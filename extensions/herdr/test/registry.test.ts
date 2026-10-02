/**
 * Identity registry tests. Run: bun test/registry.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	identityFile,
	pruneDeadIdentities,
	readIdentities,
	removeIdentity,
	resolvePaneRef,
	setIdentityGrouping,
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

// deterministic workflow names
check("stageName deterministic", stageName("wf", "dig", 3) === "wf-dig-3");
check("stageName sanitizes", stageName("My WF!", "Critique", 1) === "my-wf-critique-1");
check("stageName avoids collision", stageName("wf", "dig", 1, new Set(["wf-dig-1"])) === "wf-dig-1-2");
check("stageName herdr-safe", /^[a-z][a-z0-9_-]{0,31}$/.test(stageName("Wf 2", "Dig Stage", 10, new Set())));

// resolution
check("resolve ^^name", resolvePaneRef("^^brisk-falcon", read) === "w3:pB");
check("resolve bare name", resolvePaneRef("amber-otter", read) === "w3:pA");
check("resolve unknown -> undefined", resolvePaneRef("nope", read) === undefined);

removeIdentity("w3:pA", dir);
check("removeIdentity", readIdentities(dir).length === 1);

// dead-pid pruning
writeIdentity(ident({ pane_id: "w3:pDead", name: "dead", pid: 0 }), dir);
writeIdentity(ident({ pane_id: "w3:pLive", name: "live", pid: process.pid }), dir);
const removed = pruneDeadIdentities(dir);
check("prune removes dead pid only", removed === 1);
check("prune keeps live pid", readIdentities(dir).some((i) => i.name === "live"));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
