# Herdr Orchestration for Pi — Goal

**Status:** Phases 1–3 complete (herdr control, event-driven results, IRC); Phase 4 design recorded; **workflow grouping + `workflow` progress view + panel labels + stage-completion notices landed; Phase 6 slice 4 (spawn-on-demand wake) next**
**Owner:** n
**Created:** 2026-10-01
**Location:** `~/.pi/agent/extensions/herdr/`

---

## North star

Make **pi a first-class orchestrator on top of herdr**: use pi's tool model (and
`codemode` for scripted fan-out) to spawn, drive, coordinate, observe, and
tear down multiple agents — `pi`, `omp`, `claude`, `codex`, … — across herdr
panes, tabs, workspaces, worktrees, and machines, with an agent-to-agent
messaging layer ("IRC") for peer coordination.

The end state: from one pi session, you can command a visible, human-steerable
swarm of coding agents, each in its own pane/worktree, coordinating through
typed messages, while pi itself stays a thin, auditable control plane.

---

## Why build this

- **pi has no built-in subagents, plan mode, or agent bus** (deliberate). herdr
  already provides the hard parts we'd otherwise reinvent: a persistent daemon,
  a socket API, an agent roster with lifecycle states, terminals/panes,
  worktrees, and cross-process (and cross-machine) transport.
- **omp's equivalent (eval kernel + `task` + `IrcBus` + `vibe`) is in-process.**
  It is elegant but confined to one process. herdr is out-of-process, so the pi
  version is strictly more capable — at the cost of latency and moving parts.
- **Observability.** Every agent is a real terminal pane the human can watch,
  attach to, and steer. Coordination is not hidden in a subprocess tree.
- **Heterogeneity.** The same control plane drives pi, omp, claude, codex, etc.

---

## Principles

1. **herdr is the cluster; pi is the control plane.** Do not reimplement herdr
   layout, theming, or process management. Wrap it.
2. **Wrap, don't guess.** Use the installed `herdr` CLI as the source of truth
   for syntax (`herdr --help`, `herdr <group> <cmd> --help`).
3. **Typed tools over string munging.** Expose a small, well-typed tool surface;
   parse herdr's JSON envelopes into structured results.
4. **JSON in / JSON out.** herdr control commands return `{id, result}` (or
   `{id, error}`). Surface `result`; fail loudly on `error` and non-zero exit.
