/**
 * herdr tool — typed wrappers over the herdr CLI (L1 of docs/GOAL.md).
 *
 * One model-facing tool with an `action` enum keeps the surface small while
 * covering the operations orchestration needs: roster, agent control, pane
 * control, workspaces, worktrees, notify, and a raw escape hatch.
 *
 * See ./GOAL.md for architecture and phasing.
 */

import { Type, type Static } from "typebox";
import type {
	AutocompleteProviderFactory,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	callHerdr,
	herdrAvailable,
	herdrUnavailableReason,
	renderHerdrResult,
} from "./client.ts";
import { sessionPathOf, readSessionResult } from "./session.ts";
import { getAgent, waitForTurnSettled } from "./socket.ts";
import { formatIrcForModel, IrcNode, registerIrcTool, type IrcAgent, type IrcEnvelope, type IrcTarget } from "./irc.ts";
import {
	DelegateRegistry,
	DELEGATE_ENTRY_TYPE,
	findInstanceRefs,
	replaceMention,
	type DelegateEntryLike,
	type ModelLike,
} from "./delegates.ts";
import { generateName, stageName } from "./names.ts";
import {
	aggregateWorkflows,
	panelMetadataArgs,
	StageNotifier,
	workspaceMetadataArgs,
	type WorkflowLiveAgent,
} from "./workflow.ts";
import {
	findIdentity,
	isAlive,
	pruneDeadIdentities,
	readIdentities,
	resolvePaneRef,
	setIdentityGrouping,
	withIdentities,
	writeIdentity,
	type AgentIdentity,
} from "./registry.ts";

export const HERDR_ACTIONS = [
	// roster
	"agents",
	"panes",
	"workflow",
	// agent control
	"agent_get",
	"agent_start",
	"spawn",
	"agent_prompt",
	"agent_read",
	"agent_wait",
	"agent_result",
	"agent_send_keys",
	"agent_rename",
	"agent_focus",
	// pane control
	"pane_get",
	"pane_read",
	"pane_split",
	"pane_run",
	"pane_send_text",
	"pane_wait_output",
	"pane_close",
	"pane_focus",
	// workspaces
	"workspace_list",
	"workspace_create",
	"workspace_close",
	// worktrees
	"worktree_list",
	"worktree_create",
	"worktree_open",
	"worktree_remove",
	// misc
	"notify",
	"snapshot",
	"raw",
] as const;

