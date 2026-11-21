# RR-W22-20261121-OPENROUTERE2E — DeepSeek adapter E2E ported to OpenRouter

Date: 2026-11-21. Lane: dsh. No spend by this lane; no push. Attribution:
kapitaali <teppo@kapitaali.com>.

## What changed

`.github/workflows/e2e.yml` now runs only the DeepSeek Messages adapter E2E
(`packages/llm/llm-deepseek/tests/adapter.e2e.ts`) against OpenRouter's
Messages-compatible endpoint with a free tool-capable model:

- secret: `OPENROUTER_API_KEY_EXTERNAL`, with fallback to the legacy
  `DEEPSEEK_API_KEY_EXTERNAL` name, mapped to `DEEPSEEK_API_KEY`;
- `DEEPSEEK_BASE_URL: https://openrouter.ai/api` (adapter appends `/v1/messages`);
- `DEEPSEEK_E2E_MODEL: inclusionai/ling-3.2-flash:free`;
- targeted vitest command instead of full `pnpm run test:e2e`.

`tests/helpers.ts` reads `DEEPSEEK_E2E_MODEL`, defaulting to the old id.
`tests/adapter.e2e.ts` uses that model, derives baseURL from the env, supplies an
explicit model catalog on non-official endpoints (bypasses DeepSeek's origin
`/models` listing), rewrites `x-api-key` to `Authorization: Bearer` for
OpenRouter, and skips the two DeepSeek-only tests (Files API lifecycle and Loader
inventory/session-log acceptance) unless the base is the official DeepSeek root.

## Verification

```
NODE_OPTIONS=--max-old-space-size=8192 npx tsc -b tsconfig.host.json  → rc=0
env -u DEEPSEEK_API_KEY pnpm exec vitest run --config vitest.e2e.config.ts \
  packages/llm/llm-deepseek/tests/adapter.e2e.ts
  → 17 tests skipped (no key; confirms load/parity of the port)
```

Live validation is owed once the GitHub secret holds a working OpenRouter key;
no local key in this environment is valid (`401 User not found` from OpenRouter).

## Claim ceiling

Reduced gate scope: 15 Messages/tool/replay tests run on a free model; two
DeepSeek-specific tests are skipped. No Files-API, effort, catalog, cost,
parity or model-quality claim. No credentials or trace bytes in the repo.
