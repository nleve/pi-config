/**
 * IRC semantics regression tests. Run: bun test/irc.test.ts
 *
 * Covers delivery modes, the persisted dedup ring (incl. across restart and a
 * socket-only cleanup), and the at-least-once crash window (deliver happens,
 * record does not -> a retry re-delivers).
 */
import { existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatIrcForModel, IrcNode, ircDir, seenDir } from "../irc.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
	if (!cond) failures++;
}

/** Clean only this test's artifacts in BOTH dirs — never the whole shared dir. */
function clean() {
	for (const dir of [ircDir(), seenDir()]) {
		try {
			for (const f of readdirSync(dir)) if (f.startsWith("tst~")) rmSync(join(dir, f), { force: true });
		} catch {}
	}
}

clean();

let busy = false;
const inbox: string[] = [];
const B = new IrcNode({
	paneId: "tst:pB",
	identity: "bob",
	deliver: (e) => inbox.push(e.body),
	isBusy: () => busy,
});
await B.start();
const A = new IrcNode({ paneId: "tst:pA", identity: "alice", deliver: () => {} });
await A.start();

let r = await A.send("tst:pB", "hello", { dedupeId: "d1" });
check("no waiter -> queued", r.ack.ack === "queued" && inbox.length === 1, r.ack.ack);

r = await A.send("tst:pB", "again", { dedupeId: "d1" });
check("same dedupeId -> duplicate", r.ack.ack === "duplicate" && inbox.length === 1, r.ack.ack);

busy = true;
r = await A.send("tst:pB", "urgent", { mode: "reject", dedupeId: "d2" });
check(
	"reject while busy -> rejected",
	r.ack.ack === "rejected" && inbox.length === 1,
	`${r.ack.ack}/${r.ack.reason}`,
);
busy = false;

const wp = B.wait({ timeoutMs: 2000 });
r = await A.send("tst:pB", "for waiter", { dedupeId: "d3" });
const got = await wp;
check(
	"waiter -> accepted",
	r.ack.ack === "accepted" && got?.body === "for waiter" && inbox.length === 1,
	r.ack.ack,
);

// dedup ring survives a recipient restart
B.stop();
const B2 = new IrcNode({ paneId: "tst:pB", identity: "bob", deliver: (e) => inbox.push(e.body) });
await B2.start();
r = await A.send("tst:pB", "retry d1", { dedupeId: "d1" });
check("dedupe after restart -> duplicate", r.ack.ack === "duplicate" && inbox.length === 1, r.ack.ack);

// a socket-only cleanup must not touch the durable ring
rmSync(join(ircDir(), "tst~pB.sock"), { force: true });
check("ring survives socket rm", existsSync(join(seenDir(), "tst~pB.sock.seen")));
// restore the socket (exercises listen()) before the next case
await (B2 as unknown as { listen: () => Promise<void> }).listen();

// crash window: deliver happens, record does not -> retry re-delivers (at-least-once)
(B2 as unknown as { recordSeen: () => void }).recordSeen = () => {};
r = await A.send("tst:pB", "crash-window", { dedupeId: "d4" });
const mid = inbox.length;
r = await A.send("tst:pB", "crash-window retry", { dedupeId: "d4" });
check(
	"crash window -> at-least-once redelivery",
	mid === 2 && inbox.length === mid + 1,
	`inbox 1 -> ${mid} -> ${inbox.length}`,
);

// stale ring reaping: a `.seen` untouched for > SEEN_TTL is removed on start
const stalePath = join(seenDir(), "tst~old.sock.seen");
writeFileSync(stalePath, "old\n");
const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
utimesSync(stalePath, old, old);
const B3 = new IrcNode({ paneId: "tst:pC", identity: "carol", deliver: () => {} });
await B3.start();
check("stale ring reaped on start", !existsSync(stalePath));
B3.stop();

// incoming rendering must never demand a reply (omp's anti-ping-pong model)
const msg = { id: "m1", from: "bob", to: "alice", body: "ping", ts: 0 };
const unset = formatIrcForModel(msg);
check(
	"unset expectsReply -> conditional, not imperative",
	unset.includes("If a response is expected") && !unset.includes("Reply with the irc tool"),
);
check("renders the message id for replyTo", unset.includes("[m1]") && unset.includes("replyTo=m1"));
check(
	"expectsReply:true -> response expected",
	formatIrcForModel({ ...msg, expectsReply: true }).includes("A response is expected"),
);
check(
	"expectsReply:false -> no reply needed",
	formatIrcForModel({ ...msg, expectsReply: false }).includes("No reply is needed"),
);

A.stop();
B2.stop();
clean();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
