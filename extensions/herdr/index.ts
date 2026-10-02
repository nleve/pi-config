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
import { appendSpawnEntry, registerNavigation } from "./navigation.ts";
import {
	aggregateWorkflows,
	panelMetadataArgs,
	StageNotifier,
	workspaceMetadataArgs,
	type WorkflowLiveAgent,
} from "./workflow.ts";
import {
	findIdentity,
	identityByName,
	isAlive,
	mergeIdentity,
	preferIdentity,
	pruneDeadIdentities,
	pruneRecycledIdentities,
	readIdentities,
	resolvePaneRef,
	setIdentityGrouping,
	setIdentityParent,
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

/** Sanitize a handle to herdr's agent-name charset (`^[a-z][a-z0-9_-]{0,31}$`). */
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
	/** Set when the worker started but the initial prompt/wait failed; the worker is still live. */
	error?: string;
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
 * In-process serialization of placement, keyed by group/stage. Parallel spawns
 * for one stage chain onto the same promise instead of racing list→create.
 */
const stageLocks = new Map<string, Promise<unknown>>();

function withStageLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prior = stageLocks.get(key) ?? Promise.resolve();
	const run = prior.then(fn, fn);
	const guarded = run.catch(() => {});
	stageLocks.set(key, guarded);
	void guarded.then(() => {
		if (stageLocks.get(key) === guarded) stageLocks.delete(key);
	});
	return run;
}

