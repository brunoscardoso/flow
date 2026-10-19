/**
 * THE PANEL LAYOUT FOLLOWS THE THREAD.
 *
 * Each chat thread is its own context, and which panels are open is part of
 * it: put the chat away in thread A, open thread B — B starts from what was on
 * screen (no jump) and then keeps its own — and going back to A brings A's
 * arrangement back. Across a restart too, which is why this spec relaunches.
 *
 * Before this, the layout was ONE per-project value: whatever the last thread
 * did, every thread of the project showed.
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

/** Long enough to outlast the shell's 200 ms layout-save debounce. */
const SAVE_SETTLE_MS = 600

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
      FLOW_E2E_BACKGROUND: '1',
      DISABLE_AUTO_UPDATE: 'true',
    },
  })
}

async function firstWindow(app: ElectronApplication): Promise<Page> {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return win
}

/** Close any settings / onboarding overlay that would swallow clicks. */
async function dismissOverlays(win: Page): Promise<void> {
  const overlay = win.locator('.fl-settings-overlay:not([hidden])')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await overlay.waitFor({ state: 'visible', timeout: 2000 })
    } catch {
      return
    }
    const skip = overlay.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
    if (await skip.count()) await skip.first().click()
    else await win.keyboard.press('Escape')
    await overlay.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined)
  }
}

const chat = (win: Page) => win.locator('[data-panel-id="conversation"]')

/** The thread the app has recorded as open — the positive proof that a click
 *  actually switched threads, so an unchanged layout is evidence, not a no-op. */
async function openThreadId(win: Page): Promise<string | null> {
  return win.evaluate(async () => {
    const context = await (window as unknown as {
      flow: { project: { active(): Promise<{ activeThreadId?: string | null } | null> } }
    }).flow.project.active()
    return context?.activeThreadId ?? null
  })
}

/** Open a thread the way a person does: click its row in the Threads pane. */
async function openThread(win: Page, title: string, id: string): Promise<void> {
  const row = win
    .locator('.fl-thread-sidebar .row', { has: win.locator(`span[title="${title}"]`) })
    .first()
  await row.click()
  await expect.poll(() => openThreadId(win), { timeout: 10_000 }).toBe(id)
}

async function toggleChat(win: Page): Promise<void> {
  await win.keyboard.press('ControlOrMeta+Alt+KeyC')
}

test('each thread keeps its own panel layout, across switches and a restart', async () => {
  test.setTimeout(300_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-thread-layout-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'flow-thread-layout-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: projectDir })
  writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\nloops/\n')
  execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: projectDir })
  writeFileSync(join(projectDir, 'a.ts'), 'export const a = 1\n')
  // A configured project does not open its settings overlay on every launch.
  mkdirSync(join(projectDir, 'flow'), { recursive: true })
  writeFileSync(join(projectDir, 'flow', '.flowconfig'), 'autopilot: false\ncommit: false\npush: false\n')
  execFileSync('git', ['add', '-A'], { cwd: projectDir })
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: projectDir })

  let app: ElectronApplication | null = null
  try {
    app = await launch(userDataDir)
    let win = await firstWindow(app)
    await dismissOverlays(win)
    const ids = await win.evaluate(async (p: string) => {
      const flow = (window as unknown as {
        flow: {
          project: {
            add(r: { path: string }): Promise<unknown>
            setActive(r: { rootPath: string }): Promise<unknown>
          }
          threads: { create(r: { projectRoot: string; title: string }): Promise<{ id: string }> }
        }
      }).flow
      await flow.project.add({ path: p })
      await flow.project.setActive({ rootPath: p })
      const a = await flow.threads.create({ projectRoot: p, title: 'Thread A' })
      const b = await flow.threads.create({ projectRoot: p, title: 'Thread B' })
      return { a: a.id, b: b.id }
    }, projectDir)
    await dismissOverlays(win)

    // ── A: put the chat away ────────────────────────────────────────────────
    await openThread(win, 'Thread A', ids.a)
    await expect(chat(win)).toBeVisible()
    await toggleChat(win)
    await expect(chat(win)).toHaveCount(0)

    // ── B: a new thread starts from what is on screen — no jump ─────────────
    await openThread(win, 'Thread B', ids.b)
    await expect(chat(win)).toHaveCount(0)
    // …and then diverges: B brings its chat back.
    await toggleChat(win)
    await expect(chat(win)).toBeVisible()

    // ── back to A: A's own arrangement, not B's ─────────────────────────────
    await openThread(win, 'Thread A', ids.a)
    await expect(chat(win)).toHaveCount(0)
    // …and B still has its own.
    await openThread(win, 'Thread B', ids.b)
    await expect(chat(win)).toBeVisible()
    await win.waitForTimeout(SAVE_SETTLE_MS)

    // ── restart: the app reopens B with B's layout, and A still has A's ─────
    await app.close()
    app = await launch(userDataDir)
    win = await firstWindow(app)
    await dismissOverlays(win)
    await expect(win.locator('.fl-composer')).toBeVisible({ timeout: 60_000 })
    expect(await openThreadId(win)).toBe(ids.b)
    await expect(chat(win)).toBeVisible()
    await openThread(win, 'Thread A', ids.a)
    await expect(chat(win)).toHaveCount(0)
  } finally {
    if (app !== null) await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    removeTempDir(projectDir)
  }
})
