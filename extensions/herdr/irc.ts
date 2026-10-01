/**
 * IRC: agent-to-agent messaging over per-agent unix sockets.
 *
 * pi subagents are separate processes with no shared bus, so IRC is
 * out-of-process. Each agent running this extension listens on its own socket
 * at `$XDG_RUNTIME_DIR/pi-irc/<pane>.sock` (fallback `~/.pi/agent/pi-irc/`).
 * Senders connect, write one JSON envelope per line, and read one JSON ack line.
 *
 * Delivery, matching omp's in-process IrcBus semantics:
 *   - a matching `irc_wait` is blocked on the message -> resolve it (tool result)
 *   - `mode: "reject"` while busy -> bounce to the sender (retryable), no delivery
 *   - otherwise the message is injected into the live pi session via
 *     `pi.sendMessage` as `deliverAs: "steer"` when busy, or `followUp` +
 *     `triggerTurn` when idle
 *
 * Exactly-once (two layers, see IRC-DURABLE-SPEC.md):
 *   - transport: a bounded dedup ring keyed by `dedupeId ?? id`, persisted at
 *     `~/.pi/agent/pi-irc-seen/<pane>.seen` — a DURABLE path, not the ephemeral
 *     socket dir (so a socket cleanup or reboot keeps the ring). Delivered
 *     before recorded, so a crash between the two re-delivers on retry rather
 *     than silently losing the message (at-least-once under transport failure).
 *   - admission: a Durable-backed orchestrator passes the envelope id as
 *     `requestId`, so a resubmission is not admitted twice.
 *
 * herdr's roster is the registry: identity is the agent name when set, else the
 * pane id; targets resolve through `agent list`.
 *
 * Ring keying: keys are `dedupeId ?? id`, stored per PANE id and deliberately
 * stable across recipient restarts (that is what makes a Durable-orchestrator
 * retry safe). Consequence: if a pane id is recycled by a new agent, that agent
 * inherits the old ring. Accepted — an old message should not reach a new
 * occupant — so no per-boot nonce is added.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type IrcScope = "self" | "tab" | "workspace" | "all";
export type IrcMode = "steer" | "followUp" | "reject";
export type IrcAckStatus = "accepted" | "queued" | "rejected" | "duplicate";

export interface IrcEnvelope {
	id: string;
	from: string;
	to: string;
	body: string;
	ts: number;
	replyTo?: string;
	/** Delivery mode; defaults to steer-when-busy / followUp-when-idle. */
	mode?: IrcMode;
	/** Idempotency key; defaults to `id`. Retries MUST reuse it. */
	dedupeId?: string;
	/**
	 * Whether the sender expects a reply. `true` asks for one, `false` marks it
	 * FYI, unset leaves the decision to the recipient (the default).
	 */
	expectsReply?: boolean;
}

/** One JSON line returned by the receiver for every envelope. */
export interface IrcAck {
	ack: IrcAckStatus;
	id: string;
	reason?: string;
}

export interface IrcAgent {
	pane_id: string;
	name?: string;
	agent?: string;
	agent_status?: string;
	workspace_id?: string;
	tab_id?: string;
}

export interface IrcPeer {
	pane_id: string;
	identity: string;
	name?: string;
	agent?: string;
	status?: string;
	workspace_id?: string;
	self?: boolean;
}

const LOG_CAP = 200;
const ACK_TIMEOUT_MS = 5000;
/** Stale `.seen` files (a pane id that has not sent/received in this long) are reaped. */
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Directory holding per-agent sockets. Ephemeral (tmpfs) by design. */
export function ircDir(): string {
	const base = process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(base, "pi-irc");
}

/**
 * Durable directory for dedup rings. Deliberately NOT under the socket dir:
 * socket cleanup must cost sockets only, and the ring must survive a reboot.
 */
export function seenDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "pi-irc-seen");
}

function sockName(paneId: string): string {
	return `${paneId.replace(/:/g, "~")}.sock`;
}

function paneFromSock(name: string): string | undefined {
	if (!name.endsWith(".sock")) return undefined;
	return name.slice(0, -".sock".length).replace(/~/g, ":");
}

export function socketPathFor(paneId: string): string {
	return path.join(ircDir(), sockName(paneId));
}

function seenPathFor(paneId: string): string {
	return path.join(seenDir(), `${sockName(paneId)}.seen`);
}

