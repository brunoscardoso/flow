// Feature ports feed (plan `diagram-entry-exit` phase 3).
//
// Runs the bundled CLI `blueprint features ports --feature <ref> --target
// <root> --json` and relays its one JSON line to the board. The CLI is the one
// reader of connections (allowed-pattern #14) — main narrows the answer's
// shape and keeps one run per root + feature until that root changes.
//
// FAIL-SOFT: a missing CLI, a timeout, a non-JSON answer or a refusal all
// become `{ ports: null, reason, sentence }` with one sentence for the reader.
// It never throws and never blocks the main process (allowed-pattern #19).
import { runBundledCliCapturing } from '../agent/learn-session'
import type { BundledCli } from './derive-runner'
import type { FeaturePorts, FeaturePortsAnswer, FeaturePortsUnavailable } from '../../shared/ipc-contract'

/** A ports read is a few file reads; this is the ceiling. */
export const FEATURE_PORTS_TIMEOUT_MS = 15_000

const PORTS_ACTION = 'features-ports'
const UNAVAILABLE_REASON = 'unavailable'
const UNAVAILABLE_SENTENCE = "Flow couldn't read what connects to this feature."

/**
 * THE VERB'S REFUSALS, IN THE READER'S WORDS. The CLI's sentence carries the
 * ref, a path or a flag — none of that belongs on the board (forbidden-pattern
 * #12). Each known reason gets one fixed sentence; any other is the generic one.
 */
const REFUSAL_SENTENCES: ReadonlyMap<string, string> = new Map([
  ['unknown-feature', "Flow couldn't find this feature any more."],
  ['arguments', 'Pick one feature to see what connects to it.'],
  ['no-workspace', "This project isn't in a Workspace yet."],
  ['unknown-workspace', "Flow couldn't find this project's Workspace."],
  ['which-workspace', "Flow can't tell which Workspace this project belongs to."],
  ['unknown-project', "This project isn't listed in its Workspace."],
  ['malformed-workspace', "This project's Workspace can't be read right now."],
  ['malformed-local-map', "Flow couldn't read where this computer keeps its projects."],
  ['not-a-git-repo', "Flow couldn't find this project."],
])

export interface FeaturePortsRequest {
  rootId: string
  feature: string
}

export interface FeaturePortsDeps {
  bundledCli: BundledCli | null | undefined
  run?: typeof runBundledCliCapturing
}

function unavailable(reason: string, sentence: string): FeaturePortsUnavailable {
  return { ports: null, reason, sentence }
}

/** A refusal reason in the reader's words — never the CLI's own sentence. */
export function refusalSentence(reason: string): string {
  return REFUSAL_SENTENCES.get(reason) ?? UNAVAILABLE_SENTENCE
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const PORT_SIDES = ['in', 'out', 'linked'] as const

/** The minimal shape check: a result carries its three sides, a refusal its reason. */
function asAnswer(value: unknown): FeaturePortsAnswer | null {
  if (!isRecord(value) || value.action !== PORTS_ACTION) return null
  if (typeof value.refused === 'string') return unavailable(value.refused, refusalSentence(value.refused))
  if (typeof value.feature !== 'string' || !PORT_SIDES.every((side) => Array.isArray(value[side]))) return null
  const more = isRecord(value.more) ? value.more : {}
  return {
    ...(value as unknown as FeaturePorts),
    more: {
      in: typeof more.in === 'number' ? more.in : 0,
      out: typeof more.out === 'number' ? more.out : 0,
      linked: typeof more.linked === 'number' ? more.linked : 0,
    },
    unreadableLinks: typeof value.unreadableLinks === 'number' ? value.unreadableLinks : 0,
  }
}

/** The LAST stdout line that parses as a `features-ports` answer — noise before it is ignored. */
export function parseFeaturePortsStdout(stdout: string): FeaturePortsAnswer | null {
  const lines = stdout.split('\n').map((line) => line.trim())
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      // Not JSON after all — keep scanning upward for the answer line.
      continue
    }
    const answer = asAnswer(parsed)
    if (answer !== null) return answer
  }
  return null
}

/** Read one feature's (or part's) ports. Never throws. */
export async function runFeaturePorts(deps: FeaturePortsDeps, request: FeaturePortsRequest): Promise<FeaturePortsAnswer> {
  const feature = request.feature.trim()
  if (feature === '') return unavailable('arguments', refusalSentence('arguments'))
  if (!deps.bundledCli) return unavailable(UNAVAILABLE_REASON, UNAVAILABLE_SENTENCE)

  const run = deps.run ?? runBundledCliCapturing
  const args = ['blueprint', 'features', 'ports', '--feature', feature, '--target', request.rootId, '--json']
  let result: Awaited<ReturnType<typeof runBundledCliCapturing>>
  try {
    result = await run(deps.bundledCli, request.rootId, args, { timeoutMs: FEATURE_PORTS_TIMEOUT_MS })
  } catch (error) {
    // The default runner never rejects; an injected one might. Log, then answer.
    console.warn('[featurePorts] run failed:', error)
    return unavailable(UNAVAILABLE_REASON, UNAVAILABLE_SENTENCE)
  }
  return parseFeaturePortsStdout(result.stdout) ?? unavailable(UNAVAILABLE_REASON, UNAVAILABLE_SENTENCE)
}

/**
 * One run per root + feature, shared by concurrent asks and kept until the
 * root's next change. A failed read is not kept — the next ask tries again.
 */
export function createFeaturePortsCache(read: (request: FeaturePortsRequest) => Promise<FeaturePortsAnswer>) {
  const byRoot = new Map<string, Map<string, Promise<FeaturePortsAnswer>>>()
  return {
    get(request: FeaturePortsRequest): Promise<FeaturePortsAnswer> {
      let entries = byRoot.get(request.rootId)
      if (entries === undefined) {
        entries = new Map()
        byRoot.set(request.rootId, entries)
      }
      const cached = entries.get(request.feature)
      if (cached !== undefined) return cached
      const owner = entries
      const pending = read(request).then((answer) => {
        if ('ports' in answer && answer.reason === UNAVAILABLE_REASON && owner.get(request.feature) === pending) {
          owner.delete(request.feature)
        }
        return answer
      })
      entries.set(request.feature, pending)
      return pending
    },
    clear(rootId: string): void {
      byRoot.delete(rootId)
    },
  }
}
