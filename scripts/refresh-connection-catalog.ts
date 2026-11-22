/**
 * Refresh the model catalog of connection endpoints, then optionally merge it
 * into profile provider routes.
 *
 * Each connection names an endpoint and a credential reference. This step asks
 * that endpoint which models it advertises (`GET {baseURL}/models`, or the
 * protocol's native listing) and stores the ids on the connection, so
 * `dsh connection use` can write them into the profile's provider route.
 *
 * OpenRouter connections use an account-aware, capability-filtered listing:
 * `/models/user` when a key is available, with `/models` as a public fallback;
 * models without the DSH wire endpoint or tools are dropped, and a cached
 * per-model `/endpoints` health check removes models with no healthy provider.
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

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

/** Counts from the OpenRouter catalog eligibility filter. */
export interface OpenRouterMetadataReport {
  readonly total: number
  readonly kept: number
  readonly dropped: Readonly<Record<string, number>>
}

/** Counts from the OpenRouter per-model endpoint health check. */
export interface OpenRouterHealthReport {
  readonly kept: number
  readonly dropped: number
  readonly unknown: number
  readonly cacheHits: number
  readonly requests: number
}

/** One cached health decision. */
interface HealthEntry {
  readonly checkedAt: number
  readonly eligible: boolean
  readonly reason?: string
}

/** Versioned health cache, stored outside the repo under the DSH home. */
interface HealthCache {
  readonly version: 1
  readonly models: Record<string, HealthEntry>
}

const OPENROUTER_HOSTS = new Set(['openrouter.ai', 'www.openrouter.ai'])
const OPENROUTER_PAGE_SIZE = 1000
const OPENROUTER_MAX_PAGES = 5
const HEALTH_TTL_MS = 6 * 60 * 60 * 1000
const HEALTH_UPTIME_MIN = 95
const HEALTH_CONCURRENCY = 8

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function stringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function bump(target: Record<string, number>, reason: string): void {
  target[reason] = (target[reason] ?? 0) + 1
}

/**
 * Whether a connection points at OpenRouter's API host.
 * @param connection - connection whose base URL is checked.
 * @returns true only for OpenRouter hosts; gateway aliases keep the generic path.
 */
