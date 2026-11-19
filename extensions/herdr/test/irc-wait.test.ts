import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { IrcNode, type IrcEnvelope } from "../irc.ts";
import { listPending } from "../mailbox.ts";

async function fixture(check: (f: {
	caller: IrcNode; peer: IrcNode; injected: IrcEnvelope[];
	request: () => Promise<string>; reply: (id: string, body?: string) => Promise<IrcEnvelope>;
}) => Promise<void>) {
	const root = mkdtempSync(path.join(os.tmpdir(), "pi-irc-wait-"));
	const env = { PI_IRC_MAIL_DIR: path.join(root, "mail"), PI_IRC_SEEN_DIR: path.join(root, "seen"), PI_IRC_DIR: path.join(root, "sockets") };
	const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	const injected: IrcEnvelope[] = [];
	const caller = new IrcNode({ paneId: "test:p1", identity: "caller", sessionId: "session-caller", deliver: env => injected.push(env) });
	const peer = new IrcNode({ paneId: "test:p2", identity: "peer", sessionId: "session-peer", deliver() {} });
	try {
		await check({ caller, peer, injected,
			request: async () => (await caller.send({ mailboxKey: "session-peer" }, "Question", { expectsReply: true })).env.id,
			reply: async (id, body) => (await peer.send({ mailboxKey: "session-caller" }, body ?? "Answer", { replyTo: id, expectsReply: false })).env,
		});
	} finally {
		caller.stop();
		peer.stop();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

test("a reply arriving before wait stays durable and is claimed without a duplicate follow-up", async () => {
	await fixture(async ({ caller, injected, request, reply }) => {
		const a = await request();
		const b = await request();
		const first = await reply(a, "First");
		const second = await reply(b, "Second");
		await caller.drain(); // Model is still deciding to call wait.
		expect(injected).toEqual([]);
		expect(listPending("session-caller")).toHaveLength(2);
		expect(await caller.wait({ from: "^^peer", replyTo: b, timeoutMs: 1000 })).toEqual(second);
		expect(await caller.wait({ from: "peer", replyTo: a, timeoutMs: 1000 })).toEqual(first);
		await caller.settle();
		expect(listPending("session-caller")).toEqual([]);
		expect(injected).toEqual([]);
	});
});

test("unrelated messages arrive normally and unclaimed replies become follow-ups at settle", async () => {
	await fixture(async ({ caller, peer, injected, request, reply }) => {
		const id = await request();
		const fast = await reply(id);
		const normal = (await peer.send({ mailboxKey: "session-caller" }, "FYI", { expectsReply: false })).env;
		await caller.drain();
		expect(injected).toEqual([normal]);
		await caller.settle();
		expect(injected).toEqual([normal, fast]);
	});
});

test("a held reply stays in the original mailbox on a session switch", async () => {
	await fixture(async ({ caller, injected, request, reply }) => {
		const id = await request();
		const fast = await reply(id);
		await caller.drain();
		caller.setSession("different-session");
		expect(listPending("session-caller").map(m => m.env)).toEqual([fast]);
		expect(injected).toEqual([]);
	});
});