import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 12 (panel toggles & keyboard shortcuts), round 22.
 *
 * Prior flow-12 rounds drove ⌘B, ⌃`/⌘J, ⌘⌥C, ⌘⌥D vs the terminal (#626/#674),
 * focus-mode scope (#616/#836/#924/#967/#968/#1161/#1201), rail digits (#1212),
 * per-project persistence (#767), split sizes (#1110/#1111), modal isolation
 * (#525/#1002) and the palette's reveal contract (#1057/#1071/#1202/#1313).
 * Never probed: the **non-empty guard** that sits underneath every one of those
 * toggles — `enforceNonEmpty` (renderer/panel-layout.ts:103).
 *
 * That guard exists so hiding everything can't leave a blank shell. But its
 * definition of "renders something" is `editorVisible || effectivePanels()` —
 * and `effectivePanels()` covers only the MOVABLE panels (today: conversation).
 * The activity sidebar (threads / files / source-control) is driven by
 * RailItem in sidetab-state, deliberately OUTSIDE this model (panel-layout.ts:9),
 * so the guard cannot see it — even though it is open by default at 306px.
 *
 * Two user-visible consequences, both measured live on main:
 *  (A) With Chat hidden, ⌘⌥D is a silent dead key. The editor stays, the
 *      layout is structurally unchanged, nothing is said — while the sidebar
 *      it refuses to count sits on screen.
 *  (B) From the editor-hidden state, ⌘⌥C — a *Chat* toggle — silently
 *      re-opens the editor the user hid. One key, two panels changed.
 *
 * The control tests below lock in the behavior that IS right (both toggles work
 * normally when the guard is not engaged), so a fix can't regress them.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => !/Canceled/.test(m))
}

/** Open a file the decoupled way — same event blueprint rows / chat links use. */
async function openViaEvent(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

/** Structural shape of the three surfaces the guard arbitrates. */
async function layoutShape(win: Page): Promise<{
  chat: string
  editorStack: string
  sidebar: string
  monaco: boolean
}> {
  return win.evaluate(() => {
    const w = (s: string): string => {
      const el = document.querySelector(s) as HTMLElement | null
      if (!el) return 'absent'
      const r = el.getBoundingClientRect()
      return r.width > 4 ? 'present' : 'collapsed'
    }
    return {
      chat: w('[data-panel-id="conversation"]'),
      editorStack: w('#fl-split-editor-stack'),
      sidebar: w('.fl-activity-sidebar'),
      monaco: !!document.querySelector('.monaco-editor'),
    }
  })
}

/** Seed a project with one file and open it, so the editor is a REAL surface
 *  (an empty editor collapses on its own via #675 and would confound this). */
async function shellWithOpenFile(window: Page): Promise<void> {
  const root = await seedProject(window)
  writeFileSync(join(root, 'notes.md'), '# Hello\n\nSome content the user is reading.\n')
  await activateProject(window, root)
  await window.waitForTimeout(1000)
  await openViaEvent(window, root, 'notes.md')
  await expect(window.locator('.monaco-editor').first()).toBeVisible({ timeout: 20_000 })
  await window.waitForTimeout(600)
}

test.describe('flow 12 — the non-empty guard under ⌘⌥C / ⌘⌥D', () => {
  test.afterAll(() => cleanupSeeds())

  // ── Controls: the guard is NOT engaged, so both toggles behave ────────────

  test('control: with Chat visible, ⌘⌥D hides and re-shows the editor', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    await shellWithOpenFile(window)

    expect(await layoutShape(window)).toMatchObject({
      chat: 'present',
      editorStack: 'present',
      sidebar: 'present',
    })

    await window.keyboard.press('ControlOrMeta+Alt+KeyD')
    await expect
      .poll(async () => (await layoutShape(window)).editorStack, { timeout: 5000 })
      .toBe('absent')

    await window.keyboard.press('ControlOrMeta+Alt+KeyD')
    await expect
      .poll(async () => (await layoutShape(window)).editorStack, { timeout: 5000 })
      .toBe('present')

    expect(appErrors(errors)).toEqual([])
  })

  test('control: ⌘⌥C hides and re-shows the Chat panel', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    await shellWithOpenFile(window)

    await window.keyboard.press('ControlOrMeta+Alt+KeyC')
    await expect.poll(async () => (await layoutShape(window)).chat, { timeout: 5000 }).toBe('absent')
    await window.keyboard.press('ControlOrMeta+Alt+KeyC')
    await expect.poll(async () => (await layoutShape(window)).chat, { timeout: 5000 }).toBe('present')

    expect(appErrors(errors)).toEqual([])
  })

  test('precondition: with Chat hidden the shell still shows the sidebar AND the editor', async ({
    window,
  }) => {
    await shellWithOpenFile(window)
    await window.keyboard.press('ControlOrMeta+Alt+KeyC')
    await expect.poll(async () => (await layoutShape(window)).chat, { timeout: 5000 }).toBe('absent')

    // This is the state the guard mis-reads: hiding the editor here would still
    // leave a 306px activity sidebar on screen, so the shell would not be blank.
    expect(await layoutShape(window)).toMatchObject({
      chat: 'absent',
      editorStack: 'present',
      sidebar: 'present',
    })
    await window.screenshot({ path: `${SCREENS}/panels-nonempty-chat-hidden.png` })
  })

  // ── TRIPWIRES ────────────────────────────────────────────────────────────
  // Fix-agnostic: the shortcut must either DO its documented thing or SAY why
  // it can't. Silently doing nothing (A) / silently changing a second panel (B)
  // is the defect. Un-`fixme` when enforceNonEmpty learns about the sidebar (or
  // the refusal grows a visible notice).

  test.fixme(
    'A: with Chat hidden, ⌘⌥D still hides the editor (or explains why not)',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))
      await shellWithOpenFile(window)

      await window.keyboard.press('ControlOrMeta+Alt+KeyC')
      await expect
        .poll(async () => (await layoutShape(window)).chat, { timeout: 5000 })
        .toBe('absent')

      const toastsBefore = await window.locator('[class*="toast"]').count()
      await window.keyboard.press('ControlOrMeta+Alt+KeyD')
      await window.waitForTimeout(1000)

      const shape = await layoutShape(window)
      const toastsAfter = await window.locator('[class*="toast"]').count()
      await window.screenshot({ path: `${SCREENS}/panels-nonempty-dead-D.png` })

      // Either the editor went away, or the user was told something.
      const acted = shape.editorStack === 'absent'
      const explained = toastsAfter > toastsBefore
      expect(acted || explained, 'either ⌘⌥D acts, or the refusal is visible').toBe(true)
      expect(appErrors(errors)).toEqual([])
    },
  )

  test.fixme(
    'B: the Chat toggle does not silently re-open the editor the user hid',
    async ({ window }) => {
      await shellWithOpenFile(window)

      // Hide the editor deliberately (Chat visible, so the guard allows it).
      await window.keyboard.press('ControlOrMeta+Alt+KeyD')
      await expect
        .poll(async () => (await layoutShape(window)).editorStack, { timeout: 5000 })
        .toBe('absent')

      // Now toggle CHAT. The editor is nobody's business here.
      await window.keyboard.press('ControlOrMeta+Alt+KeyC')
      await window.waitForTimeout(1000)

      const shape = await layoutShape(window)
      await window.screenshot({ path: `${SCREENS}/panels-nonempty-revived-editor.png` })
      expect(shape.editorStack, 'the hidden editor stays hidden').toBe('absent')
    },
  )
})
