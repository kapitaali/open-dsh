# RR-W22-20261119-HERMESCREDS — dynamic Hermes→DSH credential sync (no cron)

Card: W22 follow-up (rotating Nous OAuth token). Lane: dsh. Date: 2026-11-19.
No spec/corpus byte changed. No credential value logged. No push.

## Problem

The Nous credential is an OAuth inference JWT (~1 h lifetime). Hermes auto-refreshes
it into `~/.hermes/auth.json`, but DSH's `.credentials.yaml` holds a static snapshot
from import time. Each rotation staleifies the DSH copy → next model call fails
`API key is invalid / AUTH`. Measured twice this session (store sha ≠ Hermes sha).
Owner rejected cron ("lowers adoption rate"); asked for a dynamic solution.

## Key enabling fact (read from source)

`credentials-local` watches `.credentials.yaml` (chokidar, `watch:true` default) and
hot-publishes edits (`reconcileFromDisk` → `notifyUpdated`); `llm-pi-ai` calls
`credentials.resolve(ref)` **per request**. So a credential written through the seam
reaches the next model call with **no gateway restart**. The only missing piece was
something to push the fresh token when Hermes rotates it.

## Solution — `@local/dsh-hermes-creds` (event-driven local plugin)

New local bundle in the workspace (`default-workspace/dsh-hermes-creds/`), modeled on
`@local/dsh-memento`. Files: `package.json`, `index.js`, `cordis.patch.yml`,
`locale/en.json`, `icon.svg`, `README.md`.

- `inject=['credentials']`; watches `~/.hermes/auth.json` with `node:fs.watch`
  (debounced, default 200 ms). No cron, no polling loop.
- On startup and on each change, reads `providers.<name>.access_token` for each
  configured provider (default `nous`) and, only if it differs from the resolved
  value, calls `ctx.credentials.set('<NAME>_ACCESS_TOKEN', token)`.
- `credentials-local` persists + hot-publishes; `llm-pi-ai` picks it up next request.
- Never logs a token value; try/catch around read/watch/set so a failure warns but
  never takes the host down.

## Wiring (web profile)

- `~/.dsh/profiles/web/package.json`: added `@local/dsh-hermes-creds` link dependency
  and appended it to `dsh.profile.bundles`.
- Symlink `node_modules/@local/dsh-hermes-creds → ../../../../../Documents/deepseek-harness/default-workspace/dsh-hermes-creds` (matches the dsh-memento pattern).

## Verification (commands + results)

```
node --check index.js                          → SYNTAX OK
node apps/cli/lib/bin.js --dump-config --profile web
   → row dsh-hermes-creds present (enabled:true, providers:[nous]); no ValidationError
# mock-ctx smoke test (schemastery test-aid symlink, removed after):
stale stored token  → set called: {ref:NOUS_ACCESS_TOKEN, len:2114} = real token len  → PASS
current stored token→ no set called (no-op)                                        → PASS
```

## Status / honest limits

- Logic verified with a mock credential service; config composes boot-free.
  **Runtime activation pending a gateway restart** (owner action) — UNVERIFIED until
  the owner restarts and sees `[hermes-creds] watching …` / `synced NOUS_ACCESS_TOKEN`.
- Syncs the access token Hermes has already written; it does not itself run the OAuth
  refresh flow. If Hermes has not refreshed an expired token, the synced value stays
  expired until Hermes refreshes.
- Local plugin (`@local/`), not an official DSH package; lives in the workspace, not
  committed to the DSH checkout or ctxvm. No push.
