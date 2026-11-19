# Pi Workers (stock Herdr)

| Intent | Use |
| --- | --- |
| Give a model a new assignment | `delegate({ model: "^model:medium", label: "Rate limits", task: "..." })` |
| Collect an assignment later | `delegate_result({ ticket: "..." })` |
| Talk to a worker that already exists | `irc({ action: "send", to: "^^auth-rate-limits", body: "..." })` |
| Inspect, move, or recover a pane | Find the advanced `herdr` tool via tool discovery or Codemode |

`delegate` waits up to 30 seconds for an answer by default. `wait: false` returns after handing off the prompt. Either way, keep the ticket: it identifies this assignment and survives reload/resume of the coordinating Pi session. Call `delegate_result({})` to recover recent tickets after an interruption, or pass an exact `worker` handle. The `^^handle` identifies the worker, not its answer. A timeout doesn't stop a worker or justify resending its prompt. If a competing message or a fork makes attribution ambiguous, collection reports that rather than returning the latest turn.

Give each task a short `label` (not the full task or any secrets). One-offs get a full-size background tab in the caller's workspace. Set the same `run` label on a batch to share a workspace, one full tab per worker. Handles are stable, task-based, prefixed by the run when given, and get a suffix on collisions. This changes layout, not filesystem isolation. Workers stay open for inspection.

## Find and flip through workers

Your Herdr prefix is **Ctrl+Space**:

- **prefix, g, /**: find a task by tab title or a worker by handle. Because stock Go to searches labels separately, search one term or phrase at a time.
- **prefix, n / p**: next or previous tab in the current workspace. In a run workspace this flips worker by worker.
- **prefix, a / Shift+A**: next or previous live agent across the Herdr sidebar.
- **`/parent`**: return to the coordinator from a Pi worker. **`/children`**: focus your live workers; **`/children offline`** shows saved sessions that can be resumed on purpose.
- **`/workers`**: these controls in Pi.

## Session titles and worker mentions

An unnamed interactive session gets a short title from the visible conversation. The request uses the current model (or `PI_TITLE_MODEL=provider/id`), without tools or reasoning history. Set `PI_NO_TITLE=1` to disable automatic titles. Named delegates already have a task label and don't get an extra title request. Use Pi's `/name` to name a session manually or `/retitle` to regenerate the title on demand. Both leave its IRC handle alone.

Type `^^` plus a word from the title or handle. If titles collide, distinguish them by their handles in the menu. The composer displays the title when it fits (or shortens it to fit); the handle reappears while you edit it. Sent messages show the title as it was at submission. Copying/editing the underlying draft and routing an IRC message still use the stable `^^handle`.

The `^^` completion list starts with live workers in this workspace and the caller's live descendants. An exact handle can still address an offline worker. `irc` broadcasts use the live roster in the requested scope (workspace by default); use an explicit `to: "all"` to send one. Directed offline mail is queued until the worker resumes; `mailboxed` isn't a read receipt. IRC headers show the sender's title (or delegate task label) at send time, followed by the handle. Replies and sender filters still use the handle, not the title. To wait for a specific answer, send with `expectsReply: true` and pass the returned message ID as `replyTo` to `irc wait`. An early reply stays in the mailbox for up to 10 seconds (or until the current turn settles), giving `wait` time to claim it before it becomes a normal follow-up.

Herdr itself is unmodified. Its plugin system can add actions, bindings, terminal panes and event hooks over the same CLI/socket. It cannot currently extend the built-in Go to UI. Task titles in the result row, combined field matching, and remembered run-scoped search would require native support.