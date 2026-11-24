# RR-W22-ALIAS-INLINE-20261124 — connection writers preserve excessive YAML aliases

Date: 2026-11-24 (Europe/Helsinki). Branch: `fix/inline-connection-aliases`. Scope: connection profile patch writers and live profile repair. No push.

## Summary

A connection refresh rewrote the web profile but preserved 437 existing YAML aliases. Cordis rejected the patch before plugin activation because its default alias limit is 100. Both connection writers now inline existing aliases, remove anchors, and prevent new duplicate-object aliases. The live patches were repaired, and the web profile booted successfully.

## Root cause

`stringify(document, { aliasDuplicateObjects: false })` prevents new aliases from repeated JavaScript object identities. It does not replace `Alias` nodes already present in a parsed YAML `Document`. The earlier alias-limit fix therefore protected newly created model entries but left older aliases in the same profile patch.

A minimal probe confirmed the behavior:

```text
document-stringify:
- id: x
  config:
    models:
      - reasoningEfforts: &a1 { off: null, low: low }
      - reasoningEfforts: *a1

js-stringify:
- id: x
  config:
    models:
      - reasoningEfforts:
          off: null
          low: low
      - reasoningEfforts:
          off: null
          low: low
```

## Actions taken

1. Reproduced the boot failure from `pnpm dsh web` and counted 437 aliases and 2 anchors in the live web patch.
2. Wrote `packages/util/connection-store/BUG_REPORT.md` before changing the writers.
3. Added `inlineYamlAliases` to `packages/util/connection-store/src/index.ts` and `scripts/sync-connection-models.mjs`. The helper replaces each alias with a detached clone of its resolved source, then removes every anchor.
4. Kept `aliasDuplicateObjects: false` during serialization to prevent new aliases.
5. Added regression tests for both writers. Each test starts with 120 aliases, performs a connection write, and asserts zero aliases and anchors. The tests also verify header comments, `!!js` expressions, runtime YAML parsing, and the new model entry.
6. Backed up the affected live patches to the Hermes scratch directory under `dsh-alias-repair-20261124`.
7. Repaired six live profile patches. The repair removed 967 aliases and 7 anchors. The web patch changed from 437 aliases to zero.
8. Parsed all nine live profile patches through `parseEntryYaml`. Every patch reported zero aliases and zero anchors.
9. Booted the web profile with `pnpm dsh web --no-open --port 0`. The server printed its URL and activated `ctxvm`, `dsh-memento`, and `hermes-creds` without an alias error.

## Verification

Focused tests:

```text
pnpm exec vitest run scripts/refresh-connection-catalog.spec.ts packages/util/connection-store/tests/connection-store.spec.ts packages/llm/llm-pi-ai/tests/discovery.spec.ts
Test Files  3 passed (3)
Tests       90 passed (90)
```

Host TypeScript check:

```text
pnpm exec tsc -b tsconfig.host.json --pretty false
exit 0
```

Focused lint:

```text
node scripts/run-oxlint.ts packages/util/connection-store/src/index.ts packages/util/connection-store/tests/connection-store.spec.ts scripts/sync-connection-models.mjs
exit 0
```

Live parser check:

```text
ctxvm-dsh-local: aliases=0 anchors=0
ctxvm-plana: aliases=0 anchors=0
deepseek: aliases=0 anchors=0
nous: aliases=0 anchors=0
nvidia: aliases=0 anchors=0
opencode: aliases=0 anchors=0
openrouter: aliases=0 anchors=0
test-headless: aliases=0 anchors=0
web: aliases=0 anchors=0
```

Web boot:

```text
$ node --import tsx/esm apps/cli/src/bin.ts web --no-open --port 0
[ctxvm] apply called, enabled = true
[ctxvm] effect running; registering page-table projection
[dsh-memento] active: 0 case(s)
[hermes-creds] watching the Hermes auth directory for [nous]
dsh web: http://127.0.0.1:<port>/?token=[REDACTED]
```

The boot command reached the 30-second tool timeout because the server remained running. No alias error occurred, and no test server process remained afterward.

## Status

The writer fix, regression tests, bug report, live profile repair, and web boot verification are complete. The runtime parser limit was not changed. No push was made.
