import { describe, expect, it } from 'vitest'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { executeReasoning } from '../src/index.ts'

/** Minimal Agent double: only the model controller the command touches. */
function agentWith(selection: ModelSelection | undefined, onSelect?: (s: ModelSelection) => void): Agent {
  return {
    model: {
      current: () => selection,
      select: (next: ModelSelection) => onSelect?.(next),
    },
  } as unknown as Agent
}

const ROUTE = { provider: 'nous', model: 'openai/gpt-6-luna' }

describe('executeReasoning', () => {
  it('reports the current route and effort', () => {
    const result = executeReasoning(agentWith({ ...ROUTE, reasoningEffort: brandString<ReasoningEffortId>('high') }), 'show')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('openai/gpt-6-luna')
    expect(result.text).toContain('high')
  })

  it('reports an unset effort as the adapter default', () => {
    const result = executeReasoning(agentWith({ ...ROUTE }), '')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('adapter default')
  })

  it('records the effort for the next steps, keeping the route', () => {
    let selected: ModelSelection | undefined
    const result = executeReasoning(agentWith({ ...ROUTE }, (s) => { selected = s }), 'low')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('effort set to low')
    expect(selected).toEqual({ ...ROUTE, reasoningEffort: 'low' })
  })

  it('rejects an unknown level without touching the selection', () => {
    let selected: ModelSelection | undefined
    const result = executeReasoning(agentWith({ ...ROUTE }, (s) => { selected = s }), 'ludicrous')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Unknown level')
    expect(selected).toBeUndefined()
  })

  it('refuses when no route is selected yet', () => {
    const result = executeReasoning(agentWith(undefined), 'high')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('Select a model first')
  })
})
