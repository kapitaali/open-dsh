# RR-W22-20261121-OPENROUTERE2E-ERR — reproduced CI failures and fix

Date: 2026-11-21 (local). Lane: dsh. Investigation + fix committed as `45280f66ec`. No push.

## Result

The CI failures in `packages/llm/llm-deepseek/tests/adapter.e2e.ts` were caused by commit `4324929402` ("run adapter E2E on OpenRouter Messages"), which repointed the DeepSeek Messages adapter E2E suite at `https://openrouter.ai/api` but kept DeepSeek-specific request shapes. Reproduced locally with the working OpenRouter key (SHA prefix `038578bd45`; the dsh-store copy was stale — `401 User not found`).

Repro (key sourced from `.env` inside the shell, never printed):

```
DEEPSEEK_API_KEY=<working key> DEEPSEEK_BASE_URL=https://openrouter.ai/api \
DEEPSEEK_E2E_MODEL=inclusionai/ling-3.2-flash:free DSH_E2E_MAX_WORKERS=1 \
pnpm exec vitest run --config vitest.e2e.config.ts packages/llm/llm-deepseek/tests/adapter.e2e.ts
→ 12 failed / 5 skipped / 17 total  (identical to CI, even with 1 worker → not a concurrency issue)
```

## Root causes, all reproduced against the live endpoint

1. **HTTP 400 `INVALID_REQUEST: Invalid Anthropic Messages API request`**:
   - `thinking: { type: 'enabled' }` without `budget_tokens` → 400. DeepSeek accepts it; OpenRouter/Anthropic requires it. Hit the 4 effort tests.
   - `tool_addition` / `tool_removal` developer-message blocks (`serialize.ts:96-97`) → 400. DeepSeek-specific, rejected by OpenRouter. Hit the 3 tool-update tests.
   - Unsigned `thinking` blocks in replay history → 400. Anthropic-compatible endpoints require a signature. Hit the replay-degradation test.
   - Control: `thinking: { type: 'disabled' }` → 200; plain tools → 200.
2. **HTTP 429 `RATE_LIMIT`** from the free model `inclusionai/ling-3.2-flash:free`, reproduced with a direct request. The owner then named two usable free models; `nvidia/nemotron-3.5-lightning:free` was chosen.

## Why the earlier "fix" did not help

`a827fdd830` (and `ca9fe40ceb`) only add secret-name fallbacks so the key is found. They do not change request shape or rate-limit exposure. CI's key was present — the 400/429 were protocol responses.

## Fix (committed `45280f66ec`)

Per owner decision: stay on OpenRouter free models.

- `.github/workflows/e2e.yml` — CI model set to `nvidia/nemotron-3.5-lightning:free`.
- `tests/adapter.e2e.ts` — the non-official fetch wrapper now also adds `budget_tokens: 1024` to enabled thinking, drops `tool_addition`/`tool_removal` blocks (the declared `tools` array already carries them), and drops unsigned historical thinking blocks. The official DeepSeek wire format is unchanged.
- `src/translate.ts` — `null` usage token buckets are treated as unreported, not malformed. OpenRouter sends `cache_read_input_tokens: null` at `message_start`; DeepSeek sends integers.
- `tests/stream.spec.ts` — unit test for null usage buckets.

## Verification

```
adapter.e2e.ts (working key, free model): 12 passed | 5 skipped (both 1 and 6 workers)
llm-deepseek unit suites (env cleared):   741 passed
tsc -b tsconfig.host.json:                rc=0
pre-commit hooks:                         lint / whitespace / vendor guard all pass
```

## Honest limits

- The dsh-store OpenRouter key was stale; only the `.env` copy was valid during investigation. CI uses a repo secret that is valid.
- No cost-saving, parity, or model-quality claim. Live E2E now exercises the adapter against a free model with no spend by this lane.
- The test-side translations are scoped to non-official endpoints; they do not change the adapter's output on the official route.
