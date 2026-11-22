# RR-W22-20261122-ORMODELFILTER — OpenRouter model-list eligibility and health filtering

Date: 2026-11-22. Lane: dsh. No push by this lane. Attribution:
kapitaali <teppo@kapitaali.com>. Plan:
`ctxvm-dsh-scaffold/handoffs/29-openrouter-model-health-plan.md`.

## What changed

`scripts/refresh-connection-catalog.ts` now has an OpenRouter-specific path for
`route: pi-ai` connections whose base URL host is `openrouter.ai`:

- asks `GET /models/user` when a stored key exists, falling back to public
  `GET /models` on credential failure or when no key exists;
- applies server-side filters `output_modalities=text`, `endpoints` for the
  connection's wire protocol, and `supported_parameters=tools`;
- locally drops `:batch`, dynamic routers (`prompt < 0`), expired models,
  non-text output, models without the chosen wire endpoint, and models without
  `tools`;
- checks per-model `GET /models/{id}/endpoints` with bounded concurrency (8),
  requiring at least one endpoint with `status: 0`, tools, usable tool choice,
  and recent uptime >= 95; caches decisions for 6 h in
  `$DSH_HOME/model-health/openrouter.json`;
- keeps a model when the endpoint API fails, reporting it as `health_unknown`
  rather than deleting it on a transient outage;
- reports metadata and health counts on stdout. Key values are never printed.

Other providers and `--prefer-catalog` behavior are unchanged. Non-OpenRouter
connections without a stored key are still skipped. The default model is still
never touched; `--replace` remains the way to make a refreshed list authoritative.

## Verification

```
pnpm exec vitest run scripts/refresh-connection-catalog.spec.ts
  → 15 passed
NODE_OPTIONS=--max-old-space-size=8192 npx tsc -b tsconfig.host.json
  → rc=0
pnpm run refresh:connections -- --connection openrouter \
  --dsh-home /tmp/dsh-or-dryrun-home --dry-run
  → rc=0; total=299 metadata_kept=299 health_kept=293
    health_dropped=6 health_unknown=0 health_requests=299
  → no cache written in dry-run
```

The dry run used a key-free fixture and public metadata endpoints only. No model
call, no spend, no credential/profile write.

## Claim ceiling

This reduces known-bad catalog entries and provider-health failures; it does not
guarantee zero runtime errors. Layer 2 per-model reasoning metadata and Layer 3
canary probes remain separate owner decisions.

## Follow-up

If desired, run a non-dry-run refresh with the real key and `--replace` to write
the filtered list into `connections.yaml`; no profile was changed by this work.
