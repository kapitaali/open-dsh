# RR-W22-20261125-ACTIVESTUB — opt-in active DSH stub context engine

Date: 2026-11-25. Lane: dsh. Workspace-staged; no checkout write, commit, push,
publish, default-on activation, gateway restart, or existing profile change.

## Scope

Implements the active phase of `design/W22-DSH-STUB-MODE-20261124.md` §6. Mirror
mode remains the default and never registers the active listener.

## Changes

- `src/config.ts`: `mode`, `protectFirstN`, `protectLastN`, `stubDropped`,
  `selectionMode`, and `stableEvery` configuration with mirror/off/fresh defaults.
- `src/context-engine.ts` (new): Hermes-derived hard keeps, second-demand pinning,
  content-change release, apx4 code-point estimator, fresh/stable recency
  selection, duplicate-PageId fail-closed behavior, and exact stub text.
- `src/active-runtime.ts` (new): nondeprecated `sessionQuery.readSurface()`
  candidates, message-id projection mapping, tokenMeter measurement, pre-step
  replacement append, flush, cancellation/freshness checks, bounded diagnostics.
- `src/index.ts`: per-SessionId active state and a prepended `agent/pre-step`
  waterfall that delegates first, preserves reject/`startsRequestSeries`, and
  fails open.
- `src/event-map.ts` / `src/types.ts`: retain raw tool arguments for exact stub
  excerpts.
- Tests: pure selection/protection/pinning/stable/stub-text matrix plus runtime
  mapping/off/cancel/provenance tests.
- README and peer dependencies updated.

## Verification

```
adapter unit suite: 35 passed, 1 named replay skip
tsc -p packages/deepseek/tsconfig.json: rc=0
ci-deepseek.sh: rc=0 (external tracer tarball; no source symlink)
```

Forced-pressure local mock (`stub-live-harness/active-summary.json`):
- 2 mock requests; request #2 carried the exact Hermes stub bytes;
- 8-event trace: 1 tool declaration, 1 eviction, 1 stub render;
- live projection version 3 held the original PageId as `stub`;
- schema/checker passed; Rust replay `divergences: []`, `violations: []`.

Forced-pressure real Nous `meituan/longcat-2.5:free`
(`stub-live-harness/remote-active-summary.json`):
- DSH rc=0; model completed the task;
- 15-event trace, 3 tool results, 2 eviction/stub pairs, `stubCount: 2`;
- schema/checker passed; Rust replay `divergences: []` with one expected
  identifier-scan `faultOfResidentPage`.

## Parity limits / deliberate deviations

- DSH's single-node result-replacement seam cannot perform Hermes pinned-block
  reordering; pinned pages remain in transcript order.
- `stubDropped: off` plans but emits no replacement. True Hermes drop (removing
  call+result) is not represented.
- Pre-step sees committed history plus claimed user messages, not the newly
  assembled system prompt/tool schemas. The prior committed system prompt and
  prospective user batch participate; tokenMeter is diagnostic, while the
  Hermes apx4 estimator owns budget arithmetic.
- Stable mode is incremental over the durable surface and ignores the engine's
  own stubbed originals when deciding whether a page disappeared.
- Like Hermes, selection does not reserve stub-text token cost. Forced-pressure
  acceptance verifies the resulting request/trace, not a universal budget proof.
- Duplicate current PageIds fail closed instead of partially stubbing one copy.

## Owner sequence

1. Ensure external `@ctxvm/node@0.1.1` is published/installed.
2. Run `ctxvm-dsh-scaffold/copy-staging.sh` for both repos.
3. Run ctxvm `bash tools/ci-deepseek.sh` and open-dsh adapter tests/typecheck.
4. Review active evidence before enabling `mode: stub` in any real profile.

## Claim ceiling

No cost-saving, paging-quality, model-quality, determinism, availability, or
`stubText` redaction claim. Active mode is opt-in and default-off.
