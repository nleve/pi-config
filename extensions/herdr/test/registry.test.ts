/**
 * Identity registry tests. Run: bun test/registry.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	identityByName,
	identityFile,
	mergeIdentity,
	pruneDeadIdentities,
	pruneRecycledIdentities,
	readIdentities,
	removeIdentity,
	resolvePaneRef,
	setIdentityGrouping,
	setIdentityParent,
	withIdentities,
	writeIdentity,
	type AgentIdentity,
} from "../registry.ts";
import { stageName } from "../names.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
	if (!cond) failures++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-reg-"));

function ident(over: Partial<AgentIdentity>): AgentIdentity {
	return {
		pane_id: "w3:pA",
		name: "amber-otter",
		pid: 1,
		started_at: 1,
		updated_at: 1,
		...over,
	};
}

check("identityFile sanitizes pane id", identityFile("w3:pA", dir).endsWith("w3~pA.json"));

writeIdentity(ident({}), dir);
writeIdentity(ident({ pane_id: "w3:pB", name: "brisk-falcon", model: "openai/gpt-5", session_path: "/x.jsonl" }), dir);
const read = readIdentities(dir);
check("read roundtrip", read.length === 2);

// malformed file is skipped
fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
check("malformed skipped", readIdentities(dir).length === 2);

// join by pane
const rows = [
	{ pane_id: "w3:pA", agent_status: "idle" },
	{ pane_id: "w3:pB", agent_status: "working", name: "herdr-name" },
	{ pane_id: "w3:pZ", agent_status: "idle" },
];
const joined = withIdentities(rows, read);
check("join adds registry name", joined[0]!.name === "amber-otter");
check("join keeps herdr name", joined[1]!.name === "herdr-name");
check("join adds model/session", joined[1]!.model === "openai/gpt-5" && joined[1]!.session_path === "/x.jsonl");
check("join leaves unknown pane alone", joined[2]!.name === undefined);

// workflow grouping: the spawning orchestrator stamps group/stage after the
// worker has registered (the worker does not know its own grouping).
setIdentityGrouping(read.find((i) => i.pane_id === "w3:pB")!, "wf", "dig", dir);
const reread = readIdentities(dir);
const grouped = reread.find((i) => i.pane_id === "w3:pB")!;
check("grouping persists", grouped.group === "wf" && grouped.stage === "dig");
check("join surfaces grouping", withIdentities([{ pane_id: "w3:pB" }], reread)[0]!.group === "wf");
check("setIdentityGrouping missing file -> false", setIdentityGrouping("nope", "x", "y", dir) === false);

// parent orchestrator link: the spawner stamps its own session/pane/name onto
// the child after the child has registered.
check("setIdentityParent missing -> false", setIdentityParent("nope", { session_id: "s-parent" }, dir) === false);
check(
	"setIdentityParent by pane sets fields",
	setIdentityParent("w3:pB", { session_id: "s-parent", pane_id: "w3:pP", name: "orchestrator" }, dir) === true,
);
const parented = readIdentities(dir).find((i) => i.pane_id === "w3:pB")!;
check(
	"parent fields persist",
	parented.parent_session_id === "s-parent" &&
		parented.parent_pane_id === "w3:pP" &&
		parented.parent_name === "orchestrator",
);
check(
	"parent merge preserves existing fields",
	parented.group === "wf" && parented.stage === "dig" && parented.name === "brisk-falcon" && parented.model === "openai/gpt-5",
);
check("setIdentityParent partial update keeps siblings", setIdentityParent("w3:pB", { name: "lead" }, dir) === true);
const reparented = readIdentities(dir).find((i) => i.pane_id === "w3:pB")!;
check(
	"parent partial update only changes provided field",
	reparented.parent_name === "lead" &&
		reparented.parent_session_id === "s-parent" &&
		reparented.parent_pane_id === "w3:pP",
);

// mergeIdentity is the locked read-modify-write primitive: it preserves fields
// it was not given and reports a missing entry (worker not registered yet).
const mdir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-reg-merge-"));
writeIdentity(ident({ pane_id: "w3:pM", name: "merge-target", session_id: "s-merge", group: "g1", model: "m1" }), mdir);
check("mergeIdentity missing file -> false", mergeIdentity("nope", { group: "x" }, mdir) === false);
check("mergeIdentity patches existing entry", mergeIdentity("s-merge", { stage: "merge" }, mdir) === true);
const afterMerge = readIdentities(mdir).find((i) => i.session_id === "s-merge")!;
check(
	"mergeIdentity preserves unpatched fields",
	afterMerge.stage === "merge" &&
		afterMerge.group === "g1" &&
		afterMerge.name === "merge-target" &&
		afterMerge.model === "m1",
);
fs.rmSync(mdir, { recursive: true, force: true });

// A recycled pane with two identities: preferIdentity picks the live/current
// entry deterministically, and only that file is stamped.
const pdir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-reg-parent-collide-"));
writeIdentity(ident({ pane_id: "w9:pR", name: "old-session", pid: 0, session_id: "s-old", updated_at: 100 }), pdir);
writeIdentity(ident({ pane_id: "w9:pR", name: "current", pid: process.pid, session_id: "s-new", updated_at: 200 }), pdir);
check("setIdentityParent shared pane -> true", setIdentityParent("w9:pR", { session_id: "s-parent" }, pdir) === true);
const collide = readIdentities(pdir);
check(
	"setIdentityParent shared pane stamps live entry only",
	collide.find((i) => i.name === "current")?.parent_session_id === "s-parent" &&
		collide.find((i) => i.name === "old-session")?.parent_session_id === undefined,
);
fs.rmSync(pdir, { recursive: true, force: true });

// deterministic workflow names
check("stageName deterministic", stageName("wf", "dig", 3) === "wf-dig-3");
check("stageName sanitizes", stageName("My WF!", "Critique", 1) === "my-wf-critique-1");
check("stageName avoids collision", stageName("wf", "dig", 1, new Set(["wf-dig-1"])) === "wf-dig-1-2");
check("stageName herdr-safe", /^[a-z][a-z0-9_-]{0,31}$/.test(stageName("Wf 2", "Dig Stage", 10, new Set())));

// resolution
check("resolve ^^name", resolvePaneRef("^^brisk-falcon", read) === "w3:pB");
check("resolve bare name", resolvePaneRef("amber-otter", read) === "w3:pA");
check("resolve unknown -> undefined", resolvePaneRef("nope", read) === undefined);
// A dormant entry's pane may have been recycled: never hand back its stale pane.
const dormantResolve = [ident({ pane_id: "w3:pDorm", name: "dormant-one", pid: 0, session_id: "s-dorm" })];
check("resolve dormant name -> undefined", resolvePaneRef("^^dormant-one", dormantResolve) === undefined);
check("resolve dormant pane -> undefined", resolvePaneRef("w3:pDorm", dormantResolve) === undefined);

removeIdentity("w3:pA", dir);
check("removeIdentity", readIdentities(dir).length === 1);

// dead-pid pruning
writeIdentity(ident({ pane_id: "w3:pDead", name: "dead", pid: 0 }), dir);
writeIdentity(ident({ pane_id: "w3:pLive", name: "live", pid: process.pid }), dir);
const removed = pruneDeadIdentities(dir);
check("prune removes dead pid only", removed === 1);
check("prune keeps live pid", readIdentities(dir).some((i) => i.name === "live"));

// Recycled panes: several identities share a pane_id but have different session
// keys. The join must prefer the live/current entry and be order-independent.
const recycled: AgentIdentity[] = [
	ident({ pane_id: "w9:pR", name: "old-session", pid: 0, session_id: "s-old", updated_at: 100 }),
	ident({ pane_id: "w9:pR", name: "current", pid: process.pid, session_id: "s-new", updated_at: 200 }),
];
const joinOldFirst = withIdentities([{ pane_id: "w9:pR" }], recycled)[0]!;
const joinNewFirst = withIdentities([{ pane_id: "w9:pR" }], [...recycled].reverse())[0]!;
check("withIdentities collision prefers live entry", joinOldFirst.name === "current");
check("withIdentities collision order-independent", joinNewFirst.name === "current");

// An explicit session_id on the record wins even over a live entry.
const joinedMatch = withIdentities([{ pane_id: "w9:pR", session_id: "s-old" }], recycled)[0]!;
check("withIdentities prefers record session match", joinedMatch.name === "old-session");

// With no live entry, the most recently updated one wins.
const dormantPair: AgentIdentity[] = [
	ident({ pane_id: "w9:pD", name: "older", pid: 0, session_id: "s-1", updated_at: 100 }),
	ident({ pane_id: "w9:pD", name: "newer", pid: 0, session_id: "s-2", updated_at: 300 }),
];
check("withIdentities prefers recent dormant", withIdentities([{ pane_id: "w9:pD" }], dormantPair)[0]!.name === "newer");

// identityByName collisions (same name, different panes) prefer the live entry.
const nameCollisions: AgentIdentity[] = [
	ident({ pane_id: "w9:pA", name: "same-name", pid: 0, session_id: "s-a", updated_at: 100 }),
	ident({ pane_id: "w9:pB", name: "same-name", pid: process.pid, session_id: "s-b", updated_at: 200 }),
];
check("identityByName prefers live entry", identityByName(nameCollisions).get("same-name")?.pane_id === "w9:pB");
check(
	"identityByName collision order-independent",
	identityByName([...nameCollisions].reverse()).get("same-name")?.pane_id === "w9:pB",
);

// pruneRecycledIdentities drops the stale entry sharing a recycled pane.
const cdir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-reg-collide-"));
writeIdentity(ident({ pane_id: "w9:pR", name: "old-session", pid: 0, session_id: "s-old", updated_at: 100 }), cdir);
writeIdentity(ident({ pane_id: "w9:pR", name: "current", pid: process.pid, session_id: "s-new", updated_at: 200 }), cdir);
check("pruneRecycledIdentities removes stale", pruneRecycledIdentities(cdir) === 1);
const survivors = readIdentities(cdir);
check("pruneRecycledIdentities keeps current", survivors.length === 1 && survivors[0]!.name === "current");
fs.rmSync(cdir, { recursive: true, force: true });

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
