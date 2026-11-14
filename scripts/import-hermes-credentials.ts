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
import { storeConnectionKey } from '@deepseek-ai/dsh-connection-store'

/** A key whose value is a secret worth importing. */
const CREDENTIAL_KEY = /_(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i

interface Options {
  readonly hermesHome: string | undefined
  readonly dshHome: string | undefined
  /** Import every `KEY=value` entry, not only credential-shaped names. */
  readonly all: boolean
  /** Report what would be written without touching the credential file. */
  readonly dryRun: boolean
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
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg === '--') continue
    if (arg === '--hermes-home' || arg === '--dsh-home') {
      const value = argv[index + 1]
      if (value === undefined) return `${arg} needs a path`
      if (arg === '--hermes-home') hermesHome = value
      else dshHome = value
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
    return `unknown argument ${JSON.stringify(arg)}`
  }
  return { hermesHome, dshHome, all, dryRun }
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
  return 0
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
