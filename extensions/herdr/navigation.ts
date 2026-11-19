/**
 * Subagent ledger + navigation.
 *
 * A session that spawns workers appends a {@link SpawnEntry} to its own branch
 * for each one, recording the identity it can later navigate back to (pane id,
 * session path, parent link, workflow group/stage). Because entries live in the
 * session transcript they survive reload/resume, and a re-spawn appends an
 * updated entry with a fresh pane id so the latest `ts` wins.
 *
 * `/children` (ctrl+shift+a) lists those entries with a live/closed marker and
 * focuses a live worker, or resumes a closed one in a fresh pane. `/parent`
 * (ctrl+shift+p) jumps from a worker back to the session that spawned it.
 *
 * herdr is best-effort here: every failure is surfaced as a notification and
 * never propagates into the pi session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callHerdr, herdrAvailable, herdrUnavailableReason } from "./client.ts";
import { findIdentity, isAlive, preferIdentity, readIdentities, type AgentIdentity } from "./registry.ts";

export const SPAWN_ENTRY_TYPE = "herdr_spawn";

export interface SpawnEntry {
	action: "spawn" | "agent_start";
	name: string;
	label?: string;
	pane_id?: string;
	session_path?: string;
	session_id?: string;
	cwd?: string;
	model?: string;
	group?: string;
	stage?: string;
	workspace_id?: string;
	parent_session_id?: string;
	parent_pane_id?: string;
	parent_name?: string;
	ts: number;
}

/** Persist a spawn/resume entry in the session branch (not sent to the LLM). */
export function appendSpawnEntry(pi: ExtensionAPI, entry: SpawnEntry): void {
	pi.appendEntry(SPAWN_ENTRY_TYPE, entry);
}

/** Validate one branch entry's data. Unknown/malformed data is ignored. */
export function parseSpawnEntry(data: unknown): SpawnEntry | undefined {
	if (!data || typeof data !== "object") return undefined;
	const rec = data as Record<string, unknown>;
	if (rec.action !== "spawn" && rec.action !== "agent_start") return undefined;
	if (typeof rec.name !== "string" || rec.name.length === 0) return undefined;
	if (typeof rec.ts !== "number" || !Number.isFinite(rec.ts)) return undefined;
	const entry: SpawnEntry = { action: rec.action, name: rec.name, ts: rec.ts };
	if (typeof rec.pane_id === "string") entry.pane_id = rec.pane_id;
	if (typeof rec.session_path === "string") entry.session_path = rec.session_path;
	if (typeof rec.session_id === "string") entry.session_id = rec.session_id;
	if (typeof rec.cwd === "string") entry.cwd = rec.cwd;
	if (typeof rec.model === "string") entry.model = rec.model;
	if (typeof rec.label === "string") entry.label = rec.label;
	if (typeof rec.group === "string") entry.group = rec.group;
	if (typeof rec.workspace_id === "string") entry.workspace_id = rec.workspace_id;
	if (typeof rec.stage === "string") entry.stage = rec.stage;
	if (typeof rec.parent_session_id === "string") entry.parent_session_id = rec.parent_session_id;
	if (typeof rec.parent_pane_id === "string") entry.parent_pane_id = rec.parent_pane_id;
	if (typeof rec.parent_name === "string") entry.parent_name = rec.parent_name;
	return entry;
}

/**
 * Fold this session's branch into the current spawn ledger: one entry per name,
 * the latest `ts` winning (a resume appends an updated entry), most-recent-first.
 */
export function readSpawnEntries(ctx: ExtensionContext): SpawnEntry[] {
	const byName = new Map<string, SpawnEntry>();
	for (const branchEntry of ctx.sessionManager.getBranch()) {
		const custom = branchEntry as unknown as { customType?: unknown; data?: unknown };
		if (custom.customType !== SPAWN_ENTRY_TYPE) continue;
		const parsed = parseSpawnEntry(custom.data);
		if (!parsed) continue;
		const prev = byName.get(parsed.name);
		if (!prev || parsed.ts >= prev.ts) byName.set(parsed.name, parsed);
	}
	return [...byName.values()].sort((a, b) => b.ts - a.ts);
}