/**
 * Write one envelope to a target pane's socket and read its ack.
 * Rejects if the socket is unreachable (stale/dead pane) or no ack arrives.
 */
export async function sendEnvelope(
	toPane: string,
	env: IrcEnvelope,
	timeoutMs: number = ACK_TIMEOUT_MS,
): Promise<IrcAck> {
	const sp = socketPathFor(toPane);
	return await new Promise<IrcAck>((resolve, reject) => {
		const socket = net.createConnection(sp);
		let buf = "";
		let settled = false;
		const done = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			fn();
		};
		const timer = setTimeout(() => done(() => reject(new Error(`irc: no ack from ${toPane}`))), timeoutMs);
		timer.unref?.();
		socket.on("connect", () => socket.write(`${JSON.stringify(env)}\n`));
		socket.on("data", (d) => {
			buf += d.toString();
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			try {
				done(() => resolve(JSON.parse(buf.slice(0, nl)) as IrcAck));
			} catch {
				done(() => reject(new Error(`irc: bad ack from ${toPane}`)));
			}
		});
		socket.on("error", (e) => done(() => reject(new Error(`irc: cannot reach ${toPane}: ${e.message}`))));
	});
}

interface Waiter {
	from?: string;
	done: boolean;
	timer: ReturnType<typeof setTimeout>;
	resolve: (env: IrcEnvelope | undefined) => void;
}

export interface IrcNodeOptions {
	paneId: string;
	identity?: string;
	/** Inject a message into the live session (steer/followUp decided by caller). */
	deliver: (env: IrcEnvelope) => void;
	/** Whether the local agent is mid-turn; gates `mode: "reject"`. */
	isBusy?: () => boolean;
}

export class IrcNode {
	readonly paneId: string;
	identity: string;
	private opts: IrcNodeOptions;
	private server?: net.Server;
	private healTimer?: ReturnType<typeof setInterval>;
	private waiters: Waiter[] = [];
	private log: IrcEnvelope[] = [];
	private started = false;
	/** Bounded, persisted dedup ring of processed `dedupeId ?? id`. */
	private seen = new Set<string>();
	private seenOrder: string[] = [];

	constructor(opts: IrcNodeOptions) {
		this.opts = opts;
		this.paneId = opts.paneId;
		this.identity = opts.identity ?? opts.paneId;
	}

	async start(): Promise<void> {
		if (this.started) return;
		await mkdir(ircDir(), { recursive: true });
		await mkdir(seenDir(), { recursive: true }).catch(() => {});
		this.sweepSeen();
		this.loadSeen();
		await this.listen();
		this.started = true;
		// Self-heal: if something unlinks our socket file (an over-broad cleanup,
		// a manual rm), re-listen so peers can reach us again.
		this.healTimer = setInterval(() => this.healSocket(), 15000);
		this.healTimer.unref?.();
	}

