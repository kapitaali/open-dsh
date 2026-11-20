# RR-W22-20261119-ALIASFIX — repair the reasoningEfforts alias corruption that disabled all pi-ai providers

Card: W22 follow-up (connection-refresh merge, handoff 20). Lane: dsh. Date: 2026-11-19.
No spec byte, no corpus byte, no credential value changed. No push.

## Symptom

After `refresh:connections --profile web` and a gateway restart, the DSH web UI showed
only the default DeepSeek models; openrouter / nvidia / nous / opencode were absent.

## Root cause (measured from the gateway startup log)

```
dsh: warning: 1 entry did not activate
llm-pi-ai (@deepseek-ai/dsh-llm-pi-ai): ValidationError: invalid config:
  - $.providers.nous.models[413].reasoningEfforts expected false | {…} but got {"source":"a3"}
```

One malformed `reasoningEfforts` entry fails schemastery validation for the **whole**
`llm-pi-ai` row, so the row never activates and **no** pi-ai provider loads. Only the
separate `llm-deepseek-api-key` row activates (log: "loaded 2 model(s)" from
api.deepseek.com) — hence "only deepseek".

The two corrupted entries in `~/.dsh/profiles/web/cordis.patch.yml` were
`stepfun/step-3.5-flash` and `qwen/qwen3-vl-30b-a3b-thinking`, each written as:

```yaml
reasoningEfforts:
  source: a3        # literal dict, NOT a YAML alias
```

instead of `reasoningEfforts: *a5`. These are exactly the two "stale ids" that handoff 20's
additive merge keeps (they are in the profile but not in the refreshed endpoint catalog).

## Generator bug (the reason it will recur without this fix)

`scripts/sync-connection-models.mjs` read existing models with:

```js
modelsNode.items.map(item => isMap(item) ? item.toJSON() : null)
```

On a YAMLMap whose value is an **Alias node** (`reasoningEfforts: *a5`), `item.toJSON()`
does not resolve the alias — it serializes the Alias's internal structure. Measured:

```
item.toJSON()      → {"source":"anchor"}     ❌
item.toJS(document)→ {"off":null,"low":"low"} ✅
```

The corrupted `{source:…}` dicts were merged back and written as literal mappings.
`refresh-connection-catalog.ts` imports `mergeConnectionModels` from this module, so the
refresh path inherited the bug. The connection-store's `applyConnectionToProfile` is NOT
affected: it reads via `document.toJS()` and builds models from plain dicts.

## Fixes applied

1. `~/.dsh/profiles/web/cordis.patch.yml` — replaced the two corrupted
   `reasoningEfforts: {source: a3}` blocks with `reasoningEfforts: *a5`
   (the nous anchor defined at the first nous model). Runtime config, outside the repo.
2. `scripts/sync-connection-models.mjs` (DSH checkout, uncommitted) — one-line change:
   `item.toJSON()` → `item.toJS(document)`.

## Verification (commands + results)

```
# alias-resolution proof (node, yaml from apps/cli):
item.toJSON()       → {"source":"anchor"}
item.toJS(document) → {"off":null,"low":"low"}

# end-to-end merge test on a throwaway DSH_HOME (/tmp/sync-test, removed after):
testp/nous: updated models=3 added=1 removed=0
resulting patch: existing alias-bearing model resolved to an inline dict; grep -c "source:" → 0

# all profiles scanned for the corruption:
for f in ~/.dsh/profiles/*/cordis.patch.yml; do grep -c "source: a" "$f"; done
→ 0 for all 9 profiles (web was the only one affected; now repaired)

# connections.yaml source store: grep -c "source: a" → 0 (was already clean)

# composed config after repair:
node apps/cli/lib/bin.js --dump-config --profile web
→ no ValidationError; providers openrouter(470) nvidia(83) nous(415) opencode(21)

# YAML parse of the repaired web patch (yaml, maxAliasCount 100000):
YAML errors 0; corrupted reasoningEfforts 0 across all four providers
```

## Remaining step (owner)

Restart the gateway to load the repaired config: `pnpm dsh web --no-open`.
The `sync-connection-models.mjs` fix is uncommitted in the DSH checkout
(`git status`: `M scripts/refresh-connection-catalog.ts`, `?? scripts/sync-connection-models.mjs`).
Commit when ready; never push — the owner pushes.

## Limits / honest notes

- The gateway restart itself was not re-run by this lane after the repair; the
  `--dump-config` + YAML-parse checks are boot-free. UNVERIFIED until the owner restarts
  and confirms all four providers render in the web UI.
- No cost, paging, eviction, determinism or model-quality claim is made.
- No credential value, trace byte, or secret appears in this report.
