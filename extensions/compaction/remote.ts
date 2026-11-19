import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	convertToLlm, type CompactionEntry, type ExtensionAPI, type ExtensionContext,
	type SessionBeforeCompactEvent, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	appendCompactionTrigger, createCompactionCollector, hasCheckpointMarker, isObject,
	rewriteCheckpointMarker, validateCompactionItem, withoutInputImages, type JsonObject,
} from "./vendor/codex/protocol.ts";

const KEY = "codexRemoteV2";
const ORIGIN = "https://chatgpt.com";
const ENDPOINT = `${ORIGIN}/backend-api/codex/responses`;
const MAX_ITEM_BYTES = 4 * 1024 * 1024;
const RETAIN_CHARS = 64_000;
const FEATURE = "remote_compaction_v2";

interface Checkpoint {
	model: string;
	account: string;
	id: string;
	items: JsonObject[];
}

export function latestCompaction(entries: readonly SessionEntry[]): CompactionEntry | undefined {
	return entries.findLast((entry): entry is CompactionEntry => entry.type === "compaction");
}

export function isRemoteEntry(entry: SessionEntry): entry is CompactionEntry {
	return entry.type === "compaction" && isObject(entry.details) && Object.hasOwn(entry.details, KEY);
}

/** A later context edit can invalidate what the opaque item or its excerpt contains. */
export function checkpointEdited(entries: readonly SessionEntry[], checkpoint: CompactionEntry): boolean {
	const commit = entries.findIndex(entry => entry.id === checkpoint.id);
	const cut = entries.findIndex(entry => entry.id === checkpoint.firstKeptEntryId);
	if (commit < 0 || cut < 0 || cut > commit) return true;
	const edits = entries.slice(commit + 1).filter(entry => entry.type === "context_edit");
	if (!edits.length) return false;
	const covered = new Set(entries.slice(0, cut).map(entry => entry.id));
	return edits.some(edit => covered.has(edit.targetId));
}

function marker(entry: CompactionEntry): string {
	// Match Pi's exact wire text, so ordinary messages and third-party additions
	// are not erased. The readable summary is safe if a hook skips replay.
	const text = convertToLlm([{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: 0 }])[0];
	return text?.role === "user" && Array.isArray(text.content) && text.content[0]?.type === "text" ? text.content[0].text : "";
}

function checkpoint(entry: CompactionEntry | undefined): Checkpoint | undefined {
	if (!entry || !isRemoteEntry(entry) || !isObject(entry.details)) return;
	const data = entry.details[KEY];
	if (!isObject(data) || data.version !== 1 || typeof data.model !== "string" || typeof data.account !== "string" ||
		typeof data.id !== "string" || !entry.summary.startsWith(`Codex checkpoint ${data.id}\n`) ||
		!Array.isArray(data.items) || !data.items.length || !data.items.every(isObject)) return;
	const last = data.items.at(-1)!;
	if (last.type !== "compaction" || typeof last.encrypted_content !== "string" || !last.encrypted_content ||
		last.encrypted_content.length > MAX_ITEM_BYTES ||
		!data.items.slice(0, -1).every(item => item.role === "user" && Array.isArray(item.content) &&
			item.content.every(part => isObject(part) && part.type === "input_text" && typeof part.text === "string"))) return;
	return data as unknown as Checkpoint;
}

function official(base: string | undefined): boolean {
	return base?.replace(/\/+$/, "") === `${ORIGIN}/backend-api` || base?.replace(/\/+$/, "") === `${ORIGIN}/backend-api/codex`;
}

export function supportsRemote(model: ExtensionContext["model"]): boolean {
	return model?.provider === "openai-codex" && model.api === "openai-codex-responses" && official(model.baseUrl);
}

/** Bind replay to the issuing account (and user) without storing a token. */
function accountKey(token: string | undefined): string | undefined {
	if (!token) return;
	try {
		const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
		if (!isObject(claims) || typeof claims.sub !== "string") return;
		const auth = claims["https://api.openai.com/auth"];
		if (!isObject(auth) || typeof auth.chatgpt_account_id !== "string") return;
		return createHash("sha256").update(JSON.stringify([claims.sub, auth.chatgpt_account_id])).digest("hex");
	} catch { return undefined; }
}

async function issuer(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>): Promise<string | undefined> {
	if (!supportsRemote(model)) return;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	return auth.ok && official(auth.baseUrl ?? model.baseUrl) ? accountKey(auth.apiKey) : undefined;
}

function retainedUsers(input: readonly unknown[], realUsers: number, priorItems: readonly JsonObject[]): JsonObject[] {
	// Keep a bounded recent user prefix, as Codex V2 expects. No tool items or
	// images are kept verbatim here; the checkpoint covers those. The Pi tail
	// was not sent to compaction and remains verbatim in the session projection.
	const users = input.filter(item => isObject(item) && item.role === "user") as JsonObject[];
	// A portable summary represents old history, not a fresh user request.
	const candidates = [...priorItems, ...(realUsers ? users.slice(-realUsers) : [])];
	let remaining = RETAIN_CHARS;
	const out: JsonObject[] = [];
	for (let i = candidates.length - 1; i >= 0 && remaining > 0; --i) {
		const parts = candidates[i]?.content;
		if (!Array.isArray(parts)) continue;
		const texts = parts.flatMap(part => isObject(part) && part.type === "input_text" && typeof part.text === "string" ? [part.text] : []);
		const text = texts.join("\n").slice(-remaining);
		if (!text.trim()) continue;
		remaining -= text.length;
		out.push({ role: "user", content: [{ type: "input_text", text }] });
	}
	return out.reverse();
}

