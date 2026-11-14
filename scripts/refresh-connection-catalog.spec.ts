/** The connection catalog refresh step. */
import { describe, expect, it } from 'vitest'
import { discoverForConnection, parseArgs } from './refresh-connection-catalog.ts'

describe('parseArgs', () => {
  it('defaults to every connection, endpoint source, no write', () => {
    expect(parseArgs([])).toEqual({ dshHome: undefined, names: [], source: 'endpoint', dryRun: false })
  })

  it('reads the home, names, and the source override', () => {
    expect(parseArgs(['--dsh-home', '/d', '--prefer-catalog', '--dry-run', 'nvidia', 'openrouter']))
      .toEqual({ dshHome: '/d', names: ['nvidia', 'openrouter'], source: 'catalog', dryRun: true })
  })

  it('tolerates the pnpm `--` separator', () => {
    const parsed = parseArgs(['--', 'nvidia'])
    expect(typeof parsed === 'object' && parsed.names).toEqual(['nvidia'])
  })

  it('reports a missing value and an unknown flag', () => {
    expect(parseArgs(['--dsh-home'])).toBe('--dsh-home needs a path')
    expect(parseArgs(['--nope'])).toBe('unknown argument "--nope"')
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
