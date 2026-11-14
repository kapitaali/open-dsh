/**
 * Human-facing `/reasoning` command over the Agent model selection.
 *
 * `/reasoning <level>` records a reasoning-effort change for the receiving
 * Session's next steps; `/reasoning show` (or no argument) reports the current
 * choice. The level is the adapter-owned effort id, so the same command works
 * across providers; an empty argument never clears a recorded effort.
 *
 * @module @deepseek-ai/dsh-command-reasoning
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/types'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export const name = 'command-reasoning'
export const inject = ['commands']

const USAGE = 'Usage: /reasoning <level> | /reasoning show'

/**
 * Levels accepted regardless of the selected model. Adapters own the exact
 * spelling per model, so an unrecognised level is still forwarded: refusing it
 * here would second-guess the adapter that has the catalog.
 */
const GENERIC_LEVELS: readonly string[] = [
  'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]

/**
 * Execute one `/reasoning` invocation.
 * @param agent - the agent whose UI received the command.
 * @param rawInput - exact text after the command name.
 * @returns the outcome the dispatching composer renders.
 */
export function executeReasoning(agent: Agent, rawInput: string): CommandResult {
  const input = rawInput.trim()
  const current = agent.model.current()
  if (input.length === 0 || input.toLowerCase() === 'show') {
    if (current === undefined) return { kind: 'success', text: 'No model selected yet.' }
    const effort = current.reasoningEffort === undefined ? 'adapter default' : String(current.reasoningEffort)
    return { kind: 'success', text: `Model ${current.model} on ${current.provider}, reasoning effort ${effort}.` }
  }
  const tokens = input.split(/\s+/)
  const level = (tokens[0] ?? input).toLowerCase()
  if (!isReasoningEffort(level)) {
    return { kind: 'error', text: `${USAGE}\nUnknown level ${JSON.stringify(level)}.` }
  }
  if (current === undefined) {
    return { kind: 'error', text: 'Select a model first; there is no session route to attach an effort to.' }
  }
  agent.model.select({ provider: current.provider, model: current.model, reasoningEffort: level })
  return { kind: 'success', text: `Reasoning effort set to ${level} for ${current.provider}/${current.model}.` }
}

/** Whether a level is one this build recognises. */
function isReasoningEffort(value: string): value is ReasoningEffortId {
  return GENERIC_LEVELS.includes(value)
}

/**
 * Register `/reasoning` for every composed human-command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(function* () {
    yield ctx.commands.register({
      definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-command-reasoning'),
      name: 'reasoning',
      description: 'Show or set the reasoning effort for this session',
      handler: (invocation: CommandInvocation) => executeReasoning(invocation.agent, invocation.rawInput),
    })
  }, 'command-reasoning lifecycle')
}
