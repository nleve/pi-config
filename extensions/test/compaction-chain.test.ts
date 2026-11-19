import { expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { convertToLlm, type CompactionEntry, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { methodOrder, projectPrefix, readableBranch, recoveredEvent, remotePortableSummary } from "../compaction/chain.ts";
import { registerCompaction } from "../compaction/index.ts";

const model = { provider: "openai-codex", api: "openai-codex-responses", id: "fixture", baseUrl: "https://chatgpt.com/backend-api", contextWindow: 32768, input: ["text"] } as Model<"openai-codex-responses">;
const token = `x.${Buffer.from(JSON.stringify({ sub: "test", "https://api.openai.com/auth": { chatgpt_account_id: "account-a" } })).toString("base64url")}.x`;
const item = { type: "compaction", encrypted_content: "synthetic-not-a-secret" };
function fixture() {
	const entries: SessionEntry[] = [];
	function append<T extends SessionEntry>(data: Omit<T, "id" | "parentId" | "timestamp">): T {
		const row = { id: `${entries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(0).toISOString(), ...data } as T;
		entries.push(row);
		return row;
	}
	const prompt = (text: string) => append<Extract<SessionEntry, {type: "message"}>>({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } });
	let cut = prompt("Older exact fact: indigo-7432").id;
	const wrong = prompt("Omitted by edit");
	append<Extract<SessionEntry, { type: "context_edit" }>>({ type: "context_edit", targetId: wrong.id, replacement: null });
	cut = prompt("Kept tail").id;
	let remote = 0;
	let soft = 0;
	let fail = false;
	let lastNative: any;
	let lastSoft = "";
	const hooks: Record<string, Function> = {};
	const pi = { on: (name: string, fn: Function) => { hooks[name] = fn; }, registerCommand() {}, getSettings: () => ({}), getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => "off" } as unknown as ExtensionAPI;
	const ctx = {
		model, hasUI: false, ui: { notify() {}, setStatus() {} },
		sessionManager: { getBranch: () => entries.slice(), getLeafId: () => entries.at(-1)?.id, getSessionId: () => "test" },
		getSystemPrompt: () => "test system",
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }),
			streamSimple: (_model: unknown, context: any, options: any) => {
				const result = (async () => {
					if (!options.fetch) {
						soft++;
						lastSoft = JSON.stringify(context);
						return { stopReason: "stop", content: [{ type: "text", text: "Readable result" }] };
					}
					const payload = { input: context.messages.map((msg: any) => ({ role: msg.role, content: msg.content.map((p: any) => ({ type: "input_text", text: p.text })) })) };
					lastNative = options.onPayload(payload, model);
					const res = await options.fetch("https://chatgpt.com/backend-api/codex/responses", { headers: { authorization: `Bearer ${token}` } });
					if (!res.ok) return { stopReason: "error" };
					options.onProviderStreamEvent({ type: "response.output_item.done", item });
					options.onProviderStreamEvent({ type: "response.completed", response: { status: "completed" } });
					return { stopReason: "stop" };
				})();
				return { result: () => result };
			},
		},
	} as unknown as ExtensionContext;
	registerCompaction(pi, { remoteFetch: async () => { remote++; return new Response(null, { status: fail ? 403 : 200 }); } });
	function event(firstKeptEntryId = cut): SessionBeforeCompactEvent {
		return { type: "session_before_compact", reason: "threshold", willRetry: false, signal: new AbortController().signal,
			branchEntries: entries.slice(), preparation: { firstKeptEntryId, messagesToSummarize: projectPrefix(entries, firstKeptEntryId).filter(msg => msg.role !== "compactionSummary"),
			tokensBefore: 50, turnPrefixMessages: [], isSplitTurn: false, fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, keepRecentTokens: 20, reserveTokens: 16384 } } };
	}
	return { entries, prompt, append, ctx, hooks, event, fail: () => { fail = true; }, counts: () => [remote, soft], lastNative: () => lastNative, lastSoft: () => lastSoft };
}

test("default chain uses remote, replays its checkpoint, then reconstructs older history on failure", async () => {
	const f = fixture();
	const a = await f.hooks.session_before_compact!(f.event(), f.ctx);
	expect(a.compaction.summary).toContain("indigo-7432");
	expect(a.compaction.summary).not.toContain("Omitted by edit");
	expect(f.lastNative().input.at(-1)).toEqual({ type: "compaction_trigger" });
	expect(JSON.stringify(f.lastNative())).not.toContain("Kept tail");
	expect(f.counts()).toEqual([1, 0]);
	const entry = f.append<CompactionEntry>({ type: "compaction", ...a.compaction });
	const msg = convertToLlm([{ role: "compactionSummary", summary: entry.summary, timestamp: 0, tokensBefore: 50 }])[0] as any;
	const payload = { input: [{ role: "user", content: [{ type: "input_text", text: msg.content[0].text }] }] };
	const replayed = await f.hooks.before_provider_request!({ payload }, f.ctx);
	expect(replayed.input.at(-1)).toEqual(item);
	const other = { ...f.ctx, model: { ...model, id: "another-model" } };
	expect(await f.hooks.before_provider_request!({ payload }, other)).toBeUndefined();
	const tail = f.prompt("After checkpoint");
	const readable = recoveredEvent(f.event(tail.id));
	expect(projectPrefix(readableBranch(f.entries), tail.id).map((msg: any) => msg.content?.[0]?.text)).toEqual(["Older exact fact: indigo-7432", "Kept tail"]);
	expect(readable.preparation.previousSummary).toBeUndefined();
	f.fail();
	const b = await f.hooks.session_before_compact!(f.event(tail.id), f.ctx);
	expect(b.compaction.summary).toBe("Readable result");
	expect(f.counts()).toEqual([2, 1]);
	expect((JSON.stringify(f.lastNative()).match(/synthetic-not-a-secret/g) ?? []).length).toBe(1);
	expect(f.lastSoft()).toContain("indigo-7432");
	expect(f.lastSoft()).not.toContain("Omitted by edit");
	expect(f.lastSoft()).not.toContain("After checkpoint");
});

test("an edit to covered history suppresses the old opaque item and its readable excerpt", async () => {
	const f = fixture();
	const result = await f.hooks.session_before_compact!(f.event(), f.ctx);
	const entry = f.append<CompactionEntry>({ type: "compaction", ...result.compaction });
	f.append<Extract<SessionEntry, { type: "context_edit" }>>({ type: "context_edit", targetId: f.entries[0]!.id, replacement: null });
	const summary = { role: "compactionSummary" as const, summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: 0 };
	const native = convertToLlm([summary])[0];
	const text = native?.role === "user" && Array.isArray(native.content) && native.content[0]?.type === "text" ? native.content[0].text : "";
	const payload = { input: [{ role: "user", content: [{ type: "input_text", text }] }] };
	expect(await f.hooks.before_provider_request!({ payload }, f.ctx)).toBeUndefined();
	const rewritten = await f.hooks.context!({ messages: [summary] }, f.ctx);
	expect(rewritten.messages[0].summary).not.toContain("indigo-7432");
});

test("non-Codex and proxied Codex text models skip remote and use soft under the default chain", async () => {
	for (const other of [
		{ ...model, provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
		{ ...model, baseUrl: "https://proxy.example/backend-api" },
	] as Model[]) {
		const f = fixture();
		const result = await f.hooks.session_before_compact!(f.event(), { ...f.ctx, model: other });
		expect(result.compaction.summary).toBe("Readable result");
		expect(f.counts()).toEqual([0, 1]);
	}
});

test("manual soft bypasses remote; aborted compaction never falls back", async () => {
	const f = fixture();
	await f.hooks.session_before_compact!({ ...f.event(), customInstructions: "soft keep the facts" }, f.ctx);
	expect(f.counts()).toEqual([0, 1]);
	expect(f.lastSoft()).toContain("Additional focus: keep the facts");
	const stopped = await f.hooks.session_before_compact!({ ...f.event(), signal: AbortSignal.abort() }, f.ctx);
	expect(stopped).toEqual({ cancel: true });
	expect(f.counts()).toEqual([0, 1]);
});

test("config ordering is deduped and portable view is explicitly bounded", () => {
	expect(methodOrder(["remote", "remote", "soft"])).toEqual(["remote", "soft"]);
	expect(methodOrder(["unexpected"])).toBeUndefined();
	const text = remotePortableSummary("start " + "x".repeat(200) + " end", [], 160);
	expect(text.length).toBeLessThanOrEqual(160);
	expect(text).toStartWith("start");
	expect(text).toEndWith("end");
});