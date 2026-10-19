// BlueprintDeriveRunner — runs `planflow-ai blueprint derive` for a project
// root ON BEHALF of the Blueprint view, so the user is never told to run a
// CLI command. Everything happens in main:
//
//   resolution   ordered candidates, first that exists/works wins:
//                  (1) <root>/node_modules/.bin/planflow-ai   (installed CLI)
//                  (2) `node <root>/dist/cli/index.js` when the root's
//                      package.json name is 'planflow-ai' (the CLI repo
//                      itself) AND dist exists — missing dist falls through
//                  (3) well-known install dirs, probed directly — GUI-
//                      launched Electron does NOT inherit the shell PATH on
//                      macOS, so `planflow-ai` on PATH misses (ENOENT) even
//                      when the CLI is installed: /opt/homebrew/bin,
//                      /usr/local/bin, ~/.local/bin, ~/.npm-global/bin,
//                      plus nvm's ~/.nvm/versions/node/*/bin (highest
//                      version wins when several have the CLI)
//                  (4) login-shell lookup, once per app session (cached):
//                      `$SHELL -lc 'command -v planflow-ai'` with a 3s cap
//                  (5) `planflow-ai` on PATH (last resort)
//   spawn        async child_process.spawn (never execSync — the main
//                process must not block), cwd = the VALIDATED root, 60s
//                timeout. A spawn-level miss (ENOENT etc.) tries the next
//                candidate; a non-zero exit is a real derive failure.
//   concurrency  one derive per root at a time (in-flight promise map) —
//                the CLI holds its own graph lock, but we never double-spawn.
//
// SECURITY: the renderer only ever supplies a rootId (absolute rootPath),
// validated against the current project roots exactly like blueprint:read.
// The command and arguments are constructed HERE — nothing renderer-supplied
// is ever executed.
//
// Fail-soft: a failed derive resolves to { ok: false, error } with a short
// one-line reason (for the view's calm failure state) and logs ONE line —
// it never throws and never crashes main.

import { spawn } from 'child_process'
import { constants as fsConstants, existsSync, promises as fsPromises } from 'fs'
import { homedir as osHomedir } from 'os'
import { join } from 'path'

import type { BlueprintDeriveResult } from '../../shared/ipc-contract'
import type { RootsProvider } from '../flow/flow-observer'
import { INIT_ARGS, runBundledCli } from '../project/provisioner'

export const DERIVE_ARGS = ['blueprint', 'derive'] as const

// The under-the-hood `init --yes` args + spawn now live in the provisioner —
// the single init-spawn code path (#14). Re-exported here so existing importers
// (and the derive-runner tests) keep resolving INIT_ARGS from this module.
export { INIT_ARGS }

/** Hard cap on one derive run — a hung CLI must not pin the root forever. */
const DERIVE_TIMEOUT_MS = 60_000

/** Cap on the once-per-session login-shell `command -v` lookup. */
const SHELL_LOOKUP_TIMEOUT_MS = 3_000

/** Keep only the tail of stderr — enough for a one-line reason. */
const STDERR_TAIL_CHARS = 2000

export interface DeriveCommand {
  /** Which resolution rule produced this candidate (logging/tests). */
  id: 'bundled' | 'local-bin' | 'project-dist' | 'well-known' | 'nvm' | 'login-shell' | 'path'
  command: string
  args: string[]
  /** Extra env for the spawn (merged over process.env) — the bundled candidate
   *  sets ELECTRON_RUN_AS_NODE so the Electron binary runs the CLI as Node. */
  env?: Record<string, string>
}

/** The app-embedded CLI (built by scripts/build-cli-bundle.mjs), spawned via the
 *  Electron binary as Node — no npm/PATH/system-node needed. Resolved first. */
export interface BundledCli {
  /** Electron binary to run as Node (process.execPath). */
  execPath: string
  /** Absolute path to the bundled planflow-ai.mjs. */
  cliPath: string
}

export interface EnsureInitResult {
  ok: boolean
  /** True when init actually ran (false = already set up, or no CLI to run it). */
  ranInit: boolean
  error?: string
}

