/**
 * Navigation spawn-ledger tests. Run: bun test/navigation.test.ts
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseSpawnEntry, readSpawnEntries, SPAWN_ENTRY_TYPE, type SpawnEntry } from "../navigation.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
	if (!cond) failures++;
}

/** Fake ctx exposing just the branch `readSpawnEntries` folds. */
function branch(entries: unknown[]): ExtensionContext {
	return { sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
}

function spawn(data: Partial<SpawnEntry> & { name: string; ts: number }): unknown {
	return { customType: SPAWN_ENTRY_TYPE, data: { action: "spawn", ...data } };
}

// parseSpawnEntry keeps known fields and drops everything else.
const parsed = parseSpawnEntry({
	action: "spawn",
	name: "amber-otter",
	ts: 10,
	pane_id: "w1:pA",
	session_path: "/tmp/a.jsonl",
	bogus: true,
});
check("parse keeps known fields", parsed?.name === "amber-otter" && parsed?.pane_id === "w1:pA");
check("parse drops unknown fields", parsed !== undefined && !("bogus" in parsed));

// Malformed entries are ignored rather than throwing.
check("parse rejects missing name", parseSpawnEntry({ action: "spawn", ts: 1 }) === undefined);
check("parse rejects bad action", parseSpawnEntry({ action: "nope", name: "x", ts: 1 }) === undefined);
check("parse rejects bad ts", parseSpawnEntry({ action: "spawn", name: "x", ts: "1" }) === undefined);

// Non-ledger branch entries and malformed payloads are skipped; one entry per
// name survives (latest ts), most-recent-first.
const ctx = branch([
	spawn({ name: "a", ts: 1, pane_id: "w1:p1" }),
	{ customType: "other", data: { action: "spawn", name: "ignored", ts: 99 } },
	{ customType: SPAWN_ENTRY_TYPE, data: { action: "spawn", ts: 5 } },
	spawn({ name: "b", ts: 2, pane_id: "w1:p2" }),
	spawn({ name: "a", ts: 3, pane_id: "w1:p3" }),
]);
const folded = readSpawnEntries(ctx);
check("malformed ignored", folded.length === 2);
check("latest ts wins", folded.find((e) => e.name === "a")?.pane_id === "w1:p3");
check("most-recent-first", folded[0]!.name === "a" && folded[1]!.name === "b");

// A resume appends the same name with a newer ts and a fresh pane id; the new
// record replaces the old one.
const resumed = readSpawnEntries(
	branch([spawn({ name: "a", ts: 1, pane_id: "w1:old" }), spawn({ name: "a", ts: 7, pane_id: "w1:new" })]),
);
check("resume replaces old pane", resumed.length === 1 && resumed[0]!.pane_id === "w1:new");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
