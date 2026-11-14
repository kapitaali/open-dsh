# W22 — Connection profiles for the dsh fork

**Status:** plan (owner-directed investigation 2026-11-14) · **Card:** W22 · **Date:** 2026-11-14
**Repos:** ctxvm `/home/theb/Documents/ctxvm` · dsh `/home/theb/Apps/deepseek-harness` (release 0.2.2-rc.3, origin `deepseek-ai/deepseek-harness`)

---

## 1. Goal

Fork the deepseek harness and add **connection profiles**: the default profile keeps the
default DeepSeek connection; a custom profile can be given an API endpoint URL and an API
key, and it connects there instead of the default.

---

## 2. What the investigation found

### 2.1 A dsh profile is a composition, and its connection lives in its patch

- A profile is a directory `$DSH_HOME/profiles/<name>/` holding `package.json`
  (`dsh.profile.bundles`), `cordis.patch.yml` (the user patch layer), `pnpm-workspace.yaml`,
  and `node_modules/`.
- The connection is configured by the `llm-deepseek` row (`@deepseek-ai/dsh-llm-deepseek-api-key`):
  - `baseURL` — endpoint; falls back to `$DEEPSEEK_BASE_URL`, then `https://api.deepseek.com/anthropic`.
  - `apiKeyEnv` — a **credential reference** (default `DEEPSEEK_API_KEY`), resolved per request.
- The profile patch **replaces a row's whole config** by id. So a profile can pin a connection with:
  ```yaml
  - id: llm-deepseek
    name: '@deepseek-ai/dsh-llm-deepseek-api-key'
    config:
      baseURL: https://my-endpoint.example
      apiKeyEnv: MY_ENDPOINT_API_KEY
  ```
  The plugin's zod Config supplies defaults for every field the patch omits.
- The credentials service stores keys in `$DSH_HOME/.credentials.yaml` — a versioned YAML
  document with two spaces: `refs` (key values by environment-variable name) and `records`
  (per-plugin credentials). Precedence: stored file → launch environment → project `.env` →
  harness-home `.env`. Writes are `withFileLock` + `writeFileAtomic` at mode `0600` / dir `0700`.

### 2.2 The config-editor already solves the hard part

`packages/boot/config-editor` shows exactly how to edit a profile patch:
`parseDocument` (with the `!!js` custom tag preserved) → find the row by `id`/`name` →
`setIn([index, 'config'], …)` → `String(document)` → atomic write at mode `0600`. It preserves
comments and `!!js` expressions outside the replaced value. A CLI command reproduces this
minus the HMR reload.

### 2.3 The CLI has a subcommand pattern to copy

`apps/cli/src/args.ts` registers `dsh plugin` as a commander subcommand that manages a
profile's packages. A `dsh connection` subcommand fits the same shape.

### 2.4 `llm-pi-ai` is the precedent for multiple connections

`@deepseek-ai/dsh-llm-pi-ai` already routes to multiple providers and hand-declared gateways
from one `providers` dictionary (each with `baseURL`, `apiKeyEnv`, `api`, `models`). The
Models settings page (`client/ui-settings-models`) already lets a user add a provider row,
type an API key (stored write-only under a derived `<ROUTE>_API_KEY` ref), and edit the model
list. So a custom connection is **already configurable by hand** — what is missing is a
first-class, reusable, CLI-reachable "connection profile" abstraction.

### 2.5 What is actually missing

1. A named connection abstraction (reusable across profiles).
2. A CLI path (headless / scriptable setup).
3. A way to attach a connection at profile creation.
4. (Optional) a settings-UI section.

---

## 3. Design

### 3.1 Connection store

`$DSH_HOME/connections.yaml` — a small versioned YAML document:

```yaml
version: 1
connections:
  - name: my-endpoint
    baseURL: https://my-endpoint.example
    apiKeyEnv: MY_ENDPOINT_API_KEY
```

- The API key itself is **never** in this file; it lives in the credentials store under
  `apiKeyEnv` (the same `refs` space as every other key).
- `name` is a lowercase-hyphenated identifier (the same grammar the credentials record space
  enforces for storability).

### 3.2 CLI command — `dsh connection`

