/** `dsh connection`: named connection profiles, their keys, and the profile patch. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import { runConnection } from '../src/connection.ts'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'cli-connection-'))
  vi.stubEnv('DSH_HOME', home)
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  onTestFinished(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })
  return { home, stdout, stderr }
}

function output(spy: MockInstance): string {
  return spy.mock.calls.map(call => String(call[0])).join('')
}

it('adds a connection, stores its key, and lists it', async () => {
  const { home, stdout } = fixture()
  expect(await runConnection(['add', 'acme', '--url', 'https://gateway.acme.example', '--key', 'sk-test'])).toBe(0)
  expect(output(stdout)).toContain('saved connection "acme"')

  const connections = readFileSync(join(home, 'connections.yaml'), 'utf8')
  expect(connections).toContain('name: acme')
  expect(connections).toContain('baseURL: https://gateway.acme.example')
  expect(connections).toContain('apiKeyEnv: ACME_API_KEY')

  const credentials = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  expect(credentials).toContain('ACME_API_KEY')
  expect(credentials).toContain('sk-test')

  stdout.mockClear()
  expect(await runConnection(['list'])).toBe(0)
  expect(output(stdout)).toContain('acme')
  expect(output(stdout)).toContain('https://gateway.acme.example')
})

it('applies a connection to a profile patch', async () => {
  const { home, stdout } = fixture()
  expect(await runConnection(['add', 'acme', '--url', 'https://gateway.acme.example', '--key', 'sk-test'])).toBe(0)
  stdout.mockClear()

  expect(await runConnection(['use', 'tui', 'acme'])).toBe(0)
  expect(existsSync(join(home, 'profiles', 'tui', 'package.json'))).toBe(true)
  const patch = readFileSync(join(home, 'profiles', 'tui', 'cordis.patch.yml'), 'utf8')
  expect(patch).toContain('id: llm-deepseek')
  expect(patch).toContain('baseURL: https://gateway.acme.example')
  expect(patch).toContain('apiKeyEnv: ACME_API_KEY')
})

it('preserves comments and other rows when applying a connection', async () => {
  const { home } = fixture()
  const dir = join(home, 'profiles', 'tui')
  rmSync(dir, { recursive: true, force: true })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), '# my patch\n- id: other\n  name: other-plugin\n  config:\n    a: 1\n', { mode: 0o600 })

  expect(await runConnection(['add', 'acme', '--url', 'https://gateway.acme.example', '--key', 'sk-test'])).toBe(0)
  expect(await runConnection(['use', 'tui', 'acme'])).toBe(0)
  const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  expect(patch).toContain('# my patch')
  expect(patch).toContain('id: other')
  expect(patch).toContain('id: llm-deepseek')
})

it('applies a pi-ai connection as a route plus the default model', async () => {
  const { home } = fixture()
  expect(await runConnection([
    'add', 'nous', '--url', 'https://inference.example/v1', '--key', 'sk-test',
    '--route', 'pi-ai', '--model', 'm/1', '--context-window', '200000',
  ])).toBe(0)

  expect(await runConnection(['use', 'tui', 'nous'])).toBe(0)
  const patch = readFileSync(join(home, 'profiles', 'tui', 'cordis.patch.yml'), 'utf8')
  expect(patch).toContain('id: llm-pi-ai')
  expect(patch).toContain('providers:')
  expect(patch).toContain('apiKeyEnv: NOUS_API_KEY')
  expect(patch).toContain('baseURL: https://inference.example/v1')
  expect(patch).toContain('contextWindow: 200000')
  expect(patch).toContain('id: agent-default-model')
  expect(patch).toContain('provider: nous')
  expect(patch).toContain('model: m/1')
})

it('keeps an existing pi-ai provider when applying another connection', async () => {
  const { home } = fixture()
  const dir = join(home, 'profiles', 'tui')
  rmSync(dir, { recursive: true, force: true })
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- id: llm-pi-ai',
    '  name: \'@deepseek-ai/dsh-llm-pi-ai\'',
    '  config:',
    '    providers:',
    '      keepme:',
    '        apiKeyEnv: KEEPME_API_KEY',
    '        baseURL: https://keep.example/v1',
    '',
  ].join('\n'), { mode: 0o600 })

  expect(await runConnection(['add', 'nous', '--url', 'https://inference.example/v1', '--key', 'sk-test', '--route', 'pi-ai', '--model', 'm/1'])).toBe(0)
  expect(await runConnection(['use', 'tui', 'nous'])).toBe(0)
  const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  expect(patch).toContain('keepme:')
  expect(patch).toContain('nous:')
})

it('creates the profile from a shipped template when applying a connection', async () => {
  const { home } = fixture()
  expect(await runConnection(['add', 'acme', '--url', 'https://gateway.acme.example', '--key', 'sk-test'])).toBe(0)
  expect(await runConnection(['use', 'web-profile', 'acme', '--from-default-profile', 'web'])).toBe(0)
  const manifest = JSON.parse(readFileSync(join(home, 'profiles', 'web-profile', 'package.json'), 'utf8')) as {
    dsh: { profile: { bundles: string[] } }
  }
  expect(manifest.dsh.profile.bundles).toContain('@deepseek-ai/dsh-web-app')
})

it('rejects an unknown template when applying a connection', async () => {
  const { stderr } = fixture()
  expect(await runConnection(['add', 'acme', '--url', 'https://x.example', '--key', 'sk-test'])).toBe(0)
  expect(await runConnection(['use', 'wp', 'acme', '--from-default-profile', 'nope'])).toBe(1)
  expect(output(stderr)).toContain('unknown default profile')
})

it('applies a pi-ai connection without a model, deferring to the catalog', async () => {
  const { home } = fixture()
  expect(await runConnection(['add', 'nous', '--url', 'https://inference.example/v1', '--key', 'sk-test', '--route', 'pi-ai'])).toBe(0)

  expect(await runConnection(['use', 'tui', 'nous'])).toBe(0)
  const patch = readFileSync(join(home, 'profiles', 'tui', 'cordis.patch.yml'), 'utf8')
  expect(patch).toContain('id: llm-pi-ai')
  expect(patch).toContain('apiKeyEnv: NOUS_API_KEY')
  expect(patch).not.toContain('id: agent-default-model')
})

it('rejects an unknown route', async () => {
  const { stderr } = fixture()
  expect(await runConnection(['add', 'nous', '--url', 'https://x.example', '--key', 'sk-test', '--route', 'other'])).toBe(1)
  expect(output(stderr)).toContain('--route must be')
})

it('removes a connection and its key', async () => {
  const { home, stdout } = fixture()
  expect(await runConnection(['add', 'acme', '--url', 'https://gateway.acme.example', '--key', 'sk-test'])).toBe(0)
  stdout.mockClear()

  expect(await runConnection(['remove', 'acme'])).toBe(0)
  expect(output(stdout)).toContain('removed connection "acme"')
  const connections = readFileSync(join(home, 'connections.yaml'), 'utf8')
  expect(connections).not.toContain('name: acme')
  const credentials = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  expect(credentials).not.toContain('sk-test')
})

it('creates a profile with a connection in one command', async () => {
  const { home, stdout } = fixture()
  expect(await runConnection(['create', 'acme', '--url', 'https://gateway.acme.example', '--key', 'sk-test'])).toBe(0)
  expect(output(stdout)).toContain('created profile "acme"')
  expect(existsSync(join(home, 'profiles', 'acme', 'package.json'))).toBe(true)
  const patch = readFileSync(join(home, 'profiles', 'acme', 'cordis.patch.yml'), 'utf8')
  expect(patch).toContain('apiKeyEnv: ACME_API_KEY')
})

it('rejects an invalid connection name', async () => {
  const { stderr } = fixture()
  expect(await runConnection(['add', 'Acme', '--url', 'https://x.example', '--key', 'sk-test'])).toBe(1)
  expect(output(stderr)).toContain('must match')
})

it('rejects an unknown connection on use', async () => {
  const { stderr } = fixture()
  expect(await runConnection(['use', 'tui', 'nope'])).toBe(1)
  expect(output(stderr)).toContain('no connection named "nope"')
})

it('saves a connection without --key, relying on a stored reference', async () => {
  const { home, stdout } = fixture()
  expect(await runConnection(['add', 'acme', '--url', 'https://gateway.acme.example'])).toBe(0)
  expect(output(stdout)).toContain('no --key given')
  const connections = readFileSync(join(home, 'connections.yaml'), 'utf8')
  expect(connections).toContain('apiKeyEnv: ACME_API_KEY')
  const credentials = existsSync(join(home, '.credentials.yaml')) ? readFileSync(join(home, '.credentials.yaml'), 'utf8') : ''
  expect(credentials).not.toContain('ACME_API_KEY')
})

it('rejects a missing required flag', async () => {
  const { stderr } = fixture()
  expect(await runConnection(['add', 'acme'])).toBe(1)
  expect(output(stderr)).toContain('--url is required')
})

it('rejects an unknown action', async () => {
  const { stderr } = fixture()
  expect(await runConnection(['frobnicate'])).toBe(1)
  expect(output(stderr)).toContain('unknown connection action')
})
