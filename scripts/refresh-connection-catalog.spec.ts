/** The connection catalog refresh step. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Connection } from '@deepseek-ai/dsh-connection-store'
import {
  discoverForConnection,
  discoverOpenRouterModels,
  filterHealthyOpenRouterModels,
  isOpenRouterConnection,
  openRouterHealthCachePath,
  parseArgs,
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseArgs', () => {
  it('defaults to every connection, endpoint source, no write', () => {
    expect(parseArgs([])).toEqual({ dshHome: undefined, names: [], profiles: [], source: 'endpoint', dryRun: false, replace: false })
  })

  it('reads the home, names, and the source override', () => {
    expect(parseArgs(['--dsh-home', '/d', '--prefer-catalog', '--dry-run', 'nvidia', 'openrouter']))
      .toEqual({ dshHome: '/d', names: ['nvidia', 'openrouter'], profiles: [], source: 'catalog', dryRun: true, replace: false })
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
      .toEqual({ dshHome: undefined, names: ['nous'], profiles: ['web', 'nvidia'], source: 'endpoint', dryRun: false, replace: false })
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
})
