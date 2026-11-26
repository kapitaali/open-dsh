---
description: "在令牌轮换时使 DSH 的 OAuth 凭据与 Hermes 安装保持同步。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-hermes-token-sync

[English](README.md) | 中文

## 概述

监视 Hermes 安装的 `auth.json`，在每个配置提供方的 OAuth 访问令牌轮换时将其推送到 DSH 凭据存储。`credentials-local` 在外部编辑时重新加载文档，`llm-pi-ai` 在每次请求时解析凭据引用，因此刷新后的令牌无需重启宿主即可用于下一次模型调用。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

在 profile 中挂载该 bundle。补丁插入 `hermes-token-sync` 行：

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

`providers` 列出 Hermes 提供方 id；每个映射到 `<NAME>_ACCESS_TOKEN` 凭据引用（例如 `nous` → `NOUS_ACCESS_TOKEN`）。插件需要 `credentials` 服务，基础 bundle 中的 `@deepseek-ai/dsh-credentials-local` 提供该服务。设置 `enabled: false` 可在不移除行的情况下禁用同步。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

激活时插件读取 `auth.json`，解析每个配置的引用，仅在令牌与存储值不同时调用 `ctx.credentials.set`。auth 目录上的 `node:fs` 监视器在写入时触发；防抖窗口在下一次同步前等待写入完成。从不记录令牌值，只记录引用名和提供方。失败会发出警告并保留上一个有效凭据。

</details>

<a id="further-exploration"></a>
## 延伸探索

- [凭据](../credentials/README.zh.md) — 凭据引用 seam。
- [本地凭据](../credentials-local/README.zh.md) — 此插件写入的文件支持提供方。
- [llm-pi-ai](../../llm/llm-pi-ai/README.zh.md) — 按请求解析凭据的消费者。

<a id="model-experience"></a>
## 模型体验

### Request context and condition

#### What the model sees

无直接输出。此插件没有模型可见的输出；它保持提供方凭据（如 `NOUS_ACCESS_TOKEN`）有效，使模型请求能够通过认证。

#### Token effect

无直接令牌影响。此插件从不向请求添加文本。

#### KV Cache effect

无。此插件不修改请求前缀。

## 开发备注

监视器使用 auth 文件所在目录，以便原子重命名替换仍可被观察。测试覆盖从过期状态到当前状态的同步、幂等写入、格式错误的 auth 数据，以及监视器释放；测试不记录令牌值。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仅同步 Hermes 已写入的访问令牌；本身不运行 OAuth 刷新流程。
- 会话中途过期的令牌仍可能失败；下一次轮换或 Hermes 刷新可恢复。
- 仅读取 `providers` 中命名的提供方；其他凭据引用不受影响。