const herdrSchema = Type.Object({
	action: Type.Union(
		HERDR_ACTIONS.map((a) => Type.Literal(a)),
		{ description: "Which herdr operation to run" },
	),
	// targets / identity
	target: Type.Optional(Type.String({ description: "Agent target: live agent name or hosting pane id (e.g. w3:pJ)" })),
	name: Type.Optional(
		Type.String({
			description:
				"Agent name for agent_start/spawn (auto-generated memorable codename when omitted), or new name for agent_rename",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"agent_start/spawn: model for the pi worker — a `provider/id` selector, or a `^selector[:level]` delegate the user declared in a prompt. Omit to inherit the default model.",
		}),
	),
	thinking: Type.Optional(
		Type.String({
			description:
				"agent_start/spawn: thinking level (off, minimal, low, medium, high, xhigh, max). Overrides a delegate's declared level; omit for the worker's default.",
		}),
	),
	group: Type.Optional(
		Type.String({
			description:
				"agent_start/spawn: workflow group. With a group, workers share one herdr workspace (label=group) and one tab per stage; the name defaults to `<group>-<stage>-<n>`. Without it, spawn keeps its isolated workspace/worktree behaviour. `agents`/`workflow`: filter to this group.",
		}),
	),
	notify: Type.Optional(
		Type.Boolean({
			description:
				"spawn/agent_prompt/agent_result: when a grouped worker settles and every worker in its stage is now idle/dormant, show one herdr notification for the stage (deduped, re-fires if the stage grows). Defaults on when `group` is set; pass false to silence.",
		}),
	),
	stage: Type.Optional(
		Type.String({
			description: "agent_start/spawn: stage within the group (tab label). Defaults to `main` when `group` is set.",
		}),
	),
	mode: Type.Optional(
		Type.Union([Type.Literal("workspace"), Type.Literal("worktree")], {
			description: "spawn: create an isolated workspace (default) or a git worktree workspace",
		}),
	),
	prompt: Type.Optional(Type.String({ description: "spawn: optional initial prompt to send after the agent is ready" })),
	pane: Type.Optional(Type.String({ description: "Pane id for pane_* and agent_start" })),
	workspace: Type.Optional(Type.String({ description: "Workspace id for pane/workspace/worktree operations" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for create/split/open operations" })),
	label: Type.Optional(Type.String({ description: "Label for workspace/worktree creation" })),
	// worktree
	branch: Type.Optional(Type.String({ description: "Git branch for worktree create/open" })),
	base: Type.Optional(Type.String({ description: "Base ref for worktree create" })),
	path: Type.Optional(Type.String({ description: "Filesystem path for worktree create/open" })),
	// pane control
	direction: Type.Optional(
		Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("up"), Type.Literal("down")], {
			description: "Split/focus direction",
		}),
	),
	ratio: Type.Optional(Type.Number({ description: "Split ratio for pane_split" })),
	command: Type.Optional(Type.String({ description: "Command text for pane_run (sent with Enter)" })),
	text: Type.Optional(Type.String({ description: "Prompt text for agent_prompt, or literal text for pane_send_text" })),
	keys: Type.Optional(Type.Array(Type.String(), { description: "Key presses for agent_send_keys, e.g. [\"Enter\"]" })),
	// read / wait
	source: Type.Optional(
		Type.Union(
			[
				Type.Literal("visible"),
				Type.Literal("recent"),
				Type.Literal("recent-unwrapped"),
				Type.Literal("detection"),
			],
			{ description: "Terminal snapshot source" },
		),
	),
	lines: Type.Optional(Type.Number({ description: "Limit output to N lines" })),
	ansi: Type.Optional(Type.Boolean({ description: "Include ANSI formatting in pane/agent reads" })),
	match: Type.Optional(Type.String({ description: "Literal substring to match for pane_wait_output" })),
	regex: Type.Optional(Type.String({ description: "Rust regex to match for pane_wait_output" })),
	until: Type.Optional(
		Type.Array(
			Type.Union([
				Type.Literal("idle"),
				Type.Literal("working"),
				Type.Literal("blocked"),
				Type.Literal("done"),
				Type.Literal("unknown"),
			]),
			{ description: "Agent states to wait for" },
		),
	),
	wait: Type.Optional(Type.Boolean({ description: "For agent_prompt: wait for the submitted turn to settle" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds for wait/prompt/start operations" })),
	since: Type.Optional(
		Type.Number({
			description:
				"agent_result: require the agent's state_change_seq to advance past this value before treating the turn as settled (use the `baseline_seq` returned by spawn/prompt)",
		}),
	),
	agentArgs: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'agent_start/spawn: extra pi CLI flags passed after `--` (e.g. ["-xt","herdr"] to deny the herdr tool, ["--no-context-files"]). Prefer `model`/`thinking` for model selection.',
		}),
	),
	nested: Type.Optional(
		Type.Boolean({
			description:
				"spawn: allow the spawned agent to spawn its own subagents (default false; workers get the herdr tool denied)",
		}),
	),
	// notify
	title: Type.Optional(Type.String({ description: "Notification title" })),
	body: Type.Optional(Type.String({ description: "Notification body" })),
	sound: Type.Optional(
		Type.Union([Type.Literal("none"), Type.Literal("done"), Type.Literal("request")], {
			description: "Notification sound",
		}),
	),
	position: Type.Optional(
		Type.Union(
			[
				Type.Literal("top-left"),
				Type.Literal("top-right"),
				Type.Literal("bottom-left"),
				Type.Literal("bottom-right"),
			],
			{ description: "Notification position" },
		),
	),
	// flags
	focus: Type.Optional(Type.Boolean({ description: "workspace_create: focus the new workspace" })),
	force: Type.Optional(Type.Boolean({ description: "worktree_remove: force removal" })),
	trust: Type.Optional(Type.Boolean({ description: "worktree_*: trust the repository" })),
	clear: Type.Optional(Type.Boolean({ description: "agent_rename: clear the name instead of setting it" })),
	current: Type.Optional(Type.Boolean({ description: "pane_split/pane_focus: target the calling pane" })),
	scope: Type.Optional(
		Type.Union(
			[
				Type.Literal("self"),
				Type.Literal("tab"),
				Type.Literal("workspace"),
				Type.Literal("all"),
			],
			{
				description:
					"agents/panes: which agents to include. `self` = only this pane, `tab` = this tab, `workspace` (default) = this workspace plus agents spawned this session, `all` = every agent in the session.",
			},
		),
	),
	// escape hatch
	args: Type.Optional(Type.Array(Type.String(), { description: "Raw herdr arguments for action=raw" })),
});

type HerdrParams = Static<typeof herdrSchema>;

function req<T>(value: T | undefined, name: string): T {
	if (value === undefined || value === null || value === "") {
		throw new Error(`herdr: \`${name}\` is required for this action`);
	}
	return value;
}

function pushFlag(args: string[], flag: string, value: string | number | undefined): void {
	if (value !== undefined) args.push(flag, String(value));
}

/** Build the herdr argv for a params object. Pure and testable. */
export function buildHerdrArgs(p: HerdrParams): string[] {
	const a: string[] = [];
	const repeat = (flag: string, values?: readonly string[]) => {
		if (values) for (const v of values) a.push(flag, v);
	};

	switch (p.action) {
		// ---- roster ----
		case "agents":
			a.push("agent", "list");
			break;
		case "panes":
			a.push("pane", "list");
			pushFlag(a, "--workspace", p.workspace);
			break;
		case "workflow":
			throw new Error("herdr: `workflow` is a multi-step action handled by execute()");

		// ---- agent ----
		case "agent_get":
			a.push("agent", "get", req(p.target, "target"));
			break;
		case "agent_start":
			// Every worker is a pi agent; cross-harness is a non-goal.
			a.push("agent", "start", req(p.name, "name"), "--kind", "pi", "--pane", req(p.pane, "pane"));
			pushFlag(a, "--timeout", p.timeout);
			if (p.agentArgs?.length) a.push("--", ...p.agentArgs);
			break;
		case "spawn":
			throw new Error("herdr: `spawn` is a multi-step action handled by execute()");
		case "agent_prompt":
			a.push("agent", "prompt", req(p.target, "target"), req(p.text, "text"));
			if (p.wait) a.push("--wait");
			repeat("--until", p.until);
			// herdr rejects --timeout unless --wait is present.
			pushFlag(a, "--timeout", p.wait ? (p.timeout ?? 110000) : undefined);
			break;
		case "agent_read":
			a.push("agent", "read", req(p.target, "target"));
			pushFlag(a, "--source", p.source);
			pushFlag(a, "--lines", p.lines);
			if (p.ansi) a.push("--ansi");
			break;
		case "agent_wait":
			a.push("agent", "wait", req(p.target, "target"));
			repeat("--until", p.until);
			pushFlag(a, "--timeout", p.timeout ?? 110000);
			break;
		case "agent_send_keys":
			a.push("agent", "send-keys", req(p.target, "target"), ...req(p.keys, "keys"));
			break;
		case "agent_rename":
			a.push("agent", "rename", req(p.target, "target"));
			if (p.clear) a.push("--clear");
			else a.push(req(p.name, "name"));
			break;
		case "agent_focus":
			a.push("agent", "focus", req(p.target, "target"));
			break;

		// ---- pane ----
		case "pane_get":
			a.push("pane", "get", req(p.pane, "pane"));
			break;
		case "pane_read":
			a.push("pane", "read", req(p.pane, "pane"));
			pushFlag(a, "--source", p.source);
			pushFlag(a, "--lines", p.lines);
			if (p.ansi) a.push("--ansi");
			break;
		case "pane_split":
			a.push("pane", "split");
			if (p.current) a.push("--current");
			else pushFlag(a, "--pane", p.pane);
			pushFlag(a, "--direction", p.direction);
			pushFlag(a, "--ratio", p.ratio);
			pushFlag(a, "--cwd", p.cwd);
			break;
		case "pane_run":
			a.push("pane", "run", req(p.pane, "pane"), req(p.command, "command"));
			break;
		case "pane_send_text":
			a.push("pane", "send-text", req(p.pane, "pane"), req(p.text, "text"));
			break;
		case "pane_wait_output":
			a.push("pane", "wait-output", req(p.pane, "pane"));
			if (!p.match && !p.regex) throw new Error("herdr: pane_wait_output requires `match` or `regex`");
			pushFlag(a, "--match", p.match);
			pushFlag(a, "--regex", p.regex);
			pushFlag(a, "--source", p.source);
			pushFlag(a, "--lines", p.lines);
			pushFlag(a, "--timeout", p.timeout ?? 110000);
			break;
		case "pane_close":
			a.push("pane", "close", req(p.pane, "pane"));
			break;
		case "pane_focus":
			a.push("pane", "focus", "--direction", req(p.direction, "direction"));
			if (p.current) a.push("--current");
			else pushFlag(a, "--pane", p.pane);
			break;

		// ---- workspace ----
		case "workspace_list":
			a.push("workspace", "list");
			break;
		case "workspace_create":
			a.push("workspace", "create");
			pushFlag(a, "--cwd", p.cwd);
			pushFlag(a, "--label", p.label);
			if (p.focus === true) a.push("--focus");
			if (p.focus === false) a.push("--no-focus");
			break;
		case "workspace_close":
			a.push("workspace", "close", req(p.workspace, "workspace"));
			break;

		// ---- worktree ----
		case "worktree_list":
			a.push("worktree", "list");
			pushFlag(a, "--workspace", p.workspace);
			pushFlag(a, "--cwd", p.cwd);
			if (p.trust) a.push("--trust-repository");
			break;
		case "worktree_create":
			a.push("worktree", "create");
			pushFlag(a, "--workspace", p.workspace);
			pushFlag(a, "--cwd", p.cwd);
			pushFlag(a, "--branch", p.branch);
			pushFlag(a, "--base", p.base);
			pushFlag(a, "--path", p.path);
			pushFlag(a, "--label", p.label);
			break;
		case "worktree_open":
			a.push("worktree", "open");
			pushFlag(a, "--workspace", p.workspace);
			pushFlag(a, "--cwd", p.cwd);
			pushFlag(a, "--path", p.path);
			pushFlag(a, "--branch", p.branch);
			pushFlag(a, "--label", p.label);
			break;
		case "worktree_remove":
			a.push("worktree", "remove");
			pushFlag(a, "--workspace", p.workspace);
			pushFlag(a, "--cwd", p.cwd);
			if (p.force) a.push("--force");
			if (p.trust) a.push("--trust-repository");
			break;

		// ---- misc ----
		case "notify":
			a.push("notification", "show", req(p.title, "title"));
			pushFlag(a, "--body", p.body);
			pushFlag(a, "--sound", p.sound);
			pushFlag(a, "--position", p.position);
			break;
		case "snapshot":
			a.push("api", "snapshot");
			break;
		case "raw":
			a.push(...req(p.args, "args"));
			break;
		default: {
			const never: never = p.action;
			throw new Error(`herdr: unknown action ${String(never)}`);
		}
	}
	return a;
}

// ---------------------------------------------------------------------------
// spawn: multi-step convenience (create isolated workspace/worktree → start
// agent → optionally prompt). Response shapes verified against herdr's API
// schema: workspace_created / worktree_created both return `root_pane.pane_id`,
// agent_start returns `agent`.
// ---------------------------------------------------------------------------

export interface SpawnOutcome {
	mode: "workspace" | "worktree";
	workspace_id?: string;
	pane_id: string;
	name: string;
	group?: string;
	stage?: string;
	kind: string;
	agent?: unknown;
	prompted: boolean;
	/** state_change_seq captured before the prompt; pass as `since` to agent_result. */
	baseline_seq?: number;
	/** pi session transcript path, when the agent exposes one. */
	session_path?: string;
	/** Present when `wait` was set: settled agent status. */
	status?: string;
	/** Present when `wait` was set: structured result from the session transcript. */
	result?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

interface StagePlacement {
	workspace_id: string;
	tab_id: string;
	pane_id: string;
	created_workspace: boolean;
	created_tab: boolean;
}

/**
 * Place a worker in a shared workflow workspace (`group` label) and stage tab
 * (`stage` label), creating either when missing. The first worker in a fresh
 * workspace reuses its initial tab (renamed to the stage) instead of orphaning
 * a stray pane; later workers split a pane in the stage tab.
 */
async function ensureStagePane(
	group: string,
	stage: string,
	opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<StagePlacement> {
	const list = await callHerdr({ args: ["workspace", "list"], timeoutMs: 30000 }, opts.signal);
	const wsRec = asRecord(list.result);
	const workspaces = Array.isArray(wsRec?.workspaces)
		? (wsRec.workspaces as Record<string, unknown>[])
		: [];
	let workspaceId = workspaces.find((w) => w.label === group)?.workspace_id as string | undefined;
	let createdWorkspace = false;
	let tabId: string | undefined;
	let paneId: string | undefined;
	let createdTab = false;

	if (!workspaceId) {
		const args = ["workspace", "create", "--label", group, "--no-focus"];
		if (opts.cwd) args.push("--cwd", opts.cwd);
		const created = await callHerdr({ args, timeoutMs: 120000 }, opts.signal);
		const rec = asRecord(created.result);
		workspaceId = asRecord(rec?.workspace)?.workspace_id as string | undefined;
		tabId = asRecord(rec?.tab)?.tab_id as string | undefined;
		paneId = asRecord(rec?.root_pane)?.pane_id as string | undefined;
		createdWorkspace = true;
		if (tabId) {
			await callHerdr({ args: ["tab", "rename", tabId, stage], timeoutMs: 10000 }, opts.signal).catch(
				() => {},
			);
		}
	} else {
		const tabs = await callHerdr(
			{ args: ["tab", "list", "--workspace", workspaceId], timeoutMs: 30000 },
			opts.signal,
		);
		const tabsRec = asRecord(tabs.result);
		const rows = Array.isArray(tabsRec?.tabs) ? (tabsRec.tabs as Record<string, unknown>[]) : [];
		tabId = rows.find((t) => t.label === stage)?.tab_id as string | undefined;
		if (!tabId) {
			const args = ["tab", "create", "--workspace", workspaceId, "--label", stage, "--no-focus"];
			if (opts.cwd) args.push("--cwd", opts.cwd);
			const created = await callHerdr({ args, timeoutMs: 60000 }, opts.signal);
			const rec = asRecord(created.result);
			tabId = asRecord(rec?.tab)?.tab_id as string | undefined;
			paneId = asRecord(rec?.root_pane)?.pane_id as string | undefined;
			createdTab = true;
		}
	}

	if (!workspaceId || !tabId) {
		throw new Error(`herdr spawn: could not resolve stage '${group}/${stage}' workspace/tab`);
	}
	if (!paneId) {
		const panes = await callHerdr(
			{ args: ["pane", "list", "--workspace", workspaceId], timeoutMs: 30000 },
			opts.signal,
		);
		const panesRec = asRecord(panes.result);
		const rows = Array.isArray(panesRec?.panes) ? (panesRec.panes as Record<string, unknown>[]) : [];
		const base = rows.find((p) => p.tab_id === tabId)?.pane_id as string | undefined;
		if (!base) throw new Error(`herdr spawn: stage tab ${tabId} has no pane to split`);
		const args = ["pane", "split", "--pane", base, "--direction", "down"];
		if (opts.cwd) args.push("--cwd", opts.cwd);
		const split = await callHerdr({ args, timeoutMs: 30000 }, opts.signal);
		paneId = asRecord(asRecord(split.result)?.pane)?.pane_id as string | undefined;
	}
	if (!paneId) throw new Error(`herdr spawn: could not obtain a pane for '${group}/${stage}'`);
	return {
		workspace_id: workspaceId,
		tab_id: tabId,
		pane_id: paneId,
		created_workspace: createdWorkspace,
		created_tab: createdTab,
	};
}

/** How many workers are already registered for a group/stage (for the `-n` suffix). */
function countStage(group: string, stage: string): number {
	return readIdentities().filter((i) => i.group === group && i.stage === stage).length;
}

/** Stamp group/stage onto a freshly-started worker's identity (it registers itself first). */
async function recordGrouping(paneId: string, group: string, stage: string): Promise<void> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const found = readIdentities().find((i) => i.pane_id === paneId);
		if (found) {
			setIdentityGrouping(found, group, stage);
			return;
		}
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** The workspace the human currently has focused, if any (best-effort). */
async function focusedWorkspaceId(signal?: AbortSignal): Promise<string | undefined> {
	try {
		const { result } = await callHerdr({ args: ["workspace", "list"], timeoutMs: 10000 }, signal);
		const rec = asRecord(result);
		const rows = Array.isArray(rec?.workspaces) ? (rec.workspaces as Record<string, unknown>[]) : [];
		return rows.find((w) => w.focused === true)?.workspace_id as string | undefined;
	} catch {
		return undefined;
	}
}

/**
 * `agent start` focuses the new pane (herdr has no `--no-focus` for it), which
 * would yank the human's view on every grouped spawn. Restore the previously
 * focused workspace, but only if our command actually moved it.
 */
async function restoreFocus(prior: string | undefined): Promise<void> {
	if (!prior) return;
	const now = await focusedWorkspaceId();
	if (now && now !== prior) {
		try {
			await callHerdr({ args: ["workspace", "focus", prior], timeoutMs: 10000 });
		} catch {
			/* best-effort */
		}
	}
}

export async function spawnAgent(
	params: HerdrParams,
	signal?: AbortSignal,
	modelArgs: readonly string[] = [],
): Promise<SpawnOutcome> {
	const kind = "pi";
	const mode = params.mode ?? "workspace";
	const group = params.group?.trim() || undefined;
	const stage = params.stage?.trim() || (group ? "main" : undefined);
	const taken = new Set(readIdentities().map((i) => i.name));
	const name =
		params.name?.trim() ||
		(group
			? stageName(group, stage ?? "main", countStage(group, stage ?? "main") + 1, taken)
			: generateName(taken));

	// Placement: with `group`, share one workspace per workflow (label=group) and
	// one tab per stage; without it, keep the original isolated workspace/worktree.
	let paneId: string | undefined;
	let workspaceId: string | undefined;
	if (group && mode === "workspace") {
		const placed = await ensureStagePane(group, stage ?? "main", { cwd: params.cwd, signal });
		paneId = placed.pane_id;
		workspaceId = placed.workspace_id;
	} else {
		const createAction = mode === "worktree" ? "worktree_create" : "workspace_create";
		const created = await callHerdr(
			{ args: buildHerdrArgs({ ...params, action: createAction }), timeoutMs: 120000 },
			signal,
		);
		const createdRec = asRecord(created.result);
		paneId = asRecord(createdRec?.root_pane)?.pane_id as string | undefined;
		workspaceId = asRecord(createdRec?.workspace)?.workspace_id as string | undefined;
		if (!paneId) {
			throw new Error(
				`herdr spawn: ${createAction} did not return a root pane id: ${renderHerdrResult(created.result)}`,
			);
		}
	}

	const nested = params.nested === true;
	const agentArgs = [
		...(nested ? [] : ["-xt", "herdr"]),
		"--name",
		name,
		...modelArgs,
		...(params.agentArgs ?? []),
	];
	const priorFocus = group ? await focusedWorkspaceId(signal) : undefined;
	const started = await callHerdr(
		{
			args: buildHerdrArgs({ ...params, action: "agent_start", name, pane: paneId, agentArgs }),
			timeoutMs: (params.timeout ?? 60000) + 15000,
		},
		signal,
	);
	const startedAgent = asRecord(asRecord(started.result)?.agent);
	const baselineSeq =
		typeof startedAgent?.state_change_seq === "number" ? startedAgent.state_change_seq : undefined;
	const sessionPath = startedAgent
		? sessionPathOf(startedAgent as { agent_session?: unknown })
		: undefined;

	if (group && paneId) {
		await recordGrouping(paneId, group, stage ?? "main");
		// Label the pane (and the shared workspace) in the human's panel. The
		// worker re-asserts its own label each turn, so this cannot drift.
		await callHerdr(
			{ args: panelMetadataArgs(paneId, name, { group, stage: stage ?? "main" }), timeoutMs: 10000 },
			signal,
		).catch(() => {});
		if (workspaceId) {
			const stages = [
				...new Set(readIdentities().filter((i) => i.group === group).map((i) => i.stage || "main")),
			];
			await callHerdr(
				{ args: workspaceMetadataArgs(workspaceId, { group, stages }), timeoutMs: 10000 },
				signal,
			).catch(() => {});
		}
	}
	await restoreFocus(priorFocus);

	let prompted = false;
	let status: string | undefined;
	let result: unknown;
	if (params.prompt) {
		await callHerdr(
			{
				args: buildHerdrArgs({
					...params,
					action: "agent_prompt",
					target: paneId,
					text: params.prompt,
					wait: false,
				}),
				timeoutMs: (params.timeout ?? 110000) + 15000,
			},
			signal,
		);
		prompted = true;
		if (params.wait) {
			const settled = await waitForTurnSettled(paneId, {
				sinceSeq: baselineSeq,
				timeoutMs: params.timeout ?? 120000,
				signal,
			});
			status = settled.agent_status;
			if (sessionPath) result = (await readSessionResult(sessionPath)) ?? undefined;
		}
	}

	return {
		mode,
		workspace_id: workspaceId,
		pane_id: paneId,
		name,
		group,
		stage,
		kind,
		agent: startedAgent,
		prompted,
		baseline_seq: baselineSeq,
		session_path: sessionPath,
		...(status ? { status } : {}),
		...(result ? { result } : {}),
	};
}

// ---------------------------------------------------------------------------
// Scope: keep unrelated agents out of the model's context.
//
// herdr's native boundaries are tab < workspace < session, and every agent/pane
// record carries tab_id/workspace_id/pane_id. `scope` filters the roster:
//   self      -> only the calling pane
//   tab       -> the calling tab
//   workspace -> the calling workspace, PLUS anything this session spawned
//   all       -> every agent in the herdr session
// `spawned` is passed in so workers placed in their own workspace stay visible.
// ---------------------------------------------------------------------------

export type HerdrScope = "self" | "tab" | "workspace" | "all";

interface ScopedRecord {
	pane_id?: unknown;
	tab_id?: unknown;
	workspace_id?: unknown;
	[k: string]: unknown;
}

export function scopeRecords<T extends ScopedRecord>(
	records: T[],
	scope: HerdrScope,
	spawned: ReadonlySet<string> = new Set(),
	env: NodeJS.ProcessEnv = process.env,
): { shown: T[]; total: number; hidden: number } {
	const self = env.HERDR_PANE_ID;
	const tab = env.HERDR_TAB_ID;
	const ws = env.HERDR_WORKSPACE_ID;
	const keep = (r: T): boolean => {
		const pane = typeof r.pane_id === "string" ? r.pane_id : undefined;
		if (pane && spawned.has(pane)) return true; // always show our own children
		switch (scope) {
			case "self":
				return pane === self;
			case "tab":
				return r.tab_id === tab;
			case "workspace":
				return r.workspace_id === ws;
			default:
				return true;
		}
	};
	const shown = records.filter(keep);
	return { shown, total: records.length, hidden: records.length - shown.length };
}

/** Apply `scope` to an agent_list / pane_list result, annotating counts. */
export function applyScope(
	params: HerdrParams,
	result: unknown,
	spawned: ReadonlySet<string>,
): unknown {
	if (params.action !== "agents" && params.action !== "panes") return result;
	const scope = (params.scope ?? "workspace") as HerdrScope;
	const rec = asRecord(result);
	if (!rec) return result;
	const key = params.action === "agents" ? "agents" : "panes";
	const arr = Array.isArray(rec[key]) ? (rec[key] as ScopedRecord[]) : undefined;
	if (!arr) return result;
	const { shown, total, hidden } = scopeRecords(arr, scope, spawned);
	return { ...rec, scope, total, shown: shown.length, hidden, [key]: shown };
}

export default function herdrExtension(pi: ExtensionAPI) {
	// Agents this session spawned, so they stay visible even when scope would
	// otherwise exclude them (e.g. a worker placed in its own workspace).
	const spawned = new Set<string>();

	// ---- Dynamic delegates (`^selector[:level]`) -----------------------------
	// The user tags models inline in a prompt; we resolve them against the
	// session catalogue, persist them branch-locally, and compile them to
	// `--model`/`--thinking` when a worker is spawned on that token.
	let sessionModels: readonly ModelLike[] = [];
	const delegates = new DelegateRegistry({
		availableModels: () => sessionModels,
		persist: (delegate) => pi.appendEntry(DELEGATE_ENTRY_TYPE, delegate),
	});

	function modelsFromCtx(ctx: ExtensionContext): readonly ModelLike[] {
		const scoped = ctx.scopedModels.map((s) => s.model);
		return scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
	}

	function modelArgsFor(params: HerdrParams): string[] {
		const { args, error } = delegates.resolveModelArgs(params.model, params.thinking);
		if (error) throw new Error(`herdr: ${error}`);
		return args;
	}

	/** Last path component: `/home/n/src/herdr` → `herdr`. */
	function projectName(cwd: string | undefined): string | undefined {
		if (!cwd) return undefined;
		const parts = cwd.split(/[\\/]/).filter(Boolean);
		return parts.length > 0 ? parts[parts.length - 1] : cwd;
	}

	/**
	 * `^^name` in a prompt → a legend resolving the reference to a live pane, so
	 * the model can address the worker via the herdr tool `target` or IRC.
	 * Unknown names are left literal.
	 */
	function expandInstances(text: string): { text: string; refs: { name: string; pane: string }[] } {
		const byName = new Map(readIdentities().map((i) => [i.name, i]));
		const names = findInstanceRefs(text, new Set(byName.keys()));
		if (names.length === 0) return { text, refs: [] };
		const refs = names.map((name) => ({ name, pane: byName.get(name)!.pane_id }));
		const legend = [
			"Worker references (already-running agents; address them with the herdr tool `target` or `irc send to:`):",
			...refs.map((r) => `  ^^${r.name} → ${r.pane}`),
		].join("\n");
		return { text: `${text}\n\n${legend}`, refs };
	}

	// ---- Composer autocomplete for `^model` / `^^worker` ---------------------
	type MentionProvider = Parameters<AutocompleteProviderFactory>[0];
	type MentionItem = Parameters<MentionProvider["applyCompletion"]>[3];

	function mentionAtCursor(
		line: string,
		col: number,
	): { double: boolean; prefix: string; query: string } | undefined {
		let start = col;
		while (start > 0 && !/\s/.test(line[start - 1]!)) start--;
		const token = line.slice(start, col);
		if (token.startsWith("^^")) return { double: true, prefix: token, query: token.slice(2) };
		if (token.startsWith("^")) return { double: false, prefix: token, query: token.slice(1) };
		return undefined;
	}

	function modelMentionItems(query: string): MentionItem[] {
		const counts = new Map<string, number>();
		for (const m of sessionModels) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
		const q = query.toLowerCase();
		return sessionModels
			.map((m) => {
				const selector = (counts.get(m.id) ?? 0) > 1 ? `${m.provider}/${m.id}` : m.id;
				return { value: `^${selector}`, label: selector, description: m.provider };
			})
			.filter((it) => it.label.toLowerCase().includes(q))
			.slice(0, 30);
	}

	function workerMentionItems(query: string): MentionItem[] {
		const q = query.toLowerCase();
		return readIdentities()
			.filter((i) => i.pane_id !== selfPane)
			.map((i) => ({
				value: `^^${i.name}`,
				label: i.name,
				description: [i.pane_id, i.cwd ? projectName(i.cwd) : undefined].filter(Boolean).join(" · "),
			}))
			.filter((it) => it.label.toLowerCase().includes(q))
			.slice(0, 30);
	}

	const makeMentionAutocomplete: AutocompleteProviderFactory = (current) => ({
		triggerCharacters: [...(current.triggerCharacters ?? []), "^"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const mention = mentionAtCursor(lines[cursorLine] ?? "", cursorCol);
			if (mention) {
				const query = mention.query.split(":")[0] ?? "";
				const items = mention.double ? workerMentionItems(query) : modelMentionItems(query);
				if (items.length > 0) return { items, prefix: mention.prefix };
			}
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!item.value.startsWith("^")) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const applied = replaceMention(lines[cursorLine] ?? "", cursorCol, prefix, item.value);
			const next = [...lines];
			next[cursorLine] = applied.line;
			return { lines: next, cursorLine, cursorCol: applied.cursorCol };
		},
		shouldTriggerFileCompletion: current.shouldTriggerFileCompletion
			? (lines, cursorLine, cursorCol) => current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol)
			: undefined,
	});

	// ---- Live identity registry ---------------------------------------------
	// Every pi writes its own identity file, so an agent the human started
	// directly is as addressable as one we spawned. herdr's CLI omits `name`.
	const selfPane = process.env.HERDR_PANE_ID;

	function ownName(): string {
		const sessionName = pi.getSessionName()?.trim();
		if (sessionName) return sessionName;
		const known = readIdentities();
		const prior = selfPane ? known.find((i) => i.pane_id === selfPane)?.name : undefined;
		if (prior) return prior;
		const fresh = generateName(new Set(known.map((i) => i.name)));
		try {
			pi.setSessionName(fresh); // surface the handle in the terminal title
		} catch {
			/* best-effort; the registry entry is what matters */
		}
		return fresh;
	}

	function herdrSafeName(raw: string | undefined): string | undefined {
		if (!raw) return undefined;
		const s = raw
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^[^a-z]+/, "")
			.replace(/-{2,}/g, "-")
			.replace(/[-_]+$/, "")
			.slice(0, 32);
		return /^[a-z][a-z0-9_-]{0,31}$/.test(s) ? s : undefined;
	}

	/**
	 * Ensure herdr itself shows a name for this pane. The agents panel renders
	 * `AgentInfo.name`, which only `agent start` / `agent rename` set. Adopt the
	 * name herdr already shows (the human may have chosen it); otherwise claim a
	 * unique one. Retries while the agent is still being detected. Returns the
	 * effective name, or undefined if we could never set one.
	 */
	async function assertHerdrName(handle: string): Promise<string | undefined> {
		if (!selfPane) return undefined;
		const base = herdrSafeName(handle) ?? herdrSafeName(generateName()) ?? "pi";
		let suffix = 0;
		for (let attempt = 0; attempt < 8; attempt++) {
			if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * Math.min(attempt, 4)));
			try {
				const { result } = await callHerdr({ args: ["agent", "get", selfPane], timeoutMs: 10000 });
				const rec = asRecord(result);
				const agent = asRecord(rec?.agent) ?? rec;
				const existing = typeof agent?.name === "string" && agent.name ? agent.name : undefined;
				if (existing) return existing;
				const candidate = suffix === 0 ? base : `${base.slice(0, 29)}-${suffix + 1}`;
				await callHerdr({
					args: buildHerdrArgs({ action: "agent_rename", target: selfPane, name: candidate }),
					timeoutMs: 10000,
				});
				return candidate;
			} catch (error) {
				// A name clash needs a fresh suffix; "not detected yet" just needs patience.
				const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
				if (/taken|in use|exists|unique|duplicate|conflict/.test(msg)) suffix++;
			}
		}
		return undefined;
	}

	let lastPanelMetaKey: string | undefined;

	/**
	 * Show the workflow position (or name + project) in the herdr sidebar via
	 * display-only pane metadata. A grouped worker shows `<group>/<stage>`; the
	 * orchestrator pushes the same labels right after spawn, and re-asserting it
	 * here keeps the label from being clobbered on the worker's next turn or a
	 * mid-run reload. `--agent pi` scopes it so it never decorates a non-pi pane;
	 * `--source` is ours so we own clearing/TTL. Best-effort: a failure must not
	 * affect pi.
	 */
	async function reportPanel(ctx: ExtensionContext, resolvedName?: string): Promise<void> {
		if (!selfPane) return;
		const name = resolvedName ?? ownName();
		const dir = projectName(ctx.cwd);
		const self = identities().find((i) => i.pane_id === selfPane);
		const args = panelMetadataArgs(selfPane, name, {
			group: self?.group,
			stage: self?.stage,
			project: dir,
		});
		const key = args.join(" ");
		if (key === lastPanelMetaKey) return;
		lastPanelMetaKey = key;
		try {
			await callHerdr({ args, timeoutMs: 10000 });
		} catch {
			lastPanelMetaKey = undefined; // retry next turn
		}
	}

	function registerSelf(ctx: ExtensionContext, resolvedName?: string): void {
		if (!selfPane) return;
		pruneDeadIdentities();
		const known = readIdentities();
		const sessionId = ctx.sessionManager.getSessionId();
		const prior =
			known.find((i) => i.pane_id === selfPane) ?? known.find((i) => i.session_id === sessionId);
		writeIdentity({
			pane_id: selfPane,
			name: resolvedName ?? ownName(),
			session_path: ctx.sessionManager.getSessionFile(),
			session_id: sessionId,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinking: ctx.thinkingLevel,
			cwd: ctx.cwd,
			group: prior?.group,
			stage: prior?.stage,
			pid: process.pid,
			started_at: prior?.started_at ?? Date.now(),
			updated_at: Date.now(),
		});
	}

	function identities(): AgentIdentity[] {
		return readIdentities();
	}

	/** Resolve a `^^name` (or bare registered name) target to its pane id. */
	function targetResolved(target: string | undefined): string | undefined {
		if (!target) return target;
		return resolvePaneRef(target, identities()) ?? target;
	}

	let herdrNamed = false;
	let autocompleteRegistered = false;

	/** Reconcile herdr's panel name in the background (never blocks startup). */
	async function reconcileName(ctx: ExtensionContext): Promise<void> {
		const name = await assertHerdrName(ownName());
		if (name) {
			herdrNamed = true;
			registerSelf(ctx, name);
			if (ircNode) ircNode.identity = name;
		}
		await reportPanel(ctx, name);
	}

	// IRC node is created below, once per process; declared here so the session
	// handlers can bind it to the durable session identity.
	let ircNode: IrcNode | undefined;
	let currentCtx: ExtensionContext | undefined;

	pi.on("session_start", (_event, ctx) => {
		sessionModels = modelsFromCtx(ctx);
		currentCtx = ctx;
		delegates.sync(ctx.sessionManager.getBranch() as unknown as readonly DelegateEntryLike[]);
		herdrNamed = false;
		registerSelf(ctx);
		// Key the mailbox by the durable session id, and drain anything queued
		// for this identity while it was not running.
		try {
			ircNode?.setSession(ctx.sessionManager.getSessionId(), ownName());
		} catch {
			// no session id available; keep the pane-keyed mailbox
		}
		if (!autocompleteRegistered && ctx.mode === "tui") {
			autocompleteRegistered = true;
			ctx.ui.addAutocompleteProvider(makeMentionAutocomplete);
		}
		void reconcileName(ctx);
	});

	// A reload can replace the extension mid-run without re-firing session_start;
	// the first turn start guarantees the agent is detected, so reconcile then.
	pi.on("agent_start", (_event, ctx) => {
		if (!herdrNamed) void reconcileName(ctx);
		else void reportPanel(ctx); // refresh if the cwd/project changed
	});

	// Keep the roster's model/thinking metadata fresh.
	pi.on("model_select", (_event, ctx) => registerSelf(ctx));
	pi.on("thinking_level_select", (_event, ctx) => registerSelf(ctx));
	pi.on("session_shutdown", () => {
		// Keep the durable identity entry: a closed session is "dormant", so mail
		// addressed to it is still deliverable if the session is resumed. It is
		// reaped later by pruneDeadIdentities once its transcript is gone or stale.
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !event.text.includes("^")) return { action: "continue" };
		const trimmed = event.text.trimStart();
		// `!` / `$` drafts are local shell execution; leave their body verbatim.
		if (trimmed.startsWith("!") || trimmed.startsWith("$")) return { action: "continue" };
		sessionModels = modelsFromCtx(ctx);
		if (delegates.all.length === 0) {
			delegates.sync(ctx.sessionManager.getBranch() as unknown as readonly DelegateEntryLike[]);
		}
		const expanded = delegates.expand(event.text);
		const inst = expandInstances(expanded.text);
		if (expanded.delegates.length === 0 && inst.refs.length === 0) return { action: "continue" };
		return { action: "transform", text: inst.text };
	});

	// ---- IRC: durable mailbox + unix-socket doorbell ------------------------
	const paneId = process.env.HERDR_PANE_ID;
	let busy = false;
	pi.on("agent_start", () => {
		busy = true;
	});
	pi.on("agent_settled", () => {
		busy = false;
		// Confirm messages that were injected during the turn (or re-arm any
		// that were dropped), then pick up anything that arrived meanwhile.
		void ircNode?.settle();
	});

	const listAgents = async (scope: HerdrScope): Promise<IrcAgent[]> => {
		const { result } = await callHerdr({ args: ["agent", "list"], timeoutMs: 30000 });
		const rec = asRecord(result);
		const raw = Array.isArray(rec?.agents) ? (rec.agents as Record<string, unknown>[]) : [];
		const enriched = withIdentities(raw, identities());
		return scopeRecords(enriched as ScopedRecord[], scope, spawned).shown as unknown as IrcAgent[];
	};

	/**
	 * Fire one deduped herdr notification when every worker in a stage settles.
	 * Keyed by member count, so a stage that gains a worker and settles again
	 * notifies a second time. Best-effort: the notification is for the human, and
	 * never blocks or fails the tool call.
	 */
	const stageNotified = new StageNotifier();
	async function notifyIfStageDone(group: string, stage: string): Promise<void> {
		try {
			const key = `${group}/${stage}`;
			const members = identities().filter((i) => i.group === group && (i.stage || "main") === stage);
			const live = await listAgents("all");
			const statusByPane = new Map(live.map((a) => [a.pane_id, a.agent_status]));
			const settled = !members.some((i) => {
				const s = statusByPane.get(i.pane_id);
				return s === "working" || s === "blocked";
			});
			if (!stageNotified.shouldNotify(key, members.length, settled)) return;
			const names = members
				.map((i) => i.name)
				.sort()
				.join(", ");
			await callHerdr({
				args: [
					"notification",
					"show",
					`stage ${group}/${stage} complete`,
					"--body",
					`${members.length} worker(s) settled: ${names}`,
					"--sound",
					"none",
				],
				timeoutMs: 10000,
			});
		} catch {
			/* display-only; never let a notice break the tool */
		}
	}

	// A message is durable in the session transcript; the mailbox entry is
	// unlinked only once this confirms the custom entry is present, so a crash
	// between injection and persistence re-delivers rather than dropping.
	function isIrcPersisted(env: IrcEnvelope): boolean {
		const entries = currentCtx?.sessionManager?.getEntries?.() ?? [];
		return entries.some(
			(e) =>
				e.type === "custom_message" &&
				e.customType === "irc" &&
				(e.details as { id?: string } | undefined)?.id === env.id,
		);
	}

	if (paneId) {
		const node = new IrcNode({
			paneId,
			identity: paneId,
			deliver: (env) => {
				// Steer stays inside the current turn (no triggerTurn); everything
				// else queues as a follow-up and wakes the agent. Pairing
				// `triggerTurn` with `steer` silently dropped the message, so the two
				// are mutually exclusive here.
				const steer = env.mode === "steer" && busy;
				const options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" } = steer
					? { deliverAs: "steer" }
					: { triggerTurn: true, deliverAs: "followUp" };
				Promise.resolve(
					pi.sendMessage(
						{ customType: "irc", content: formatIrcForModel(env), display: true, details: env },
						options,
					),
				).catch((error) => {
					console.error("[irc] delivery failed:", error);
				});
			},
			isPersisted: isIrcPersisted,
		});
		ircNode = node;
		void node.start().catch(() => {});
		void getAgent(paneId)
			.then((info) => {
				if (info.name) node.identity = info.name;
			})
			.catch(() => {});

		// Resolve a name / `^^name` / session id / pane id to a mailbox. Dormant
		// identities resolve too (no live pane): the message is parked for them.
		const resolveTarget = async (ref: string): Promise<IrcTarget | undefined> => {
			const found = findIdentity(ref, identities());
			if (found) {
				const live = isAlive(found.pid);
				return {
					mailboxKey: found.session_id ?? found.pane_id,
					...(live ? { paneId: found.pane_id } : {}),
					identity: found.name,
				};
			}
			const all = await listAgents("all");
			const match = all.find((a) => a.name === ref || a.pane_id === ref || a.session_id === ref);
			if (!match) return undefined;
			return {
				mailboxKey: match.session_id ?? match.pane_id,
				paneId: match.pane_id,
				identity: match.name ?? match.pane_id,
			};
		};

		registerIrcTool(pi, { node, listAgents, resolveTarget });
		pi.on("session_shutdown", () => node.stop());
	}
	pi.registerTool({
		name: "herdr",
		label: "Herdr",
		description:
			"herdr is a terminal workspace manager (like tmux) that hosts multiple AI coding agents at once. It organizes terminals as workspaces → tabs → panes. This tool drives that cluster from inside pi: list/inspect agents and panes, spawn pi workers in new panes, workspaces, or git worktrees, send them prompts, wait for their turns to settle, and read their structured results. Every worker is a pi agent — spawn one per model/thinking level to create ad-hoc teammates on the fly. Only works when pi itself is running inside herdr (HERDR_ENV=1); otherwise the tool reports that it is unavailable.",
		promptSnippet: "Spawn and drive ad-hoc pi workers in herdr panes to delegate work",
		promptGuidelines: [
			"herdr is a terminal workspace manager (like tmux) that runs many AI coding agents side by side, organized as workspaces → tabs → panes, with one agent per pane. This tool is how you observe and drive those agents from inside pi. Every worker is a pi agent.",
			"Start with `agents` and `panes` to discover what is running, then target an agent by its name (auto-generated codenames like `amber-otter`) or hosting pane id (e.g. w3:pJ).",
			"Roster and pane listings default to `scope: workspace` — only agents sharing your workspace, plus anything this session spawned; pass `scope: all` to see every agent in the herdr session.",
			"To run a worker on a specific model, pass `model` (a `provider/id` selector or a `^selector[:level]` delegate) and optional `thinking` to `spawn`/`agent_start`; `spawn` compiles them to `--model`/`--thinking`. Omit `name` to get a memorable codename.",
			"When the user writes `^selector[:level]` in a prompt, they are asking you to delegate to that model — spawn a worker with `model` set to the token. `^^name` refers to an already-running worker (address it by name).",
			"Delegate with `agent_prompt` (which returns `baseline_seq`), then call `agent_result` with `since` set to that baseline to wait (event-driven, no polling) for the turn to settle and return the worker's structured result — its final message, model, and usage — read from the pi session transcript. Use `agent_read`/`agent_wait` only for raw terminal inspection.",
			"`spawn` creates a fresh isolated worker (its own workspace, or a git worktree); workers get the `herdr` tool denied so they cannot spawn their own subagents — pass `nested: true` to allow nesting.",
			"Give a fan-out a workflow shape with `group` + `stage`: workers then share one herdr workspace (label=group) and one tab per stage, their names default to `<group>-<stage>-<n>`, and the roster reports `group`/`stage`. Use it for multi-stage runs (e.g. dig → critique → judge); when only `group` is set, `stage` defaults to `main`.",
			"Track a workflow with `workflow` (`group:<g>` to scope one, omit for all your groups): it folds the live agent statuses and the durable registry into per-stage counts and a `working|blocked|done` status, so you can see a fan-out at a glance instead of polling each worker. `agents` also accepts `group` to filter the roster.",
			"When a grouped worker settles, the tool shows one herdr notification once its whole stage is idle/dormant (deduped; `notify:false` silences it). This is for the human watching the panels.",
			"Only usable when pi runs inside a herdr pane; otherwise the tool reports that it is unavailable.",
		],
		parameters: herdrSchema,
		async execute(_id, rawParams, signal, _onUpdate, _ctx) {
			if (!herdrAvailable()) {
				throw new Error(herdrUnavailableReason());
			}
			const params: HerdrParams = rawParams.target
				? { ...rawParams, target: targetResolved(rawParams.target) }
				: rawParams;
			if (params.action === "spawn") {
				const outcome = await spawnAgent(params, signal, modelArgsFor(params));
				spawned.add(outcome.pane_id);
				if (outcome.group && params.notify !== false) {
					void notifyIfStageDone(outcome.group, outcome.stage ?? "main");
				}
				return {
					content: [{ type: "text", text: renderHerdrResult(outcome) }],
					details: { action: "spawn", ...outcome },
				};
			}
			if (params.action === "agent_result") {
				const target = req(params.target, "target");
				const info = await waitForTurnSettled(target, {
					sinceSeq: params.since,
					timeoutMs: params.timeout ?? 120000,
					signal,
				});
				const sessionPath = sessionPathOf(info as { agent_session?: unknown });
				const result = sessionPath ? await readSessionResult(sessionPath) : undefined;
				const out = {
					pane_id: info.pane_id,
					name: info.name,
					agent: info.agent,
					status: info.agent_status,
					state_change_seq: info.state_change_seq,
					session_path: sessionPath,
					result: result ?? null,
					...(result
						? {}
						: {
								note: "No structured result: this agent does not expose a pi session transcript. Only status is returned (no terminal scraping).",
							}),
				};
				const agentIdentity = findIdentity(target, identities());
				if (agentIdentity?.group && params.notify !== false) {
					void notifyIfStageDone(agentIdentity.group, agentIdentity.stage || "main");
				}
				return {
					content: [{ type: "text", text: renderHerdrResult(out) }],
					details: { action: "agent_result", ...out },
				};
			}
			if (params.action === "agent_prompt") {
				const target = req(params.target, "target");
				// Capture the pre-prompt state_change_seq so callers can pass it as
				// `since` to agent_result and avoid the "still idle" race.
				let baselineSeq: number | undefined;
				try {
					const info = await getAgent(target, { signal });
					baselineSeq =
						typeof info.state_change_seq === "number" ? info.state_change_seq : undefined;
				} catch {
					// socket unavailable / agent not resolvable yet — baseline is optional
				}
				const args = buildHerdrArgs(params);
				const timeoutMs = (params.timeout ?? 110000) + 15000;
				const { result } = await callHerdr({ args, timeoutMs }, signal);
				const out = { ...(asRecord(result) ?? { result }), baseline_seq: baselineSeq };
				if (params.wait && params.notify !== false) {
					const agentIdentity = findIdentity(target, identities());
					if (agentIdentity?.group) void notifyIfStageDone(agentIdentity.group, agentIdentity.stage || "main");
				}
				return {
					content: [{ type: "text", text: renderHerdrResult(out) }],
					details: { action: "agent_prompt", ...out },
				};
			}
			if (params.action === "workflow") {
				const scope = (params.scope ?? "workspace") as HerdrScope;
				const liveRows = await listAgents("all");
				const { result: wsResult } = await callHerdr({ args: ["workspace", "list"], timeoutMs: 30000 }, signal);
				const wsRec = asRecord(wsResult);
				const workspaces = Array.isArray(wsRec?.workspaces)
					? (wsRec.workspaces as { workspace_id?: string; label?: string }[])
					: [];
				const selfWs = process.env.HERDR_WORKSPACE_ID;
				const groups = aggregateWorkflows(liveRows as unknown as WorkflowLiveAgent[], identities(), {
					group: params.group?.trim() || undefined,
					workspaces,
					keepGroup: (g) =>
						scope === "all" ||
						!!params.group ||
						workspaces.some((w) => w.label === g && w.workspace_id === selfWs) ||
						identities().some((i) => i.group === g && spawned.has(i.pane_id)),
				});
				const out = { scope, total: groups.length, groups };
				return {
					content: [{ type: "text", text: renderHerdrResult(out) }],
					details: { action: "workflow", ...out },
				};
			}
			let effective: HerdrParams = params;
			if (params.action === "agent_start") {
				const group = params.group?.trim() || undefined;
				const stage = params.stage?.trim() || (group ? "main" : undefined);
				const taken = new Set(identities().map((i) => i.name));
				const name =
					params.name?.trim() ||
					(group
						? stageName(group, stage ?? "main", countStage(group, stage ?? "main") + 1, taken)
						: generateName(taken));
				effective = {
					...params,
					name,
					agentArgs: ["--name", name, ...modelArgsFor(params), ...(params.agentArgs ?? [])],
				};
			}
			const args = buildHerdrArgs(effective);
			const timeoutMs = (params.timeout ?? 110000) + 15000;
			const startGroup = effective.action === "agent_start" ? effective.group?.trim() : undefined;
			const priorFocus = startGroup ? await focusedWorkspaceId(signal) : undefined;
			const { result } = await callHerdr({ args, timeoutMs }, signal);
			if (startGroup && effective.pane) {
				await recordGrouping(effective.pane, startGroup, effective.stage?.trim() || "main");
			}
			await restoreFocus(priorFocus);
			let scoped = applyScope(params, result, spawned);
			if (params.action === "agents") {
				const rec = asRecord(scoped);
				let arr = rec && Array.isArray(rec.agents) ? (rec.agents as Record<string, unknown>[]) : undefined;
				if (rec && arr) {
					arr = withIdentities(arr, identities());
					const groupFilter = params.group?.trim();
					if (groupFilter) arr = arr.filter((a) => a.group === groupFilter);
					scoped = { ...rec, agents: arr, ...(groupFilter ? { group: groupFilter } : {}) };
				}
			}
			return {
				content: [{ type: "text", text: renderHerdrResult(scoped) }],
				details: { action: params.action, args },
			};
		},
	});
}
