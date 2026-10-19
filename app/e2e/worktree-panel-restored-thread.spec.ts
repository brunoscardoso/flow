/**
 * THE PANEL AFTER A RESTART, WHICH IS HOW PEOPLE ACTUALLY MEET IT.
 *
 * Every other worktree spec opens a conversation by dispatching
 * `flow:open-thread` — i.e. AFTER boot, with every listener already attached.
 * A person launches the app instead, and the app restores the conversation they
 * were last in. The panel only ever learned which conversation it was looking
 * at from the `flow:active-thread` DOM event, and that event is fired by
 * `initThreads` — which runs BEFORE `initWorktrees` registers the listener for
 * it. A signal fired before anyone is listening is not a signal.
 *
 * The visible result is a control that opens a panel saying "Open a
 * conversation to manage its worktree" over a conversation that is open
 * (user, 2026-09-17: "STILL NOT THERE").
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { removeTempDir } from './ux/fixtures/seed'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MAIN_ENTRY = resolve(__dirname, '../out/main/index.js')

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

async function firstWindow(app: ElectronApplication): Promise<Page> {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return win
}

/**
 * The per-project settings overlay opens over a project the app has not been
 * configured for, on EVERY launch, and it intercepts every click. A single
 * un-waited Escape races it; this waits for it, dismisses it, and checks.
 */
async function dismissSettings(win: Page): Promise<void> {
  const overlay = win.locator('.fl-settings-overlay:not([hidden])')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await overlay.waitFor({ state: 'visible', timeout: 2000 })
    } catch {
      return // not up (any more)
    }
    await win.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined)
  }
}

test('a conversation RESTORED at launch still gets a worktree panel', async () => {
  test.setTimeout(300_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-wt-restore-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'flow-wt-restore-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: projectDir })
  writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\nloops/\n')
  execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: projectDir })
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: projectDir })
  writeFileSync(join(projectDir, 'a.ts'), 'export const a = 1\n')
  // A project with no .flowconfig auto-opens the per-project settings overlay on
  // EVERY launch, and it intercepts every click. This spec relaunches, so it
  // would meet that overlay twice; giving the project a config is how the app
  // itself stops asking.
  mkdirSync(join(projectDir, 'flow'), { recursive: true })
  writeFileSync(
    join(projectDir, 'flow', '.flowconfig'),
    'autopilot: false\ncommit: false\npush: false\n',
  )
  execFileSync('git', ['add', '-A'], { cwd: projectDir })
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: projectDir })

  let app: ElectronApplication | null = null
  try {
    app = await launch(userDataDir)
    let win = await firstWindow(app)
    await win.evaluate(async (p: string) => {
      const flow = (window as unknown as {
        flow: {
          project: {
            add(r: { path: string }): Promise<unknown>
            setActive(r: { rootPath: string }): Promise<unknown>
            setActiveThread(r: { rootPath: string; threadId: string | null }): Promise<unknown>
          }
          threads: { create(r: { projectRoot: string; title: string }): Promise<{ id: string }> }
        }
      }).flow
      await flow.project.add({ path: p })
      await flow.project.setActive({ rootPath: p })
      const thread = await flow.threads.create({ projectRoot: p, title: 'Restored conversation' })
      // THROUGH THE SAME DOOR THE RESTORE READS. Clicking the row would do it
      // too, but the per-project settings overlay opens over a project with no
      // .flowconfig and swallows the click; what this spec is about is the
      // NEXT launch, so it states the persisted fact directly.
      await flow.project.setActiveThread({ rootPath: p, threadId: thread.id })
    }, projectDir)
    await dismissSettings(win)

    // …and now the app is closed and opened again, which is the whole point.
    await app.close()
    app = await launch(userDataDir)
    win = await firstWindow(app)
    await expect(win.locator('.fl-composer')).toBeVisible({ timeout: 60_000 })
    await dismissSettings(win)

    await win.evaluate(() => {
      document.dispatchEvent(new CustomEvent('flow:reveal-sidebar', { detail: { rail: 'files' } }))
    })
    // The positive first: the panel is on screen at all — with nothing pressed…
    await expect(win.locator('.fl-wt')).toBeVisible({ timeout: 30_000 })
    // …and it is the panel for THIS conversation, not the empty state that
    // tells a reader to open one.
    await expect(win.locator('.fl-wt-empty')).toHaveCount(0)
    await expect(win.locator('.fl-wt-track')).toBeVisible({ timeout: 30_000 })
  } finally {
    if (app !== null) await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    removeTempDir(projectDir)
  }
})
