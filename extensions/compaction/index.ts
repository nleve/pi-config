/**
 * Compaction for Pi — Codex Remote V2, Snapcompact, and Pi text summaries.
 *
 * A port of omp's snapcompact (`@oh-my-pi/snapcompact`) as a pi extension.
 * Instead of asking an LLM to summarize discarded history, the discarded turns
 * are serialized, normalized, and rasterized into dense PNG frames of pixel-font
 * text that a vision model reads back directly. The pass is local and
 * deterministic: no LLM call, no API key, no latency beyond rendering.
 *
 * Engine: `vendor/snapcompact.ts` is a vendored OMP snapshot with import shims
 * and a bounded text-only archive view ported from later upstream versions.
 *
 * Integration (the parts omp supplies natively, reimplemented here):
 *   - `session_before_compact` renders the archive, sizes it with a
 *     context-window budget, guards that it actually reduces the context, and
 *     externalizes frame payloads to a content-addressed store.
 *   - `context` re-attaches the latest archive's frames, optionally images
 *     large historical tool results (inline imaging), and keeps the total image
 *     count within the provider's per-request budget.
 *
 * Automatic compaction defaults to remote → snapcompact → soft.
 * `/compact` offers the chain and individual starting methods:
 *   /compact                    → picker (or the configured chain)
 *   /compact remote             → try Codex V2 first
 *   /compact snapcompact        → try the bitmap archive first
 *   /compact soft [focus]       → classic LLM summary
 *   /compaction                 → configure ordering and archive settings
 *
 * Config lives at ~/.pi/agent/snapcompact.json (created on first use).
 */
import fs from "node:fs";
import path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	compactReadable, DEFAULT_ORDER, methodOrder, projectPrefix, readableBranch, readableSummary, recoveredEvent, remotePortableSummary,
	type Method,
} from "./chain.ts";
import { checkpointEdited, isRemoteEntry, registerRemoteReplay, remoteCompact, supportsRemote } from "./remote.ts";
import {
	compact as runSnapcompact,
	FRAME_DATA_BYTES_BUDGET,
	getPreservedArchive,
	historyBlocks,
	isShapeVariantName,
	PRESERVE_KEY,
	renderabilityProbeText,
	resolveShape,
	resolveShapeForText,
	SHAPE_VARIANT_NAMES,
	viewWithoutFrames,
	type Archive,
	type Shape,
	type ShapeVariantName,
} from "./vendor/snapcompact";
import { preferredDialect } from "./vendor/identity";
import { blobStats, externalizeArchive, formatBytes, gcBlobs, maybeAutoGc, resolveFrameData, resolvedFrameBytes } from "./blobs";
import { archiveTokens, computeMaxFrames, guardReduction, textArchiveCharBudget, tokensOfMessages } from "./budget";
import { resolveFrameCountBudget, resolveImageCountBudget } from "./tuning";
import { type FrameCacheEntry, imageToolResults } from "./inline";

/** Same wrapper pi applies when it turns a compaction entry into a user message. */
const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

const CHAIN_LABEL = "Auto — use the configured fallback order";
const REMOTE_LABEL = "Remote — try Codex V2 first, then fall back";
const SNAP_LABEL = "Snapcompact — archive history onto bitmap images (no LLM call)";
const SOFT_LABEL = "Soft — summarize with the active model";

interface Config {
	methodOrder: Method[];
	picker: boolean;
	/** Upper limit; the effective cap is lowered by the model window/budget. */
	maxFrames: number;
	shape: "auto" | ShapeVariantName;
	/** Inline-imaging of large historical tool results (omp: snapcompact.toolResults). */
	toolResults: boolean;
	/** Externalize frame payloads to the content-addressed blob store. */
	blobStore: boolean;
	/** Override the provider image-count budget. */
	imageBudget?: number;
}

const DEFAULT_CONFIG: Config = {
	methodOrder: [...DEFAULT_ORDER],
	picker: true,
	maxFrames: 80,
	shape: "auto",
	toolResults: false,
	blobStore: true,
};
const CONFIG_PATH = path.join(getAgentDir(), "snapcompact.json");

