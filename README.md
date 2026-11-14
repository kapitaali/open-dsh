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

### Create a profile that uses a connection

```sh
dsh connection create my-profile --url https://my-endpoint.example --key sk-…
dsh --profile my-profile
```

### Or point an existing profile at a saved connection

```sh
dsh connection add my-endpoint --url https://my-endpoint.example --key sk-…
dsh connection use my-profile my-endpoint
```

### Choosing the wire protocol

`--route` selects how the profile applies the connection. The default is `deepseek`, which speaks the Anthropic Messages wire used by the DeepSeek official API. For an OpenAI-compatible endpoint — NVIDIA NIM, Nous Portal, most gateways — pass `--route pi-ai` and a model:

```sh
dsh connection create nvidia --url https://integrate.api.nvidia.com/v1 --key nvapi-… \
  --route pi-ai --model nvidia/nemotron-3.5-super-vl-120b-a12b
```

### Managing connections

```sh
dsh connection list
dsh connection show <name>
dsh connection remove <name>
```

### Notes

- The API key is stored in a private file (`$DSH_HOME/.credentials.yaml`, mode `0600`), never in the profile configuration.
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
