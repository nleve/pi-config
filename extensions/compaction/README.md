# Compaction (Pi extension)

One compaction hook runs **Codex Remote V2 → Snapcompact → soft** by default.
Unsupported methods are skipped; cancellation stops the chain. Remote V2 is only
attempted for `openai-codex` models on the official ChatGPT endpoint. Other models
start with Snapcompact and use soft if images are unsupported or the archive is declined.
The extension lives in `extensions/compaction/`; existing Snapcompact settings and archives
keep their original paths.

Snapcompact is a Pi port of [OMP's `@oh-my-pi/snapcompact`](https://github.com/can1357/oh-my-pi),
with opt-in inline imaging of large tool results.

Instead of asking an LLM to summarize the history being discarded, snapcompact serializes it,
normalizes it, and rasterizes it into dense PNG frames of pixel-font text. A vision model reads
those frames back directly on later turns. The pass is local and deterministic — no LLM call, no
API key, no latency beyond rendering (tens of ms).

```
/compact              → method picker (first choice: configured fallback chain)
/compact remote       → Codex Remote V2, then Snapcompact, then soft
/compact snap         → Snapcompact, then soft
/compact soft [focus] → Pi text summary only
/compaction           → configure fallback order, shape, frames, tool-result imaging, blobs, GC
/snapcompact-gc       → collect unreferenced frame blobs now
```

## What is omp-exact vs ported

The **engine** (`vendor/snapcompact.ts`) is a vendored OMP snapshot with import/runtime shims and
inlined prompt templates. The bounded text-only reader view is a later upstream port: when the
reader cannot take images or has no image slots left, it uses the saved transcript within the
current window budget, keeping both ends if the middle must be cut.

The **integration** is reimplemented on pi's extension API. The following pieces are ported from
omp's native integration because they change behavior, not just plumbing:

| Ported | Where | Why |
| --- | --- | --- |
| Context-window frame budget | `budget.ts#computeMaxFrames` | omp's `#computeSnapcompactMaxFrames`: reserve recent history + text-edge pages + summary template before sizing frames. |
| Reduction guard | `budget.ts#guardReduction` | omp rejects an archive that does not *reduce* the context or does not *fit* the window. A frame holds ~4.2–4.8 chars per billed token — near text parity — so "valid but useless" archives must be rejected. The reduction test is **local and self-consistent** (the archive vs the region it replaces, plus the standing previous archive), so a deflated `tokensBefore` can't falsely reject a reducing archive (omp #10023); the window-fit check stays usage-anchored and conservative. |
| Savings gate | `inline.ts` | `frames × frameTokenEstimate ≤ textTokens × 0.9`, plus a 3000-token floor, applied to inline imaging. |
| Provider image budget | `tuning.ts` | omp's `providerImageBudget`/`providerFrameBudget`. Provider id → api family → gateway default (override via config), never above `MAX_FRAMES_DEFAULT`. |
| Inline tool-result imaging | `inline.ts` | omp's `snapcompact-inline.ts` policy: oldest-first, never the last result, never errors, budget-aware, cache-stable. |
| Content-addressed frame store | `blobs.ts` | omp's `blob:sha256:` externalization; the engine resolves it via `historyBlocks`'s `resolveFrameData`. |

Intentionally **not** ported: system-prompt/context-file imaging (cache-hostile, off in omp too),
the OMP `handoff` and `shake` methods, the savings journal, stale-archive rescue,
and the `unknown → 5` provider floor as a hard cap.

## How it plugs into pi

| pi hook | what it does |
| --- | --- |
| `session_before_compact` | Runs the configured methods in order and commits only the first success. Snapcompact applies its window, reduction and payload guards. |
| `before_provider_request` | Replaces the portable summary with a saved Codex checkpoint only for the issuing model and account on the official Codex endpoint. |
| `context` | Re-attaches the active archive's frames, optionally images large historical tool results, and keeps the total image count within the provider budget. |

Frames persist in the compaction entry's `details` as `blob:sha256:` references (or inline base64
when the store is disabled), so they survive `/reload`, resume, and fork.

## Blob store and GC

Frame bytes are externalized to `~/.pi/agent/snapcompact/blobs/<sha256>` and referenced as
`blob:sha256:<hex>` in the compaction entry, so a session transcript holds ~76 bytes per frame
instead of ~30 KB. Writes are staged through a temp file and renamed into place; a reused blob gets
its mtime refreshed so a concurrent sweep's grace window still covers a reference that has not
reached a session file yet.

`gcBlobs` (run by `/snapcompact-gc`, the `/compaction` menu, and opportunistically at session start
and after each compaction, throttled to once per 6 h) scans session transcripts for `blob:sha256:`
references and deletes only blobs that are **both unreferenced and older than 30 days** (never
inside a 5-minute write grace). A blob whose mtime moves mid-sweep is kept, so a `put` racing the
sweep can't lose data. A missing blob degrades to a dropped frame rather than corrupt image input.

## Remote checkpoints and recovery

Remote V2 uses the official ChatGPT Codex Responses endpoint and Pi's configured OAuth.
It compacts the prefix selected by Pi, leaves the recent tail verbatim, and stores the
returned opaque checkpoint in the session JSONL. It does not generate a second LLM summary.
A bounded readable excerpt is saved alongside the checkpoint for other models or when replay
is unavailable. The original transcript stays on disk.

