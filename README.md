# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

> **This checkout is `open-dsh`, a fork of upstream DeepSeek Harness.** It adds exactly one feature on top of upstream: **connection profiles** — a profile can use its own API endpoint and API key instead of the default DeepSeek connection. Everything else is upstream. See [Connection profiles](#connection-profiles).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/kapitaali/open-dsh.git
cd open-dsh
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Connection profiles

`open-dsh` adds **connection profiles**: a named API endpoint plus an API key that a profile uses instead of the default DeepSeek connection. The default profile is unchanged — only a profile you point at a connection behaves differently.

Run these through the `dsh` launcher: `pnpm dsh …` from a source checkout, or plain `dsh` once `@deepseek-ai/dsh` is installed from npm.

### Quick start

```sh
pnpm run setup:hermes
pnpm run refresh:connections
pnpm dsh nous
```

Then pick a model in the composer: the connection's provider lists what its endpoint advertises.

### Create a profile that uses a connection

```sh
dsh connection create my-profile --url https://my-endpoint.example --key sk-…
dsh my-profile
```

Booting a name that is not yet a profile works too: `dsh <name>` creates the profile from the `web` template and applies the connection of that name (override the template with `DSH_PROFILE_TEMPLATE=headless`, or do it by hand with `dsh connection use <name> <name> --from-default-profile web`).

### Or point an existing profile at a saved connection

```sh
dsh connection add my-endpoint --url https://my-endpoint.example --key sk-…
dsh connection use my-profile my-endpoint
```

`use` creates the profile directory if it is missing. Pass `--from-default-profile <web|headless|sdk|acp>` to give a brand-new profile that template's application bundles — without it the profile gets only the base composition and has no server to boot:

```sh
dsh connection use my-profile my-endpoint --from-default-profile web
dsh my-profile
```

### Choosing the wire protocol

`--route` selects how the profile applies the connection. The default is `deepseek`, which speaks the Anthropic Messages wire used by the DeepSeek official API. For an OpenAI-compatible endpoint — NVIDIA NIM, Nous Portal, most gateways — pass `--route pi-ai` and a model:

```sh
dsh connection create nvidia --url https://integrate.api.nvidia.com/v1 --key nvapi-… \
  --route pi-ai --model nvidia/nemotron-3.5-super-vl-120b-a12b
```

### Choosing a model

A `pi-ai` connection may omit `--model`; the route then defers to the provider's installed catalog and the composer lists what the endpoint advertises. A headless run has no composer, so give it one — and note that a connection without a model leaves the profile's default route untouched, so the command says so rather than silently calling a different provider:

```sh
pnpm run refresh:connections
dsh connection add nous-luna --url https://inference-api.nousresearch.com/v1 --key <token> \
  --route pi-ai --model openai/gpt-6-luna
dsh connection use nh nous-luna --from-default-profile headless
dsh nh "Reply with exactly: OK"
```

`DSH_PROFILE_TEMPLATE` (default `web`) selects the template when a profile is created implicitly.

### Managing connections

```sh
dsh connection list
dsh connection show <name>
dsh connection remove <name>
```

### Importing keys from Hermes

If Hermes already holds your provider keys, import them into the dsh credential store instead of retyping them. The setup step asks where Hermes is installed (default `~/.hermes`), reads its `.env` **and** its `auth.json` portal logins, writes the dsh credential file, and turns each recognised provider key into a connection using the provider's catalog endpoint:

```sh
pnpm run setup:hermes
```

Example output:

```text
Importing 6 credentials (skipping 11 non-credential)
  imported OPENROUTER_API_KEY
  imported NVIDIA_API_KEY
  …
  added connection openrouter (pi-ai, https://openrouter.ai/api/v1)
  added connection nvidia (pi-ai, https://integrate.api.nvidia.com/v1)
  added connection deepseek (deepseek, https://api.deepseek.com)
  added connection nous (pi-ai, https://inference-api.nousresearch.com/v1)
```

`--model <id>` and `--api <protocol>` apply to every created `pi-ai` connection, `--keys-only` skips connection creation, `--all` imports every assignment, and `--dry-run` previews. Values are never printed.

### Refreshing the model catalog

A connection's model list can be pulled from its own endpoint:

```sh
pnpm run refresh:connections
```

For each `pi-ai` connection this asks the endpoint (`GET {baseURL}/models`) with the stored credential and stores the advertised ids on the connection. It also merges those ids into every profile that already configures the same connection, so an open model picker sees the refreshed list after the profile reloads. Pass `--profile <name>` to limit the merge to named profiles, `--replace` to remove ids the endpoint no longer advertises, `--prefer-catalog` to answer known providers from the installed registry instead (no network call, and it carries capacities a listing omits), one or more connection names to limit the run, or `--dry-run` to preview. Connections on the `deepseek` route have no endpoint listing and are skipped.

### Switching the reasoning effort

`/reasoning` shows or changes this session's reasoning effort — `/reasoning show` reports the current provider, model, and effort, and `/reasoning high` (or `off`, `minimal`, `low`, `medium`, `xhigh`, `max`, `ultra`) records the change for the session's later steps. It never reaches the model.

### Notes

- The API key is stored in a private file (`$DSH_HOME/.credentials.yaml`, mode `0600`), never in the profile configuration.
- `--key` is optional: omit it when the reference is already in the credential store, for example after `pnpm run setup:hermes`.
- Connection names are lowercase with hyphens (`my-profile`, not `My Profile`).
- `use` and `create` write an ordinary profile patch row; the connection document itself lives at `$DSH_HOME/connections.yaml` and holds no secret.
- Design and verification record: [reports/RR-W22-20261114.md](reports/RR-W22-20261114.md).

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/kapitaali/open-dsh/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/kapitaali/open-dsh}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