// `Key` is a value helper from the TUI package, which the extension build does
// not externalize; the runtime value is just the canonical key-id string, so a
// tiny local helper keeps the shortcut typed without adding a bundle dependency.
function ctrlShift<K extends string>(key: K): `ctrl+shift+${K}` {
	return `ctrl+shift+${key}`;
}
const Key = { ctrlShift };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Single-quote a shell word so a session path with spaces survives `pane run`. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The registry identity backing a spawn entry, resolved by durable refs only:
 * the session transcript (id, then path), then the display name. A pane id is
 * deliberately NOT a ref: herdr recycles panes, so a live occupant of the old
 * pane must never stand in for the dormant entry.
 */
export function resolveIdentity(entry: SpawnEntry, identities: readonly AgentIdentity[]): AgentIdentity | undefined {
	if (entry.session_id) {
		const byId = identities.find((id) => id.session_id === entry.session_id);
		if (byId) return byId;
	}
	if (entry.session_path) {
		const byPath = identities.find((id) => id.session_path === entry.session_path);
		if (byPath) return byPath;
	}
	return entry.name ? findIdentity(entry.name, identities) : undefined;
}

/**
 * A worker is live only when the authoritative roster names it, or its registry
 * identity's pid is alive. Pane-set membership is intentionally ignored: panes
 * are recycled and `agent list` often omits names, so the pid is the fallback.
 */
function workerIsLive(
	entry: SpawnEntry,
	identity: AgentIdentity | undefined,
	liveAgents: { names: Set<string>; paths: Set<string> } | undefined,
): boolean {
	const file = entry.session_path ?? identity?.session_path;
	if (liveAgents && file) return liveAgents.paths.has(file);
	return (liveAgents?.names.has(entry.name) ?? false) || (identity !== undefined && isAlive(identity.pid));
}

function groupStage(entry: SpawnEntry): string | undefined {
	if (entry.group && entry.stage) return `${entry.group}/${entry.stage}`;
	return entry.group ?? entry.stage;
}

/**
 * Live agent pane ids/names from a single `herdr agent list`, or undefined when
 * the call fails. `agent list` is the authoritative liveness signal; the pid in
 * the registry cannot tell a reused pid from a still-running worker.
 */
async function fetchLiveAgents(): Promise<{ panes: Set<string>; names: Set<string>; paths: Set<string> } | undefined> {
	try {
		const { result } = await callHerdr({ args: ["agent", "list"], timeoutMs: 30000 });
		const rec = asRecord(result);
		const raw = Array.isArray(rec?.agents) ? (rec.agents as Record<string, unknown>[]) : [];
		const panes = new Set<string>();
		const names = new Set<string>();
		const paths = new Set<string>();
		for (const agent of raw) {
			const session = asString(asRecord(agent.agent_session)?.value);
			if (session) paths.add(session);
			const pane = asString(agent.pane_id);
			if (pane) panes.add(pane);
			const name = asString(agent.name);
			if (name) names.add(name);
		}
		return { panes, names, paths };
	} catch {
		return undefined;
	}
}

/**
 * This session's own registry identity. The parent link is written to the
 * registry file by the spawning orchestrator, not to this session's branch, so
 * resolve it from `readIdentities()`: session id first, then pane id, folding
 * duplicate records through `preferIdentity`.
 */
function ownIdentity(ctx: ExtensionContext, identities: readonly AgentIdentity[]): AgentIdentity | undefined {
	const sessionId = ctx.sessionManager.getSessionId();
	const pane = process.env.HERDR_PANE_ID;
	let best: AgentIdentity | undefined;
	for (const id of identities) {
		if (sessionId && id.session_id === sessionId) best = preferIdentity(best, id, sessionId);
		else if (pane && id.pane_id === pane) best = preferIdentity(best, id, sessionId);
	}
	return best;
}

interface PickerItem {
	label: string;
	entry: SpawnEntry;
	identity?: AgentIdentity;
	live: boolean;
}

