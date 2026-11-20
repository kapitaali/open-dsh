# RR-W22-20261120-ALIASLIMIT — upstream merge alias-limit boot failure and fix

Date: 2026-11-20. Context: upstream merge `e1274cf7f3` (upstream `2e39e704`) and
follow-ups `7b8510a9f9` / `8018fcb16f` are already pushed. This card records the
durable writer fix still owed after that merge. No spec/corpus/credential byte changed.
Landed with this commit.

## Symptom

After the merge, `pnpm dsh web` failed before activation:

```
Error: dsh: failed to parse overlay /home/theb/.dsh/profiles/web/cordis.patch.yml:
ReferenceError: Excessive alias count indicates a resource exhaustion attack
```

## Root cause

The merged `vendor/include/src/index.ts` calls `document.toJS()` with the `yaml`
library's default `maxAliasCount: 100`. The connection-merge writer had put the
same `reasoningEfforts` object into hundreds of model entries, so the generated
profile patches carried far more aliases than 100 (web 940, openrouter 476,
nous 412, nvidia 32, three others 20 each). Upstream's own writer contract is
`aliasDuplicateObjects: false` — it never emits aliases. The data was at fault,
not the parser.

## Fix

1. Regenerated the seven affected profile patches with `toJS({maxAliasCount:
   100000})` → `stringify(..., {aliasDuplicateObjects:false, lineWidth:-1})`,
   preserving the header comment. Aliases remaining: 0 in all nine profiles.
   Runtime state in `~/.dsh/profiles/*`, outside the repo.
2. Durable writer fixes (so a refresh cannot reintroduce aliases):
   - `packages/util/connection-store/src/index.ts` — `applyConnectionToProfile`
     now serializes with `stringify(document.toJSON(), {aliasDuplicateObjects:false})`
     instead of `String(document)`.
   - `scripts/sync-connection-models.mjs` — same change in `mergeConnectionModels`.
   The sync script fix already landed in `8018fcb16f`; the remaining tracked fix here is
   `packages/util/connection-store/src/index.ts`.

## Verification (commands + results)

```
parseEntryYaml() over all 9 ~/.dsh/profiles/*/cordis.patch.yml  → all OK (web: 3 entries)
pnpm dsh web --no-open --port 0  → booted, served http://127.0.0.1:44855/, no alias error;
  [ctxvm] and [hermes-creds] both activated (tokens synced on boot)
tsc -b packages/util/connection-store/tsconfig.json  → rc=0
proof: stringify(data-with-shared-map, {aliasDuplicateObjects:false}) → 0 aliases, inline maps
```

## Honest limits

- Loaded profiles were regenerated from the current connection model lists; their
  content is otherwise unchanged (verified by parse, not by byte diff).
- The tracked writer fix is committed with this card by explicit path; the
  regenerated profile patches themselves are runtime state outside the repo and
  are not committed.
- No full `tools/run-ci.sh` run for this card; verification is the targeted
  parse/boot check and `tsc -b packages/util/connection-store/tsconfig.json` above.
