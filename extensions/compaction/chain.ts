import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	buildSessionProjection, compact, convertToLlm, estimateTokens, serializeConversation, SettingsManager,
	type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isRemoteEntry, latestCompaction } from "./remote.ts";
import { getPreservedArchive, viewWithoutFrames } from "./vendor/snapcompact.ts";

export const DEFAULT_ORDER = ["remote", "snapcompact", "soft"] as const;
export type Method = typeof DEFAULT_ORDER[number];

export function methodOrder(value: unknown): Method[] | undefined {
	if (!Array.isArray(value) || !value.length || !value.every(method => DEFAULT_ORDER.includes(method))) return;
	return [...new Set<Method>(value)];
}

/** Hide opaque entries without severing the parent-id chain or ignoring context edits. */
export function readableBranch(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.map(entry => isRemoteEntry(entry) ? {
		id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
		type: "custom", customType: "compaction:opaque", data: null,
	} : entry);
}

/** Preserve Pi's original cut and tool-call boundaries while rebuilding its summarized prefix. */
export function projectPrefix(entries: SessionEntry[], cut: string): AgentMessage[] {
	const projection = buildSessionProjection(entries);
	const index = projection.entries.findIndex(entry => entry.sourceEntry.id === cut);
	if (index < 0) throw new Error("Compaction cut no longer belongs to the active branch");
	return projection.entries.slice(0, index).flatMap(entry => entry.messages).filter(message => message.role !== "system");
}

export function readableSummary(
	entries: readonly SessionEntry[], messages: readonly AgentMessage[], maxChars: number,
): string | undefined {
	const prior = latestCompaction(entries);
	if (!prior || !messages.some(message => message.role === "compactionSummary" && message.summary === prior.summary)) return;
	const archive = getPreservedArchive(prior.details as Record<string, unknown> | undefined);
	if (!archive) return prior.summary;
	const view = viewWithoutFrames(prior.summary, archive, maxChars, false);
	return [view.summary, view.archive.textHead, view.archive.textTail].filter(Boolean).join("\n\n");
}

export function remotePortableSummary(prior: string | undefined, prefix: AgentMessage[], maxChars = 16_000): string {
	maxChars = Math.max(0, Math.floor(maxChars));
	const text = [prior, serializeConversation(convertToLlm(prefix.filter(message => message.role !== "compactionSummary")))].filter(Boolean).join("\n\n");
	if (text.length <= maxChars) return text || "No readable earlier messages.";
	const clip = "\n\n[Middle omitted from this portable view; the original remains in the session transcript.]\n\n";
	if (maxChars <= clip.length) return text.slice(0, maxChars);
	const remaining = maxChars - clip.length;
	const head = Math.floor(remaining / 3);
	return text.slice(0, head) + clip + text.slice(-(remaining - head));
}

export function recoveredEvent(event: SessionBeforeCompactEvent): SessionBeforeCompactEvent {
	const prior = latestCompaction(event.branchEntries);
	if (!prior || !isRemoteEntry(prior)) return event;
	const branches = readableBranch(event.branchEntries);
	const prefix = projectPrefix(branches, event.preparation.firstKeptEntryId);
	const messages = prefix.filter(message => message.role !== "compactionSummary");
	const summary = prefix.find(message => message.role === "compactionSummary");
	const previousSummary = summary?.role === "compactionSummary" ? summary.summary : undefined;
	return {
		...event, branchEntries: branches,
		preparation: {
			...event.preparation, previousSummary, messagesToSummarize: messages,
			turnPrefixMessages: [], isSplitTurn: false,
			tokensBefore: Math.max(event.preparation.tokensBefore, buildSessionProjection(branches).messages.reduce((n, message) => n + estimateTokens(message), 0)),
		},
	};
}

/** Pi's text compactor with the reconstructed preparation and Pi's configured credentials. */
export async function compactReadable(
	pi: ExtensionAPI, ctx: ExtensionContext, event: SessionBeforeCompactEvent, focus?: string,
) {
	const model = ctx.model;
	if (!model) throw new Error("No model selected for soft compaction");
	const settings = SettingsManager.inMemory(pi.getSettings());
	const retry = settings.getProviderRetrySettings();
	const prior = latestCompaction(event.branchEntries);
	const preparation = { ...event.preparation };
	if (prior && prior.summary === preparation.previousSummary) {
		const existing = { role: "compactionSummary", summary: prior.summary, tokensBefore: prior.tokensBefore, timestamp: 0 } as const;
		preparation.previousSummary = readableSummary(event.branchEntries, [existing], Math.min(48_000, model.contextWindow));
	}
	const responses: ReturnType<ExtensionContext["modelRegistry"]["streamSimple"]>[] = [];
	const result = await compact(preparation, model, undefined, undefined, focus, event.signal, pi.getThinkingLevel(),
		(_model, context, options) => {
			const stream = ctx.modelRegistry.streamSimple(model, context, {
				...options, transport: settings.getTransport(), thinkingBudgets: settings.getThinkingBudgets(),
				websocketConnectTimeoutMs: settings.getWebSocketConnectTimeoutMs(),
				timeoutMs: retry.timeoutMs, maxRetries: retry.maxRetries, maxRetryDelayMs: retry.maxRetryDelayMs,
			});
			responses.push(stream);
			return stream;
		}, undefined, settings.getRetrySettings(), undefined, ctx.sessionManager.getSessionId());
	event.signal.throwIfAborted();
	for (const stream of responses) {
		const response = await stream.result();
		if (response.stopReason === "error") continue; // Pi may have retried this attempt.
		if (response.stopReason !== "stop" || !response.content.some(block => block.type === "text" && block.text.trim())) {
			throw new Error("Soft compaction did not return a complete text summary");
		}
	}
	return result;
}
