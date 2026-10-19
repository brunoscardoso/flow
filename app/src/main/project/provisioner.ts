// Provisioner — keeps every project root scaffolded with the plan-flow assets
// that match the IDE's bundled CLI, with zero terminal interaction.
//
// The decision core (`decideProvisioning`) is PURE and exhaustively unit-tested:
// given a root's provision stamp, the bundled CLI's version, and whether a run
// is already in flight, it returns exactly one of provision / refresh / skip.
// The `Provisioner` class is the thin effect wrapper — it serializes runs per
// root, spawns the bundled CLI (`init --claude --force --yes` to provision a
// fresh project, `init --refresh-owned` to update owned assets when the version
// drifted), stamps the root on success via ProjectRegistry, and on failure
// emits ONE toast and leaves the root unstamped so the next trigger re-runs it.
//
// #14 (invariants live in ONE code path): the bundled-CLI spawn used here is the
// SAME `runBundledCli` helper the blueprint derive-runner's ensureProjectInitialized
// delegates to — there is a single init-spawn code path in the app.

import { spawn } from 'child_process'
import { runInCliHost } from '../cli-host/client'
import { runInBackground } from '../agent/background-priority'
import { readFileSync } from 'fs'
import { access } from 'fs/promises'
import { dirname, join } from 'path'

import type { FlowNotification, ProvisioningState } from '../../shared/ipc-contract'
import type { BundledCli } from '../blueprint/derive-runner'

export type { ProvisioningState }

/** Fresh-project provisioning — non-interactive full init (defaults to Claude);
 *  `--yes` takes every default so it runs under the hood with no terminal.
 *  `--workspace-managed`: every project lives in a Workspace, so init leaves
 *  `flow/` alone (no vault link) — joining the Workspace links it. */
export const INIT_ARGS = ['init', '--claude', '--force', '--yes', '--workspace-managed'] as const

/** Version-drift refresh — rewrites plan-flow-OWNED asset groups only, never the
 *  user's own files (refuses without an existing install). */
export const REFRESH_ARGS = ['init', '--refresh-owned'] as const

/** Hard cap on one bundled-CLI run — a hung CLI must not pin a root forever. */
export const PROVISION_TIMEOUT_MS = 120_000

/** Keep only the tail of stderr — enough for a one-line failure reason. */
const STDERR_TAIL_CHARS = 2000

export type ProvisionAction = 'provision' | 'refresh' | 'skip'

export interface ProvisionDecision {
  action: ProvisionAction
  /** Present on every `skip` (why nothing runs); absent on provision/refresh. */
  reason?: string
}

/** The provision-relevant slice of a root: is it reachable, and what version
 *  (if any) last provisioned it. */
export interface ProvisionRootState {
  available: boolean
  provisionedVersion?: string
}

/**
 * Pure provisioning decision (exhaustively unit-tested). Order matters:
 *   unreachable root                → skip('unavailable')
 *   a run already in flight         → skip('in-flight')
 *   no bundled CLI version to run   → skip('no-bundled-cli')
 *   never provisioned (no stamp)    → provision
 *   stamp differs from the bundle   → refresh
 *   stamp equals the bundle version → skip('current')
 */
export function decideProvisioning(
  root: ProvisionRootState,
  bundleVersion: string | null,
  inFlight: boolean,
): ProvisionDecision {
  if (!root.available) return { action: 'skip', reason: 'unavailable' }
  if (inFlight) return { action: 'skip', reason: 'in-flight' }
  if (!bundleVersion) return { action: 'skip', reason: 'no-bundled-cli' }
  if (root.provisionedVersion === undefined) return { action: 'provision' }
  if (root.provisionedVersion !== bundleVersion) return { action: 'refresh' }
  return { action: 'skip', reason: 'current' }
}

