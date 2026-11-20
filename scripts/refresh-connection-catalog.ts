/**
 * Refresh the model catalog of connection endpoints, then optionally merge it
 * into profile provider routes.
 *
 * Each connection names an endpoint and a credential reference. This step asks
 * that endpoint which models it advertises (`GET {baseURL}/models`, or the
 * protocol's native listing) and stores the ids on the connection, so
 * `dsh connection use` can write them into the profile's provider route.
 *
 * With `--profile <name>` (repeatable), this script also merges each refreshed
 * connection's models into that profile's pi-ai provider route, preserving the
 * profile's current default model. The merge is additive by default; pass
 * `--replace` to make the refreshed catalog authoritative and drop stale ids.
 * Without `--profile`, behavior is unchanged: only connections.yaml is written.
 *
 * Catalog routes (nvidia, openrouter, deepseek, …) are answered from the
 * installed pi-ai registry when `--prefer-catalog` is passed; by default the
 * endpoint itself is asked, which is what a gateway or self-hosted server
 * needs. Values and endpoints are reported, never printed secrets.
 *
 * Usage: pnpm run refresh:connections -- [--profile web] [--connection nous] [--dry-run]
 *
 * @module scripts/refresh-connection-catalog
 */

import { readConnections, resolveConnectionsPath, writeConnections, type Connection } from '@deepseek-ai/dsh-connection-store'
import { readConnectionKey } from '@deepseek-ai/dsh-connection-store'
import { discoverModels } from '@deepseek-ai/dsh-llm-pi-ai'
import { dshHomePath, mergeConnectionModels } from './sync-connection-models.mjs'

/** Which listing a refresh asks for. */
type Source = 'endpoint' | 'catalog'

interface Options {
  readonly dshHome: string | undefined
  readonly names: readonly string[]
  readonly profiles: readonly string[]
  readonly source: Source
  /** Report what would change without writing the connection document. */
  readonly dryRun: boolean
  /** Make the refreshed catalog authoritative; default merge is additive. */
  readonly replace: boolean
}

/**
 * Read flags from argv.
 * @param argv - arguments after the script name.
 * @returns the parsed options; unknown flags are an error string.
 */
export function parseArgs(argv: readonly string[]): Options | string {
  let dshHome: string | undefined
  let source: Source = 'endpoint'
  let dryRun = false
  let replace = false
  const names: string[] = []
  const profiles: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--') continue
    if (arg === '--dsh-home') {
      const value = argv[index + 1]
      if (value === undefined) return '--dsh-home needs a path'
      dshHome = value
      index++
      continue
    }
    if (arg === '--profile' || arg === '--connection') {
      const value = argv[index + 1]
      if (value === undefined) return `${arg} needs a name`
      ;(arg === '--profile' ? profiles : names).push(value)
      index++
      continue
    }
    if (arg === '--prefer-catalog') {
      source = 'catalog'
      continue
    }
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--replace') {
      replace = true
      continue
    }
    if (arg.startsWith('--')) return `unknown argument ${JSON.stringify(arg)}`
    names.push(arg)
  }
  return { dshHome, names, profiles, source, dryRun, replace }
}

/**
 * Ask one connection's endpoint for its model ids.
 * @param connection - the connection to refresh.
 * @param source - endpoint listing, or the installed catalog for a known route.
 * @param apiKey - the connection's stored credential.
 * @returns the advertised model ids.
 */
export async function discoverForConnection(
  connection: Connection,
  source: Source,
  apiKey: string | undefined,
): Promise<readonly string[]> {
  const models = await discoverModels({
    ...source === 'catalog' && connection.route === 'pi-ai' ? { provider: connection.name } : {},
    baseURL: connection.baseURL,
    ...connection.api === undefined ? {} : { api: connection.api },
    ...apiKey === undefined ? {} : { apiKey },
  })
  return models.map(model => model.id)
}

/** Report one merge result on stdout. */
interface MergeReport {
  profile: string
  connection: string
  status: string
  reason?: string
  models?: number
  added?: number
  removed?: number
}

function reportMerge(result: MergeReport): void {
  process.stdout.write(`  profile ${result.profile}/${result.connection}: ${result.status}`
    + `${result.reason === undefined ? '' : ` (${result.reason})`}`
    + `${result.models === undefined ? '' : ` models=${result.models}`}`
    + `${result.added === undefined ? '' : ` added=${result.added} removed=${result.removed}`}\n`)
}

/**
 * Run the refresh.
 * @param argv - arguments after the script name.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv)
  if (typeof options === 'string') {
    process.stderr.write(`refresh-connection-catalog: ${options}\n`)
    return 1
  }
  const home = options.dshHome ?? dshHomePath()
  const path = resolveConnectionsPath(options.dshHome)
  const document = await readConnections(path)
  if (document.connections.length === 0) {
    process.stderr.write(`refresh-connection-catalog: no connections in ${path}`
      + ' — run pnpm run setup:hermes, or dsh connection add <name> --url <url>\n')
    return 1
  }
  const targets = options.names.length === 0
    ? document.connections
    : document.connections.filter(connection => options.names.includes(connection.name))
  if (targets.length === 0) {
    process.stderr.write(`refresh-connection-catalog: no matching connection in ${path}\n`)
    return 1
  }
  const next = new Map(document.connections.map(connection => [connection.name, connection]))
  let refreshed = 0
  const refreshedNames: string[] = []
  for (const connection of targets) {
    if (connection.route !== 'pi-ai') {
      process.stdout.write(`  ${connection.name}: route ${connection.route} has no endpoint listing; skipped\n`)
      continue
    }
    const apiKey = await readConnectionKey(connection.apiKeyEnv, options.dshHome)
    if (apiKey === undefined) {
      process.stdout.write(`  ${connection.name}: no stored ${connection.apiKeyEnv}; skipped\n`)
      continue
    }
    let ids: readonly string[]
    try {
      ids = await discoverForConnection(connection, options.source, apiKey)
    } catch (error) {
      process.stdout.write(`  ${connection.name}: listing failed — ${error instanceof Error ? error.message : String(error)}\n`)
      continue
    }
    const updated = connection.reasoningEfforts === undefined
      ? { ...connection, reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } }
      : connection
    next.set(connection.name, { ...updated, models: [...ids] })
    refreshed++
    refreshedNames.push(connection.name)
    const added = connection.reasoningEfforts === undefined ? ' (added default reasoning efforts)' : ''
    process.stdout.write(`  ${connection.name}: ${ids.length} models from ${options.source === 'catalog' ? 'catalog' : connection.baseURL}${added}\n`)
  }

  // Merge into explicitly named profiles. Default model is never touched here.
  const mergeAll = async (dryRun: boolean): Promise<void> => {
    for (const name of refreshedNames) {
      const connection = next.get(name)
      if (connection === undefined) continue
      for (const profile of options.profiles) {
        reportMerge(await mergeConnectionModels(profile, connection, home, dryRun, options.replace))
      }
    }
  }

  if (options.dryRun) {
    await mergeAll(true)
    process.stdout.write(`would update ${refreshed} connection${refreshed === 1 ? '' : 's'} (dry run)\n`)
    return 0
  }
  if (refreshed > 0) await writeConnections(path, { version: document.version, connections: [...next.values()] })
  await mergeAll(false)
  process.stdout.write(`updated ${refreshed} of ${targets.length} connection${targets.length === 1 ? '' : 's'}\n`)
  return 0
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
