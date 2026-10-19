// Feature code map feed (#1533).
//
// Runs the bundled CLI `blueprint feature-map --feature <ref> --json` and
// parses stdout into a BlueprintFeatureMapResult the opened-feature surface
// can render. Mirrors feature-runner: captures STDOUT, FAIL-SOFT on every
// path — a missing CLI, a refusal line, a timeout or unparseable output all
// yield `available: false` with a one-line reason, so the surface falls back
// to its honest empty state rather than breaking.
import { spawn } from 'child_process'

import type { BundledCli } from './derive-runner'
import type {
  BlueprintFeatureMapEdge,
  BlueprintFeatureMapFile,
  BlueprintFeatureMapResult,
  BlueprintFeatureMapUnresolved,
} from '../../shared/ipc-contract'

const FEATURE_MAP_TIMEOUT_MS = 30_000

function unavailable(reason: string): BlueprintFeatureMapResult {
  return { available: false, reason, feature: '', files: [], edges: [], unresolved: [] }
}

/**
 * Narrow the CLI's JSON to the contract shape. A malformed entry is DROPPED
 * rather than passed through — the same rule as the feature graph reader: a
 * map rendering half-understood nodes confidently is worse than one rendering
 * fewer, and the user has no way to tell the difference.
 */
function parseFeatureMapJson(stdout: string): BlueprintFeatureMapResult {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return unavailable('no output')
  // The verb's refusals are one-line prose (`feature-map refused: …`).
  if (!trimmed.startsWith('{')) return unavailable(trimmed.split('\n')[0] ?? 'feature-map refused')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return unavailable('unparseable feature-map output')
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.feature !== 'string' || obj.feature.length === 0) {
    return unavailable('feature-map output names no feature')
  }

  const files: BlueprintFeatureMapFile[] = []
  for (const raw of Array.isArray(obj.files) ? obj.files : []) {
    const f = raw as Record<string, unknown>
    if (
      typeof f.path !== 'string' ||
      f.path.length === 0 ||
      (f.kind !== 'file' && f.kind !== 'folder') ||
      (f.part !== null && typeof f.part !== 'string')
    ) {
      continue
    }
    files.push({
      path: f.path,
      part: f.part as string | null,
      kind: f.kind,
      badges: (Array.isArray(f.badges) ? f.badges : []).filter(
        (badge): badge is string => typeof badge === 'string',
      ),
    })
  }

  const known = new Set(files.map((file) => file.path))
  const edges: BlueprintFeatureMapEdge[] = []
  for (const raw of Array.isArray(obj.edges) ? obj.edges : []) {
    const e = raw as Record<string, unknown>
    if (typeof e.from !== 'string' || typeof e.to !== 'string') continue
    // The contract's edge rule, re-checked at the boundary: both endpoints in
    // the file set. An edge to a node this reader dropped must drop with it.
    if (!known.has(e.from) || !known.has(e.to)) continue
    edges.push({ from: e.from, to: e.to })
  }

  const unresolved: BlueprintFeatureMapUnresolved[] = []
  for (const raw of Array.isArray(obj.unresolved) ? obj.unresolved : []) {
    const u = raw as Record<string, unknown>
    if (typeof u.anchor !== 'string') continue
    unresolved.push({ anchor: u.anchor, reason: typeof u.reason === 'string' ? u.reason : '' })
  }

  return { available: true, reason: null, feature: obj.feature, files, edges, unresolved }
}

/**
 * Run the feature map for `rootPath` via the bundled CLI. Fail-soft — never
 * throws. `spawnFn` is injectable for tests.
 */
export function runFeatureMap(
  bundledCli: BundledCli | null,
  rootPath: string,
  feature: string,
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<BlueprintFeatureMapResult> {
  if (bundledCli === null) return Promise.resolve(unavailable('bundled CLI unavailable'))
  if (feature.trim().length === 0) return Promise.resolve(unavailable('no feature named'))
  const spawnFn = deps.spawnFn ?? spawn
  const timeoutMs = deps.timeoutMs ?? FEATURE_MAP_TIMEOUT_MS
  const args = [bundledCli.cliPath, 'blueprint', 'feature-map', '--feature', feature, '--json']
  return new Promise<BlueprintFeatureMapResult>((resolve) => {
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
      resolve(parseFeatureMapJson(stdout))
    })
  })
}
