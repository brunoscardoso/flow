import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds } from './fixtures/seed'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Dialog, Page } from '@playwright/test'

/**
 * UX sweep — flow 7 (Editor), round 14: an UNSAVED buffer across a project switch.
 *
 * Prior flow-7 rounds drove open/tabs/dirty-save/close/reopen, binary + too-large
 * placeholders, tab-nav + dirty-close confirm, the close-ops menu, overflow/scroll,
 * external-disk reload, markdown preview, save-fail feedback, select-to-chat, and
 * (round 10, `editor-tabs-follow-project.spec.ts`) the per-project tab FOLLOW seam
 * — but that one drives only CLEAN tabs. Nothing had ever driven the data-safety
 * question underneath it: what happens to a tab the user typed into but did not
 * save when the active project changes out from under it?
 *
 * The seam: `editor/index.ts setActiveProject()` calls `closeAllTabsSilently()`
 * (index.ts:472), whose doc-comment states the intent — "a programmatic switch,
 * not a user close, so unsaved buffers are silently discarded". It drops each
 * Monaco model without ever consulting `host.isDirty(path)`, the exact check its
 * sibling `closeFile()` (index.ts:511) makes before raising a
 * "Discard unsaved changes in <file>?" confirm. `project-context.ts` persists the
 * outgoing project's tab PATHS (`saveOpenFiles`) but never its BUFFERS, so the
 * tab is restored looking clean and the typed work is unrecoverable. Filed as
 * #955 (High — silent loss of uncommitted work on ordinary navigation).
 *
 * What this spec locks in:
 *  - LIVE guard: the round trip must not get WORSE than the filed bug — the
 *    discarded buffer must never leak onto disk (neither into A's file nor into
 *    a same-named file in B), the tab set must still be restored, and the flow
 *    must stay error-free. A regression here would turn silent loss into
 *    cross-project corruption (the #426/#288 mis-target class).
 *  - LIVE guard: the sibling contrast that makes #955 a defect rather than a
 *    policy — a MANUAL close of the very same dirty tab does prompt, and
 *    dismissing it keeps the buffer.
 *  - test.fixme tripwire for #955: the unsaved buffer survives the switch, or
 *    the user is warned. Un-fixme when #955 is fixed.
 *
 * Account-independent, git-independent, no agent. Files open via the decoupled
 * `flow:open-file` event; the switch runs through the real
 * `project:setActive` IPC the titlebar switcher fires. Monaco's benign
 * internal "Canceled" on model dispose is filtered — see editor.spec.ts.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

/** Record every native dialog raised during a flow (and accept it so nothing
 *  blocks). The whole question in #955 is whether ONE ever fires. */
function trackDialogs(win: Page): string[] {
  const dialogs: string[] = []
  win.on('dialog', (d: Dialog) => {
    dialogs.push(`${d.type()}: ${d.message()}`)
    void d.accept()
  })
  return dialogs
}

/** Open a project file through the app's real decoupled `flow:open-file` event —
 *  the same path the Files tree / blueprint file rows dispatch (independent of
 *  the #663/#664 activity-bar markup). */
async function openFile(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

/** Switch the active project via the real IPC the titlebar switcher fires. */
async function switchTo(win: Page, rootPath: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, rootPath)
  await dismissFlowOverlay(win)
}

/** The editor tab strip button whose visible label matches `name`. */
function tab(win: Page, name: string) {
  return win.locator('.fl-shell fl-tabs .tab', { hasText: name })
}

/** Wait until Monaco shows a line containing `text` (content actually rendered). */
async function expectEditorShows(win: Page, text: string): Promise<void> {
  await expect(win.locator('.monaco-editor .view-lines')).toContainText(text, { timeout: 15000 })
}

/** Seed project A (file on disk at v1), open its file, and type an unsaved line. */
async function seedDirtyTabInA(win: Page): Promise<string> {
  const dirA = await seedProject(win, 'flow-ux-dirtyA-')
  writeFileSync(join(dirA, 'alpha.ts'), 'export const ALPHA = "on-disk-v1"\n')
  await activateProject(win, dirA)

  await openFile(win, dirA, 'alpha.ts')
  await expect(tab(win, 'alpha.ts')).toBeVisible({ timeout: 10000 })
  await expectEditorShows(win, 'on-disk-v1')

  await win.locator('.monaco-editor .view-lines').click()
  await win.keyboard.press('End')
  await win.keyboard.type('\nexport const PRECIOUS = "unsaved-work-do-not-lose"')
  await expect(tab(win, 'alpha.ts').locator('.dirty-dot')).toBeVisible()
  await expectEditorShows(win, 'unsaved-work-do-not-lose')
  return dirA
}

