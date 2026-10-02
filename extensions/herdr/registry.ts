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

/** First-wins name index. */
export function identityByName(identities: readonly AgentIdentity[]): Map<string, AgentIdentity> {
	const map = new Map<string, AgentIdentity>();
	for (const id of identities) if (!map.has(id.name)) map.set(id.name, id);
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
	for (const id of identities) if (id.name === key) return id;
	for (const id of identities) if (id.session_id === key) return id;
	for (const id of identities) if (id.pane_id === key) return id;
	return undefined;
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
	const byPane = new Map(identities.map((i) => [i.pane_id, i]));
	return records.map((r) => {
		const pane = typeof r.pane_id === "string" ? r.pane_id : undefined;
		const id = pane ? byPane.get(pane) : undefined;
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
