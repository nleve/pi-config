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

The `^^` completion list starts with live workers in this workspace and the caller's live descendants. An exact handle can still address an offline worker. `irc` broadcasts use the live roster in the requested scope (workspace by default); use an explicit `to: "all"` to send one. Directed offline mail is queued until the worker resumes; `mailboxed` isn't a read receipt.

Herdr itself is unmodified. Its plugin system can add actions, bindings, terminal panes and event hooks over the same CLI/socket. It cannot currently extend the built-in Go to UI. Task titles in the result row, combined field matching, and remembered run-scoped search would require native support.