/**
 * Tasks board — the technical brief's PENDING state (flow 9 of the progressive
 * UX sweep, round 16).
 *
 * The board's detail modal is the ONLY surface in the app that can start a brief
 * (`tasks.generateBrief` has exactly one renderer caller: kanban-board.ts:441).
 * `generateTaskBrief` persists `brief_status = 'pending'` up front and only flips
 * it to ready/error when the in-process LLM call resolves — so a generation that
 * is interrupted (app quit, crash, force-quit) leaves `pending` written to SQLite
 * with nothing left running and no boot-time recovery.
 *
 *   1. LIVE GUARD — a description-less task shows the #362 hint instead of a
 *      dead "Generate technical brief" button, and a task WITH a description
 *      gives immediate feedback when the button is pressed (the state leaves
 *      "No brief yet." rather than sitting there like a dead click).
 *   2. #1026 (was a `test.fixme` tripwire, now live) — quit while a brief is
 *      pending, relaunch, and the detail modal must not be a dead end: either the
 *      status resolved, or the section offers a way to act (Retry / Regenerate /
 *      Generate). It used to show "Generating a technical brief…" forever with
 *      only Close / Open chat; `TaskStore.reconcileInterruptedBriefs()` now sweeps
 *      the stale `pending` row to `idle` at startup.
 *
 * Both are account-independent: `pending` is written by the main process before
 * the generator is ever called, so the tripwire's precondition holds with or
 * without a Claude account (it skips itself, rather than passing vacuously, if
 * the generation resolves before the quit).
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const SCREENS = 'e2e/ux/__screens'

const DESCRIPTION =
  'The sync engine retries every failed batch immediately, which hammers the API on an ' +
  'outage. We want exponential backoff with jitter, a circuit breaker after 5 consecutive ' +
  'failures, and a visible "paused — retrying in Ns" state in the UI.'

interface BriefRow {
  id: string
  title: string
  briefStatus: string
}

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

async function dismissOnboarding(win: Page): Promise<void> {
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if ((await wizard.count()) === 0) return
  const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
  if (await skip.count()) await skip.first().click()
  else await win.keyboard.press('Escape')
  await expect(wizard).toHaveCount(0)
}

/** A repo carrying flow/.flowconfig so activating it doesn't auto-open the
 *  per-project settings overlay (whose Escape would also close board modals). */
function mkRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'flow'), { recursive: true })
  writeFileSync(join(dir, 'flow', '.flowconfig'), 'autopilot: false\n')
  return dir
}

async function openProject(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    const w = window as unknown as {
      flow: {
        project: {
          add(r: { path: string }): Promise<unknown>
          setActive(r: { rootPath: string }): Promise<unknown>
        }
      }
    }
    await w.flow.project.add({ path: p })
    await w.flow.project.setActive({ rootPath: p })
  }, dir)
  await win.waitForTimeout(900)
  const overlay = win.locator('.fl-settings-overlay:not([hidden])')
  for (let i = 0; i < 3 && (await overlay.count()) > 0; i++) {
    await win.keyboard.press('Escape')
    await win.waitForTimeout(300)
  }
}

async function createTask(win: Page, root: string, title: string, description?: string): Promise<string> {
  return win.evaluate(
    async ([p, t, d]) => {
      const w = window as unknown as {
        flow: {
          tasks: {
            create(a: {
              projectRoot: string
              title: string
              description?: string
            }): Promise<{ id: string }>
          }
        }
      }
      const task = await w.flow.tasks.create({
        projectRoot: p as string,
        title: t as string,
        description: (d as string) || undefined,
      })
      return task.id
    },
    [root, title, description ?? ''],
  )
}

async function briefRows(win: Page, root: string): Promise<BriefRow[]> {
  return win.evaluate(async (p) => {
    const w = window as unknown as {
      flow: { tasks: { list(a: { projectRoot: string; includeArchived: boolean }): Promise<BriefRow[]> } }
    }
    return w.flow.tasks.list({ projectRoot: p, includeArchived: false })
  }, root) as Promise<BriefRow[]>
}

async function openBoard(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-board')))
  await expect(win.locator('.fl-board')).toBeVisible()
}

/** The brief section's text + every control it offers. */
async function briefSection(win: Page): Promise<{ text: string; controls: string[] }> {
  return win.evaluate(() => {
    const section = [...document.querySelectorAll('.fl-board-detail-section')].find((s) =>
      /TECHNICAL BRIEF/i.test((s as HTMLElement).innerText),
    ) as HTMLElement | undefined
    if (!section) return { text: '', controls: [] }
    return {
      text: section.innerText,
      controls: [...section.querySelectorAll('button')].map((b) => (b as HTMLElement).innerText.trim()),
    }
  })
}

