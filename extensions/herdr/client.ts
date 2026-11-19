/**
 * Low-level herdr CLI client.
 *
 * Every herdr control command returns a JSON envelope on stdout:
 *   { "id": "cli:...", "result": { ... } }
 * or, on failure:
 *   { "id": "cli:...", "error": { "code": "...", "message": "..." } }
 *
 * We surface `result` and turn `error` / non-zero exit into thrown Errors so
 * tool callers see a real failure instead of a JSON blob they must decode.
 */

import { spawn } from "node:child_process";

export const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";

/** How long to wait after SIGTERM before escalating an aborted run to SIGKILL. */
const ABORT_KILL_GRACE_MS = 2000;

export interface HerdrRun {
	stdout: string;
	stderr: string;
	code: number;
}

export function herdrAvailable(): boolean {
	return process.env.HERDR_ENV === "1";
}

export function herdrUnavailableReason(): string {
	if (process.env.HERDR_ENV === "1") return "";
	return "Not running inside herdr (HERDR_ENV != 1). Start pi in a herdr pane to use this tool.";
}

/** Run the herdr CLI and capture output. Rejects only on spawn failure/timeout/abort. */
export function runHerdr(args: string[], signal?: AbortSignal, timeoutMs = 120000): Promise<HerdrRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(HERDR_BIN, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let aborted = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => {
			if (settled || aborted) return;
			aborted = true;
			child.kill("SIGTERM");
			// Escalate if the CLI ignores SIGTERM. The promise settles only once the
			// child actually exits (the `close` handler below), so callers never
			// race a still-running process.
			killTimer = setTimeout(() => child.kill("SIGKILL"), ABORT_KILL_GRACE_MS);
			killTimer.unref?.();
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => reject(new Error(`herdr ${args.join(" ")} timed out after ${timeoutMs}ms`)));
		}, timeoutMs);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", (err) => finish(() => reject(err)));
		child.on("close", (code) => {
			if (aborted) {
				finish(() => reject(new Error("aborted")));
				return;
			}
			finish(() => resolve({ stdout, stderr, code: code ?? 0 }));
		});
	});
}

interface Envelope {
	result?: unknown;
	error?: { code?: string; message?: string } | string;
}

/** Parse a herdr envelope, unwrap `result`, and throw on `error`. */
export function unwrapHerdr(stdout: string): unknown {
	const trimmed = stdout.trim();
	if (!trimmed) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return trimmed; // not JSON; return raw text
	}
	if (parsed && typeof parsed === "object") {
		const env = parsed as Envelope;
		if (env.error !== undefined) {
			const err = env.error;
			const message =
				typeof err === "string" ? err : err?.message || err?.code || JSON.stringify(err);
			throw new Error(`herdr error: ${message}`);
		}
		if ("result" in env) return env.result;
	}
	return parsed;
}

export class HerdrCommandError extends Error {
	constructor(message: string, readonly code?: string) { super(message); }
}

export interface HerdrCall {
	args: string[];
	timeoutMs?: number;
}

/** Run a herdr command and return its unwrapped result plus the raw run. */
export async function callHerdr(
	call: HerdrCall,
	signal?: AbortSignal,
): Promise<{ result: unknown; run: HerdrRun }> {
	const run = await runHerdr(call.args, signal, call.timeoutMs);
	const combined = [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join("\n");
	if (run.code !== 0) {
		for (const stream of [run.stdout, run.stderr]) {
			let response: Envelope | undefined;
			try { response = JSON.parse(stream.trim()) as Envelope; } catch { continue; }
			const error = response?.error;
			if (error && typeof error === "object") throw new HerdrCommandError(error.message || error.code || "Herdr rejected the request.", error.code);
			if (typeof error === "string") throw new HerdrCommandError(error);
		}
		throw new HerdrCommandError(`herdr ${call.args.slice(0, 2).join(" ")} exited ${run.code}:\n${combined || "(no output)"}`);
	}
	return { result: unwrapHerdr(run.stdout), run };
}

/** Render a herdr result for the model: JSON pretty-printed, else raw text. */
export function renderHerdrResult(result: unknown): string {
	if (result === undefined) return "(no output)";
	if (typeof result === "string") return result;
	try {
		return JSON.stringify(result, null, 2);
	} catch {
		return String(result);
	}
}
