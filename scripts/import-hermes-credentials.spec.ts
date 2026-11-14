/** The Hermes credential import setup step. */
import { describe, expect, it } from 'vitest'
import { expandHome, parseArgs, parseEnvFile } from './import-hermes-credentials.ts'

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
    expect(parseArgs(['--hermes-home', '/h', '--dsh-home', '/d', '--all', '--dry-run']))
      .toEqual({ hermesHome: '/h', dshHome: '/d', all: true, dryRun: true })
  })

  it('tolerates the pnpm `--` separator and defaults', () => {
    expect(parseArgs(['--', '--dry-run'])).toEqual({ hermesHome: undefined, dshHome: undefined, all: false, dryRun: true })
    expect(parseArgs([])).toEqual({ hermesHome: undefined, dshHome: undefined, all: false, dryRun: false })
  })

  it('reports a missing flag value and an unknown flag', () => {
    expect(parseArgs(['--hermes-home'])).toBe('--hermes-home needs a path')
    expect(parseArgs(['--nope'])).toBe('unknown argument "--nope"')
  })
})