/**
 * Startup-only readiness snapshot (pure, exhaustively unit-tested; #513
 * progressive-learning phase 1). `provisioningState` is in-memory only — it
 * has no persisted column — so it's recomputed from scratch on every restore:
 * a root already stamped at the CURRENT bundle version starts `ready` (there
 * is nothing to run); everything else — never provisioned, version-drifted,
 * or no bundled CLI to compare against — starts `idle` and waits for the
 * startup provisioning sweep's `maybeProvision` call to drive it forward.
 */
export function initialProvisioningState(
  root: ProvisionRootState,
  bundleVersion: string | null,
): ProvisioningState {
  return bundleVersion !== null && root.provisionedVersion === bundleVersion ? 'ready' : 'idle'
}

/**
 * Pure transition step (exhaustively unit-tested): given the decision just
 * computed by `decideProvisioning`, what readiness state follows immediately?
 * `provision`/`refresh` are ABOUT to run → `provisioning`. A skip because the
 * root is already `current` resolves `ready` right away (nothing runs, but
 * the in-memory state may still be stale from before the last stamp). Every
 * other skip reason (`unavailable`, `in-flight`, `no-bundled-cli`) leaves the
 * existing state untouched — signaled by returning `undefined`.
 */
export function nextStateForDecision(decision: ProvisionDecision): ProvisioningState | undefined {
  if (decision.action === 'skip') return decision.reason === 'current' ? 'ready' : undefined
  return 'provisioning'
}

/** Pure transition step: a run's outcome maps 1:1 to the terminal readiness
 *  state (`ready` on success, `failed` on error) — retrying re-enters via
 *  `nextStateForDecision` (`provision`/`refresh` → `provisioning`) on the next
 *  trigger, since a failed run leaves the root unstamped. */
export function nextStateForOutcome(ok: boolean): ProvisioningState {
  return ok ? 'ready' : 'failed'
}

export interface RunCliResult {
  ok: boolean
  /** Short one-line reason when `ok` is false (last stderr line / exit / timeout). */
  error?: string
  /** False ONLY when the child could not be spawned at all (synchronous throw). */
  launched: boolean
}

/**
 * The single init-spawn code path (#14): spawn the app-embedded CLI as
 * Electron-as-Node in `rootPath` with a hard timeout. Both the Provisioner and
 * the blueprint derive-runner's ensureProjectInitialized route through here, so
 * there is no duplicated init-spawn logic anywhere in the app. Never throws —
 * a synchronous spawn failure resolves to `{ ok: false, launched: false }`.
 */
export async function runBundledCli(
  bundledCli: BundledCli,
  rootPath: string,
  args: readonly string[],
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<RunCliResult> {
  const spawnFn = deps.spawnFn ?? spawn
  const timeoutMs = deps.timeoutMs ?? PROVISION_TIMEOUT_MS
  // Spawned by the CLI host when there is one — see cli-host/host.ts. Tests
  // inject spawnFn and must keep their own path.
  if (deps.spawnFn === undefined) {
    const hosted = runInCliHost({
      execPath: bundledCli.execPath,
      args: [bundledCli.cliPath, ...args],
      cwd: rootPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      captureStdout: false,
      timeoutMs,
    })
    if (hosted !== null) {
      const result = await hosted
      if (result.error !== 'cli host exited' && result.error !== 'cli host unreachable') {
        return result.ok
          ? { ok: true, launched: true }
          : {
              ok: false,
              launched: true,
              error: result.error ?? result.stderr.trim().split('\n').pop() ?? 'failed',
            }
      }
    }
  }
  return new Promise<RunCliResult>((resolve) => {
    let stderrTail = ''
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(bundledCli.execPath, [bundledCli.cliPath, ...args], {
        cwd: rootPath,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      // Provisioning and derive are derived work: they run, and they lose every
      // scheduling contest against the window (background-priority.ts).
      runInBackground(child.pid)
    } catch (error) {
      resolve({ ok: false, launched: false, error: (error as Error).message })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, launched: true, error: 'timed out' })
    }, timeoutMs)
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      resolve({ ok: false, launched: true, error: error.message })
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve(
        code === 0
          ? { ok: true, launched: true }
          : { ok: false, launched: true, error: lastLine(stderrTail) ?? `exited with ${String(code)}` },
      )
    })
  })
}

