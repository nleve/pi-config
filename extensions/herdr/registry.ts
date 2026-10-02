/**
 * Agent identity registry — durable, keyed by session id.
 *
 * Every pi running the herdr extension writes one file per *pi session* at
 * session start and refreshes it as the session runs. The file is keyed by
 * `session_id` (`session_path` as a fallback), not by pane: pane ids are
 * recycled, names are display handles, but the session transcript is the durable
 * identity. That is what lets a message be queued for an agent that is not
 * currently running, and later resumed.
 *
 * Liveness is *computed*, not encoded by deleting the file: an entry whose pid
 * is gone is "dormant" (it stays so its mailbox can be drained on restart), and
 * is only pruned once its session file is gone or it has been stale past a TTL.
 *
 * `herdr agent list` omits `name`, so this file is the source of a stable
 * handle. Because each process writes its own entry, an agent the human started
 * directly is exactly as addressable as one we spawned.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgentIdentity {
	pane_id: string;
	name: string;
	/** Durable identity: the pi session transcript path. */
	session_path?: string;
	session_id?: string;
	model?: string;
	thinking?: string;
	cwd?: string;
	/** Workflow group (shared workspace label); set by the spawning orchestrator. */
	group?: string;
	/** Stage within the group (tab label). */
	stage?: string;
	/** Parent orchestrator link; set by the agent that spawned this one. */
	parent_session_id?: string;
	parent_pane_id?: string;
	parent_name?: string;
	pid: number;
	started_at: number;
	updated_at: number;
}

const DEFAULT_DIR = path.join(os.homedir(), ".pi", "agent", "herdr-agents");
/** Dormant (pid gone) entries are kept this long so offline mail can be delivered. */
export const DORMANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Durable identity dir. Deliberately NOT the ephemeral runtime dir. */
export function identityDir(_env: NodeJS.ProcessEnv = process.env): string {
	return DEFAULT_DIR;
}

/** The canonical file key: session id, else session path, else pane id. */
function identityKey(identity: Pick<AgentIdentity, "pane_id" | "session_id" | "session_path">): string {
	return identity.session_id ?? identity.session_path ?? identity.pane_id;
}

export function identityFile(key: string, dir = identityDir()): string {
	return path.join(dir, `${key.replace(/[^\w.-]/g, "~")}.json`);
}

