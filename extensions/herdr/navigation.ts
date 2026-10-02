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
function parseSpawnEntry(data: unknown): SpawnEntry | undefined {
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

	/** Resume a closed worker in a fresh pane split from the caller's pane. */
	async function resumeClosed(ctx: ExtensionContext, entry: SpawnEntry): Promise<void> {
		const callerPane = process.env.HERDR_PANE_ID;
		if (!callerPane) throw new Error("HERDR_PANE_ID is not set; cannot split a pane");
		const args = ["pane", "split", "--pane", callerPane, "--direction", "down"];
		if (entry.cwd) args.push("--cwd", entry.cwd);
		const { result } = await callHerdr({ args, timeoutMs: 30000 });
		const pane = asRecord(asRecord(result)?.pane);
		const newPane = asString(pane?.pane_id);
		const tabId = asString(pane?.tab_id);
		if (!newPane) throw new Error("pane split returned no pane id");
		const command = entry.session_path
			? `pi --session ${shellQuote(entry.session_path)}`
			: "pi --resume";
		await callHerdr({ args: ["pane", "run", newPane, command], timeoutMs: 30000 });
		if (tabId) await callHerdr({ args: ["tab", "focus", tabId], timeoutMs: 10000 }).catch(() => {});
		// Record the new pane so the next visit finds it live.
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
		const items: PickerItem[] = entries.map((entry) => {
			const identity = resolveIdentity(entry, identities);
			const live = identity ? isAlive(identity.pid) : false;
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
			if (item.live) await focusLive(item);
			else await resumeClosed(ctx, item.entry);
		} catch (error) {
			notifyError(ctx, error);
		}
	}

	/** `/parent`: focus the session that spawned this one, when recorded. */
	async function focusParent(ctx: ExtensionContext): Promise<void> {
		if (!herdrReady(ctx)) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const pane = process.env.HERDR_PANE_ID;
		const own = readSpawnEntries(ctx).find(
			(entry) => (sessionId && entry.session_id === sessionId) || (pane && entry.pane_id === pane),
		);
		if (!own || (!own.parent_name && !own.parent_pane_id)) {
			ctx.ui.notify("this session has no recorded parent", "info");
			return;
		}
		for (const target of [own.parent_name, own.parent_pane_id]) {
			if (!target) continue;
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
