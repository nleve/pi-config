/**
 * Durable agent mailbox — the single delivery path for IRC.
 *
 * Pure-mailbox design (see GOAL.md Phase 6): a message is a file in the
 * recipient's mailbox, keyed by the recipient's *session id* (the durable
 * identity — panes are recycled, names are display handles). The socket is only
 * a doorbell: it tells a live recipient "you have mail" and triggers a drain.
 *
 * Why a file per message:
 *   - one writer per file (the sender), so no locking;
 *   - `link(2)` publishes atomically and fails with EEXIST, which *is* the
 *     idempotency check (`dedupeId ?? id`), so a sender retry cannot double-send;
 *   - the recipient unlinks only after the message is confirmed in the session
 *     transcript, so a crash re-delivers instead of losing the message.
 *
 * Everything lives under the home dir, never `XDG_RUNTIME_DIR`: mail must
 * survive a reboot, unlike sockets.
 */

import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IrcEnvelope } from "./irc.ts";

/** Root of all mailboxes. Durable path (not the ephemeral socket dir). */
export function mailRoot(): string {
	return process.env.PI_IRC_MAIL_DIR ?? path.join(os.homedir(), ".pi", "agent", "pi-irc-mail");
}

/** Filesystem-safe form of an identity/session id. */
function safeKey(value: string): string {
	return value.replace(/[^\w.-]/g, "_");
}

export function mailboxDir(mailboxKey: string, root = mailRoot()): string {
	return path.join(root, safeKey(mailboxKey));
}

export function messagePath(mailboxKey: string, key: string, root = mailRoot()): string {
	return path.join(mailboxDir(mailboxKey, root), `${safeKey(key)}.json`);
}

export interface MailboxItem {
	/** `dedupeId ?? id` — the idempotency/filename key. */
	key: string;
	env: IrcEnvelope;
}

/** The dedup/idempotency key for an envelope. */
export function envelopeKey(env: IrcEnvelope): string {
	return env.dedupeId ?? env.id;
}

export type EnqueueResult = "enqueued" | "duplicate";

/**
 * Atomically publish an envelope into a mailbox. Returns `"duplicate"` if the
 * key is already present (a retry), `"enqueued"` otherwise. Safe to call
 * concurrently: `link()` is the arbiter.
 */
export function enqueue(mailboxKey: string, env: IrcEnvelope, root = mailRoot()): EnqueueResult {
	const dir = mailboxDir(mailboxKey, root);
	mkdirSync(dir, { recursive: true });
	const key = envelopeKey(env);
	const final = messagePath(mailboxKey, key, root);
	if (existsSync(final)) return "duplicate";
	const tmp = path.join(dir, `.${safeKey(key)}.${process.pid}.${Date.now()}.tmp`);
	const fd = openSync(tmp, "wx");
	try {
		writeSync(fd, `${JSON.stringify({ key, env })}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(tmp, final);
		return "enqueued";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "duplicate";
		throw error;
	} finally {
		rmSync(tmp, { force: true });
	}
}

/** Pending envelopes in a mailbox, oldest first. Skips unreadable files. */
export function listPending(mailboxKey: string, root = mailRoot()): MailboxItem[] {
	let files: string[];
	try {
		files = readdirSync(mailboxDir(mailboxKey, root));
	} catch {
		return [];
	}
	const out: MailboxItem[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(readFileSync(path.join(mailboxDir(mailboxKey, root), file), "utf8")) as MailboxItem;
			if (parsed && parsed.env && typeof parsed.env.body === "string" && typeof parsed.key === "string") {
				out.push(parsed);
			}
		} catch {
			// A partial file (killed between open and link) would be a `.tmp`,
			// never a `.json`; anything malformed here is safest to drop.
			rmSync(path.join(mailboxDir(mailboxKey, root), file), { force: true });
		}
	}
	out.sort((a, b) => a.env.ts - b.env.ts || a.key.localeCompare(b.key));
	return out;
}

/** Remove a delivered envelope. Idempotent. */
export function removeMessage(mailboxKey: string, key: string, root = mailRoot()): void {
	rmSync(messagePath(mailboxKey, key, root), { force: true });
}

/** Reap mailbox contents not touched within `ttlMs` (undeliverable identities). */
export function sweepMailboxes(ttlMs: number, root = mailRoot()): void {
	let identities: string[];
	try {
		identities = readdirSync(root);
	} catch {
		return;
	}
	const now = Date.now();
	for (const identity of identities) {
		const dir = path.join(root, identity);
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			try {
				if (now - statSync(path.join(dir, file)).mtimeMs > ttlMs) {
					unlinkSync(path.join(dir, file));
				}
			} catch {
				// raced with a drain; fine
			}
		}
	}
}
