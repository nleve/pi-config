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
	pane_id?: string;
	session_path?: string;
	session_id?: string;
	cwd?: string;
	model?: string;
	group?: string;
	stage?: string;
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
	if (typeof rec.group === "string") entry.group = rec.group;
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

/** The registry identity backing a spawn entry, folding name/pane/session refs. */
function resolveIdentity(entry: SpawnEntry, identities: readonly AgentIdentity[]): AgentIdentity | undefined {
	let best: AgentIdentity | undefined;
	for (const ref of [entry.session_id, entry.pane_id, entry.name]) {
		if (!ref) continue;
		const found = findIdentity(ref, identities);
		if (found) best = preferIdentity(best, found, entry.session_id);
	}
	return best;
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
async function fetchLiveAgents(): Promise<{ panes: Set<string>; names: Set<string> } | undefined> {
	try {
		const { result } = await callHerdr({ args: ["agent", "list"], timeoutMs: 30000 });
		const rec = asRecord(result);
		const raw = Array.isArray(rec?.agents) ? (rec.agents as Record<string, unknown>[]) : [];
		const panes = new Set<string>();
		const names = new Set<string>();
		for (const agent of raw) {
			const pane = asString(agent.pane_id);
			if (pane) panes.add(pane);
			const name = asString(agent.name);
			if (name) names.add(name);
		}
		return { panes, names };
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

	/** Focus a live worker, falling back to focusing its pane's workspace. */
	async function focusLive(item: PickerItem): Promise<void> {
		try {
			await callHerdr({ args: ["agent", "focus", item.entry.name], timeoutMs: 10000 });
			return;
		} catch {
			/* fall through to the workspace fallback */
		}
		const pane = item.identity?.pane_id ?? item.entry.pane_id;
		let workspace: string | undefined;
		if (pane) {
			try {
				const { result } = await callHerdr({ args: ["pane", "get", pane], timeoutMs: 10000 });
				workspace = asString(asRecord(asRecord(result)?.pane)?.workspace_id);
			} catch {
				/* no pane info; try the agent record below */
			}
		}
		if (!workspace) {
			try {
				const { result } = await callHerdr({ args: ["agent", "get", item.entry.name], timeoutMs: 10000 });
				workspace = asString(asRecord(asRecord(result)?.agent)?.workspace_id);
			} catch {
				/* give up below */
			}
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

	/** Resume a closed worker in a fresh pane split from the caller's pane. */
	async function resumeClosed(ctx: ExtensionContext, entry: SpawnEntry): Promise<void> {
		// A bare `pi --resume` picks the most recent session, which may belong to a
		// different worker: never resume without the recorded transcript.
		if (!entry.session_path) {
			throw new Error(`cannot resume ${entry.name}: no session path recorded`);
		}
		const callerPane = process.env.HERDR_PANE_ID;
		if (!callerPane) throw new Error("HERDR_PANE_ID is not set; cannot split a pane");
		const args = ["pane", "split", "--pane", callerPane, "--direction", "down"];
		if (entry.cwd) args.push("--cwd", entry.cwd);
		const { result } = await callHerdr({ args, timeoutMs: 30000 });
		const pane = asRecord(asRecord(result)?.pane);
		const newPane = asString(pane?.pane_id);
		const tabId = asString(pane?.tab_id);
		if (!newPane) throw new Error("pane split returned no pane id");
		const command = `pi --session ${shellQuote(entry.session_path)}`;
		await callHerdr({ args: ["pane", "run", newPane, command], timeoutMs: 30000 });
		// `pane run` only types the command and presses Enter, so confirm pi
		// actually came up before recording the pane. Otherwise a silent failure
		// would leak the split and append a ledger entry that splits yet another
		// pane on the next retry.
		if (!(await waitForAgent(newPane, 15000))) {
			await callHerdr({ args: ["pane", "close", newPane], timeoutMs: 10000 }).catch(() => {});
			throw new Error(`resumed ${entry.name} did not start in ${newPane}; closed the pane`);
		}
		if (tabId) await callHerdr({ args: ["tab", "focus", tabId], timeoutMs: 10000 }).catch(() => {});
		// Record the new pane only now that the resume is verified.
		appendSpawnEntry(pi, { ...entry, pane_id: newPane, ts: Date.now() });
	}

	/** `/children` picker: list spawned agents and open the chosen one. */
	async function openChildren(ctx: ExtensionContext): Promise<void> {
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
		const items: PickerItem[] = entries.map((entry) => {
			const identity = resolveIdentity(entry, identities);
			const pane = identity?.pane_id ?? entry.pane_id;
			// Prefer the live roster; only trust the pid when `agent list` failed.
			const live = liveAgents
				? (pane !== undefined && liveAgents.panes.has(pane)) || liveAgents.names.has(entry.name)
				: identity
					? isAlive(identity.pid)
					: false;
			const meta = [groupStage(entry), entry.model].filter(Boolean).join("  ");
			const label = `${live ? "●" : "○"} ${entry.name}${meta ? `  ${meta}` : ""}  ${live ? "live" : "closed"}`;
			return { label, entry, identity, live };
		});
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
				} catch {
					// Liveness can be stale (recycled pid); a failed focus means the
					// worker is really gone, so offer the resume path instead.
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
		const targets: string[] = [];
		if (own.parent_name) targets.push(own.parent_name);
		if (own.parent_pane_id) targets.push(own.parent_pane_id);
		if (targets.length === 0 && own.parent_session_id) {
			// Only the durable session id was stamped; resolve it to a live handle.
			const parent = findIdentity(own.parent_session_id, identities);
			if (parent?.name) targets.push(parent.name);
			if (parent?.pane_id) targets.push(parent.pane_id);
		}
		if (targets.length === 0) {
			ctx.ui.notify("herdr: parent session is recorded but not registered", "warning");
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
		description: "Focus or resume an agent spawned from this session",
		handler: async (_args, ctx) => {
			await openChildren(ctx);
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
