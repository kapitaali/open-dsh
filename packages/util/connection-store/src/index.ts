/**
 * Named connection profiles for the DeepSeek Harness.
 *
 * A connection profile is one named API route: a `baseURL` endpoint and the
 * credential reference (`apiKeyEnv`) that authenticates against it. The name
 * is the handle a person types; the credential reference is resolved by the
 * credential seam, so no secret value lives in this document.
 *
 * The document is `$DSH_HOME/connections.yaml`, a versioned YAML file with one
 * `connections` list. It is read and written by the `dsh connection` command
 * and by any embedder that wants to enumerate or apply a connection; the
 * harness runtime itself does not read it. A profile applies a connection by
 * writing the `llm-deepseek` row's config in its own patch layer.
 *
 * Parsing is strict: an unreadable or malformed document is refused rather than
 * silently treated as empty, because a dropped connection reads as "the
 * connection I saved has no effect". An absent document is an empty store.
 *
 * @module @deepseek-ai/dsh-connection-store
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Document, parseDocument, stringify, type YAMLError } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Basename of the connection document inside the harness home. */
export const CONNECTIONS_FILENAME = 'connections.yaml'

/** The document layout this build reads and writes. */
export const CONNECTIONS_DOCUMENT_VERSION = 1

/** Grammar of a connection name: a lowercase hyphenated identifier. */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/** One named API route. */
export interface Connection {
  /** Lowercase hyphenated handle a person types. */
  readonly name: string
  /** Messages-compatible endpoint root; an HTTP(S) URL without credentials, query, or fragment. */
  readonly baseURL: string
  /** Credential reference resolved per request; the API key lives in the credential store. */
  readonly apiKeyEnv: string
}

/** One parsed connection document. */
export interface ConnectionDocument {
  /** Document layout version; {@link CONNECTIONS_DOCUMENT_VERSION}. */
  readonly version: number
  /** Every stored connection, in file order. */
  readonly connections: readonly Connection[]
}

/**
 * Resolve the connection document path.
 * @param dshHome - Harness home; defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns the absolute path of `connections.yaml`.
 */
export function resolveConnectionsPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), CONNECTIONS_FILENAME))
}

/**
 * Whether a raw string could be a connection name.
 * @param value - candidate name.
 * @returns true when the name matches the grammar.
 */
export function isConnectionName(value: string): boolean {
  return NAME_PATTERN.test(value)
}

/**
 * Read one connection document.
 * @param path - absolute path of the document.
 * @returns the parsed document, or an empty store when the file is absent.
 * @throws when the file exists but cannot be read or parsed.
 */
export async function readConnections(path: string): Promise<ConnectionDocument> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: CONNECTIONS_DOCUMENT_VERSION, connections: [] }
    }
    throw error
  }
  return parseConnectionsDocument(text, path)
}

/**
 * Parse and validate one connection document.
 * @param text - the document's text.
 * @param filename - absolute path, quoted in errors.
 * @returns the validated document.
 * @throws when the document is malformed or any connection is invalid.
 */
export function parseConnectionsDocument(text: string, filename: string): ConnectionDocument {
  const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true })
  const parseError = document.errors[0]
  if (parseError !== undefined) {
    throw new Error(`connection-store: invalid document at ${filename}: ${describeYamlError(parseError)}`)
  }
  const root: unknown = document.toJS() ?? {}
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new TypeError(`connection-store: document at ${filename} must be a mapping`)
  }
  const fields = root as Record<string, unknown>
  const version = fields['version']
  if (version !== undefined && version !== CONNECTIONS_DOCUMENT_VERSION) {
    throw new Error(
      `connection-store: unsupported document version ${JSON.stringify(version)} at ${filename};`
      + ` expected ${String(CONNECTIONS_DOCUMENT_VERSION)}`,
    )
  }
  const rawConnections = fields['connections']
  if (rawConnections === undefined) {
    return { version: CONNECTIONS_DOCUMENT_VERSION, connections: [] }
  }
  if (!Array.isArray(rawConnections)) {
    throw new Error(`connection-store: "connections" at ${filename} must be an array`)
  }
  const connections: Connection[] = []
  const seen = new Set<string>()
  for (const entry of rawConnections) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`connection-store: every "connections" entry at ${filename} must be a mapping`)
    }
    const record = entry as Record<string, unknown>
    const name = requireString(record, 'name', filename)
    if (!isConnectionName(name)) {
      throw new Error(
        `connection-store: connection name "${name}" at ${filename} must match ${String(NAME_PATTERN)}`,
      )
    }
    const baseURL = requireString(record, 'baseURL', filename)
    assertValidBaseURL(baseURL, filename)
    const apiKeyEnv = requireString(record, 'apiKeyEnv', filename)
    if (!isCredentialRefName(apiKeyEnv)) {
      throw new Error(
        `connection-store: apiKeyEnv "${apiKeyEnv}" at ${filename} must be a POSIX environment-variable name`,
      )
    }
    if (seen.has(name)) {
      throw new Error(`connection-store: duplicate connection name "${name}" at ${filename}`)
    }
    seen.add(name)
    connections.push({ name, baseURL, apiKeyEnv })
  }
  return { version: CONNECTIONS_DOCUMENT_VERSION, connections }
}