/**
 * First-run provisioning: when a project has no `flow/` yet, run
 * `planflow-ai init --yes` via the app-embedded CLI so the blueprint (and the
 * brain pipeline) have their scaffolding. Idempotent — a project that already
 * has `flow/` is a no-op. Fail-soft — a missing CLI or a failed init resolves
 * to `ok:false`; the caller can still attempt derive (which fails cleanly).
 * Delegates the actual init-spawn to the provisioner's `runBundledCli` — the
 * single init-spawn code path (#14): no duplicated spawn/timeout/stderr logic
 * lives here. Runs the CLI as Electron-as-node, exactly like the bundled derive
 * candidate.
 */
export async function ensureProjectInitialized(
  rootPath: string,
  deps: {
    bundledCli: BundledCli | null
    spawnFn?: typeof spawn
    /** Injectable existence check (defaults to fs.existsSync) for tests. */
    pathExists?: (path: string) => boolean
  },
): Promise<EnsureInitResult> {
  const pathExists = deps.pathExists ?? existsSync
  if (pathExists(join(rootPath, 'flow'))) {
    return { ok: true, ranInit: false }
  }
  const { bundledCli } = deps
  if (!bundledCli || !pathExists(bundledCli.cliPath)) {
    return { ok: false, ranInit: false, error: 'planflow-ai CLI not available for init' }
  }
  const result = await runBundledCli(bundledCli, rootPath, INIT_ARGS, { spawnFn: deps.spawnFn })
  // `launched: false` (a synchronous spawn throw) is the only case that never
  // ran init — everything else, success or failure, means init executed.
  if (result.ok) {
    return { ok: true, ranInit: true }
  }
  return { ok: false, ranInit: result.launched, error: result.error }
}

/** Injectable fs surface so the resolution order is unit-testable. */
export interface DeriveFsDeps {
  fileExists(path: string): Promise<boolean>
  /** True when the path exists AND is executable by this process. */
  executableExists(path: string): Promise<boolean>
  /** File content, or null when unreadable/missing. */
  readFile(path: string): Promise<string | null>
  /** Directory entry names, or [] when unreadable/missing. */
  listDir(path: string): Promise<string[]>
  /** The user's home directory (injectable for tests). */
  homedir(): string
}

