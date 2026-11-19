import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { formatIrcForModel, IrcNode } from "../irc.ts";
import { listPending } from "../mailbox.ts";

test("IRC titles are snapshotted without changing routing or reply filters", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pi-irc-title-"));
	const env = { PI_IRC_MAIL_DIR: path.join(dir, "mail"), PI_IRC_SEEN_DIR: path.join(dir, "seen") };
	const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
	Object.assign(process.env, env);
	try {
		let title = "\x1b[31mToken Renewal\x1b[0m\nAudit";
		const from = new IrcNode({ paneId: "w1:p1", identity: "audit-otter", getTitle: () => title, deliver() {} });
		const to = new IrcNode({ paneId: "w1:p2", identity: "receiver", sessionId: "target", deliver() {} });
		const target = { mailboxKey: "target", identity: "receiver" };
		const first = await from.send(target, "Hello", { dedupeId: "one", expectsReply: true });
		expect(first.env).toMatchObject({ from: "audit-otter", fromTitle: "Token Renewal Audit" });
		title = "New Session Title";
		const duplicate = await from.send(target, "Hello", { dedupeId: "one" });
		expect(duplicate.ack.ack).toBe("duplicate");
		expect(duplicate.env.fromTitle).toBe("Token Renewal Audit");
		expect(listPending("target")[0]?.env.fromTitle).toBe("Token Renewal Audit");
		const waiting = to.wait({ from: "audit-otter", timeoutMs: 1000 });
		await to.drain();
		const delivered = await waiting;
		expect(delivered).toEqual(first.env);
		const shown = formatIrcForModel(delivered!);
		expect(shown).toContain("Token Renewal Audit (^^audit-otter):\nHello");
		expect(shown).toContain(`to=audit-otter, replyTo=${first.env.id}`);
		expect((await from.send(target, "Later")).env.fromTitle).toBe("New Session Title");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("untitled senders and old messages keep the existing header", () => {
	const env = { id: "m1", from: "audit-otter", to: "receiver", body: "Hello", ts: 0, expectsReply: false };
	const legacy = "[irc] [m1] audit-otter:\nHello\n\nNo reply is needed.";
	expect(formatIrcForModel(env)).toBe(legacy);
	expect(formatIrcForModel({ ...env, fromTitle: "audit-otter" })).toBe(legacy);
});