/** Try V2 on a projected prefix. Credential resolution and streaming stay in Pi. */
export async function remoteCompact(
	pi: ExtensionAPI, ctx: ExtensionContext, event: SessionBeforeCompactEvent,
	input: {
		portableSummary: string;
		readable: AgentMessage[];
		withPrior: AgentMessage[];
		fetch?: typeof globalThis.fetch;
	},
) {
	const model = ctx.model;
	if (!model || !supportsRemote(model)) return;
	const account = await issuer(ctx, model);
	event.signal.throwIfAborted();
	if (!account) throw new Error("Codex account or official endpoint could not be verified");
	const entry = latestCompaction(event.branchEntries);
	const prior = checkpoint(entry);
	const compatible = prior?.model === model.id && prior.account === account && entry &&
		!checkpointEdited(event.branchEntries, entry) ? prior : undefined;
	const source = compatible ? input.withPrior : input.readable;
	if (!source.length) return;
	const initial = convertToLlm(source);
	if (initial.length === 0) return;
	const active = new Set(pi.getActiveTools());
	const tools = pi.getAllTools().filter(tool => active.has(tool.name)).map(({ name, description, parameters }) => ({ name, description, parameters }));
	const collector = createCompactionCollector();
	let providerError: unknown;
	let kept: JsonObject[] = [];
	const signal = AbortSignal.any([event.signal, AbortSignal.timeout(90_000)]);
	const fetcher = input.fetch ?? globalThis.fetch;
	const settings = pi.getSettings();
	const thinking = pi.getThinkingLevel();
	const stream = ctx.modelRegistry.streamSimple(model, { systemPrompt: ctx.getSystemPrompt(), messages: initial, tools }, {
		transport: "sse", maxRetries: 0, timeoutMs: 90_000, signal,
		reasoning: thinking === "off" ? undefined : thinking, thinkingBudgets: settings.thinkingBudgets,
		sessionId: ctx.sessionManager.getSessionId(),
		transformHeaders(headers) {
			const key = Object.keys(headers).find(name => name.toLowerCase() === "x-codex-beta-features") ?? "x-codex-beta-features";
			const features = new Set((headers[key] ?? "").split(",").map(value => value.trim()).filter(Boolean));
			features.add(FEATURE);
			return { ...headers, [key]: [...features].join(",") };
		},
		fetch: (request, init) => {
			const url = request instanceof Request ? request.url : String(request);
			if (url !== ENDPOINT) throw new Error("Unexpected Codex compaction endpoint");
			const header = new Headers(init?.headers ?? (request instanceof Request ? request.headers : undefined)).get("authorization");
			if (accountKey(header?.replace(/^Bearer\s+/i, "")) !== account) throw new Error("Codex account changed during compaction");
			return fetcher(request, { ...init, redirect: "error" });
		},
		onPayload(payload, resolved) {
			if (!supportsRemote(resolved) || !isObject(payload) || !Array.isArray(payload.input)) throw new Error("Codex did not build a Responses payload");
			kept = retainedUsers(payload.input, source.filter(message => message.role === "user").length, compatible?.items.slice(0, -1) ?? []);
			const replay = compatible && entry ? rewriteCheckpointMarker(payload, marker(entry), compatible.items) : payload;
			const history = Array.isArray(replay.input) && replay.input.every(isObject) && settings.images?.blockImages
				? { ...replay, input: withoutInputImages(replay.input) } : replay;
			return appendCompactionTrigger(history);
		},
		onProviderStreamEvent(data) {
			// Provider observers are notification-only; record validation failures
			// and check them before accepting a terminal result.
			try { collector.observe(data); } catch (error) { providerError = error; }
		},
	});
	const response = await stream.result();
	signal.throwIfAborted();
	if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length" || response.stopReason === "toolUse") {
		throw new Error(`Codex compaction did not finish (${response.stopReason})`);
	}
	if (providerError) throw providerError;
	const item = validateCompactionItem(collector.finish());
	if (typeof item.encrypted_content !== "string" || item.encrypted_content.length > MAX_ITEM_BYTES) throw new Error("Codex checkpoint is too large");
	const id = randomUUID();
	return { compaction: {
		summary: `Codex checkpoint ${id}\n${input.portableSummary}`,
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		usage: response.usage,
		details: { [KEY]: { version: 1, model: model.id, account, id, items: [...kept, item] } },
	} };
}

/** Replay only into the issuing Codex account/model. Otherwise Pi uses the readable summary. */
export function registerRemoteReplay(pi: ExtensionAPI): void {
	pi.on("before_provider_request", async ({ payload }, ctx) => {
		const model = ctx.model;
		if (!model || !supportsRemote(model)) return;
		const branch = ctx.sessionManager.getBranch();
		const entry = latestCompaction(branch);
		const prior = checkpoint(entry);
		if (!entry || !prior || prior.model !== model.id || checkpointEdited(branch, entry)) return;
		const text = marker(entry);
		if (!text || !hasCheckpointMarker(payload, text)) return;
		const leaf = branch.at(-1)?.id;
		if (await issuer(ctx, model) !== prior.account) return;
		if (ctx.sessionManager.getLeafId() !== leaf || ctx.model !== model) return;
		return rewriteCheckpointMarker(payload, text, prior.items);
	});
}
