---
description: "Named connection profiles for the DeepSeek Harness: an API endpoint plus a credential reference, stored in the harness home."
kind: "package-reference"
---

# @deepseek-ai/dsh-connection-store

English | [中文](README.zh.md)

## Summary

Use `dsh-connection-store` to read and write named connection profiles: one `baseURL` endpoint plus the credential reference that authenticates against it. A connection is the unit the `dsh connection` command creates and a profile applies by writing the `llm-deepseek` row's config in its own patch layer. The document lives at `$DSH_HOME/connections.yaml`, holds no secret value, and is read by the CLI and by embedders — never by the harness runtime itself.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The smallest path is one read and one write:

```ts
import { readConnections, resolveConnectionsPath, writeConnections } from '@deepseek-ai/dsh-connection-store'

const path = resolveConnectionsPath()
const document = await readConnections(path)
await writeConnections(path, {
  version: document.version,
  connections: [...document.connections, { name: 'acme', baseURL: 'https://gateway.acme.example', apiKeyEnv: 'ACME_API_KEY' }],
})
```

`resolveConnectionsPath()` honours `$DSH_HOME`; pass an explicit home in tests. An absent document reads as an empty store. `writeConnections` takes the cross-process writer lock and replaces the file atomically at owner-only permissions.

### Storing the key

The connection document names a credential reference; the key value lives in the credential store. `storeConnectionKey(ref, value)` and `removeConnectionKey(ref)` edit that store's `refs` section with the same comment-preserving, locked, atomic write the credentials provider uses, so a connection's key is stored and removed with the connection:

```ts
import { storeConnectionKey } from '@deepseek-ai/dsh-connection-store'

declare const ref: string
declare const value: string
await storeConnectionKey(ref, value)
```

### Connection fields

| Field | Grammar | Meaning |
|---|---|---|
| `name` | `^[a-z][a-z0-9-]*$` | Handle a person types; unique in the document |
| `baseURL` | HTTP(S) URL, no credentials/query/fragment | Messages-compatible endpoint root |
| `apiKeyEnv` | POSIX environment-variable name | Credential reference resolved per request by the credential seam |

The API key value is never part of this document. It lives in the credential store under `apiKeyEnv`, so rotating a key does not touch the connection.

### Failures to plan for

Parsing is strict. A malformed document, an unknown version, a duplicate name, or a field outside its grammar throws rather than being skipped, because a silently dropped connection reads as "the connection I saved has no effect". A live writer that cannot parse the file it is about to modify must fail rather than overwrite content it could not read.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The document type, parser, serializer, reader, and writer — the package's whole surface |

### Document layout

```yaml
version: 1
connections:
  - name: acme
    baseURL: https://gateway.acme.example
    apiKeyEnv: ACME_API_KEY
```

`version` is validated against `CONNECTIONS_DOCUMENT_VERSION`. An empty file or a mapping without `connections` is an empty store. An unknown top-level key is refused rather than ignored, matching the credentials store's loud-parse rule.

### Write path

`writeConnections` holds `withFileLock` across the whole read-modify-write the caller performs, then `writeFileAtomic` replaces the file. The serialized document carries a two-line header comment naming the manager and the fact that the key lives elsewhere.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Credentials subsystem](../../../docs/subsystems/credentials.md) — the credential seam that resolves `apiKeyEnv`.
- [Credentials store](../../credentials/credentials-local/README.md) — the file that holds the key value.
- [Config editor](../../boot/config-editor/README.md) — the profile-patch writer a connection is applied through.
- [util group map](../README.md) — the utility family this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

None, as this is a pure file-backed store that registers nothing model-facing.

#### KV Cache effect

Nothing here enters a request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the package is not the right tool. They are current package constraints, not a task backlog.

- **No comment preservation** — the document is machine-managed; a write replaces the whole file, so a comment a person wrote in it does not survive.
- **No runtime reader** — the harness runtime does not read this document. A profile applies a connection by copying its values into the profile patch; the runtime resolves the resulting `llm-deepseek` config, not this file.
- **One host and one PID namespace** — the writer lock is the atomic-write lock, so writers on several hosts sharing a network filesystem can contend unsafely, as with every store built on it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
