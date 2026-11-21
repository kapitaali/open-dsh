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

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyConnectionToProfile,
  findConnection,
  isConnectionName,
  readConnections,
  removeConnectionKey,
  resolveConnectionsPath,
  storeConnectionKey,
  writeConnections,
  type Connection,
} from '@deepseek-ai/dsh-connection-store'
import { initProfile, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { DEFAULT_PROFILE_BUNDLES, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'

/** The profile rows a connection is applied through. */

/** Derive the credential reference for a connection name. */
function credentialRefFor(name: string): string {
  return `${name.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

/**
 * Make `dsh --profile <name> …` work straight after a connection is imported.
 *
 * When the profile directory is missing but a connection of that name exists,
 * create the profile from a shipped template and apply the connection — so
 * `pnpm dsh --profile nous web` behaves like
 * `pnpm dsh connection use nous nous --from-default-profile web`.
 * Does nothing when the profile already exists or no connection matches (the
 * launcher then reports its usual "profile does not exist").
 * @param profile - profile name.
 * @returns whether this call created the profile.
 */
export async function ensureProfileForConnection(profile: string): Promise<boolean> {
  if (existsSync(join(resolveProfileDir(profile), 'package.json'))) return false
  const document = await readConnections(resolveConnectionsPath())
  const connection = findConnection(document, profile)
  if (connection === undefined) return false
  // Create the profile directory before applyConnectionToProfile writes the
  // patch; the writer's withFileLock needs the parent to exist for its .lock
  // sibling. Without this the same-named-connection boot fails on a fresh home.
  const template = process.env.DSH_PROFILE_TEMPLATE ?? 'web'
  initProfile(resolveProfileDir(profile), profileTemplate(template))
  await applyConnectionToProfile(profile, connection)
  process.stdout.write(`dsh: created profile "${profile}" from the web template` +
    ` and applied connection "${connection.name}"\n`)
  return true
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
  const { positionals, flags } = parseArgs(args)
  const profile = requirePositional(positionals, 0, 'use <profile> <name>')
  const name = requirePositional(positionals, 1, 'use <profile> <name>')
  const document = await readConnections(resolveConnectionsPath())
  const connection = findConnection(document, name)
  if (connection === undefined) throw new Error(`no connection named "${name}"`)
  // Initialize the profile directory first: a patch file alone is not a bootable
  // profile, and the launcher expects its manifest and pnpm settings. A shipped
  // template gives it the application bundles (web, headless, …).
  initProfile(resolveProfileDir(profile), profileTemplate(flags['from-default-profile']))
  await applyConnectionToProfile(profile, connection)
  if (connection.route === 'pi-ai' && connection.model === undefined
    && (connection.models === undefined || connection.models.length === 0)) {
    process.stdout.write(`dsh: connection "${name}" names no model, so the profile still defaults to its previous route.\n`)
    process.stdout.write('     run pnpm run refresh:connections, or dsh connection use <profile> <name> --model <id>\n')
  }
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
  dsh connection use <profile> <name> [--from-default-profile <tpl>]
                                                         apply a connection; a shipped template gives the profile its app bundles
  dsh connection list                                     list saved connections
  dsh connection show <name>                              show one connection
  dsh connection remove <name>                            remove a connection and its key
  dsh connection create <profile> --url <url> --key <key> create a profile with a connection

Flags:
  --route <deepseek|pi-ai>   where the profile applies it (default deepseek)
  --model <id>               pi-ai route model (required for pi-ai)
  --api <protocol>           pi-ai wire protocol (default openai-completions)
  --context-window <tokens>  pi-ai route context window`

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

if (import.meta.main) {
  process.exit(await runConnection(process.argv.slice(2)))
}