export function isOpenRouterConnection(connection: Connection): boolean {
  try {
    return OPENROUTER_HOSTS.has(new URL(connection.baseURL).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** Wire endpoint OpenRouter must serve for this connection's pi-ai protocol. */
function wireEndpoint(connection: Connection): string {
  return connection.api === 'anthropic-messages' ? '/api/v1/messages' : '/api/v1/chat/completions'
}

/** JSON GET with the key scoped to this request only. */
async function getJson(url: string, apiKey: string | undefined, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey !== undefined) headers.authorization = `Bearer ${apiKey}`
  const response = await fetchImpl(url, { headers })
  if (!response.ok) throw new Error(`HTTP ${response.status}${response.statusText === '' ? '' : ` ${response.statusText}`}`)
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error('listing response is not an object')
  return body
}

/**
 * Ask the account-aware listing first, falling back to the public catalog.
 * Errors mention only status, never the credential.
 */
async function getCatalogPage(
  params: URLSearchParams,
  connection: Connection,
  apiKey: string | undefined,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const base = connection.baseURL.replace(/\/+$/u, '')
  if (apiKey !== undefined) {
    try {
      return await getJson(`${base}/models/user?${params.toString()}`, apiKey, fetchImpl)
    } catch {
      // A stale or restricted key must not block a public capability listing.
    }
  }
  return await getJson(`${base}/models?${params.toString()}`, apiKey, fetchImpl)
}

/** Local rejection reason for one OpenRouter catalog row. */
function rejectReason(row: unknown, id: string, endpoint: string, now: number): string | undefined {
  if (!isRecord(row)) return 'invalid-row'
  if (id.endsWith(':batch')) return 'batch'
  const pricing = row.pricing
  if (isRecord(pricing)) {
    const prompt = numeric(pricing.prompt)
    if (prompt !== undefined && prompt < 0) return 'dynamic-router'
  }
  const rawExpiry = row.expiration_date
  const parsedExpiry = typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : numeric(rawExpiry)
  const expiry = parsedExpiry !== undefined && Math.abs(parsedExpiry) < 1e12 ? parsedExpiry * 1000 : parsedExpiry
  if (expiry !== undefined && Number.isFinite(expiry) && expiry <= now) return 'expired'
  const architecture = row.architecture
  if (isRecord(architecture)) {
    const outputs = stringList(architecture.output_modalities)
    if (outputs !== undefined && !outputs.includes('text')) return 'non-text-output'
  }
  const endpoints = stringList(row.endpoints)
  if (endpoints !== undefined && !endpoints.includes(endpoint)) return 'wrong-endpoint'
  const parameters = stringList(row.supported_parameters)
  if (parameters !== undefined && !parameters.includes('tools')) return 'no-tools'
  return undefined
}

/**
 * Discover capability-eligible OpenRouter model ids.
 * @param connection - the OpenRouter connection.
 * @param apiKey - optional stored key for `/models/user`.
 * @param fetchImpl - fetch implementation, injectable for tests.
 * @param now - clock, injectable for expiry checks.
 * @returns eligible ids and rejection counts.
 */
export async function discoverOpenRouterModels(
  connection: Connection,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
  now: number = Date.now(),
): Promise<{ ids: readonly string[]; report: OpenRouterMetadataReport }> {
  const endpoint = wireEndpoint(connection)
  const rows: unknown[] = []
  let total: number | undefined
  for (let page = 0; page < OPENROUTER_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      output_modalities: 'text',
      endpoints: endpoint,
      supported_parameters: 'tools',
      limit: String(OPENROUTER_PAGE_SIZE),
      offset: String(page * OPENROUTER_PAGE_SIZE),
    })
    const body = await getCatalogPage(params, connection, apiKey, fetchImpl)
    const data = Array.isArray(body.data) ? body.data : []
    rows.push(...data)
    total = numeric(body.total_count)
    if (data.length < OPENROUTER_PAGE_SIZE || (total !== undefined && rows.length >= total)) break
  }
  const dropped: Record<string, number> = {}
  const ids: string[] = []
  for (const row of rows) {
    const id = isRecord(row) && typeof row.id === 'string' && row.id.length > 0 ? row.id : ''
    if (id === '') {
      bump(dropped, 'invalid-id')
      continue
    }
    const reason = rejectReason(row, id, endpoint, now)
    if (reason !== undefined) {
      bump(dropped, reason)
      continue
    }
    ids.push(id)
  }
  return { ids, report: { total: total ?? rows.length, kept: ids.length, dropped } }
}

/** Cache path for one DSH home. */
export function openRouterHealthCachePath(home: string): string {
  return join(home, 'model-health', 'openrouter.json')
}

async function readHealthCache(home: string): Promise<HealthCache> {
  const empty: HealthCache = { version: 1, models: {} }
  try {
    const parsed: unknown = JSON.parse(await readFile(openRouterHealthCachePath(home), 'utf8'))
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.models)) return empty
    const models: Record<string, HealthEntry> = {}
    for (const [id, value] of Object.entries(parsed.models)) {
      if (!isRecord(value) || typeof value.eligible !== 'boolean') continue
      const checkedAt = numeric(value.checkedAt)
      if (checkedAt === undefined) continue
      models[id] = typeof value.reason === 'string'
        ? { checkedAt, eligible: value.eligible, reason: value.reason }
        : { checkedAt, eligible: value.eligible }
    }
    return { version: 1, models }
  } catch {
    return empty
  }
}

