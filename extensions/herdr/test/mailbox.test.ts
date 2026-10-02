/**
 * Mailbox unit tests. Run: bun test/mailbox.test.ts
 *
 * The mailbox is the single durable delivery path, so its invariants matter:
 * atomic idempotent parking, stable ordering, and safe reaping.
 */
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	enqueue,
	envelopeKey,
	listPending,
	mailboxDir,
	messagePath,
	removeMessage,
	sweepMailboxes,
} from "../mailbox.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
	if (!cond) failures++;
}

const root = mkdtempSync(path.join(os.tmpdir(), "herdr-mailbox-"));
const env = (id: string, ts: number, over: Record<string, unknown> = {}) => ({
	id,
	from: "alice",
	to: "bob",
	body: id,
	ts,
	...over,
});

check("enqueue publishes", enqueue("s1", env("m1", 2), root) === "enqueued");
check("same key -> duplicate", enqueue("s1", env("m1", 2), root) === "duplicate");
check("dedupeId is the key", envelopeKey(env("m1", 2, { dedupeId: "d9" })) === "d9");
enqueue("s1", env("m3", 3, { dedupeId: "d9" }), root);
check("dedupeId file name", existsSync(messagePath("s1", "d9", root)));

enqueue("s1", env("m2", 1), root);
const pending = listPending("s1", root);
check("pending ordered oldest first", pending.map((p) => p.env.id).join(",") === "m2,m1,m3", pending.map((p) => p.env.id).join(","));

removeMessage("s1", "m1", root);
check("remove", listPending("s1", root).length === 2);

// malformed files are dropped, not delivered
writeFileSync(path.join(mailboxDir("s1", root), "junk.json"), "{not json");
check("malformed dropped", listPending("s1", root).length === 2);

// reaping: an untouched message older than the TTL goes away
const stale = messagePath("sOld", "old", root);
enqueue("sOld", env("old", 1), root);
const old = new Date(Date.now() - 60_000);
utimesSync(stale, old, old);
sweepMailboxes(1000, root);
check("stale mail reaped", !existsSync(stale));

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
