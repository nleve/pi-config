/**
 * herdr socket API client (event-driven waits).
 *
 * The herdr CLI exposes only a subset of the socket API. Two things we need are
 * socket-only:
 *   - `agent.get`        — read live agent state, incl. `state_change_seq`
 *   - `events.wait`      — block until an agent reaches a status (no polling)
 *
 * Protocol: connect to `HERDR_SOCKET_PATH`, write one JSON request per line
 * (`{ id, method, params }`), read one JSON response line (`{ id, result }` or
 * `{ id, error }`). This mirrors herdr's own pi integration
 * (`herdr-agent-state.ts`), which we must not edit.
 *
 * Note: `events.wait` is **level-triggered** — it returns immediately if the
 * condition already holds. Callers must baseline state (`state_change_seq`)
 * when they need an edge (see `waitForTurnSettled`).
 */

import net from "node:net";

export function herdrSocketPath(): string | undefined {
	const p = process.env.HERDR_SOCKET_PATH;
	if (!p) return undefined;
	return process.platform === "win32" ? `\\\\.\\pipe\\${p}` : p;
}

export interface HerdrApiOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

interface ApiEnvelope {
	result?: unknown;
	error?: { code?: string; message?: string } | string;
}

/** Agent statuses reported by herdr; `blocked` means the agent awaits input. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "dormant" | "unknown";

/** Call one herdr socket API method and return its unwrapped `result`. */
export function herdrApi<T = unknown>(
	method: string,
	params: unknown,
	opts: HerdrApiOptions = {},
): Promise<T> {
	const socketPath = herdrSocketPath();
	if (!socketPath) {
		return Promise.reject(new Error("herdr: HERDR_SOCKET_PATH is not set"));
	}
	const { timeoutMs = 30000, signal } = opts;
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let buf = "";
		const socket = net.createConnection(socketPath);
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			socket.destroy();
			fn();
		};
		const onAbort = () => finish(() => reject(new Error("aborted")));
		const timer = setTimeout(
			() => finish(() => reject(new Error(`herdr api ${method} timed out after ${timeoutMs}ms`))),
			timeoutMs,
		);
		timer.unref?.();
		signal?.addEventListener("abort", onAbort, { once: true });
		socket.on("connect", () =>
			socket.write(`${JSON.stringify({ id: `ext:${method}:${Date.now()}`, method, params })}\n`),
		);
		socket.on("data", (d) => {
			buf += d.toString();
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			const line = buf.slice(0, nl);
			let parsed: ApiEnvelope;
			try {
				parsed = JSON.parse(line) as ApiEnvelope;
			} catch {
				finish(() => reject(new Error(`herdr api ${method}: bad response: ${line}`)));
				return;
			}
			if (parsed && typeof parsed === "object" && parsed.error !== undefined) {
				const err = parsed.error;
				const message =
					typeof err === "string" ? err : err?.message || err?.code || JSON.stringify(err);
				finish(() => reject(new Error(`herdr api ${method}: ${message}`)));
				return;
			}
			finish(() => resolve((parsed?.result ?? parsed) as T));
		});
		socket.on("error", (err) => finish(() => reject(err)));
		socket.on("end", () => finish(() => reject(new Error(`herdr api ${method}: connection closed`))));
	});
}

export interface AgentInfo {
	pane_id: string;
	name?: string;
	agent?: string;
	agent_status?: string;
	state_change_seq?: number;
	workspace_id?: string;
	tab_id?: string;
	agent_session?: { value?: string; [k: string]: unknown };
	[k: string]: unknown;
}

/** `agent.get` over the socket. */
export async function getAgent(target: string, opts: HerdrApiOptions = {}): Promise<AgentInfo> {
	const res = await herdrApi<{ type?: string; agent?: AgentInfo }>(
		"agent.get",
		{ target },
		{ timeoutMs: 15000, ...opts },
	);
	const agent = res?.agent ?? (res as unknown as AgentInfo);
	if (!agent || typeof agent !== "object" || typeof agent.pane_id !== "string") {
		throw new Error(`herdr agent.get returned no agent for ${target}`);
	}
	return agent;
}

/**
 * Block until `target` reaches any of `statuses`. Returns false on timeout,
 * throws on other errors. Level-triggered: returns true if already there.
 * Uses the socket `agent.wait` API, which accepts several target statuses.
 */
export async function waitForAgentStatuses(
	target: string,
	statuses: AgentStatus[],
	opts: HerdrApiOptions = {},
): Promise<boolean> {
	const timeoutMs = opts.timeoutMs ?? 120000;
	try {
		await herdrApi(
			"agent.wait",
			{ target, until: statuses, timeout_ms: timeoutMs },
			{ timeoutMs: timeoutMs + 5000, signal: opts.signal },
		);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/timed out|timeout/i.test(message)) return false;
		throw error;
	}
}

/**
 * herdr reports a completed turn as either `idle` or `done` depending on how it
 * detects the agent (`agent explain` says `idle` while `agent get` may say
 * `done`), so both count as settled.
 */
const SETTLED_STATUSES: AgentStatus[] = ["idle", "done"];

/**
 * Thrown when a target is (or becomes) `blocked` while waiting for it to settle.
 * A blocked agent waits on input and will not settle on its own, so spinning
 * the full timeout is useless; callers should surface this promptly.
 */
export class HerdrBlockedError extends Error {
	readonly paneId: string;
	readonly status = "blocked";

	constructor(paneId: string) {
		super(
			`herdr: ${paneId} is blocked waiting for input and will not settle on its own; ` +
				"unblock or prompt it, then retry",
		);
		this.name = "HerdrBlockedError";
		this.paneId = paneId;
	}
}

function isSettled(status: string | undefined): boolean {
	return status === "idle" || status === "done";
}

export interface SettleOptions extends HerdrApiOptions {
	/** Require `state_change_seq` to advance past this value before settling. */
	sinceSeq?: number;
}

/**
 * Event-driven "turn settled" wait: the agent is `idle` *and*, when `sinceSeq`
 * is given, its `state_change_seq` has advanced past the baseline captured
 * before the prompt. This fixes the level-triggered race where a freshly
 * prompted agent is still `idle` for a beat.
 */
export async function waitForTurnSettled(
	target: string,
	opts: SettleOptions = {},
): Promise<AgentInfo> {
	const { sinceSeq, timeoutMs = 120000, signal } = opts;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (signal?.aborted) throw new Error("aborted");
		const info = await getAgent(target, { timeoutMs: 15000, signal });
		if (info.agent_status === "blocked") throw new HerdrBlockedError(info.pane_id);
		const seq = typeof info.state_change_seq === "number" ? info.state_change_seq : undefined;
		const settled = isSettled(info.agent_status);
		const advanced = sinceSeq === undefined || (seq !== undefined && seq > sinceSeq);
		if (settled && advanced) return info;
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`herdr: timed out after ${timeoutMs}ms waiting for ${target} to settle (status=${info.agent_status ?? "?"})`,
			);
		}
		// If already settled but the baseline has not advanced, the prompt has not
		// been picked up yet — block until it starts working. Otherwise block until
		// it finishes (idle or done).
		const step = Math.min(remaining, settled ? 5000 : remaining);
		// Include `blocked` in the wait set so a worker that stalls on input wakes
		// the wait immediately; the next `getAgent` then throws `HerdrBlockedError`
		// instead of blocking until the timeout.
		await waitForAgentStatuses(
			info.pane_id,
			settled ? ["working", "blocked"] : [...SETTLED_STATUSES, "blocked"],
			{ timeoutMs: step, signal },
		);
	}
}
