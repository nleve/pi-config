import { expect, test } from "bun:test";
import { cleanTitle, parseTitle, registerSessionTitles, titleExcerpt } from "../session-title.ts";

const entries = [
	{ type: "message", message: { role: "user", content: "Audit token renewal.\n\n<!-- herdr:mention-routing -->\ninternal routes" } },
	{ type: "message", message: { role: "toolResult", content: "tool output" } },
	{ type: "message", message: { role: "assistant", stopReason: "stop", content: [
		{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "The cache expiry looks wrong." },
	] } },
];

test("title excerpt uses only visible user/assistant text and strips routing metadata", () => {
	expect(titleExcerpt(entries)).toBe("user: Audit token renewal.\nassistant: The cache expiry looks wrong.");
	expect(titleExcerpt([{ type: "message", message: { role: "user", content: "hi" } }])).toBeUndefined();
	expect(titleExcerpt([{ type: "message", message: { role: "user", content: "x".repeat(20_000) } }])?.length).toBeLessThan(1300);
	expect(cleanTitle("\x1b[31mSite\x1b[0m  \n audit")).toBe("Site audit");
	expect(parseTitle("<title>Session title: Site audit</title>")).toBe("Site audit");
	expect(parseTitle("First\nSecond")).toBeUndefined();
});

function fixture(initial?: string) {
	let name = initial;
	let id = "A";
	const hooks = new Map<string, (...args: unknown[]) => unknown>();
	let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	let attempts = 0;
	let resolve!: (result: unknown) => void;
	const api = {
		on(event: string, handler: (...args: unknown[]) => unknown) { hooks.set(event, handler); },
		getSessionName: () => name,
		setSessionName: (value: string) => { name = value; },
		registerCommand(_: string, def: { handler: typeof command }) { command = def.handler; },
	};
	const ctx = {
		mode: "tui", isIdle: () => true, model: { id: "title-fixture", provider: "test" }, ui: { notify() {} },
		sessionManager: { getSessionId: () => id, getBranch: () => entries },
		modelRegistry: { getAvailable: () => [], streamSimple() { attempts++; return { result: () => new Promise(r => { resolve = r; }) }; } },
	};
	registerSessionTitles(api as never, { canAutoTitle: () => !name });
	return {
		start: () => hooks.get("session_start")?.({}, ctx), settle: () => hooks.get("agent_settled")?.({}, ctx),
		retitle: () => command!("", ctx), name: () => name, count: () => attempts,
		manual: (value: string) => { name = value; }, swap: (value: string) => { id = value; },
		finish: async () => { resolve({ stopReason: "stop", content: [{ type: "text", text: "<title>Token Renewal Audit</title>" }] }); await Promise.resolve(); },
	};
}

test("auto-title starts once; explicit retitle leaves a more recent manual name alone", async () => {
	const f = fixture();
	f.start();
	f.settle();
	expect(f.count()).toBe(1);
	await f.finish();
	expect(f.name()).toBe("Token Renewal Audit");
	f.settle();
	expect(f.count()).toBe(1);
	const retitle = f.retitle();
	f.manual("User picked this name");
	await f.finish();
	await retitle;
	expect(f.name()).toBe("User picked this name");
});

test("already named sessions are protected; results cannot cross session switches", async () => {
	const f = fixture("Manual name");
	f.start();
	expect(f.count()).toBe(0);
	const req = f.retitle();
	f.swap("B");
	f.manual("Different session");
	f.start();
	await f.finish();
	await req;
	expect(f.name()).toBe("Different session");
});