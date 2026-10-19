/**
 * Launch control for the perf probes.
 *
 * The shared fixture launches once per test and hides the launch itself, which
 * is the half of startup the complaint is about ("i click on the input when the
 * app open"). These probes need to time the launch, and to relaunch against a
 * userData directory that already has a project in it — a cold profile measures
 * a state no returning user is ever in.
 */
import { _electron as electron, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { liveRoot, noLiveProject } from '../fixtures/live-root'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

/** A real repo, cloned once and reused: 4,182 files with a full history — the
 *  size of thing people actually open. A ten-file fixture measures nothing. */
export const PERF_REPO = join(tmpdir(), 'flow-perf-repo')
// Whose repo it clones is the runner's business, not this file's.
const SOURCE_REPO = liveRoot()

/**
 * No live project SKIPS the probe, as the fixture promises — it does not fail
 * it. A throw here turned every perf probe red on any machine without
 * FLOW_LIVE_PROJECT set, which is the default; and the cached clone cannot
 * cover for it, because global-setup sweeps every `flow-*` temp dir at start.
 */
export function ensurePerfRepo(): string {
  if (existsSync(join(PERF_REPO, '.git'))) return PERF_REPO
  test.skip(SOURCE_REPO === '', `${noLiveProject()} to clone the perf repo from`)
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '-q', SOURCE_REPO, PERF_REPO])
  return PERF_REPO
}

/**
 * `count` sibling repos, for the profile people actually have.
 *
 * One project measures a tidy case. The stall reports this work chases came
 * from somebody with several open at once, where every watcher, every git
 * process and every provisioning pass is multiplied by the number of things
 * they are working on. Cloned with hardlinks — cheap on disk, real to git.
 */
export function ensurePerfRepos(count: number): string[] {
  const first = ensurePerfRepo()
  const repos = [first]
  for (let i = 1; i < count; i += 1) {
    const path = `${PERF_REPO}-${String(i)}`
    if (!existsSync(join(path, '.git'))) {
      execFileSync('git', ['clone', '--local', '-q', first, path])
    }
    repos.push(path)
  }
  return repos
}

export interface Launched {
  app: ElectronApplication
  window: Page
  /** Wall-clock from before launch to the first window being handed over. */
  launchMs: number
}

/** Launch the built app against `userDataDir`, timing the launch itself.
 *  `inspectPort` opens main's inspector so a probe can take a real CPU
 *  profile — see `profiler.ts`; without it nothing is exposed. */
export async function launch(userDataDir: string, inspectPort?: number): Promise<Launched> {
  mkdirSync(userDataDir, { recursive: true })
  const started = Date.now()
  const app = await electron.launch({
    args: [
      ...(inspectPort === undefined ? [] : [`--inspect=${String(inspectPort)}`]),
      MAIN_ENTRY,
      `--user-data-dir=${userDataDir}`,
    ],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { app, window, launchMs: Date.now() - started }
}

/** Close an app without letting a hung quit fail the measurement. */
export async function close(app: ElectronApplication): Promise<void> {
  let pid: number | undefined
  try {
    pid = app.process().pid
  } catch {
    return
  }
  await Promise.race([app.close(), new Promise((resolve_) => setTimeout(resolve_, 15_000))])
  try {
    process.kill(pid, 0)
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone — the graceful close worked
  }
}

/** The app's own startup marks, as it recorded them about itself. */
export function startupMarks(userDataDir: string): string[] {
  return slowLines(userDataDir).filter(
    (line) =>
      line.includes('startup') || line.includes('window shown') || line.includes('bootstrap'),
  )
}

/** Every slow line the app recorded — what it blamed while we were watching. */
export function slowLines(userDataDir: string): string[] {
  try {
    return readFileSync(join(userDataDir, 'logs', 'slow.log'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => line.replace(/^\S+\s/, ''))
  } catch {
    return []
  }
}

export function freshUserData(name: string): string {
  const dir = join(tmpdir(), `flow-perf-${name}-${String(process.pid)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/** One aligned table, the same shape the jest probes print. */
export function printTable(title: string, rows: Record<string, number | string>): void {
  const width = Math.max(...Object.keys(rows).map((k) => k.length))
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
  for (const [name, value] of Object.entries(rows)) {
    const shown = typeof value === 'number' ? `${String(Math.round(value))}ms` : value
    console.log(`${name.padEnd(width)}  ${shown.padStart(9)}`)
  }
  console.log('')
}

/**
 * Dismiss the first-run wizard.
 *
 * A fresh profile opens onboarding over the shell, which intercepts every
 * click — including the one this probe is timing. Not part of the measurement:
 * the returning user we are measuring saw it once, months ago.
 */
export async function dismissOnboarding(window: Page): Promise<void> {
  const wizard = window.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if ((await wizard.count()) === 0) return
  const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
  if (await skip.count()) await skip.first().click()
  else await window.keyboard.press('Escape')
  await wizard.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined)
}

/**
 * Fill a thread with the traffic of a long working session.
 *
 * Tool calls have no IPC creator — nothing outside an agent turn makes one — so
 * this writes them where they live. Through node:sqlite, NOT the app's
 * better-sqlite3: that binary is built for the Electron ABI and cannot load in
 * the plain Node a spec runs in. The built-in needs no binding at all.
 *
 * The app must be CLOSED when this runs; two writers on one SQLite file is a
 * lock, not a seed.
 *
 * The mix mirrors the live measurement this work started from: 8 KB outputs,
 * one call in five a Write carrying a whole file.
 */
export function seedHeavyThread(userDataDir: string, threadId: string, calls: number): number {
  // Ids are scoped to the thread — seeding two threads in one profile must not
  // collide on a primary key.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { run(...args: unknown[]): void }
      exec(sql: string): void
      close(): void
    }
  }
  const db = new DatabaseSync(join(userDataDir, 'flow.db'))
  const output = JSON.stringify({ content: 'x'.repeat(8 * 1024) })
  const write = JSON.stringify({
    file_path: '/repo/src/deep/file.ts',
    content: 'y'.repeat(14 * 1024),
  })
  const insert = db.prepare(
    `INSERT INTO tool_calls (id, thread_id, message_id, tool_name, input_json, output_json, status, started_at, completed_at)
     VALUES (?, ?, NULL, ?, ?, ?, 'success', ?, ?)`,
  )
  db.exec('BEGIN')
  const base = Date.parse('2026-01-01T00:00:00.000Z')
  for (let i = 0; i < calls; i += 1) {
    const at = new Date(base + i * 1000).toISOString()
    insert.run(
      `perf-call-${threadId}-${String(i)}`,
      threadId,
      i % 5 === 0 ? 'Write' : 'Read',
      i % 5 === 0 ? write : JSON.stringify({ file_path: `/repo/src/file-${String(i)}.ts` }),
      output,
      at,
      at,
    )
  }
  db.exec('COMMIT')
  db.close()
  return calls
}
