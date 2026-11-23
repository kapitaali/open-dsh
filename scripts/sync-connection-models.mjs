/**
 * Merge a stored connection's model catalog into a profile's pi-ai provider
 * route without changing that profile's default model.
 *
 * Companion to scripts/refresh-connection-catalog.ts: refresh discovers ids and
 * writes connections.yaml; this module copies those ids into the profile patch.
 * It only replaces the `models` array of the named provider. The
 * `agent-default-model` row is never touched.
 *
 * Run standalone (from the DSH checkout so package imports resolve):
 *   node scripts/sync-connection-models.mjs \
 *     --profile web --connection nous [--dry-run]
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM does not honour NODE_PATH. Anchor package resolution at apps/cli, whose
// node_modules contains the DSH workspace links and yaml in this checkout.
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const requireFromCli = createRequire(join(repoRoot, 'apps/cli/package.json'))
const { isMap, isSeq, parseDocument, stringify } = requireFromCli('yaml')
const { readConnections, resolveConnectionsPath } = requireFromCli('@deepseek-ai/dsh-connection-store')
const { withFileLock, writeFileAtomic } = requireFromCli('@deepseek-ai/dsh-atomic-write')

const PI_AI_ROW = 'llm-pi-ai'
const PI_AI_PACKAGE = '@deepseek-ai/dsh-llm-pi-ai'
const PROFILE_PATCH = 'cordis.patch.yml'

/** DSH home from the environment, with the standard default. */
export function dshHomePath() {
  return process.env.DSH_HOME === undefined || process.env.DSH_HOME === ''
    ? join(homedir(), '.dsh')
    : process.env.DSH_HOME
}

function profilePatchPath(profile, home) {
  return join(home, 'profiles', profile, PROFILE_PATCH)
}

function findRowIndex(document, id) {
  const contents = document.contents
  if (!isSeq(contents)) return -1
  return contents.items.findIndex(item => isMap(item) && item.get('id') === id)
}

