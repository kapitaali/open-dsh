/**
 * Type declarations for the JavaScript merge module used by
 * scripts/refresh-connection-catalog.ts. A .mjs file has no inferred types
 * under this repo's strict tsconfig, so its exported functions are
 * declared here. No runtime behaviour changes.
 */

export interface MergeResult {
  profile: string
  connection: string
  status: 'skip' | 'unchanged' | 'updated' | 'would-update'
  reason?: string
  models?: number
  added?: number
  removed?: number
}

export interface MergeConnectionLike {
  name: string
  baseURL: string
  apiKeyEnv: string
  api?: string
  models?: readonly string[]
  model?: string
  contextWindow?: number
  reasoningEfforts?: Record<string, unknown>
}

export function dshHomePath(): string

export function listProfilesUsingConnection(
  connection: MergeConnectionLike,
  home?: string,
): Promise<string[]>

export function mergeConnectionModels(
  profile: string,
  connection: MergeConnectionLike,
  home?: string,
  dryRun?: boolean,
  replace?: boolean,
): Promise<MergeResult>
