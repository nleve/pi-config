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
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			fn();
		};
		const onAbort = () => {
			child.kill("SIGTERM");
			finish(() => reject(new Error("aborted")));
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => reject(new Error(`herdr ${args.join(" ")} timed out after ${timeoutMs}ms`)));
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("error", (err) => finish(() => reject(err)));
		child.on("close", (code) => finish(() => resolve({ stdout, stderr, code: code ?? 0 })));
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
		// herdr writes an error envelope to stdout on API failures (exit != 0),
		// so try to unwrap a useful message before falling back to raw output.
		try {
			unwrapHerdr(run.stdout);
		} catch (error) {
			throw new Error(error instanceof Error ? error.message : String(error));
		}
		throw new Error(`herdr ${call.args.join(" ")} exited ${run.code}:\n${combined || "(no output)"}`);
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