function loadConfig(): Config {
	try {
		const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<Config> & { default?: string };
		return {
			methodOrder: methodOrder(parsed.methodOrder) ?? (parsed.default === "soft" ? ["soft"] : [...DEFAULT_ORDER]),
			picker: parsed.picker !== false,
			maxFrames:
				typeof parsed.maxFrames === "number" && parsed.maxFrames > 0
					? Math.min(Math.floor(parsed.maxFrames), 400)
					: DEFAULT_CONFIG.maxFrames,
			shape:
				parsed.shape === "auto" || isShapeVariantName(parsed.shape)
					? (parsed.shape as Config["shape"])
					: "auto",
			toolResults: parsed.toolResults === true,
			blobStore: parsed.blobStore !== false,
			imageBudget:
				typeof parsed.imageBudget === "number" && parsed.imageBudget > 0
					? Math.floor(parsed.imageBudget)
					: undefined,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(config: Config): void {
	fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function modelSupportsImages(ctx: ExtensionContext): boolean {
	const input = ctx.model?.input;
	return Array.isArray(input) && input.includes("image");
}

/** Whether the archive's source text should include assistant reasoning. */
function includeThinkingFor(modelId: string | undefined): boolean {
	// Reasoning replayed to a Claude reader trips its reasoning-extraction
	// classifier, so omit it there — mirrors omp's per-dialect behavior.
	return preferredDialect(modelId ?? "") !== "anthropic";
}

interface ParsedInstructions {
	method?: Method;
	focus?: string;
	error?: string;
}

/** Split a leading method token off `/compact` instructions. */
function parseInstructions(raw: string | undefined): ParsedInstructions {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return {};
	const spaceIndex = trimmed.search(/\s/);
	const token = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
	const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

	if (token === "remote") {
		return rest ? { error: "Remote compaction does not accept focus instructions; use /compact soft <focus>." } : { method: "remote" };
	}
	if (token === "snapcompact" || token === "snap" || token === "sc") {
		return rest
			? { error: "snapcompact archives history without an LLM summary, so it ignores focus instructions." }
			: { method: "snapcompact" };
	}
	if (token === "soft" || token === "llm" || token === "summary") {
		return { method: "soft", focus: rest || undefined };
	}
	// No recognized token: the whole argument string is focus text (historical behavior).
	return { focus: trimmed };
}

/** The archive carried by the most recent compaction entry, if it has one. */
function previousArchiveFrom(
	entries: readonly { type: string; details?: unknown }[],
): Record<string, unknown> | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		const archive = getPreservedArchive(entry.details as Record<string, unknown> | undefined);
		// Only the newest compaction matters: if it was soft, the history it
		// replaced is already condensed and must not be replayed from an older
		// snapcompact archive.
		return archive ? { [PRESERVE_KEY]: archive } : undefined;
	}
	return undefined;
}

/**
 * Billed tokens of the previous compaction standing in the context: its frames
 * (at the current model's frame price) plus text edges, or the previous text
 * summary when no archive exists. Zero on a first compaction. Folding this into
 * the reduction baseline lets a re-compaction be judged against what it
 * actually replaces, the pi-side analogue of omp's
 * `#projectPreSnapcompactContextTokens`.
 */
function previousStandingTokens(
	previousPreserveData: Record<string, unknown> | undefined,
	previousSummary: string | undefined,
	shape: Shape,
): number {
	const archive = getPreservedArchive(previousPreserveData);
	if (archive) return archiveTokens(archive, shape);
	if (previousSummary) return Math.ceil(previousSummary.length / 4);
	return 0;
}

/** Session roots and the exact current file, for blob reference scanning. */
function gcScopeFor(ctx: ExtensionContext): { sessionRoots: string[]; exactSessionFiles: string[] } {
	const sessionRoots: string[] = [];
	const exactSessionFiles: string[] = [];
	try {
		const dir = ctx.sessionManager.getSessionDir();
		if (dir) sessionRoots.push(dir);
	} catch {
		// Session manager without a dir.
	}
	try {
		const file = ctx.sessionManager.getSessionFile();
		if (file) exactSessionFiles.push(file);
	} catch {
		// Sessions disabled.
	}
	return { sessionRoots, exactSessionFiles };
}

/** Rough text sample of the messages, for font-aware shape selection. */
function probeTextFor(messages: readonly unknown[], cap = 200_000): string {
	const parts: string[] = [];
	let total = 0;
	for (const message of messages) {
		const content = (message as { content?: unknown })?.content;
		if (typeof content === "string") {
			parts.push(content);
			total += content.length;
		} else if (Array.isArray(content)) {
			for (const block of content as { type?: unknown; text?: unknown }[]) {
				if (block?.type === "text" && typeof block.text === "string") {
					parts.push(block.text);
					total += block.text.length;
				}
			}
		}
		if (total >= cap) break;
	}
	return parts.join("\n");
}

/** Resolve the frame shape the same way `compact()` will for this text/model. */
function resolveCompactionShape(
	model: ExtensionContext["model"],
	config: Config,
	allMessages: readonly unknown[],
	previousPreserveData: Record<string, unknown> | undefined,
	previousSummary: string | undefined,
): Shape {
	const probe = renderabilityProbeText(probeTextFor(allMessages), previousPreserveData, previousSummary);
	return resolveShapeForText(probe, model as never, config.shape);
}

/** Keep only the newest `limit` frames; count the dropped characters. */
function clampArchiveFrames(archive: Archive, limit: number): Archive {
	const omit = archive.frames.length - limit;
	if (omit <= 0) return archive;
	return {
		...archive,
		frames: archive.frames.slice(omit),
		truncatedChars: archive.truncatedChars + archive.frames.slice(0, omit).reduce((sum, frame) => sum + frame.chars, 0),
	};
}

/** Count image blocks carried by a message list. */
function countImages(messages: readonly unknown[]): number {
	let count = 0;
	for (const message of messages) {
		const content = (message as { content?: unknown })?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as { type?: unknown }[]) {
			if (block?.type === "image") count++;
		}
	}
	return count;
}

/** Short human label for a resolved shape (the engine's Shape has no name). */
function shapeLabel(shape: Shape): string {
	return `${shape.cellWidth}on${shape.cellHeight}${shape.columns === 2 ? "-doc" : ""}-${shape.variant}@${shape.frameSize}`;
}

/** Render an archive into pi content blocks (text edges + frame images). */
function archiveBlocks(archive: Archive) {
	if (archive.frames.length === 0 && !archive.textHead && !archive.textTail) return [];
	return historyBlocks(archive, {
		maxFrameDataBytes: FRAME_DATA_BYTES_BUDGET,
		resolveFrameData,
	}).map(block =>
		block.type === "image" ? { type: "image" as const, data: block.data, mimeType: block.mimeType } : block,
	);
}

export default function compactionExtension(pi: ExtensionAPI): void {
	registerCompaction(pi);
}

export function registerCompaction(pi: ExtensionAPI, options: { remoteFetch?: typeof globalThis.fetch } = {}): void {
	// Keep one decoded frame payload, keyed by session, compaction and limit.
	let archiveCache: { key: string; blocks: ReturnType<typeof archiveBlocks> } | undefined;
	// Rendered inline tool-result frames, keyed by toolCallId.
	const toolFrameCache = new Map<string, FrameCacheEntry>();

	// Opportunistic blob sweep; throttled internally to once per interval.
	pi.on("session_start", async (_event, ctx) => {
		void maybeAutoGc(gcScopeFor(ctx)).catch(() => {});
	});

	async function snapcompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext, config: Config): Promise<SessionBeforeCompactResult | undefined> {
		if (!modelSupportsImages(ctx)) {
			ctx.ui.notify("Snapcompact needs a model that accepts images; falling back to soft compaction.", "warning");
			return undefined;
		}

		const model = ctx.model;
		const allMessages = [
			...event.preparation.messagesToSummarize,
			...event.preparation.turnPrefixMessages,
		];
		const previousPreserveData = previousArchiveFrom(event.branchEntries);
		const shape = resolveCompactionShape(
			model,
			config,
			allMessages,
			previousPreserveData,
			event.preparation.previousSummary,
		);

		const sourceTokens = tokensOfMessages(allMessages);
		const previousTokens = previousStandingTokens(previousPreserveData, event.preparation.previousSummary, shape);
		const maxFrames = computeMaxFrames({
			model: { provider: model?.provider, api: model?.api, contextWindow: model?.contextWindow },
			shape,
			sourceTokens,
			tokensBefore: event.preparation.tokensBefore,
			configMaxFrames: config.maxFrames,
			imageBudget: config.imageBudget,
		});

		if (maxFrames < 1) {
			ctx.ui.notify(
				"Snapcompact: kept history alone exceeds the context budget; falling back to soft compaction.",
				"warning",
			);
			return undefined;
		}

		try {
			const result = await runSnapcompact(
				{
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					messagesToSummarize: event.preparation.messagesToSummarize,
					turnPrefixMessages: event.preparation.turnPrefixMessages,
					tokensBefore: event.preparation.tokensBefore,
					previousSummary: event.preparation.previousSummary,
					previousPreserveData,
					fileOps: event.preparation.fileOps,
				} as never,
				{
					convertToLlm: convertToLlm as never,
					model: { api: model?.api as never, id: model?.id ?? "" },
					shape,
					maxFrames,
					includeThinking: includeThinkingFor(model?.id),
				} as never,
			);

			const archive = getPreservedArchive(result.preserveData);
			if (!archive) {
				ctx.ui.notify("Snapcompact produced no archive; falling back to soft compaction.", "warning");
				return undefined;
			}

			// Standing image payload must fit the per-request byte budget.
			const payloadBytes = resolvedFrameBytes(archive);
			if (payloadBytes > FRAME_DATA_BYTES_BUDGET) {
				ctx.ui.notify(
					`Snapcompact produced too much standing image payload (${(payloadBytes / 1e6).toFixed(1)} MB); falling back to soft compaction.`,
					"warning",
				);
				return undefined;
			}

			// Reject an archive that does not actually shrink the context.
			const verdict = guardReduction({
				model: { provider: model?.provider, api: model?.api, contextWindow: model?.contextWindow },
				shape,
				archive,
				tokensBefore: event.preparation.tokensBefore,
				sourceTokens,
				previousTokens,
			});
			if (!verdict.accept) {
				const reason =
					verdict.reason === "no-fit"
						? "projected context would not fit the window"
						: "archive would not reduce context";
				ctx.ui.notify(
					`Snapcompact skipped — ${reason} (projected ${verdict.projectedTokens.toLocaleString()} vs ${verdict.baselineTokens.toLocaleString()} tokens); falling back to soft compaction.`,
					"warning",
				);
				return undefined;
			}

			const persisted = externalizeArchive(archive, config.blobStore);
			const frames = archive.frames.length;
			// Reclaim old frame blobs in the background; never blocks the compaction.
			void maybeAutoGc(gcScopeFor(ctx)).catch(() => {});
			ctx.ui.notify(
				`Snapcompact [${shapeLabel(shape)}]: archived ${archive.totalChars.toLocaleString()} chars onto ${frames} frame${frames === 1 ? "" : "s"}, ~${verdict.projectedTokens.toLocaleString()} tok (from ${verdict.baselineTokens.toLocaleString()})`,
				"info",
			);

			return {
				compaction: {
					summary: result.summary,
					firstKeptEntryId: result.firstKeptEntryId,
					tokensBefore: result.tokensBefore,
					details: { ...(result.details ?? {}), [PRESERVE_KEY]: persisted },
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Snapcompact failed (${message}); falling back to soft compaction.`, "warning");
			return undefined;
		}
	}

	registerRemoteReplay(pi);
	pi.on("session_before_compact", async (event, ctx): Promise<SessionBeforeCompactResult | undefined> => {
		const config = loadConfig();
		const parsed = parseInstructions(event.customInstructions);
		if (parsed.error) {
			ctx.ui.notify(parsed.error, "error");
			return { cancel: true };
		}
		let method = parsed.method;
		if (!method && !parsed.focus && event.reason === "manual" && config.picker && ctx.hasUI) {
			const choices = [CHAIN_LABEL, ...(supportsRemote(ctx.model) ? [REMOTE_LABEL] : []), SNAP_LABEL, SOFT_LABEL];
			const choice = await ctx.ui.select("Compaction method", choices);
			if (choice === undefined) return { cancel: true };
			method = choice === REMOTE_LABEL ? "remote" : choice === SNAP_LABEL ? "snapcompact" : choice === SOFT_LABEL ? "soft" : undefined;
		}
		const order = method === "remote" ? DEFAULT_ORDER : method === "snapcompact" ? ["snapcompact", "soft"] as const :
			method === "soft" || parsed.focus ? ["soft"] as const : config.methodOrder;
		const session = ctx.sessionManager.getSessionId();
		const leaf = ctx.sessionManager.getLeafId();
		const model = ctx.model;
		const current = () => !event.signal.aborted && session === ctx.sessionManager.getSessionId() &&
			leaf === ctx.sessionManager.getLeafId() && model === ctx.model;
		try {
			let recovered: SessionBeforeCompactEvent | undefined;
			const readable = () => recovered ??= recoveredEvent(event);
			for (const candidate of order) {
				if (!current()) return { cancel: true };
				if (candidate === "remote") {
					if (!supportsRemote(model)) continue;
					ctx.ui.setStatus("compaction", "Codex remote compaction…");
					try {
						const restored = readable();
						const prefix = projectPrefix(restored.branchEntries, event.preparation.firstKeptEntryId);
						const prior = readableSummary(restored.branchEntries, prefix, 48_000);
						const result = await remoteCompact(pi, ctx, event, {
							portableSummary: remotePortableSummary(prior, prefix),
							fetch: options.remoteFetch,
							readable: prefix.map(message => message.role === "compactionSummary" && prior ? { ...message, summary: prior } : message),
							withPrior: restored === event ? prefix : projectPrefix(event.branchEntries, event.preparation.firstKeptEntryId),
						});
						if (!current()) return { cancel: true };
						if (result) {
							ctx.ui.notify("Codex remote compaction complete.", "info");
							return result;
						}
					} catch (error) {
						if (!current()) return { cancel: true };
						ctx.ui.notify(`Codex remote compaction failed; trying the next method. ${error instanceof Error ? error.message : String(error)}`, "warning");
					} finally {
						ctx.ui.setStatus("compaction", undefined);
					}
				} else if (candidate === "snapcompact") {
					const result = await snapcompact(readable(), ctx, config);
					if (!current()) return { cancel: true };
					if (result) return result;
				} else {
					const result = await compactReadable(pi, ctx, readable(), parsed.focus);
					return current() ? { compaction: result } : { cancel: true };
				}
			}
			ctx.ui.notify("No configured compaction method succeeded; history left unchanged.", "warning");
		} catch (error) {
			if (current()) ctx.ui.notify(`Compaction failed; history left unchanged. ${error instanceof Error ? error.message : String(error)}`, "error");
		}
		return { cancel: true };
	});

	// Re-attach the latest compaction's frames, optionally image large tool
	// results, and keep the request within the provider image budget.
	pi.on("context", async (event, ctx) => {
		const config = loadConfig();
		const model = ctx.model;
		const imageBudget = resolveImageCountBudget(
			{ provider: model?.provider, api: model?.api },
			config.imageBudget,
		);
		const shape = model ? resolveShape(model as never, config.shape) : undefined;
		const vision = modelSupportsImages(ctx);

		let messages = event.messages as unknown[];
		let changed = false;

		// Pi's session context has one active compaction summary. Ignore older
		// entries (including a snapcompact followed by a soft compaction).
		const summaryIndex = event.messages.findIndex(message => message.role === "compactionSummary");
		if (summaryIndex >= 0) {
			const message = event.messages[summaryIndex];
			const branch = ctx.sessionManager.getBranch();
			const entry = branch.findLast(item => item.type === "compaction");
			if (message.role === "compactionSummary" && entry?.type === "compaction" && entry.summary === message.summary) {
				if (isRemoteEntry(entry) && checkpointEdited(branch, entry)) {
					let summary = "An earlier remote checkpoint was invalidated by a context edit. Run /compact soft to rebuild it from the saved branch.";
					try {
						const readable = readableBranch(branch);
						const prefix = projectPrefix(readable, entry.firstKeptEntryId);
						summary = remotePortableSummary(readableSummary(readable, prefix, 16_000), prefix);
					} catch { /* Never send the invalidated excerpt. */ }
					messages = messages.slice();
					messages[summaryIndex] = { ...message, summary };
					changed = true;
				}
				const archive = getPreservedArchive(entry.details as Record<string, unknown> | undefined);
				if (archive) {
					const limit = vision ? Math.max(0, imageBudget - countImages(messages)) : 0;
					let summary = message.summary;
					let blocks: ReturnType<typeof archiveBlocks> = [];
					if (limit > 0 && archive.frames.length > 0) {
						const key = JSON.stringify([ctx.sessionManager.getSessionId(), entry.id, Math.min(limit, archive.frames.length)]);
						blocks = archiveCache?.key === key
							? archiveCache.blocks
							: archiveBlocks(clampArchiveFrames(archive, limit));
						if (blocks.some(block => block.type === "image")) archiveCache = { key, blocks };
					}
					if (!blocks.some(block => block.type === "image")) {
						const retainedTokens = tokensOfMessages(messages) + Math.ceil(ctx.getSystemPrompt().length / 4);
						const view = viewWithoutFrames(
							summary,
							archive,
							textArchiveCharBudget(model?.contextWindow, retainedTokens),
							includeThinkingFor(model?.id),
						);
						summary = view.summary;
						blocks = archiveBlocks(view.archive);
					}
					messages = messages.slice();
					messages[summaryIndex] = {
						role: "custom",
						customType: "snapcompact",
						display: false,
						timestamp: message.timestamp,
						content: [
							{ type: "text", text: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX },
							...blocks,
						],
					};
					changed = true;
				}
			}
		}

		// 2. Inline-image large historical tool results (opt-in), within budget.
		if (shape) {
			const used = countImages(messages);
			const outcome = await imageToolResults(messages, {
				enabled: config.toolResults && vision && imageBudget - used > 0,
				shape,
				budget: Math.max(0, imageBudget - used),
			}, toolFrameCache);
			if (outcome.changed) {
				messages = outcome.messages;
				changed = true;
				if (outcome.swapped > 0) {
					ctx.ui.setStatus?.(
						"snapcompact",
						`imaged ${outcome.swapped} tool result${outcome.swapped === 1 ? "" : "s"} (~${outcome.savedTokens.toLocaleString()} tok saved)`,
					);
				}
			}
		}

		return changed ? { messages: messages as never } : undefined;
	});

	pi.registerCommand("compaction", {
		description: "Configure compaction fallback order, picker, Snapcompact frames, and blob storage",
		handler: async (_args, ctx) => {
			const config = loadConfig();

			while (true) {
				const shape = ctx.model
					? resolveShape(ctx.model as never, config.shape)
					: undefined;
				const budget = resolveImageCountBudget(
					{ provider: ctx.model?.provider, api: ctx.model?.api },
					config.imageBudget,
				);
				const frameCap = resolveFrameCountBudget(
					{ provider: ctx.model?.provider, api: ctx.model?.api },
					config.imageBudget,
				);
				const blobs = blobStats();
				const choice = await ctx.ui.select("Compaction settings", [
					`Fallback order: ${config.methodOrder.join(" → ")}`,
					`Method picker on /compact: ${config.picker ? "on" : "off"}`,
					`Max frames per archive: ${config.maxFrames} (effective cap ${frameCap})`,
					`Frame shape: ${config.shape}${shape ? ` → ${shapeLabel(shape)}` : ""}`,
					`Image tool results: ${config.toolResults ? "on" : "off"}`,
					`Blob store for frames: ${config.blobStore ? "on" : "off"}`,
					`Frame blobs: ${blobs.files} files, ${formatBytes(blobs.bytes)} — collect now`,
					`Image-count budget: ${config.imageBudget ?? "auto"} (resolved ${budget})`,
				]);
				if (!choice) return;

				if (choice.startsWith("Fallback order")) {
					const value = await ctx.ui.input("Methods in order (remote, snapcompact, soft)", config.methodOrder.join(", "));
					if (value === undefined) continue;
					const order = methodOrder(value.split(",").map(word => word.trim().toLowerCase()));
					if (!order) { ctx.ui.notify("Enter a comma-separated list of compaction methods.", "error"); continue; }
					config.methodOrder = order;
				} else if (choice.startsWith("Method picker")) {
					config.picker = !config.picker;
				} else if (choice.startsWith("Max frames")) {
					const value = await ctx.ui.input("Max frames per archive", String(config.maxFrames));
					if (value === undefined) continue;
					const parsed = Number.parseInt(value.trim(), 10);
					if (!Number.isFinite(parsed) || parsed <= 0) {
						ctx.ui.notify("Max frames must be a positive integer.", "error");
						continue;
					}
					config.maxFrames = Math.min(parsed, 400);
				} else if (choice.startsWith("Frame shape")) {
					const picked = await ctx.ui.input("Frame shape (auto or a variant name)", config.shape);
					if (picked === undefined) continue;
					const trimmed = picked.trim();
					if (trimmed && trimmed !== "auto" && !isShapeVariantName(trimmed)) {
						ctx.ui.notify(`Unknown shape "${trimmed}"; known: auto, ${SHAPE_VARIANT_NAMES.join(", ")}`, "error");
						continue;
					}
					config.shape = (trimmed || "auto") as Config["shape"];
				} else if (choice.startsWith("Image tool results")) {
					config.toolResults = !config.toolResults;
				} else if (choice.startsWith("Blob store")) {
					config.blobStore = !config.blobStore;
				} else if (choice.startsWith("Frame blobs")) {
					const swept = await gcBlobs(gcScopeFor(ctx));
					ctx.ui.notify(
						swept.deleted > 0
							? `Snapcompact GC: removed ${swept.deleted} blob${swept.deleted === 1 ? "" : "s"} (${formatBytes(swept.bytes)}); ${swept.referenced} referenced.`
							: `Snapcompact GC: nothing to remove (${swept.candidates} unreferenced candidate${swept.candidates === 1 ? "" : "s"}, ${swept.referenced} referenced).`,
						"info",
					);
				} else if (choice.startsWith("Image-count budget")) {
					const picked = await ctx.ui.input("Image-count budget (blank = auto)", config.imageBudget?.toString() ?? "");
					if (picked === undefined) continue;
					const trimmed = picked.trim();
					if (!trimmed) {
						config.imageBudget = undefined;
					} else {
						const parsed = Number.parseInt(trimmed, 10);
						if (!Number.isFinite(parsed) || parsed <= 0) {
							ctx.ui.notify("Image-count budget must be a positive integer.", "error");
							continue;
						}
						config.imageBudget = parsed;
					}
				}
				saveConfig(config);
			}
		},
	});

	pi.registerCommand("snapcompact-gc", {
		description: "Collect unreferenced snapcompact frame blobs",
		handler: async (_args, ctx) => {
			const swept = await gcBlobs(gcScopeFor(ctx));
			ctx.ui.notify(
				`Snapcompact GC: ${swept.deleted} removed (${formatBytes(swept.bytes)}), ${swept.referenced} referenced, ${swept.stagingDeleted} staging` +
					(swept.errors.length > 0 ? `, ${swept.errors.length} error${swept.errors.length === 1 ? "" : "s"}` : ""),
				swept.errors.length > 0 ? "warning" : "info",
			);
		},
	});
}