/** Pane rows in a workspace, or undefined when the list failed (never guess empty). */
async function listWorkspacePanes(
	workspaceId: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>[] | undefined> {
	const panes = await callHerdr(
		{ args: ["pane", "list", "--workspace", workspaceId], timeoutMs: 30000 },
		signal,
	).catch(() => undefined);
	if (!panes) return undefined;
	const rec = asRecord(panes.result);
	if (!Array.isArray(rec?.panes)) return undefined;
	return rec.panes as Record<string, unknown>[];
}

/** Same-label workspace ids, ascending (undefined when the list failed). */
async function listWorkspaceIds(label: string, signal?: AbortSignal): Promise<string[] | undefined> {
	const res = await callHerdr({ args: ["workspace", "list"], timeoutMs: 30000 }, signal).catch(
		() => undefined,
	);
	if (!res) return undefined;
	const rec = asRecord(res.result);
	const rows = Array.isArray(rec?.workspaces) ? (rec.workspaces as Record<string, unknown>[]) : [];
	return rows
		.filter((w) => w.label === label && typeof w.workspace_id === "string")
		.map((w) => w.workspace_id as string)
		.sort();
}

/** Same-label tab ids in a workspace, ascending (undefined when the list failed). */
async function listStageTabIds(
	workspaceId: string,
	label: string,
	signal?: AbortSignal,
): Promise<string[] | undefined> {
	const res = await callHerdr(
		{ args: ["tab", "list", "--workspace", workspaceId], timeoutMs: 30000 },
		signal,
	).catch(() => undefined);
	if (!res) return undefined;
	const rec = asRecord(res.result);
	const rows = Array.isArray(rec?.tabs) ? (rec.tabs as Record<string, unknown>[]) : [];
	return rows
		.filter((t) => t.label === label && typeof t.tab_id === "string")
		.map((t) => t.tab_id as string)
		.sort();
}

/**
 * Lowest id among a same-label set. We re-check once after a short pause when we
 * only saw our own create: a peer's concurrent create may not have landed yet.
 * Bounded to one extra list — never loops.
 */
async function convergeLowestId(
	list: () => Promise<string[] | undefined>,
	createdId: string | undefined,
): Promise<string | undefined> {
	if (!createdId) return undefined;
	let winner = (await list())?.[0];
	if (winner !== createdId) return winner;
	await new Promise((r) => setTimeout(r, 400));
	winner = (await list())?.[0];
	return winner;
}

/**
 * Place a worker in a shared workflow workspace (`group` label) and stage tab
 * (`stage` label), creating either when missing. The first worker in a fresh
 * workspace reuses its initial tab (renamed to the stage) instead of orphaning
 * a stray pane; later workers split a pane in the stage tab.
 *
 * Placement is serialized per group/stage so parallel spawns cannot each create
 * a same-label workspace/tab, and each create is followed by a re-list so a
 * racing caller in another process converges on one shared object.
 */
async function ensureStagePane(
	group: string,
	stage: string,
	opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<StagePlacement> {
	return withStageLock(`stage:${group}\u0000${stage}`, () => ensureStagePaneLocked(group, stage, opts));
}

async function ensureStagePaneLocked(
	group: string,
	stage: string,
	opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<StagePlacement> {
	let workspaceId: string | undefined;
	let tabId: string | undefined;
	let paneId: string | undefined;
	let createdWorkspace = false;
	let createdTab = false;

	try {
		// Resolve an existing same-label workspace deterministically (lowest id),
		// matching the create-race convergence below; otherwise one group could
		// split across two same-label workspaces depending on list order.
		workspaceId = (await listWorkspaceIds(group, opts.signal))?.[0];

		if (!workspaceId) {
			const args = ["workspace", "create", "--label", group, "--no-focus"];
			if (opts.cwd) args.push("--cwd", opts.cwd);
			const created = await callHerdr({ args, timeoutMs: 120000 }, opts.signal);
			const rec = asRecord(created.result);
			const createdId = asRecord(rec?.workspace)?.workspace_id as string | undefined;
			tabId = asRecord(rec?.tab)?.tab_id as string | undefined;
			paneId = asRecord(rec?.root_pane)?.pane_id as string | undefined;
			workspaceId = createdId;
			createdWorkspace = true;
			// Another process may have created a same-label workspace concurrently;
			// converge on the lowest id and drop our duplicate unless a sibling has
			// already moved into it.
			const winner = await convergeLowestId(() => listWorkspaceIds(group, opts.signal), createdId);
			if (winner && createdId && winner !== createdId) {
				await rollbackPlacement(
					{
						workspace_id: createdId,
						tab_id: tabId,
						pane_id: paneId,
						created_workspace: true,
						created_tab: false,
					},
				);
				workspaceId = winner;
				tabId = undefined;
				paneId = undefined;
				createdWorkspace = false;
			}
		}

		if (createdWorkspace && tabId) {
			await callHerdr({ args: ["tab", "rename", tabId, stage], timeoutMs: 10000 }, opts.signal).catch(
				() => {},
			);
			// A peer may have created and adopted a same-label stage tab before our
			// rename landed; converge on the lowest id, exactly like the tab-create
			// race below, so one stage does not end up with two tabs.
			const winner = await convergeLowestId(
				() => listStageTabIds(workspaceId!, stage, opts.signal),
				tabId,
			);
			if (winner && winner !== tabId) {
				// Adopt the peer's lower-id stage tab and drop our renamed initial tab
				// (and its root pane) so the stage does not keep two same-label tabs.
				const strayTab = tabId;
				const strayPane = paneId;
				tabId = winner;
				paneId = undefined;
				await rollbackPlacement({
					workspace_id: workspaceId,
					tab_id: strayTab,
					pane_id: strayPane,
					created_workspace: false,
					created_tab: true,
				});
			}
		} else if (workspaceId) {
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
				const createdTabId = asRecord(rec?.tab)?.tab_id as string | undefined;
				paneId = asRecord(rec?.root_pane)?.pane_id as string | undefined;
				createdTab = true;
				// Same convergence for a racing same-label tab create.
				const winner = await convergeLowestId(
					() => listStageTabIds(workspaceId!, stage, opts.signal),
					createdTabId,
				);
				if (winner && createdTabId && winner !== createdTabId) {
					await rollbackPlacement(
						{
							workspace_id: workspaceId,
							tab_id: createdTabId,
							pane_id: paneId,
							created_workspace: false,
							created_tab: true,
						},
					);
					tabId = winner;
					paneId = undefined;
					createdTab = false;
				} else {
					tabId = createdTabId;
				}
			}
		}

		if (!workspaceId || !tabId) {
			throw new Error(`herdr spawn: could not resolve stage '${group}/${stage}' workspace/tab`);
		}
		if (!paneId) {
			const rows = (await listWorkspacePanes(workspaceId, opts.signal)) ?? [];
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
	} catch (error) {
		// Close exactly what we created so far — and only if no sibling has since
		// occupied it — before surfacing the failure, so a mid-way throw cannot
		// strand a stray same-label workspace/tab.
		await rollbackPlacement(
			{
				workspace_id: workspaceId,
				tab_id: tabId,
				pane_id: paneId,
				created_workspace: createdWorkspace,
				created_tab: createdTab,
			},
		);
		throw error;
	}
}

/** How many workers are already registered for a group/stage (for the `-n` suffix). */
function countStage(group: string, stage: string): number {
	return readIdentities().filter((i) => i.group === group && i.stage === stage).length;
}

/**
 * Names reserved by spawns in flight in this process, bridging the gap before
 * the worker's identity file lands. Entries auto-expire so a lost reservation
 * cannot reserve a name for the process lifetime; callers release promptly.
 */
const pendingNames = new Map<string, number>();
const PENDING_NAME_TTL_MS = 60000;

function reserveName(name: string): void {
	pendingNames.set(name, Date.now() + PENDING_NAME_TTL_MS);
}

function releaseName(name: string): void {
	pendingNames.delete(name);
}

/**
 * Drop a reservation once the expected worker at `paneId` has registered
 * (bounded). Matches the worker, not just any entry at the pane, so a recycled
 * pane's dormant identity does not free the name before our worker appears.
 */
function releaseNameWhenRegistered(
	name: string,
	paneId: string,
	expected?: { session_path?: string; startedAt?: number },
): void {
	void (async () => {
		for (let attempt = 0; attempt < 12; attempt++) {
			const found = identityForPane(paneId);
			if (found && matchesExpectedWorker(found, expected)) break;
			await new Promise((r) => setTimeout(r, 250));
		}
		releaseName(name);
	})();
}

function pendingNameTaken(name: string): boolean {
	const expiry = pendingNames.get(name);
	if (expiry === undefined) return false;
	if (expiry <= Date.now()) {
		pendingNames.delete(name);
		return false;
	}
	return true;
}

/** Registry names plus this process's unexpired in-flight reservations. */
function takenNames(): Set<string> {
	const taken = new Set(readIdentities().map((i) => i.name));
	const now = Date.now();
	for (const [name, expiry] of pendingNames) {
		if (expiry > now) taken.add(name);
		else pendingNames.delete(name);
	}
	return taken;
}

/** Append a numeric suffix until the name is free (herdr's 32-char limit). */
function numericName(base: string, taken: ReadonlySet<string>): string {
	for (let k = 2; k < 1000; k++) {
		const suffix = `-${k}`;
		const candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`.replace(/-+$/g, "");
		if (!taken.has(candidate) && !pendingNameTaken(candidate)) return candidate;
	}
	return `${base.slice(0, 27)}-${Date.now().toString(36)}`.slice(0, 32);
}

/** Sanitize a caller-supplied agent name, or throw a clear validation error. */
function explicitAgentName(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) return undefined;
	const safe = herdrSafeName(trimmed);
	if (!safe) {
		throw new Error(
			`herdr: invalid agent name '${trimmed}' (expected ^[a-z][a-z0-9_-]{0,31}$)`,
		);
	}
	return safe;
}

/**
 * Pick the worker's effective name. A grouped spawn derives `<group>-<stage>-<n>`
 * from the freshly-read registry (plus in-flight reservations) so parallel
 * callers do not mint the same name; explicit names are sanitized and the
 * chosen name is reserved until the worker registers.
 */
function chooseName(params: HerdrParams, group: string | undefined, stage: string | undefined): string {
	const explicit = explicitAgentName(params.name);
	const name = explicit
		? explicit
		: group
			? stageName(group, stage ?? "main", countStage(group, stage ?? "main") + 1, takenNames())
			: generateName(takenNames());
	reserveName(name);
	return name;
}

const NAME_TAKEN_RE = /taken|in use|exists|unique|duplicate|conflict/i;

/**
 * Tear down a placement we own without disturbing siblings: close only our own
 * pane, then a workspace/tab we created only once it is empty (a peer may have
 * adopted it and started a live worker in the meantime). Best-effort throughout.
 */
async function rollbackPlacement(
	placed: {
		workspace_id?: string;
		tab_id?: string;
		pane_id?: string;
		created_workspace: boolean;
		created_tab: boolean;
	},
	signal?: AbortSignal,
): Promise<void> {
	if (placed.pane_id) {
		await callHerdr({ args: ["pane", "close", placed.pane_id], timeoutMs: 30000 }, signal).catch(
			() => {},
		);
	}
	if (placed.created_workspace && placed.workspace_id) {
		const panes = await listWorkspacePanes(placed.workspace_id, signal);
		if (panes && panes.length === 0) {
			await callHerdr(
				{ args: ["workspace", "close", placed.workspace_id], timeoutMs: 30000 },
				signal,
			).catch(() => {});
		}
	} else if (placed.created_tab && placed.tab_id && placed.workspace_id) {
		const panes = await listWorkspacePanes(placed.workspace_id, signal);
		if (panes && panes.filter((p) => p.tab_id === placed.tab_id).length === 0) {
			await callHerdr({ args: ["tab", "close", placed.tab_id], timeoutMs: 30000 }, signal).catch(
				() => {},
			);
		}
	}
}

/** Close a workspace an isolated spawn created, best-effort, when the start fails. */
async function rollbackWorkspace(workspaceId: string, signal?: AbortSignal): Promise<void> {
	try {
		await callHerdr({ args: ["workspace", "close", workspaceId], timeoutMs: 30000 }, signal);
	} catch {
		/* best-effort cleanup */
	}
}

/**
 * `agent start` with a name-collision retry. herdr enforces unique live names
 * across processes, so a name minted from a stale registry can lose the race;
 * on that error we mint a numeric-suffixed name and either rename the agent in
 * place (if the start had registered it) or retry the start.
 */
async function startAgentWithName(opts: {
	params: HerdrParams;
	paneId: string;
	name: string;
	agentArgsFor: (name: string) => readonly string[];
	signal?: AbortSignal;
}): Promise<{ agent: Record<string, unknown> | undefined; name: string }> {
	const { params, paneId, agentArgsFor, signal } = opts;
	let candidate = opts.name;
	// Only an agent this call started may be renamed on a name-taken error. If
	// the pane already hosts an agent (a caller-supplied pane), the collision is
	// elsewhere and renaming the occupant would corrupt an unrelated worker.
	let paneWasEmpty = false;
	try {
		await getAgent(paneId, { signal });
	} catch {
		paneWasEmpty = true;
	}
	for (let attempt = 0; attempt < 6; attempt++) {
		const agentArgs = agentArgsFor(candidate);
		try {
			const started = await callHerdr(
				{
					args: buildHerdrArgs({
						...params,
						action: "agent_start",
						name: candidate,
						pane: paneId,
						agentArgs,
					}),
					timeoutMs: (params.timeout ?? 60000) + 15000,
				},
				signal,
			);
			return { agent: asRecord(asRecord(started.result)?.agent), name: candidate };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (attempt >= 5 || !NAME_TAKEN_RE.test(msg)) {
				releaseName(candidate);
				throw error;
			}
			const taken = takenNames();
			taken.add(candidate);
			const previous = candidate;
			candidate = numericName(candidate, taken);
			releaseName(previous);
			reserveName(candidate);
			// The failed start may have registered the agent before rejecting the
			// duplicate name; renaming it in place avoids a second start. Only do
			// that when the pane was empty before this call and still holds the name
			// we just tried, so an unrelated occupant is never renamed.
			if (paneWasEmpty) {
				try {
					const current = await getAgent(paneId, { signal });
					if (current.name === previous) {
						await callHerdr(
							{ args: ["agent", "rename", paneId, candidate], timeoutMs: 10000 },
							signal,
						);
						let agent: Record<string, unknown> | undefined;
						try {
							agent = (await getAgent(paneId, { signal })) as unknown as Record<string, unknown>;
						} catch {
							/* renamed, but live info is unavailable; still a success */
						}
						return { agent, name: candidate };
					}
				} catch {
					/* cannot confirm the pane's agent is ours — retry the start */
				}
			}
		}
	}
	throw new Error(`herdr spawn: agent name '${opts.name}' stayed taken`);
}

/** Label a grouped worker's pane and shared workspace in the human's panel. */
async function labelGroupedPane(
	paneId: string,
	workspaceId: string | undefined,
	group: string,
	stage: string,
	name: string,
	signal?: AbortSignal,
): Promise<void> {
	await callHerdr(
		{ args: panelMetadataArgs(paneId, name, { group, stage }), timeoutMs: 10000 },
		signal,
	).catch(() => {});
	if (!workspaceId) return;
	const stages = [
		...new Set(readIdentities().filter((i) => i.group === group).map((i) => i.stage || "main")),
	];
	await callHerdr(
		{ args: workspaceMetadataArgs(workspaceId, { group, stages }), timeoutMs: 10000 },
		signal,
	).catch(() => {});
}

/** Preferred registry entry for a pane (recycled panes resolve to the live/current one). */
function identityForPane(paneId: string): AgentIdentity | undefined {
	let found: AgentIdentity | undefined;
	for (const id of readIdentities()) if (id.pane_id === paneId) found = preferIdentity(found, id);
	return found;
}

/**
 * Poll for a freshly-started worker's identity to land, then apply `stamp`.
 * The worker registers itself asynchronously and a slow worker can take longer
 * than a couple of seconds to answer its first turn, so the grouping stamp and
 * the parent link share one deadline. `expected` rejects a recycled pane's
 * dormant entry so a stale session is never stamped.
 */
async function stampWhenRegistered(
	paneId: string,
	expected: { session_path?: string; startedAt?: number } | undefined,
	stamp: (found: AgentIdentity) => void,
): Promise<void> {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		const found = identityForPane(paneId);
		if (found && matchesExpectedWorker(found, expected)) {
			stamp(found);
			return;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
}

/** Stamp group/stage onto a freshly-started worker's identity (it registers itself first). */
async function recordGrouping(
	paneId: string,
	group: string,
	stage: string,
	expected?: { session_path?: string; startedAt?: number },
): Promise<void> {
	await stampWhenRegistered(paneId, expected, (found) => setIdentityGrouping(found, group, stage));
}

/**
 * Stamp the spawning orchestrator onto a freshly-started worker's identity.
 * The worker registers itself asynchronously, so poll (`identityForPane`) for
 * the shared registration deadline before linking, and only link the expected
 * worker: a recycled pane can still hold the previous session's dormant entry,
 * so when we know the new worker's `session_path` (or a start timestamp)
 * require it to match before writing. Best-effort: a missing registry entry or
 * a write failure must never fail the spawn.
 */
async function stampParent(
	paneId: string | undefined,
	parent: { session_id: string; pane_id: string | undefined; name: string },
	expected?: { session_path?: string; startedAt?: number },
): Promise<void> {
	if (!paneId) return;
	try {
		await stampWhenRegistered(paneId, expected, (found) =>
			setIdentityParent(found.session_id ?? found.session_path ?? found.pane_id, parent),
		);
	} catch {
		/* best-effort: the parent link is a convenience, never a spawn failure */
	}
}

/** True when `found` is the worker we just started, not a recycled-pane entry. */
function matchesExpectedWorker(
	found: AgentIdentity,
	expected: { session_path?: string; startedAt?: number } | undefined,
): boolean {
	if (!expected) return true;
	if (expected.session_path) return found.session_path === expected.session_path;
	if (expected.startedAt !== undefined) return (found.started_at || 0) >= expected.startedAt;
	return true;
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
	onPanePlaced?: (paneId: string) => void,
): Promise<SpawnOutcome> {
	const kind = "pi";
	const mode = params.mode ?? "workspace";
	const group = params.group?.trim() || undefined;
	const stage = params.stage?.trim() || (group ? "main" : undefined);
	const nested = params.nested === true;
	// `agent start` (and a default-focus create) moves the human's view; capture
	// it up front so a failed or successful start can restore it.
	const priorFocus = await focusedWorkspaceId(signal);

	let paneId: string | undefined;
	let workspaceId: string | undefined;
	let placed: StagePlacement | undefined;
	let createdWorkspaceId: string | undefined;
	let startedAgent: Record<string, unknown> | undefined;
	let name = "";
	let baselineSeq: number | undefined;
	let sessionPath: string | undefined;
	let startedAt = 0;

	try {
		// Placement: with `group`, share one workspace per workflow (label=group)
		// and one tab per stage; without it, keep the original isolated
		// workspace/worktree.
		if (group && mode === "workspace") {
			placed = await ensureStagePane(group, stage ?? "main", { cwd: params.cwd, signal });
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
			createdWorkspaceId = workspaceId;
		}

		// Make the new pane visible to the scoped roster immediately, even if the
		// start below fails and we roll the placement back.
		if (paneId) onPanePlaced?.(paneId);

		// Timestamp before the start so the registration stamps can reject a stale
		// recycled-pane identity when the session path is unknown.
		startedAt = Date.now();

		// Mint the name after placement against the freshest registry, so parallel
		// spawns in the same stage do not all compute `<group>-<stage>-1`.
		name = chooseName(params, group, stage);
		const agentArgsFor = (workerName: string): string[] => [
			...(nested ? [] : ["-xt", "herdr"]),
			"--name",
			workerName,
			...modelArgs,
			...(params.agentArgs ?? []),
		];
		const started = await startAgentWithName({
			params,
			paneId: req(paneId, "pane"),
			name,
			agentArgsFor,
			signal,
		});
		name = started.name;
		startedAgent = started.agent;
		baselineSeq =
			typeof startedAgent?.state_change_seq === "number" ? startedAgent.state_change_seq : undefined;
		sessionPath = startedAgent
			? sessionPathOf(startedAgent as { agent_session?: unknown })
			: undefined;

		if (group && paneId) {
			await recordGrouping(paneId, group, stage ?? "main", {
				session_path: sessionPath,
				startedAt,
			}).catch(() => {});
			await labelGroupedPane(paneId, workspaceId, group, stage ?? "main", name, signal);
		}
	} catch (error) {
		releaseName(name);
		if (placed) await rollbackPlacement(placed);
		else if (createdWorkspaceId) await rollbackWorkspace(createdWorkspaceId);
		throw error;
	} finally {
		await restoreFocus(priorFocus);
	}

	// The worker owns the name once it has registered; drop our in-flight
	// reservation then, bounded so a slow registration cannot leak it.
	if (paneId) releaseNameWhenRegistered(name, paneId, { session_path: sessionPath, startedAt });

	let prompted = false;
	let promptError: string | undefined;
	let status: string | undefined;
	let result: unknown;
	if (params.prompt) {
		try {
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
				const settled = await waitForTurnSettled(req(paneId, "pane"), {
					sinceSeq: baselineSeq,
					timeoutMs: params.timeout ?? 120000,
					signal,
				});
				status = settled.agent_status;
				// A transient read/parse failure must not discard the settled status.
				if (sessionPath) {
					try {
						result = (await readSessionResult(sessionPath)) ?? undefined;
					} catch {
						result = undefined;
					}
				}
			}
		} catch (error) {
			// The worker started and owns its pane/name; surface the prompt failure
			// without rolling it back or discarding the placement details.
			promptError = error instanceof Error ? error.message : String(error);
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
		...(promptError ? { error: promptError } : {}),
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
		// Only live workers: a dormant entry's pane may have been recycled to an
		// unrelated agent, so its `^^name → pane` legend would misdirect the model.
		const byName = identityByName(readIdentities().filter((id) => isAlive(id.pid)));
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
		const prior = selfPane ? identityForPane(selfPane)?.name : undefined;
		if (prior) return prior;
		const fresh = generateName(new Set(known.map((i) => i.name)));
		try {
			pi.setSessionName(fresh); // surface the handle in the terminal title
		} catch {
			/* best-effort; the registry entry is what matters */
		}
		return fresh;
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
		const self = identityForPane(selfPane);
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
		// Registry maintenance is best-effort: an FS error must never propagate
		// into the pi event handler and skip IRC/autocomplete setup.
		try {
			pruneDeadIdentities();
		} catch {
			/* best-effort */
		}
		try {
			pruneRecycledIdentities();
		} catch {
			/* best-effort */
		}
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionPath = ctx.sessionManager.getSessionFile();
		// Re-read synchronously just before writing: inherit group/stage/parent
		// only from an entry whose session_id is ours — a recycled pane must not
		// adopt a dead session's grouping.
		const known = readIdentities();
		const bySession = known.find((i) => i.session_id === sessionId);
		const inherit = bySession && bySession.session_id === sessionId ? bySession : undefined;
		const owned = {
			pane_id: selfPane,
			name: resolvedName ?? ownName(),
			session_path: sessionPath,
			session_id: sessionId,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinking: ctx.thinkingLevel,
			cwd: ctx.cwd,
			pid: process.pid,
			started_at: inherit?.started_at ?? Date.now(),
		};
		try {
			// Merge only the fields this writer owns so a concurrent orchestrator's
			// group/stage/parent stamp is not clobbered (cross-process lost update).
			const key = sessionId ?? sessionPath ?? selfPane;
			if (!mergeIdentity(key, owned)) {
				// No file yet (first registration): write the full object, carrying
				// over any grouping/parent link already known for this session.
				writeIdentity({
					...owned,
					group: inherit?.group,
					stage: inherit?.stage,
					parent_session_id: inherit?.parent_session_id,
					parent_pane_id: inherit?.parent_pane_id,
					parent_name: inherit?.parent_name,
					updated_at: Date.now(),
				});
			}
		} catch {
			/* best-effort: never let a registry FS error break the event handler */
		}
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
			// Unknown/absent status means "not observed", not "settled": only a live
			// worker that is idle/done, or a dormant one, counts. Otherwise a
			// freshly-started (still being detected) worker would fake completion.
			const settled =
				members.length > 0 &&
				members.every((i) => {
					const s = statusByPane.get(i.pane_id);
					if (s === "idle" || s === "done") return true;
					if (s === "working" || s === "blocked") return false;
					return !isAlive(i.pid);
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

	// Durable spawn ledger + navigation command. Registered regardless of herdr
	// availability so the command can still explain an empty/unavailable roster.
	try {
		registerNavigation(pi);
	} catch (error) {
		console.error("[herdr] navigation registration failed:", error);
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
		async execute(_id, rawParams, signal, _onUpdate, ctx) {
			if (!herdrAvailable()) {
				throw new Error(herdrUnavailableReason());
			}
			const params: HerdrParams = rawParams.target
				? { ...rawParams, target: targetResolved(rawParams.target) }
				: rawParams;
			if (params.action === "spawn") {
				const startedAt = Date.now();
				let placedPane: string | undefined;
				let outcome: SpawnOutcome;
				try {
					outcome = await spawnAgent(params, signal, modelArgsFor(params), (pane) => {
						placedPane = pane;
						spawned.add(pane);
					});
				} catch (error) {
					// spawnAgent rolled back its placement; drop the pane from scope too.
					if (placedPane) spawned.delete(placedPane);
					throw error;
				}
				// Durable ledger + parent link. Best-effort: a ledger/registry failure
				// must not fail an otherwise-successful spawn.
				try {
					appendSpawnEntry(pi, {
						action: "spawn",
						name: outcome.name,
						pane_id: outcome.pane_id,
						session_path: outcome.session_path,
						cwd: params.cwd,
						model: params.model,
						group: outcome.group,
						stage: outcome.stage,
						ts: Date.now(),
					});
					void stampParent(
						outcome.pane_id,
						{
							session_id: ctx.sessionManager.getSessionId(),
							pane_id: selfPane,
							name: ownName(),
						},
						{ session_path: outcome.session_path, startedAt },
					);
				} catch {
					/* best-effort */
				}
				// Only notify for a spawn that actually ran a prompt; a promptless
				// worker is idle immediately and would fake "stage complete".
				if (outcome.prompted && outcome.group && params.notify !== false) {
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
				// A transient read/parse failure must not throw away the settled
				// status; degrade to the no-result path instead.
				let result: unknown;
				if (sessionPath) {
					try {
						result = await readSessionResult(sessionPath);
					} catch {
						result = undefined;
					}
				}
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
			let result: unknown;
			let args: string[] = [];
			let effectiveName = "";
			if (params.action === "agent_start") {
				const group = params.group?.trim() || undefined;
				const stage = params.stage?.trim() || (group ? "main" : undefined);
				const nested = params.nested === true;
				const modelArgs = modelArgsFor(params);
				const agentArgsFor = (workerName: string): string[] => [
					...(nested ? [] : ["-xt", "herdr"]),
					"--name",
					workerName,
					...modelArgs,
					...(params.agentArgs ?? []),
				];
				// `agent start` focuses the new pane; capture/restore the human's
				// view whether or not the worker is grouped.
				const priorFocus = await focusedWorkspaceId(signal);
				let placed: StagePlacement | undefined;
				let paneId = params.pane;
				// Captured just before the start so stampParent can reject a stale
				// recycled-pane identity when the worker's session path is unknown.
				const startedAt = Date.now();
				try {
					if (group) {
						// A grouped worker must share the group workspace/stage tab
						// with its peers rather than run in an isolated pane.
						placed = await ensureStagePane(group, stage ?? "main", { cwd: params.cwd, signal });
						paneId = placed.pane_id;
						spawned.add(paneId);
					}
					const target = req(paneId, "pane");
					effectiveName = chooseName(params, group, stage);
					const started = await startAgentWithName({
						params,
						paneId: target,
						name: effectiveName,
						agentArgsFor,
						signal,
					});
					effectiveName = started.name;
					result = { agent: started.agent };
					if (group) {
						await recordGrouping(target, group, stage ?? "main", {
							session_path: sessionPathOf(started.agent as { agent_session?: unknown }),
							startedAt,
						}).catch(() => {});
						await labelGroupedPane(
							target,
							placed?.workspace_id,
							group,
							stage ?? "main",
							started.name,
							signal,
						);
					}
				} catch (error) {
					releaseName(effectiveName);
					if (placed && paneId) spawned.delete(paneId);
					if (placed) await rollbackPlacement(placed);
					throw error;
				} finally {
					await restoreFocus(priorFocus);
				}
				// The worker owns the name once it has registered; bounded release.
				if (paneId && effectiveName) releaseNameWhenRegistered(effectiveName, paneId, { startedAt });
				// Durable ledger + parent link for every started worker (grouped or
				// not). Best-effort: a ledger/registry failure must not fail an
				// otherwise-successful start.
				if (paneId && effectiveName) {
					try {
						const workerSession = sessionPathOf(asRecord(result)?.agent as { agent_session?: unknown });
						appendSpawnEntry(pi, {
							action: "agent_start",
							name: effectiveName,
							pane_id: paneId,
							session_path: workerSession,
							cwd: params.cwd,
							model: params.model,
							group,
							stage,
							ts: Date.now(),
						});
						void stampParent(
							paneId,
							{
								session_id: ctx.sessionManager.getSessionId(),
								pane_id: selfPane,
								name: ownName(),
							},
							{ session_path: workerSession, startedAt },
						);
					} catch {
						/* best-effort */
					}
				}
				effective = { ...params, name: effectiveName, pane: paneId };
				args = buildHerdrArgs({ ...effective, agentArgs: agentArgsFor(effectiveName) });
			} else {
				args = buildHerdrArgs(effective);
				const timeoutMs = (params.timeout ?? 110000) + 15000;
				({ result } = await callHerdr({ args, timeoutMs }, signal));
			}
			let scoped = applyScope(params, result, spawned);
			if (params.action === "agent_start" && effectiveName) {
				scoped = { ...(asRecord(scoped) ?? {}), name: effectiveName };
			}
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
				details: { action: params.action, args, ...(effectiveName ? { name: effectiveName } : {}) },
			};
		},
	});
}
