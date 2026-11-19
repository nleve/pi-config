import { expect, test } from "bun:test";
import { DelegateRegistry, type ModelLike } from "../delegates.ts";
import { registerIrcTool, type IrcNode } from "../irc.ts";
import { CURSOR_MARKER, renderFakeCursor, visibleWidth } from "@earendil-works/pi-tui";
import { highlightMentionRow } from "../mention-editor.ts";
import { appendMentionRouting, draftMentions, modelMentionItems, renderMentionMessage, workerMentionItems } from "../mentions.ts";

const models: ModelLike[] = [
	{ id: "solver", provider: "first", name: "Solver", reasoning: true, thinkingLevelMap: { high: null, xhigh: "extra" } },
	{ id: "solver", provider: "second", name: "Solver", reasoning: true },
	{ id: "solver:max", provider: "first", name: "Solver Max" },
];
const workers = [{ name: "old-otter" }, { name: "live-otter", pane: "w1:p2", project: "demo" }];

const values = (query: string) => modelMentionItems(models, query).map(item => item.value);

test("colon completion preserves literal model IDs and only offers supported levels", () => {
	const items = values("solver:");
	expect(items[0]).toBe("^solver:max");
	expect(items).toContain("^first/solver:xhigh");
	expect(items).not.toContain("^first/solver:high");
	expect(items).toContain("^second/solver:high");
	expect(items).not.toContain("^second/solver:xhigh");
	expect(values("second/solver:hi")).toEqual(["^second/solver:high"]);
});

test("worker completion ranks live handles first and describes dormant mailboxes", () => {
	const items = workerMentionItems(workers, "otter");
	expect(items.map(item => item.value)).toEqual(["^^live-otter", "^^old-otter"]);
	expect(items[0]?.description).toContain("live · w1:p2");
	expect(items[1]?.description).toBe("offline · mail waits for resume");
});

test("inline transcript styling is render-only and uses the resolution at submit time", () => {
	const registry = new DelegateRegistry({ availableModels: () => models, persist() {} });
	const prompt = "Ask ^second/solver:low to compare with ^^live-otter and ^^old-otter (not ^unknown).";
	const routed = appendMentionRouting(prompt, registry.expand(prompt).legend, workers);
	expect(routed).toContain("use only IRC for dormant workers");
	expect(routed).toContain("^^live-otter → live · w1:p2");
	const rendered = renderMentionMessage(routed);
	expect(rendered).toBe("Ask `^second/solver:low` to compare with `^^live-otter` and `^^old-otter` (not ^unknown).");
	expect(rendered).not.toContain("Recognized:");
	expect(rendered).not.toContain("w1:p2");
	expect(rendered).not.toContain("herdr:mention-routing");
	expect(renderMentionMessage(routed + "\n\nOther extension output")).toEndWith("Other extension output");
	expect(renderMentionMessage("plain ^unknown and ^^ghost")).toBe("plain ^unknown and ^^ghost");
});

test("draft resolves only real mentions, without persisting or styling shell input", () => {
	const registry = new DelegateRegistry({ availableModels: () => models, persist() { throw Error("draft persisted"); } });
	const resolve = (text: string) => [...draftMentions(text, models, registry, () => workers)];
	expect(resolve("^second/solver:low ^^live-otter ^^old-otter ^typo ^first/solver:high")).toEqual([
		["^second/solver:low", "model"], ["^^live-otter", "worker"], ["^^old-otter", "offline"],
	]);
	expect(resolve("! echo ^second/solver:low")).toEqual([]);
});

test("editor styling preserves terminal width and Pi's cursor markers", () => {
	const row = "Ask " + CURSOR_MARKER + renderFakeCursor("^") + "second/solver:low or ^^live-otter or ^typo.";
	const mentions = new Map([["^second/solver:low", "model"], ["^^live-otter", "worker"]] as const);
	const seen: string[] = [];
	const rendered = highlightMentionRow(row, mentions, (kind, text) => {
		seen.push(kind);
		return "\x1b[36m" + text + "\x1b[39m";
	});
	expect(seen).toEqual(["model", "worker"]);
	expect(rendered).toContain(CURSOR_MARKER + renderFakeCursor("^"));
	expect(rendered.replace(/\x1b\[(?:36|39)m/g, "")).toBe(row);
	expect(visibleWidth(rendered)).toBe(visibleWidth(row));
});

test("IRC broadcast requires an explicit target and uses only the scoped live roster", async () => {
	let execute: ((...args: unknown[]) => Promise<{ details: { recipients?: number } }>) | undefined;
	const sent: string[] = [];
	const scopes: string[] = [];
	const node = {
		paneId: "self", identity: "self", listListeners: () => ["child", "external"],
		async send(target: { identity: string }) {
			sent.push(target.identity);
			return { env: { id: "123" }, ack: { ack: "mailboxed" } };
		},
	} as unknown as IrcNode;
	registerIrcTool({ registerTool(tool: { execute: typeof execute }) { execute = tool.execute; } } as never, {
		node,
		listAgents: async (scope) => {
			scopes.push(scope);
			return [{ pane_id: "child", name: "child" }, { pane_id: "offline", name: "offline" },
				...(scope === "all" ? [{ pane_id: "external", name: "external" }] : [])];
		},
		resolveTarget: async () => undefined,
	});
	const send = (to?: string, scope?: string) => execute!("call", { action: "send", to, scope, body: "fixture" }, undefined, undefined, { mode: "rpc" });
	await expect(send()).rejects.toThrow("provide a target");
	expect((await send("all")).details.recipients).toBe(1);
	expect((await send("all", "all")).details.recipients).toBe(2);
	expect(scopes).toEqual(["workspace", "all"]);
	expect(sent).toEqual(["child", "child", "external"]);
});

test("IRC reports a directed dormant message only after a new durable acknowledgement", async () => {
	let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
	const notices: string[] = [];
	let duplicate = false;
	const node = {
		paneId: "self",
		identity: "self",
		async send() {
			return { env: { id: "123" }, ack: { ack: duplicate ? "duplicate" : "mailboxed" } };
		},
	} as unknown as IrcNode;
	registerIrcTool({ registerTool(tool: { execute: typeof execute }) { execute = tool.execute; } } as never, {
		node,
		listAgents: async () => [],
		resolveTarget: async () => ({ mailboxKey: "session", identity: "old-otter" }),
	});
	const send = () => execute!("call", { action: "send", to: "^^old-otter", body: "fixture" }, undefined, undefined, {
		mode: "tui", ui: { notify: (message: string) => notices.push(message) },
	});
	await send();
	duplicate = true;
	await send();
	expect(notices).toEqual(["Queued for ^^old-otter (dormant)"]);
});
