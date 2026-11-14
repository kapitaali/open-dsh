import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findConnection,
  isConnectionName,
  parseConnectionsDocument,
  readConnections,
  removeConnectionKey,
  resolveConnectionsPath,
  serializeConnections,
  storeConnectionKey,
  writeConnections,
  type Connection,
  type ConnectionDocument,
} from '../src/index.ts'

const cleanups: Array<() => Promise<void>> = []
const ORIGINAL_DSH_HOME = process.env.DSH_HOME

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = ORIGINAL_DSH_HOME
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-connection-store-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  process.env.DSH_HOME = dir
  return dir
}

const ACME: Connection = { name: 'acme', baseURL: 'https://gateway.acme.example', apiKeyEnv: 'ACME_API_KEY', route: 'deepseek' }

describe('isConnectionName', () => {
  it('accepts a lowercase hyphenated identifier', () => {
    expect(isConnectionName('acme')).toBe(true)
    expect(isConnectionName('acme-gateway-2')).toBe(true)
  })

  it('rejects anything outside the grammar', () => {
    for (const value of ['', 'Acme', '2acme', 'acme_gateway', 'acme.gateway', 'acme gateway', '-acme']) {
      expect(isConnectionName(value)).toBe(false)
    }
  })
})

describe('parseConnectionsDocument', () => {
  it('reads an empty document as an empty store', () => {
    expect(parseConnectionsDocument('', 'file')).toEqual({ version: 1, connections: [] })
    expect(parseConnectionsDocument('version: 1\n', 'file')).toEqual({ version: 1, connections: [] })
  })

  it('reads every connection in file order', () => {
    const document = parseConnectionsDocument(serializeConnections({
      version: 1,
      connections: [ACME, { name: 'beta', baseURL: 'https://beta.example', apiKeyEnv: 'BETA_API_KEY', route: 'deepseek' }],
    }), 'file')
    expect(document.connections.map(connection => connection.name)).toEqual(['acme', 'beta'])
  })

  it('refuses an unsupported version', () => {
    expect(() => parseConnectionsDocument('version: 2\nconnections: []\n', 'file')).toThrow(/unsupported document version/)
  })

  it('refuses a malformed connection field', () => {
    expect(() => parseConnectionsDocument('version: 1\nconnections:\n  - name: Acme\n', 'file'))
      .toThrow(/must match/)
    expect(() => parseConnectionsDocument('version: 1\nconnections:\n  - name: acme\n    baseURL: ftp://x\n    apiKeyEnv: ACME_API_KEY\n', 'file'))
      .toThrow(/must use HTTP/)
    expect(() => parseConnectionsDocument('version: 1\nconnections:\n  - name: acme\n    baseURL: https://x.example\n    apiKeyEnv: not a ref\n', 'file'))
      .toThrow(/POSIX environment-variable name/)
  })

  it('refuses a duplicate name', () => {
    const text = serializeConnections({ version: 1, connections: [ACME, ACME] })
    expect(() => parseConnectionsDocument(text, 'file')).toThrow(/duplicate connection name/)
  })

  it('refuses malformed YAML', () => {
    expect(() => parseConnectionsDocument('version: 1\nconnections:\n  - name: [unclosed\n', 'file')).toThrow(/invalid document/)
  })
})

describe('connection route', () => {
  it('defaults to deepseek when the field is absent', () => {
    const document = parseConnectionsDocument(
      'version: 1\nconnections:\n  - name: acme\n    baseURL: https://x.example\n    apiKeyEnv: ACME_API_KEY\n',
      'file',
    )
    expect(document.connections[0]?.route).toBe('deepseek')
  })

  it('reads a pi-ai route with its model, protocol and context window', () => {
    const connection: Connection = {
      name: 'nous',
      baseURL: 'https://inference.example/v1',
      apiKeyEnv: 'NOUS_API_KEY',
      route: 'pi-ai',
      model: 'm/1',
      api: 'openai-completions',
      contextWindow: 200_000,
    }
    const parsed = parseConnectionsDocument(serializeConnections({ version: 1, connections: [connection] }), 'file')
    expect(parsed.connections[0]).toEqual(connection)
  })

  it('refuses an unknown route', () => {
    expect(() => parseConnectionsDocument(
      'version: 1\nconnections:\n  - name: acme\n    baseURL: https://x.example\n    apiKeyEnv: ACME_API_KEY\n    route: other\n',
      'file',
    )).toThrow(/must be "deepseek" or "pi-ai"/)
  })

  it('refuses a pi-ai route without a model', () => {
    expect(() => parseConnectionsDocument(
      'version: 1\nconnections:\n  - name: acme\n    baseURL: https://x.example\n    apiKeyEnv: ACME_API_KEY\n    route: pi-ai\n',
      'file',
    )).toThrow(/needs a model/)
  })

  it('refuses a non-positive context window', () => {
    expect(() => parseConnectionsDocument(
      'version: 1\nconnections:\n  - name: acme\n    baseURL: https://x.example\n    apiKeyEnv: ACME_API_KEY\n    route: pi-ai\n    model: m/1\n    contextWindow: 0\n',
      'file',
    )).toThrow(/positive integer/)
  })
})