/** The root shape the Provisioner operates on (a slice of RegisteredProject). */
export interface ProvisionerRoot {
  id: string
  rootPath: string
  /** Absent = available; `false` = persisted-but-unreachable (never provisioned). */
  available?: boolean
  provisionedVersion?: string
}

export interface ProvisionerDeps {
  /** The app-embedded CLI, or null when unavailable (all runs then skip). */
  bundledCli: BundledCli | null
  /** Stamp a provisioned root — ProjectRegistry.stampProvisioned (the one write path). */
  stampProvisioned: (rootId: string, version: string, at: string) => void
  /** Emit ONE toast on failure — broadcasts a flow:notification to the windows. */
  notify: (notification: FlowNotification) => void
  spawnFn?: typeof spawn
  /** Injectable bundle-version reader (tests); defaults to reading the bundle's package.json. */
  readBundleVersion?: (bundledCli: BundledCli) => string | null
  /** Injectable clock (tests); defaults to Date.now via new Date(). */
  now?: () => Date
  /**
   * Whether the project already HAS a plan-flow install a refresh can update
   * (the CLI's own `hasExistingInstall` rule: `.claude/commands` or
   * `.claude/resources`). Read-only; injectable for tests.
   */
  hasInstall?: (rootPath: string) => Promise<boolean>
}

/** The CLI's install rule (`init-refresh.ts` hasExistingInstall), asked without blocking main. */
async function hasPlanFlowInstall(rootPath: string): Promise<boolean> {
  for (const owned of [join(rootPath, '.claude', 'commands'), join(rootPath, '.claude', 'resources')]) {
    try {
      await access(owned)
      return true
    } catch {
      // absent — try the next marker
    }
  }
  return false
}

/**
 * The stamp a project is provisioned at: the bundle's version, plus the hash of
 * its owned assets when the bundle carries one (`1.4.3+3f9a…`, semver build
 * metadata). The version alone let a skill edit shipped without a version bump
 * sit in the bundle forever: every project already stamped `1.4.3` read as
 * current, and kept the old skill.
 */
export function bundleStamp(version: string, assetsHash: string | undefined): string {
  return assetsHash === undefined || assetsHash.length === 0 ? version : `${version}+${assetsHash}`
}

/**
 * Read the bundled CLI's stamp from its sibling package.json, fail-soft.
 * The bundle ships `{ name, version, type, assetsHash }` next to planflow-ai.mjs
 * (see scripts/build-cli-bundle.mjs); an older bundle without `assetsHash`
 * stamps by version alone. Returns null on any read/parse miss.
 */
