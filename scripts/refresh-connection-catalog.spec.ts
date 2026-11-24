/** The connection catalog refresh step. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  readConnections,
  resolveConnectionsPath,
  storeConnectionKey,
  writeConnections,
  type Connection,
} from '@deepseek-ai/dsh-connection-store'
import { mergeConnectionModels } from './sync-connection-models.mjs'
import {
  discoverForConnection,
  discoverOpenRouterModels,
  filterHealthyOpenRouterModels,
  isOpenRouterConnection,
  main,
  openRouterHealthCachePath,
  parseArgs,
  probeOpenRouterModels,
} from './refresh-connection-catalog.ts'

const openRouter: Connection = {
  name: 'openrouter',
  baseURL: 'https://openrouter.ai/api/v1',
  apiKeyEnv: 'OPENROUTER_API_KEY',
  route: 'pi-ai',
}

const NOW = Date.parse('2026-11-21T00:00:00Z')

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function catalogRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    pricing: { prompt: '1', completion: '2' },
    expiration_date: null,
    architecture: { output_modalities: ['text'] },
    endpoints: ['/api/v1/chat/completions'],
    supported_parameters: ['tools'],
    ...overrides,
  }
}

function reasoningRow(id: string, efforts: readonly string[], mandatory = false): Record<string, unknown> {
  return catalogRow(id, { reasoning: { mandatory, supported_efforts: [...efforts] } })
}

function providerPatch(provider: string, baseURL: string, models: readonly string[]): string {
  return [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    `      ${provider}:`,
    `        baseURL: ${baseURL}`,
    `        apiKeyEnv: ${provider.toUpperCase()}_API_KEY`,
    '        api: openai-completions',
    '        models:',
    ...models.map(id => `          - id: ${id}`),
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    `    provider: ${provider}`,
    `    model: ${models[0] ?? 'missing'}`,
    '',
  ].join('\n')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseArgs', () => {
  it('defaults to every connection, endpoint source, no write', () => {
    expect(parseArgs([])).toEqual({
      dshHome: undefined, names: [], profiles: [], source: 'endpoint', dryRun: false, replace: false, canary: false,
    })
  })

  it('reads the home, names, and the source override', () => {
    expect(parseArgs(['--dsh-home', '/d', '--prefer-catalog', '--dry-run', 'nvidia', 'openrouter']))
      .toEqual({
        dshHome: '/d', names: ['nvidia', 'openrouter'], profiles: [], source: 'catalog', dryRun: true, replace: false, canary: false,
      })
  })

  it('tolerates the pnpm `--` separator', () => {
    const parsed = parseArgs(['--', 'nvidia'])
    expect(typeof parsed === 'object' && parsed.names).toEqual(['nvidia'])
  })

  it('reports a missing value and an unknown flag', () => {
    expect(parseArgs(['--dsh-home'])).toBe('--dsh-home needs a path')
    expect(parseArgs(['--nope'])).toBe('unknown argument "--nope"')
  })

  it('reads repeatable profiles and the connection alias', () => {
    expect(parseArgs(['--profile', 'web', '--profile', 'nvidia', '--connection', 'nous']))
      .toEqual({
        dshHome: undefined, names: ['nous'], profiles: ['web', 'nvidia'], source: 'endpoint', dryRun: false, replace: false, canary: false,
      })
  })

  it('reads the replace flag for exact-catalog merges', () => {
    const parsed = parseArgs(['--profile', 'web', 'nous', '--replace', '--dry-run'])
    expect(typeof parsed === 'object' && parsed.replace).toBe(true)
    expect(typeof parsed === 'object' && parsed.dryRun).toBe(true)
  })

  it('reports missing profile and connection values', () => {
    expect(parseArgs(['--profile'])).toBe('--profile needs a name')
    expect(parseArgs(['--connection'])).toBe('--connection needs a name')
  })

  it('reads the canary flag', () => {
    expect(parseArgs(['--canary', '--replace', 'openrouter'])).toEqual({
      dshHome: undefined, names: ['openrouter'], profiles: [], source: 'endpoint',
      dryRun: false, replace: true, canary: true,
    })
  })
})

describe('discoverForConnection', () => {
  it('answers a catalog route from the installed registry, with no network call', async () => {
    const ids = await discoverForConnection(
      { name: 'nvidia', baseURL: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY', route: 'pi-ai' },
      'catalog',
      'sk-unused',
    )
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
  })
})

describe('refresh profile propagation', () => {
  it('inlines aliases already present in a profile patch', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-refresh-aliases-'))
    onTestFinished(() => {
      rmSync(home, { recursive: true, force: true })
    })
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const patchPath = join(profileDir, 'cordis.patch.yml')
    writeFileSync(patchPath, [
      '# keep this header',
      '- id: llm-pi-ai',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    expression: !!js "[\'keep\']"',
      '    providers:',
      '      opencode:',
      '        baseURL: https://opencode.example/v1',
      '        apiKeyEnv: OPENCODE_API_KEY',
      '        api: openai-completions',
      '        models:',
      '          - id: old-model',
      '      legacy:',
      '        baseURL: https://legacy.example/v1',
      '        apiKeyEnv: LEGACY_API_KEY',
      '        models:',
      '          - id: old-0',
      '            reasoningEfforts: &a1',
      '              off: null',
      '              low: low',
      ...Array.from({ length: 120 }, (_, index) => [
        `          - id: old-${String(index + 1)}`,
        '            reasoningEfforts: *a1',
      ]).flat(),
      '',
    ].join('\n'), 'utf8')

    const result = await mergeConnectionModels('web', {
      name: 'opencode',
      baseURL: 'https://opencode.example/v1',
      apiKeyEnv: 'OPENCODE_API_KEY',
      api: 'openai-completions',
      models: ['new-model'],
    }, home, false, true)

    expect(result.status).toBe('updated')
    const text = readFileSync(patchPath, 'utf8')
    expect(text).toContain('# keep this header')
    expect(text).toContain('!!js')
    expect(text).not.toMatch(/\*a[0-9]+/u)
    expect(text).not.toMatch(/&a[0-9]+/u)
    const rows = parseEntryYaml(text) as Array<{
      config: { expression: unknown; providers: Record<string, { models: Array<{ id: string }> }> }
    }>
    expect(rows[0]?.config.expression).toEqual({ __jsExpr: "['keep']" })
    expect(rows[0]?.config.providers.opencode?.models[0]?.id).toBe('new-model')
  })

  it('updates every profile already using the refreshed connection without --profile', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-refresh-profiles-'))
    onTestFinished(() => {
      rmSync(home, { recursive: true, force: true })
    })
    const connection: Connection = {
      name: 'opencode',
      baseURL: 'https://opencode.example/v1',
      apiKeyEnv: 'OPENCODE_API_KEY',
      route: 'pi-ai',
      model: 'old-model',
      models: ['old-model'],
    }
    await writeConnections(resolveConnectionsPath(home), { version: 1, connections: [connection] })
    await storeConnectionKey(connection.apiKeyEnv, 'sk-test', home)
    for (const profile of ['opencode', 'web']) {
      const dir = join(home, 'profiles', profile)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'cordis.patch.yml'), providerPatch('opencode', connection.baseURL, ['old-model']), 'utf8')
    }
    const unrelatedDir = join(home, 'profiles', 'unrelated')
    mkdirSync(unrelatedDir, { recursive: true })
    writeFileSync(join(unrelatedDir, 'cordis.patch.yml'), providerPatch('other', 'https://other.example/v1', ['other-model']), 'utf8')
    const differentEndpointDir = join(home, 'profiles', 'different-endpoint')
    mkdirSync(differentEndpointDir, { recursive: true })
    writeFileSync(
      join(differentEndpointDir, 'cordis.patch.yml'),
      providerPatch('opencode', 'https://other-opencode.example/v1', ['old-model']),
      'utf8',
    )
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ id: 'new-model' }, { id: 'second-model' }] })))
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    onTestFinished(() => {
      stdout.mockRestore()
    })

    expect(await main(['--dsh-home', home, 'opencode'])).toBe(0)

    const updated = await readConnections(resolveConnectionsPath(home))
    expect(updated.connections[0]?.models).toEqual(['new-model', 'second-model'])
    for (const profile of ['opencode', 'web']) {
      const patch = readFileSync(join(home, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
      expect(patch).toContain('id: new-model')
      expect(patch).toContain('id: second-model')
      expect(patch).toContain('model: old-model')
    }
    expect(readFileSync(join(unrelatedDir, 'cordis.patch.yml'), 'utf8')).not.toContain('new-model')
    expect(readFileSync(join(differentEndpointDir, 'cordis.patch.yml'), 'utf8')).not.toContain('new-model')
  })
})

describe('OpenRouter metadata discovery', () => {
  it('recognizes only OpenRouter hosts', () => {
    expect(isOpenRouterConnection(openRouter)).toBe(true)
    expect(isOpenRouterConnection({ ...openRouter, baseURL: 'https://gateway.example/v1' })).toBe(false)
  })

  it('prefers /models/user and sends only a scoped Bearer header', async () => {
    const urls: string[] = []
    const authorizations: (string | null)[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      urls.push(String(input))
      authorizations.push(new Headers(init?.headers).get('authorization'))
      return jsonResponse({ data: [catalogRow('vendor/good')], total_count: 1 })
    }
    const result = await discoverOpenRouterModels(openRouter, 'sk-test', fetchImpl, NOW)
    expect(result.ids).toEqual(['vendor/good'])
    expect(urls[0]).toContain('/models/user?')
    expect(urls[0]).toContain('supported_parameters=tools')
    expect(urls[0]).toContain('endpoints=%2Fapi%2Fv1%2Fchat%2Fcompletions')
    expect(authorizations).toEqual(['Bearer sk-test'])
  })

  it('falls back to the public catalog when the key is rejected', async () => {
    const urls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input))
      return urls.length === 1
        ? jsonResponse({ error: { message: 'unauthorized' } }, 401)
        : jsonResponse({ data: [catalogRow('vendor/good')], total_count: 1 })
    }
    const result = await discoverOpenRouterModels(openRouter, 'sk-stale', fetchImpl, NOW)
    expect(result.ids).toEqual(['vendor/good'])
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/models/user?')
    expect(urls[1]).toContain('/models?')
  })

  it('maps OpenRouter reasoning efforts to DSH levels', async () => {
    const rows = [
      reasoningRow('vendor/none', []),
      reasoningRow('vendor/medium', ['none', 'low', 'medium', 'high', 'max']),
      reasoningRow('vendor/minimal', ['minimal', 'xhigh']),
      reasoningRow('vendor/mandatory', ['high'], true),
      catalogRow('vendor/no-reasoning'),
    ]
    const fetchImpl: typeof fetch = async () => jsonResponse({ data: rows, total_count: rows.length })
    const result = await discoverOpenRouterModels(openRouter, undefined, fetchImpl, NOW)
    expect(result.reasoning).toEqual({
      'vendor/none': false,
      'vendor/medium': { off: null, low: 'low', high: 'high', max: 'max' },
      'vendor/minimal': { off: null, low: 'low', high: 'high' },
      'vendor/mandatory': { off: null, high: 'high' },
      'vendor/no-reasoning': false,
    })
  })

  it('drops batch, dynamic, expired, wrong-endpoint, no-tools and non-text rows', async () => {
    const rows = [
      catalogRow('vendor/good'),
      catalogRow('vendor/batch:batch'),
      catalogRow('vendor/dynamic', { pricing: { prompt: '-1', completion: '-1' } }),
      catalogRow('vendor/expired', { expiration_date: '2020-01-01T00:00:00Z' }),
      catalogRow('vendor/wrong', { endpoints: ['/api/v1/messages'] }),
      catalogRow('vendor/no-tools', { supported_parameters: [] }),
      catalogRow('vendor/image', { architecture: { output_modalities: ['image'] } }),
    ]
    const fetchImpl: typeof fetch = async () => jsonResponse({ data: rows, total_count: rows.length })
    const result = await discoverOpenRouterModels(openRouter, undefined, fetchImpl, NOW)
    expect(result.ids).toEqual(['vendor/good'])
    expect(result.report.total).toBe(7)
    expect(result.report.kept).toBe(1)
    expect(result.report.dropped).toEqual({
      batch: 1,
      'dynamic-router': 1,
      expired: 1,
      'no-tools': 1,
      'non-text-output': 1,
      'wrong-endpoint': 1,
    })
  })
})

describe('OpenRouter health cache', () => {
  it('reuses fresh decisions and checks only stale ids', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-or-health-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, 'model-health'), { recursive: true })
    writeFileSync(openRouterHealthCachePath(home), JSON.stringify({
      version: 1,
      models: {
        'vendor/bad': { checkedAt: NOW, eligible: false, reason: 'no-healthy-endpoint' },
        'vendor/good': { checkedAt: NOW, eligible: true },
      },
    }), 'utf8')
    let requests = 0
    const fetchImpl: typeof fetch = async () => {
      requests++
      return jsonResponse({
        data: { endpoints: [{ status: 0, supported_parameters: ['tools'], supports_tool_choice: { auto: true }, uptime_last_1d: 99.9 }] },
      })
    }
    const result = await filterHealthyOpenRouterModels(
      ['vendor/bad', 'vendor/good', 'vendor/fresh'], openRouter, undefined, home, false, fetchImpl, NOW,
    )
    expect(result.ids).toEqual(['vendor/good', 'vendor/fresh'])
    expect(result.report).toEqual({ kept: 2, dropped: 1, unknown: 0, cacheHits: 2, requests: 1 })
    expect(requests).toBe(1)
  })

  it('keeps a model with unknown health when endpoint listing fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-or-health-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: { message: 'temporary' } }, 503)
    const result = await filterHealthyOpenRouterModels(
      ['vendor/flaky'], openRouter, undefined, home, false, fetchImpl, NOW,
    )
    expect(result.ids).toEqual(['vendor/flaky'])
    expect(result.report.unknown).toBe(1)
    expect(result.report.dropped).toBe(0)
  })

  it('does not write the cache on a dry run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-or-health-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    const fetchImpl: typeof fetch = async () => jsonResponse({
      data: { endpoints: [{ status: 0, supported_parameters: ['tools'], uptime_last_1d: 100 }] },
    })
    const result = await filterHealthyOpenRouterModels(
      ['vendor/good'], openRouter, undefined, home, true, fetchImpl, NOW,
    )
    expect(result.ids).toEqual(['vendor/good'])
    expect(() => readFileSync(openRouterHealthCachePath(home))).toThrow()
  })

  it('writes per-model reasoning profiles through the sync merge', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-or-sync-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    mkdirSync(join(home, 'model-health'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
      '- id: llm-pi-ai',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      openrouter:',
      '        baseURL: https://openrouter.ai/api/v1',
      '        apiKeyEnv: OPENROUTER_API_KEY',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(openRouterHealthCachePath(home), JSON.stringify({
      version: 2,
      models: {
        'vendor/plain': { checkedAt: NOW, eligible: true, reasoning: false },
        'vendor/reasons': { checkedAt: NOW, eligible: true, reasoning: { off: null, high: 'high' } },
      },
    }), 'utf8')
    const result = await mergeConnectionModels(
      'web',
      { ...openRouter, models: ['vendor/plain', 'vendor/reasons'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
      home,
      false,
      true,
    )
    expect(result.status).toBe('updated')
    const patch = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('reasoningEfforts: false')
    expect(patch).toContain('high: high')
    expect(patch).not.toContain('low: low')
  })

  it('migrates version 1 cache entries to non-reasoning profiles', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-or-health-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, 'model-health'), { recursive: true })
    writeFileSync(openRouterHealthCachePath(home), JSON.stringify({
      version: 1,
      models: { 'vendor/old': { checkedAt: NOW, eligible: true } },
    }), 'utf8')
    const result = await filterHealthyOpenRouterModels(
      ['vendor/old'], openRouter, undefined, home, false, globalThis.fetch, NOW,
      { 'vendor/old': false },
    )
    expect(result.ids).toEqual(['vendor/old'])
    interface CachedReasoning { version: number; models: Record<string, { reasoning: unknown }> }
    const cache = JSON.parse(readFileSync(openRouterHealthCachePath(home), 'utf8')) as CachedReasoning
    expect(cache.version).toBe(2)
    expect(cache.models['vendor/old']?.reasoning).toBe(false)
  })
})

describe('OpenRouter canary', () => {
  it('sends reasoning.effort for a mandatory-reasoning model', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-or-canary-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    mkdirSync(join(home, 'model-health'), { recursive: true })
    writeFileSync(openRouterHealthCachePath(home), JSON.stringify({
      version: 2,
      models: { 'vendor/mandatory': { checkedAt: NOW, eligible: true, reasoning: { high: 'high' } } },
    }), 'utf8')
    let body: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({ id: 'chatcmpl-1', choices: [] })
    }
    await probeOpenRouterModels(['vendor/mandatory'], openRouter, 'sk-test', home, false, fetchImpl, NOW)
    expect(body.reasoning).toEqual({ effort: 'high' })
  })

  it('removes a model on a deterministic 400/404 failure', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-or-canary-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: { message: 'model not found' } }, 404)
    const result = await probeOpenRouterModels(
      ['vendor/bad'], openRouter, 'sk-test', home, false, fetchImpl, NOW,
    )
    expect(result.ids).toEqual([])
    expect(result.report).toEqual({ ok: 0, failed: 1, unknown: 0, aborted: false })
    const cache = JSON.parse(readFileSync(openRouterHealthCachePath(home), 'utf8')) as {
      models: Record<string, { runtime?: { status: string; reason?: string } }>
    }
    expect(cache.models['vendor/bad']?.runtime?.status).toBe('failed')
    expect(cache.models['vendor/bad']?.runtime?.reason).toBe('model not found')
  })

  it('keeps models on 429 and 5xx as unknown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-or-canary-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls++
      return jsonResponse({ error: { message: 'slow down' } }, calls === 1 ? 429 : 503)
    }
    const result = await probeOpenRouterModels(
      ['vendor/a', 'vendor/b'], openRouter, 'sk-test', home, false, fetchImpl, NOW,
    )
    expect(result.ids).toEqual(['vendor/a', 'vendor/b'])
    expect(result.report.unknown).toBe(2)
    expect(result.report.failed).toBe(0)
  })

  it('aborts remaining probes on account-level billing failure', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-or-canary-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    const ids = Array.from({ length: 8 }, (_, index) => `vendor/model-${index}`)
    let calls = 0
    const fetchImpl: typeof fetch = async () => {
      calls++
      return jsonResponse({ error: { message: 'no credit' } }, 402)
    }
    const result = await probeOpenRouterModels(ids, openRouter, 'sk-test', home, false, fetchImpl, NOW)
    expect(result.report.aborted).toBe(true)
    expect(result.report.failed).toBe(0)
    expect(result.ids).toHaveLength(8)
    // Four workers may already be in flight; the remaining four must not start.
    expect(calls).toBeLessThanOrEqual(4)
    expect(calls).toBeLessThan(ids.length)
  })

  it('sends tools, Bearer auth and the model id on a successful probe', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-or-canary-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    let url = ''
    let headers = new Headers()
    let body: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (input, init) => {
      url = String(input)
      headers = new Headers(init?.headers)
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({ id: 'chatcmpl-1', choices: [] })
    }
    const result = await probeOpenRouterModels(
      ['vendor/good'], openRouter, 'sk-test', home, false, fetchImpl, NOW,
    )
    expect(result.ids).toEqual(['vendor/good'])
    expect(result.report.ok).toBe(1)
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(headers.get('authorization')).toBe('Bearer sk-test')
    expect(body.model).toBe('vendor/good')
    expect(body.tools).toBeDefined()
    expect(body.tool_choice).toBe('auto')
  })

  it('does not write the cache on a dry run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-or-canary-'))
    onTestFinished(() => rmSync(home, { recursive: true, force: true }))
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: { message: 'bad' } }, 404)
    const result = await probeOpenRouterModels(
      ['vendor/bad'], openRouter, 'sk-test', home, true, fetchImpl, NOW,
    )
    expect(result.ids).toEqual([])
    expect(() => readFileSync(openRouterHealthCachePath(home))).toThrow()
  })
})
