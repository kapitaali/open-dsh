# W22 — ctxvm support for DeepSeek Harness (dsh)

**Status:** plan (owner-approved direction 2026-11-14) · **Card:** W22 · **Date:** 2026-11-14
**Repos:** ctxvm `/home/theb/Documents/ctxvm` (adapter + trace standard) · dsh `/home/theb/Apps/deepseek-harness` (target harness, release 0.2.2-rc.3)

---

## 1. Goal

Add a dsh adapter to the ctxvm repo that captures xCABI v0 traces from the dsh session
log, validates against the sealed schema, and derives the page table. Mirror mode first
(observe-only, zero model-visible change), then replay, then active context management.

### Success criteria (Phase 1)

1. A live dsh session produces an xCABI v0 JSONL trace.
2. The trace validates against `spec/rfc-0/validate_schema.py`.
3. The trace replays without divergence (`ctxvm replay` exit 0, `divergences: []`).
4. No model-visible behavior changes (mirror mode — the plugin never mutates a message,
   tool argument, or surface node).
5. The plugin installs from a local absolute path via the dsh plugin manager.

---

## 2. Confirmed decisions (owner, 2026-11-14)

| # | Decision | Choice |
|---|---|---|
| 1 | Adapter location | ctxvm repo, `packages/deepseek/` (like `packages/hermes`, `packages/opencode`, `packages/ai-sdk`) |
| 2 | Distribution | local path bundle (absolute path via the dsh plugin manager); npm later |
| 3 | Minimum viable trace | `session.open`, `page.declare`, `page.render`, `page.fault`, `turn.render`, `call.meta` (`page.evict` / `page.pin` / `page.unpin` deferred) |

---

## 3. Background

### 3.1 ctxvm side

- ctxvm is a virtual-memory manager for agent context; xCABI is the JSONL trace standard.
- Nine v0 verbs: `session.open`, `page.declare`, `page.render`, `page.evict`, `page.fault`,
  `page.pin`, `page.unpin`, `turn.render`, `call.meta` (`spec/rfc-0/x-cabi.schema-v0.json`).
- `@ctxvm/node` (`packages/node`) is the zero-dependency TS tracer: `trace(init)` →
  `page_raw`, `observe_recall`, `render`, `scan_text`, `pin`, `unpin`, `finish`.
- Adapters exist for Hermes (Python plugin), OpenCode (TS plugin), Vercel AI SDK (middleware).
- `ctxvm replay` (Rust) re-derives the page table from a trace; it is the byte authority.
- Recording contract: `design/mcp-shim.md` (identity minting, Pichay matching, recording matrix).

### 3.2 dsh side

- Everything-is-a-plugin Cordis harness; the session log (`SessionEventMap`) is the
  append-only source of truth; model history is derived via the surface projection.
- Key seams:
  - `ctx.compaction` — `CompactionEngine` Service Definition (`packages/compaction/compaction`),
    backend `compaction-basic`.
  - `ctx.tokenMeter` — replay-aware token/context-pressure measurement (`packages/llm/token-meter`).
  - `ctx.sessionProjections` — pure fold units over committed session events
    (`packages/session/session-projection`); `ProjectionDefinition { key, stateSchema, init, apply, wire?, stateVersion }`.
  - `agent/*` events — live turn/step/request extension points (`agent/pre-step`, `agent/request`,
    `agent/status`, `agent/created`, …).
- Plugin packages: `export default <class extends Service>`, `static inject = [...]`,
  `static Config = z.object({...})`, constructor `(ctx, config)`.
- Bundles: a package with `dsh.bundle.patch: "./cordis.patch.yml"`; the patch inserts rows.
- Plugin manager installs from npm, absolute local path, or Git (`install-spec.ts`).

---

## 4. Architecture

The adapter is a Cordis plugin that:

1. Listens to `session/event` for every committed event.
2. Maintains one `@ctxvm/node` tracer per session (keyed by `sessionId`).
3. Maps dsh events to xCABI events.
4. Registers a session projection for the page table (so replay and UI can read it).
5. Writes the trace to `<CTXVM_TRACE_DIR>/<name>.jsonl` at `finish()` (session end / unload).

