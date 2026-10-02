/**
 * IRC: agent-to-agent messaging over a durable mailbox, with a unix-socket doorbell.
 *
 * Pure-mailbox (see GOAL.md Phase 6): a message is written to the recipient's
 * durable mailbox (keyed by *session id*) and the recipient drains its own
 * mailbox when it can. The socket carries no message body and no ack semantics;
 * it is only a doorbell ("you have mail") so a live, idle agent picks mail up
 * promptly. A dormant recipient's mail waits until its session next runs.
 *
 * Guarantees:
 *   - transport: exactly-once *parking*. `mailbox.ts` publishes with `link(2)`,
 *     so a sender retry with the same `dedupeId ?? id` is a `duplicate`, never a
 *     second copy — even across a sender crash.
 *   - delivery: at-least-once. The recipient unlinks a message only once it is
 *     confirmed present in the session transcript (`isPersisted`), so a crash
 *     between injection and persistence re-delivers rather than drops. A
 *     per-session dedup ring (`~/.pi/agent/pi-irc-seen/`) suppresses repeats.
 *
 * This replaced socket-push delivery, which could lose a message that was queued
 * in memory when the recipient crashed, and which conflated "rejected" (a
 * synchronous bounce) with "queued". `mode: "reject"` is gone: a busy recipient
 * simply defers, which is what a durable mailbox gives you for free.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { enqueue, envelopeKey, listPending, removeMessage, sweepMailboxes } from "./mailbox.ts";
import { isAlive, readIdentities } from "./registry.ts";

export type IrcScope = "self" | "tab" | "workspace" | "all";
/** Delivery mode while the recipient is busy. `reject` is intentionally gone. */
export type IrcMode = "steer" | "followUp";
export type IrcAckStatus = "mailboxed" | "duplicate";

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

/** A resolved mailbox destination. `paneId` is only for the doorbell. */
export interface IrcTarget {
	mailboxKey: string;
	paneId?: string;
	identity?: string;
}

/** One JSON line returned for an accepted send. */
export interface IrcAck {
	ack: IrcAckStatus;
	id: string;
}

export interface IrcAgent {
	pane_id: string;
	name?: string;
	agent?: string;
	agent_status?: string;
	workspace_id?: string;
	tab_id?: string;
	session_id?: string;
}

export interface IrcPeer {
	pane_id: string;
	identity: string;
	/** Durable mailbox key (session id when known); defaults to the pane id. */
	mailboxKey?: string;
	name?: string;
	agent?: string;
	status?: string;
	workspace_id?: string;
	self?: boolean;
}

/** A durable registry identity, structurally compatible with `AgentIdentity`. */
export interface IrcDurableIdentity {
	pane_id: string;
	name?: string;
	session_id?: string;
	pid?: number;
}

/**
 * Broadcast recipient set: live peers (already scoped) unioned with durable
 * registry identities. A dormant identity (pid gone) has no live pane, so it
 * becomes a mailbox-only target; a live one keeps its pane for the doorbell.
 * The sender is skipped and targets are de-duplicated by mailbox key.
 */
export function broadcastTargets(
	peers: readonly IrcPeer[],
	durable: readonly IrcDurableIdentity[],
	selfPane: string,
): IrcTarget[] {
	const out: IrcTarget[] = [];
	const seen = new Set<string>();
	const add = (target: IrcTarget) => {
		if (!target.mailboxKey || target.paneId === selfPane || seen.has(target.mailboxKey)) return;
		seen.add(target.mailboxKey);
		out.push(target);
	};
	for (const p of peers) {
		if (p.self || p.pane_id === selfPane) continue;
		add({ mailboxKey: p.mailboxKey ?? p.pane_id, paneId: p.pane_id, identity: p.identity });
	}
	for (const d of durable) {
		if (d.pane_id === selfPane) continue;
		add({
			mailboxKey: d.session_id ?? d.pane_id,
			...(d.pid !== undefined && isAlive(d.pid) ? { paneId: d.pane_id } : {}),
			identity: d.name ?? d.pane_id,
		});
	}
	return out;
}

const LOG_CAP = 200;
const DOORBELL_TIMEOUT_MS = 2000;
/** Stale `.seen` files (an identity that has not received in this long) are reaped. */
const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Undeliverable mail older than this is reaped. */
const MAIL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Directory holding per-agent sockets. Ephemeral (tmpfs) by design. */
export function ircDir(): string {
	if (process.env.PI_IRC_DIR) return process.env.PI_IRC_DIR;
	const base = process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(base, "pi-irc");
}

