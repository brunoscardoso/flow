// Feature home writer (plan `feature-home-folders`, FR-10).
//
// Runs the bundled CLI's `blueprint features home --feature <ref>
// (--folder <path> | --clear) --json` in the root's checkout — the ONE writer
// of the person-owned `home:` key (allowed-pattern #14). Main only relays the
// verb's one JSON line: a success says the home now pinned, a refusal says its
// reason code and the folder it named. The CLI's own sentence is never relayed
// — it names flags (forbidden-pattern #12); the board words the refusal.
//
// Async with a timeout, never execSync (allowed-pattern #19). Never throws.
import { runBundledCliCapturing } from '../agent/learn-session'
import type { BundledCli } from './derive-runner'
import type { BlueprintSetFeatureHomeRequest, BlueprintSetFeatureHomeResult } from '../../shared/ipc-contract'

/** A home write reads the feature store and edits one line; this is the ceiling. */
export const FEATURE_HOME_TIMEOUT_MS = 20_000

const HOME_ACTION = 'features-home'

export interface FeatureHomeDeps {
  bundledCli: BundledCli | null | undefined
  run?: typeof runBundledCliCapturing
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** The LAST stdout line that parses as a `features-home` answer, or null. */
export function parseFeatureHomeStdout(stdout: string, folder: string | null): BlueprintSetFeatureHomeResult | null {
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
    if (!isRecord(parsed) || parsed.action !== HOME_ACTION) continue
    if (typeof parsed.refused === 'string') {
      return { ok: false, reason: parsed.refused, folder: stringOrNull(parsed.folder) ?? folder }
    }
    return { ok: true, home: stringOrNull(parsed.home), previous: stringOrNull(parsed.previous) }
  }
  return null
}

/** Pin (or clear) a home. Never throws. */
export async function runFeatureHome(
  deps: FeatureHomeDeps,
  request: BlueprintSetFeatureHomeRequest,
): Promise<BlueprintSetFeatureHomeResult> {
  const ref = request.featureRef.trim()
  const folder = typeof request.folder === 'string' ? request.folder.trim() : null
  const clear = request.clear === true
  // EXACTLY ONE OF THE TWO, checked here too: an ask with both or neither is a
  // caller's bug, refused before a child is spawned for it.
  if (ref === '' || (folder === null) === !clear) return { ok: false, reason: 'arguments', folder }
  if (!deps.bundledCli) return { ok: false, reason: 'unavailable', folder }
  const run = deps.run ?? runBundledCliCapturing
  const args = ['blueprint', 'features', 'home', '--feature', ref, ...(clear ? ['--clear'] : ['--folder', folder ?? '']), '--json']
  let result: Awaited<ReturnType<typeof runBundledCliCapturing>>
  try {
    result = await run(deps.bundledCli, request.rootId, args, { timeoutMs: FEATURE_HOME_TIMEOUT_MS })
  } catch (error) {
    // The default runner never rejects; an injected one might. Log, then answer.
    console.warn('[featureHome] run failed:', error)
    return { ok: false, reason: 'unavailable', folder }
  }
  const answer = parseFeatureHomeStdout(result.stdout, folder)
  if (answer !== null) return answer
  return { ok: false, reason: result.error === 'timed out' ? 'timed out' : 'unavailable', folder }
}
