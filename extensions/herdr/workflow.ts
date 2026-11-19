/**
 * Workflow aggregation + display-only panel metadata builders.
 *
 * The orchestrator stamps `group`/`stage` onto each worker's registry identity
 * (`registry.ts: setIdentityGrouping`). This module folds the live `agent list`
 * rows and the durable identities into a per-group / per-stage progress view
 * (`workflow` action), and builds the `pane`/`workspace report-metadata` argv
 * that labels a worker (and its shared workspace) in the human's herdr panel.
 *
 * No I/O here: `index.ts` supplies the rows. That keeps the folding and the
 * argv shapes unit-testable without a pi runtime.
 */

import type { AgentIdentity } from "./registry.ts";

/** `--source` for everything this extension writes; we own its clearing/TTL. */
export const PANEL_SOURCE = "pi-herdr-ext";
const DEFAULT_TTL_MS = 86_400_000;

/** A row from `agent list`, joined with registry identity by `withIdentities`. */
export interface WorkflowLiveAgent {
	pane_id?: string;
	name?: string;
	agent_status?: string;
	model?: string;
	session_path?: string;
	workspace_id?: string;
	tab_id?: string;
	[k: string]: unknown;
}

export interface WorkflowWorkspace {
	workspace_id?: string;
	label?: string;
}

export type StageStatus = "working" | "blocked" | "done" | "unknown";

export interface WorkflowCounts {
	total: number;
	idle: number;
	working: number;
	blocked: number;
	dormant: number;
	/** Live rows whose status we cannot classify as settled (`idle`/`done`). */
	unknown: number;
}

export interface WorkflowWorker {
	name: string;
	pane_id: string;
	status: string;
	model?: string;
	session_path?: string;
	live: boolean;
}

export interface WorkflowStage {
	stage: string;
	status: StageStatus;
	counts: WorkflowCounts;
	workers: WorkflowWorker[];
}

export interface WorkflowGroup {
	group: string;
	workspace_id?: string;
	status: StageStatus;
	counts: WorkflowCounts;
	stages: WorkflowStage[];
}

function emptyCounts(): WorkflowCounts {
	return { total: 0, idle: 0, working: 0, blocked: 0, dormant: 0, unknown: 0 };
}

function addStatus(counts: WorkflowCounts, status: string): void {
	counts.total++;
	if (status === "working") counts.working++;
	else if (status === "blocked") counts.blocked++;
	else if (status === "dormant") counts.dormant++;
	else if (status === "idle" || status === "done") counts.idle++; // settled, ready for input
	else counts.unknown++; // `unknown` or an unrecognized status: not settled
}

/** A stage is done once every member is idle or dormant (no work remains). */
function statusOf(counts: WorkflowCounts): StageStatus {
	if (counts.working > 0) return "working";
	if (counts.blocked > 0) return "blocked";
	// An unclassifiable member means we cannot know the stage settled; never "done".
	if (counts.unknown > 0) return "working";
	if (counts.total > 0 && counts.idle + counts.dormant === counts.total) return "done";
	return "unknown";
}

function mergeCounts(into: WorkflowCounts, from: WorkflowCounts): void {
	into.total += from.total;
	into.idle += from.idle;
	into.working += from.working;
	into.blocked += from.blocked;
	into.dormant += from.dormant;
	into.unknown += from.unknown;
}

export interface AggregateOptions {
	/** Return only this group. */
	group?: string;
	/** Workspace rows, so a group can report the workspace it lives in. */
	workspaces?: readonly WorkflowWorkspace[];
	/** Extra group filter (e.g. "this session spawned at least one member"). */
	keepGroup?: (group: string) => boolean;
}

/**
 * Fold live agent rows + durable identities into a workflow progress view.
 * Membership comes from the identities (only the orchestrator writes
 * `group`/`stage`); `agent_status` comes from the live row, or `dormant` when
 * the worker's pid is gone.
 */
