---
description: "Human-facing /reasoning command to show or switch the session's reasoning effort."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-reasoning

English | [中文](README.zh.md)

## Summary

Register `/reasoning` to show or change the reasoning effort of the session that received it. `/reasoning <level>` records the effort for the next model steps through the Agent model selection; `/reasoning show` (or no argument) reports the current provider, model, and effort. The level is the adapter-owned effort id, so one command works across providers; an unrecognised level is still forwarded rather than guessed at, because only the adapter holding the catalog can validate it.

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

Mount the plugin alongside the command registry; the base composition already does.

```yaml
- name: '@deepseek-ai/dsh-command-reasoning'
```

Then, in a session:

```text
/reasoning show
/reasoning high
/reasoning off
```

`/reasoning show` and a bare `/reasoning` are the same. The command never reaches the model: it is executed against the receiving agent and returns its text to the composer.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The command handler and its registration — the package's whole surface |

### Behaviour

`executeReasoning(agent, rawInput)` reads `agent.model.current()`. With no input, or `show`, it reports that selection. With a level it re-selects the same provider and model and adds the effort, so the change is durable for the session's later steps and is recorded in the session log as a `model/selection` event. A session with no route yet is refused: there is nothing to attach an effort to.

The accepted spellings are the union every adapter uses (`off`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`). A level outside that set is refused here; anything else is forwarded and left for the adapter, which owns the per-model effort table.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Commands](../commands/README.md) — the registry this command joins.
- [Agent model selection](../../core/agent/README.md) — `agent.model.current()` / `select()` and the `model/selection` event.
- [Model selection UI](../../client/ui-model-selection/README.md) — the composer's own effort picker.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/reasoning` control

#### What the model sees

The command itself contributes no model input; it is handled against the receiving agent. Setting an effort changes how much the model thinks before answering on the following steps of this session, which is the point of the switch, and the change is recorded in the session log as a `model/selection` event.

#### Token effect

The command adds no request tokens. A higher effort can lengthen the reasoning portion of later responses; a lower effort shortens it.

#### KV Cache effect

Reasoning effort changes the response, not the request prefix, so it does not by itself break provider cache reuse; changing effort mid-conversation can still change output length.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No per-model validation.** The command checks a generic spelling list; whether the selected model advertises that effort is decided by the adapter at request time.
- **Session scope only.** The switch is recorded for the receiving session. It does not change the profile default for future sessions — use `dsh connection use`, or the Models page, for that.
- **No display toggle.** Showing or hiding reasoning in the transcript is a client setting; this command changes the effort, not the rendering.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
