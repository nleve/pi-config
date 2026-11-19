import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASSIGNMENT_ENTRY, RUN_ENTRY, RESULT_ENTRY, DEFAULT_WAIT_MS, assignmentMarker, collectAssignment, type Assignment } from "./assignment.ts";
import { callHerdr, HerdrCommandError } from "./client.ts";
import { getAgent, type AgentInfo } from "./socket.ts";
import { sessionPathOf } from "./session.ts";
import { appendSpawnEntry } from "./navigation.ts";
import { isAlive, mergeIdentity, readIdentities } from "./registry.ts";

const timeoutSchema = Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000, description: "Maximum milliseconds to wait for the answer, not a worker deadline. Default 30000; 0 checks once." }));
const leafTools = "herdr,delegate,delegate_result";
const row = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const str = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const err = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function delegateLabel(value: string, max = 56): string {
	return [...value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("");
}

export function delegateHandle(label: string, run: string | undefined, taken: ReadonlySet<string>): string {
	function slug(text: string): string {
		return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	}
	const scope = run ? slug(run).slice(0, 11).replace(/-+$/, "") : "";
	const task = slug(label) || "worker";
	let base = scope && task !== scope && !task.startsWith(scope + "-") ? `${scope}-${task}` : task;
	if (!/^[a-z]/.test(base)) base = `work-${base}`;
	base = base.slice(0, 32).replace(/-+$/, "");
	if (!taken.has(base)) return base;
	for (let i = 2;; i++) {
		const suffix = `-${i}`;
		const candidate = base.slice(0, 32 - suffix.length).replace(/-+$/, "") + suffix;
		if (!taken.has(candidate)) return candidate;
	}
}

function quoteShell(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function customData(ctx: ExtensionContext, type: string): unknown[] {
	return ctx.sessionManager.getEntries().flatMap(entry => entry.type === "custom" && entry.customType === type ? [entry.data] : []);
}

function readTicket(ctx: ExtensionContext, ticket: string): { assignment: Assignment; submission?: string } | undefined {
	for (const item of customData(ctx, ASSIGNMENT_ENTRY).reverse()) {
		const record = row(item);
		if (record.ticket !== ticket) continue;
		if (!["name", "label", "pane", "workspace", "tab", "sessionPath"].every(k => str(record[k]))) return undefined;
		return { assignment: record as unknown as Assignment, submission: str(record.submission) };
	}
}

interface DelegateDeps {
	modelArgs: (selector: string | undefined, ctx: ExtensionContext) => { args: string[]; model?: string };
	parentName: () => string;
	spawned: Set<string>;
}

type Placement = { workspace: string; tab: string; pane: string };

export function registerDelegateTools(pi: ExtensionAPI, deps: DelegateDeps): void {
	const workspaceLocks = new Map<string, Promise<unknown>>();
	const nameReservations = new Set<string>();

	async function cli(args: string[], signal?: AbortSignal) {
		return row((await callHerdr({ args, timeoutMs: 15_000 }, signal)).result);
	}

	async function placementFor(ctx: ExtensionContext, label: string, run: string | undefined, signal?: AbortSignal): Promise<Placement> {
		async function place(): Promise<Placement> {
			signal?.throwIfAborted();
			const caller = await cli(["pane", "current", "--current"], signal);
			let workspace = str(row(caller.pane).workspace_id) ?? process.env.HERDR_WORKSPACE_ID;
			if (!workspace) throw new Error("Pi has no Herdr workspace context.");
			if (run) {
				const name = `${run} · ${deps.parentName()}`;
				const owner = ctx.sessionManager.getSessionId();
				const prior = customData(ctx, RUN_ENTRY).map(row).reverse().find(record => record.run === run && record.owner === owner);
				const known = str(prior?.workspace);
				if (known) {
					const all = await cli(["workspace", "list"], signal);
					const workspaces = Array.isArray(all.workspaces) ? all.workspaces.map(row) : [];
					const saved = workspaces.find(item => item.workspace_id === known && (row(item.tokens).delegate_owner === owner || item.label === prior?.name));
					if (saved) workspace = known;
					else workspace = undefined;
				} else workspace = undefined;
				if (!workspace) {
					// Keep the creation response (rather than killing the CLI midway) so
					// cancellation still leaves us with a concrete pane to roll back.
					const made = await cli(["workspace", "create", "--cwd", ctx.cwd, "--label", name, "--no-focus"]);
					workspace = str(row(made.workspace).workspace_id);
					const tab = str(row(made.tab).tab_id);
					const pane = str(row(made.root_pane).pane_id);
					if (!workspace || !tab || !pane) throw new Error("Herdr did not return the new workspace/tab/pane IDs.");
					try {
						await cli(["tab", "rename", tab, label]);
						await cli(["workspace", "report-metadata", workspace, "--source", "pi-herdr-delegate", "--token", `delegate_owner=${owner}`]);
						pi.appendEntry(RUN_ENTRY, { run, workspace, name, owner });
					} catch (error) {
						await closePane(pane);
						throw error;
					}
					return { workspace, tab, pane };
				}
			}
			const created = await cli(["tab", "create", "--workspace", workspace, "--cwd", ctx.cwd, "--label", label, "--no-focus"]);
			const tab = str(row(created.tab).tab_id);
			const pane = str(row(created.root_pane).pane_id);
			if (!tab || !pane) throw new Error("Herdr did not return the new tab/pane IDs.");
			return { workspace, tab, pane };
		}
		if (!run) return place();
		const key = `${ctx.sessionManager.getSessionId()}:${run}`;
		const prior = workspaceLocks.get(key);
		const next = Promise.resolve(prior).catch(() => {}).then(place);
		workspaceLocks.set(key, next);
		try {
			return await next;
		} finally {
			if (workspaceLocks.get(key) === next) workspaceLocks.delete(key);
		}
	}

	async function closePane(pane: string): Promise<void> {
		await cli(["pane", "close", pane]).catch(() => {});
	}

	async function workerIdentity(pane: string, sessionPath: string, signal?: AbortSignal) {
		const deadline = Date.now() + 3000;
		do {
			const found = readIdentities().find(item => item.pane_id === pane && item.session_path === sessionPath && isAlive(item.pid));
			if (found) return found;
			await pause(120, undefined, { signal });
		} while (Date.now() < deadline);
	}

	async function lookup(a: Assignment, signal?: AbortSignal): Promise<AgentInfo | undefined> {
		const id = readIdentities().find(candidate => candidate.session_path === a.sessionPath && (!a.sessionId || candidate.session_id === a.sessionId) && isAlive(candidate.pid));
		const target = id?.pane_id ?? a.pane;
		try {
			const agent = await getAgent(target, { timeoutMs: 1200, signal });
			return sessionPathOf(agent) === a.sessionPath ? agent : undefined;
		} catch (error) {
			if (/no agent|not found|not.*known|does not exist/i.test(err(error))) return undefined;
			throw error;
		}
	}

	async function ready(pane: string, signal?: AbortSignal): Promise<{ agent: AgentInfo; sessionPath: string }> {
		const deadline = Date.now() + 22_000;
		while (Date.now() < deadline) {
			signal?.throwIfAborted();
			const agent = await getAgent(pane, { timeoutMs: 1200, signal }).catch(() => undefined);
			const sessionPath = agent && sessionPathOf(agent);
			if (agent?.agent === "pi" && sessionPath && agent.name && ["idle", "done", "blocked"].includes(agent.agent_status ?? "")) {
				return { agent, sessionPath };
			}
			await pause(175, undefined, { signal });
		}
		throw new Error(`Pi did not become ready in ${pane}.`);
	}

	function result(a: Assignment, state: object, cache = true) {
		const out = { ticket: a.ticket, worker: `^^${a.name}`, label: a.label, run: a.run, workspace: a.workspace, tab: a.tab, model: a.model, ...state };
		if (cache && (state as { status?: string }).status === "completed" && JSON.stringify(state).length <= 1024 * 1024) {
			try { pi.appendEntry(RESULT_ENTRY, { ticket: a.ticket, result: state }); } catch { /* still return the answer */ }
		}
		return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }], details: out };
	}

	pi.registerTool({
		name: "delegate",
		label: "Delegate Task",
		description: "Give one assignment to a new Pi worker in a background Herdr tab. Returns its answer or a ticket and its ^^handle. Use delegate_result for the assignment; use irc send for conversational follow-ups.",
		promptSnippet: "Delegate a new task to a named Pi worker",
		promptGuidelines: ["Use delegate when the user names a ^model[:thinking] or requests a subagent. Pass the model tag as-is, a short search label, and a self-contained task. Use the same run label for a batch; use wait:false to launch without waiting for the answer. A wait timeout does not stop the worker."],
		parameters: Type.Object({
			model: Type.Optional(Type.String({ description: "^model[:thinking] from the user, or provider/model[:thinking]. Omit to inherit the active model." })),
			task: Type.String({ minLength: 1, description: "Assignment to submit once to the worker." }),
			label: Type.String({ minLength: 1, description: "Short task label for the Herdr tab and handle; don't paste the prompt or secrets." }),
			run: Type.Optional(Type.String({ description: "Optional shared batch label. Each worker gets a full-size tab in that run workspace." })),
			wait: Type.Optional(Type.Boolean({ description: "Wait for an answer after starting and submitting, default true." })),
			timeout: timeoutSchema,
		}),
		async execute(callId, params, signal, _update, ctx) {
			const task = params.task.trim();
			const label = delegateLabel(params.label);
			const run = params.run ? delegateLabel(params.run, 36) || undefined : undefined;
			if (!task || !label) throw new Error("delegate: task and label must not be empty.");
			const model = deps.modelArgs(params.model, ctx);
			const taken = new Set([...readIdentities().map(identity => identity.name), ...nameReservations]);
			const name = delegateHandle(label, run, taken);
			nameReservations.add(name);
			let placed: Placement | undefined;
			let assignment: Assignment | undefined;
			let startupBlocked = false;
			try {
				placed = await placementFor(ctx, label, run, signal);
				signal?.throwIfAborted();
				const words = ["pi", "--offline", "-xt", leafTools, "--name", name, ...model.args];
				const command = words.map(quoteShell).join(" ");
				await cli(["pane", "run", placed.pane, command], signal);
				const { agent, sessionPath } = await ready(placed.pane, signal);
				startupBlocked = agent.agent_status === "blocked";
				const identity = await workerIdentity(placed.pane, sessionPath, signal);
				assignment = { ...placed, ticket: randomUUID(), name: agent.name!, label, sessionPath, sessionId: identity?.session_id, run, model: model.model };
				// Record the ticket before sending. If the client or CLI dies after
				// admission, collect can still find the marker without resubmitting.
				pi.appendEntry(ASSIGNMENT_ENTRY, { ...assignment, callId, submission: "not_sent" });
				deps.spawned.add(placed.pane);
				appendSpawnEntry(pi, { action: "spawn", name: assignment.name, label, pane_id: placed.pane, session_id: identity?.session_id,
					session_path: sessionPath, cwd: ctx.cwd, model: model.model, group: run, workspace_id: placed.workspace, ts: Date.now() });
				const parent = deps.parentName();
				if (identity) {
					try {
						mergeIdentity(identity.session_id ?? sessionPath, { task_label: label, group: run,
							parent_name: parent, parent_pane_id: process.env.HERDR_PANE_ID, parent_session_id: ctx.sessionManager.getSessionId() });
					} catch { /* panel/ledger still work when the registry is unavailable */ }
				}
				void cli(["pane", "report-metadata", placed.pane, "--source", "pi-herdr-delegate", "--agent", "pi", "--title", label,
					"--token", `task=${label}`, "--token", `parent=${parent}`, ...(run ? ["--token", `run=${run}`] : []), "--ttl-ms", "86400000"]).catch(() => {});
				if (ctx.mode === "tui") ctx.ui.notify(`Started ^^${assignment.name}`, "info");
			} catch (error) {
				if (placed) await closePane(placed.pane);
				throw error;
			} finally {
				nameReservations.delete(name);
			}
			if (startupBlocked || signal?.aborted) {
				return result(assignment, { status: startupBlocked ? "blocked" : "wait_cancelled", reason: "The assignment was not sent; the worker was left open." });
			}
			let unknown = false;
			try {
				pi.appendEntry(ASSIGNMENT_ENTRY, { ...assignment, callId, submission: "unknown" });
				await cli(["agent", "prompt", assignment.pane, `${assignmentMarker(assignment.ticket)}\n${task}`], signal);
				pi.appendEntry(ASSIGNMENT_ENTRY, { ...assignment, callId, submission: "accepted" });
			} catch (error) {
				if (error instanceof HerdrCommandError && ["agent_blocked", "agent_not_found", "invalid_params"].includes(error.code ?? "")) {
					pi.appendEntry(ASSIGNMENT_ENTRY, { ...assignment, callId, submission: "not_sent" });
					return result(assignment, { status: error.code === "agent_blocked" ? "blocked" : "failed", reason: `Not sent: ${err(error)}` });
				}
				unknown = true;
			}
			if (signal?.aborted) return result(assignment, { status: "wait_cancelled", reason: "Worker was left open. Collect this ticket before retrying." });
			if (params.wait === false && !unknown) return result(assignment, { status: "queued" });
			try {
				return result(assignment, await collectAssignment(assignment, lookup, params.wait === false ? 0 : (params.timeout ?? DEFAULT_WAIT_MS), signal, unknown));
			} catch (error) {
				if (!signal?.aborted) throw error;
				return result(assignment, { status: "wait_cancelled", reason: "Wait cancelled; the worker was left open." });
			}
		},
	});

	pi.registerTool({
		name: "delegate_result",
		label: "Collect Delegated Task",
		description: "Collect the answer to a specific delegate assignment from its ticket, without submitting it again. Later IRC replies are not assignment results.",
		promptSnippet: "Collect an earlier delegation by ticket",
		parameters: Type.Object({
			ticket: Type.Optional(Type.String({ description: "Ticket from delegate." })),
			worker: Type.Optional(Type.String({ description: "Exact ^^handle to recover its ticket. Omit both to list recent assignments." })),
			timeout: timeoutSchema,
		}),
		async execute(_id, params, signal, _update, ctx) {
			const records = [...new Map(customData(ctx, ASSIGNMENT_ENTRY).map(row).map(r => [r.ticket, r])).values()].reverse();
			const name = params.worker?.trim().replace(/^\^\^/, "");
			const matching = name ? records.filter(r => r.name === name) : records;
			const ticket = params.ticket ?? (name && matching.length === 1 ? str(matching[0]?.ticket) : undefined);
			if (!ticket) {
				const tickets = matching.slice(0, 30).map(r => ({ ticket: r.ticket, worker: `^^${r.name}`, label: r.label, submission: r.submission }));
				return { content: [{ type: "text", text: JSON.stringify(tickets, null, 2) }], details: { tickets } };
			}
			const saved = readTicket(ctx, ticket);
			if (!saved) throw new Error("delegate_result: unknown assignment in this Pi session.");
			const receipt = customData(ctx, RESULT_ENTRY).map(row).find(entry => entry.ticket === ticket);
			if (receipt && row(receipt.result).status === "completed") return result(saved.assignment, row(receipt.result), false);
			if (saved.submission === "not_sent") return result(saved.assignment, { status: "not_sent", reason: "No assignment prompt was submitted." });
			try {
				return result(saved.assignment, await collectAssignment(saved.assignment, lookup, params.timeout ?? DEFAULT_WAIT_MS, signal, saved.submission !== "accepted"));
			} catch (error) {
				if (!signal?.aborted) throw error;
				return result(saved.assignment, { status: "wait_cancelled", reason: "Wait cancelled; the worker was left open." });
			}
		},
	});
}