/**
 * Durable directory for dedup rings. Deliberately NOT under the socket dir:
 * socket cleanup must cost sockets only, and the ring must survive a reboot.
 */
export function seenDir(): string {
	return process.env.PI_IRC_SEEN_DIR ?? path.join(os.homedir(), ".pi", "agent", "pi-irc-seen");
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

function seenPathFor(mailboxKey: string): string {
	return path.join(seenDir(), `${mailboxKey.replace(/:/g, "~")}.seen`);
}

/**
 * Ring the doorbell: tell a live pane it has mail. Body-less, best-effort.
 * Resolves on any response, error, or timeout — a failed doorbell costs
 * promptness, never delivery.
 */
export async function ringDoorbell(paneId: string, timeoutMs: number = DOORBELL_TIMEOUT_MS): Promise<void> {
	const sp = socketPathFor(paneId);
	await new Promise<void>((resolve) => {
		const socket = net.createConnection(sp);
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		timer.unref?.();
		socket.on("connect", () => socket.write(`${JSON.stringify({ doorbell: true })}\n`));
		socket.on("data", finish);
		socket.on("error", finish);
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
	/** Durable identity. The mailbox is keyed by this when present. */
	sessionId?: string;
	identity?: string;
	/** Mailbox key; defaults to `sessionId ?? paneId`. */
	mailboxKey?: string;
	/** Inject a message into the live session. Fire-and-forget. */
	deliver: (env: IrcEnvelope) => void;
	/** Whether an injected message is durably in the session. Defaults to "assume yes". */
	isPersisted?: (env: IrcEnvelope) => boolean;
}

export class IrcNode {
	readonly paneId: string;
	mailboxKey: string;
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
	/** Injected but not yet confirmed persisted, keyed by dedupe key. */
	private injected = new Map<string, IrcEnvelope>();
	private draining = false;
	private dirty = false;

	constructor(opts: IrcNodeOptions) {
		this.opts = opts;
		this.paneId = opts.paneId;
		this.mailboxKey = opts.mailboxKey ?? opts.sessionId ?? opts.paneId;
		this.identity = opts.identity ?? opts.paneId;
	}

	async start(): Promise<void> {
		if (this.started) return;
		await mkdir(ircDir(), { recursive: true });
		await mkdir(seenDir(), { recursive: true }).catch(() => {});
		this.sweepSeen();
		sweepMailboxes(MAIL_TTL_MS);
		this.loadSeen();
		await this.listen();
		this.started = true;
		// Self-heal: if something unlinks our socket file (an over-broad cleanup,
		// a manual rm), re-listen so peers can still ring us.
		this.healTimer = setInterval(() => this.healSocket(), 15000);
		this.healTimer.unref?.();
		void this.drain();
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
				void this.drain();
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

	/**
	 * Bind to the durable session identity: switch the mailbox (and seen ring)
	 * from the provisional pane key to the session id, then drain. Safe to call
	 * more than once (a reload re-fires session_start).
	 */
	setSession(sessionId: string, identity?: string): void {
		if (identity) this.identity = identity;
		if (!sessionId || sessionId === this.mailboxKey) return;
		// The mailbox key changes from the provisional pane id to the durable
		// session id. Reattach anything still parked under the old key first, or
		// unconfirmed pane-keyed mail would be orphaned forever.
		this.reattachMail(this.mailboxKey, sessionId);
		this.mailboxKey = sessionId;
		this.seen = new Set();
		this.seenOrder = [];
		this.injected.clear();
		this.loadSeen();
		void this.drain();
	}

	/**
	 * Move pending mail from the provisional pane key to the durable session key
	 * on a `setSession` switch. The idempotency key is preserved, so a message
	 * already present in the destination is not copied twice.
	 */
	private reattachMail(fromKey: string, toKey: string): void {
		for (const { env } of listPending(fromKey)) {
			try {
				enqueue(toKey, env);
				removeMessage(fromKey, envelopeKey(env));
			} catch (error) {
				console.error("[irc] mailbox reattach failed:", error instanceof Error ? error.message : String(error));
			}
		}
	}

	/** Load the persisted ring, keeping only the newest `LOG_CAP` keys. */
	private loadSeen(): void {
		try {
			const lines = readFileSync(seenPathFor(this.mailboxKey), "utf8").split("\n").filter(Boolean);
			const tail = lines.slice(-LOG_CAP);
			for (const key of tail) {
				if (!this.seen.has(key)) {
					this.seen.add(key);
					this.seenOrder.push(key);
				}
			}
			writeFileSync(seenPathFor(this.mailboxKey), tail.length ? `${tail.join("\n")}\n` : "");
		} catch {
			// no ring yet
		}
	}

	/** Reap `.seen` files for identities that have not been active for `SEEN_TTL_MS`. */
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
			appendFileSync(seenPathFor(this.mailboxKey), `${key}\n`);
		} catch (error) {
			// Durable dedup is degrading to in-memory; make that observable.
			console.error(
				`[irc] dedup ring write failed for ${this.mailboxKey}; falling back to in-memory only:`,
				error instanceof Error ? error.message : String(error),
			);
		}
		if (this.seenOrder.length > LOG_CAP * 2) {
			const tail = this.seenOrder.slice(-LOG_CAP);
			this.seen = new Set(tail);
			this.seenOrder = tail;
			try {
				writeFileSync(seenPathFor(this.mailboxKey), `${tail.join("\n")}\n`);
			} catch (error) {
				console.error(
					`[irc] dedup ring compaction failed for ${this.mailboxKey}:`,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
	}

	private onConnection(socket: net.Socket): void {
		let buf = "";
		socket.on("data", (d) => {
			buf += d.toString();
			if (buf.indexOf("\n") < 0) return;
			// Any connection is a doorbell: drain and acknowledge.
			void this.drain();
			socket.write(`${JSON.stringify({ doorbell: "ok" })}\n`, () => socket.end());
		});
		socket.on("error", () => {});
	}

	/** Hand an envelope to a blocked `wait`, if one matches. */
	private takeWaiter(env: IrcEnvelope): boolean {
		const i = this.waiters.findIndex((w) => !w.done && (!w.from || w.from === env.from));
		if (i < 0) return false;
		const w = this.waiters.splice(i, 1)[0]!;
		w.done = true;
		clearTimeout(w.timer);
		w.resolve(env);
		return true;
	}

	/** Drain the mailbox: deliver, confirm durability, then unlink. Single-flight. */
	async drain(): Promise<void> {
		if (this.draining) {
			this.dirty = true;
			return;
		}
		this.draining = true;
		try {
			for (const { key, env } of listPending(this.mailboxKey)) {
				if (this.seen.has(key)) {
					removeMessage(this.mailboxKey, key);
					continue;
				}
				if (this.injected.has(key)) {
					if (this.isPersisted(env)) this.confirm(key, env);
					continue; // otherwise leave it for `settle()` to confirm or re-arm
				}
				if (this.takeWaiter(env)) {
					this.confirm(key, env);
					continue;
				}
				this.injected.set(key, env);
				try {
					this.opts.deliver(env);
				} catch (error) {
					this.injected.delete(key);
					console.error("[irc] delivery failed:", error instanceof Error ? error.message : String(error));
					continue;
				}
				if (this.isPersisted(env)) this.confirm(key, env);
			}
		} finally {
			this.draining = false;
			if (this.dirty) {
				this.dirty = false;
				void this.drain();
			}
		}
	}

	private isPersisted(env: IrcEnvelope): boolean {
		return this.opts.isPersisted ? this.opts.isPersisted(env) : true;
	}

	private confirm(key: string, env: IrcEnvelope): void {
		this.recordSeen(key);
		removeMessage(this.mailboxKey, key);
		this.injected.delete(key);
		this.log.push(env);
		if (this.log.length > LOG_CAP) this.log.shift();
	}

	/**
	 * A turn settled: confirm anything queued in memory that made it into the
	 * transcript; re-arm anything that was dropped (e.g. aborted) so it is
	 * re-injected, then drain again.
	 */
	async settle(): Promise<void> {
		for (const [key, env] of [...this.injected]) {
			if (this.isPersisted(env)) this.confirm(key, env);
			else this.injected.delete(key);
		}
		await this.drain();
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

	/**
	 * Park an envelope in the recipient's durable mailbox and ring its doorbell.
	 * Idempotent on `dedupeId ?? id`.
	 */
	async send(
		target: IrcTarget,
		body: string,
		opts: { replyTo?: string; mode?: IrcMode; dedupeId?: string; expectsReply?: boolean } = {},
	): Promise<{ env: IrcEnvelope; ack: IrcAck }> {
		const env: IrcEnvelope = {
			id: randomUUID(),
			from: this.identity,
			to: target.identity ?? target.mailboxKey,
			body,
			ts: Date.now(),
			...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
			...(opts.mode ? { mode: opts.mode } : {}),
			...(opts.dedupeId ? { dedupeId: opts.dedupeId } : {}),
			...(opts.expectsReply === undefined ? {} : { expectsReply: opts.expectsReply }),
		};
		const result = enqueue(target.mailboxKey, env);
		// Capture the parked envelope *before* ringing: the doorbell triggers the
		// recipient's drain, which can unlink it before we re-read it, and the ack
		// must name the actually-parked envelope, not this fresh id.
		const parked =
			result === "duplicate" ? listPending(target.mailboxKey).find((i) => i.key === envelopeKey(env)) : undefined;
		// Ring before the duplicate early-return: a retry must still nudge a live recipient.
		if (target.paneId && target.paneId !== this.paneId) await ringDoorbell(target.paneId);
		if (result === "duplicate") {
			// A concurrent drain can still win the race; fall back to the sender's
			// dedupeId, the stable key that names the parked message (a duplicate
			// implies it is set, since the key defaults to the fresh envelope id).
			const existing = parked?.env ?? (opts.dedupeId ? { ...env, id: opts.dedupeId } : env);
			return { env: existing, ack: { ack: "duplicate", id: existing.id } };
		}
		return { env, ack: { ack: "mailboxed", id: env.id } };
	}

	/** Pane ids with a live IRC doorbell listener. */
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
	/** Resolve a name / `^^name` / session id / pane id to a mailbox destination. */
	resolveTarget: (ref: string) => Promise<IrcTarget | undefined>;
}

const ircScopeSchema = Type.Union(
	[Type.Literal("self"), Type.Literal("tab"), Type.Literal("workspace"), Type.Literal("all")],
	{ description: "send/roster: which agents to include (default workspace)" },
);

const ircModeSchema = Type.Union([Type.Literal("steer"), Type.Literal("followUp")], {
	description:
		'send: delivery mode while the recipient is busy. "steer" reaches it at its next step; "followUp" queues after the current answer.',
});

const ircSchema = Type.Object({
	action: Type.Union([Type.Literal("send"), Type.Literal("wait"), Type.Literal("roster")]),
	to: Type.Optional(
		Type.String({ description: 'send: target agent name, session id, or pane id, or "all" to broadcast' }),
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
				mailboxKey: a.session_id ?? a.pane_id,
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
			"Agent-to-agent messaging (IRC) between coding agents that run this extension. Messages are delivered to a durable per-agent mailbox, so a message to an agent that is not currently running waits until it next runs. `roster` lists reachable peers, `send` parks a message for a peer or broadcasts, and `wait` blocks for the next incoming message. Incoming messages are also injected into your session automatically, so you only need `wait` when you want to block for a reply.",
		promptSnippet: "Message other agents (IRC) and wait for replies",
		promptGuidelines: [
			"Use `irc` to talk to peer agents: `roster` to see who is reachable, `send` to message one (`to: <name|pane>`) or broadcast (`to: \"all\"`), `wait` to block for the next message.",
			"Incoming IRC messages are injected into your session automatically (steered mid-turn, or a follow-up when idle); a message is delivered exactly once, so `wait` only returns messages you did not already receive.",
			"`send` returns an ack per target (`mailboxed`/`duplicate`/`failed`). A `mailboxed` message is already durable, so do not resend it; only `failed` is worth retrying, and reuse the same `dedupeId`.",
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
				const targets: IrcTarget[] = [];
				if (!to || to === "all") {
					// Broadcast is not workspace-scoped: force scope "all" and union live
					// peers with the durable registry, so other workspaces and dormant
					// (no live pane) identities get a mailbox-only target too.
					targets.push(...broadcastTargets(await peers("all"), readIdentities(), node.paneId));
				} else {
					const resolved = await deps.resolveTarget(to);
					if (!resolved) throw new Error(`irc send: no agent named, at session, or at pane "${to}"`);
					targets.push(resolved);
				}
				const mailboxed: Array<{ to: string; id: string }> = [];
				const duplicate: Array<{ to: string; id: string }> = [];
				const failed: Array<{ to: string; mailboxKey: string; code: string; error: string }> = [];
				for (const t of targets) {
					try {
						const { env, ack } = await node.send(t, body, opts);
						const rec = { to: t.identity ?? t.mailboxKey, id: env.id };
						if (ack.ack === "mailboxed") mailboxed.push(rec);
						else duplicate.push(rec);
					} catch (e) {
						failed.push({
							to: t.identity ?? t.mailboxKey,
							mailboxKey: t.mailboxKey,
							code: "error",
							error: e instanceof Error ? e.message : String(e),
						});
					}
				}
				const out = {
					mailboxed,
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
