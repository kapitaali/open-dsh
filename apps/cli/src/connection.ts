/**
 * `dsh connection` — manage named connection profiles.
 *
 * A connection is one named API route (endpoint + credential reference). This
 * command stores it in `$DSH_HOME/connections.yaml`, stores its API key in the
 * credential store, and applies it to a profile by writing the `llm-deepseek`
 * row's config in that profile's patch layer. The harness runtime resolves the
 * resulting config; it never reads the connection document.
 * @module @deepseek-ai/dsh/connection
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMap, isSeq, parseDocument, type Document } from 'yaml'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { DEFAULT_PROFILE_BUNDLES, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import { initProfile, PROFILE_PATCH_FILENAME, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import {
  findConnection,
  isConnectionName,
  readConnections,
  removeConnectionKey,
  resolveConnectionsPath,
  storeConnectionKey,
  writeConnections,
  type Connection,
} from '@deepseek-ai/dsh-connection-store'

/** The profile rows a connection is applied through. */
const LLM_DEEPSEEK_ROW = { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' } as const
const LLM_PI_AI_ROW = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } as const
const AGENT_DEFAULT_MODEL_ROW = { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' } as const

/** One patch row's identity. */
interface RowRef {
  readonly id: string
  readonly name: string
}

/**
 * Write one connection into a profile's patch layer. A `deepseek` connection
 * replaces the `llm-deepseek` row's config; a `pi-ai` connection merges one
 * provider route into the `llm-pi-ai` row and points the default model at it.
 * Comments and `!!js` expressions outside the changed value survive; the write
 * is atomic at owner-only permissions.
 * @param profile - profile name.
 * @param connection - the connection to apply.
 */
async function applyConnectionToProfile(profile: string, connection: Connection): Promise<void> {
  const patchPath = join(resolveProfileDir(profile), PROFILE_PATCH_FILENAME)
  const document = loadPatchDocument(patchPath)
  if (connection.route === 'pi-ai') applyPiAiConnection(document, connection)
  else applyDeepSeekConnection(document, connection)
  await writeFileAtomic(patchPath, String(document), { mode: 0o600 })
}

function loadPatchDocument(patchPath: string): Document {
  let text: string
  try {
    text = readFileSync(patchPath, 'utf8')
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
  return document
}

function applyDeepSeekConnection(document: Document, connection: Connection): void {
  const index = ensureRow(document, LLM_DEEPSEEK_ROW)
  document.setIn([index, 'config'], document.createNode({
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
  if (connection.model !== undefined) {
    provider.models = [{
      id: connection.model,
      name: connection.model,
      ...connection.contextWindow === undefined ? {} : { contextWindow: connection.contextWindow },
    }]
  }
  const piAiIndex = ensureRow(document, LLM_PI_AI_ROW)
  document.setIn([piAiIndex, 'config', 'providers', connection.name], document.createNode(provider))
  // Without a model the route defers to the installed catalog, so there is no
  // default selection to write yet.
  if (connection.model === undefined) return
  const defaultIndex = ensureRow(document, AGENT_DEFAULT_MODEL_ROW)
  document.setIn([defaultIndex, 'config'], document.createNode({ provider: connection.name, model: connection.model }))
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

/** Index of the patch row matching `row`, appending it when absent. */
function ensureRow(document: Document, row: RowRef): number {
  const existing = findRowIndex(document, row)
  if (existing >= 0) return existing
  document.add(document.createNode({ id: row.id, name: row.name }))
  const contents = document.contents
  if (!isSeq(contents)) throw new Error('profile patch is no longer a YAML sequence')
  return contents.items.length - 1
}

/** Parsed command arguments: positionals plus `--flag value` pairs. */
interface ParsedArgs {
  readonly positionals: readonly string[]
  readonly flags: Readonly<Record<string, string>>
}

/**
 * Run the `dsh connection` command.
 * @param args - arguments after `connection`, verbatim.
 * @returns the process exit code.
 */
export async function runConnection(args: readonly string[]): Promise<number> {
  const [action, ...rest] = args
  try {
    switch (action) {
      case 'add':
        return await addConnection(rest)
      case 'use':
        return await useConnection(rest)
      case 'list':
        return await listConnections()
      case 'show':
        return await showConnection(rest)
      case 'remove':
        return await removeConnection(rest)
      case 'create':
        return await createProfile(rest)
      default:
        process.stderr.write(`dsh: unknown connection action ${JSON.stringify(action ?? '')}\n${USAGE}`)
        return 1
    }
  } catch (error) {
    process.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/** Derive the credential reference for a connection name. */
function credentialRefFor(name: string): string {
  return `${name.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

/** Store one connection, replacing any existing connection of the same name. */
async function saveConnection(connection: Connection): Promise<void> {
  const path = resolveConnectionsPath()
  const document = await readConnections(path)
  await writeConnections(path, {
    version: document.version,
    connections: [...document.connections.filter(existing => existing.name !== connection.name), connection],
  })
}

function assertConnectionName(name: string): void {
  if (!isConnectionName(name)) throw new Error(`connection name "${name}" must match /^[a-z][a-z0-9-]*$/`)
}

/** Build a connection from the shared `add`/`create` flags. */
function connectionFromFlags(name: string, url: string, flags: Readonly<Record<string, string>>): Connection {
  const route = flags['route'] ?? 'deepseek'
  if (route !== 'deepseek' && route !== 'pi-ai') {
    throw new Error(`--route must be "deepseek" or "pi-ai", got "${route}"`)
  }
  const model = flags['model']
  const api = flags['api']
  const rawWindow = flags['context-window']
  const contextWindow = rawWindow === undefined ? undefined : parsePositiveInt(rawWindow, '--context-window')
  return {
    name,
    baseURL: url,
    apiKeyEnv: credentialRefFor(name),
    route,
    ...model === undefined ? {} : { model },
    ...api === undefined ? {} : { api },
    ...contextWindow === undefined ? {} : { contextWindow },
  }
}

function parsePositiveInt(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer, got "${raw}"`)
  return value
}

async function addConnection(args: readonly string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args)
  const name = requirePositional(positionals, 0, 'add <name> --url <url> [--key <key>]')
  const url = requireFlag(flags, 'url')
  const key = optionalFlag(flags, 'key')
  assertConnectionName(name)
  const connection = connectionFromFlags(name, url, flags)
  await saveConnection(connection)
  if (key === undefined) {
    process.stdout.write(`dsh: saved connection "${name}" (${url}) as ${connection.apiKeyEnv}`
      + ' — no --key given, so that reference must already be stored (pnpm run setup:hermes imports Hermes keys)\n')
    return 0
  }
  await storeConnectionKey(connection.apiKeyEnv, key)
  process.stdout.write(`dsh: saved connection "${name}" (${url}) as ${connection.apiKeyEnv}\n`)
  return 0
}

async function useConnection(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs(args)
  const profile = requirePositional(positionals, 0, 'use <profile> <name>')
  const name = requirePositional(positionals, 1, 'use <profile> <name>')
  const document = await readConnections(resolveConnectionsPath())
  const connection = findConnection(document, name)
  if (connection === undefined) throw new Error(`no connection named "${name}"`)
  // Initialize the profile directory first: a patch file alone is not a bootable
  // profile, and the launcher expects its manifest and pnpm settings.
  initProfile(resolveProfileDir(profile), DEFAULT_PROFILE_BUNDLES)
  await applyConnectionToProfile(profile, connection)
  process.stdout.write(`dsh: profile "${profile}" now uses connection "${name}" (${connection.baseURL})\n`)
  return 0
}

async function listConnections(): Promise<number> {
  const document = await readConnections(resolveConnectionsPath())
  if (document.connections.length === 0) {
    process.stdout.write('dsh: no connections saved\n')
    return 0
  }
  process.stdout.write('Connections:\n')
  for (const connection of document.connections) {
    const detail = connection.route === 'pi-ai' && connection.model !== undefined
      ? `  model ${connection.model}`
      : ''
    process.stdout.write(`  ${connection.name}  [${connection.route}]  ${connection.baseURL}  ${connection.apiKeyEnv}${detail}\n`)
  }
  return 0
}

async function showConnection(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs(args)
  const name = requirePositional(positionals, 0, 'show <name>')
  const document = await readConnections(resolveConnectionsPath())
  const connection = findConnection(document, name)
  if (connection === undefined) throw new Error(`no connection named "${name}"`)
  const lines = [
    connection.name,
    `  baseURL:    ${connection.baseURL}`,
    `  apiKeyEnv:  ${connection.apiKeyEnv}`,
    `  route:      ${connection.route}`,
  ]
  if (connection.model !== undefined) lines.push(`  model:      ${connection.model}`)
  if (connection.api !== undefined) lines.push(`  api:        ${connection.api}`)
  if (connection.contextWindow !== undefined) lines.push(`  context:    ${connection.contextWindow}`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

async function removeConnection(args: readonly string[]): Promise<number> {
  const { positionals } = parseArgs(args)
  const name = requirePositional(positionals, 0, 'remove <name>')
  const path = resolveConnectionsPath()
  const document = await readConnections(path)
  const connection = findConnection(document, name)
  if (connection === undefined) throw new Error(`no connection named "${name}"`)
  await writeConnections(path, {
    version: document.version,
    connections: document.connections.filter(existing => existing.name !== name),
  })
  await removeConnectionKey(connection.apiKeyEnv)
  process.stdout.write(`dsh: removed connection "${name}"\n`)
  return 0
}

async function createProfile(args: readonly string[]): Promise<number> {
  const { positionals, flags } = parseArgs(args)
  const profile = requirePositional(positionals, 0, 'create <profile> --url <url> --key <key>')
  const url = requireFlag(flags, 'url')
  const key = requireFlag(flags, 'key')
  assertConnectionName(profile)
  initProfile(resolveProfileDir(profile), profileTemplate(flags['from-default-profile']))
  const connection = connectionFromFlags(profile, url, flags)
  await saveConnection(connection)
  await storeConnectionKey(connection.apiKeyEnv, key)
  await applyConnectionToProfile(profile, connection)
  process.stdout.write(`dsh: created profile "${profile}" using connection "${profile}" (${url})\n`)
  return 0
}

/** Resolve a shipped profile template name to its bundle list. */
function profileTemplate(template: string | undefined): readonly string[] {
  if (template === undefined) return DEFAULT_PROFILE_BUNDLES
  const profile = PROFILE_TEMPLATES[template]
  if (profile === undefined) throw new Error(`unknown default profile "${template}"`)
  return profile.bundles
}

/** Parse positionals and `--flag value` / `--flag=value` pairs. */
function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string> = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === undefined) continue
    const inline = /^--([^=]+)=(.*)$/.exec(arg)
    if (inline !== null) {
      const key = inline[1]
      const value = inline[2]
      if (key !== undefined && value !== undefined) flags[key] = value
      continue
    }
    if (arg.startsWith('--')) {
      const value = args[index + 1]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      flags[arg.slice(2)] = value
      index++
      continue
    }
    positionals.push(arg)
  }
  return { positionals, flags }
}

function requirePositional(positionals: readonly string[], index: number, usage: string): string {
  const value = positionals[index]
  if (value === undefined) throw new Error(`usage: dsh connection ${usage}`)
  return value
}

function requireFlag(flags: Readonly<Record<string, string>>, name: string): string {
  const value = flags[name]
  if (value === undefined || value === '') throw new Error(`--${name} is required`)
  return value
}

function optionalFlag(flags: Readonly<Record<string, string>>, name: string): string | undefined {
  const value = flags[name]
  return value === undefined || value === '' ? undefined : value
}

const USAGE = `Usage:
  dsh connection add <name> --url <url> [--key <key>]     save a connection (key optional if already stored)
  dsh connection use <profile> <name>                     apply a connection to a profile
  dsh connection list                                     list saved connections
  dsh connection show <name>                              show one connection
  dsh connection remove <name>                            remove a connection and its key
  dsh connection create <profile> --url <url> --key <key> create a profile with a connection

Flags:
  --route <deepseek|pi-ai>   where the profile applies it (default deepseek)
  --model <id>               pi-ai route model (required for pi-ai)
  --api <protocol>           pi-ai wire protocol (default openai-completions)
  --context-window <tokens>  pi-ai route context window`