export function registerNavigation(pi: ExtensionAPI): void {
	/** herdr guard: notify and return false when control is unavailable. */
	function herdrReady(ctx: ExtensionContext): boolean {
		if (process.env.HERDR_ENV === "1" && herdrAvailable()) return true;
		ctx.ui.notify(herdrUnavailableReason() || "herdr is not available", "warning");
		return false;
	}

	function notifyError(ctx: ExtensionContext, error: unknown): void {
		ctx.ui.notify(`herdr: ${message(error)}`, "error");
	}

	/**
	 * Focus a live worker. On `agent focus` failure, only fall back to the
	 * workspace of the *named* agent; never use a recorded pane id, which herdr
	 * may have recycled to an unrelated occupant.
	 */
	async function focusLive(item: PickerItem): Promise<void> {
		try {
			await callHerdr({ args: ["agent", "focus", item.entry.name], timeoutMs: 10000 });
			return;
		} catch {
			/* fall through to the named agent's workspace */
		}
		let workspace: string | undefined;
		try {
			const { result } = await callHerdr({ args: ["agent", "get", item.entry.name], timeoutMs: 10000 });
			workspace = asString(asRecord(asRecord(result)?.agent)?.workspace_id);
		} catch {
			/* the named agent is not there; do not focus a recycled pane */
		}
		if (!workspace) throw new Error(`could not focus ${item.entry.name}`);
		await callHerdr({ args: ["workspace", "focus", workspace], timeoutMs: 10000 });
	}

	/** Poll `herdr agent list` until `pane` appears, or the deadline passes. */
	async function waitForAgent(pane: string, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const live = await fetchLiveAgents();
			if (live?.panes.has(pane)) return true;
			if (Date.now() >= deadline) return false;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}

	/** Resume an explicitly selected closed worker in a full-size tab. */
	async function resumeClosed(ctx: ExtensionContext, entry: SpawnEntry): Promise<void> {
		// A bare `pi --resume` picks the most recent session, which may belong to a
		// different worker: never resume without the recorded transcript.
		if (!entry.session_path) {
			throw new Error(`cannot resume ${entry.name}: no session path recorded`);
		}
		let workspace = process.env.HERDR_WORKSPACE_ID;
		if (entry.workspace_id && entry.group) {
			const { result } = await callHerdr({ args: ["workspace", "get", entry.workspace_id], timeoutMs: 3000 }).catch(() => ({ result: undefined }));
			const tokens = asRecord(asRecord(asRecord(result)?.workspace)?.tokens);
			if (tokens?.delegate_owner === ctx.sessionManager.getSessionId()) workspace = entry.workspace_id;
		}
		if (!workspace) throw new Error("HERDR_WORKSPACE_ID is not set; cannot create a tab");
		const args = ["tab", "create", "--workspace", workspace, "--label", entry.label || entry.name, "--no-focus"];
		if (entry.cwd) args.push("--cwd", entry.cwd);
		const { result } = await callHerdr({ args, timeoutMs: 30000 });
		const placement = asRecord(result);
		const newPane = asString(asRecord(placement?.root_pane)?.pane_id);
		const tabId = asString(asRecord(placement?.tab)?.tab_id);
		if (!newPane) throw new Error("tab create returned no pane id");
		// Anything after the split can fail; close the fresh pane on any failure so
		// a rejected `pane run` cannot leak an orphaned split.
		try {
			const command = `pi ${entry.label ? "-xt herdr,delegate,delegate_result " : ""}--session ${shellQuote(entry.session_path)}`;
			await callHerdr({ args: ["pane", "run", newPane, command], timeoutMs: 30000 });
			// `pane run` only types the command and presses Enter, so confirm pi
			// actually came up before recording the pane. Otherwise a silent failure
			// would append a ledger entry that splits yet another pane on the next
			// retry.
			if (!(await waitForAgent(newPane, 15000))) {
				throw new Error(`resumed ${entry.name} did not start in ${newPane}`);
			}
			if (tabId) await callHerdr({ args: ["tab", "focus", tabId], timeoutMs: 10000 }).catch(() => {});
			// Record the new pane only now that the resume is verified.
			appendSpawnEntry(pi, { ...entry, pane_id: newPane, ts: Date.now() });
		} catch (error) {
			await callHerdr({ args: ["pane", "close", newPane], timeoutMs: 10000 }).catch(() => {});
			throw error;
		}
	}

	/** `/children` picker: list spawned agents and open the chosen one. */
	async function openChildren(ctx: ExtensionContext, scope: "live" | "offline" | "all" = "live"): Promise<void> {
		if (!herdrReady(ctx)) return;
		if (!ctx.hasUI) {
			ctx.ui.notify("children requires an interactive UI", "warning");
			return;
		}
		const entries = readSpawnEntries(ctx);
		if (entries.length === 0) {
			ctx.ui.notify("no spawned agents recorded in this session", "info");
			return;
		}
		const identities = readIdentities();
		const liveAgents = await fetchLiveAgents();
		if (!liveAgents) {
			ctx.ui.notify("Could not verify live workers in Herdr. No session was reopened.", "warning");
			return;
		}
		const items: PickerItem[] = entries.map((entry) => {
			const identity = resolveIdentity(entry, identities);
			const live = workerIsLive(entry, identity, liveAgents);
			const meta = [groupStage(entry), entry.model].filter(Boolean).join("  ");
			const label = `${live ? "●" : "○"} ${entry.label ? `${entry.label} · ` : ""}${entry.name}${meta ? `  ${meta}` : ""}  ${live ? "live" : "closed"}`;
			return { label, entry, identity, live };
		}).filter(item => scope === "all" || (scope === "live" ? item.live : !item.live));
		if (!items.length) {
			ctx.ui.notify(scope === "live" ? "No live workers. Use /children offline for closed sessions." : "No matching workers.", "info");
			return;
		}
		const byLabel = new Map<string, PickerItem>();
		for (const item of items) byLabel.set(item.label, item);
		const choice = await ctx.ui.select(
			"Spawned agents",
			items.map((item) => item.label),
		);
		if (!choice) return;
		const item = byLabel.get(choice);
		if (!item) return;
		try {
			if (item.live) {
				try {
					await focusLive(item);
				} catch (error) {
					// Re-check liveness before resuming: a transient focus failure on a
					// worker the roster still lists must not launch a second pi on the
					// same transcript. Only resume once the worker is confirmed gone.
					const fresh = await fetchLiveAgents();
					if (workerIsLive(item.entry, item.identity, fresh ?? liveAgents)) throw error;
					await resumeClosed(ctx, item.entry);
				}
			} else {
				await resumeClosed(ctx, item.entry);
			}
		} catch (error) {
			notifyError(ctx, error);
		}
	}

	/** `/parent`: focus the session that spawned this one, when recorded. */
	async function focusParent(ctx: ExtensionContext): Promise<void> {
		if (!herdrReady(ctx)) return;
		// The parent link lives on this session's registry identity (stamped by
		// the orchestrator), not in this session's own spawn ledger.
		const identities = readIdentities();
		const own = ownIdentity(ctx, identities);
		if (!own || (!own.parent_name && !own.parent_pane_id && !own.parent_session_id)) {
			ctx.ui.notify("this session has no recorded parent", "info");
			return;
		}
		// Resolve the parent's durable registry identity. A bare pane ref is only
		// safe while the parent is live and still owns that pane.
		const parent = own.parent_session_id
			? findIdentity(own.parent_session_id, identities)
			: own.parent_name
				? findIdentity(own.parent_name, identities)
				: undefined;
		const targets: string[] = [];
		// An offline parent may share its former display name with a new session.
		if (parent && isAlive(parent.pid)) targets.push(parent.name);
		if (own.parent_pane_id && parent && parent.pane_id === own.parent_pane_id && isAlive(parent.pid)) {
			targets.push(own.parent_pane_id);
		}
		if (targets.length === 0) {
			ctx.ui.notify("herdr: parent is recorded but not live", "warning");
			return;
		}
		for (const target of targets) {
			try {
				await callHerdr({ args: ["agent", "focus", target], timeoutMs: 10000 });
				return;
			} catch {
				/* try the next ref */
			}
		}
		ctx.ui.notify("herdr: could not focus parent", "error");
	}

	pi.registerCommand("children", {
		description: "Focus a live child; /children offline (or all) shows sessions to resume",
		handler: async (args, ctx) => {
			const scope = args.trim();
			await openChildren(ctx, scope === "offline" || scope === "all" ? scope : "live");
		},
	});
	pi.registerShortcut(Key.ctrlShift("a"), {
		description: "Spawned agents",
		handler: (ctx) => openChildren(ctx),
	});
	pi.registerCommand("parent", {
		description: "Focus the agent that spawned this session",
		handler: async (_args, ctx) => {
			await focusParent(ctx);
		},
	});
	pi.registerShortcut(Key.ctrlShift("p"), {
		description: "Focus parent agent",
		handler: (ctx) => focusParent(ctx),
	});
}
