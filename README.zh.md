# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

> **本检出是 `open-dsh`，是上游 DeepSeek Harness 的一个 fork。** 它只在上游之上增加了一个功能：**连接配置（connection profiles）**——一个 profile 可以使用自己的 API 端点与 API 密钥，而不是默认的 DeepSeek 连接。其余部分均为上游内容。参见[连接配置](#connection-profiles)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/kapitaali/open-dsh.git
cd open-dsh
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

<a id="connection-profiles"></a>

## 连接配置

`open-dsh` 增加了**连接配置（connection profiles）**：一个命名的 API 端点加上一个 API 密钥，profile 用它们替代默认的 DeepSeek 连接。默认 profile 不受影响——只有你显式指向某个连接的 profile 才会不同。

请通过 `dsh` 启动器运行这些命令：在源码检出中用 `pnpm dsh …`，通过 npm 安装 `@deepseek-ai/dsh` 后直接用 `dsh`。

### 创建一个使用连接的 profile

```sh
dsh connection create my-profile --url https://my-endpoint.example --key sk-…
dsh --profile my-profile
```

### 或者把已有 profile 指向一个已保存的连接

```sh
dsh connection add my-endpoint --url https://my-endpoint.example --key sk-…
dsh connection use my-profile my-endpoint
```

### 选择线路协议

`--route` 选择 profile 应用连接的方式。默认是 `deepseek`，使用 DeepSeek 官方 API 所用的 Anthropic Messages 线路。对于 OpenAI 兼容的端点（NVIDIA NIM、Nous Portal、大多数网关），传入 `--route pi-ai` 与一个模型：

```sh
dsh connection create nvidia --url https://integrate.api.nvidia.com/v1 --key nvapi-… \
  --route pi-ai --model nvidia/nemotron-3.5-super-vl-120b-a12b
```

### 管理连接

```sh
dsh connection list
dsh connection show <name>
dsh connection remove <name>
```

### 从 Hermes 导入密钥

如果 Hermes 已经保存了你的提供方密钥，可以把它们导入 dsh 凭据存储，而不必重新输入。该安装步骤会询问 Hermes 的安装位置（默认 `~/.hermes`），读取其 `.env`，写入 dsh 凭据文件，并把每个识别出的提供方密钥变成一个连接（使用该提供方目录中的端点）：

```sh
pnpm run setup:hermes
```

示例输出：

```text
Importing 6 credentials (skipping 11 non-credential)
  imported OPENROUTER_API_KEY
  imported NVIDIA_API_KEY
  …
  added connection openrouter (pi-ai, https://openrouter.ai/api/v1)
  added connection nvidia (pi-ai, https://integrate.api.nvidia.com/v1)
  added connection deepseek (deepseek, https://api.deepseek.com)
```

`--model <id>` 与 `--api <protocol>` 会应用到每个创建的 `pi-ai` 连接，`--keys-only` 跳过连接创建，`--all` 导入每个赋值，`--dry-run` 预览。密钥值绝不被打印。

### 说明

- API 密钥保存在私有文件中（`$DSH_HOME/.credentials.yaml`，权限 `0600`），绝不写入 profile 配置。
- `--key` 是可选的：当引用已在凭据存储中时（例如在 `pnpm run setup:hermes` 之后）可省略。
- 连接名使用小写加连字符（`my-profile`，而不是 `My Profile`）。
- `use` 与 `create` 写入的是普通的 profile 补丁行；连接文档本身位于 `$DSH_HOME/connections.yaml`，不含任何密钥。
- 设计与验证记录：[reports/RR-W22-20261114.md](reports/RR-W22-20261114.md)。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/kapitaali/open-dsh/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/kapitaali/open-dsh}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