async function writeHealthCache(home: string, cache: HealthCache): Promise<void> {
  const path = openRouterHealthCachePath(home)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(cache, undefined, 2)}\n`, { mode: 0o600 })
}

/** URL for one model's provider endpoint listing. */
function modelEndpointsUrl(connection: Connection, id: string): string {
  const base = connection.baseURL.replace(/\/+$/u, '')
  const segments = id.split('/').map(segment => encodeURIComponent(segment)).join('/')
  return `${base}/models/${segments}/endpoints`
}

function endpointHealthy(value: unknown): boolean {
  if (!isRecord(value) || numeric(value.status) !== 0) return false
  const parameters = stringList(value.supported_parameters)
  if (parameters === undefined || !parameters.includes('tools')) return false
  const toolChoice = value.supports_tool_choice
  if (isRecord(toolChoice) && !Object.values(toolChoice).some(item => item === true)) return false
  const uptime = numeric(value.uptime_last_1d) ?? numeric(value.uptime_last_5m)
  if (uptime !== undefined && uptime < HEALTH_UPTIME_MIN) return false
  return true
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, operation: (item: T) => Promise<R>): Promise<readonly R[]> {
  const results: { index: number; value: R }[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) continue
      results.push({ index, value: await operation(item) })
    }
  })
  await Promise.all(workers)
  return results.sort((left, right) => left.index - right.index).map(result => result.value)
}

/**
 * Filter ids through a cached per-model provider health check.
 * Endpoint API failures keep the id and are reported as unknown.
 */
export async function filterHealthyOpenRouterModels(
  ids: readonly string[],
  connection: Connection,
  apiKey: string | undefined,
  home: string,
  dryRun: boolean,
  fetchImpl: typeof fetch = globalThis.fetch,
  now: number = Date.now(),
): Promise<{ ids: readonly string[]; report: OpenRouterHealthReport }> {
  const cache = await readHealthCache(home)
  const decisions: Record<string, HealthEntry> = { ...cache.models }
  let cacheHits = 0
  let requests = 0
  let unknown = 0
  const stale = ids.filter((id) => {
    const entry = decisions[id]
    if (entry !== undefined && now - entry.checkedAt <= HEALTH_TTL_MS) {
      cacheHits++
      return false
    }
    return true
  })
  await mapWithConcurrency(stale, HEALTH_CONCURRENCY, async (id) => {
    requests++
    try {
      const body = await getJson(modelEndpointsUrl(connection, id), apiKey, fetchImpl)
      const payload = isRecord(body.data) ? body.data : body
      const endpoints = Array.isArray(payload.endpoints) ? payload.endpoints : []
      const eligible = endpoints.some(endpointHealthy)
      decisions[id] = eligible
        ? { checkedAt: now, eligible: true }
        : { checkedAt: now, eligible: false, reason: 'no-healthy-endpoint' }
    } catch {
      unknown++
      // A transient endpoint-listing failure must not delete a usable model.
    }
  })
  const eligibleIds = ids.filter(id => decisions[id]?.eligible !== false)
  const dropped = ids.length - eligibleIds.length
  if (!dryRun && requests > 0) await writeHealthCache(home, { version: 1, models: decisions })
  return {
    ids: eligibleIds,
    report: { kept: eligibleIds.length, dropped, unknown, cacheHits, requests },
  }
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

function reportOpenRouter(metadata: OpenRouterMetadataReport, health: OpenRouterHealthReport): string {
  const reasons = Object.entries(metadata.dropped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(',')
  return ` openrouter total=${metadata.total} metadata_kept=${metadata.kept}`
    + `${reasons === '' ? '' : ` dropped[${reasons}]`}`
    + ` health_kept=${health.kept} health_dropped=${health.dropped}`
    + ` health_unknown=${health.unknown} health_cache_hits=${health.cacheHits}`
    + ` health_requests=${health.requests}`
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
    const openRouter = options.source === 'endpoint' && isOpenRouterConnection(connection)
    const apiKey = await readConnectionKey(connection.apiKeyEnv, options.dshHome)
    if (apiKey === undefined && !openRouter) {
      process.stdout.write(`  ${connection.name}: no stored ${connection.apiKeyEnv}; skipped\n`)
      continue
    }
    let ids: readonly string[]
    let filterNote = ''
    try {
      if (openRouter) {
        const discovered = await discoverOpenRouterModels(connection, apiKey)
        const healthy = await filterHealthyOpenRouterModels(discovered.ids, connection, apiKey, home, options.dryRun)
        ids = healthy.ids
        filterNote = reportOpenRouter(discovered.report, healthy.report)
      } else {
        ids = await discoverForConnection(connection, options.source, apiKey as string)
      }
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
    process.stdout.write(`  ${connection.name}: ${ids.length} models from ${options.source === 'catalog' ? 'catalog' : connection.baseURL}${added}${filterNote}\n`)
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
  process.stdout.write(`updated ${refreshed} of ${targets.length} connection${refreshed === 1 ? '' : 's'}\n`)
  return 0
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
