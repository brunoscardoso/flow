// One feature's recorded couplings, with the store's own words.
//
// Runs the bundled CLI `blueprint features relations --feature <ref>` and
// parses stdout into a BlueprintFeatureRelationsResult the connections panel
// renders. Mirrors feature-map-runner: captures STDOUT, FAIL-SOFT on every
// path — a missing CLI, a refusal line, a timeout or unparseable output all
// yield `available: false` with a one-line reason, so the surface says it
// could not read rather than that there is nothing to read.
//
// WHY A SEPARATE CHANNEL FROM `blueprint:featureGraph`. The graph carries the
// SHAPE of a relation and nothing else, on purpose — `via` and `note` "are for
// a reader of the FEATURE, and the graph is a shape". This is that reader,
// asking about one feature.
import { spawn } from 'child_process'

import type { BundledCli } from './derive-runner'
import type {
  BlueprintFeatureRelation,
  BlueprintFeatureRelationsResult,
} from '../../shared/ipc-contract'

const RELATIONS_TIMEOUT_MS = 30_000

function unavailable(reason: string): BlueprintFeatureRelationsResult {
  return { available: false, reason, feature: '', name: '', relations: [] }
}

/**
 * Narrow the CLI's JSON to the contract shape.
 *
 * A ROW WITHOUT A TARGET IS DROPPED, not passed through with a blank: the
 * panel makes every row clickable, and a row that navigates nowhere is the
 * dead control this app keeps being corrected for. `via` and `note` are
 * genuinely optional — plenty of edges were recorded as a bare target — and
 * their absence is rendered as absence, never as an invented sentence.
 */
export function parseRelationsJson(stdout: string): BlueprintFeatureRelationsResult {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return unavailable('no output')
  // The verb's refusals are one-line prose (`features refused: …`).
  if (!trimmed.startsWith('{')) return unavailable(trimmed.split('\n')[0] ?? 'features refused')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return unavailable('unparseable relations output')
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.feature !== 'string' || obj.feature.length === 0) {
    return unavailable('relations output names no feature')
  }
  const relations: BlueprintFeatureRelation[] = []
  for (const raw of Array.isArray(obj.relations) ? obj.relations : []) {
    const row = raw as Record<string, unknown>
    if (typeof row.target !== 'string' || row.target.length === 0) continue
    relations.push({
      target: row.target,
      name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.target,
      ...(typeof row.via === 'string' && row.via.length > 0 ? { via: row.via } : {}),
      ...(typeof row.note === 'string' && row.note.length > 0 ? { note: row.note } : {}),
      stale: row.stale === true,
    })
  }
  return {
    available: true,
    reason: null,
    feature: obj.feature,
    name: typeof obj.name === 'string' ? obj.name : obj.feature,
    relations,
  }
}

/** Read one feature's relations. Fail-soft — never throws. */
export function runFeatureRelations(
  bundledCli: BundledCli | null,
  rootPath: string,
  feature: string,
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<BlueprintFeatureRelationsResult> {
  if (bundledCli === null) return Promise.resolve(unavailable('bundled CLI unavailable'))
  if (feature.trim().length === 0) return Promise.resolve(unavailable('no feature named'))
  const spawnFn = deps.spawnFn ?? spawn
  const timeoutMs = deps.timeoutMs ?? RELATIONS_TIMEOUT_MS
  const args = [bundledCli.cliPath, 'blueprint', 'features', 'relations', '--feature', feature]
  return new Promise<BlueprintFeatureRelationsResult>((resolve) => {
    let stdout = ''
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(bundledCli.execPath, args, {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    } catch (error) {
      resolve(unavailable((error as Error).message))
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(unavailable('timed out'))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve(unavailable(error.message))
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(parseRelationsJson(stdout))
    })
  })
}
