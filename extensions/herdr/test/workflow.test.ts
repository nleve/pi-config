/**
 * Workflow aggregation + panel metadata arg tests. Run: bun test/workflow.test.ts
 */
import type { AgentIdentity } from "../registry.ts";
import {
	aggregateWorkflows,
	panelMetadataArgs,
	StageNotifier,
	workspaceMetadataArgs,
	type WorkflowLiveAgent,
} from "../workflow.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
	console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
	if (!cond) failures++;
}

function ident(over: Partial<AgentIdentity>): AgentIdentity {
	return { pane_id: "w3:pA", name: "amber-otter", pid: 1, started_at: 1, updated_at: 1, ...over };
}
function live(over: Partial<WorkflowLiveAgent>): WorkflowLiveAgent {
	return { pane_id: "w3:pA", name: "amber-otter", agent_status: "idle", ...over };
}

// --- aggregation -----------------------------------------------------------

const identities = [
	ident({ pane_id: "w1D:p1", name: "wf-dig-1", group: "wf", stage: "dig" }),
	ident({ pane_id: "w1D:p2", name: "wf-dig-2", group: "wf", stage: "dig" }),
	ident({ pane_id: "w1D:p3", name: "wf-judge-1", group: "wf", stage: "judge" }),
	ident({ pane_id: "w2:p1", name: "loose", group: undefined }),
	ident({ pane_id: "w9:p9", name: "other-x", group: "other", stage: "main" }),
];
const liveRows = [
	live({ pane_id: "w1D:p1", name: "wf-dig-1", agent_status: "idle" }),
	live({ pane_id: "w1D:p2", name: "wf-dig-2", agent_status: "working" }),
	live({ pane_id: "w1D:p3", name: "wf-judge-1", agent_status: "idle", workspace_id: "w1D" }),
];
const workspaces = [{ workspace_id: "w1D", label: "wf" }];

const all = aggregateWorkflows(liveRows, identities, { workspaces });
check("one group per label", all.length === 2, JSON.stringify(all.map((g) => g.group)));
const wf = all.find((g) => g.group === "wf")!;
check("group resolves workspace", wf.workspace_id === "w1D");
check("stages in first-seen order", wf.stages.map((s) => s.stage).join(",") === "dig,judge");
check("group counts", wf.counts.total === 3 && wf.counts.working === 1 && wf.counts.idle === 2);
check("group status working", wf.status === "working");
const dig = wf.stages.find((s) => s.stage === "dig")!;
check("dig counts", dig.counts.total === 2 && dig.counts.working === 1 && dig.counts.idle === 1);
check("dig status working", dig.status === "working");
check("workers sorted by name", dig.workers.map((w) => w.name).join(",") === "wf-dig-1,wf-dig-2");

check("ungrouped excluded", all.every((g) => g.group !== "loose"));

const filtered = aggregateWorkflows(liveRows, identities, { group: "wf", workspaces });
check("group filter", filtered.length === 1 && filtered[0]!.group === "wf");

const onlySpawned = aggregateWorkflows(liveRows, identities, {
	workspaces,
	keepGroup: (g) => g === "other",
});
check("keepGroup filter", onlySpawned.length === 1 && onlySpawned[0]!.group === "other");

// dormant: registry entry with no live row -> dormant, and stage becomes done
const dormant = aggregateWorkflows(
	[live({ pane_id: "w1D:p3", agent_status: "idle", workspace_id: "w1D" })],
	identities,
	{ group: "wf", workspaces },
)[0]!;
check("dormant counted", dormant.counts.dormant === 2);
check("partly dormant still not done (one live idle)", dormant.status === "done");
const blocky = aggregateWorkflows(
	[live({ pane_id: "w1D:p2", agent_status: "blocked" })],
	identities,
	{ group: "wf", workspaces },
)[0]!;
check("blocked beats done", blocky.status === "blocked" && blocky.counts.blocked === 1);

check("empty identities -> no groups", aggregateWorkflows([], [], {}).length === 0);

// --- metadata argv ---------------------------------------------------------

const p = panelMetadataArgs("w1D:p1", "wf-dig-1", { group: "wf", stage: "dig", project: "proj" });
check("panel positional + source", p[0] === "pane" && p[1] === "report-metadata" && p[2] === "w1D:p1");
check("panel has source + agent guard", p.includes("--source") && p.includes("--agent") && p.includes("pi"));
check("panel title is group/stage", p[p.indexOf("--title") + 1] === "wf/dig");
check("panel display-agent", p[p.indexOf("--display-agent") + 1] === "wf-dig-1");
check("panel tokens", p.includes("group=wf") && p.includes("stage=dig") && p.includes("project=proj"));
check("panel ttl", p[p.indexOf("--ttl-ms") + 1] === "86400000");
const pu = panelMetadataArgs("w9:p1", "loose", { project: "proj" });
check("ungrouped title falls back to project", pu[pu.indexOf("--title") + 1] === "proj");

const w = workspaceMetadataArgs("w1D", { group: "wf", stages: ["dig", "judge"] });
check("workspace positional", w[0] === "workspace" && w[1] === "report-metadata" && w[2] === "w1D");
check("workspace tokens", w.includes("group=wf") && w.includes("stages=dig,judge"));
check("workspace ttl", w[w.indexOf("--ttl-ms") + 1] === "86400000");

// --- stage-completion dedup ------------------------------------------------

const sn = new StageNotifier();
check("notifier fires on first settle", sn.shouldNotify("wf/dig", 2, true) === true);
check("notifier dedups identical settle", sn.shouldNotify("wf/dig", 2, true) === false);
check("notifier resets while running", sn.shouldNotify("wf/dig", 2, false) === false);
check("notifier re-fires after reset", sn.shouldNotify("wf/dig", 2, true) === true);
check("notifier re-fires when stage grows", sn.shouldNotify("wf/dig", 3, true) === true);
check("notifier never fires for empty stage", sn.shouldNotify("wf/none", 0, true) === false);

console.log(failures ? `${failures} FAILED` : "ALL PASS");
if (failures) process.exit(1);
