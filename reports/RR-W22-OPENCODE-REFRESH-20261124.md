# RR-W22-OPENCODE-REFRESH-20261124 — propagate refreshed connection models into configured profiles

Date: 2026-11-24 (Europe/Helsinki). Branch: `fix/refresh-connection-profiles`. Base branch: `connection-profiles`. Scope: open-dsh connection catalog refresh. No commit or push.

## Summary

`pnpm run refresh:connections` updated the saved connection but left existing profile model lists stale unless the caller also passed `--profile`. The refresh now finds every profile that already configures the same provider name, endpoint, credential reference, and protocol. It merges the refreshed model ids into those profiles. `--profile` remains an explicit filter. The default merge is additive. `--replace` makes the endpoint list authoritative. The profile default model does not change.

## Actions taken

1. Confirmed the affected repository was the open-dsh checkout, not ctxvm.
2. Checked the branch, working tree, recent commits, connection store, profile patches, refresh script, merge helper, and model-discovery path.
3. Reproduced the stale profile with `pnpm run refresh:connections -- opencode --dry-run --profile opencode`. The endpoint returned 29 models. The profile would gain 8 models.
4. Confirmed the root cause in `scripts/refresh-connection-catalog.ts`: the script wrote `connections.yaml`, but the profile merge loop iterated only `options.profiles`. Without `--profile`, that list was empty.
5. Created `fix/refresh-connection-profiles` before editing files.
6. Added `listProfilesUsingConnection` to `scripts/sync-connection-models.mjs`. It scans `$DSH_HOME/profiles`, parses each `cordis.patch.yml`, and selects routes matching the connection's provider name, `baseURL`, `apiKeyEnv`, and effective protocol.
7. Changed the refresh merge loop to use matching profiles when `--profile` is absent. Explicit `--profile` values still restrict the merge.
8. Kept the existing merge rules: additive by default, authoritative with `--replace`, and no change to `agent-default-model`.
9. Added a regression test that refreshes a connection without `--profile`. The test proves that two matching profiles update, an unrelated provider does not update, a same-name provider at another endpoint does not update, and the default model stays unchanged.
10. Updated `scripts/sync-connection-models.d.mts` for the new export and the route identity fields. The runtime `.mjs` file has no inferred TypeScript types in this repository.
11. Updated the English and Chinese refresh documentation and re-recorded `README.i18n.yaml`.
12. Applied the refresh to the live OpenCode connection. The command added 8 missing models to `ctxvm-dsh-local`, `ctxvm-plana`, `opencode`, and `web`. Each profile then contained 29 models.
13. Ran a second live dry-run. All four profiles reported `unchanged models=29`.

## Files changed

- `scripts/refresh-connection-catalog.ts`
- `scripts/sync-connection-models.mjs`
- `scripts/sync-connection-models.d.mts`
- `scripts/refresh-connection-catalog.spec.ts`
- `README.md`
- `README.zh.md`
- `README.i18n.yaml`

## Verification

Focused behavior and discovery tests:

```text
pnpm exec vitest run scripts/refresh-connection-catalog.spec.ts packages/llm/llm-pi-ai/tests/discovery.spec.ts
Test Files  2 passed (2)
Tests       58 passed (58)
```

Host TypeScript check:

```text
pnpm exec tsc -b tsconfig.host.json --pretty false
exit 0
```

Build check:

```text
pnpm run build:check
run-gates: 2 passed, 0 failed, 0 skipped
```

Documentation pair and diff checks:

```text
pnpm run verify-translation-pairing README.md
verify-translation-pairing: 1 named pair(s) consistent

git diff --check
exit 0
```

Live refresh:

```text
pnpm run refresh:connections -- opencode
opencode: 29 models from https://opencode.ai/inference/go/openai/v1
profile ctxvm-dsh-local/opencode: updated models=29 added=8 removed=0
profile ctxvm-plana/opencode: updated models=29 added=8 removed=0
profile opencode/opencode: updated models=29 added=8 removed=0
profile web/opencode: updated models=29 added=8 removed=0
updated 1 of 1 connection
```

Live verification after the write:

```text
pnpm run refresh:connections -- opencode --dry-run
opencode: 29 models from https://opencode.ai/inference/go/openai/v1
profile ctxvm-dsh-local/opencode: unchanged models=29
profile ctxvm-plana/opencode: unchanged models=29
profile opencode/opencode: unchanged models=29
profile web/opencode: unchanged models=29
would update 1 connection (dry run)
```

## Remaining check failures

The following checks ran and remained red. Their reported paths were outside the changed behavior, or on pre-existing lines in the refreshed files.

- `pnpm run test:docs` reported 5 failing gates: translation pairing, markdown wrap, repository references, package README summaries, and documentation standard tests. The failures named `packages/deepseek`, `packages/credentials/hermes-token-sync`, and existing report files.
- Focused `node scripts/run-oxlint.ts scripts/refresh-connection-catalog.ts scripts/refresh-connection-catalog.spec.ts scripts/sync-connection-models.mjs` reported existing diagnostics on unchanged lines. No reported line was in the added code after the new test callbacks were corrected.
- `pnpm run verify-export-jsdoc` reported 10 violations in `packages/credentials/hermes-token-sync/src/index.ts`.
- `pnpm run verify-empty-catch` reported existing catches in `packages/deepseek/src/event-map.ts` and three pre-existing catches in `scripts/refresh-connection-catalog.ts`.

## Status

The code change, regression test, documentation update, and live OpenCode profile refresh are complete. The working tree contains the seven implementation and README files listed above, this report, and the appended `reports/LOG.md` row. No commit or push was made.

## Follow-up on 2026-11-24

The refresh change was committed on `fix/refresh-connection-profiles`. A later `pnpm dsh web` boot exposed a separate writer defect: the refresh preserved pre-existing YAML aliases in the web patch. Both writers now inline existing aliases, the live patches were repaired, and the web profile boots. The evidence is in `RR-W22-ALIAS-INLINE-20261124.md` and `packages/util/connection-store/BUG_REPORT.md`.
