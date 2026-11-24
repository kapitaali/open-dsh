# BUG_REPORT — connection patch writers preserve excessive YAML aliases

Date: 2026-11-24. Status: fixed and verified. Affected code: `scripts/sync-connection-models.mjs` and `packages/util/connection-store/src/index.ts`.

## Symptom

`pnpm dsh web` fails before plugin activation:

```text
Error: dsh: failed to parse overlay $DSH_HOME/profiles/web/cordis.patch.yml:
ReferenceError: Excessive alias count indicates a resource exhaustion attack
```

The failure returned after `pnpm run refresh:connections -- opencode` updated the web profile.

## Evidence

The live web patch contains 437 YAML aliases and 2 anchors. Cordis parses profile patches with the YAML library's default `maxAliasCount` of 100. The aliases are repeated `reasoningEfforts` maps in provider model entries.

A minimal probe shows that `aliasDuplicateObjects: false` prevents new duplicate-object aliases but does not inline aliases already present in a parsed `Document`:

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

## Root cause

Both connection patch writers serialize a parsed YAML `Document` with `stringify(document, { aliasDuplicateObjects: false })`. That option only controls aliases created from repeated JavaScript object identities. Existing `Alias` nodes remain in the document and are written back unchanged. A refresh of one provider therefore preserves every alias already stored elsewhere in the same profile patch.

The earlier alias-limit fix removed aliases from newly created model objects but did not remove pre-existing alias nodes. The live web patch regressed when a later refresh rewrote the document.

## Fix

Both writers now traverse the parsed YAML document and replace every `Alias` node with a detached clone of its resolved source. A second traversal removes all anchors. Serialization still uses `aliasDuplicateObjects: false` to prevent new aliases. Header comments and `!!js` scalar tags remain intact.

Regression tests start with 120 aliases, perform a connection write, and assert zero aliases and anchors. They also parse the result through the runtime YAML parser and verify the header comment, `!!js` expression, and new model entry.

## Live repair and verification

The repair removed 530 aliases and 7 anchors across six live profile patches. The web patch changed from 437 aliases to zero. All nine profile patches then passed `parseEntryYaml` with zero aliases and zero anchors.

`pnpm dsh web --no-open --port 0` printed the server URL and activated `ctxvm`, `dsh-memento`, and `hermes-creds`. The command reached the 30-second tool timeout because the server remained running; no alias error occurred, and no test server process remained afterward.

Focused verification passed: 90 tests, host TypeScript check, and lint for the changed implementation and package test files.

## Scope boundary

The runtime parser limit is not the defect. Do not raise `maxAliasCount` in the loader to make the generated data acceptable.