export function aggregateWorkflows(
	live: readonly WorkflowLiveAgent[],
	identities: readonly AgentIdentity[],
	opts: AggregateOptions = {},
): WorkflowGroup[] {
	const liveByPane = new Map<string, WorkflowLiveAgent>();
	for (const a of live) if (typeof a.pane_id === "string") liveByPane.set(a.pane_id, a);

	const groups = new Map<string, Map<string, WorkflowWorker[]>>();
	for (const id of identities) {
		const group = id.group;
		if (!group) continue;
		if (opts.group && group !== opts.group) continue;
		if (opts.keepGroup && !opts.keepGroup(group)) continue;
		const stage = id.stage || "main";
		const l = liveByPane.get(id.pane_id);
		const worker: WorkflowWorker = {
			name: (typeof l?.name === "string" && l.name) || id.name,
			pane_id: id.pane_id,
			status: (typeof l?.agent_status === "string" && l.agent_status) || "dormant",
			model: (typeof l?.model === "string" && l.model) || id.model,
			session_path: (typeof l?.session_path === "string" && l.session_path) || id.session_path,
			live: !!l,
		};
		let stages = groups.get(group);
		if (!stages) groups.set(group, (stages = new Map()));
		const arr = stages.get(stage);
		if (arr) arr.push(worker);
		else stages.set(stage, [worker]);
	}

	const out: WorkflowGroup[] = [];
	for (const [group, stages] of groups) {
		const groupCounts = emptyCounts();
		const stageOut: WorkflowStage[] = [];
		for (const [stage, workers] of stages) {
			workers.sort((a, b) => a.name.localeCompare(b.name));
			const counts = emptyCounts();
			for (const w of workers) addStatus(counts, w.status);
			mergeCounts(groupCounts, counts);
			stageOut.push({ stage, status: statusOf(counts), counts, workers });
		}
		const workspaceId = opts.workspaces?.find((w) => w.label === group)?.workspace_id;
		out.push({
			group,
			workspace_id: workspaceId,
			status: statusOf(groupCounts),
			counts: groupCounts,
			stages: stageOut,
		});
	}
	out.sort((a, b) => a.group.localeCompare(b.group));
	return out;
}

/**
 * Dedup guard for stage-completion notices. A stage notifies once when it
 * settles, and again only if it *grows* and settles a second time. Keyed by
 * member count; observing a still-running member resets the stage so a later
 * settle re-notifies.
 */
export class StageNotifier {
	private seen = new Map<string, number>();

	/** True exactly when this observation warrants firing a completion notice. */
	shouldNotify(key: string, memberCount: number, settled: boolean): boolean {
		if (memberCount === 0 || !settled) {
			this.seen.delete(key);
			return false;
		}
		if (this.seen.get(key) === memberCount) return false;
		this.seen.set(key, memberCount);
		return true;
	}
}

export interface PanelMetaOptions {
	group?: string;
	stage?: string;
	project?: string;
	task?: string;
	title?: string;
	parent?: string;
	source?: string;
	ttlMs?: number;
}

/**
 * `pane report-metadata` argv that labels a worker. A grouped worker shows
 * `<group>/<stage>` as its title so the human can read the workflow at a glance;
 * an ungrouped one keeps the project/name title.
 */
export function panelMetadataArgs(paneId: string, name: string, opts: PanelMetaOptions = {}): string[] {
	const title = opts.title ?? opts.task ?? (opts.group ? `${opts.group}${opts.stage ? `/${opts.stage}` : ""}` : opts.project || name);
	const args = [
		"pane",
		"report-metadata",
		paneId,
		"--source",
		opts.source ?? PANEL_SOURCE,
		"--agent",
		"pi",
		"--title",
		title,
		"--display-agent",
		name,
	];
	if (opts.project !== undefined) args.push("--token", `project=${opts.project}`);
	if (opts.task || opts.title) args.push("--token", `task=${opts.task ?? opts.title}`);
	if (opts.title) args.push("--token", `session_title=${opts.title}`);
	else args.push("--clear-token", "session_title");
	if (!opts.task && !opts.title) args.push("--clear-token", "task");
	if (opts.parent) args.push("--token", `parent=${opts.parent}`);
	if (opts.group) args.push("--token", `group=${opts.group}`);
	if (opts.stage) args.push("--token", `stage=${opts.stage}`);
	args.push("--ttl-ms", String(opts.ttlMs ?? DEFAULT_TTL_MS));
	return args;
}

/** `workspace report-metadata` argv that labels a workflow's shared workspace. */
export function workspaceMetadataArgs(
	workspaceId: string,
	opts: { group: string; stages?: readonly string[]; source?: string; ttlMs?: number },
): string[] {
	const args = [
		"workspace",
		"report-metadata",
		workspaceId,
		"--source",
		opts.source ?? PANEL_SOURCE,
		"--token",
		`group=${opts.group}`,
	];
	if (opts.stages?.length) args.push("--token", `stages=${opts.stages.join(",")}`);
	args.push("--ttl-ms", String(opts.ttlMs ?? DEFAULT_TTL_MS));
	return args;
}
