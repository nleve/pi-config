import { readFile, stat } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import type { AgentInfo } from "./socket.ts";

export const ASSIGNMENT_ENTRY = "herdr_assignment";
export const RUN_ENTRY = "herdr_delegate_workspace";
export const RESULT_ENTRY = "herdr_assignment_result";
export const DEFAULT_WAIT_MS = 30_000;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

export interface Assignment {
	ticket: string;
	name: string;
	label: string;
	pane: string;
	workspace: string;
	tab: string;
	sessionPath: string;
	sessionId?: string;
	run?: string;
	model?: string;
}

export type Attribution =
	| { status: "queued" | "running" }
	| { status: "completed"; answer: string; model?: string; provider?: string; usage?: unknown }
	| { status: "failed" | "result_unavailable" | "attempt_failed"; reason: string };
export type Collection = Attribution | { status: "offline" | "blocked" | "submission_unknown"; reason: string };

type RecordRow = {
	type?: string;
	id?: string;
	parentId?: string | null;
	targetId?: string;
	replacement?: { content: unknown } | null;
	message?: { role?: string; content?: unknown; stopReason?: string; model?: string; provider?: string; usage?: unknown; errorMessage?: string };
};

export function assignmentMarker(ticket: string): string {
	return `<!-- herdr:assignment ${ticket} -->`;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("");
}

/** Follow the unique descendant path of the exact user entry, not newest assistant text. */
export function attributeAnswer(jsonl: string, ticket: string, sessionId?: string): Attribution {
	const rows: RecordRow[] = [];
	const lines = jsonl.split("\n");
	for (const [i, line] of lines.entries()) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line);
			if (value && typeof value === "object") rows.push(value);
		} catch {
			if (i !== lines.length - 1) return { status: "result_unavailable", reason: "Malformed session transcript." };
		}
	}
	const header = rows[0];
	if (sessionId && (header?.type !== "session" || header.id !== sessionId)) {
		return { status: "result_unavailable", reason: "Session identity does not match the ticket." };
	}
	const marker = assignmentMarker(ticket);
	const anchors = rows.filter(row => row.type === "message" && row.message?.role === "user" && messageText(row.message.content).startsWith(marker + "\n"));
	if (anchors.length === 0) return { status: "queued" };
	if (anchors.length !== 1 || !anchors[0]?.id) return { status: "result_unavailable", reason: "Assignment anchor is ambiguous." };

	// This is the worker's first assignment. If a person or IRC already
	// started a turn, submission can enter that turn as steering and its
	// eventual final message must not be attributed to this assignment.
	const anchor = anchors[0];
	const inputBefore = rows.slice(0, rows.indexOf(anchor)).some(row => row.type === "custom_message" ||
		(row.type === "message" && ["user", "custom", "bashExecution"].includes(row.message?.role ?? "")));
	if (inputBefore) return { status: "result_unavailable", reason: "A different input reached the worker before the assignment." };

	const children = new Map<string, RecordRow[]>();
	for (const row of rows) {
		if (!row.id || !row.parentId) continue;
		const peers = children.get(row.parentId);
		if (peers) peers.push(row);
		else children.set(row.parentId, [row]);
	}
	const visited = new Set<string>();
	let id = anchors[0].id;
	let failed: { id: string; reason: string } | undefined;
	while (!visited.has(id)) {
		visited.add(id);
		const peers = children.get(id) ?? [];
		if (!peers.length) return failed ? { status: "attempt_failed", reason: failed.reason } : { status: "running" };
		if (peers.length !== 1) break;
		const row = peers[0]!;
		const msg = row.message;
		if (row.type === "custom_message" || row.type === "branch_summary" || row.type === "compaction" ||
			(row.type === "message" && ["user", "custom", "bashExecution", "branchSummary", "compactionSummary"].includes(msg?.role ?? ""))) {
			return { status: "result_unavailable", reason: "Another input or context rewrite intervened before the answer." };
		}
		if (row.type === "context_edit") {
			if (row.targetId === failed?.id && row.replacement === null) failed = undefined;
			else if (row.targetId && visited.has(row.targetId)) {
				return { status: "result_unavailable", reason: "The assignment or one of its contributing entries was edited before the answer." };
			}
		}
		if (row.type === "message" && msg?.role === "assistant") {
			if (failed) return { status: "result_unavailable", reason: "A failed attempt was followed by another response without a recorded recovery." };
			if (msg.stopReason === "stop") {
				return { status: "completed", answer: messageText(msg.content), model: msg.model, provider: msg.provider, usage: msg.usage };
			}
			if (msg.stopReason !== "toolUse" && msg.stopReason !== "tool_calls") {
				failed = { id: row.id!, reason: msg.errorMessage || `The worker ended with ${msg.stopReason || "no completion status"}.` };
			}
		}
		id = row.id!;
	}
	return { status: "result_unavailable", reason: "Transcript branches before the answer; attribution is ambiguous." };
}

export async function collectAssignment(
	assignment: Assignment,
	lookup: (a: Assignment, signal?: AbortSignal) => Promise<AgentInfo | undefined>,
	waitMs: number,
	signal?: AbortSignal,
	submissionUnknown = false,
): Promise<Collection & { waitTimedOut?: true }> {
	const deadline = Date.now() + waitMs;
	let version: string | undefined;
	let attribution: Attribution = { status: "queued" };
	let live: AgentInfo | undefined;
	let lookupFailed = false;
	let nextLookup = 0;
	for (;;) {
		signal?.throwIfAborted();
		try {
			const info = await stat(assignment.sessionPath);
			if (info.size > MAX_TRANSCRIPT_BYTES) return { status: "result_unavailable", reason: "Worker transcript exceeds the collection limit." };
			const stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
			if (stamp !== version) {
				attribution = attributeAnswer(await readFile(assignment.sessionPath, "utf8"), assignment.ticket, assignment.sessionId);
				version = stamp;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { status: "result_unavailable", reason: "Worker transcript could not be read." };
			attribution = { status: "queued" };
			version = undefined;
		}
		if (attribution.status !== "queued" && attribution.status !== "running" && attribution.status !== "attempt_failed") return attribution;
		if (Date.now() >= nextLookup) {
			try {
				live = await lookup(assignment, signal);
				lookupFailed = false;
			} catch {
				signal?.throwIfAborted();
				lookupFailed = true;
			}
			nextLookup = Date.now() + 1000;
		}
		if (attribution.status === "attempt_failed" && !lookupFailed && (!live || ["idle", "done"].includes(live.agent_status ?? ""))) {
			return { status: "failed", reason: attribution.reason };
		}
		if (!lookupFailed && !live) return { status: "offline", reason: "Worker is not live and this assignment has no attributable answer yet." };
		if (!lookupFailed && live?.agent_status === "blocked") return { status: "blocked", reason: "Worker needs attention in Herdr." };
		if (submissionUnknown && attribution.status === "queued") {
			return { status: "submission_unknown", reason: "Could not confirm the prompt was accepted. Inspect the worker or collect this ticket again; do not blindly resend." };
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) return { status: attribution.status === "attempt_failed" ? "running" : attribution.status, ...(waitMs > 0 ? { waitTimedOut: true } : {}) };
		await pause(Math.min(250, remaining), undefined, { signal });
	}
}
