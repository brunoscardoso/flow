import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * UX sweep — flow 7 (Editor): the AGENT-EDIT REVIEW surface, i.e. the inline
 * accept/reject hunk widgets inside Monaco (`renderer/editor/{inline-diff,
 * diff-review-index}.ts`). This is the editor half of "review what the agent
 * changed".
 *
 * The pending-changes strip that used to sit above the tab strip is GONE by
 * design — Source Control lists what is pending, the editor resolves one hunk
 * where the reader can see it. The first guard here pins that removal: a
 * pending change must put NO strip chrome on screen.
 *
 * State arrives on the real `editor:pendingChangesUpdated` channel (the one
 * `EditTracker.emitChanged` broadcasts), sent from the main process exactly as
 * `conversation-permission-card.spec.ts` stages `threads:permissionRequest`.
 * That keeps the probe credential-free; the bugs behind it were first found by
 * driving a live agent Edit turn (#1290 / #1291).
 *
 * Guards:
 *   1. no strip chrome renders for a pending change, and opening the file shows
 *      an inline hunk widget aligned to the line it describes;
 *   2. a resolve click really reaches main and really can fail — the control
 *      that keeps 3 non-vacuous (the button is wired; the IPC rejects);
 *   3. #1291 tripwire — a resolve that fails must tell the user SOMETHING.
 *      Fix-agnostic: any visible feedback surface satisfies it.
 */

const SCREENS = 'e2e/ux/__screens'

const SOURCE = [
  `export function greet(name) {`,
  `  const prefix = 'omega'`,
  `  console.log(prefix + ' ' + name)`,
  `  return prefix`,
  `}`,
  ``,
  ...Array.from({ length: 30 }, (_, i) => `export const filler${i} = ${i}`),
  ``,
].join('\n')

/** A committed repo whose src/logger.js already carries the agent's new line. */
async function seedRepo(win: Page): Promise<string> {
  return seedProject(win, 'flow-ux-editreview-', (dir) => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'logger.js'), SOURCE)
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync(
      'git',
      ['-c', 'user.email=qa@flow', '-c', 'user.name=QA', 'commit', '-qm', 'init'],
      { cwd: dir },
    )
  })
}

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

/**
 * Broadcast one pending agent edit on the real IPC channel — the payload shape
 * `EditTracker.listPendingChanges` produces for an Edit that turned line 2's
 * `'alpha'` into `'omega'` (hunkId format: afterStart-beforeLen-contentHash).
 */
async function emitPendingChange(
  app: ElectronApplication,
  change: { rootId: string; threadId: string },
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('editor:pendingChangesUpdated', [payload])
    },
    {
      rootId: change.rootId,
      filePath: 'src/logger.js',
      threadId: change.threadId,
      hunks: [
        {
          hunkId: '1-1-livryo',
          range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
          beforeText: "  const prefix = 'alpha'",
          afterText: "  const prefix = 'omega'",
          status: 'pending',
        },
      ],
    },
  )
}

/** Open the reviewed file through the app's own decoupled open-file channel. */
async function openReviewedFile(win: Page, dir: string): Promise<void> {
  await win.evaluate(
    ({ rootPath }) => {
      document.dispatchEvent(
        new CustomEvent('flow:open-file', {
          detail: { rootPath, relPath: 'src/logger.js' },
        }),
      )
    },
    { rootPath: dir },
  )
  await expect(win.locator('.monaco-editor .view-lines')).not.toBeEmpty({ timeout: 15_000 })
  await expect(win.locator('.fl-shell fl-tabs .tab', { hasText: 'logger.js' })).toBeVisible()
}

/**
 * Every visible surface a failed review action could speak through: the flow
 * toast stack, its persisted inbox, and any ad-hoc alert/toast chrome. Returns
 * the texts, so a tripwire can require a NEW one rather than any at all (a
 * seeded project already shows the "Run a basic discovery?" prompt toast).
 */
async function feedbackTexts(win: Page): Promise<string[]> {
  return win
    .locator('.fl-flow-toast, .fl-flow-inbox-entry, .fl-toast, [role="alert"]')
    .allInnerTexts()
}

