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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	callHerdr,
	herdrAvailable,
	herdrUnavailableReason,
	renderHerdrResult,
} from "./client.ts";
import { sessionPathOf, readSessionResult } from "./session.ts";
import { getAgent, waitForTurnSettled } from "./socket.ts";
import { formatIrcForModel, IrcNode, registerIrcTool, type IrcAgent } from "./irc.ts";

export const HERDR_ACTIONS = [
	// roster
	"agents",
	"panes",
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
	name: Type.Optional(Type.String({ description: "Agent name for agent_start, or new name for agent_rename" })),
	kind: Type.Optional(
		Type.String({ description: "Agent kind for agent_start/spawn: pi, omp, claude, codex, gemini, opencode, ..." }),
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
				'agent_start/spawn: extra args passed through to the agent after `--` (e.g. ["-xt","herdr"] to deny the herdr tool)',
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

		// ---- agent ----
		case "agent_get":
			a.push("agent", "get", req(p.target, "target"));
			break;
		case "agent_start":
			a.push("agent", "start", req(p.name, "name"), "--kind", req(p.kind, "kind"), "--pane", req(p.pane, "pane"));
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

export async function spawnAgent(params: HerdrParams, signal?: AbortSignal): Promise<SpawnOutcome> {
	const name = req(params.name, "name");
	const kind = params.kind ?? "pi";
	const mode = params.mode ?? "workspace";

	const createAction = mode === "worktree" ? "worktree_create" : "workspace_create";
	const created = await callHerdr(
		{ args: buildHerdrArgs({ ...params, action: createAction }), timeoutMs: 120000 },
		signal,
	);
	const createdRec = asRecord(created.result);
	const rootPane = asRecord(createdRec?.root_pane);
	const workspace = asRecord(createdRec?.workspace);
	const paneId = typeof rootPane?.pane_id === "string" ? rootPane.pane_id : undefined;
	if (!paneId) {
		throw new Error(
			`herdr spawn: ${createAction} did not return a root pane id: ${renderHerdrResult(created.result)}`,
		);
	}
	const workspaceId = typeof workspace?.workspace_id === "string" ? workspace.workspace_id : undefined;

	const nested = params.nested === true;
	const agentArgs = [...(nested ? [] : ["-xt", "herdr"]), ...(params.agentArgs ?? [])];
	const started = await callHerdr(
		{
			args: buildHerdrArgs({ ...params, action: "agent_start", name, kind, pane: paneId, agentArgs }),
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

	// ---- IRC: agent-to-agent messaging over per-agent unix sockets ----------
	const paneId = process.env.HERDR_PANE_ID;
	let busy = false;
	pi.on("agent_start", () => {
		busy = true;
	});
	pi.on("agent_settled", () => {
		busy = false;
	});

	const listAgents = async (scope: HerdrScope): Promise<IrcAgent[]> => {
		const { result } = await callHerdr({ args: ["agent", "list"], timeoutMs: 30000 });
		const rec = asRecord(result);
		const arr = Array.isArray(rec?.agents) ? (rec.agents as ScopedRecord[]) : [];
		return scopeRecords(arr, scope, spawned).shown as unknown as IrcAgent[];
	};

	if (paneId) {
		const node = new IrcNode({
			paneId,
			identity: paneId,
			isBusy: () => busy,
			deliver: (env) => {
				// `mode: "reject"` is handled by the node (bounced when busy); here
				// only steer/followUp reach delivery.
				const deliverAs =
					env.mode === "steer" || env.mode === "followUp" ? env.mode : busy ? "steer" : "followUp";
				pi.sendMessage(
					{ customType: "irc", content: formatIrcForModel(env), display: true, details: env },
					{ triggerTurn: true, deliverAs },
				);
			},
		});
		void node.start().catch(() => {});
		void getAgent(paneId)
			.then((info) => {
				if (info.name) node.identity = info.name;
			})
			.catch(() => {});
		registerIrcTool(pi, { node, listAgents });
		pi.on("session_shutdown", () => node.stop());
	}
	pi.registerTool({
		name: "herdr",
		label: "Herdr",
		description:
			"herdr is a terminal workspace manager (like tmux) that hosts multiple AI coding agents at once. It organizes terminals as workspaces → tabs → panes, and each pane can run a coding agent (pi, omp, claude, codex, ...). This tool drives that cluster from inside pi: list/inspect agents and panes, start new agents in new panes, workspaces, or git worktrees, send them prompts, wait for their turns to settle and read their structured results, and manage workspaces, worktrees, and notifications. Use it to delegate work to other agents and collect results. Only works when pi itself is running inside herdr (HERDR_ENV=1); otherwise the tool reports that it is unavailable.",
		promptSnippet:
			"Delegate work to other coding agents (pi, omp, claude, codex, ...) running inside herdr",
		promptGuidelines: [
			"herdr is a terminal workspace manager (like tmux) that runs many AI coding agents side by side, organized as workspaces → tabs → panes, with one agent per pane. This tool is how you observe and drive those agents from inside pi.",
			"Start with `agents` and `panes` to discover what is running, then target an agent by its live name or hosting pane id (e.g. w3:pJ).",
			"Roster and pane listings default to `scope: workspace` — only agents sharing your workspace, plus anything this session spawned; pass `scope: all` to see every agent in the herdr session.",
			"Delegate with `agent_prompt` (which returns `baseline_seq`), then call `agent_result` with `since` set to that baseline to wait (event-driven, no polling) for the turn to settle and return the worker's structured result — its final message, model, and usage — read from the pi session transcript. Use `agent_read`/`agent_wait` only for raw terminal inspection.",
			"`spawn` creates a fresh isolated worker (its own workspace, or a git worktree); workers get the `herdr` tool denied so they cannot spawn their own subagents — pass `nested: true` to allow nesting.",
			"Only usable when pi runs inside a herdr pane; otherwise the tool reports that it is unavailable.",
		],
		parameters: herdrSchema,
		async execute(_id, params, signal, _onUpdate, _ctx) {
			if (!herdrAvailable()) {
				throw new Error(herdrUnavailableReason());
			}
			if (params.action === "spawn") {
				const outcome = await spawnAgent(params, signal);
				spawned.add(outcome.pane_id);
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
				return {
					content: [{ type: "text", text: renderHerdrResult(out) }],
					details: { action: "agent_prompt", ...out },
				};
			}
			const args = buildHerdrArgs(params);
			const timeoutMs = (params.timeout ?? 110000) + 15000;
			const { result } = await callHerdr({ args, timeoutMs }, signal);
			const scoped = applyScope(params, result, spawned);
			return {
				content: [{ type: "text", text: renderHerdrResult(scoped) }],
				details: { action: params.action, args },
			};
		},
	});
}
