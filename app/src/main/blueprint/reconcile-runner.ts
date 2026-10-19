// Live change-simulation reconciliation (blueprint-simulation).
//
// Runs the bundled CLI `blueprint reconcile --plan <plan> --json` for a project
// and parses its stdout into a BlueprintReconcileResult. Unlike the provisioner's
// runBundledCli (stderr-only), this captures STDOUT — the CLI emits the
// reconciliation JSON there. Fail-soft: any spawn/parse failure, or the CLI's
// `reconcile refused: …` line, yields `available: false` with a one-line reason
// so the board falls back to the predicted overlay.
import { spawn } from 'child_process'

import type { BundledCli } from './derive-runner'
import type {
  BlueprintReconcileNode,
  BlueprintReconcileResult,
} from '../../shared/ipc-contract'

const RECONCILE_TIMEOUT_MS = 30_000

function unavailable(reason: string): BlueprintReconcileResult {
  return { available: false, reason, nodes: [], surprises: [] }
}

/** Narrow the CLI's parsed JSON to the contract shape (defensive). */
function parseReconcileJson(stdout: string): BlueprintReconcileResult {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return unavailable('no output')
  // A refusal is printed as a plain line, not JSON.
  if (!trimmed.startsWith('{')) return unavailable(trimmed.split('\n')[0] ?? 'reconcile refused')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return unavailable('unparseable reconcile output')
  }
  const obj = parsed as { reconciliation?: unknown; surprises?: unknown }
  const rawNodes = Array.isArray(obj.reconciliation) ? obj.reconciliation : []
  const nodes: BlueprintReconcileNode[] = []
  for (const n of rawNodes) {
    const node = n as { nodeId?: unknown; phase?: unknown; state?: unknown }
    if (
      typeof node.nodeId === 'string' &&
      typeof node.phase === 'number' &&
      (node.state === 'confirmed' || node.state === 'missed' || node.state === 'surprise')
    ) {
      nodes.push({ nodeId: node.nodeId, phase: node.phase, state: node.state })
    }
  }
  const surprises = Array.isArray(obj.surprises)
    ? obj.surprises.filter((s): s is string => typeof s === 'string')
    : []
  return { available: true, reason: null, nodes, surprises }
}

/**
 * Run reconcile for `plan` in `rootPath` via the bundled CLI. Fail-soft — never
 * throws; returns `available: false` on any failure. `spawnFn` is injectable for
 * tests.
 */
export function runReconcile(
  bundledCli: BundledCli | null,
  rootPath: string,
  plan: string,
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<BlueprintReconcileResult> {
  if (bundledCli === null) {
    return Promise.resolve(unavailable('bundled CLI unavailable'))
  }
  const spawnFn = deps.spawnFn ?? spawn
  const timeoutMs = deps.timeoutMs ?? RECONCILE_TIMEOUT_MS
  const args = [bundledCli.cliPath, 'blueprint', 'reconcile', '--plan', plan, '--json']
  return new Promise<BlueprintReconcileResult>((resolve) => {
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
      resolve(parseReconcileJson(stdout))
    })
  })
}