If a later remote attempt fails, the extension reconstructs the readable prefix from the
active branch, respecting context edits and the previous portable compaction. Snapcompact
and soft use that prefix rather than summarizing only the tail. If no method succeeds, the
existing checkpoint and transcript are left unchanged.

## The `soft` fallback

If the model cannot accept images, the archive would not reduce context, the payload would exceed
the per-request byte budget, or no headroom remains, snapcompact declines and pi runs its built-in
LLM summary ("soft" compaction). This is deliberate: on Anthropic/OpenAI a frame is roughly
token-neutral, so an archive that does not pay is worse than a summary that does.

## Install

Pi discovers `~/.pi/agent/extensions/compaction/` automatically.
Reload with `/reload`, or pass it explicitly:

```bash
pi -e ~/.pi/agent/extensions/compaction/index.ts
```

## The native renderer

Rasterization/PNG encoding is native (`renderSnapcompactPng`). omp ships it in
`@oh-my-pi/pi-natives`, whose JS loader is **Bun-only** (`import.meta.dir`). This extension skips
that loader and requires the N-API `.node` addon directly; N-API is ABI-stable, so Node loads the
exact same binary omp uses.

Resolution order (`vendor/pi-natives.ts`):

1. `PI_SNAPCOMPACT_ADDON` — explicit `.node` file or directory
2. `@oh-my-pi/pi-natives-<platform>-<arch>` reachable from the extension
3. `$BUN_INSTALL/install/global/node_modules` (default `~/.bun/...`)
4. npm's global root
5. `$XDG_DATA_HOME/omp/natives`, `~/.omp/natives`

If the addon can't be found, `/compact` falls back to soft compaction with a warning.

## Config

`~/.pi/agent/snapcompact.json` (edit with `/compaction`):

```json
{
  "methodOrder": ["remote", "snapcompact", "soft"],
  "picker": true,
  "maxFrames": 40,
  "shape": "auto",
  "toolResults": false,
  "blobStore": true,
  "imageBudget": null
}
```

- `methodOrder` — methods to try in order, for automatic compaction and the picker's Auto option.
  A legacy `"default": "snapcompact"` uses the new chain; a legacy explicit `"default": "soft"`
  stays soft-only. The remaining settings and saved archives are unchanged.
- `picker` — show a method picker on bare `/compact`.
- `maxFrames` — upper limit; the effective cap is lowered by the window budget, the 3 MB data
  budget, and the provider image budget.
- `shape` — `auto` or a snapcompact variant name (see `/compaction` for the resolved shape).
- `toolResults` — inline-image large historical tool results (omp's `snapcompact.toolResults`,
  default off).
- `blobStore` — externalize frame bytes to `~/.pi/agent/snapcompact/blobs/`.
- `imageBudget` — override the provider image-count budget (`null` = auto).

## Repo layout

```
index.ts                 method selection and fallback hook; Snapcompact rendering
chain.ts                 readable branch projection and Pi text summarization
remote.ts                Codex Remote V2 request, checkpoint, and compatible replay
vendor/codex/            V2 protocol helpers from Criogaid (MIT)
budget.ts                window sizing + reduction guard
tuning.ts                provider image budgets / api family mapping
inline.ts                tool-result imaging (savings gate, cache)
blobs.ts                 content-addressed frame store + reference-scanning GC
vendor/snapcompact.ts    omp's snapcompact source (MIT), import shims only
vendor/prompts.ts        the two prompt templates, inlined as TS strings
vendor/pi-natives.ts     direct N-API addon loader
vendor/pi-utils.ts       formatGroupedPaths + prompt.render (re-export)
vendor/path-tree.ts      vendored from @oh-my-pi/pi-utils (MIT)
vendor/prompt.ts         vendored from @oh-my-pi/pi-utils (MIT)
vendor/template.ts       vendored handlebars-compatible template engine (MIT)
vendor/identity.ts       classifyModel/parseRevision/compareRevision/preferredDialect shim
vendor/pi-wire.ts        INTENT_FIELD constant
vendor/pi-ai-types.ts    minimal type stand-ins (erased at runtime)
```

## Known limitations

- **Context accounting.** pi's compaction threshold does not count injected image tokens, so this
  extension keeps its own window budget. The reduction guard is usage-independent by construction
  (it compares the archive to the region it replaces); the window-fit check still uses pi's
  `tokensBefore`, which may come from provider usage and can differ from a content estimate.
- **Prompt caching.** Re-attached archive images and imaged tool results are deterministic, so they
  are cache-stable once rendered; the first request that crosses a threshold pays a cache miss.
  System-prompt imaging — the cache-hostile variant — is not implemented.
- **Portable checkpoint view.** A different Codex model, account, or provider gets a bounded
  excerpt, not the full history or the opaque item. A later portable compact rebuilds its
  input from the saved branch.
- **OpenAI `detail`.** Pi 1.5.2 sends `auto` rather than forwarding the engine's `imageDetail`.
  OMP's pricing and legibility estimates for `original` image detail do not directly carry over.

## Attribution

`vendor/snapcompact.ts` and the vendored pi-utils files are MIT-licensed work of Stencil Labs, Inc.
(`@oh-my-pi/*`). See upstream `THIRD-PARTY-NOTICES.txt` in the omp packages.
The V2 wire helpers are from [Criogaid's Pi extension](https://github.com/Criogaid/pi-codex-compaction)
0.5.2; see `vendor/codex/LICENSE`.