test.describe('tasks board — technical brief pending state', () => {
  test('the Generate control gives feedback, and a content-less task gets the hint (#362)', async () => {
    test.setTimeout(120_000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-brief-live-'))
    const repo = mkRepo('flow-ux-brief-live-')
    const app = await launch(userDataDir)
    try {
      const win = await app.firstWindow()
      const errors: string[] = []
      win.on('pageerror', (e) => errors.push(String(e)))
      await win.waitForLoadState('domcontentloaded')
      await dismissOnboarding(win)
      await openProject(win, repo)

      // (a) Title-only task: generateBrief can never succeed, so the modal must
      //     show the hint rather than a button that does nothing (#362).
      await createTask(win, repo, 'Title only, no body')
      await openBoard(win)
      await win.locator('.fl-board-card', { hasText: 'Title only, no body' }).click()
      await expect(win.locator('.fl-board-detail')).toBeVisible()
      const bare = await briefSection(win)
      expect(bare.text).toContain('Add a description to generate a technical brief.')
      expect(bare.controls).toHaveLength(0)
      await win.keyboard.press('Escape')

      // (b) A task with real content offers the button, and pressing it leaves
      //     the "No brief yet." state immediately — the main process writes
      //     `pending` before the generator runs, so this holds with or without a
      //     Claude account (an account-less run lands on the error+Retry state).
      await createTask(win, repo, 'Refactor the sync engine', DESCRIPTION)
      await openBoard(win)
      await win.locator('.fl-board-card', { hasText: 'Refactor the sync engine' }).click()
      await expect(win.locator('.fl-board-detail')).toBeVisible()
      const idle = await briefSection(win)
      expect(idle.text).toContain('No brief yet.')
      expect(idle.controls).toContain('Generate technical brief')

      await win.locator('.fl-board-detail-link', { hasText: 'Generate technical brief' }).click()
      await expect
        .poll(async () => (await briefSection(win)).text, { timeout: 15_000 })
        .not.toContain('No brief yet.')
      const after = await briefSection(win)
      // Whatever it reached, the user is not left staring at a dead control:
      // either it reports progress, or it offers an action.
      expect(
        /Generating a technical brief/.test(after.text) || after.controls.length > 0,
      ).toBe(true)

      expect(errors).toEqual([])
    } finally {
      await app.close()
      rmSync(userDataDir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test(
    'a brief interrupted by a quit is not a permanent "Generating…" dead end (#1026)',
    async () => {
      test.setTimeout(180_000)
      const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-brief-quit-'))
      const repo = mkRepo('flow-ux-brief-quit-')
      let app = await launch(userDataDir)
      try {
        let win = await app.firstWindow()
        await win.waitForLoadState('domcontentloaded')
        await dismissOnboarding(win)
        await openProject(win, repo)

        // Start a generation and quit while it is still in flight — exactly what
        // happens when a user imports an issue (which auto-generates) and closes
        // the app, or when it crashes, within the multi-second LLM call.
        const taskId = await createTask(win, repo, 'Refactor the sync engine', DESCRIPTION)
        await win.evaluate(async (id) => {
          const w = window as unknown as {
            flow: { tasks: { generateBrief(a: { taskId: string }): Promise<unknown> } }
          }
          void w.flow.tasks.generateBrief({ taskId: id })
        }, taskId)
        await win.waitForTimeout(500)

        const before = (await briefRows(win, repo)).find((r) => r.id === taskId)
        // Non-vacuous: skip rather than pass if the call already resolved.
        test.skip(before?.briefStatus !== 'pending', 'brief resolved before the quit')
        await app.close()

        app = await launch(userDataDir)
        win = await app.firstWindow()
        const errors: string[] = []
        win.on('pageerror', (e) => errors.push(String(e)))
        await win.waitForLoadState('domcontentloaded')
        await dismissOnboarding(win)
        await win.waitForTimeout(2500)

        await openBoard(win)
        await win.locator('.fl-board-card', { hasText: 'Refactor the sync engine' }).click()
        await expect(win.locator('.fl-board-detail')).toBeVisible()
        // Give any recovery a generous window to land.
        await win.waitForTimeout(10_000)
        await win.screenshot({ path: `${SCREENS}/tasks-brief-pending-after-relaunch.png` })

        const row = (await briefRows(win, repo)).find((r) => r.id === taskId)
        const section = await briefSection(win)
        // Either the interrupted generation was recovered (resolved to ready or
        // error), or the modal offers the user a way to act on it. What must not
        // happen is a permanent "Generating…" with no control at all.
        const resolved = row?.briefStatus === 'ready' || row?.briefStatus === 'error'
        expect(
          resolved || section.controls.length > 0,
          `brief is a dead end: status=${row?.briefStatus} section=${JSON.stringify(section)}`,
        ).toBe(true)
        expect(errors).toEqual([])
      } finally {
        await app.close()
        rmSync(userDataDir, { recursive: true, force: true })
        rmSync(repo, { recursive: true, force: true })
      }
    },
  )
})
