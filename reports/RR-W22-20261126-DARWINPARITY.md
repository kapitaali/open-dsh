# RR-W22-20261126-DARWINPARITY — fix macOS unit-test drift

Date: 2026-11-26. Lane: dsh. Workspace-staged; no checkout write, commit, push,
secret change, or model call.

## Failure

The `unit tests (darwin parity, macos-latest)` job on `b584c9d1b7` failed in four
groups:

1. `scripts/ci-workflow.spec.ts` still expected the legacy DeepSeek secret,
   old E2E step name, and DeepSeek endpoint.
2. `scripts/gen-tsconfig-paths.spec.ts` found
   `@deepseek-ai/dsh-hermes-token-sync` without a committed source alias.
3. `scripts/doc-standard.spec.ts` found the Hermes READMEs had the wrong kind
   and lacked the required English/Chinese Dev Note skeleton.

## Fix

- Updated CI workflow assertions to the OpenRouter-only secret, free Nemotron
  model, OpenRouter endpoint, and current E2E step name; added explicit free-model
  assertions.
- Added the hand-written tsconfig alias for the Hermes token-sync package, whose
  name does not match its directory and is therefore skipped by the generator.
- Changed both Hermes README frontmatter kinds to `package-bundle`.
- Added the required English `Dev Note` and Chinese `开发备注` sections while
  preserving bilingual physical-line alignment.

## Verification

A workspace-only overlay ran the exact three failing spec files against the
staged fixes:

```
scripts/ci-workflow.spec.ts       74 passed
scripts/gen-tsconfig-paths.spec.ts 7 passed
scripts/doc-standard.spec.ts      22 passed
total                            103 passed
```

No real-provider request was made. The OpenRouter key rotation is independent of
this source fix.