export function readBundleVersionFromDisk(bundledCli: BundledCli): string | null {
  try {
    const raw = readFileSync(join(dirname(bundledCli.cliPath), 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown; assetsHash?: unknown }
    if (typeof parsed.version !== 'string' || parsed.version.length === 0) return null
    return bundleStamp(parsed.version, typeof parsed.assetsHash === 'string' ? parsed.assetsHash : undefined)
  } catch (error) {
    console.warn('flow: could not read the bundled CLI version', { cliPath: bundledCli.cliPath, error })
    return null
  }
}

export class Provisioner {
  private readonly bundledCli: BundledCli | null
  /** The bundled CLI's version, resolved ONCE at construction (fail-soft). */
  private readonly bundleVersion: string | null
  /** Per-root guard: rootId ∈ set ⇒ a run is in flight for that root. */
  private readonly inFlight = new Set<string>()
  /** Subscribers to per-root readiness transitions (#513 phase 1) — the
   *  main-side bridge mirrors these onto ProjectRegistry; Phase 2 gating
   *  will read them directly. */
  private readonly stateListeners = new Set<(rootId: string, state: ProvisioningState) => void>()
  private readonly stampProvisioned: ProvisionerDeps['stampProvisioned']
  private readonly notify: ProvisionerDeps['notify']
  private readonly spawnFn: typeof spawn
  private readonly now: () => Date
  private readonly hasInstall: (rootPath: string) => Promise<boolean>

  constructor(deps: ProvisionerDeps) {
    this.bundledCli = deps.bundledCli
    this.stampProvisioned = deps.stampProvisioned
    this.notify = deps.notify
    this.spawnFn = deps.spawnFn ?? spawn
    this.now = deps.now ?? (() => new Date())
    this.hasInstall = deps.hasInstall ?? hasPlanFlowInstall
    const readVersion = deps.readBundleVersion ?? readBundleVersionFromDisk
    this.bundleVersion = deps.bundledCli ? readVersion(deps.bundledCli) : null
  }

  /**
   * Decide → act for one root, fire-and-forget. Safe to call on every trigger
   * (addRoot, activation, startup sweep) — it self-serializes per root via the
   * in-flight guard and returns immediately for anything that should skip.
   * Never rejects — failures surface as a toast, not an exception.
   */
  maybeProvision(root: ProvisionerRoot): Promise<void> {
    const decision = decideProvisioning(
      { available: root.available !== false, provisionedVersion: root.provisionedVersion },
      this.bundleVersion,
      this.inFlight.has(root.id),
    )
    // Only the skip branch needs handling here: `provisionRoot` itself sets
    // 'provisioning' the instant a run actually starts (single source of
    // truth, reached from both this decision-driven path AND a direct
    // provisionRoot call from the manual re-provision action).
    if (decision.action === 'skip') {
      const next = nextStateForDecision(decision)
      if (next) this.setState(root.id, next)
      return Promise.resolve()
    }
    return this.provisionRoot(root, decision.action)
  }

  /**
   * Run the bundled CLI for one root (provision or refresh), serialized by the
   * in-flight guard. On success stamps the root with the bundle version; on
   * failure emits ONE toast and leaves the root unstamped so it re-runs on the
   * next trigger. Never rejects.
   */
  async provisionRoot(root: ProvisionerRoot, action: 'provision' | 'refresh'): Promise<void> {
    // Defensive: maybeProvision already skips these, but provisionRoot may be
    // called directly (derive-runner delegation) — never spawn without a CLI.
    if (!this.bundledCli || !this.bundleVersion) return
    if (this.inFlight.has(root.id)) return
    this.inFlight.add(root.id)
    // Set 'provisioning' here (not just in maybeProvision's decision-driven
    // transition) so a DIRECT provisionRoot call — the manual "re-provision
    // now" action bypasses decideProvisioning entirely — still reports the
    // transition to subscribers (#513 phase 1).
    this.setState(root.id, 'provisioning')
    try {
      // A STAMPED root with nothing to refresh (setup failed once, or its
      // .claude/ was removed) can never recover through a refresh — the CLI
      // refuses "no existing plan-flow install" on every open (live:
      // orbit-argo-applications, 2026-10-06). It gets the full first-time
      // setup instead. Only in that case: a full setup is never run over an
      // existing install, whose rules a refresh must leave alone.
      const effective = action === 'refresh' && !(await this.hasInstall(root.rootPath)) ? 'provision' : action
      const args = effective === 'provision' ? INIT_ARGS : REFRESH_ARGS
      const result = await runBundledCli(this.bundledCli, root.rootPath, args, {
        spawnFn: this.spawnFn,
        timeoutMs: PROVISION_TIMEOUT_MS,
      })
      this.setState(root.id, nextStateForOutcome(result.ok))
      if (result.ok) {
        this.stampProvisioned(root.id, this.bundleVersion, this.now().toISOString())
      } else {
        this.emitFailure(root, action, result.error)
      }
    } catch (error) {
      // runBundledCli never rejects, but keep the guard honest regardless.
      this.setState(root.id, 'failed')
      this.emitFailure(root, action, (error as Error).message)
    } finally {
      this.inFlight.delete(root.id)
    }
  }

  /** True while a run is in flight for `rootId` (used by the decision core). */
  isInFlight(rootId: string): boolean {
    return this.inFlight.has(rootId)
  }

  /**
   * Compute the readiness state a root should start in — recomputed on
   * every restore since `provisioningState` is in-memory only, never
   * persisted (#513 phase 1). Delegates to the pure `initialProvisioningState`
   * core, closing over the instance's resolved `bundleVersion`.
   */
  initialStateFor(root: ProvisionRootState): ProvisioningState {
    return initialProvisioningState(root, this.bundleVersion)
  }

  /**
   * Subscribe to per-root readiness transitions (#513 phase 1). Returns an
   * unsubscribe function. Fired on every state change made by this instance —
   * `provisioning` (run starting), `ready`/`failed` (run outcome), and the
   * immediate `ready` resolved by `maybeProvision` for an already-current root.
   */
  onStateChange(listener: (rootId: string, state: ProvisioningState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private setState(rootId: string, state: ProvisioningState): void {
    for (const listener of this.stateListeners) listener(rootId, state)
  }

  private emitFailure(root: ProvisionerRoot, action: 'provision' | 'refresh', error?: string): void {
    const verb = action === 'provision' ? 'set up' : 'update'
    this.notify({
      kind: 'state-change',
      rootId: root.rootPath,
      title: `Could not ${verb} plan-flow`,
      body: error ? `${error}` : `plan-flow ${action} failed for this project.`,
      timestamp: this.now().toISOString(),
      level: 'error',
    })
  }
}

/**
 * Node prints its version banner as the LAST line of an unhandled-exception
 * crash dump, plus a couple of framing lines around the stack.
 */
const CRASH_FRAMING = [
  /^Node\.js v[\d.]+$/,
  /^\s*at\s/, // stack frames
  /^\s*\^+\s*$/, // the caret line under the offending source
  /^\s*(throw\b|\})/, // the echoed source line Node prints above the error
  /^\[?\d{4}-\d{2}-\d{2}/, // leading timestamps some tools prefix
]

/** A line that actually names a failure, in rough order of how useful it is. */
const REASON_PATTERNS = [
  /^[A-Za-z]*Error:\s*\S/, // Error: / TypeError: / SyntaxError: …
  /\b(EACCES|EPERM|ENOENT|ENOSPC|EROFS|EBUSY|EEXIST|EMFILE)\b/,
  /\b(permission denied|read-only file system|no space left|not a directory)\b/i,
  /\brefused:/, // this CLI's own "<verb> refused: <reason>" convention
]

/**
 * The one-line reason for the toast — the most informative stderr line, not
 * merely the last one (#1463).
 *
 * `lastLine` was literally the last non-empty line, and for a bundled-CLI
 * process that dies on an uncaught error that line is ALWAYS `Node.js v24.18.0`
 * — the crash dump's version banner. The real cause (`Error: EACCES: permission
 * denied, mkdir '<project>/.claude/commands'`) sat two lines above it in the very
 * same buffer and was thrown away, so the user was told a Node version and
 * nothing else, forever, on every retry.
 *
 * Prefer a line that names a failure; otherwise fall back to the last line that
 * is not obviously crash framing; and only then to the last line at all, so a
 * message this doesn't recognise is still passed through rather than swallowed.
 */
export function lastLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return null

  for (const pattern of REASON_PATTERNS) {
    // Last match: a stack usually ends with the most specific wrapper.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i] as string
      if (pattern.test(line)) return line
    }
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string
    if (!CRASH_FRAMING.some((frame) => frame.test(line))) return line
  }
  return lines[lines.length - 1] as string
}
