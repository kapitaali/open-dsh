/**
 * Watches Hermes `auth.json` and pushes rotating OAuth access tokens into the
 * DSH credential store. `credentials-local` hot-reloads its document and
 * `llm-pi-ai` resolves a credential reference per request, so a write through
 * `ctx.credentials.set` reaches the next model call without a host restart.
 *
 * Event-driven: a file watcher fires when Hermes refreshes a token. No cron,
 * no polling loop, and no manual re-import. Token values are never logged.
 * @module @deepseek-ai/dsh-hermes-token-sync
 */

import { existsSync } from 'node:fs'
import { readFile, watch } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { credentialRef } from '@deepseek-ai/dsh-credentials'

type Z = typeof import('@deepseek-ai/schemastery').default

export const name = 'hermes-token-sync'
export const inject = ['credentials'] as const

export interface Config {
  /** Master switch. */
  enabled: boolean
  /** Hermes install directory. */
  hermesHome: string
  /** Explicit auth.json path; defaults to <hermesHome>/auth.json. */
  authPath?: string
  /** Hermes provider ids to sync; each maps to <NAME>_ACCESS_TOKEN. */
  providers: string[]
  /** Watcher write-settle window in milliseconds. */
  debounceMs: number
}

/** Build the config schema from the runtime schemastery `z`. */
export function makeConfig(z: Z) {
  return z.object({
    enabled: z.boolean().default(true),
    hermesHome: z.string().default('~/.hermes'),
    authPath: z.string(),
    providers: z.array(z.string()).default(['nous']),
    debounceMs: z.number().min(0).default(200),
  })
}

const log = (...args: unknown[]): void => { console.error('[hermes-token-sync]', ...args) }

/** Expand a leading ~ and ${VAR} / ${VAR:-default} in a configured path. */
export function expandPath(p: string): string {
  const home = p.replace(/^~(?=$|\/)/, homedir())
  return home.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g, (m, n: string, d?: string) => {
    const v = process.env[n]
    return v !== undefined && v !== '' ? v : (d ?? m)
  })
}

/** Credential reference for a Hermes provider, matching the import script. */
export function refFor(provider: string): string {
  return `${provider.toUpperCase().replace(/-/g, '_')}_ACCESS_TOKEN`
}

interface CredentialStore {
  resolve(ref: ReturnType<typeof credentialRef>): Promise<{ value: string } | undefined>
  set(ref: ReturnType<typeof credentialRef>, value: string): Promise<void>
}

interface SyncDeps {
  credentials: CredentialStore
  readText: (path: string) => Promise<string>
}

/** One sync pass: read Hermes auth.json and push any rotated token. */
export async function syncOnce(
  config: Config,
  deps: SyncDeps,
  lastSynced: Map<string, string>,
): Promise<void> {
  const authPath = expandPath(config.authPath ?? join(expandPath(config.hermesHome), 'auth.json'))
  let doc: unknown
  try {
    doc = JSON.parse(await deps.readText(authPath))
  } catch (error) {
    log(`cannot read ${authPath}: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const docProviders: unknown = (doc as { providers?: unknown }).providers
  const providers: Record<string, { access_token?: unknown }> = typeof docProviders === 'object' && docProviders !== null
    ? docProviders as Record<string, { access_token?: unknown }>
    : {}
  for (const provider of config.providers.length > 0 ? config.providers : ['nous']) {
    const entry = providers[provider]
    const token: unknown = entry === undefined ? undefined : entry.access_token
    if (typeof token !== 'string' || token.length === 0) continue
    const ref = refFor(provider) as ReturnType<typeof credentialRef>
    if (lastSynced.get(ref) === token) continue
    try {
      const current = await deps.credentials.resolve(ref)
      if (current?.value === token) {
        lastSynced.set(ref, token)
        continue
      }
      await deps.credentials.set(ref, token)
      lastSynced.set(ref, token)
      log(`synced ${ref} from Hermes auth.json (provider ${provider})`)
    } catch (error) {
      log(`failed to sync ${ref}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Plugin entry: watch auth.json and sync on startup and on change. */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  const credentials = ctx.get('credentials') as unknown as CredentialStore | undefined
  if (credentials === undefined) {
    log('credentials service unavailable; not activating')
    return
  }
  const authPath = expandPath(config.authPath ?? join(expandPath(config.hermesHome), 'auth.json'))
  const lastSynced = new Map<string, string>()
  const deps: SyncDeps = { credentials, readText: path => readFile(path, 'utf8') }

  ctx.effect(async () => {
    if (!existsSync(authPath)) {
      log(`no auth.json at ${authPath}; not activating`)
      return () => undefined
    }
    await syncOnce(config, deps, lastSynced)
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const watcher = watch(dirname(authPath), { signal: controller.signal })
    void (async () => {
      try {
        for await (const event of watcher) {
          if (event.filename !== 'auth.json') continue
          if (timer !== undefined) clearTimeout(timer)
          timer = setTimeout(() => void syncOnce(config, deps, lastSynced), config.debounceMs)
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          log(`watcher ended: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()
    log(`watching ${authPath} for [${config.providers.join(', ')}]`)
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
    }
  }, 'hermes-token-sync')
}
