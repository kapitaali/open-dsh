---
description: "Keep DSH OAuth credentials in sync with a Hermes install as tokens rotate."
kind: "package-bundle"
---

# @deepseek-ai/dsh-hermes-token-sync

English | [中文](README.zh.md)

## Summary

Watches a Hermes install's `auth.json` and pushes each configured provider's OAuth access token into the DSH credential store as it rotates. `credentials-local` reloads its document on external edits and `llm-pi-ai` resolves a credential reference per request, so a refreshed token reaches the next model call without a host restart.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount the bundle in a profile. The patch inserts the `hermes-token-sync` row:

```yaml
- id: hermes-token-sync
  name: '@deepseek-ai/dsh-hermes-token-sync'
  config:
    enabled: true
    hermesHome: '~/.hermes'
    providers:
      - nous
    debounceMs: 200
```

`providers` lists Hermes provider ids; each maps to the `<NAME>_ACCESS_TOKEN` credential reference (for example `nous` → `NOUS_ACCESS_TOKEN`). The plugin needs the `credentials` service, which `@deepseek-ai/dsh-credentials-local` provides in the base bundle. Set `enabled: false` to disable sync without removing the row.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

On activation the plugin reads `auth.json`, resolves each configured reference, and calls `ctx.credentials.set` only when the token differs from the stored value. A `node:fs` watcher on the auth directory fires on writes; a debounce window settles the write before the next sync. Token values are never logged, only the reference name and provider. Failures warn and leave the last good credential in place.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Credentials](../credentials/README.md) — the credential-reference seam.
- [Credentials local](../credentials-local/README.md) — the file-backed provider this writes.
- [llm-pi-ai](../../llm/llm-pi-ai/README.md) — the per-request credential consumer.

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

Nothing directly. This plugin has no model-visible output; it keeps the provider credential valid so model requests using credentials such as `NOUS_ACCESS_TOKEN` authenticate.

#### Token effect

Zero direct token effect. This plugin never adds text to a request.

#### KV Cache effect

None. This plugin does not alter request prefixes.

## Dev Note

The watcher uses the auth-file parent directory so atomic rename replacements remain observable. Tests cover stale-to-current sync, idempotent writes, malformed auth data, and watcher disposal without logging token values.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Syncs the access token Hermes has already written; it does not run the OAuth refresh flow itself.
- A token that expires mid-session can still fail; the next rotation or Hermes refresh restores it.
- Reads only the providers named in `providers`; other credential references are untouched.