### 4.1 Event mapping

| xCABI verb | dsh event | Payload derivation |
|---|---|---|
| `session.open` | plugin init (first event per session) | `agentId` = `dsh:<sessionId prefix>`, `model`/`provider` from `request/header` or agent options, `budgetTokens` from config, `tokenizerId` from config |
| `page.declare` | `tool/result` | `logicalRef = tool:<name>(<canonicalArgs>)` — args from the matching `tool/call` (via `callId`); `contentHash = sha256(result content)`; `kind = tool_result`; `tokens` from token-meter or approx |
| `page.declare` | `user/message` | `logicalRef` = message ref (T3 touch-proxy naming); `kind = file` for file-content pages; `contentHash = sha256(content)` |
| `page.declare` | `system/message` | `logicalRef` = summary ref; `kind = summary`; `contentHash = sha256(system prompt)` |
| `page.render` | surface projection | mode `full` for pages present in the model-visible surface at the turn; `stub` after eviction |
| `page.fault` | `tool/call` | `tool_recall` when `(name, canonicalArgs)` matches a declared page |
| `turn.render` | `turn/start` | `residentTokens` / `evictedTokens` from the page table + token-meter |
| `call.meta` | `request/header` | `provider` from header; `cacheEstimate` from token-meter usage anchor |

### 4.2 Page table derivation

The page table is a pure fold over the session log:

```
PageState = { pages: Map<logicalRef, { kind, contentHash, tokens, status }>, order: logicalRef[] }
```

- `tool/result` → insert/refresh page (first-declare-wins content hash).
- `tool/call` → lookup page by logicalRef; if resident → `FaultOfResidentPage` (ledger row).
- surface projection → mark pages resident/stub.
- `compaction/summary` → mark shadowed pages evicted.

This fold is registered as a `ProjectionDefinition` so the live session and replay agree.

### 4.3 Mirror-mode guarantee

The plugin:
- Never mutates a dsh message, tool argument, surface node, or config.
- Never raises from a session event handler (a throwing listener would break the loop).
- Writes only to its own trace file and its own projection state.
- Is disabled by default; enabled by mounting the bundle.

---

## 5. Package structure

```
packages/deepseek/
  package.json          # @ctxvm/dsh, private, type: module; dsh.bundle.patch: ./cordis.patch.yml
  tsconfig.json         # extends the ctxvm package convention
  cordis.patch.yml      # the bundle patch (inserts the ctxvm-tracer row)
  src/
    index.ts            # Cordis plugin: static inject, static Config, apply()
    tracer.ts           # @ctxvm/node tracer wrapper (per-session lifecycle)
    page-table.ts       # page table fold + ProjectionDefinition
    event-map.ts        # dsh event → xCABI event mapping
    config.ts           # zod config schema + resolution
    types.ts            # shared types
  test/
    event-map.test.ts   # mapping unit tests
    page-table.test.ts  # fold unit tests
    replay.test.ts      # trace → validate → replay
  README.md
```

### 5.1 Bundle patch

```yaml
- insert:
    - id: ctxvm-tracer
      name: '@ctxvm/dsh'
      config:
        budgetTokens: 200000
        tokenizerId: apx4-char
```

### 5.2 Local path installation

```
dsh plugin install /home/theb/Documents/ctxvm/packages/deepseek
# or a profile patch naming the local path
```

(Exact command confirmed during the plugin-manager investigation task, §6.1.)

---

## 6. Phases

### Phase 1 — Trace capture (mirror mode) · the immediate next step

Tasks:
1. Write `design/W22-DSH-ADAPTER-20261114.md` (this doc).
2. Create `packages/deepseek/` skeleton (package.json, tsconfig, src/, test/, README).
3. Implement `config.ts` (zod schema: `budgetTokens`, `tokenizerId`, `traceDir`, `agentId`).
4. Implement `tracer.ts` (per-session `@ctxvm/node` tracer lifecycle; `finish()` on session end).
5. Implement `page-table.ts` (the fold + ProjectionDefinition).
6. Implement `event-map.ts` (dsh event → xCABI event).
7. Implement `index.ts` (the Cordis plugin: inject `sessionProjections`, listen `session/event`,
   register the projection, flush on session end / unload).
