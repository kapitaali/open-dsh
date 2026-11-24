# RR-W22-20261124-DSHSTUB-PASSIVE — DSH passive stub wire and coverage sidecar

Date: 2026-11-24. Lane: dsh. Workspace-staged; no checkout write, commit, push,
publish, gateway restart, active paging, or model call by this lane.

## Scope

Implements the passive checkpoint in `design/W22-DSH-STUB-MODE-20261124.md`.
Active selection/context-engine work is not included.

## Changes

- `packages/deepseek/src/surface.ts` (new): recognizes object-form replacements
  and resolves the authoritative single `startSeq === endSeq`; extra
  `sourceEventSeqs` entries are tolerated and never treated as append origins.
- `src/event-map.ts`: append-origin tool results retain the exact PageId returned
  by `tracer.page()` under their event seq. A valid tool/result replacement calls
  `tracer.stub()` with that PageId and the exact replacement text at the current
  xCABI turn. Unknown/malformed origins are bounded diagnostics, never thrown.
- `src/page-table.ts`: replacement text no longer refreshes the original hash or
  token count; the original page becomes `stub`. A later full append restores a
  stub to `resident`; `evicted` remains terminal. Non-tool replacements no longer
  mark tool pages stub. Projection stateVersion is now 3.
- `src/tracer.ts`: all provenance/stub state is per session. Full flush writes
  `<trace>.coverage.json` with the W17 shape plus `plugin.adapter: "dsh"`,
  `plugin.capabilities.stubWire: 1`, observed `stubDropped`, original-token
  `evictedTokens`, `stubCount`, and exact `{ref, contentHash, stubText, turn}`
  records. Digest covers the exact JSONL bytes; files are 0600.
- `package.json`: exact external `@ctxvm/node` dependency `0.1.1`; no `file:` or
  workspace symlink. `README.md` and `tsconfig.json` updated.

## Required external tracer behavior

The staged `@ctxvm/node` 0.1.1 adds `stub({ref, contentHash?, stubText, turn?})`:
atomic `page.evict` then `page.render(mode="stub")`, exact PageId/text/turn,
`ts` last, refusal without half-pair, same-turn superseded-full reconciliation,
and stub-aware `turn.render.residentTokens`/`evictedTokens`/headroom. The
optional `contentHash` is required for durable DSH provenance after a same-ref
fresh fetch; ref-only calls select the first declared PageId.

## Verification

```
@ctxvm/node: 30/30 tests; build rc=0; source/dist parity 21 events byte-identical
DSH adapter: 22/22 pass + 1 named replay skip; tsc rc=0
checker: 13/13 synthetic DSH tests; four committed Hermes sidecars remain green
ci-deepseek.sh: rc=0 using an installed external tarball (no source symlink)
generated stub trace: v0.1 validator OK; coverage checker consistent;
  Rust replay {events:11, divergences:[], violations:[]}
generated mirror trace: v0.1 validator OK; coverage checker consistent;
  Rust replay {events:4, divergences:[], violations:[]}
```

The generated traces and logs are under workspace
`ctxvm-dsh-scaffold/stub-acceptance/`; they are not repo artifacts.

## Owner sequence

1. Publish `@ctxvm/node@0.1.1` from the ctxvm staging package (not done here).
2. Run `ctxvm-dsh-scaffold/copy-staging.sh` for both repos.
3. In ctxvm run `bash tools/ci-deepseek.sh` and the focused checker tests.
4. In open-dsh run the adapter tests/typecheck against the published package.
5. Review/passive checkpoint, then decide separately on active mode.

## Claim ceiling

Passive wire parity only. No active selection, surface mutation, cost-saving,
paging-quality, model-quality, determinism, or `stubText` redaction claim.