describe('serializeConnections', () => {
  it('carries the version and never the key', () => {
    const text = serializeConnections({ version: 1, connections: [ACME] })
    expect(text).toContain('version: 1')
    expect(text).toContain('baseURL: https://gateway.acme.example')
    expect(text).toContain('apiKeyEnv: ACME_API_KEY')
    expect(text).not.toContain('sk-')
  })

  it('round-trips through the parser', () => {
    const document: ConnectionDocument = { version: 1, connections: [ACME] }
    expect(parseConnectionsDocument(serializeConnections(document), 'file')).toEqual(document)
  })
})

describe('resolveConnectionsPath', () => {
  it('honours $DSH_HOME', async () => {
    const home = await tempHome()
    expect(resolveConnectionsPath()).toBe(join(home, 'connections.yaml'))
  })
})

describe('readConnections / writeConnections', () => {
  it('reads an absent document as an empty store', async () => {
    await tempHome()
    const path = resolveConnectionsPath()
    expect(await readConnections(path)).toEqual({ version: 1, connections: [] })
  })

  it('writes a document that reads back equal', async () => {
    await tempHome()
    const path = resolveConnectionsPath()
    await writeConnections(path, { version: 1, connections: [ACME] })
    expect(await readConnections(path)).toEqual({ version: 1, connections: [ACME] })
  })

  it('writes at owner-only permissions', async () => {
    await tempHome()
    const path = resolveConnectionsPath()
    await writeConnections(path, { version: 1, connections: [ACME] })
    const { stat } = await import('node:fs/promises')
    const mode = (await stat(path)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('refuses to read a malformed document', async () => {
    await tempHome()
    const path = resolveConnectionsPath()
    await writeFile(path, 'version: 1\nconnections: [unclosed\n', { mode: 0o600 })
    await expect(readConnections(path)).rejects.toThrow(/invalid document/)
  })
})

describe('findConnection', () => {
  it('finds by name and reports absence', () => {
    const document: ConnectionDocument = { version: 1, connections: [ACME] }
    expect(findConnection(document, 'acme')).toEqual(ACME)
    expect(findConnection(document, 'nope')).toBeUndefined()
    expectTypeOf(findConnection(document, 'acme')).toEqualTypeOf<Connection | undefined>()
  })
})

describe('storeConnectionKey / removeConnectionKey', () => {
  it('writes a ref that the credentials layout reads', async () => {
    await tempHome()
    await storeConnectionKey('ACME_API_KEY', 'sk-test')
    const text = await readFile(join(process.env.DSH_HOME!, '.credentials.yaml'), 'utf8')
    expect(text).toContain('ACME_API_KEY')
    expect(text).toContain('sk-test')
  })

  it('preserves an existing ref and record', async () => {
    await tempHome()
    const path = join(process.env.DSH_HOME!, '.credentials.yaml')
    await writeFile(path, 'version: 1\nrefs:\n  OTHER: keep\nrecords:\n  llm-pi-ai/x:\n    kind: grant\n    payload: { a: 1 }\n', { mode: 0o600 })
    await storeConnectionKey('ACME_API_KEY', 'sk-test')
    const text = await readFile(path, 'utf8')
    expect(text).toContain('OTHER: keep')
    expect(text).toContain('llm-pi-ai/x')
    expect(text).toContain('sk-test')
  })

  it('removes only its own ref', async () => {
    await tempHome()
    await storeConnectionKey('ACME_API_KEY', 'sk-test')
    await storeConnectionKey('OTHER', 'keep')
    await removeConnectionKey('ACME_API_KEY')
    const text = await readFile(join(process.env.DSH_HOME!, '.credentials.yaml'), 'utf8')
    expect(text).not.toContain('sk-test')
    expect(text).toContain('OTHER')
  })

  it('refuses an empty key value', async () => {
    await tempHome()
    await expect(storeConnectionKey('ACME_API_KEY', '')).rejects.toThrow(/empty key/)
  })

  it('refuses a ref outside the grammar', async () => {
    await tempHome()
    await expect(storeConnectionKey('not a ref', 'sk-test')).rejects.toThrow(/POSIX environment-variable name/)
  })

  it('removing a key from a document without refs is a no-op', async () => {
    await tempHome()
    const path = join(process.env.DSH_HOME!, '.credentials.yaml')
    await writeFile(path, 'version: 1\nrecords: {}\n', { mode: 0o600 })
    await expect(removeConnectionKey('ACME_API_KEY')).resolves.toBeUndefined()
    const text = await readFile(path, 'utf8')
    expect(text).toContain('records: {}')
  })
})
