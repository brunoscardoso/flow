/**
 * UX sweep — flow 5 (Review), round 21, found while driving it: **does the app
 * quit?**
 *
 * Filed as #1284.
 *
 * Quit is intercepted: `before-quit` prevents the default, runs the async
 * `disposeMainProcess()` and only then re-issues `app.quit()`
 * (`main/index.ts:2082-2098`). Anything in that disposal that never settles
 * means the process never exits — ⌘Q, the Quit menu item, an app restart for an
 * update and every E2E fixture teardown all hang, and the only way out is Force
 * Quit.
 *
 * Measured on `main` (02d4205d): a launch with NO project quits in ~0.2 s; add a
 * single project — with nothing else done, no agent, no editor — and quit never
 * completes (>60 s, `BrowserWindow` evaluation stops answering too). Bisected to
 * ONE file: restoring `src/main/flow/flow-observer.ts` to its pre-#1241 revision
 * (afac74f4) and rebuilding makes the same probe exit in ~0.25 s. #1241 (#1164's
 * fix) adds a SECOND persistent chokidar watcher per root — `rootWatcher` on the
 * project root (`flow-observer.ts:626`) alongside `ProjectRegistry`'s own
 * watcher on that same path — and the quit path awaits
 * `projectRegistry.dispose()` → `Promise.all(watcher.close())`
 * (`project-registry.ts`).
 *
 * FIXED (#1284): `FlowObserver.dispose()` closed the flow/ watcher but never
 * #1241's rootWatcher, leaking one persistent chokidar watcher per open
 * project — and a persistent watcher holds the libuv event loop. The flow IPC
 * teardown is now awaited, and the quit path is bounded so no future disposal
 * can hold ⌘Q hostage either. Both guards are live.
 *
 * Guard 1 is the CONTROL (the no-project quit must stay fast, and it is what
 * makes guard 2 meaningful); guard 2 is the regression. Both specs own their
 * Electron instance
 * (the shared `window` fixture closes the app for you, which is the very thing
 * under test) and force-kill any survivor so the suite can continue.
 */
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { removeTempDir } from './fixtures/seed'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
/** Generous: the whole disposal is timers, watchers and a SQLite close. */
const QUIT_BUDGET_MS = 20_000

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** A throwaway repo with one committed file — the seed every project probe uses. */
function seedRepo(): string {
  const dir = tempDir('flow-quit-repo-')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\n')
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  return dir
}

async function launch(): Promise<{ app: ElectronApplication; userDataDir: string }> {
  const userDataDir = tempDir('flow-quit-ud-')
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const wizard = window.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if (await wizard.count()) {
    const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
    if (await skip.count()) await skip.first().click()
  }
  return { app, userDataDir }
}

/** Quit exactly as the Quit menu item does, then wait for the process to go.
 *  Returns how long it took, or null if it was still alive at the budget. */
async function quitAndAwaitExit(app: ElectronApplication): Promise<number | null> {
  const pid = app.process().pid as number
  const started = Date.now()
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
  while (Date.now() - started < QUIT_BUDGET_MS) {
    await new Promise((resolve_) => setTimeout(resolve_, 250))
    try {
      process.kill(pid, 0)
    } catch {
      return Date.now() - started
    }
  }
  return null
}

/** Never leave an Electron process (or its temp dirs) behind for the next spec. */
function reap(app: ElectronApplication): void {
  try {
    process.kill(app.process().pid as number, 9)
  } catch {
    // Already exited — the good case.
  }
}

test.afterAll(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) removeTempDir(dir)
  }
})

test('CONTROL: with no project open, Quit exits the process', async () => {
  test.setTimeout(120_000)
  const { app } = await launch()
  const ms = await quitAndAwaitExit(app)
  reap(app)
  expect(ms, `the app did not exit within ${QUIT_BUDGET_MS}ms with no project open`).not.toBeNull()
})

test('with a project open, Quit must exit the process too', async () => {
  test.setTimeout(120_000)
  const repo = seedRepo()
  const { app } = await launch()
  const window = await app.firstWindow()
  // The real "Add project" path minus its native folder picker.
  await window.evaluate(async (path) => {
    const api = (window as unknown as { flow: { project: {
      add(request: { path: string }): Promise<unknown>
      setActive(request: { rootPath: string }): Promise<unknown>
    } } }).flow
    await api.project.add({ path })
    await api.project.setActive({ rootPath: path })
  }, repo)
  await window.waitForTimeout(4000) // let the watchers arm

  const ms = await quitAndAwaitExit(app)
  reap(app)
  expect(
    ms,
    `Quit never completed with one project open — the process was still alive after ${QUIT_BUDGET_MS}ms, so ⌘Q leaves the app running and only Force Quit ends it`,
  ).not.toBeNull()
})