/**
 * Serialize one connection document.
 *
 * The file is machine-managed; comments a person wrote in it are not preserved
 * across a write. The credential value is never part of the document.
 * @param document - the document to serialize.
 * @returns the YAML text, ending with one newline.
 */
export function serializeConnections(document: ConnectionDocument): string {
  const body = stringify({
    version: document.version,
    connections: document.connections.map(connection => ({
      name: connection.name,
      baseURL: connection.baseURL,
      apiKeyEnv: connection.apiKeyEnv,
    })),
  })
  return '# DeepSeek Harness connection profiles — managed by `dsh connection`.\n'
    + '# The API key is not stored here; it lives in the credential store under apiKeyEnv.\n'
    + body
}

/**
 * Write one connection document atomically under the cross-process lock.
 * @param path - absolute path of the document.
 * @param document - the document to write.
 */
export async function writeConnections(path: string, document: ConnectionDocument): Promise<void> {
  await withFileLock(path, async () => {
    await writeFileAtomic(path, serializeConnections(document), { mode: 0o600, dirMode: 0o700 })
  })
}

/**
 * Find one connection by name.
 * @param document - the document to search.
 * @param name - the connection name.
 * @returns the connection, or undefined when absent.
 */
export function findConnection(document: ConnectionDocument, name: string): Connection | undefined {
  return document.connections.find(connection => connection.name === name)
}

/** Basename of the credential document inside the harness home. */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** The credential document layout this build writes; mirrors the credentials store. */
const CREDENTIALS_DOCUMENT_VERSION = 1

/**
 * Resolve the credential document path.
 * @param dshHome - Harness home; defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns the absolute path of `.credentials.yaml`.
 */
export function resolveCredentialsPath(dshHome?: string): string {
  return resolve(join(resolveDshHome(dshHome), CREDENTIALS_FILENAME))
}

/**
 * Store one connection's API key under its credential reference.
 *
 * The write mirrors the credentials store's reference edit: it re-parses the
 * current document under the writer lock, sets one `refs` entry, and replaces
 * the file atomically at owner-only permissions. Comments and every untouched
 * entry survive; a document that exists but cannot be parsed is refused rather
 * than overwritten.
 * @param ref - credential reference (the connection's `apiKeyEnv`).
 * @param value - the API key value.
 * @param dshHome - Harness home; defaults to `$DSH_HOME` or `~/.dsh`.
 */
export async function storeConnectionKey(ref: string, value: string, dshHome?: string): Promise<void> {
  if (value.length === 0) throw new Error(`connection-store: an empty key cannot be stored for "${ref}"`)
  if (!isCredentialRefName(ref)) {
    throw new Error(`connection-store: "${ref}" must be a POSIX environment-variable name`)
  }
  const path = resolveCredentialsPath(dshHome)
  await withFileLock(path, async () => {
    const text = await readExistingText(path)
    const document = mutableCredentialDocument(text, path)
    document.setIn(['refs', ref], value)
    await writeFileAtomic(path, document.toString(), { mode: 0o600, dirMode: 0o700 })
  }, { waitMs: 120_000 })
}

/**
 * Remove one connection's API key.
 * @param ref - credential reference (the connection's `apiKeyEnv`).
 * @param dshHome - Harness home; defaults to `$DSH_HOME` or `~/.dsh`.
 */
export async function removeConnectionKey(ref: string, dshHome?: string): Promise<void> {
  const path = resolveCredentialsPath(dshHome)
  await withFileLock(path, async () => {
    const text = await readExistingText(path)
    if (text === undefined) return
    const document = mutableCredentialDocument(text, path)
    if (document.has('refs')) document.deleteIn(['refs', ref])
    await writeFileAtomic(path, document.toString(), { mode: 0o600, dirMode: 0o700 })
  }, { waitMs: 120_000 })
}

async function readExistingText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function mutableCredentialDocument(text: string | undefined, filename: string): Document {
  const document = text === undefined ? new Document({}) : parseDocument(text, { intAsBigInt: true })
  const parseError = document.errors[0]
  if (parseError !== undefined) {
    throw new Error(`connection-store: invalid credential document at ${filename}: ${describeYamlError(parseError)}`)
  }
  document.setIn(['version'], CREDENTIALS_DOCUMENT_VERSION)
  return document
}

function requireString(record: Record<string, unknown>, key: string, filename: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`connection-store: "${key}" at ${filename} must be a non-empty string`)
  }
  return value
}

function assertValidBaseURL(baseURL: string, filename: string): void {
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new Error(`connection-store: baseURL "${baseURL}" at ${filename} is not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`connection-store: baseURL "${baseURL}" at ${filename} must use HTTP(S)`)
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      `connection-store: baseURL "${baseURL}" at ${filename} must not carry credentials, a query, or a fragment`,
    )
  }
}

function describeYamlError(error: YAMLError): string {
  const at = error.linePos?.[0]
  const where = at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`
  return `${error.code}${where}`
}