5. **Degrade gracefully off-herdr.** When `HERDR_ENV !== "1"`, say so clearly
   instead of probing the focused session from outside (herdr's own rule).
6. **Keep the model-facing surface small.** One `herdr` tool with an action enum
   now; push high-fan-out orchestration into `codemode`, which scripts
   `tools.herdr(...)` and `tools.bash(...)`.
7. **No hidden spawning.** Everything created is a visible herdr pane/worktree.
8. **Read-only where it should be.** Mark roster/read/wait as `readOnlyHint`.

---

## Layered architecture

| Layer | Responsibility | Status |
|---|---|---|
| **L0** | herdr daemon + socket API + CLI (external) | available |
| **L1** | `herdr` tool — typed wrappers over agent/pane/workspace/worktree/notify | **Phase 1 (this)** |
| **L2** | `irc` messaging — roster + send + wait + mailbox injection into pi turns | Phase 3 |
| **L3** | Orchestration steering — `orchestrate`/`workflowz` keyword notices + codemode patterns | Phase 4 |
| **L4** | Optional: herdr-backed subagent tool, worktree isolation recipes | Phase 5 |

```
human / pi model
      │  tool calls
      ▼
 codemode (QuickJS)  ──►  herdr tool (L1)  ──►  herdr CLI/socket (L0)
      │                        ▲                     │
      └── tools.bash(...) ─────┘                     ▼
                                                 pi/omp/claude/codex panes
      irc tool (L2) ◄──────── mailbox ◄────────────┘
```

---

## Key facts & constraints

- **`codemode` is a QuickJS sandbox with tool-only reach.** No `import`, no
  `child_process`, no network. It calls other tools via `tools.<name>(args)`,
  lists them with `ALL_TOOLS`, persists JSON with `store()`/`load()`, and can
  run classifier models via `models.classify()`. So orchestration state lives in
  JSON and all effects go through tool calls (chiefly `herdr`, `bash`).
- **herdr agent identity.** `herdr agent list` does **not** expose a `name`
  field; the stable target for agent commands is the **pane id** (`w3:pJ`).
  `agent start` requires a name but it is not echoed in list/get output. Assume
  pane id is the canonical handle; keep our own name→pane map if needed.
- **herdr requires `HERDR_ENV=1`.** The CLI talks to the current session. Do not
  drive the focused session from outside herdr.
- **Agent states:** `idle`, `working`, `blocked`, `done`, `unknown`.
  `idle`/`done` both mean "ready for input".
- **The pi integration** (`herdr-agent-state.ts`, herdr-managed, v9) reports this
  pi pane's state and session ref over `pane.report_agent` /
  `pane.report_agent_session`, and reacts to the `herdr:blocked` event on
  `pi.events`. Do not edit it; build beside it.
- **pi extension API:** `registerTool`, `pi.on(...)` lifecycle events,
  `pi.sendMessage` / `sendUserMessage` (inject messages), `pi.events` (extension
  bus), `pi.registerCommand`, `pi.getActiveTools`/`setActiveTools`, exposure
  (`direct` | `codemode` | `deferred` | `hidden`), namespaces.

---

## Scoping model (agent isolation)

A herdr session holds agents that have nothing to do with each other. The
orchestration layer must not leak them into the model's context, and IRC must
not message them.

**Native boundaries.** herdr is `tab < workspace < session`. Every agent/pane
record carries `tab_id`, `workspace_id`, `pane_id`, and herdr's own
`AgentViewContext` is exactly `current_workspace_id | current_tab_id`. So
workspace/tab scoping is native and needs no extra state.

**Ruled out as group keys.** `report-metadata` tokens are *display-only* and do
not appear in `agent list` / `pane list` output. `agent.view.set` exists only on
the socket API (no CLI subcommand). Either could later scope the *human's* TUI
panel, but neither is usable for programmatic filtering today.

**Decision — `scope` on the `herdr` tool** (applies to `agents`/`panes`):

| scope | includes |
|---|---|
| `self` | only the calling pane |
| `tab` | the calling tab |
| `workspace` **(default)** | the calling workspace, **plus** agents this session spawned |
| `all` | every agent in the herdr session |

`workspace` is the default because it matches how the human already organizes
work, and the tool tracks its own spawned pane ids in-memory so workers placed
in their own workspace/worktree stay visible. Results carry `scope`, `total`,
`shown`, `hidden` so the model can tell that something was filtered out and ask
for `scope: all`.

**Cohorts are out of scope for now.** Cross-workspace swarms would need a group
key herdr does not expose (metadata tokens are display-only, `agent.view` is
socket-only, and `name` is in the API `AgentInfo` but omitted by the
`agent list` CLI). We deliberately stick to the four scopes above. IRC will
reuse the exact same `self|tab|workspace|all` scoping for its roster and
broadcast targets; `scope: all` is the escape hatch for anything that must span
workspaces.

**IRC is inherently opt-in.** Only agents running this extension expose a
socket, so unrelated agents are unreachable regardless of scope. Scope governs
what the *model sees* (roster) and what `irc_send`/broadcast *targets*.

---

## Scope

### Phase 1 — `herdr` tool (L1)  ✅ complete
- [x] Goal doc
- [x] `herdr` tool with actions:
  - roster: `agents`, `panes`
  - agent: `agent_get`, `agent_start`, `agent_prompt`, `agent_read`,
    `agent_wait`, `agent_send_keys`, `agent_rename`, `agent_focus`
  - pane: `pane_get`, `pane_read`, `pane_split`, `pane_run`, `pane_send_text`,
    `pane_wait_output`, `pane_close`, `pane_focus`
  - workspace: `workspace_create`, `workspace_list`, `workspace_close`
  - worktree: `worktree_list`, `worktree_create`, `worktree_open`,
    `worktree_remove`
  - misc: `notify`, `snapshot`, `raw` (escape hatch)
- [x] JSON unwrap + error surfacing, timeouts, abort propagation
- [x] Unit-tested `buildHerdrArgs` against the live CLI shapes
- [x] Smoke tested `agents`, `agent_read`, and the off-herdr guard end-to-end

### Phase 2 — spawn/isolation recipes  ✅
- [x] `spawn` action: create isolated workspace → `agent start` → optional prompt
- [x] End-to-end verified: spawned a pi agent in workspace `wV`, confirmed
  `interactive_ready`, then closed the workspace cleanly
- [x] Worktree-backed workers via `spawn mode=worktree` (shares the verified
  create→start flow; not yet live-tested)
- [x] **Recursion guard**: workers are started with `-- -xt herdr` so they cannot
  spawn their own subagents; `nested: true` opts out. Verified live.
- [ ] Orchestrator spawns N workers in one `codemode` cell (fan-out pattern)

### Phase 2.5 — event-driven settle & structured results  ✅
The old flow waited by sleeping in bash and read results by scraping the
terminal. Both are replaced.
- [x] `socket.ts` — herdr socket API client (`agent.get`, `events.wait`).
  `events.wait` is **level-triggered** (returns immediately if the condition
  already holds), so `waitForTurnSettled` baselines `state_change_seq` and waits
  for `idle` *after* it advances. No polling, no sleeps.
- [x] `session.ts` — parse a pi worker's session `.jsonl` and return its last
  completed assistant message (`stopReason: "stop"`; mid-turn is `"toolUse"`),
  with text/thinking/model/usage/cost. No terminal scraping.
- [x] `agent_result` action — wait for the turn to settle, then return the
  structured result. `since` (the `baseline_seq` returned by `spawn`) closes the
  pre-turn `idle` race.
- [x] `spawn wait:true` — blocks until the turn settles and inlines `status`,
  `baseline_seq`, `session_path`, and `result`.
- [x] Verified live: `spawn(wait:true)` returned `SUM=4 HERDR=unavailable` (guard
  held) with usage/cost. Found + fixed two bugs along the way: `--timeout` is
  rejected without `--wait`, and herdr says "timed out" (not "timeout").

### Phase 3 — `irc` messaging (L2)  ✅ complete
- [x] Envelope `{ id, from, to, body, ts, replyTo?, mode?, dedupeId?, expectsReply? }`;
      identity = agent name, else pane id
- [x] Transport: a durable per-identity **mailbox** (`mailbox.ts`, keyed by
      `session_id`) is the single delivery path; a unix socket at
      `$XDG_RUNTIME_DIR/pi-irc/<pane>.sock` is only a body-less doorbell. (Phase 3
      shipped socket-push; redesigned in Phase 6 slice 3 — see the log.)
- [x] One `irc` tool with actions `send` (name/session/pane, or `all` broadcast
      within scope), `wait` (blocking, `from` filter, timeout), `roster`
- [x] Reuses `self|tab|workspace|all` scope for roster/broadcast (no cohorts)
- [x] Delivery into the live session via `pi.sendMessage`: `steer` when busy,
      `followUp`+`triggerTurn` when idle; a matching `irc_wait` wins instead.
      `mode: "reject"` is gone — a busy recipient simply defers.
- [x] Ack protocol: per-target `mailboxed | duplicate | failed`; a `mailboxed`
      message is already durable (never resend), only `failed` is retried
- [x] Dedup/idempotency: `link(2)` publish makes a retry with the same
      `dedupeId ?? id` a `duplicate`; the seen ring
      (`~/.pi/agent/pi-irc-seen/<session>.seen`, durable) suppresses repeats.
      The mailbox file is unlinked only once the message is confirmed in the
      session transcript (`ctx.sessionManager.getEntries()`), so a crash
      re-delivers rather than drops (at-least-once). Stale rings/mail reaped.
- [x] Socket self-heal: re-binds if its socket file disappears (15s guard)
- [x] Verified live: worker `w16:p1` received an injected message, replied with
      `irc send`, orchestrator `w3:pJ` received `{from:"ircworker", body:"PONG"}`;
      plus a live `w3:pJ` ↔ `w3:pH` exchange
- [x] Regression tests: `test/irc.test.ts` (8 cases incl. crash-window + reaping)
- [x] ~~Treat herdr `blocked` as busy~~ — dropped: `deliverAs` is only consulted
      while streaming, and a mid-turn block is already covered by pi's own
      `agent_start`/`agent_settled`; nothing here even emits `herdr:blocked`
- [ ] Persist *unread* mail across restart — deferred (delivered mail is durable
      in the session `.jsonl`; the dedup ring is already durable)

### Phase 4 — orchestration steering (L3)
- [ ] Durable-as-orchestrator driving herdr agents (checkpointed
      prompt→settle→result, ownership teardown) — primary direction
- [ ] `orchestrate` / `workflowz` keyword notices (per-turn hidden system notice)
- [x] **Workflow grouping**: `group` + `stage` on `spawn`/`agent_start` → one
      shared herdr workspace per group, one tab per stage, deterministic
      `<group>-<stage>-<n>` names, and `group`/`stage` surfaced in the roster
- [x] **`workflow` progress view**: one action folds the live agent statuses +
      durable registry into per-group/per-stage counts and a
      `working|blocked|done` status; `agents` accepts a `group` filter
- [x] Panel labels: grouped workers get `pane report-metadata` `<group>/<stage>`
      (+ `group`/`stage` tokens), the workspace gets `workspace report-metadata`
      (`group`, `stages`), and each worker re-asserts its own label every turn
- [x] Stage-completion notices: a deduped `herdr notification show` fires when
      every worker in a stage is idle/dormant (opt out with `notify:false`)
- [ ] Canonical patterns: fan-out, poll-until-state, gather, verify
- [ ] Budget/`todo` integration

#### Phase 4 design — the Durable seam

**Three layers, each owning its own durability.** pi-durable is added as a
control plane *above* the existing adapters; it does not replace them.

| Layer | Role | Owns |
|---|---|---|
| **Durable** | durable control plane — task graph, ownership, `resume()`, `requestId` exactly-once admission | the orchestrator's *own* state |
| **herdr** | process/terminal substrate — spawn/drive/observe agents, worktrees | the external agents' lifecycle |
| **IRC** | cross-process transport — messaging between autonomous agents | delivery between processes |

**What pi-durable replaces vs what stays hand-rolled:**

| Concern | Today (hand-rolled) | With pi-durable |
|---|---|---|
| Orchestrator state (which workers, which step, what's pending) | in-memory `spawned` set | **replaced** — checkpointed task graph |
| Resume after the orchestrator crashes | none | **replaced** — `resume()` |
| Teardown | manual `workspace close` | **replaced** — ownership trees |
| Exactly-once *submission* | n/a | **added** — `requestId` (per-conversation) |
| **Settle edge** — "is the external agent done?" | `state_change_seq` + `agent.wait` | **stays** — Durable cannot observe another OS process |
| **Result extraction** | session `.jsonl` parsing | **stays** for heterogeneous agents (claude/codex/omp) |
| **IRC transport exactly-once** | dedup ring + ack | **stays** — `requestId` is admission into one conversation, not cross-process transport |

The hand-rolled pieces are wrapped as Durable tasks (e.g. a `herdr.prompt` task
whose body uses `baseline_seq` + `.jsonl` parsing), not deleted. The one thing
Durable would fully retire is the in-memory bookkeeping and manual teardown.

**Two layers to build, in order:**
- **(a) Ergonomics (no new deps).** `orchestrate` / `workflowz` keyword notices
  that steer pi to delegate, plus canonical codemode recipes (fan-out,
  poll-until-state, gather, verify) over the existing `herdr` + `irc` tools.
- **(b) The Durable harness.** Install `pi-durable`; express a job as Durable
  tasks so a crash mid-fan-out resumes. This is where the durability, teardown,
  and exactly-once benefits actually come from.

**Benefits:**
1. One instruction instead of N — fan-out + gather + verify in a single call.
2. Crash-resumable multi-agent work — resume from the last checkpoint.
3. Clean teardown, no orphaned workspaces — ownership trees.
4. Exactly-once coordination — dedup ring + ack + `requestId`.
5. Structured, verifiable results — typed results, no terminal scraping.
6. Reusable, tested patterns — named recipes, not ad-hoc codemode each time.

**Starting kit already in place:** `agent_result` / `baseline_seq` (the settle
edge), `IRC-DURABLE-SPEC.md` (vocabulary), and Durable examples 22/23/24
(task/ownership templates).

### Phase 5 — optional
- [x] herdr-backed subagent tool with typed results (via `agent_result` + the pi
  session transcript)
- [ ] `apply`/`merge` handoff for worktree workers
- [x] Workflow pattern: one workspace per phase (dynamic agents), orchestrator
  owns the plan and gathers each phase's structured result

### Phase 6 — dynamic agents & durable identity  🚧 active

The user's direction: **dynamic, on-the-fly agents are more useful than
predefined ones.** The `^` affordance (borrowed from omp) fits that. Cross-harness
is dropped (see Non-goals): **every worker is a pi agent**, which is what makes
durable identity possible at all.

**Syntax (typed by the user in a prompt):**
- `^<selector>[:<level>]` — declare a *new* delegate spec (model + thinking).
  Resolved against the session model catalogue, persisted branch-locally, and
  compiled by the `herdr` tool to `--model <provider>/<id> [--thinking <level>]`.
- `^^<name>` — address a named worker. The picker labels live workers separately
  from dormant, IRC-only workers. Mail to a dormant worker waits for it to run
  again; it does not wake it. (`@` is already Pi's file reference sigil.)
- Resolved mentions are highlighted inline in the composer and transcript.
  The underlying prompt and caret syntax stay editable, and model-facing
  routing details don't appear in the transcript. Starting a worker shows
  `Started ^^name`; parking mail for an offline worker shows `Queued for ^^name`.

**Build order (each slice useful alone):**
1. **Pi-only + model/thinking + `^` delegates** — *in progress*
   - [x] Record this thread in the goal doc
   - [x] Drop `kind` from the model-facing schema; all workers are pi
   - [x] First-class `model` + `thinking` on `spawn` / `agent_start`
   - [x] `delegates.ts`: `^selector[:level]` input interception, catalogue
         resolution, `pi.appendEntry` persistence, legend injection
   - [x] Auto-generated worker codenames (`names.ts`) when `name` is omitted
   - [x] `^` / `^^` autocomplete (`ctx.ui.addAutocompleteProvider`): `^` suggests
         the model catalogue, `^^` suggests live registry names
   - [x] `^model:` autocomplete suggests supported thinking levels; literal
         model IDs with colons remain selectable
   - [x] `^^name` expands to a live pane or a dormant IRC-only destination;
         recognized mentions are styled in place, not followed by a receipt
2. **Name registry** — 🚧 started
   - [x] `registry.ts`: per-pane identity files written by every pi (so an agent
         the human started directly is included), dead-pid pruning
   - [x] `agents` output + IRC roster enriched with `name` / `model` /
         `session_path`
   - [x] `^^name` (or a bare registered name) resolves to a pane id for
         `target`; `irc send to:"name"` works
   - [x] `--name <codename>` passed to spawned workers; a top-level agent with
         no session name gets a generated codename via `pi.setSessionName`
   - [x] **Native herdr name**: self-assert `AgentInfo.name` via `agent rename`
         (adopt an existing name, else claim a unique one; retry past agent
         detection; reconcile on first `agent_start` after a mid-run reload) -
         this is the field the agents panel renders
   - [x] rich panel metadata: `pane report-metadata --title <project>
         --display-agent <name> --token project=<dir>` (source `pi-herdr-ext`,
         `--agent pi` guard, 24 h TTL), refreshed on session start / turn start
   - [ ] cluster-wide uniqueness / collision policy (first-wins today)
3. **Durable inbox** — ✅ message an offline identity; delivered when it next
   runs. Landed as the pure-mailbox redesign: `mailbox.ts` (durable, keyed by
   session id, atomic `link` publish), doorbell sockets, and
   confirm-before-unlink delivery. The durable registry is now keyed by
   `session_id` with computed liveness (a closed session stays *dormant*, not
   deleted) so a named identity outlives its pane. Spawn-on-demand wake (slice 4)
   is next.
4. **Spawn-on-demand wake** — `irc send` to a dormant `name` resumes its pi
   session (`--session <path>`) in a fresh pane and delivers the message. Needs
   single-owner locking, a boot-cost policy, and GC.

**Files:** `delegates.ts` (`^` parsing + registry), `names.ts` (codenames),
`registry.ts` (live identity files), `test/delegates.test.ts`,
`test/registry.test.ts`.

**Identity is the through-line.** `herdr agent list` exposes
`agent_session.value` (the pi transcript path) for every live agent — that path
*is* the durable identity. pi-only is the enabling decision: a non-pi pane has no
resumable transcript, so wake-on-message cannot exist.

---

## Non-goals

- Reimplementing herdr's TUI, layout, theming, or session persistence.
- Setting up cross-machine auth/SSH (we use `--machine` / `--remote` if present).
- **Cohorts / cross-workspace membership groups.** Scoping stays `self | tab |
  workspace | all`; `scope: all` covers anything that must span workspaces.
- A general distributed-systems framework. Stay pragmatic and observable.
- **Cross-harness agents (omp/claude/codex/…).** Non-goal. Every worker is a pi
  agent; the model-facing surface drops `kind`. Cross-harness would forfeit
  structured results, IRC, and durable identity.
- Editing herdr-managed files (`herdr-agent-state.ts`).

---

## Interfaces (contract sketch)

`herdr` tool — single tool, `action` enum + optional typed params:

```
action: "agents" | "agent_get" | "agent_start" | "spawn" | "agent_prompt" |
        "agent_read" | "agent_wait" | "agent_result" | "agent_send_keys" |
        "agent_rename" | "agent_focus" | "panes" | "pane_get" | "pane_read" |
        "pane_split" | "pane_run" | "pane_send_text" | "pane_wait_output" |
        "pane_close" | "pane_focus" | "workspace_create" | "workspace_list" |
        "workspace_close" | "worktree_list" | "worktree_create" |
        "worktree_open" | "worktree_remove" | "notify" | "snapshot" | "raw"
scope: "self" | "tab" | "workspace" | "all"   # agents/panes; default workspace
since: number            # agent_result: settle baseline (state_change_seq)
model: string            # agent_start/spawn: provider/id selector OR a ^delegate token
thinking: string         # agent_start/spawn: off|minimal|low|medium|high|xhigh|max
agentArgs: string[]      # agent_start/spawn: extra pi CLI args passed after --
nested: boolean          # spawn: allow the worker to spawn its own subagents
# name is auto-generated when omitted (memorable codename, not the model name)
```

`irc` tool (`irc.ts`, imported by `index.ts`) — one tool, `action` enum:

```
action: "send" | "wait" | "roster"
to: string        # send: agent name | session id | pane id | "all" (broadcast)
body: string      # send
replyTo: string   # send: id of the message being replied to
mode: "steer" | "followUp"   # send: delivery while recipient is busy (no reject)
dedupeId: string  # send: idempotency key (default: envelope id); reuse on retry
from: string      # wait: only accept messages from this identity
scope: "self" | "tab" | "workspace" | "all"   # send/roster; default workspace
timeout: number   # wait; default 120000
# send returns: { mailboxed, duplicate?, failed? }[]  (mailboxed = durable, do not resend)
# message files: ~/.pi/agent/pi-irc-mail/<session_id>/<dedupeId ?? id>.json
# seen rings:    ~/.pi/agent/pi-irc-seen/<session_id>.seen
```

---

## Status log

- **2026-10-01** — Goal written. herdr/pi integration confirmed installed (v9).
  Captured CLI surface. Starting Phase 1 (`herdr` tool).
- **2026-10-01** — Phase 1 complete. `herdr` tool (`index.ts` + `client.ts`)
  registered with 28 actions. `buildHerdrArgs` verified against live CLI shapes;
  `agents` + `agent_read` + off-herdr guard smoke tested through a real pi run.
- **2026-10-01** — Phase 2 spawn verified. Pulled herdr's API schema (`herdr api
  schema --json`) to confirm response shapes (`workspace_created` /
  `worktree_created` → `root_pane.pane_id`; `agent_started` → `agent`). Added the
  `spawn` action. Live-tested `spawnAgent` → workspace `wV` / pane `wV:p1` /
  agent `smoketest` (`interactive_ready: true`), then closed it; roster returned
  to baseline. Note: `AgentInfo` in the API includes `name`; the CLI `agent list`
  output omits it.
- **2026-10-01** — Scoping added. `scope` on `herdr` (`self|tab|workspace|all`,
  default `workspace`) filters `agents`/`panes`; workspace scope always keeps
  session-spawned children. Unit-tested all four levels + spawned-inclusion, and
  smoke tested through pi. Ruled out metadata tokens / `agent.view` as group
  keys (display-only / socket-only). Cohorts intentionally out of scope for now;
  IRC will reuse `self|tab|workspace|all`.
- **2026-10-01** — Tool docs made self-contained. The agent may not know what
  herdr is, so `description`, `promptSnippet`, and `promptGuidelines` now define
  it (a tmux-like terminal workspace manager hosting many agents, organized as
  workspaces → tabs → panes, one agent per pane) before describing actions. pi
  renders the snippet as the `- herdr: …` line in the system prompt tools list
  and the guidelines as bullets in the `<rules>` section.
- **2026-10-01** — Live orchestration trial (workspace mode). `spawn` created
  workspace `wW` / pane `wW:p1`, booted a `pi` worker, and submitted a task in
  one call; the worker wrote the correct artifact and replied `DONE <hash>`
  (independently verified). `agent_read` returned the full worker transcript
  (tool calls + final answer + cost/model status line). Scoping verified live:
  `tab` hid the 2 unrelated `omp` agents (`shown: 3, hidden: 2`) while the
  session-spawned worker stayed visible under `workspace` scope. Then closed
  `wW`; roster returned to baseline.
  Findings to act on:
  1. **`agent_wait` on `idle` races** — right after `agent_prompt` the agent is
     still `idle` for a beat, so waiting for `idle` returns immediately. Need a
     "turn settled" primitive (wait for `working` → `idle`, or wait on a
     sentinel via `pane_wait_output`).
  2. **Terminal scraping is lossy** — `agent_read` includes TUI chrome. But
     `agent_start` returns `agent_session.value` (the pi session `.jsonl`), which
     is a structured result channel; use it for typed results in Phase 5.
  3. **`workspace` scope only isolates if unrelated work lives in other
     workspaces** — the user's unrelated agents share `w3` with the orchestrator,
     so `workspace` hid nothing; `tab`/`self` are the tighter levers. Revisit the
     default (maybe `tab`).
  4. **Recursion risk** — spawned pi workers inherit the full config and thus
     the `herdr` tool, so a worker can spawn its own workers. Consider a guard.
- **2026-10-01** — Phase 2.5 complete; all four findings above addressed.
  Added `socket.ts` (`agent.get` + `events.wait`) and `session.ts` (pi session
  `.jsonl` parser), plus the `agent_result` action and `spawn wait:true`.
  Discovered `events.wait` is level-triggered, so settle uses a
  `state_change_seq` baseline. Recursion guard is `-- -xt herdr` (pi's tool
  denylist, forwarded by herdr after `--`); `nested: true` opts out.
  Verified out-of-process (live session needs `/reload` for the new actions):
  `spawn(wait:true)` returned `SUM=4 HERDR=unavailable` with model/usage/cost.
  Two bugs fixed: `--timeout` requires `--wait` on `agent_prompt`, and herdr's
  timeout text is "timed out". Latency note: a cold pi worker round-trip
  (create → boot → turn → settle) measured ~52s, dominated by pi boot + model.
- **2026-10-01** — Phase 3 (IRC) core complete. Added `irc.ts` (per-agent unix
  socket transport + `irc` tool) and wired it into `index.ts` (busy tracking via
  `agent_start`/`agent_settled`, delivery via `pi.sendMessage`). `agent_prompt`
  now returns `baseline_seq` so the prompt→result flow is race-free.
  Verified live end-to-end: worker `w16:p1` got an injected message and replied
  `irc send`, orchestrator `w3:pJ` received `{from:"ircworker", body:"PONG"}`.
  Bugs found + fixed along the way:
  1. `listAgents` returned the scope object (`{shown,...}`) instead of `.shown`,
     which broke roster/send ("agents is not iterable", "all.find is not a
     function").
  2. herdr reports a finished turn as `idle` **or** `done` (`agent explain` says
     `idle` while `agent get` may say `done`), so settle now uses the socket
     `agent.wait` API with `until: ["idle","done"]`.
  (Resolved in the next entry: `blocked`-as-busy dropped; unread persistence
  deferred.)
- **2026-10-01** — IRC hardened + Durable research (collaboration with peer agent
  `w3:pH`). Per `IRC-DURABLE-SPEC.md`: added delivery `mode`, `dedupeId`, a
  **persisted** dedup ring (durable path, at-least-once), an ack protocol, a
  socket self-heal, and `test/irc.test.ts` (8 cases). Two peer catches mattered:
  the ring must live in a durable dir (an over-broad test `rm` had unlinked the
  live sockets, proving the point) and the ordering should be at-least-once for
  coordination. Studied `@earendil-works/pi-durable@1.0.0`: `ExecutionEnv` is an
  open `FileSystem`+`Shell` interface, but it is a **stateless exec shape**, so
  herdr *panes* map (opt-in) while herdr *agents* do not. Its default
  `toolExecution: "parallel"` and unlocked `bash` mean a pane-backed `Shell.exec`
  needs a process-global per-pane mutex (probe: 1 vs 3 concurrent; cross-talk
  damage demo). Decision: shelve the pane-as-ExecutionEnv wrapper as opt-in; the
  valuable seam is **Durable-as-orchestrator driving herdr agents**.
- **2026-10-01** — Incoming-message rendering no longer demands a reply (peer
  `w3:pH`, following `omp`: `src/irc/bus.ts` "Replaces the old auto-reply model").
  `formatIrcForModel` now renders `[id] from (reply to …)` and states the reply
  mechanism **conditionally** ("If a response is expected…") instead of the
  unconditional "Reply with the irc tool: …", which could make two idle agents
  ping-pong. Added `expectsReply?: boolean` end-to-end (envelope, `send`, tool
  schema, render) — true asks, false marks FYI, unset lets the recipient decide —
  plus `promptGuidelines` against needless replies. Tests 8 → 12.
- **2026-10-01** — Documented the Phase 4 design (the Durable seam) in the
  Phase 4 section: the three-layer boundary (Durable control plane / herdr
  substrate / IRC transport), the replace-vs-keep table, the (a)/(b) build order,
  and the benefits. Direction unchanged — this records the reasoning so it is
  not reconstructed from scratch later.
- **2026-10-01** — Phase 6 opened (dynamic agents & durable identity). Two
  decisions from the user: (1) **drop cross-harness** — every worker is pi; the
  `kind` field and per-kind arg mapping go away, and this is now an explicit
  non-goal; (2) pursue **dynamic agents** expressed inline in the prompt via `^`,
  with `^^` reserved for existing worker instances (`@` is taken by pi file
  refs). Recorded the full build order (pi-only + model/thinking + `^` delegates
  → name registry → durable inbox → spawn-on-demand wake). Key enabling find:
  `herdr agent list` exposes `agent_session.value` (the pi transcript path) for
  every live agent, so a name can map to a durable, resumable identity. Started
  slice 1.
- **2026-10-01** — Phase 6 slice 1 landed. `delegates.ts` resolves
  `^selector[:level]` against the session catalogue (`ctx.scopedModels` or
  `modelRegistry.getAvailable()`), persists each first mention via
  `pi.appendEntry("herdr_delegate", …)` (resume/rewind-safe `sync()`), and
  appends a legend so the model knows the token's `provider/id` + supported
  levels. `index.ts` wires the `input` event (skips extension-sourced and
  `!`/`$` drafts; unknown tokens stay literal), drops `kind` from the schema
  (all workers are pi), and adds first-class `model`/`thinking` that compile to
  `--model`/`--thinking`. `names.ts` mints `adjective-noun` codenames when
  `name` is omitted, so workers are addressable without the model name.
  `test/delegates.test.ts` covers parse/resolve/expand/sync (both suites pass);
  the extension loads clean under `pi -ne -e …`. Remaining in slice 1: `^`/`^^`
  autocomplete.
- **2026-10-01** — Phase 6 slice 2 started (name registry), in response to the
  question "does a top-level agent get a worker name?" Answer: no — a pi the
  human started directly has `name: undefined` even via the socket, and the CLI
  omits names entirely; only `terminal_title` (`π - mdjev`) hints at identity.
  But `agent_prompt` / `agent_result` / `irc send` already work on any pi by pane
  id (verified: `agent_result` returned model + last message for two live
  top-level sessions), so the only gap was a stable, discoverable handle.
  Added `registry.ts`: every pi self-registers a per-pane identity file
  (`name`, `session_path`, `model`, `thinking`, `cwd`, `pid`), pruned on dead
  pid. `agents` and the IRC roster now join it in; `^^name`/bare names resolve to
  pane ids; spawned workers get `--name`, and a top-level session with no name
  gets a codename + `setSessionName` (so the title shows it). Verified live by
  booting a throwaway worker: it registered as `regtest` with model/thinking/
  session path, then the workspace was closed. `test/registry.test.ts` passes.
- **2026-10-01** — Native herdr naming (agents panel). Investigated what herdr
  exposes: the panel renders `AgentInfo.name`, set by `agent start <name>` or
  `agent rename <target> <name>` (pattern `[a-z][a-z0-9_-]{0,31}`, unique among
  live agents, follows the pane occupant, cleared when the agent exits). Also
  found the self-service `pane report-metadata` channel (`title` /
  `display_agent` / `state_labels` / `tokens`, `--source` + `--ttl-ms`) and
  `workspace report-metadata` (tokens). The herdr-installed pi integration
  (`~/.pi/agent/extensions/herdr-agent-state.ts`, source `herdr:pi`) reports
  session + state but no name. Wired self-assertion in: on `session_start` (and
  on the first `agent_start` after a mid-run reload) every pi adopts herdr's
  existing name or claims a unique one via `agent rename`, and the registry
  follows it. Verified live: a bare `pi` in a fresh pane self-named
  `clever-moth`, and `agent list` reported it. The orchestrator pane w3:pP now
  shows `vivid-gull` (`herdr agent rename w3:pP --clear` to undo).
- **2026-10-01** — Answered "does `^`/`^^` work?": `^selector` runtime expansion
  was already implemented (input hook), but `^^name` in prompt text was only a
  reserved sigil (never resolved), and there was **no composer autocomplete** -
  which is why it "doesn't seem to work". Implemented both: a
  `ctx.ui.addAutocompleteProvider` wrapper that suggests models for `^` and live
  registry names for `^^` (with pane/project descriptions), and `^^name` prompt
  expansion to a resolved-pane legend. Also added the **project/dir in the
  panel** using herdr's "custom status labels" (`pane report-metadata --title
  <project> --display-agent <name> --token project=<dir>`, source
  `pi-herdr-ext`, `--agent pi`, 24 h TTL). Verified live: a bare pi in
  `/home/n/src/oh-my-pi` reported `name=vivid-maple title=oh-my-pi
  tokens={project: oh-my-pi}`. All four live sessions self-registered native
  names (`cosmic-tiger`, `grand-condor`, `coral-tiger`, `vivid-gull`).
  `findInstanceRefs` unit-tested; all suites + load check pass.
- **2026-10-01** — Fixed `^` autocomplete eating the caret (reported live). Model
  suggestions inserted a bare id as their completion `value`, so they fell
  through to pi's built-in provider, which treated the caret as its own prefix
  and dropped it; `^^` items already carried their sigil and worked. Model items
  now insert `^<selector>` and both paths splice via a shared, unit-tested
  `replaceMention()`.
- **2026-10-01** — Live `^^coral-tiger` check-in exposed an IRC delivery bug. The
  send reached coral-tiger (injected as a follow-up) and it replied, but the
  reply never reached this session: `deliver` picked `deliverAs: "steer"` when
  the recipient was busy and paired it with `triggerTurn: true`, a combination pi
  silently drops (the sender still got a `queued` ack). Fixed: `steer` only when
  explicitly requested *and* busy (no `triggerTurn`); otherwise `followUp` +
  `triggerTurn`, with the promise `.catch`-logged. Note for the operator: `irc
  wait` is usually redundant — incoming messages are injected automatically and
  exactly once, so `wait` only returns ones that arrive before it starts.
- **2026-10-01** — Phase 6 slice 3 landed: **pure-mailbox IRC** (redesign agreed
  after a robustness review found socket-push unsound). Findings that drove it:
  (1) `pi.sendMessage` may resolve after only queueing in memory
  (`agent-session.ts` `sendCustomMessage`), so "deliver then unlink" could lose a
  message on crash; (2) `name` is a display handle and pane ids recycle, so the
  durable key must be `session_id`; (3) socket-push + mailbox-fallback is two
  exactly-once stores. New design: `mailbox.ts` (one durable file per message,
  `link(2)` publish so `EEXIST` *is* the idempotency check, `dedupeId ?? id`);
  sockets are body-less doorbells; the recipient drains on bind, on every
  connection, on `session_start`, and after `agent_settled`; a message is
  unlinked only once confirmed present in the session transcript. `mode: reject`
  was dropped (a busy recipient defers). Registry is now durable and
  `session_id`-keyed with computed liveness, and identity is no longer deleted on
  shutdown (dormant identities are addressable). Files: `mailbox.ts`, `irc.ts`,
  `registry.ts`, wired in `index.ts`; `test/mailbox.test.ts` + rewritten
  `test/irc.test.ts` (both pass), all four suites green, factory load check
  registers `irc` + `herdr`. Slice 4 (spawn-on-demand wake) is the next step and
  needs the in-flight/GC work noted above.
- **2026-10-01** — Phase 4 groundwork: **workflow grouping** (`group` +
  `stage` on `spawn`/`agent_start`). A group gets one herdr workspace
  (`workspace create --label <group> --no-focus`) and one tab per stage
  (`tab create --label <stage>`); the first worker reuses the workspace's
  initial tab (renamed to the stage), later ones `pane split` inside it. Names
  derive deterministically as `<group>-<stage>-<n>` (`names.ts: stageName`),
  and the spawner stamps `group`/`stage` into the worker's `session_id`-keyed
  identity (`registry.ts: setIdentityGrouping`), so the roster
  (`withIdentities`) reports them. `agent start` focuses the new pane and herdr
  has no `--no-focus` for it, so grouped spawns capture and restore the human's
  focused workspace (`focusedWorkspaceId`/`restoreFocus`). Unit tests cover
  grouping persistence + name derivation; live-tested two stages → workspace
  `w1G` with tabs `dig`/`critique`, workers `wftest2-dig-1` /
  `wftest2-critique-1`, and the human's focus unchanged.
- **2026-10-01** — Phase 4 follow-ups (workflow slices 2–3). **`workflow`
  action** folds live `agent list` statuses + the durable registry into
  per-group/per-stage counts and a `working|blocked|done` status (dormant
  members count too); `agents` gained a `group` filter. `workflow.ts` holds the
  pure aggregation + the report-metadata argv builders; `test/workflow.test.ts`
  covers folding, filters, argv, and the completion dedup. **Panel labels**: a
  grouped worker's pane gets `pane report-metadata --title <group>/<stage>
  --token group/stage`, the shared workspace gets `workspace report-metadata
  --token group/stages`, and `reportPanel` now re-reads the worker's own
  registry identity so the label survives the worker's next turn or a reload
  (the orchestrator's push alone would be clobbered by the worker's own
  refresh). **Stage-completion notices**: a deduped `herdr notification show`
  fires when every member of a stage is idle/dormant, via `StageNotifier`
  (keyed by member count, so a grown stage re-notifies; opt out with
  `notify:false`). Live-tested: group `wf3` with stages `dig`/`judge` → tabs
  `dig`(2)+`judge`(1), pane titles `wf3/dig`+`wf3/judge` with tokens, workspace
  tokens `{group: wf3, stages: "judge,dig"}`, aggregation reported `dig: done
  (2 idle)`, focus stayed on `w3`; all five suites + bundle green, artifacts
  cleaned up.
