/**
 * UX regression probe — flow 2 (Threads: create / search / select / delete), round 18.
 *
 * Flow 2 is one of the most-swept flows (31 committed specs: search filter,
 * archived search, rename-under-search, overflow, collapsed groups, multiselect,
 * pin/unpin, delete-non-open, empty state, multi-project picker, selection
 * follows the active project…). Every one of them asks whether the LIST is
 * right. This probe asks the two questions nobody had asked:
 *
 *  1. When a destructive project action quotes a COUNT of threads it is about
 *     to destroy, is that count the number it actually destroys? The sidebar's
 *     `#confirmRemoveProject` derives its count from `this.#threads`, which is
 *     the SEARCH RESULT SET whenever the search box is non-empty — while
 *     `project:remove` cascades over every thread of the root in the
 *     main process. Filter to 1 of 6, confirm "delete its 1 thread?", lose 6.
 *
 *  2. Does a quit/relaunch put you back in the conversation you were in? The
 *     app persists `workspace_state.active_thread_id` per project, and
 *     `renderer/threads/index.ts` restores it on every `activeProjectChanged`
 *     — a comment there names "boot restore" as one of its triggers. But
 *     `initThreads` never reads the CURRENT context at startup, so the boot
 *     activation (main/index.ts ~1250) is missed and the chat comes up empty.
 *     Same mechanism as #516 (story card never read the initial project bind).
 *
 * Live guards (green on main) establish the controls; the tripwires encode
 * the two defects fix-agnostically ('relaunch reopens the conversation' went
 * live with the #1083 fix — initThreads now reads the initial context).
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const SCREENS = 'e2e/ux/__screens'

// ── harness ────────────────────────────────────────────────────────────────

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

/** No account is ever connected here, so the first-run wizard opens on EVERY boot. */
async function dismissOnboarding(win: Page): Promise<void> {
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if ((await wizard.count()) === 0) return
  const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
  if (await skip.count()) await skip.first().click()
  else await win.keyboard.press('Escape')
  await expect(wizard).toHaveCount(0)
}

/** Boot mounts the wizard AND the per-project flow-settings overlay
 *  asynchronously; dismiss until nothing re-appears for a quiet window. */
async function settleOverlays(win: Page): Promise<void> {
  const overlay = win.locator('.fl-settings-overlay:not([hidden])')
  for (let i = 0; i < 6; i++) {
    if ((await overlay.count()) === 0) {
      await win.waitForTimeout(500)
      if ((await overlay.count()) === 0) return
    }
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
  }
}

function mkRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'seed\n')
  return dir
}

async function addRoot(win: Page, path: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (window as unknown as FlowWindow).flow.project.add({ path: p })
  }, path)
}

async function activate(win: Page, rootPath: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (window as unknown as FlowWindow).flow.project.setActive({ rootPath: p })
  }, rootPath)
}

interface FlowWindow {
  flow: {
    project: {
      add(r: { path: string }): Promise<unknown>
      setActive(r: { rootPath: string }): Promise<{ activeThreadId?: string | null } | null>
      active(): Promise<{ rootPath: string; activeThreadId: string | null } | null>
    }
    threads: {
      create(r: { projectRoot: string; title: string }): Promise<{ id: string }>
      list(r: {
        projectRoot?: string
        includeArchived?: boolean
      }): Promise<Array<{ id: string; title: string; archivedAt: string | null }>>
    }
  }
}

async function makeThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const t = await (window as unknown as FlowWindow).flow.threads.create({
        projectRoot: root,
        title,
      })
      return t.id
    },
    { root, title },
  )
}

async function threadTitles(win: Page, root: string): Promise<string[]> {
  return win.evaluate(
    async (r) =>
      (
        await (window as unknown as FlowWindow).flow.threads.list({
          projectRoot: r,
          includeArchived: true,
        })
      ).map((t) => t.title),
    root,
  )
}

function searchBox(win: Page) {
  return win.locator('input[aria-label="Search threads"]')
}

function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}

/** Right-click the project group header to open its ⋯ menu. */
async function openProjectMenu(win: Page, label: string) {
  await win.locator('fl-list').getByText(label, { exact: false }).first().click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  return menu
}

/** Open the remove confirmation and return its exact prompt text. */
async function removeConfirmText(win: Page, label: string): Promise<string> {
  const menu = await openProjectMenu(win, label)
  await menu.locator('.fl-thread-menu-item', { hasText: 'Remove from sidebar' }).first().click()
  return (await win.locator('.fl-thread-menu-confirm').innerText()).trim()
}

/** "…delete its 4 threads?" → 4 ("…from the sidebar?" → 0). */
function countedThreads(prompt: string): number {
  const m = prompt.match(/(\d+)\s+threads?/)
  return m ? Number(m[1]) : 0
}

const TITLES = [
  'Zeta migration notes',
  'Zeta auth rework',
  'Zeta billing spike',
  'Zeta infra cleanup',
  'Omega needle thread',
  'Zeta perf tuning',
]