8. Write unit tests for the mapping and the fold.
9. **Plugin-manager investigation**: confirm the exact local-path install command; document it.
10. Live test: run a dsh headless session with the bundle mounted; capture the trace;
    validate with `spec/rfc-0/validate_schema.py`; replay with `ctxvm replay`.
11. Record: `reports/RR-W22-<date>.md`, LOG row, day-file section.

### Phase 2 — Page table derivation (replay)

- A `ctxvm replay` equivalent for dsh traces (or a dsh-side replay that calls the Rust binary).
- Validate the derived page table against the live projection.
- Corpus drop: a frozen dsh trace with checksums (follows the corpus/m1..m8 convention).

### Phase 3 — Context management (active)

The implementation plan is `design/W22-DSH-STUB-MODE-20261124.md`. Passive stub-wire parity lands first. The active engine starts only after passive traces validate, replay, and pass the adapter-aware coverage checker.

- A `CompactionEngine` backend (or a new context-engine seam) that uses the page table for
  eviction (ctxvm keep law).
- Stub text per RFC-0 §7 (identify · how-to-recover · cost).
- Budget policy: `budgetTokens` drives `turn.render.headroom`.

---

## 7. Acceptance criteria (Phase 1)

| # | Criterion | Command |
|---|---|---|
| 1 | Live dsh session produces an xCABI v0 JSONL trace | run dsh headless with the bundle; check the trace file |
| 2 | Trace validates against the sealed schema | `python3 spec/rfc-0/validate_schema.py <trace>` |
| 3 | Trace replays without divergence | `cargo run --release -p ctxvm-conformance --bin replay <trace>` |
| 4 | No model-visible behavior change | diff the session log with/without the plugin (same events) |
| 5 | Installs from a local absolute path | `dsh plugin install <abs path>` (command confirmed in §6.1) |
| 6 | Unit tests pass | `node --test packages/deepseek/test` |
| 7 | Gate green | `bash tools/run-ci.sh` (with CTXVM_* unset) |

---

## 8. Risks

1. **`tool/result` carries no arguments.** The dsh `tool/result` event has `callId`; the
   adapter must maintain a `callId → (name, arguments)` map from `tool/call` events.
   A missing `tool/call` (provider-executed tools, out-of-order) → no page (recorded as a
   known gap, mirroring T7 risk 2).
2. **Surface is derived.** The adapter must use the dsh surface projection to know which
   pages are model-visible. The fold must match the surface semantics exactly.
3. **Plugin-manager local path install may have constraints** (absolute path required,
   pnpm link semantics, bundle resolution). Mitigated by task §6.1.
4. **dsh session log is rich; the mapping is not 1:1.** Some xCABI verbs have no direct dsh
   event (`page.evict`, `page.pin`, `page.unpin`). Deferred to Phase 3.
5. **Timing.** `page.declare` is turn-free; `page.render` is at the turn the page is first
   visible. The dsh `tool/result` lands mid-step; the adapter must stamp the render at the
   correct turn (RFC-0 §5).
6. **Multiple sessions.** One tracer per session; a shared process must not cross-contaminate
   (T7 risk 3).

---

## 9. Open questions (resolved during Phase 1)

1. Exact plugin-manager command for a local path bundle.
2. Does the dsh surface projection expose enough to derive resident/stub status, or must the
   adapter re-derive it from the log?
3. Where does the trace file live by default? (Recommendation: `${XDG_STATE_HOME:-~/.local/state}/ctxvm/traces`,
   matching law 9 — capture is default-on and private, mode 0700.)
4. Does the dsh token-meter expose the cache estimate needed for `call.meta`, or is it
   estimated from the header?
5. Corpus drop naming: `corpus/m9/` or a new `corpus/dsh/` tree?

---

## 10. Out of scope (Phase 1)

- Active eviction / paging (Phase 3).
- `page.evict`, `page.pin`, `page.unpin` verbs (Phase 3).
- npm publication (later).
- Modifying the dsh repo (the adapter lives in the ctxvm repo; dsh is the test bed).
- Any change to the sealed RFC-0 schema or the Rust core.