	/** (Re)bind the socket. Closes any previous server on the same path. */
	private async listen(): Promise<void> {
		const sp = socketPathFor(this.paneId);
		await unlink(sp).catch(() => {});
		const server = net.createServer((socket) => this.onConnection(socket));
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			server.once("error", onError);
			server.listen(sp, () => {
				server.off("error", onError);
				resolve();
			});
		});
		this.server = server;
	}

	private healSocket(): void {
		if (!this.started || existsSync(socketPathFor(this.paneId))) return;
		void (async () => {
			try {
				this.server?.close();
				this.server = undefined;
				await this.listen();
			} catch {
				// retry on the next tick
			}
		})();
	}

	stop(): void {
		if (this.healTimer) clearInterval(this.healTimer);
		this.healTimer = undefined;
		for (const w of this.waiters) {
			clearTimeout(w.timer);
			w.resolve(undefined);
		}
		this.waiters = [];
		this.server?.close();
		this.server = undefined;
		this.started = false;
		void unlink(socketPathFor(this.paneId)).catch(() => {});
	}

	/** Load the persisted ring, keeping only the newest `LOG_CAP` keys. */
	private loadSeen(): void {
		try {
			const lines = readFileSync(seenPathFor(this.paneId), "utf8").split("\n").filter(Boolean);
			const tail = lines.slice(-LOG_CAP);
			for (const key of tail) {
				if (!this.seen.has(key)) {
					this.seen.add(key);
					this.seenOrder.push(key);
				}
			}
			writeFileSync(seenPathFor(this.paneId), tail.length ? `${tail.join("\n")}\n` : "");
		} catch {
			// no ring yet
		}
	}

	/** Reap `.seen` files for pane ids that have not been active for `SEEN_TTL_MS`. */
	private sweepSeen(): void {
		try {
			const now = Date.now();
			for (const f of readdirSync(seenDir())) {
				if (!f.endsWith(".seen")) continue;
				const p = path.join(seenDir(), f);
				try {
					if (now - statSync(p).mtimeMs > SEEN_TTL_MS) unlinkSync(p);
				} catch {
					// skip
				}
			}
		} catch {
			// no dir yet
		}
	}

	/** Append the key to the durable ring. In-memory ring guards this process. */
	private recordSeen(key: string): void {
		if (this.seen.has(key)) return;
		this.seen.add(key);
		this.seenOrder.push(key);
		try {
			mkdirSync(seenDir(), { recursive: true });
			appendFileSync(seenPathFor(this.paneId), `${key}\n`);
		} catch (error) {
			// Durable dedup is degrading to in-memory; make that observable.
			console.error(
				`[irc] dedup ring write failed for ${this.paneId}; falling back to in-memory only:`,
				error instanceof Error ? error.message : String(error),
			);
		}
		if (this.seenOrder.length > LOG_CAP * 2) {
			const tail = this.seenOrder.slice(-LOG_CAP);
			this.seen = new Set(tail);
			this.seenOrder = tail;
			try {
				writeFileSync(seenPathFor(this.paneId), `${tail.join("\n")}\n`);
			} catch (error) {
				console.error(
					`[irc] dedup ring compaction failed for ${this.paneId}:`,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	}

	private onConnection(socket: net.Socket): void {
		let buf = "";
		socket.on("data", (d) => {
			buf += d.toString();
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			const line = buf.slice(0, nl);
			let env: IrcEnvelope;
			try {
				env = JSON.parse(line) as IrcEnvelope;
			} catch {
				socket.end();
				return;
			}
			if (!env || typeof env.body !== "string" || typeof env.from !== "string") {
				socket.end();
				return;
			}
			const ack = this.receive(env);
			socket.write(`${JSON.stringify(ack)}\n`, () => socket.end());
		});
		socket.on("error", () => {});
	}

	/**
	 * Decide and deliver. At-least-once: deliver FIRST, then record, so a crash
	 * between the two re-delivers on retry rather than silently losing the
	 * message. Rejections are never recorded, so a bounced send stays retryable.
	 */
	private receive(env: IrcEnvelope): IrcAck {
		const key = env.dedupeId ?? env.id;
		if (this.seen.has(key)) return { ack: "duplicate", id: env.id };
		const i = this.waiters.findIndex((w) => !w.done && (!w.from || w.from === env.from));
		if (i >= 0) {
			const w = this.waiters.splice(i, 1)[0]!;
			w.done = true;
			clearTimeout(w.timer);
			w.resolve(env);
			this.recordSeen(key);
			return { ack: "accepted", id: env.id };
		}
		if (env.mode === "reject" && (this.opts.isBusy?.() ?? false)) {
			return { ack: "rejected", id: env.id, reason: "busy" };
		}
		this.opts.deliver(env);
		this.recordSeen(key);
		this.log.push(env);
		if (this.log.length > LOG_CAP) this.log.shift();
		return { ack: "queued", id: env.id };
	}

	/** Block for the next message (optionally filtered by sender). */
	wait(opts: { from?: string; timeoutMs: number; signal?: AbortSignal }): Promise<IrcEnvelope | undefined> {
		return new Promise((resolve) => {
			const w: Waiter = {
				from: opts.from,
				done: false,
				resolve,
				timer: setTimeout(() => this.settleWaiter(w, undefined), opts.timeoutMs),
			};
			w.timer.unref?.();
			if (opts.signal?.aborted) {
				resolve(undefined);
				return;
			}
			opts.signal?.addEventListener("abort", () => this.settleWaiter(w, undefined), { once: true });
			this.waiters.push(w);
		});
	}

	private settleWaiter(w: Waiter, env: IrcEnvelope | undefined): void {
		if (w.done) return;
		w.done = true;
		clearTimeout(w.timer);
		const i = this.waiters.indexOf(w);
		if (i >= 0) this.waiters.splice(i, 1);
		w.resolve(env);
	}

	async send(
		toPane: string,
		body: string,
		opts: { replyTo?: string; mode?: IrcMode; dedupeId?: string; expectsReply?: boolean } = {},
	): Promise<{ env: IrcEnvelope; ack: IrcAck }> {
		const env: IrcEnvelope = {
			id: randomUUID(),
			from: this.identity,
			to: toPane,
			body,
			ts: Date.now(),
			...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
			...(opts.mode ? { mode: opts.mode } : {}),
			...(opts.dedupeId ? { dedupeId: opts.dedupeId } : {}),
			...(opts.expectsReply === undefined ? {} : { expectsReply: opts.expectsReply }),
		};
		const ack = await sendEnvelope(toPane, env);
		return { env, ack };
	}

	/** Pane ids with a live IRC listener. */
	listListeners(): string[] {
		try {
			return readdirSync(ircDir())
				.map(paneFromSock)
				.filter((x): x is string => !!x);
		} catch {
			return [];
		}
	}

	recent(): IrcEnvelope[] {
		return [...this.log];
	}
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export interface IrcToolDeps {
	node: IrcNode;
	/** Scoped herdr agents, used to resolve targets and build the roster. */
	listAgents: (scope: IrcScope) => Promise<IrcAgent[]>;
}

const ircScopeSchema = Type.Union(
	[Type.Literal("self"), Type.Literal("tab"), Type.Literal("workspace"), Type.Literal("all")],
	{ description: "send/roster: which agents to include (default workspace)" },
);

const ircModeSchema = Type.Union([Type.Literal("steer"), Type.Literal("followUp"), Type.Literal("reject")], {
	description:
		'send: delivery mode. "reject" bounces when the recipient is busy (retry later) instead of interrupting it.',
});

const ircSchema = Type.Object({
	action: Type.Union([Type.Literal("send"), Type.Literal("wait"), Type.Literal("roster")]),
	to: Type.Optional(
		Type.String({ description: 'send: target agent name or pane id, or "all" to broadcast' }),
	),
	body: Type.Optional(Type.String({ description: "send: message text" })),
	replyTo: Type.Optional(Type.String({ description: "send: id of the message being replied to" })),
	mode: Type.Optional(ircModeSchema),
	dedupeId: Type.Optional(
		Type.String({ description: "send: idempotency key; retries with the same value are dropped (defaults to the envelope id)" }),
	),
	expectsReply: Type.Optional(
		Type.Boolean({
			description:
				"send: whether a reply is expected. true asks for one, false marks it FYI, unset lets the recipient decide. Leave unset/false for broadcasts and acknowledgements.",
		}),
	),
	from: Type.Optional(Type.String({ description: "wait: only accept messages from this identity" })),
	scope: Type.Optional(ircScopeSchema),
	timeout: Type.Optional(Type.Number({ description: "wait: timeout in milliseconds (default 120000)" })),
});

function formatIrcForModel(env: IrcEnvelope): string {
	const reply = env.replyTo ? ` (reply to ${env.replyTo})` : "";
	const how = `the irc tool: action=send, to=${env.from}, replyTo=${env.id}`;
	// Never demand a reply: an unconditional "reply with…" makes two idle agents
	// ping-pong. State the mechanism, and let the sender's intent (or the
	// recipient's judgment) decide whether it is used.
	const guidance =
		env.expectsReply === true
			? `A response is expected — reply via ${how}.`
			: env.expectsReply === false
				? "No reply is needed."
				: `If a response is expected, reply via ${how}; otherwise no reply is needed.`;
	return `[irc] [${env.id}] ${env.from}${reply}:\n${env.body}\n\n${guidance}`;
}

export function registerIrcTool(pi: ExtensionAPI, deps: IrcToolDeps): void {
	const { node } = deps;

	async function peers(scope: IrcScope): Promise<IrcPeer[]> {
		const listeners = new Set(node.listListeners());
		listeners.add(node.paneId);
		const agents = await deps.listAgents(scope);
		const seen = new Set<string>();
		const out: IrcPeer[] = [];
		for (const a of agents) {
			if (!listeners.has(a.pane_id) || seen.has(a.pane_id)) continue;
			seen.add(a.pane_id);
			out.push({
				pane_id: a.pane_id,
				identity: a.name ?? a.pane_id,
				name: a.name,
				agent: a.agent,
				status: a.agent_status,
				workspace_id: a.workspace_id,
				self: a.pane_id === node.paneId,
			});
		}
		if (!seen.has(node.paneId)) {
			out.push({ pane_id: node.paneId, identity: node.identity, self: true });
		}
		return out;
	}

	pi.registerTool({
		name: "irc",
		label: "IRC",
		description:
			"Agent-to-agent messaging (IRC) between coding agents that run this extension. Each agent listens on its own socket; the herdr roster is the registry. `roster` lists reachable peers, `send` delivers a message to a peer or broadcasts, and `wait` blocks for the next incoming message. Incoming messages are also injected into your session automatically, so you only need `wait` when you want to block for a reply.",
		promptSnippet: "Message other agents (IRC) and wait for replies",
		promptGuidelines: [
			"Use `irc` to talk to peer agents: `roster` to see who is reachable, `send` to message one (`to: <name|pane>`) or broadcast (`to: \"all\"`), `wait` to block for the next message.",
			"Incoming IRC messages are injected into your session automatically (steered mid-turn, or a follow-up when idle); a message is delivered exactly once, so `wait` only returns messages you did not already receive.",
			"`send` returns an ack per target (`accepted`/`queued`/`rejected`/`failed`). Retry only `rejected` (busy recipient) or `failed`, reusing the same `dedupeId` so a retry cannot double-deliver.",
			"Keep messages short and explicit; include what you need and, when replying, set `replyTo` to the incoming message id.",
			"Reply only when a response is expected; acknowledgements and FYIs need no reply. A reply must not itself demand a reply, or two idle agents will ping-pong.",
			"When sending, set `expectsReply: true` only if you actually need an answer; leave it unset (or `false`) for FYIs and broadcasts so peers do not reply needlessly.",
		],
		parameters: ircSchema,
		async execute(_id, params, signal) {
			const scope = (params.scope ?? "workspace") as IrcScope;
			if (params.action === "roster") {
				const list = await peers(scope);
				const out = { self: node.identity, scope, peers: list };
				return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: out };
			}
			if (params.action === "send") {
				const body = params.body?.trim();
				if (!body) throw new Error("irc send: `body` is required");
				const to = params.to?.trim();
				const opts = {
					replyTo: params.replyTo,
					mode: params.mode as IrcMode | undefined,
					dedupeId: params.dedupeId,
					expectsReply: params.expectsReply,
				};
				const targets: Array<{ pane_id: string; identity: string; workspace_id?: string }> = [];
				if (!to || to === "all") {
					for (const p of (await peers(scope)).filter((p) => !p.self)) {
						targets.push({ pane_id: p.pane_id, identity: p.identity, workspace_id: p.workspace_id });
					}
				} else {
					const all = await deps.listAgents("all");
					const match = all.find((a) => a.name === to || a.pane_id === to);
					if (!match) throw new Error(`irc send: no agent named or at pane "${to}"`);
					targets.push({
						pane_id: match.pane_id,
						identity: match.name ?? match.pane_id,
						workspace_id: match.workspace_id,
					});
				}
				const accepted: Array<{ to: string; id: string }> = [];
				const queued: Array<{ to: string; id: string }> = [];
				const rejected: Array<{ to: string; id: string; reason?: string }> = [];
				const duplicate: Array<{ to: string; id: string }> = [];
				const failed: Array<{
					to: string;
					pane_id: string;
					workspace_id?: string;
					code: string;
					error: string;
				}> = [];
				for (const t of targets) {
					try {
						const { env, ack } = await node.send(t.pane_id, body, opts);
						const rec = { to: t.identity, id: env.id };
						if (ack.ack === "accepted") accepted.push(rec);
						else if (ack.ack === "queued") queued.push(rec);
						else if (ack.ack === "rejected") rejected.push({ ...rec, reason: ack.reason });
						else duplicate.push(rec);
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						const code = /ECONNREFUSED|ENOENT|no ack|cannot reach/i.test(msg) ? "pane_gone" : "error";
						failed.push({
							to: t.identity,
							pane_id: t.pane_id,
							...(t.workspace_id ? { workspace_id: t.workspace_id } : {}),
							code,
							error: msg,
						});
					}
				}
				const out = {
					accepted,
					queued,
					...(rejected.length ? { rejected } : {}),
					...(duplicate.length ? { duplicate } : {}),
					...(failed.length ? { failed } : {}),
				};
				return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: out };
			}
			// wait
			const env = await node.wait({
				from: params.from,
				timeoutMs: params.timeout ?? 120000,
				signal,
			});
			const out = env
				? { message: env }
				: { message: null, timedOut: true, note: "No matching message before the timeout." };
			return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: out };
		},
	});
}

export { formatIrcForModel };
