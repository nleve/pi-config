# IRC ⇄ Durable Vocabulary Spec

**Status:** draft — for implementation in Phase 3/4
**Author:** `w3:pH`
**Context:** `@earendil-works/pi-durable` semantics worth borrowing. IRC stays out-of-process; this only aligns vocabulary and makes the orchestrator's own IRC state durable when the orchestrator is Durable-backed.

---

## 0. Purpose / non-goals

- **Purpose:** stop Phase 3/4 from diverging from Durable's vocabulary; let a Durable-backed orchestrator survive its own restart without losing pending IRC work.
- **Non-goals:** IRC does **not** become Durable. It stays an out-of-process transport over per-agent unix sockets. There is no runtime-enforced ownership or abort across processes.

## 1. Substrate boundary (read first)

Durable is **one runtime** that owns conversation state. IRC is a **federation of autonomous OS processes** (`pi`/`omp`/`claude`/`codex`), each owning its own session.

- Semantics overlap ≈ **80%**.
- Substrate overlap ≈ **0%** — Durable cannot address a `claude` process's state.
- Therefore: IRC's exactly-once must be enforced **at the transport layer**. Durable only guarantees *no double-admission* once a submission reaches a conversation.

## 2. Envelope → Durable vocabulary

| IRC field | Durable primitive | Rule |
|---|---|---|
| `id` (UUID) | `requestId` (per conversation) | Pass the envelope id as `requestId` on submit. Durable dedups on `(conversationId, requestId)`, so one broadcast id → one delivery per recipient. **Keep IRC's own global ledger regardless.** |
| `from` | sender identity | `name ?? pane_id`. |
| `to` | recipient conversation | resolves target. |
| `body` | input content | — |
| `replyTo` | *no direct analogue* | Thread header only (see §6). |
| `ts` | — | — |
| **`mode`** *(new)* | `whenBusy` | `"steer" \| "followUp" \| "reject"` (see §3). |
| **`dedupeId`** *(new)* | — | idempotency key; defaults to `id`. |

## 3. Delivery modes

Current `irc.ts`: an incoming envelope either resolves a matching `wait`, or is injected — `steer` when busy, `followUp` + `triggerTurn` when idle. Durable's `SubmissionDraft.whenBusy` has three modes:

- `"steer"` — reach the recipient at its next step; interrupts remaining tools.
- `"followUp"` — queue after the current answer; starts a turn when idle.
- `"reject"` — **do not interrupt a busy recipient**; bounce to sender to retry later.

**Action:** add optional `mode` to `irc_send` / the envelope. Default = current behavior. Add `"reject"` so an orchestrator can fan out without interrupting busy workers and observe a retryable failure.

Also note: Durable `resolveSettings` defaults `steeringMode` and `followUpMode` to `"one-at-a-time"` — a burst of N messages becomes **N queued turns, not one**. Document IRC mailbox semantics to match, or state explicitly where they differ.

## 4. Exactly-once: two layers

- **Transport (IRC):** one socket write per envelope; `IrcNode.receive` delivers to exactly one sink (waiter XOR inject). At-most-once under transport failure (socket error → `send` throws, nothing delivered). **Retried sends MUST reuse the envelope id.**
- **Admission (Durable):** `requestId` makes a resubmission return the first submission — guards double-delivery when an orchestrator retries after a crash.

**Recommendation:** `irc_send` returns the envelope id and accepts an optional `dedupeId`. The recipient keeps a **bounded processed-id ring** (e.g. `LOG_CAP`) and drops repeats.

## 5. Durability of the orchestrator's own state

Today `IrcNode.waiters` + mailbox live in-process; an orchestrator crash loses pending sends/waits.

- **Plain pi orchestrator:** document the limitation. Consider persisting received-but-undelivered mail to the mailbox dir.
- **Durable-backed orchestrator:** model an outstanding send as a **Reporter-style task** (see durable example `23-subagent-background.ts`) with `requestId = envelope id`, so a crash resumes the wait and the peer answers exactly once.

## 6. Threading

- IRC `replyTo`: header metadata; recipient treats it as addressing. Fine.
- Durable **fork-at-message**: copy-on-write history, **in-process only**. Do **not** present IRC threads as Durable forks.
- If a herdr-side thread ever needs shared history, it must be shipped explicitly. IRC is message-passing, not shared state.

## 7. Ownership / abort: cooperative vs enforced

- **Durable:** abort a task → aborts what it owns, **bottom-up**, runtime-enforced, running each task's `abort` handler.
- **IRC:** peers are autonomous; there is **no single owner** and **no enforced abort**.
- **Rule:** an orchestrator "stops" a peer by sending a control envelope (e.g. `{ control: "stop" }`) that the peer honors **cooperatively**. Abort over IRC is best-effort. Do not claim Durable-grade teardown.
- **Corollary (accepted):** ownership ≠ recursion guard. Ownership is teardown; `-- -xt herdr` prevents unbounded fan-out. **Keep both.**

## 8. Roster / scope

`self | tab | workspace | all` are pure herdr concepts (panes/tabs/workspaces); Durable has conversations, not panes — **no analogue**. Keep as-is. Optionally add `conversationId` to peer entries so a Durable-backed orchestrator can correlate a peer with its conversation.

## 9. Proposed concrete changes to `irc.ts`

1. `IrcEnvelope`: add `mode?: "steer" | "followUp" | "reject"`; keep `id` as the idempotency key.
2. `IrcNode.send(toPane, body, replyTo?, mode?)` — include `mode`.
3. `IrcNode.receive`: maintain a bounded `Set` of processed ids; drop repeats (socket-layer dedup).
4. Delivery: honor `env.mode`; on `"reject"` while busy, respond with a rejection. **Note:** the transport is currently fire-and-forget (no ack), so `"reject"` needs a small **ack frame** on the same socket.
5. `irc` tool `send`: add optional `dedupeId` (default: new UUID).
6. Roster peers: add optional `conversationId` when the peer is Durable-backed.
7. Docs: publish the guarantee matrix (§10).

## 10. Guarantee matrix

| | while process alive | after crash |
|---|---|---|
| **transport delivery** | exactly-once (dedup ring) | in-flight lost; retry with same id |
| **admission to recipient** | exactly-once (`requestId`) | resumes if mediated by a durable task |
| **abort / teardown** | cooperative only | none |
| **history / threads** | header only | none shared |

## 11. Open questions

1. Is `reject` worth the ack frame, or keep fire-and-forget `steer`/`followUp` only?
2. Recipient dedup ring — implement, or require callers never to retry?
3. For a Durable-backed orchestrator: Reporter-style send task, or is a `codemode` `store()` ledger enough?
