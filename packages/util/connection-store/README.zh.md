---
description: "DeepSeek Harness 的命名连接配置：一个 API 端点加一个凭据引用，保存在 Harness 主目录中。"
kind: "package-reference"
---

# @deepseek-ai/dsh-connection-store

[English](README.md) | 中文

## 概述

使用 `dsh-connection-store` 读取和写入命名连接配置：一个 `baseURL` 端点，加上对它进行鉴权的凭据引用。连接是 `dsh connection` 命令创建的单位；配置文件通过在自己的补丁层中写入 `llm-deepseek` 行的 config 来应用连接。该文档位于 `$DSH_HOME/connections.yaml`，不保存任何密钥值，由 CLI 和嵌入方读取——绝不由 Harness 运行时本身读取。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

最小路径是一次读取加一次写入：

```ts
import { readConnections, resolveConnectionsPath, writeConnections } from '@deepseek-ai/dsh-connection-store'

const path = resolveConnectionsPath()
const document = await readConnections(path)
await writeConnections(path, {
  version: document.version,
  connections: [...document.connections, { name: 'acme', baseURL: 'https://gateway.acme.example', apiKeyEnv: 'ACME_API_KEY' }],
})
```

`resolveConnectionsPath()` 遵循 `$DSH_HOME`；测试中传入显式主目录。文档缺失时读取为空存储。`writeConnections` 持有跨进程写锁，并以仅属主权限原子替换文件。

### 存储密钥

连接文档命名一个凭据引用；密钥值保存在凭据存储中。`storeConnectionKey(ref, value)` 与 `removeConnectionKey(ref)` 以凭据提供方相同的保留注释、加锁、原子写入方式编辑该存储的 `refs` 段，因此连接的密钥随连接一起存储和移除：

```ts
import { storeConnectionKey } from '@deepseek-ai/dsh-connection-store'

declare const ref: string
declare const value: string
await storeConnectionKey(ref, value)
```

### 连接字段

| 字段 | 语法 | 含义 |
|---|---|---|
| `name` | `^[a-z][a-z0-9-]*$` | 用户输入的句柄；在文档中唯一 |
| `baseURL` | HTTP(S) URL，无凭据/查询/片段 | 端点根 |
| `apiKeyEnv` | POSIX 环境变量名 | 由凭据接缝按请求解析的凭据引用 |
| `route` | `deepseek` 或 `pi-ai` | 配置文件在哪里应用它；默认 `deepseek` |
| `model` | 非空字符串 | `pi-ai` 路由模型 id；`route` 为 `pi-ai` 时必填 |
| `api` | pi-ai 协议 id | `pi-ai` 线路协议；默认 `openai-completions` |
| `contextWindow` | 正整数 | `pi-ai` 路由上下文窗口 |

API 密钥值绝不出现在本文档中。它保存在凭据存储的 `apiKeyEnv` 下，因此轮换密钥不会触及连接。

### 路由

`deepseek` 连接通过写入 `llm-deepseek` 行的 config 来应用，该行使用 Anthropic Messages 线路（DeepSeek 官方 API 与兼容 Messages 的网关）。`pi-ai` 连接通过把一个 provider 路由合并进 `llm-pi-ai` 行、并将 `agent-default-model` 指向它来应用，可到达 OpenAI 兼容与其他线路。应用侧位于 `dsh connection` 命令中；本包只保存字段。

### 需要规划的失败

解析是严格的。文档格式错误、版本未知、名称重复或字段超出语法时抛出错误而非跳过，因为被静默丢弃的连接会读作“我保存的连接没有效果”。无法解析将要修改的文件的活跃写入方必须失败，而不是覆盖它无法读取的内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 文档类型、解析器、序列化器、读取器与写入器——本包的全部接口 |

### 文档布局

```yaml
version: 1
connections:
  - name: acme
    baseURL: https://gateway.acme.example
    apiKeyEnv: ACME_API_KEY
```

`version` 依据 `CONNECTIONS_DOCUMENT_VERSION` 校验。空文件或没有 `connections` 的映射为空存储。未知的顶层键被拒绝而非忽略，与凭据存储的响亮解析规则一致。

### 写入路径

`writeConnections` 在调用方执行的整个读-修改-写入期间持有 `withFileLock`，然后 `writeFileAtomic` 替换文件。序列化后的文档带有两行头部注释，说明管理方以及密钥存放在别处这一事实。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [凭据子系统](../../../docs/subsystems/credentials.zh.md)——解析 `apiKeyEnv` 的凭据接缝。
- [凭据存储](../../credentials/credentials-local/README.zh.md)——保存密钥值的文件。
- [配置编辑器](../../boot/config-editor/README.zh.md)——应用连接所经的配置文件写入器。
- [util 组映射](../README.zh.md)——本包所属的工具家族。

-----

<a id="model-experience"></a>
## 模型体验

无：本包是纯文件型存储，不注册任何面向模型的内容。

#### KV Cache 影响

此处没有任何内容进入请求前缀，因此提供方缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时不是合适的工具。它们是当前包约束，不是任务积压。

- **不保留注释**——文档由机器管理；写入替换整个文件，因此用户写在里面的注释不会保留。
- **无运行时读取方**——Harness 运行时读取的不是本文档。配置文件通过把连接的值复制到配置文件补丁来应用连接；运行时解析生成的 `llm-deepseek` config，而非此文件。
- **单一主机与单一 PID 命名空间**——写锁是 atomic-write 锁，因此在多台主机共享网络文件系统时，写入方可能不安全地竞争，与构建于其上的每个存储一样。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
