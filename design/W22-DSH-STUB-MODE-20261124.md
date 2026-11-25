# W22-DSH-STUB-MODE — passive parity first, active engine second

Date: 2026-11-24. Status: implemented; passive and active checkpoints verified. Branch: `plan/dsh-stub-mode`. Owner decisions: passive first; reuse Hermes material; derive state from replacement events; keep `@ctxvm/node` in the ctxvm repository as a local dependency; use an adapter-aware checker gate.

## 1. Goal

Update `@ctxvm/dsh` so its traces obey the ctxvm stub-mode contract already shipped by Hermes 0.13.33. A stubbed tool result must produce `page.evict` and then `page.render(mode="stub")` for the original PageId at the turn where the stub becomes visible. The event text must equal the request text byte-for-byte. Drop mode must produce neither event.

Passive parity lands first. Active paging lands only after passive traces validate, replay, and pass the checker.

## 2. Decisions

1. Passive adapter support precedes the active context engine.
2. The active engine reuses the Hermes selection laws, stub template, argument limits, and test cases where DSH semantics permit.
3. No DSH stub-marker event is added. The adapter derives stub facts from durable `tool/result` replacement events and their `sourceEventSeqs`.
4. `@ctxvm/node` stays in the ctxvm repository. The open-dsh adapter uses a repository-relative `file:` dependency; no npm publish is required.
5. The ctxvm coverage checker gains an adapter-aware capability gate. It does not treat a DSH version as a Hermes version.

## 3. Source contract

The authority is `design/page-evict-stub-mode.md` in ctxvm and the Hermes 0.13.33 implementation:

- `packages/hermes/src/plugin.py:407` emits `page.evict`.
- `packages/hermes/src/plugin.py:425` emits the companion stub render.
- `packages/hermes/live/__init__.py:1560` emits the pair per session at the current visibility turn.
- `packages/hermes/live/context_engine.py:1047` builds the stub.
- `packages/hermes/live/context_engine.py:1078` inserts the same stub object into the request.
- `tools/coverage_check.py:461` checks exact text and matching visibility turn.

No schema or Rust-core change is planned. The verbs and fields already exist.

## 4. Passive phase

### 4.1 Repo-local tracer API

Keep `@ctxvm/node` in the ctxvm repository and consume it through a local `file:` dependency. Add one combined method:

```ts
stub(input: { ref: string; stubText: string; turn?: number }): boolean
```

The method resolves the original declared PageId, refuses unknown refs or invalid text, and emits `page.evict` followed by `page.render(mode="stub")`. Both rows use the same explicit or current turn. `ts` remains last. A combined method prevents a caller from emitting only half of the required pair.

Node tests cover order, PageId, turn, key order, exact text, refusal, and `finish()` idempotency.

### 4.2 DSH event mapping

Extend `SessionTracer` with a map from original event sequence to `{ logicalRef, contentHash }`.

For an append-origin `tool/result`:

1. Declare the full page through `tracer.page()`.
2. Store the returned identity under the event sequence.
3. Retain current behavior for calls, usage, scans, and turn rendering.

For a replacement `tool/result`:

1. Require a single-node `surfaceOp: replace`.
2. Resolve the original sequence from `sourceEventSeqs`.
3. Look up the original PageId.
4. Read the replacement's exact text content.
5. Call `tracer.stub()` at the tracer's current turn.
6. Do not declare the stub body as a new page.

If the original identity cannot be resolved, emit no eviction pair and record a diagnostic. Observability must not break a turn.

A replacement is recognized only when it is a `tool/result` replacement. A user-message replacement, compaction summary, or pruner replacement is not a ctxvm stub.

### 4.3 Page-table fold

Change the `tool/result` branch in `src/page-table.ts`:

- A replacement does not refresh the original page's hash or token count from stub text.
- A replacement marks the shadowed original page as `stub`.
- A later append-origin full result for the same logical ref restores `resident` status and full token accounting.
- The first declared content hash remains the page identity.

### 4.4 Passive acceptance

Passive parity is complete when:

- A synthetic original result plus replacement emits one declaration, one eviction, and one stub render.
- The eviction and render use the original PageId and current turn.
- Event text equals replacement text byte-for-byte.
- No second declaration is emitted for the stub.
- Drop/off mode emits no pair.
- Two sessions in one process do not share stub state.
- A multi-step DSH turn uses one visibility turn.
- The generated trace passes the v0.1 validator and Rust replay.
- The coverage sidecar and checker agree.

Stop at this checkpoint. Do not add selection or surface mutation until these checks pass.

## 5. Coverage and checker

Add a DSH coverage sidecar next to each trace. It contains:

