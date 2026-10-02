/**
 * Navigation spawn-ledger tests. Run: bun test/navigation.test.ts
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	parseSpawnEntry,
	readSpawnEntries,
	resolveIdentity,
	SPAWN_ENTRY_TYPE,
	type SpawnEntry,
} from "../navigation.ts";
import { isAlive, type AgentIdentity } from "../registry.ts";

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

function ident(over: Partial<AgentIdentity>): AgentIdentity {
	return {
		pane_id: "w1:p1",
		name: "amber-otter",
		pid: 1,
		started_at: 1,
		updated_at: 1,
		...over,
	};
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

// H1: a recycled pane's live occupant must not stand in for the entry's own
// (dormant) identity. resolveIdentity keys off durable refs, never the pane.
const dormant = ident({
	pane_id: "w1:p1",
	name: "amber-otter",
	session_id: "sess-a",
	session_path: "/tmp/a.jsonl",
});
const occupant = ident({
	pane_id: "w1:p1",
	name: "zesty-llama",
	session_id: "sess-b",
	session_path: "/tmp/b.jsonl",
	pid: process.pid,
});
check("recycled-pane occupant is live", isAlive(occupant.pid));
const entry: SpawnEntry = {
	action: "spawn",
	name: "amber-otter",
	session_id: "sess-a",
	session_path: "/tmp/a.jsonl",
	pane_id: "w1:p1",
	ts: 1,
};
check("resolveIdentity prefers dormant entry over live recycled occupant", resolveIdentity(entry, [dormant, occupant]) === dormant);
check(
	"resolveIdentity matches by session_path",
	resolveIdentity({ ...entry, name: "renamed-otter", session_id: undefined }, [dormant, occupant]) === dormant,
);
// A pane-only entry (no session ref, name not registered) must not resolve to
// whoever now occupies the pane.
check(
	"resolveIdentity does not match a recycled pane by pane id alone",
	resolveIdentity({ action: "spawn", name: "ghost-worker", pane_id: "w1:p1", ts: 1 }, [occupant]) === undefined,
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