const defaultFsDeps: DeriveFsDeps = {
  fileExists: async (path) => {
    try {
      await fsPromises.access(path)
      return true
    } catch {
      return false
    }
  },
  executableExists: async (path) => {
    try {
      await fsPromises.access(path, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  },
  readFile: async (path) => {
    try {
      return await fsPromises.readFile(path, 'utf-8')
    } catch {
      return null
    }
  },
  listDir: async (path) => {
    try {
      return await fsPromises.readdir(path)
    } catch {
      return []
    }
  },
  homedir: () => osHomedir(),
}

/**
 * Ask the user's login shell where planflow-ai lives — GUI-launched Electron
 * misses shell-profile PATH entries, but `$SHELL -lc 'command -v …'` sees
 * them. Resolves to an absolute path or null; capped at 3s; never throws.
 *
 * B4: the whole probe is POSIX by construction — `$SHELL`, `-lc`, `command -v`,
 * and the absolute-path test (`startsWith('/')`) are all shell-and-filesystem
 * assumptions Windows does not meet. Running it there spawns `/bin/zsh`, which
 * cannot exist, and the only question is whether it ENOENTs or hangs until the
 * 3s cap burns — either way the answer is null before it starts. So skip it: on
 * win32 there is no login-shell candidate, and the resolution list falls
 * through to the PATH fallback exactly as it does when the lookup finds nothing.
 */
export type ShellLookup = () => Promise<string | null>

export function loginShellLookup(
  spawnFn: typeof spawn = spawn,
  platform: NodeJS.Platform | string = process.platform,
): Promise<string | null> {
  if (platform === 'win32') {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const settle = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(process.env['SHELL'] || '/bin/zsh', ['-lc', 'command -v planflow-ai'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(null)
    }, SHELL_LOOKUP_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.on('error', () => settle(null))
    child.on('close', (code) => {
      const path = stdout.trim().split('\n')[0]?.trim() ?? ''
      settle(code === 0 && path.startsWith('/') ? path : null)
    })
  })
}

/** Once-per-app-session cache for the login-shell lookup (both outcomes). */
let shellLookupCache: Promise<string | null> | null = null

function cachedLoginShellLookup(): Promise<string | null> {
  shellLookupCache ??= loginShellLookup()
  return shellLookupCache
}

/** Test-only: forget the session's login-shell lookup result. */
export function resetLoginShellCacheForTests(): void {
  shellLookupCache = null
}

/** Compare nvm version dir names (`v18.20.1`) — descending numeric order. */
export function compareNvmVersionsDesc(a: string, b: string): number {
  const parse = (name: string): number[] =>
    name
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const [aParts, bParts] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (bParts[i] ?? 0) - (aParts[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Fixed non-nvm install dirs probed directly (see resolution note above). */
function wellKnownBinDirs(home: string): string[] {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
  ]
}

/**
 * Resolve the ordered CLI candidates for a root (pure given `fs` and
 * `shellLookup`). The PATH fallback is always last — whether it "works" is
 * only knowable at spawn time, so the runner treats spawn-level misses as
 * "try the next one".
 */
export async function resolveDeriveCommands(
  rootPath: string,
  fs: DeriveFsDeps = defaultFsDeps,
  shellLookup: ShellLookup = cachedLoginShellLookup,
  bundledCli: BundledCli | null = null,
): Promise<DeriveCommand[]> {
  const candidates: DeriveCommand[] = []

  // (0) The app-embedded CLI, tried FIRST — no npm / PATH / system node needed.
  // The IDE ships this, so it works out of the box regardless of the user env.
  if (bundledCli && (await fs.fileExists(bundledCli.cliPath))) {
    candidates.push({
      id: 'bundled',
      command: bundledCli.execPath,
      args: [bundledCli.cliPath, ...DERIVE_ARGS],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  }

  // (1) The project's own installed CLI.
  const localBin = join(rootPath, 'node_modules', '.bin', 'planflow-ai')
  if (await fs.fileExists(localBin)) {
    candidates.push({ id: 'local-bin', command: localBin, args: [...DERIVE_ARGS] })
  }

  // (2) The planflow-ai repo itself — run its built CLI entry directly.
  const packageJson = await fs.readFile(join(rootPath, 'package.json'))
  if (packageJson !== null) {
    try {
      const parsed = JSON.parse(packageJson) as { name?: unknown }
      if (parsed.name === 'planflow-ai') {
        const distEntry = join(rootPath, 'dist', 'cli', 'index.js')
        if (await fs.fileExists(distEntry)) {
          candidates.push({
            id: 'project-dist',
            command: 'node',
            args: [distEntry, ...DERIVE_ARGS],
          })
        }
        // dist missing → fall through to the global candidates.
      }
    } catch {
      // Corrupt package.json — not the CLI repo; fall through.
    }
  }

  // (3) Well-known install dirs — probed directly because GUI-launched
  // Electron does not inherit the shell PATH on macOS.
  const home = fs.homedir()
  for (const dir of wellKnownBinDirs(home)) {
    const bin = join(dir, 'planflow-ai')
    if (await fs.executableExists(bin)) {
      candidates.push({ id: 'well-known', command: bin, args: [...DERIVE_ARGS] })
    }
  }
  // nvm: probe every installed node version's bin, highest version first.
  const nvmVersionsDir = join(home, '.nvm', 'versions', 'node')
  const nvmVersions = (await fs.listDir(nvmVersionsDir)).sort(compareNvmVersionsDesc)
  for (const version of nvmVersions) {
    const bin = join(nvmVersionsDir, version, 'bin', 'planflow-ai')
    if (await fs.executableExists(bin)) {
      candidates.push({ id: 'nvm', command: bin, args: [...DERIVE_ARGS] })
      break // highest version that has the CLI wins
    }
  }

  // (4) Login-shell lookup (cached once per app session — one shell spawn
  // per app run at most). Skipped only when it duplicates a probe above.
  const shellPath = await shellLookup()
  if (shellPath !== null && !candidates.some((c) => c.command === shellPath)) {
    candidates.push({ id: 'login-shell', command: shellPath, args: [...DERIVE_ARGS] })
  }

  // (5) PATH fallback — a spawn ENOENT here means "no CLI anywhere".
  candidates.push({ id: 'path', command: 'planflow-ai', args: [...DERIVE_ARGS] })
  return candidates
}

type SpawnOutcome =
  | { outcome: 'ok' }
  /** The CLI ran and genuinely failed — do not try other candidates. */
  | { outcome: 'failed'; reason: string }
  /** This candidate could not start (ENOENT, …) — try the next one. */
  | { outcome: 'unavailable'; reason: string }

export class BlueprintDeriveRunner {
  /** One derive per root at a time — concurrent requests join the run. */
  private readonly inFlight = new Map<string, Promise<BlueprintDeriveResult>>()

  /**
   * Per-session cache of the candidate that last succeeded for a root —
   * tried first on the next derive, invalidated whenever it stops working.
   */
  private readonly lastGood = new Map<string, DeriveCommand>()

  private readonly resolveCommands: (rootPath: string) => Promise<DeriveCommand[]>

  constructor(
    private readonly roots: RootsProvider,
    resolveCommands?: (rootPath: string) => Promise<DeriveCommand[]>,
    private readonly spawnFn: typeof spawn = spawn,
    /** The app-embedded CLI, tried first by the default resolver. Ignored when
     *  a custom `resolveCommands` is supplied (tests). */
    bundledCli: BundledCli | null = null,
  ) {
    this.resolveCommands =
      resolveCommands ?? ((rootPath) => resolveDeriveCommands(rootPath, undefined, undefined, bundledCli))
  }

  derive(rootPath: string): Promise<BlueprintDeriveResult> {
    // Same rootId validation as blueprint:read — unknown roots never spawn.
    if (!this.roots.getRoots().some((root) => root.rootPath === rootPath)) {
      return Promise.resolve({ ok: false, error: 'Unknown project' })
    }
    const existing = this.inFlight.get(rootPath)
    if (existing) {
      return existing
    }
    const run = this.run(rootPath).finally(() => this.inFlight.delete(rootPath))
    this.inFlight.set(rootPath, run)
    return run
  }

  private async run(rootPath: string): Promise<BlueprintDeriveResult> {
    // Cached fast path: the candidate that worked last time is tried first.
    // Any non-ok outcome invalidates it — a spawn miss falls through to the
    // full resolution; a real derive failure is reported as such.
    const cached = this.lastGood.get(rootPath)
    if (cached) {
      const result = await this.spawnOnce(rootPath, cached)
      if (result.outcome === 'ok') {
        return { ok: true, error: null }
      }
      this.lastGood.delete(rootPath)
      if (result.outcome === 'failed') {
        console.warn(
          `[BlueprintDerive] derive failed for ${rootPath} (cached ${cached.id}): ${result.reason}`,
        )
        return { ok: false, error: result.reason }
      }
    }

    let lastMiss = 'planflow-ai CLI not found for this project'
    for (const candidate of await this.resolveCommands(rootPath)) {
      const result = await this.spawnOnce(rootPath, candidate)
      if (result.outcome === 'ok') {
        this.lastGood.set(rootPath, candidate)
        return { ok: true, error: null }
      }
      if (result.outcome === 'failed') {
        console.warn(
          `[BlueprintDerive] derive failed for ${rootPath} (${candidate.id}): ${result.reason}`,
        )
        return { ok: false, error: result.reason }
      }
      lastMiss = result.reason
    }
    console.warn(`[BlueprintDerive] no usable CLI for ${rootPath}: ${lastMiss}`)
    return { ok: false, error: lastMiss }
  }

  private spawnOnce(rootPath: string, candidate: DeriveCommand): Promise<SpawnOutcome> {
    return new Promise((resolve) => {
      let stderrTail = ''
      let settled = false
      let timer: NodeJS.Timeout | null = null
      const settle = (outcome: SpawnOutcome): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(outcome)
      }

      const child = this.spawnFn(candidate.command, candidate.args, {
        cwd: rootPath,
        stdio: ['ignore', 'ignore', 'pipe'],
        ...(candidate.env ? { env: { ...process.env, ...candidate.env } } : {}),
      })

      timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle({ outcome: 'failed', reason: 'Derive timed out after 60s' })
      }, DERIVE_TIMEOUT_MS)

      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS)
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        // Could not start at all (ENOENT/EACCES) — resolution miss, not a
        // derive failure: the runner moves on to the next candidate.
        settle({ outcome: 'unavailable', reason: error.message })
      })
      child.on('close', (code) => {
        if (code === 0) {
          settle({ outcome: 'ok' })
        } else {
          settle({
            outcome: 'failed',
            reason: lastLine(stderrTail) ?? `derive exited with code ${String(code)}`,
          })
        }
      })
    })
  }
}

/** Last non-empty stderr line, trimmed — the one-line reason for the view. */
function lastLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const last = lines[lines.length - 1]
  return last === undefined ? null : last
}