test.afterAll(() => cleanupSeeds())

test('a project switch with an unsaved buffer never writes it to disk in EITHER project, and restores the tab set (#955 blast-radius guard)', async ({
  window,
}) => {
  const errors = trackErrors(window)

  const dirA = await seedDirtyTabInA(window)
  await window.screenshot({ path: `${SCREENS}/editor-dirty-switch-01-dirty-in-A.png` })

  // Project B carries a file with the SAME name — the mis-target probe. The
  // buffer torn down in A must never be flushed onto B's copy.
  const dirB = await seedProject(window, 'flow-ux-dirtyB-')
  writeFileSync(join(dirB, 'beta.ts'), 'export const BETA = "beta-marker"\n')
  writeFileSync(join(dirB, 'alpha.ts'), 'export const ALPHA = "B-side-original"\n')

  // ── Switch away: A's tabs are torn down (no leak into B).
  await switchTo(window, dirB)
  await expect(tab(window, 'alpha.ts')).toHaveCount(0)
  await openFile(window, dirB, 'beta.ts')
  await expect(tab(window, 'beta.ts')).toBeVisible({ timeout: 10000 })
  await expectEditorShows(window, 'beta-marker')

  // ── Back to A: the tab SET is restored (that part works) and B's tab is gone.
  await switchTo(window, dirA)
  await expect(tab(window, 'alpha.ts')).toBeVisible({ timeout: 10000 })
  await expect(tab(window, 'beta.ts')).toHaveCount(0)
  await expectEditorShows(window, 'on-disk-v1')
  await window.screenshot({ path: `${SCREENS}/editor-dirty-switch-02-back-in-A.png` })

  // ── The invariant that must never break, however #955 is fixed: the unsaved
  //    text was never flushed to EITHER repo behind the user's back.
  expect(readFileSync(join(dirA, 'alpha.ts'), 'utf8')).toBe('export const ALPHA = "on-disk-v1"\n')
  expect(readFileSync(join(dirB, 'alpha.ts'), 'utf8')).toBe(
    'export const ALPHA = "B-side-original"\n',
  )

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('the sibling path still guards the same buffer: closing a dirty tab by hand prompts, and dismissing keeps the edits (#955 contrast)', async ({
  window,
}) => {
  const errors = trackErrors(window)
  const dialogs: string[] = []

  await seedDirtyTabInA(window)

  // Close by hand → the confirm MUST fire; dismissing keeps tab + buffer.
  const onDismiss = (d: Dialog) => {
    dialogs.push(d.message())
    void d.dismiss()
  }
  window.on('dialog', onDismiss)
  await tab(window, 'alpha.ts').locator('.close').click()
  await window.waitForTimeout(400)
  window.off('dialog', onDismiss)

  expect(dialogs.join(' ')).toContain('Discard unsaved changes')
  await expect(tab(window, 'alpha.ts')).toBeVisible()
  await expect(tab(window, 'alpha.ts').locator('.dirty-dot')).toBeVisible()
  await expectEditorShows(window, 'unsaved-work-do-not-lose')

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

// #955 acceptance (was the fixme tripwire): a project switch must never
// silently destroy an unsaved buffer — it survives the round trip (restored
// dirty via the persisted per-project buffers) or the user is warned first.
test(
  'a project switch must not silently destroy an unsaved editor buffer (#955)',
  async ({ window }) => {
    const errors = trackErrors(window)
    const dialogs = trackDialogs(window)

    const dirA = await seedDirtyTabInA(window)

    const dirB = await seedProject(window, 'flow-ux-dirtyB2-')
    writeFileSync(join(dirB, 'beta.ts'), 'export const BETA = "beta-marker"\n')
    await switchTo(window, dirB)
    await expect(tab(window, 'alpha.ts')).toHaveCount(0)

    await switchTo(window, dirA)
    await expect(tab(window, 'alpha.ts')).toBeVisible({ timeout: 10000 })
    await window.waitForTimeout(500)

    // Either the work survived …
    const survived = (await window.locator('.monaco-editor .view-lines').innerText()).includes(
      'unsaved-work-do-not-lose',
    )
    // … or the user was told before it was thrown away.
    const warned = dialogs.some((d) => /unsaved|discard/i.test(d))
    expect(
      survived || warned,
      'unsaved buffer was destroyed by the project switch with no warning',
    ).toBe(true)

    const appErrs = appErrors(errors)
    expect(appErrs, appErrs.join(', ')).toHaveLength(0)
  },
)
