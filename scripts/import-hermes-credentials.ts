/**
 * Import credential references from a Hermes install into the dsh credential store.
 *
 * Hermes keeps its provider keys in `<hermes-home>/.env`; dsh keeps its own secrets in
 * `<dsh-home>/.credentials.yaml` under credential references. This setup step reads the
 * Hermes `.env`, imports every credential-shaped entry, and writes the dsh credential file
 * through the connection store's locked, atomic writer — so a dsh connection profile can
 * name any key Hermes already has.
 *
 * Values are never printed: only reference names and counts.
 *
 * @module scripts/import-hermes-credentials
 */

import { createInterface } from 'node:readline'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { PROVIDER_DATA } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  readConnections,
  storeConnectionKey,
  writeConnections,
  resolveConnectionsPath,
  type Connection,
} from '@deepseek-ai/dsh-connection-store'

/** A key whose value is a secret worth importing. */
const CREDENTIAL_KEY = /_(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i

interface Options {
  readonly hermesHome: string | undefined
  readonly dshHome: string | undefined
  /** Import every `KEY=value` entry, not only credential-shaped names. */
  readonly all: boolean
  /** Report what would be written without touching the stores. */
  readonly dryRun: boolean
  /** Import keys only; do not create a connection for each recognised provider. */
  readonly keysOnly: boolean
  /** Model id applied to every created `pi-ai` connection. */
  readonly model: string | undefined
  /** Wire protocol applied to every created `pi-ai` connection. */
  readonly api: string | undefined
}

/** One parsed `.env` entry. */
interface EnvEntry {
  readonly key: string
  readonly value: string
}

/**
 * Read flags from argv.
 * @param argv - arguments after the script name.
 * @returns the parsed options; unknown flags are an error string.
 */
export function parseArgs(argv: readonly string[]): Options | string {
  let hermesHome: string | undefined
  let dshHome: string | undefined
  let all = false
  let dryRun = false
  let keysOnly = false
  let model: string | undefined
  let api: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--') continue
    if (arg === '--hermes-home' || arg === '--dsh-home' || arg === '--model' || arg === '--api') {
      const value = argv[index + 1]
      if (value === undefined) return `${arg} needs a value`
      if (arg === '--hermes-home') hermesHome = value
      else if (arg === '--dsh-home') dshHome = value
      else if (arg === '--model') model = value
      else api = value
      index++
      continue
    }
    if (arg === '--all') {
      all = true
      continue
    }
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--keys-only') {
      keysOnly = true
      continue
    }
    return `unknown argument ${JSON.stringify(arg)}`
  }
  return { hermesHome, dshHome, all, dryRun, keysOnly, model, api }
}

/**
 * Resolve a `~`-relative or relative directory to an absolute path.
 * @param value - path as typed.
 * @returns the absolute path.
 */
export function expandHome(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed)
}

/**
 * Parse a `.env` file into key/value entries.
 * @param text - the file's contents.
 * @returns every non-comment assignment, in file order.
 */
export function parseEnvFile(text: string): EnvEntry[] {
  const entries: EnvEntry[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key.length === 0 || value.length === 0) continue
    entries.push({ key, value })
  }
  return entries
}

/**
 * The connection implied by one imported key: the pi-ai catalog maps a provider's
 * environment names to its default endpoint, so a key plus that endpoint is a whole
 * connection. Returns undefined when no provider owns the key or the provider declares
 * no fixed endpoint (region- or resource-based ones do not).
 * @param key - credential reference, as it appears in the Hermes `.env`.
 * @param model - optional model id applied to a `pi-ai` connection.
 * @param api - optional wire protocol applied to a `pi-ai` connection.
 * @returns the connection, or undefined.
 */
export function connectionForKey(key: string, model?: string, api?: string): Connection | undefined {
  for (const [provider, data] of Object.entries(PROVIDER_DATA)) {
    if (data === undefined || !data.env.includes(key) || data.defaultBaseURL === undefined) continue
    return {
      name: provider,
      baseURL: data.defaultBaseURL,
      apiKeyEnv: key,
      route: provider === 'deepseek' ? 'deepseek' : 'pi-ai',
      ...model === undefined ? {} : { model },
      ...api === undefined ? {} : { api },
    }
  }
  return undefined
}

/** Ask one question on stdin with a default. */
async function ask(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolveQuestion) => {
      rl.question(question, resolveQuestion)
    })
    const trimmed = answer.trim()
    return trimmed.length === 0 ? fallback : trimmed
  } finally {
    rl.close()
  }
}

/**
 * Run the import.
 * @param argv - arguments after the script name.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv)
  if (typeof options === 'string') {
    process.stderr.write(`import-hermes-credentials: ${options}\n`)
    return 1
  }
  const defaultHermes = join(homedir(), '.hermes')
  let hermesHome = options.hermesHome === undefined ? undefined : expandHome(options.hermesHome)
  if (hermesHome === undefined) {
    const answer = await ask(`Hermes install directory [${defaultHermes}]: `, defaultHermes)
    hermesHome = expandHome(answer)
  }
  const envPath = join(hermesHome, '.env')
  if (!existsSync(envPath)) {
    process.stderr.write(`import-hermes-credentials: no .env at ${envPath}\n`)
    return 1
  }
  const entries = parseEnvFile(readFileSync(envPath, 'utf8'))
  const selected = options.all ? entries : entries.filter(entry => CREDENTIAL_KEY.test(entry.key))
  if (selected.length === 0) {
    process.stdout.write('import-hermes-credentials: no credential entries found\n')
    return 0
  }
  const skipped = entries.length - selected.length
  process.stdout.write(`Hermes home:  ${hermesHome}\n`)
  process.stdout.write(`DSH home:    ${options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')}\n`)
  process.stdout.write(`Importing ${selected.length} credential${selected.length === 1 ? '' : 's'}`
    + `${skipped === 0 ? '' : ` (skipping ${skipped} non-credential)`}\n`)
  for (const entry of selected) {
    if (!options.dryRun) await storeConnectionKey(entry.key, entry.value, options.dshHome)
    process.stdout.write(`  ${options.dryRun ? 'would import' : 'imported'} ${entry.key}\n`)
  }
  if (options.keysOnly) return 0

  // A recognised provider key plus its catalog endpoint is already a connection.
  const path = resolveConnectionsPath(options.dshHome)
  const document = options.dryRun ? { version: 1, connections: [] } : await readConnections(path)
  const byName = new Map(document.connections.map(connection => [connection.name, connection]))
  let added = 0
  for (const entry of selected) {
    const connection = connectionForKey(entry.key, options.model, options.api)
    if (connection === undefined) continue
    if (!options.dryRun) byName.set(connection.name, connection)
    added++
    process.stdout.write(`  ${options.dryRun ? 'would add' : 'added'} connection ${connection.name}`
      + ` (${connection.route}, ${connection.baseURL})\n`)
  }
  if (added > 0 && !options.dryRun) {
    await writeConnections(path, { version: document.version, connections: [...byName.values()] })
  }
  if (added === 0) process.stdout.write('  no recognised provider keys; no connections added\n')
  return 0
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
