/**
 * IRC semantics regression tests. Run: bun test/irc.test.ts
 *
 * Pure-mailbox: a send parks a durable file in the recipient's mailbox and rings
 * a doorbell; the recipient drains it. Covers idempotent parking, drain ordering,
 * waiters, delivery across restart, the "confirm before unlink" durability rule,
 * and rendering.
 */
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { messagePath, removeMessage } from "../mailbox.ts";
import { broadcastTargets, formatIrcForModel, IrcNode, ircDir, seenDir, socketPathFor } from "../irc.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
	if (!cond) failures++;
}

// Isolate sockets, rings, and mail on a temp tree.
const base = mkdtempSync(path.join(os.tmpdir(), "herdr-irc-"));
process.env.PI_IRC_DIR = path.join(base, "sock");
process.env.PI_IRC_SEEN_DIR = path.join(base, "seen");
process.env.PI_IRC_MAIL_DIR = path.join(base, "mail");

const inbox: string[] = [];
const B = new IrcNode({
	paneId: "tst:pB",
	sessionId: "sessB",
	identity: "bob",
	deliver: (e) => inbox.push(e.body),
});
await B.start();
const A = new IrcNode({ paneId: "tst:pA", sessionId: "sessA", identity: "alice", deliver: () => {} });
await A.start();

const bob = { mailboxKey: "sessB", paneId: "tst:pB", identity: "bob" };

let r = await A.send(bob, "hello", { dedupeId: "d1" });
check("send -> mailboxed", r.ack.ack === "mailboxed", r.ack.ack);
await B.drain();
check("drain delivers", inbox.length === 1 && inbox[0] === "hello", inbox.join(","));
check("delivered -> unlinked", !existsSync(messagePath("sessB", "d1")));

// idempotency: while a message is parked, a retry is a `duplicate`. Send with
// no doorbell so the message stays parked long enough to observe it.
const bobParked = { mailboxKey: "sessB", identity: "bob" };
r = await A.send(bobParked, "parked", { dedupeId: "d7" });
check("first park -> mailboxed", r.ack.ack === "mailboxed", r.ack.ack);
const parkedId = r.env.id;
r = await A.send(bobParked, "parked", { dedupeId: "d7" });
check("retry while parked -> duplicate", r.ack.ack === "duplicate", r.ack.ack);
check(
	"duplicate reports the already-parked id",
	r.ack.id === parkedId && r.env.id === parkedId,
	`${r.ack.id} vs ${parkedId}`,
);
await B.drain();

// after delivery the file is gone, so a late retry re-parks; the recipient's
// dedup ring is what prevents a second delivery to the model
r = await A.send(bobParked, "late retry", { dedupeId: "d7" });
await B.drain();
check(
	"late retry does not double-deliver",
	inbox.filter((b) => b === "parked").length === 1 && !inbox.includes("late retry"),
	inbox.join(","),
);

// a blocked wait consumes the message instead of injecting it
const wp = B.wait({ timeoutMs: 2000 });
r = await A.send(bob, "for waiter", { dedupeId: "d3" });
await B.drain();
const got = await wp;
check(
	"waiter resolves",
	got?.body === "for waiter" && !inbox.includes("for waiter"),
	`got=${got?.body} inbox=${inbox.join(",")}`,
);

// mail queued while the recipient is down is delivered when it next runs
B.stop();
r = await A.send(bob, "while down", { dedupeId: "d4" });
check("send to absent pane still parks", r.ack.ack === "mailboxed", r.ack.ack);
const B2 = new IrcNode({
	paneId: "tst:pB2",
	sessionId: "sessB",
	identity: "bob",
	deliver: (e) => inbox.push(e.body),
});
await B2.start();
await B2.drain();
check("queued while down -> drained on start", inbox.includes("while down"), inbox.join(","));

// deleting a socket must not touch the durable dedup ring (keyed by session)
rmSync(path.join(ircDir(), "tst~pB2.sock"), { force: true });
check("ring survives socket rm", existsSync(path.join(seenDir(), "sessB.seen")));
await (B2 as unknown as { listen: () => Promise<void> }).listen();

// durability rule: injected but not yet in the transcript -> keep the file
let persisted = false;
const cInbox: string[] = [];
const C = new IrcNode({
	paneId: "tst:pC",
	sessionId: "sessC",
	identity: "carol",
	deliver: (e) => cInbox.push(e.body),
	isPersisted: () => persisted,
});
await C.start();
const carol = { mailboxKey: "sessC", paneId: "tst:pC", identity: "carol" };
r = await A.send(carol, "pending", { dedupeId: "d5" });
await C.drain();
check("injected but unconfirmed -> kept", cInbox.length === 1 && existsSync(messagePath("sessC", "d5")));
persisted = true;
await C.settle();
check("confirmed at settle -> unlinked once", !existsSync(messagePath("sessC", "d5")) && cInbox.length === 1);
C.stop();

// re-arm: if a message was injected and then dropped (e.g. aborted), it is retried
let persisted2 = false;
const dInbox: string[] = [];
const D = new IrcNode({
	paneId: "tst:pD",
	sessionId: "sessD",
	identity: "dave",
	deliver: (e) => dInbox.push(e.body),
	isPersisted: () => persisted2,
});
await D.start();
await A.send({ mailboxKey: "sessD", paneId: "tst:pD", identity: "dave" }, "retry-me", { dedupeId: "d6" });
await D.drain();
check("first attempt injected, kept", dInbox.length === 1 && existsSync(messagePath("sessD", "d6")));
await D.settle(); // not persisted -> re-armed (and re-injected on the immediate drain)
check("re-armed and re-injected", dInbox.length >= 2, dInbox.join(","));
persisted2 = true;
await D.settle();
check("eventually confirmed and unlinked", !existsSync(messagePath("sessD", "d6")));
D.stop();

