# RR-W22-20261122-ORREASONING — per-model reasoning profiles from OpenRouter metadata

Date: 2026-11-22. Lane: dsh. No push by this lane. Attribution:
kapitaali <teppo@kapitaali.com>. Plan:
`ctxvm-dsh-scaffold/handoffs/30-openrouter-reasoning-plan.md`.

## What changed

The OpenRouter model-health sidecar is now version 2 and carries a per-model
`reasoning` profile. `refresh-connection-catalog.ts` maps OpenRouter's
`reasoning.supported_efforts` to DSH levels:

- `none` → `off: null` (omitted unless the model is mandatory reasoning);
- `minimal`/`low` → `low: 'low'`;
- `medium`/`high`/`xhigh` → `high: 'high'`;
- `max` → `max: 'max'`.

Every reasoning profile includes `off: null`, including mandatory-reasoning
models. pi-ai otherwise sends `reasoning.effort: "none"` when no effort is
selected, which OpenRouter rejects with `Reasoning is mandatory ... cannot be
disabled`. A model with no usable reasoning levels is written as
`reasoning: false`; version 1 cache entries migrate that way. `sync-connection-models.mjs` reads
the sidecar and writes each model entry's `reasoningEfforts` from that profile,
instead of copying the connection-wide map to every model. Other routes keep the
old behavior.

`dsh connection use` / `applyConnectionToProfile` is unchanged and still uses
the connection-wide map; this card closes the refresh/merge path only.

## Verification to run after copying

```
pnpm exec vitest run scripts/refresh-connection-catalog.spec.ts
pnpm exec tsc -b tsconfig.host.json
pnpm run refresh:connections -- --connection openrouter --profile web --dry-run
```

The staged tests cover effort mapping, cache migration, and per-model output in
the sync merge. No model call, spend, credential, or profile write by this lane.

## Claim ceiling

Prevents locally thrown `UNSUPPORTED_REASONING_EFFORT` errors and the
OpenRouter mandatory-reasoning 400 for refreshed profile patches. It does not claim provider acceptance, model quality, or any
behavior change for `dsh connection use`.