/** Atomic write (temp + rename) so readers never see a partial file. */
export function writeIdentity(identity: AgentIdentity, dir = identityDir()): void {
	fs.mkdirSync(dir, { recursive: true });
	const file = identityFile(identityKey(identity), dir);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(identity)}\n`);
	fs.renameSync(tmp, file);
}

export function removeIdentity(
	target: string | Pick<AgentIdentity, "pane_id" | "session_id" | "session_path">,
	dir = identityDir(),
): void {
	const key = typeof target === "string" ? target : identityKey(target);
	fs.rmSync(identityFile(key, dir), { force: true });
}

/**
 * Merge workflow `group`/`stage` into an existing identity file. The worker does
 * not know its own grouping (the orchestrator chose it), so the spawner writes
 * it here after the worker has registered. No-op (returns false) if the entry is
 * not there yet.
 */
export function setIdentityGrouping(
	target: string | Pick<AgentIdentity, "pane_id" | "session_id" | "session_path">,
	group: string | undefined,
	stage: string | undefined,
	dir = identityDir(),
): boolean {
	const key = typeof target === "string" ? target : identityKey(target);
	const file = identityFile(key, dir);
	let parsed: AgentIdentity;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8")) as AgentIdentity;
	} catch {
		return false;
	}
	if (group === undefined) delete parsed.group;
	else parsed.group = group;
	if (stage === undefined) delete parsed.stage;
	else parsed.stage = stage;
	parsed.updated_at = Date.now();
	writeIdentity(parsed, dir);
	return true;
}

/**
 * Link a child identity to the orchestrator that spawned it. `paneOrKey` is
 * resolved like `findIdentity`: pane ids fold through `preferIdentity` so a
 * recycled pane's live/current entry wins; otherwise it is treated as an
 * identity key and read directly. Only the provided parent fields are set, so
 * other identity fields are preserved. No-op (returns false) when nothing
 * matches.
 */
export function setIdentityParent(
	paneOrKey: string,
	parent: { session_id?: string; pane_id?: string; name?: string },
	dir = identityDir(),
): boolean {
	let parsed: AgentIdentity | undefined;
	for (const id of readIdentities(dir)) {
		if (id.pane_id !== paneOrKey) continue;
		parsed = preferIdentity(parsed, id);
	}
	if (!parsed) {
		try {
			parsed = JSON.parse(fs.readFileSync(identityFile(paneOrKey, dir), "utf8")) as AgentIdentity;
		} catch {
			return false;
		}
	}
	if (parent.session_id !== undefined) parsed.parent_session_id = parent.session_id;
	if (parent.pane_id !== undefined) parsed.parent_pane_id = parent.pane_id;
	if (parent.name !== undefined) parsed.parent_name = parent.name;
	parsed.updated_at = Date.now();
	writeIdentity(parsed, dir);
	return true;
}

export function readIdentities(dir = identityDir()): AgentIdentity[] {
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: AgentIdentity[] = [];
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AgentIdentity;
			if (parsed && typeof parsed.pane_id === "string" && typeof parsed.name === "string") out.push(parsed);
		} catch {
			/* skip malformed / partially written */
		}
	}
	return out;
}

/** True when the owning pid is still alive (same host; cross-machine is a non-goal). */
export function isAlive(pid: number): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function isDormant(identity: AgentIdentity): boolean {
	return !isAlive(identity.pid);
}

/**
 * Remove entries that cannot be resumed: pid gone AND no session transcript to
 * resume, or dormant past the TTL. Returns the count removed.
 */
export function pruneDeadIdentities(dir = identityDir(), ttlMs: number = DORMANT_TTL_MS): number {
	let removed = 0;
	for (const id of readIdentities(dir)) {
		if (isAlive(id.pid)) continue;
		const resumable = typeof id.session_path === "string" && fs.existsSync(id.session_path);
		const stale = Date.now() - (id.updated_at || 0) > ttlMs;
		if (!resumable || stale) {
			removeIdentity(id, dir);
			removed++;
		}
	}
	return removed;
}

/**
 * Deterministically pick the preferred registry entry when several share a key
 * (e.g. a recycled pane still holds a dormant entry for the old session).
 * Preference order: the entry whose `session_id` matches `sessionId` (the live
 * record, when known), then a live pid over a dormant one, then the most
 * recently updated. The session key breaks remaining ties so the result does
 * not depend on the order entries are read from disk.
 */
export function preferIdentity(prev: AgentIdentity | undefined, next: AgentIdentity, sessionId?: string): AgentIdentity {
	if (!prev) return next;
	if (sessionId) {
		const prevMatch = prev.session_id === sessionId;
		const nextMatch = next.session_id === sessionId;
		if (prevMatch !== nextMatch) return nextMatch ? next : prev;
	}
	const prevAlive = !isDormant(prev);
	const nextAlive = !isDormant(next);
	if (prevAlive !== nextAlive) return nextAlive ? next : prev;
	const prevUpdated = prev.updated_at || 0;
	const nextUpdated = next.updated_at || 0;
	if (prevUpdated !== nextUpdated) return nextUpdated > prevUpdated ? next : prev;
	return identityKey(next) < identityKey(prev) ? next : prev;
}

/**
 * Remove stale entries left behind when a pane was recycled: several identities
 * share one `pane_id` but have different session keys. Keeps the preferred
 * live/current entry (see `preferIdentity`) and removes the rest. Callers opt
 * into this; it can drop offline mail for the stale session. Returns the count
 * removed.
 */
export function pruneRecycledIdentities(dir = identityDir()): number {
	const byPane = new Map<string, AgentIdentity[]>();
	for (const id of readIdentities(dir)) {
		const group = byPane.get(id.pane_id);
		if (group) group.push(id);
		else byPane.set(id.pane_id, [id]);
	}
	let removed = 0;
	for (const group of byPane.values()) {
		if (new Set(group.map(identityKey)).size < 2) continue;
		let keep: AgentIdentity | undefined;
		for (const id of group) keep = preferIdentity(keep, id);
		for (const id of group) {
			if (id === keep) continue;
			removeIdentity(id, dir);
			removed++;
		}
	}
	return removed;
}

/** Name index; duplicate names resolve to the live/current entry, deterministically. */
export function identityByName(identities: readonly AgentIdentity[]): Map<string, AgentIdentity> {
	const map = new Map<string, AgentIdentity>();
	for (const id of identities) map.set(id.name, preferIdentity(map.get(id.name), id));
	return map;
}

export function identityBySession(identities: readonly AgentIdentity[]): Map<string, AgentIdentity> {
	const map = new Map<string, AgentIdentity>();
	for (const id of identities) if (id.session_id && !map.has(id.session_id)) map.set(id.session_id, id);
	return map;
}

/** Resolve a name (with or without the `^^` prefix), session id, or pane id. */
export function findIdentity(ref: string, identities: readonly AgentIdentity[]): AgentIdentity | undefined {
	const key = ref.startsWith("^^") ? ref.slice(2) : ref;
	const named = identityByName(identities).get(key);
	if (named) return named;
	// A recycled pane/session can have several entries; fold through preferIdentity
	// so the live/current one wins regardless of readdir order.
	let best: AgentIdentity | undefined;
	for (const id of identities) if (id.session_id === key) best = preferIdentity(best, id);
	if (best) return best;
	for (const id of identities) if (id.pane_id === key) best = preferIdentity(best, id);
	return best;
}

/** `^^name` or a bare registered name → pane id. */
export function resolvePaneRef(ref: string, identities: readonly AgentIdentity[]): string | undefined {
	return findIdentity(ref, identities)?.pane_id;
}

/**
 * Join herdr agent/pane rows with registry identities: expose `name`, `model`,
 * `session_id`, and `session_path` without clobbering a `name` herdr already
 * provides (e.g. a spawned worker named via `agent start`).
 */
export function withIdentities<T extends Record<string, unknown>>(
	records: readonly T[],
	identities: readonly AgentIdentity[],
): T[] {
	const byPane = new Map<string, AgentIdentity[]>();
	for (const id of identities) {
		const group = byPane.get(id.pane_id);
		if (group) group.push(id);
		else byPane.set(id.pane_id, [id]);
	}
	return records.map((r) => {
		const pane = typeof r.pane_id === "string" ? r.pane_id : undefined;
		const sessionId = typeof r.session_id === "string" ? r.session_id : undefined;
		let id: AgentIdentity | undefined;
		const candidates = pane ? byPane.get(pane) : undefined;
		if (candidates) for (const candidate of candidates) id = preferIdentity(id, candidate, sessionId);
		if (!id) return r;
		return {
			...r,
			name: (typeof r.name === "string" && r.name) || id.name,
			model: r.model ?? id.model,
			session_id: r.session_id ?? id.session_id,
			session_path: r.session_path ?? id.session_path,
			group: r.group ?? id.group,
			stage: r.stage ?? id.stage,
		} as T;
	});
}