/** Open a thread on a seeded project and put one pending agent edit on screen. */
async function stageReview(win: Page, app: ElectronApplication): Promise<{ dir: string }> {
  const dir = await seedRepo(win)
  await activateProject(win, dir)
  const threadId = await createThread(win, dir, 'Agent edit review')
  await win.getByText('Agent edit review', { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()

  await emitPendingChange(app, { rootId: dir, threadId })
  return { dir }
}

test.afterAll(() => cleanupSeeds())

test('a pending agent edit shows no strip chrome, and the open file carries an aligned inline hunk', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const { dir } = await stageReview(window, app)

  // The strip above the tab strip is REMOVED — a pending change must not put
  // any of its chrome (summary, rows, badges, nav) on screen. The verdict on a
  // whole file belongs to Source Control's review panel; the editor's inline
  // widget resolves one hunk where a reader can see it.
  await expect(window.locator('.fl-pending-strip')).toHaveCount(0)
  await expect(window.locator('[class*="fl-pending-strip"]')).toHaveCount(0)

  await openReviewedFile(window, dir)

  // The inline widget: the −n +m summary, both actions, and the replaced text.
  const widget = window.locator('.fl-inline-diff-widget')
  await expect(widget).toHaveCount(1)
  await expect(widget).toContainText('−1 +1')
  await expect(widget.locator('.fl-inline-diff-accept')).toBeVisible()
  await expect(widget.locator('.fl-inline-diff-reject')).toBeVisible()
  await expect(widget.locator('.fl-inline-diff-deleted')).toContainText("const prefix = 'alpha'")

  // The agent's new line is highlighted, and the review block sits directly on
  // top of it — a block floating away from its own hunk is unreadable.
  await expect(window.locator('.fl-diff-added-line')).toHaveCount(1)
  const gap = await window.evaluate(() => {
    const w = document.querySelector('.fl-inline-diff-widget')?.getBoundingClientRect()
    const added = document.querySelector('.fl-diff-added-line')?.getBoundingClientRect()
    return w && added ? Math.round(added.top - w.bottom) : null
  })
  expect(gap, 'inline hunk widget should render adjacent to its highlighted line').not.toBeNull()
  expect(Math.abs(gap as number)).toBeLessThan(30)

  await window.screenshot({ path: `${SCREENS}/editor-agent-edit-review.png` })
  expect(errors, 'no uncaught renderer errors while reviewing an agent edit').toEqual([])
})

test('a failing resolve really reaches main and rejects (control for the feedback tripwire)', async ({
  window,
  app,
}) => {
  const consoleErrors: string[] = []
  window.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })

  const { dir } = await stageReview(window, app)
  await openReviewedFile(window, dir)
  await expect(window.locator('.fl-inline-diff-widget')).toHaveCount(1)

  // The broadcast hunk set is whatever was last sent; the tracker re-derives
  // from disk at resolution time and can find no such hunk. That is exactly
  // what happens after the file changes under a pending review — the click
  // below MUST reach the main process and MUST fail there, otherwise the
  // "no feedback" tripwire would be asserting nothing.
  await window.locator('.fl-inline-diff-accept').click()
  await expect
    .poll(() => consoleErrors.some((t) => t.includes('failed to resolve hunk')), {
      timeout: 10_000,
      message: 'accept must invoke editor:resolveHunk (and be seen to fail)',
    })
    .toBe(true)

  // Nothing was RESOLVED — the review is still pending: the inline widget
  // stays (the failure path re-derives, and the hunk is still there).
  await expect(window.locator('.fl-inline-diff-widget')).not.toHaveCount(0)
})

// FIXED (#1291) — the failure was swallowed to console.error, so the inline
// Accept/Reject read as dead clicks: the widget stayed, and nothing on screen
// said the action failed. The renderer now reports through the toast channel
// the editor already owns (`editor-feedback.ts` → `flow:notify`, #195),
// distinguishing "the file moved on" from a hard failure, and re-derives so
// the dead widget is replaced.
test(
  'a resolve that fails tells the user something instead of dying in the console',
  async ({ window, app }) => {
    const { dir } = await stageReview(window, app)
    await openReviewedFile(window, dir)
    await expect(window.locator('.fl-inline-diff-widget')).toHaveCount(1)

    // Baseline AFTER the surface settled — a seeded project's own prompt toast
    // ("Run a basic discovery?") must not count as feedback about this action.
    const before = await feedbackTexts(window)

    await window.locator('.fl-inline-diff-accept').click()
    await expect
      .poll(
        async () => (await feedbackTexts(window)).filter((t) => !before.includes(t)),
        {
          timeout: 8_000,
          message: 'a review action that fails must be reported to the user',
        },
      )
      .not.toEqual([])
  },
)
