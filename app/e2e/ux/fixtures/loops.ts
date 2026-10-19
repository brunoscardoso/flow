/**
 * Seeding + injection helpers for the Loops screen specs.
 *
 * TWO THINGS THESE SPECS MUST NEVER DO, and both are why this file exists:
 *
 *  1. START A REAL RUN. The developer's own loops point at a live GitHub queue
 *     with real open issues, and `claude --bg` would put an agent on it. Every
 *     spec installs `fakeClaude`, which refuses a dispatch outright and answers
 *     the agents read from a fixture instead of the real Claude Code.
 *  2. TOUCH A REAL QUEUE. Every seeded directive uses `queue: ledger` with a
 *     path inside the throwaway project, so nothing any loop verb does can
 *     reach the network or another repo.
 *
 * WHY THE FAKE IS INSTALLED IN MAIN RATHER THAN THE RENDERER. The one fact
 * these specs most need to prove — that a person's own interactive Claude
 * session is never drawn as a loop run — is decided in the MAIN process, in
 * `backgroundRuns`'s `kind === 'background'` filter. Stubbing
 * `window.flow.loops.activity` would jump over exactly the code under test and
 * assert a fixture against itself. So the injection goes in one layer lower:
 * `child_process.spawn` is swapped for one that answers the `claude agents`
 * call, and everything above it — the parse, the filter, the cache, the IPC
 * channel, the screen model, the DOM — is the app's own.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'

/** One seeded directive: what to call it, and what its frontmatter says. */
export interface SeedDirective {
  loop: string
  engine?: 'producer' | 'consumer'
  paused?: boolean
  mission?: string
  /** Frontmatter written verbatim INSTEAD of the generated block — for the broken ones. */
  raw?: string
}

/** Write one `loops/<name>.md` into a seeded project directory. */
export function writeDirective(dir: string, entry: SeedDirective): void {
  mkdirSync(join(dir, 'loops'), { recursive: true })
  const body =
    entry.raw ??
    [
      '---',
      `loop: ${entry.loop}`,
      `engine: ${entry.engine ?? 'producer'}`,
      `paused: ${entry.paused === true ? 'true' : 'false'}`,
      `mission: ${entry.mission ?? 'do the thing'}`,
      // A LOCAL LIST, ALWAYS. `queue: github` would make the counts a `gh` round
      // trip against a real repository from a test.
      'queue: ledger',
      'path: flow/loops/queue.jsonl',
      '---',
      '',
      '## Direction',
      '',
      'Seeded by an end-to-end spec.',
      '',
    ].join('\n')
  writeFileSync(join(dir, 'loops', `${entry.loop}.md`), body)
}

/** What the fake `claude agents` call should do when the app makes it. */
export type AgentsBehaviour =
  /** Print this array as JSON and exit 0. */
  | { kind: 'list'; entries: unknown[] }
  /** Print something that is not a JSON array and exit 0. */
  | { kind: 'garbage'; stdout: string }
  /** Start, print nothing, and never exit — the slow read. */
  | { kind: 'hang' }

/**
 * Swap the main process's `spawn` for one that answers Claude Code itself.
 *
 * SAFE BY CONSTRUCTION: a dispatch (`claude --bg …`) is refused rather than
 * delegated, so no spec — present or future — can start a real background agent
 * by pressing the wrong button. Everything that is not a `claude` call still
 * runs for real.
 *
 * The fake child is a REAL process (`electron -e`, as node), so the app's own
 * stdout plumbing, exit handling and timeout all run exactly as they do in
 * production; only the bytes are ours.
 */