/** Seed one project with six threads and return [win, app, repo, label]. */
async function bootWithThreads(userDataDir: string, repo: string) {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await dismissOnboarding(win)
  await addRoot(win, repo)
  await activate(win, repo)
  await win.waitForTimeout(1200)
  await settleOverlays(win)
  for (const title of TITLES) await makeThread(win, repo, title)
  await win.waitForTimeout(900)
  return { app, win }
}

// ── 1. counted confirmation vs the search filter ───────────────────────────

/** Composer bound + the row rendered as the active one. */
async function chatBinding(win: Page) {
  return win.evaluate(() => {
    const composer = document.querySelector('.fl-composer') as HTMLElement | null
    const list = document.querySelector('fl-list') as (HTMLElement & { shadowRoot?: ShadowRoot }) | null
    const scope: ParentNode | null = list?.shadowRoot ?? list
    const rows = Array.from(scope?.querySelectorAll('[class*=row]') ?? []) as HTMLElement[]
    return {
      composerVisible: composer ? getComputedStyle(composer).display !== 'none' : false,
      active: rows
        .filter((r) => {
          const title = r.querySelector('span[title]')
          return title ? getComputedStyle(title).fontWeight === '500' : false
        })
        .map((r) => (r.textContent ?? '').trim().slice(0, 24)),
    }
  })
}

test('CONTROL: switching projects away and back restores the thread you were in', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-thrsw-'))
  const repoA = mkRepo('flow-thr-swA-')
  const repoB = mkRepo('flow-thr-swB-')
  let app: ElectronApplication | null = null
  try {
    app = await launch(userDataDir)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await dismissOnboarding(win)
    await addRoot(win, repoA)
    await addRoot(win, repoB)
    await activate(win, repoA)
    await win.waitForTimeout(1200)
    await settleOverlays(win)
    await makeThread(win, repoA, 'Alpha restore me')
    await makeThread(win, repoB, 'Beta elsewhere')
    await win.waitForTimeout(900)

    await threadRow(win, 'Alpha restore me').first().click()
    await win.waitForTimeout(1000)
    const bound = await chatBinding(win)
    expect(bound.composerVisible).toBe(true)
    expect(bound.active.join(' ')).toContain('Alpha restore me')

    // Away…
    await threadRow(win, 'Beta elsewhere').first().click()
    await win.waitForTimeout(1000)
    // …and back, via the project (never the thread row).
    await activate(win, repoA)
    await win.waitForTimeout(1500)
    await settleOverlays(win)
    const restored = await chatBinding(win)
    expect(restored.composerVisible).toBe(true)
    expect(restored.active.join(' ')).toContain('Alpha restore me')
  } finally {
    await app?.close().catch(() => undefined)
    for (const d of [repoA, repoB, userDataDir]) rmSync(d, { recursive: true, force: true })
  }
})

test('LIVE FACT: the last-active thread is persisted and readable at boot', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-thrp-'))
  const repo = mkRepo('flow-thr-persist-')
  let app: ElectronApplication | null = null
  try {
    app = await launch(userDataDir)
    let win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await dismissOnboarding(win)
    await addRoot(win, repo)
    await activate(win, repo)
    await win.waitForTimeout(1200)
    await settleOverlays(win)
    const alphaId = await makeThread(win, repo, 'Alpha restore me')
    await makeThread(win, repo, 'Beta other')
    await win.waitForTimeout(900)
    await threadRow(win, 'Alpha restore me').first().click()
    await win.waitForTimeout(1200)
    await app.close()
    app = null

    app = await launch(userDataDir)
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await dismissOnboarding(win)
    await win.waitForTimeout(2500)
    await settleOverlays(win)
    const context = await win.evaluate(async () =>
      (window as unknown as FlowWindow).flow.project.active(),
    )
    // The state IS there after the relaunch — the restore gap is downstream.
    expect(context?.rootPath).toBe(repo)
    expect(context?.activeThreadId).toBe(alphaId)
  } finally {
    await app?.close().catch(() => undefined)
    rmSync(repo, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('relaunch reopens the conversation you were in', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-thrrl-'))
  const repo = mkRepo('flow-thr-relaunch-')
  let app: ElectronApplication | null = null
  try {
    app = await launch(userDataDir)
    let win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await dismissOnboarding(win)
    await addRoot(win, repo)
    await activate(win, repo)
    await win.waitForTimeout(1200)
    await settleOverlays(win)
    await makeThread(win, repo, 'Alpha restore me')
    await makeThread(win, repo, 'Beta other')
    await win.waitForTimeout(900)
    await threadRow(win, 'Alpha restore me').first().click()
    await win.waitForTimeout(1200)
    expect((await chatBinding(win)).composerVisible).toBe(true)
    await win.screenshot({ path: `${SCREENS}/threads-restore-session1.png` })
    await app.close()
    app = null

    app = await launch(userDataDir)
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await dismissOnboarding(win)
    await win.waitForTimeout(2500)
    await settleOverlays(win)
    await win.screenshot({ path: `${SCREENS}/threads-restore-session2.png` })

    const after = await chatBinding(win)
    expect(
      { composer: after.composerVisible, active: after.active.join(' ').includes('Alpha') },
      'relaunch left the chat unbound though workspace_state holds the thread',
    ).toEqual({ composer: true, active: true })
  } finally {
    await app?.close().catch(() => undefined)
    rmSync(repo, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
