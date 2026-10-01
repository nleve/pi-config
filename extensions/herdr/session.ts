/**
 * Structured results from a pi worker's session transcript.
 *
 * A pi agent records its session as newline-delimited JSON. Instead of scraping
 * terminal output, we read the last completed assistant message directly:
 *
 *   { "type": "message", "message": { "role": "assistant",
 *       "content": [ { "type": "thinking", ... }, { "type": "text", ... } ],
 *       "stopReason": "stop", "usage": { ... }, "model": ..., ... } }
 *
 * A turn is complete when the final assistant message has `stopReason: "stop"`
 * (mid-turn tool calls use `"toolUse"`).
 */

import { readFile } from "node:fs/promises";

export interface SessionResult {
	/** Concatenated assistant text blocks — the answer. */
	text: string;
	/** Concatenated reasoning/thinking blocks, if any. */
	thinking?: string;
	model?: string;
	provider?: string;
	api?: string;
	stopReason?: string;
	timestamp?: string;
	usage?: unknown;
}

interface SessionRecord {
	type?: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
		model?: string;
		provider?: string;
		api?: string;
		usage?: unknown;
	};
}

function isToolUse(stopReason: string | undefined): boolean {
	return stopReason === "toolUse" || stopReason === "tool_calls";
}

/** Parse the last completed assistant message from a session transcript. */
export function parseSessionResult(jsonl: string): SessionResult | undefined {
	const lines = jsonl.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (!line) continue;
		let rec: SessionRecord;
		try {
			rec = JSON.parse(line) as SessionRecord;
		} catch {
			continue;
		}
		if (rec?.type !== "message") continue;
		const msg = rec.message;
		if (!msg || msg.role !== "assistant") continue;
		if (isToolUse(msg.stopReason)) return undefined; // turn still in progress
		const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
		const text = content
			.filter((c) => c?.type === "text")
			.map((c) => String(c.text ?? ""))
			.join("");
		const thinking = content
			.filter((c) => c?.type === "thinking")
			.map((c) => String(c.thinking ?? ""))
			.join("");
		return {
			text,
			thinking: thinking || undefined,
			model: msg.model,
			provider: msg.provider,
			api: msg.api,
			stopReason: msg.stopReason,
			timestamp: msg.timestamp ?? rec.timestamp,
			usage: msg.usage,
		};
	}
	return undefined;
}

/** Read a pi session file and extract the last completed assistant message. */
export async function readSessionResult(sessionPath: string): Promise<SessionResult | undefined> {
	const jsonl = await readFile(sessionPath, "utf8");
	return parseSessionResult(jsonl);
}

/** Extract a pi session file path from a herdr `agent_session` ref, if any. */
export function sessionPathOf(agent: { agent_session?: unknown }): string | undefined {
	const ref = agent?.agent_session as { value?: unknown } | undefined;
	return typeof ref?.value === "string" ? ref.value : undefined;
}
