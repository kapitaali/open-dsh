---
description: "人类可读的 /reasoning 命令，用于显示或切换当前会话的推理力度。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-reasoning

[English](README.md) | 中文

## 概述

注册 `/reasoning`，用于显示或更改收到它的会话的推理力度。`/reasoning <level>` 通过 Agent 的模型选择为后续模型步骤记录该力度；`/reasoning show`（或不带参数）报告当前的 provider、模型与力度。该 level 是适配方拥有的力度 id，因此同一条命令可用于不同提供方；无法识别的 level 仍会被转发而不是在此猜测，因为只有持有目录的适配方才能校验它。

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

将插件与命令注册表一起挂载；base 组合已经这样做了。

```yaml
- name: '@deepseek-ai/dsh-command-reasoning'
```

然后在会话中：

```text
/reasoning show
/reasoning high
/reasoning off
```

`/reasoning show` 与不带参数的 `/reasoning` 相同。该命令不会到达模型：它针对接收方的 agent 执行，并把文本返回给 composer。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 命令处理器及其注册——本包的全部接口 |

### 行为

`executeReasoning(agent, rawInput)` 读取 `agent.model.current()`。不带输入或 `show` 时，它报告该选择。带 level 时，它重新选择相同的 provider 与模型并附加该力度，因此该更改对会话后续步骤是持久的，并作为 `model/selection` 事件记录在会话日志中。尚无路由的会话会被拒绝：没有可附加力度的对象。

可接受的拼写是每个适配方使用的并集（`off`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`、`ultra`）。该集合之外的 level 会在此被拒绝；其余的会被转发并留给适配方，因为适配方拥有按模型的力度表。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Commands](../commands/README.zh.md) —— 本命令加入的注册表。
- [Agent 模型选择](../../core/agent/README.zh.md) —— `agent.model.current()` / `select()` 与 `model/selection` 事件。
- [模型选择 UI](../../client/ui-model-selection/README.zh.md) —— composer 自带的力度选择器。

-----

<a id="model-experience"></a>
## 模型体验

### 人类 `/reasoning` 控制

#### 模型看到什么

命令本身不贡献任何模型输入；它针对接收方的 agent 处理。设置力度会改变本会话后续步骤中模型在回答前的思考量，这正是该开关的目的，而且该更改会作为 `model/selection` 事件记录在会话日志中。

#### Token 影响

命令不增加请求 token。更高的力度可能拉长后续响应中的推理部分；更低的力度会缩短它。

#### KV Cache 影响

推理力度改变的是响应，而不是请求前缀，因此它本身不会破坏提供方缓存复用；在对话中途更改力度仍可能改变输出长度。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **无按模型校验。** 命令检查一个通用拼写列表；所选模型是否广播该力度由适配方在请求时决定。
- **仅会话范围。** 该开关为接收会话记录。它不会更改未来会话的 profile 默认值——请改用 `dsh connection use` 或 Models 页面。
- **无显示开关。** 在转录中显示或隐藏推理是客户端设置；本命令更改的是力度，而不是渲染。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
