import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assignmentMarker, attributeAnswer, collectAssignment, type Assignment } from "../assignment.ts";
import { delegateHandle, delegateLabel } from "../delegate-tool.ts";

const ticket = "1e9412f0-1e8f-404e-9a30-b69e940f4ea6";
const user = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id: string, parentId: string, stopReason: string, text = "") => ({ type: "message", id, parentId, message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });
const header = { type: "session", id: "my-worker" };
const anchor = user("anchor", null, `${assignmentMarker(ticket)}\nReview the retry logic.`);
const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

test("collects the anchored final answer through tool calls, not later follow-ups", () => {
	const chain = lines(header, anchor, assistant("tool", "anchor", "toolUse"),
		{ type: "message", id: "tool-result", parentId: "tool", message: { role: "toolResult" } },
		assistant("answer", "tool-result", "stop", "Retry once."),
		user("followup", "answer", "What time is it?"), assistant("newer", "followup", "stop", "12:15"));
	expect(attributeAnswer(chain, ticket, "my-worker")).toMatchObject({ status: "completed", answer: "Retry once." });
	expect(attributeAnswer(chain, ticket, "different-worker").status).toBe("result_unavailable");
	expect(attributeAnswer(chain, "unrelated", "my-worker").status).toBe("queued");
});

test("fails closed on competing inputs, uncertain branches and malformed complete rows", () => {
	const error = (jsonl: string) => expect(attributeAnswer(jsonl, ticket).status).toBe("result_unavailable");
	error(lines(header, anchor, user("new", "anchor", "Ignore the first task."), assistant("answer", "new", "stop", "Wrong turn.")));
	error(lines(header, anchor, { type: "custom_message", id: "mail", parentId: "anchor" }, assistant("answer", "mail", "stop", "IRC reply.")));
	error(lines(header, user("human", null, "Human started work first."),
		{ ...anchor, parentId: "human" }, assistant("answer", "anchor", "stop", "Not necessarily the delegation.")));
	error(lines(header, anchor, assistant("first", "anchor", "stop"), assistant("fork", "anchor", "stop")));
	error(lines(header, anchor, { ...anchor, id: "other" }));
	error(lines(header, anchor) + "{\n");
	expect(attributeAnswer(lines(header, anchor) + "{", ticket).status).toBe("running");
	expect(attributeAnswer(lines(header, anchor, assistant("e", "anchor", "error")), ticket).status).toBe("attempt_failed");
});

test("Pi retry edits can omit a failed attempt, but cannot replace the task", () => {
	const failed = assistant("failed", "anchor", "error");
	const recovered = { type: "context_edit", id: "edit", parentId: "failed", targetId: "failed", replacement: null };
	const answer = assistant("answer", "edit", "stop", "Recovered.");
	expect(attributeAnswer(lines(header, anchor, failed, recovered, answer), ticket)).toMatchObject({ status: "completed", answer: "Recovered." });
	const changed = { ...recovered, parentId: "anchor", targetId: "anchor", replacement: { content: "a different task" } };
	expect(attributeAnswer(lines(header, anchor, changed, answer), ticket).status).toBe("result_unavailable");
});

test("collection reports blocked, offline, and uncertain submission without fabricating answers", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "herdr-assignment-"));
	try {
		const sessionPath = path.join(root, "session.jsonl");
		const assignment: Assignment = { ticket, name: "retry", label: "Retry logic", pane: "w1:p1", workspace: "w1", tab: "w1:t1", sessionPath, sessionId: "my-worker" };
		await writeFile(sessionPath, lines(header));
		expect((await collectAssignment(assignment, async () => ({ pane_id: "w1:p1", agent_status: "idle" }), 0, undefined, true)).status).toBe("submission_unknown");
		await writeFile(sessionPath, lines(header, anchor));
		expect((await collectAssignment(assignment, async () => undefined, 0)).status).toBe("offline");
		expect((await collectAssignment(assignment, async () => ({ pane_id: "w1:p1", agent_status: "blocked" }), 0)).status).toBe("blocked");
		expect(await collectAssignment(assignment, async () => ({ pane_id: "w1:p1", agent_status: "working" }), 5)).toEqual({ status: "running", waitTimedOut: true });
	} finally {
		await rm(root, { recursive: true });
	}
});

test("task names are readable, collision-safe and within Herdr's 32-character limit", () => {
	expect(delegateLabel(" Rate\n\tlimits\x1b")).toBe("Rate limits");
	expect(delegateHandle("Rate limits", "Auth", new Set())).toBe("auth-rate-limits");
	expect(delegateHandle("Rate limits", "Auth", new Set(["auth-rate-limits", "auth-rate-limits-2"]))).toBe("auth-rate-limits-3");
	const long = "Super-long distinguishing words for a worker";
	const first = delegateHandle(long, undefined, new Set());
	const second = delegateHandle(long, undefined, new Set([first]));
	expect(second.length).toBeLessThanOrEqual(32);
	expect(second).toEndWith("-2");
});