export async function fakeClaude(app: ElectronApplication, behaviour: AgentsBehaviour): Promise<void> {
  await app.evaluate((_electron, config: string) => {
    const spec = JSON.parse(config) as AgentsBehaviour
    // THE READ MOVED OFF MAIN, so this stub has to reach it again. The agents
    // read now goes through the CLI host — a utility process with its own
    // `child_process`, where a patch applied here is invisible (review finding
    // H2). This flag puts every run back on the caller's own spawn, which is
    // the fallback the host client already documents for a build without it,
    // and is therefore the same code path production takes when the host is
    // unavailable rather than a path invented for the test.
    process.env['FLOW_E2E_NO_CLI_HOST'] = '1'
    const req = (process as unknown as { mainModule?: { require(id: string): unknown } }).mainModule
      ?.require as (id: string) => typeof import('child_process')
    const cp = req('child_process')
    const holder = globalThis as unknown as {
      __flowRealSpawn?: typeof cp.spawn
      __flowSpawns?: string[][]
    }
    holder.__flowRealSpawn ??= cp.spawn
    holder.__flowSpawns = []
    const real = holder.__flowRealSpawn
    const script =
      spec.kind === 'hang'
        ? 'setTimeout(() => {}, 120000)'
        : `process.stdout.write(${JSON.stringify(
            spec.kind === 'garbage' ? spec.stdout : JSON.stringify(spec.entries),
          )})`
    ;(cp as unknown as { spawn: unknown }).spawn = (
      bin: string,
      args: string[],
      opts: Record<string, unknown>,
    ) => {
      holder.__flowSpawns?.push([bin, ...(Array.isArray(args) ? args : [])])
      if (Array.isArray(args) && args[0] === '--bg') {
        // NEVER, under any circumstances. A real dispatch puts an agent on the
        // developer's live queue; a spec that reaches here is a spec with a bug.
        throw new Error('e2e: refused to dispatch a real background agent')
      }
      if (Array.isArray(args) && args[0] === 'agents') {
        return (real as unknown as (...a: unknown[]) => unknown)(
          process.execPath,
          ['-e', script],
          { ...opts, env: { ...(opts['env'] as object), ELECTRON_RUN_AS_NODE: '1' } },
        )
      }
      return (real as unknown as (...a: unknown[]) => unknown)(bin, args, opts)
    }
  }, JSON.stringify(behaviour))
}

/** Every process the main process has spawned since `fakeClaude` was installed. */
export async function spawnedSince(app: ElectronApplication): Promise<string[][]> {
  return app.evaluate(() => {
    const holder = globalThis as unknown as { __flowSpawns?: string[][] }
    return holder.__flowSpawns ?? []
  })
}

/** Forget what has been spawned so far — so a spec can measure ONE read. */
export async function clearSpawns(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const holder = globalThis as unknown as { __flowSpawns?: string[][] }
    holder.__flowSpawns = []
  })
}

/**
 * The Loops SCREEN is gone (2026-09-04) and so is the event that opened it.
 * Its two jobs moved to where the decisions are made: a hunt is configured on
 * the work that prompts it, and the one standing loop is started and stopped
 * from Todo's own column head. `writeDirective` and `fakeClaude` below survive
 * because they seed and fence a project's loops, which every board spec needs.
 */

/**
 * Read the loops directly over the app's own bridge, and time it.
 *
 * FR3 IS A CLAIM ABOUT COST, so the proof has to be a measurement. The read
 * this replaced booted a fresh CLI runtime per call — the handler's own log line
 * reads `loops:read handled in 2,103ms`.
 */
export async function timedRead(
  win: Page,
  rootPath: string,
): Promise<{ ms: number; loops: string[]; available: boolean }> {
  return win.evaluate(async (root: string) => {
    const api = (
      window as unknown as {
        flow: {
          loops: {
            read(request: { rootId: string }): Promise<{
              available: boolean
              loops: { loop: string }[]
            }>
          }
        }
      }
    ).flow.loops
    const started = performance.now()
    const snapshot = await api.read({ rootId: root })
    return {
      ms: performance.now() - started,
      loops: snapshot.loops.map((row) => row.loop),
      available: snapshot.available,
    }
  }, rootPath)
}