/** Whether a connection points at OpenRouter's API host. */
function isOpenRouter(connection) {
  try {
    return ['openrouter.ai', 'www.openrouter.ai'].includes(new URL(connection.baseURL).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** Read per-model reasoning profiles from the OpenRouter health sidecar. */
async function readOpenRouterReasoning(home) {
  try {
    const parsed = JSON.parse(await readFile(join(home, 'model-health', 'openrouter.json'), 'utf8'))
    if (!parsed || (parsed.version !== 1 && parsed.version !== 2) || !parsed.models || typeof parsed.models !== 'object') return {}
    const out = {}
    for (const [id, entry] of Object.entries(parsed.models)) {
      if (!entry || typeof entry !== 'object') continue
      out[id] = entry.reasoning === false ? false : entry.reasoning && typeof entry.reasoning === 'object' ? entry.reasoning : false
    }
    return out
  } catch {
    return {}
  }
}

/** Build model entries in the same shape as applyPiAiConnection. */
function modelList(connection, reasoning = {}) {
  const ids = connection.models?.length > 0
    ? connection.models
    : connection.model === undefined ? [] : [connection.model]
  const perModel = isOpenRouter(connection) ? reasoning : {}
  return ids.map(id => ({
    id,
    name: id,
    ...(connection.contextWindow === undefined ? {} : { contextWindow: connection.contextWindow }),
    ...(Object.prototype.hasOwnProperty.call(perModel, id)
      ? { reasoningEfforts: perModel[id] }
      : connection.reasoningEfforts === undefined ? {} : { reasoningEfforts: connection.reasoningEfforts }),
  }))
}

function existingIds(document, path) {
  const node = document.getIn([...path], true)
  if (!isSeq(node)) return []
  return node.items
    .map(item => isMap(item) ? String(item.get('id') ?? '') : '')
    .filter(Boolean)
}

/**
 * Merge one connection's models into one profile's provider route.
 * Returns a status record; dry-run makes no write. Never changes defaults.
 */
export async function mergeConnectionModels(profile, connection, home = dshHomePath(), dryRun = false, replace = false) {
  const patchPath = profilePatchPath(profile, home)
  if (!existsSync(patchPath)) {
    return { profile, connection: connection.name, status: 'skip', reason: 'no profile patch' }
  }
  const text = await readFile(patchPath, 'utf8')
  const document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }],
    maxAliasCount: 100000,
  })
  if (document.errors[0] !== undefined) throw document.errors[0]
  const row = findRowIndex(document, PI_AI_ROW)
  if (row < 0) {
    return { profile, connection: connection.name, status: 'skip', reason: 'no llm-pi-ai row' }
  }
  const packageName = document.getIn([row, 'name'])
  if (packageName !== PI_AI_PACKAGE) {
    return { profile, connection: connection.name, status: 'skip', reason: 'llm-pi-ai row name mismatch' }
  }
  const providerPath = [row, 'config', 'providers', connection.name]
  const provider = document.getIn(providerPath, true)
  if (provider === undefined) {
    return { profile, connection: connection.name, status: 'skip', reason: 'provider not configured in profile' }
  }

  const reasoning = isOpenRouter(connection) ? await readOpenRouterReasoning(home) : {}
  const desired = modelList(connection, reasoning)
  const modelsNode = document.getIn([...providerPath, 'models'], true)
  const existingModels = isSeq(modelsNode)
    ? modelsNode.items.map(item => isMap(item) ? item.toJS(document) : null).filter(Boolean)
    : []
  const before = existingIds(document, [...providerPath, 'models'])
  const desiredIds = desired.map(model => String(model.id))
  // Additive by default: keep profile ids the refreshed endpoint did not list.
  // --replace makes the refreshed catalog authoritative and drops stale ids.
  const finalModels = replace
    ? desired
    : [...desired, ...existingModels.filter(model => !desiredIds.includes(String(model.id ?? '')))]
  const afterIds = finalModels.map(model => String(model.id ?? ''))
  const added = afterIds.filter(id => !before.includes(id))
  const removed = before.filter(id => !afterIds.includes(id))
  if (added.length === 0 && removed.length === 0) {
    return { profile, connection: connection.name, status: 'unchanged', models: afterIds.length }
  }

  if (!dryRun) {
    document.setIn([...providerPath, 'models'], document.createNode(finalModels))
    await withFileLock(patchPath, async () => {
      await writeFileAtomic(patchPath, stringify(document, { aliasDuplicateObjects: false, lineWidth: -1 }), { mode: 0o600 })
    })
  }
  return {
    profile,
    connection: connection.name,
    status: dryRun ? 'would-update' : 'updated',
    models: afterIds.length,
    added: added.length,
    removed: removed.length,
  }
}

async function main(argv) {
  const profiles = []
  const connections = []
  let dryRun = false
  let replace = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--profile' || arg === '--connection') {
      const value = argv[index + 1]
      if (value === undefined) {
        process.stderr.write(`${arg} needs a name\n`)
        return 1
      }
      ;(arg === '--profile' ? profiles : connections).push(value)
      index++
      continue
    }
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--replace') { replace = true; continue }
    if (arg.startsWith('--')) {
      process.stderr.write(`unknown argument ${arg}\n`)
      return 1
    }
  }
  if (profiles.length === 0 || connections.length === 0) {
    process.stderr.write('usage: --profile <name> [--profile <name>…]'
      + ' --connection <name> [--connection <name>…] [--dry-run] [--replace]\n')
    return 1
  }
  const home = dshHomePath()
  const store = await readConnections(resolveConnectionsPath(home))
  for (const name of connections) {
    const connection = store.connections.find(item => item.name === name)
    if (connection === undefined) {
      process.stdout.write(`  ${name}: no such connection; skipped\n`)
      continue
    }
    for (const profile of profiles) {
      const result = await mergeConnectionModels(profile, connection, home, dryRun, replace)
      process.stdout.write(`  ${profile}/${name}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`
        + `${result.models === undefined ? '' : ` models=${result.models}`}`
        + `${result.added === undefined ? '' : ` added=${result.added} removed=${result.removed}`}\n`)
    }
  }
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
