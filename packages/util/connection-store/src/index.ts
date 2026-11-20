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

import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Document, isMap, isSeq, parseDocument, stringify, type YAMLError } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { initProfile, PROFILE_PATCH_FILENAME, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { DEFAULT_PROFILE_BUNDLES, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'

/** Basename of the connection document inside the harness home. */
export const CONNECTIONS_FILENAME = 'connections.yaml'

/** The document layout this build reads and writes. */
export const CONNECTIONS_DOCUMENT_VERSION = 1

/** Grammar of a connection name: a lowercase hyphenated identifier. */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/

/** How a profile applies a connection. */
export type ConnectionRoute = 'deepseek' | 'pi-ai'

/** One named API route. */
export interface Connection {
  /** Lowercase hyphenated handle a person types. */
  readonly name: string
  /** Endpoint root; an HTTP(S) URL without credentials, query, or fragment. */
  readonly baseURL: string
  /** Credential reference resolved per request; the API key lives in the credential store. */
  readonly apiKeyEnv: string
  /**
   * Where the profile applies the connection: `deepseek` writes the
   * `llm-deepseek` row (Anthropic Messages wire); `pi-ai` writes an
   * `llm-pi-ai` provider route (OpenAI-compatible and other wires).
   */
  readonly route: ConnectionRoute
  /** `pi-ai` route model id; when omitted, the route defers to the installed catalog. */
  readonly model?: string
  /** `pi-ai` route model ids discovered from the endpoint; replaces the catalog when present. */
  readonly models?: readonly string[]
  /** `pi-ai` wire protocol; defaults to `openai-completions`. */
  readonly api?: string
  /** `pi-ai` route context window; defaults to the route's own default. */
  readonly contextWindow?: number
  /**
   * Default reasoning effort levels offered by models on this connection,
   * applied to every model entry the connection writes into a profile patch.
   */
  readonly reasoningEfforts?: Partial<Record<'off' | 'low' | 'high' | 'max', string | null>>
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
    const route = record['route'] === undefined ? 'deepseek' : requireString(record, 'route', filename)
    if (route !== 'deepseek' && route !== 'pi-ai') {
      throw new Error(`connection-store: route "${route}" at ${filename} must be "deepseek" or "pi-ai"`)
    }
    const model = optionalString(record, 'model', filename)
    const models = optionalStringList(record, 'models', filename)
    const api = optionalString(record, 'api', filename)
    const contextWindow = optionalPositiveInt(record, 'contextWindow', filename)
    const reasoningEfforts = optionalReasoningEfforts(record, 'reasoningEfforts', filename)
    if (seen.has(name)) {
      throw new Error(`connection-store: duplicate connection name "${name}" at ${filename}`)
    }
    seen.add(name)
    connections.push({
      name,
      baseURL,
      apiKeyEnv,
      route,
      ...model === undefined ? {} : { model },
      ...models === undefined ? {} : { models },
      ...api === undefined ? {} : { api },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    })
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
      route: connection.route,
      ...connection.model === undefined ? {} : { model: connection.model },
      ...connection.models === undefined ? {} : { models: connection.models },
      ...connection.api === undefined ? {} : { api: connection.api },
      ...connection.contextWindow === undefined ? {} : { contextWindow: connection.contextWindow },
      ...connection.reasoningEfforts === undefined ? {} : { reasoningEfforts: connection.reasoningEfforts },
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

/** One patch row's identity. */
interface RowRef {
  readonly id: string
  readonly name: string
}

const LLM_DEEPSEEK_ROW = { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' } as const
const LLM_PI_AI_ROW = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } as const
const AGENT_DEFAULT_MODEL_ROW = { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' } as const

/**
 * Write one connection into a profile's patch layer. A `deepseek` connection
 * replaces the `llm-deepseek` row's config; a `pi-ai` connection merges one
 * provider route into the `llm-pi-ai` row and points the default model at it.
 * Comments and `!!js` expressions outside the changed value survive; the write
 * is atomic at owner-only permissions.
 * @param profile - profile name.
 * @param connection - the connection to apply.
 * @param dshHome - Harness home; defaults to `$DSH_HOME` or `~/.dsh`.
 */
export async function applyConnectionToProfile(
  profile: string,
  connection: Connection,
  dshHome?: string,
): Promise<void> {
  const patchPath = join(resolveProfileDir(profile, dshHome), PROFILE_PATCH_FILENAME)
  let text: string
  try {
    text = await readFile(patchPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = '[]\n'
  }
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  })
  if (document.errors[0] !== undefined) throw document.errors[0]
  if (!isSeq(document.contents)) throw new Error(`${patchPath} must be a YAML sequence`)
  document.contents.flow = false

  if (connection.route === 'pi-ai') applyPiAiConnection(document, connection)
  else applyDeepSeekConnection(document, connection)

  await withFileLock(patchPath, async () => {
    // Strip aliases: the runtime loader's YAML parser has a default maxAliasCount
    // of 100, and one connection writes the same reasoningEfforts map into
    // hundreds of models. Serialize with aliasDuplicateObjects: false so each
    // model carries its own inline map and the patch always loads.
    const text = stringify(document.toJSON(), { aliasDuplicateObjects: false, lineWidth: -1 })
    await writeFileAtomic(patchPath, text, { mode: 0o600 })
  })
}

function applyDeepSeekConnection(document: Document, connection: Connection): void {
  const index = findRowIndex(document, LLM_DEEPSEEK_ROW)
  if (index < 0) document.add(document.createNode({ id: LLM_DEEPSEEK_ROW.id, name: LLM_DEEPSEEK_ROW.name }))
  const finalIndex = findRowIndex(document, LLM_DEEPSEEK_ROW)
  document.setIn([finalIndex, 'config'], document.createNode({
    baseURL: connection.baseURL,
    apiKeyEnv: connection.apiKeyEnv,
  }))
}

function applyPiAiConnection(document: Document, connection: Connection): void {
  const provider: Record<string, unknown> = {
    displayName: connection.name,
    apiKeyEnv: connection.apiKeyEnv,
    api: connection.api ?? 'openai-completions',
    baseURL: connection.baseURL,
  }
  if (connection.models !== undefined && connection.models.length > 0) {
    provider.models = connection.models.map(id => ({
      id,
      name: id,
      ...connection.contextWindow === undefined ? {} : { contextWindow: connection.contextWindow },
      ...connection.reasoningEfforts === undefined ? {} : { reasoningEfforts: connection.reasoningEfforts },
    }))
  } else if (connection.model !== undefined) {
    provider.models = [{
      id: connection.model,
      name: connection.model,
      ...connection.contextWindow === undefined ? {} : { contextWindow: connection.contextWindow },
      ...connection.reasoningEfforts === undefined ? {} : { reasoningEfforts: connection.reasoningEfforts },
    }]
  }
  const piAiIndex = findRowIndex(document, LLM_PI_AI_ROW)
  if (piAiIndex < 0) document.add(document.createNode({ id: LLM_PI_AI_ROW.id, name: LLM_PI_AI_ROW.name }))
  const finalPiAiIndex = findRowIndex(document, LLM_PI_AI_ROW)
  document.setIn([finalPiAiIndex, 'config', 'providers', connection.name], document.createNode(provider))
  const model = connection.model ?? connection.models?.[0]
  if (model === undefined) return
  const defaultIndex = findRowIndex(document, AGENT_DEFAULT_MODEL_ROW)
  if (defaultIndex < 0) document.add(document.createNode({ id: AGENT_DEFAULT_MODEL_ROW.id, name: AGENT_DEFAULT_MODEL_ROW.name }))
  const finalDefaultIndex = findRowIndex(document, AGENT_DEFAULT_MODEL_ROW)
  document.setIn([finalDefaultIndex, 'config'], document.createNode({ provider: connection.name, model }))
}

/** Index of the last patch row matching `row`, or -1. */
function findRowIndex(document: Document, row: RowRef): number {
  const contents = document.contents
  if (!isSeq(contents)) return -1
  return contents.items.findLastIndex((item, itemIndex) => isMap(item)
    && document.getIn([itemIndex, 'id']) === row.id
    && !item.has('insert')
    && (!item.has('name') || document.getIn([itemIndex, 'name']) === row.name))
}

/**
 * Create a profile from a shipped template (default `web`) when it does not
 * exist, then apply the same-named connection to it. No-op when the profile
 * already exists — callers that want to re-apply should call
 * `applyConnectionToProfile` directly.
 * @param profile - profile name (matches a connection name).
 * @param dshHome - Harness home; defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns whether the profile was created.
 */
export async function ensureProfileForConnection(
  profile: string,
  dshHome?: string,
): Promise<boolean> {
  const profileDir = resolveProfileDir(profile, dshHome)
  const manifestPath = join(profileDir, 'package.json')
  const exists = existsSync(manifestPath)
  if (exists) return false

  const document = await readConnections(resolveConnectionsPath(dshHome))
  const connection = findConnection(document, profile)
  if (connection === undefined) return false

  const template = process.env.DSH_PROFILE_TEMPLATE ?? 'web'
  const bundles = PROFILE_TEMPLATES[template]?.bundles ?? DEFAULT_PROFILE_BUNDLES
  initProfile(profileDir, bundles)
  await applyConnectionToProfile(profile, connection, dshHome)
  return true
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    const text = await readExistingText(path)
    if (text === undefined) return
    const document = mutableCredentialDocument(text, path)
    if (document.has('refs')) document.deleteIn(['refs', ref])
    await writeFileAtomic(path, document.toString(), { mode: 0o600, dirMode: 0o700 })
  }, { waitMs: 120_000 })
}

/**
 * Read one stored connection key.
 *
 * Read-only counterpart of {@link storeConnectionKey}; used by callers that need
 * the value to talk to the provider, such as a model-listing request. Returns
 * undefined when the reference is absent or the file cannot be read.
 * @param ref - credential reference (the connection's `apiKeyEnv`).
 * @param dshHome - Harness home; defaults to `$DSH_HOME` or `~/.dsh`.
 * @returns the stored value, or undefined.
 */
export async function readConnectionKey(ref: string, dshHome?: string): Promise<string | undefined> {
  const path = resolveCredentialsPath(dshHome)
  const text = await readExistingText(path)
  if (text === undefined) return undefined
  const document = mutableCredentialDocument(text, path)
  const value = document.getIn(['refs', ref])
  return typeof value === 'string' && value.length > 0 ? value : undefined
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

function optionalString(record: Record<string, unknown>, key: string, filename: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`connection-store: "${key}" at ${filename} must be a non-empty string`)
  }
  return value
}

function optionalPositiveInt(record: Record<string, unknown>, key: string, filename: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`connection-store: "${key}" at ${filename} must be a positive integer`)
  }
  return value
}

function optionalStringList(record: Record<string, unknown>, key: string, filename: string): string[] | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`connection-store: "${key}" at ${filename} must be an array of non-empty strings`)
  }
  return value as string[]
}

/** Parse one connection's optional reasoningEfforts map: { off: null, low: 'low', high: 'high', max: 'max' }. */
function optionalReasoningEfforts(record: Record<string, unknown>, key: string, filename: string): Partial<Record<'off' | 'low' | 'high' | 'max', string | null>> | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`connection-store: "${key}" at ${filename} must be a mapping of level to wire value`)
  }
  const efforts = value as Record<string, unknown>
  const result: Partial<Record<'off' | 'low' | 'high' | 'max', string | null>> = {}
  for (const [level, wire] of Object.entries(efforts)) {
    if (wire !== null && typeof wire !== 'string') {
      throw new Error(`connection-store: "${key}.${level}" at ${filename} must be a string or null`)
    }
    result[level as 'off' | 'low' | 'high' | 'max'] = wire
  }
  return result
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
