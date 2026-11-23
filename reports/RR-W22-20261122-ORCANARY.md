# RR-W22-20261122-ORCANARY — opt-in runtime canary for OpenRouter models

Date: 2026-11-22. Lane: dsh. No push by this lane. Attribution:
kapitaali <teppo@kapitaali.com>. Plan:
`ctxvm-dsh-scaffold/handoffs/31-openrouter-canary-plan.md`.

## Problem

`baidu/ernie-5.5-flash-preview:free` remains listed even though it fails at
runtime. OpenRouter metadata reports `status: 0`, tools supported, and 100%
uptime, so capability and endpoint-health filters cannot detect this class of
failure. A real, minimal request is required.

## What changed

`scripts/refresh-connection-catalog.ts` gains `--canary` (opt-in, default off)
and `probeOpenRouterModels()`. With a stored key, it sends one non-streaming
`POST {baseURL}/chat/completions` per surviving model:

- `max_tokens: 16`, one short user message, one simple tool definition,
  `tool_choice: 'auto'`;
- `Authorization: Bearer <key>` scoped to that request;
- 20 s timeout, concurrency 4.

Results are stored in an optional `runtime` field on the health-cache entry:
- 2xx with `choices` or `id` → `ok`; the probe sends `reasoning.effort`
when the cached per-model profile requires reasoning;
- 400/404 → `failed` with a sanitized reason (max 200 chars);
- 401/402/403 → account-level abort; remaining probes stop and no model is
  marked failed;
- 429/5xx/network error → `unknown`, model retained.

Failed models are removed from the written connection id list and from a profile
only when the owner also passes `--replace`; additive merges keep existing
profile ids by design. The refresh report prints `canary_ok`, `canary_failed`,
`canary_unknown`, and `canary_aborted`. No key value is printed.

The health cache stays version 2 with an optional `runtime` field; older entries
are treated as unknown until probed.

## Verification to run after copying

```
pnpm exec vitest run scripts/refresh-connection-catalog.spec.ts
NODE_OPTIONS=--max-old-space-size=8192 npx tsc -b tsconfig.host.json
```

Staged tests cover deterministic failure removal, 429/5xx retention, account
abort, request shape, mandatory reasoning, and dry-run no-write. The DSH session
`session-bb8f30b7…` showed the real baidu/ernie error: "Reasoning is mandatory
for this endpoint and cannot be disabled." Layer 2 removes `off` for that model;
this canary now exercises the same requirement. No canary call by this lane.

## Important owner command

```sh
pnpm run refresh:connections -- --connection openrouter --profile web --replace --canary
```

This makes real model calls and can hit free-tier rate limits; use a low-limit
key. `--replace` is required to remove stale ids from the web profile.

## Claim ceiling

Removes models with deterministic runtime failures. Does not guarantee a model
will never fail later, and makes no quality, cost, or latency claim.
