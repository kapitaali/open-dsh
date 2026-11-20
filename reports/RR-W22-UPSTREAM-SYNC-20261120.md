# RR-W22-UPSTREAM-SYNC-20261120 — merge upstream master into open-dsh

Date: 2026-11-20 (Europe/Helsinki). Lane: dsh. No push. Attribution:
kapitaali <teppo@kapitaali.com>.

## Source facts

- Upstream `deepseek-ai/deepseek-harness` master tip at fetch:
  `2e39e70496aa02986ca6a820c5d497e816b69d7e`.
- Fork `connection-profiles` before merge: `68f0105517256d4720e17e0c9674c4c9bf507818`.
- Local `master` fast-forwarded `39163dd3` → `2e39e70` (upstream mirror).
- Fork was 0 behind / 26 ahead of the tracked upstream base before the merge.

## Precondition handled

The fork tree had uncommitted work from earlier handoffs (LOG row, refresh script,
two RR cards, sync-connection-models.mjs). It was stashed with
`git stash push -u -m pre-upstream-sync-20261120`, leaving the tree clean for the
merge, then restored with `git stash pop` after the merge conflict was resolved.
No stash conflicts occurred. Those files remain uncommitted and are NOT part of
this merge commit.

## Conflict and resolution

Only one conflict: `pnpm-lock.yaml` (~lines 8918-8972, HEAD vs origin/master).
Resolution per handoff 25: take upstream lock (`git checkout --theirs`), then
regenerate with `pnpm install` (rc=0) and stage it. Both fork importers are present
in the regenerated lock: `apps/cli` (connection-store link at line 362),
`packages/credentials/hermes-token-sync` (line 8918), `packages/util/connection-store`
(line 19608). No hand-edited lock bytes; no conflict markers remain.
All other upstream-owned files auto-merged (`apps/cli/src/*`, llm-pi-ai, workspace,
tsconfigs, bundle rows, website config, docs/notes).

## Verification (real output)

```
npx tsc -b tsconfig.host.json                  → rc=0 (after build:artifacts)
pnpm run build:artifacts                       → rc=0, 8/8 gates PASS
npx vitest run scripts/refresh-connection-catalog.spec.ts → 1 file, 8 tests passed
node --test packages/deepseek/test/            → 15 tests, 14 pass, 0 fail, 1 skip
P=.../dsh-memento
node --test "$P"/test/*.test.js                → 18 tests, 18 pass, 0 fail
node --import tsx/esm "$P"/test/live-tool-call.mjs       → ALL LIVE TOOL CHECKS PASSED
node --import tsx/esm "$P"/test/projection-registration.mjs → PROJECTION REGISTRATION CHECKS PASSED
node --import tsx/esm "$P"/test/v3-readiness.mjs          → V3 READINESS PARITY PASSED (bank 75bb7ce8…, mapping 91f5857e…)
```

One initial typecheck attempt OOM'd at the default heap (exit 134) and was rerun
with `NODE_OPTIONS=--max-old-space-size=8192`; the second attempt initially showed
two stale generated `remote` type errors plus a stale spec assertion — resolved by
`pnpm run build:artifacts` and restoring the stash (which carried the updated
refresh script), then rc=0. No source defect was found.

## Scope / claim ceiling

Upstream compatibility only. No feature, cost, paging, model-quality or significance
claim. No profile or host change; a host restart is owed only when the owner wants
the merged module live. No push.

## Owner decisions

1. Push the merge commit (never done by this lane).
2. Decide what to do with the restored uncommitted files (commit them explicitly or
   leave as WIP).
3. Whether to restart the GUI host to load the merged module (affects every lane).
