/**
 * IRC semantics regression tests. Run: bun test/irc.test.ts
 *
 * Pure-mailbox: a send parks a durable file in the recipient's mailbox and rings
 * a doorbell; the recipient drains it. Covers idempotent parking, drain ordering,
 * waiters, delivery across restart, the "confirm before unlink" durability rule,
 * and rendering.
 */
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { messagePath } from "../mailbox.ts";
import { formatIrcForModel, IrcNode, ircDir, seenDir } from "../irc.ts";

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
r = await A.send(bobParked, "parked", { dedupeId: "d7" });
check("retry while parked -> duplicate", r.ack.ack === "duplicate", r.ack.ack);
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
