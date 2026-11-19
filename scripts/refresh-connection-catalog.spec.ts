/** The connection catalog refresh step. */
import { describe, expect, it } from 'vitest'
import { discoverForConnection, parseArgs } from './refresh-connection-catalog.ts'

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
