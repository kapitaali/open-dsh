/** The Hermes credential import setup step. */
import { describe, expect, it } from 'vitest'
import { connectionForKey, expandHome, parseArgs, parseAuthProviders, parseEnvFile } from './import-hermes-credentials.ts'

describe('parseEnvFile', () => {
  it('reads assignments in file order and drops comments and blanks', () => {
    const entries = parseEnvFile([
      '# a comment',
      '',
      'FIRST=one',
      '  SECOND = two  ',
      'NOT_AN_ASSIGNMENT',
      '=no-key',
      'EMPTY=',
      "QUOTED='secret'",
      'DOUBLE="secret"',
    ].join('\n'))
    expect(entries.map(entry => entry.key)).toEqual(['FIRST', 'SECOND', 'QUOTED', 'DOUBLE'])
    expect(entries[1]?.value).toBe('two')
    expect(entries[2]?.value).toBe('secret')
    expect(entries[3]?.value).toBe('secret')
  })
})

describe('expandHome', () => {
  it('expands ~ and ~/ prefixes', () => {
    const home = expandHome('~')
    expect(expandHome('~/.hermes')).toBe(`${home}/.hermes`)
  })

  it('keeps absolute paths and resolves relative ones', () => {
    const absolute = expandHome('/tmp/x')
    expect(absolute).toBe('/tmp/x')
    expect(expandHome('rel')).toMatch(/\/rel$/)
  })
})

describe('parseArgs', () => {
  it('reads the home flags and the toggles', () => {
    expect(parseArgs(['--hermes-home', '/h', '--dsh-home', '/d', '--all', '--dry-run', '--model', 'm/1']))
      .toEqual({
        hermesHome: '/h', dshHome: '/d', all: true, dryRun: true,
        keysOnly: false, model: 'm/1', api: undefined,
      })
  })

  it('tolerates the pnpm `--` separator and defaults', () => {
    expect(parseArgs(['--', '--keys-only'])).toEqual({
      hermesHome: undefined, dshHome: undefined, all: false, dryRun: false,
      keysOnly: true, model: undefined, api: undefined,
    })
    expect(parseArgs([])).toEqual({
      hermesHome: undefined, dshHome: undefined, all: false, dryRun: false,
      keysOnly: false, model: undefined, api: undefined,
    })
  })

  it('reports a missing flag value and an unknown flag', () => {
    expect(parseArgs(['--hermes-home'])).toBe('--hermes-home needs a value')
    expect(parseArgs(['--nope'])).toBe('unknown argument "--nope"')
  })
})

describe('parseAuthProviders', () => {
  it('reads each provider endpoint and access token', () => {
    const providers = parseAuthProviders(JSON.stringify({
      version: 1,
      providers: {
        nous: {
          access_token: 'tok',
          inference_base_url: 'https://inference-api.nousresearch.com/v1',
        },
      },
    }))
    expect(providers).toEqual([
      { name: 'nous', baseURL: 'https://inference-api.nousresearch.com/v1', ref: 'NOUS_ACCESS_TOKEN', token: 'tok' },
    ])
  })

  it('skips providers without an endpoint or token, and non-JSON', () => {
    expect(parseAuthProviders(JSON.stringify({ providers: { incomplete: { access_token: 't' } } }))).toEqual([])
    expect(parseAuthProviders('not json')).toBeUndefined()
  })
})

describe('connectionForKey', () => {
  it('maps a provider key to its catalog endpoint', () => {
    expect(connectionForKey('OPENROUTER_API_KEY')).toEqual({
      name: 'openrouter',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      route: 'pi-ai',
    })
  })

  it('uses the deepseek route for the deepseek key', () => {
    expect(connectionForKey('DEEPSEEK_API_KEY')?.route).toBe('deepseek')
    expect(connectionForKey('DEEPSEEK_API_KEY')?.baseURL).toBe('https://api.deepseek.com')
  })

  it('applies an optional model and protocol', () => {
    expect(connectionForKey('NVIDIA_API_KEY', 'm/1', 'openai-responses')).toEqual({
      name: 'nvidia',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      apiKeyEnv: 'NVIDIA_API_KEY',
      route: 'pi-ai',
      model: 'm/1',
      api: 'openai-responses',
    })
  })

  it('returns undefined for a key no provider owns', () => {
    expect(connectionForKey('SOMETHING_ELSE')).toBeUndefined()
  })
})