| Command | Effect |
|---|---|
| `dsh connection add <name> --url <url> --key <key>` | Store the connection in `connections.yaml`; store the key under `<name>_API_KEY` in the credentials file |
| `dsh connection use <profile> <name>` | Write the connection into the profile's `cordis.patch.yml` (the `llm-deepseek` row's `config`) |
| `dsh connection list` | List connections, marking which profile (if any) uses each |
| `dsh connection show <name>` | Show one connection (masked key state) |
| `dsh connection remove <name>` | Remove the connection and its stored key |

Convenience (profile creation):
- `dsh connection create <profile> --url <url> --key <key> [--from-default-profile web]`
  — init the profile from a template, then apply the connection. This is the
  "add another profile and give it a URL and key" flow in one command.

### 3.3 What `dsh connection use` writes

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    baseURL: https://my-endpoint.example
    apiKeyEnv: MY_ENDPOINT_API_KEY
```

Written with the config-editor's algorithm (preserve comments / `!!js`, atomic `0600` write).

### 3.4 What stays unchanged

- The `llm-deepseek` plugin: it already reads `baseURL` + `apiKeyEnv` per request.
- The credentials store: it already resolves a `CredentialRef`.
- The profile/bundle system: the connection is ordinary profile config.
- The default profile: with no patch row, the plugin falls back to
  `$DEEPSEEK_BASE_URL` / `DEEPSEEK_API_KEY` / the public API — i.e. the default DeepSeek
  connection.

---

## 4. Implementation steps

1. **Fork** the repo (`github.com/kapitaali/deepseek-harness`, or a local-only fork).
2. **Connection store module** — a new package `packages/util/connection-store/`
   (`@deepseek-ai/dsh-connection-store`): read/write `connections.yaml`, atomic writes,
   schema validation, name grammar. (A `util` package keeps it dependency-light.)
3. **CLI command** — `apps/cli/src/connection.ts` + registration in `args.ts`:
   - `add` / `use` / `list` / `show` / `remove` / `create`.
   - `use` reuses the config-editor serialization (extract a shared helper if the
     config-editor's algorithm is not exported).
   - `add` writes the credentials file with `withFileLock` + `writeFileAtomic` (mode `0600`).
4. **Tests** — unit tests for the store (round-trip, validation, atomic write) and the CLI
   (patch serialization, credential write, idempotence).
5. **Docs** — a README for the fork's connection feature; update the CLI help.
6. **Build + distribute** — `pnpm install && pnpm run build`; decide the distribution channel
   (npm package, tarball, or run-from-source).

---

## 5. Risks

1. **Writing the credentials file directly.** It is a secret file with a strict schema
   (`version`, `refs`, `records`); a malformed write is refused at boot. Mitigation: reuse the
   credentials-local writer primitives (`withFileLock`, `writeFileAtomic`, mode `0600`), and
   validate the document before writing.
2. **YAML serialization.** The profile patch may carry comments and `!!js` expressions that
   must survive. Mitigation: copy the config-editor's `parseDocument` + `String(document)`
   approach (it preserves both).
3. **Profile patch conflicts.** A home patch or `--patch` overlay may override the profile's
   `llm-deepseek` config (the config-editor refuses such writes). Mitigation: detect and report
   the conflict; never silently clobber a higher layer.
4. **Key naming.** `<name>_API_KEY` must be a valid credential ref and must not collide with an
   existing key. Mitigation: validate the name; refuse a collision.
5. **Distribution.** A fork needs its own build and distribution path; the upstream release
   workflow publishes to npm under `@deepseek-ai`. Open question for the owner.

---

## 6. Open questions (owner)

1. **Named connections vs per-profile connections.** The design above uses named, reusable
   connections. A simpler variant ties the connection to the profile (no `connections.yaml`;
   `dsh connection <profile> --url … --key …` writes the patch directly). Which do you want?
2. **Distribution channel.** npm package, tarball, or run-from-source? Affects the fork's CI.
3. **Settings UI.** Should the connection also be manageable from the Web Settings page, or is
   the CLI enough for now?
4. **Default profile name.** The launcher has no built-in default; `dsh web` is the de-facto
   default. Should the fork add a `default` profile alias?
5. **Key input.** `--key` on the command line is visible in shell history. Should `add` prompt
   for the key instead (like the Models page does)?

---

## 7. Out of scope

- Changing the `llm-deepseek` plugin's config schema or the credentials store's schema.
- Changing the profile/bundle composition model.
- Any ctxvm-side work (this is a dsh-fork feature).