- `plugin.adapter: "dsh"`.
- `plugin.version`.
- `plugin.capabilities.stubWire: 1` when passive parity is present.
- `stubDropped`.
- `evictedTokens`.
- `stubCount`.
- `stubbedRefs: [{ ref, stubText, turn }]`.

Update `tools/coverage_check.py` in ctxvm:

- Keep existing Hermes version gates unchanged.
- For DSH, require `capabilities.stubWire >= 1` before enforcing the pair rule.
- Check exact `stubText`, PageId presence, and matching stub-render turn.
- Keep old/off fixtures exempt.
- Add negative cases for missing eviction, missing render, wrong turn, and mismatched text.

This checker change is a separate ctxvm handoff. It lands before active DSH mode is accepted.

## 6. Active phase

### 6.1 Configuration

Add an explicit active mode to `@ctxvm/dsh`:

- `mode: "mirror" | "stub"`, default `mirror`.
- `budgetTokens`.
- `protectFirstN`, default 3.
- `protectLastN`, default 6.
- `stubDropped: "off" | "recoverable"`, default `off`.
- `selectionMode: "fresh" | "stable"`, default `fresh`.
- `stableEvery`, default 4.

Mirror mode remains the shipped default and never mutates the session surface.

### 6.2 Reused Hermes material

Port these Hermes behaviors and tests:

- The seven selection laws in `context_engine.py:20`.
- Protected system prompt, head, tail, last user message, pinned pages, and open tool-call floor.
- Second-demand pinning and pin release on content change.
- `apx4` budget arithmetic with per-message structural cost.
- No-op when the protected floor exceeds the budget.
- Fresh and stable selection behavior.
- `_stub_arg_excerpt()` cap, control-character stripping, and bracket escaping from `context_engine.py:300`.
- The exact stub template from `context_engine.py:1075`.
- The read-only tool allowlist and mutating-tool fallback.

Hermes message rewriting is not copied. DSH uses durable surface replacement instead.

### 6.3 DSH selection seam

Add `src/context-engine.ts` and an `agent/pre-step` listener:

1. Receive the selected model and current session surface.
2. Measure the surface with `ctx.tokenMeter`.
3. Build append-origin tool-result page candidates.
4. Apply the reused keep, pin, recency, and budget laws.
5. If the protected floor exceeds the budget, leave the request unchanged.
6. For each selected page, build one stub string.
7. Append a replacement `tool/result` with the original message identity, call id, error state, and metadata, but with one text block containing the stub.
8. Use `surfaceOp: { op: "replace", startSeq, endSeq }` and `sourceEventSeqs: [originalSeq]`.
9. Let normal request derivation send the logged replacement.

The same replacement event supplies the passive adapter's exact `stubText`. There is no second derivation from a plan object.

### 6.4 Turn and state rules

- `turn/start` is committed before pre-step. The adapter's existing `tracer.render()` call makes the tracer's current turn the visibility turn. Do not add one.
- All page, pin, selection, and coverage state is keyed by SessionId.
- Already-stubbed pages are not selected again.
- A new append-origin full result for a stubbed page restores resident status.
- Resume resolves original identities from durable replacement provenance or safely skips unknown replacements.

## 7. Verification plan

### Passive tests

- Original result declares once.
- Replacement emits eviction then stub render.
- Original PageId is retained.
- Stub text is byte-identical.
- Stub content does not replace the page hash or full token count.
- Unrelated replacements emit no stub pair.
- Off/drop mode emits no pair.
- Two-session isolation.
- Multi-step turn timing.
- Validator and replay pass.
- Mirror-mode session log remains identical with the plugin on and off.

### Active tests

- Protected floor wins over budget.
- Head, tail, last user, pinned, and open-call protection.
- Second-demand pinning and content-change release.
- Fresh and stable selection.
- Read-only argument excerpt is capped and escaped.
- Mutating tools receive no argument excerpt.
- One replacement per selected page.
- Exact request text equals event text.
- Re-fetch restores full residency.
- Resume behavior is safe.
- A forced-pressure live capture validates, replays, and passes the checker.

## 8. Packaging and sequence

1. Keep the `@ctxvm/node` stub API in the ctxvm repository.
2. Point `packages/deepseek/package.json` at the local ctxvm package and build it before adapter tests.
3. Land passive DSH mapping, page-table changes, sidecar, and tests.
4. Land the adapter-aware ctxvm checker gate.
5. Run the passive acceptance checkpoint and stop for review.
6. Land the active engine only after owner approval of the passive evidence.

## 9. Scope and claim ceiling

- No RFC-0 or RFC-0.1 schema change.
- No sealed v0 fixture regeneration.
- No corpus drop without a separate owner decision.
- No default-on active paging.
- No cost-saving, paging-quality, model-quality, or model-output determinism claim.
- No `stubText` redaction claim.
- No gateway restart or release action as part of this plan.