// stale ring reaping
const staleRing = path.join(seenDir(), "old.sock.seen");
writeFileSync(staleRing, "old\n");
const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
utimesSync(staleRing, old, old);
const E = new IrcNode({ paneId: "tst:pE", sessionId: "sessE", identity: "erin", deliver: () => {} });
await E.start();
check("stale ring reaped on start", !existsSync(staleRing));
E.stop();

// broadcast is not workspace-scoped: it unions live peers with durable registry
// identities, so other-workspace live agents and dormant agents (no live pane)
// are not silently skipped, while the sender is
const bt = broadcastTargets(
	[
		{ pane_id: "tst:pB", identity: "bob", mailboxKey: "sessB" },
		{ pane_id: "tst:pA", identity: "alice", self: true },
	],
	[
		{ pane_id: "tst:pB", name: "bob", session_id: "sessB", pid: process.pid },
		{ pane_id: "w9:pZ", name: "zoe", session_id: "sessZ", pid: 0 },
		{ pane_id: "tst:pA", name: "alice", session_id: "sessA", pid: process.pid },
	],
	"tst:pA",
);
check(
	"broadcast unions live + dormant, skips self",
	bt.map((t) => t.mailboxKey).join(",") === "sessB,sessZ",
	JSON.stringify(bt),
);
check("live durable keeps its pane for the doorbell", bt[0]?.paneId === "tst:pB");
check("dormant durable is mailbox-only", bt[1]?.paneId === undefined && bt[1]?.identity === "zoe");

// a duplicate retry must still ring the doorbell (a live recipient is re-nudged)
const fakePane = "tst:pFake";
let doorbells = 0;
const fakeServer = net.createServer((s) => {
	doorbells++;
	s.write("ok\n", () => s.end());
});
await new Promise<void>((resolve) => fakeServer.listen(socketPathFor(fakePane), resolve));
const fake = { mailboxKey: "fakeSess", paneId: fakePane, identity: "fake" };
const f1 = await A.send(fake, "nudge", { dedupeId: "df1" });
const f2 = await A.send(fake, "nudge", { dedupeId: "df1" });
check("duplicate retry re-nudges the doorbell", doorbells === 2, String(doorbells));
check("duplicate retry keeps the parked id", f2.env.id === f1.env.id && f2.ack.id === f1.env.id);
await new Promise<void>((resolve) => fakeServer.close(() => resolve()));

// a duplicate retry whose doorbell makes the recipient drain must still report
// the parked envelope, not the fresh (never-parked) id: the parked entry is read
// before ringing, so the drain cannot race the ack
const racePane = "tst:pRace";
let drainOnDoorbell = false;
const raceServer = net.createServer((s) => {
	if (drainOnDoorbell) removeMessage("raceSess", "dr1");
	s.write("ok\n", () => s.end());
});
await new Promise<void>((resolve) => raceServer.listen(socketPathFor(racePane), resolve));
const race = { mailboxKey: "raceSess", paneId: racePane, identity: "race" };
const r1 = await A.send(race, "race", { dedupeId: "dr1" });
drainOnDoorbell = true; // recipient now unlinks on the doorbell
const r2 = await A.send(race, "race", { dedupeId: "dr1" });
check(
	"duplicate ack survives a doorbell-triggered drain",
	r2.ack.ack === "duplicate" && r2.ack.id === r1.env.id && r2.env.id === r1.env.id,
	`${r2.ack.ack} ${r2.ack.id} vs ${r1.env.id}`,
);
await new Promise<void>((resolve) => raceServer.close(() => resolve()));

// a session switch must not orphan unconfirmed pane-keyed mail: it is reattached
// to the durable session mailbox before the key flips
let xPersisted = false;
const xInbox: string[] = [];
const X = new IrcNode({
	paneId: "tst:pX",
	identity: "xavier",
	deliver: (e) => xInbox.push(e.body),
	isPersisted: () => xPersisted,
});
await X.start();
await A.send({ mailboxKey: "tst:pX", identity: "xavier" }, "pane-keyed", { dedupeId: "dx1" });
check("pane-keyed mail parked before switch", existsSync(messagePath("tst:pX", "dx1")));
X.setSession("sessX", "xavier");
// setSession auto-drains; unconfirmed, so it stays in the session mailbox
check(
	"pane-keyed mail reattached to session",
	existsSync(messagePath("sessX", "dx1")) && !existsSync(messagePath("tst:pX", "dx1")),
);
check("reattached mail delivered", xInbox.includes("pane-keyed"), xInbox.join(","));
xPersisted = true;
await X.settle();
check("reattached mail confirmed once", !existsSync(messagePath("sessX", "dx1")) && xInbox.length === 1);
X.stop();

// incoming rendering must never demand a reply (omp's anti-ping-pong model)
const msg = { id: "m1", from: "bob", to: "alice", body: "ping", ts: 0 };
const unset = formatIrcForModel(msg);
check(
	"unset expectsReply -> conditional, not imperative",
	unset.includes("If a response is expected") && !unset.includes("Reply with the irc tool"),
);
check("renders the message id for replyTo", unset.includes("[m1]") && unset.includes("replyTo=m1"));
check("expectsReply:true -> response expected", formatIrcForModel({ ...msg, expectsReply: true }).includes("A response is expected"));
check("expectsReply:false -> no reply needed", formatIrcForModel({ ...msg, expectsReply: false }).includes("No reply is needed"));

A.stop();
B2.stop();
rmSync(base, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
