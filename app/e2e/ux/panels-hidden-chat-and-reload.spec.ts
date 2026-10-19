import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, openEmptyThread } from './fixtures/seed'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 12 (panel toggles & keyboard shortcuts), round 17.
 *
 * Two seams that ~20 prior panel/shortcut specs never drove:
 *
 * (A) #1071 — what a chat-OPENING action does while the Chat panel is hidden.
 *     `⌘⌥C` is a supported toggle in the NORMAL layout (focus mode, #967, is a
 *     different trigger on the same panel). All three chat entry points —
 *     `flow:new-thread` (:262), `flow:open-thread` (:248), `flow:compose-prompt`
 *     (:273) in threads/index.ts — open their first line with a
 *     `flow:reveal-sidebar` dispatch, precisely so the action still lands when
 *     the user hid the SIDEBAR. There is no equivalent for the conversation
 *     panel: `flow:show-chat` does not exist anywhere in src/ (only
 *     show-editor / show-terminal / show-git / show-review). So the thread is
 *     really created and really selected, into a panel that is not on screen —
 *     the exact shape of #1057 (openFile never dispatches flow:show-editor).
 *
 * (B) #1072 — View ▸ Reload (`role:'viewMenu'` → `Reload [CmdOrCtrl+R]`,
 *     main/menu.ts:34) tears the renderer down with no `beforeunload` /
 *     `will-prevent-unload` guard anywhere in src/, so every unsaved editor
 *     buffer is discarded with no prompt. The tab is then restored from disk,
 *     clean, so the loss leaves no visible trace. #673 is the precedent: this
 *     menu was already customized once because a stock role (Close Window on
 *     ⌘W) was hurting users.
 *
 * The live guards below pin the contracts that DO hold, so a fix for either bug
 * can't quietly break them. The `test.fixme` tripwires encode the two defects —
 * flip them live when the reveal channel / reload guard lands.
 */

function newThreadBtn(win: Page) {
  return win.locator('fl-button[aria-label="New thread"]')
}

/** Thread ids currently in the store (credential-free IPC). */
async function threadIds(win: Page): Promise<string[]> {
  return win.evaluate(async () => {
    const api = (window as unknown as { flow: { threads: { list(a: object): Promise<unknown> } } })
      .flow
    const rows = (await api.threads.list({})) as Array<{ id: string }>
    return rows.map((r) => r.id)
  })
}

/** Is the conversation panel actually mounted? `⌘⌥C` removes it from the DOM
 *  entirely (not a CSS class), so presence is the honest signal. */
async function chatMounted(win: Page): Promise<boolean> {
  return win.evaluate(() => !!document.querySelector('.fl-conversation'))
}

/** Dirty-dot count across every fl-tabs strip (the dot lives in the shadow root). */
async function dirtyDots(win: Page): Promise<number> {
  return win.evaluate(() =>
    Array.from(document.querySelectorAll('fl-tabs')).reduce(
      (n, strip) =>
        n +
        ((strip as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot?.querySelectorAll(
          '.dirty-dot',
        ).length ?? 0),
      0,
    ),
  )
}

/** Seed a project with one thread and the Chat panel hidden via the real ⌘⌥C. */
async function projectWithHiddenChat(win: Page): Promise<{ dir: string; ids: string[] }> {
  const dir = await seedProject(win)
  await activateProject(win, dir)
  // Two threads: `flow:open-thread` no-ops on the already-selected one (#100).
  // "+ New thread" opens the new-thread PAGE now (a thread exists only once its
  // first message is sent), so the threads are made through the store.
  await openEmptyThread(win, dir, 'Hidden chat A')
  await openEmptyThread(win, dir, 'Hidden chat B')
  const ids = await threadIds(win)
  expect(ids.length).toBeGreaterThanOrEqual(2)

  await expect(win.locator(sel.conversation)).toBeVisible()
  await win.keyboard.press('ControlOrMeta+Alt+KeyC')
  await expect(win.locator(sel.conversation)).toHaveCount(0)
  return { dir, ids }
}

test.describe('flow 12 — hidden Chat panel (#1071) · View▸Reload (#1072)', () => {
  test.afterAll(() => cleanupSeeds())

  // ── LIVE GUARD (passes on main) ────────────────────────────────────────────
  // The reveal contract that IS implemented: `flow:open-thread` restores a
  // hidden SIDEBAR. This is the control that makes #1071 a defect rather than a
  // preference — same handler, one line above the missing chat reveal.
  test('control: opening a thread reveals the hidden SIDEBAR (#1071 control)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    await openEmptyThread(window, dir, 'Sidebar control A')
    await openEmptyThread(window, dir, 'Sidebar control B')
    const ids = await threadIds(window)

    await window.keyboard.press('ControlOrMeta+KeyB')
    await expect(window.locator(sel.threadSidebar)).toHaveCount(0)

    await window.evaluate((id) => {
      document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: id } }))
    }, ids[ids.length - 1])

    await expect(window.locator(sel.threadSidebar)).toBeVisible({ timeout: 8000 })
    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  // ── LIVE GUARD ─────────────────────────────────────────────────────────────
  // With the chat hidden, "+ New thread" is not inert. It used to create a
  // thread straight away (and every impatient re-click made another empty one);
  // it now opens the new-thread PAGE in the chat column, so it must bring the
  // column back (`flow:show-chat`, #1071) and make no thread until Create.
  test('+ New thread reveals the hidden Chat panel with the new-thread page', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    await projectWithHiddenChat(window)
    const before = (await threadIds(window)).length

    await newThreadBtn(window).click()

    // The chat column is back (its conversation pane is mounted again) and is
    // showing the new-thread page in place of a transcript.
    await expect(window.locator(sel.conversation)).toHaveCount(1, { timeout: 8000 })
    await expect(window.locator('.fl-newthread')).toBeVisible({ timeout: 8000 })
    expect((await threadIds(window)).length).toBe(before)
    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  // ── #1071 (fixed) ──────────────────────────────────────────────────────────
  // `flow:show-chat` now exists (shell.ts, beside flow:show-editor) and the
  // three thread entry points dispatch it — after asking to open a thread, the
  // conversation must be on screen (reveal) OR the user told why (a toast).
  test(
    'opening a thread with the Chat panel hidden surfaces the conversation (#1071)',
    async ({ window }) => {
      const { ids } = await projectWithHiddenChat(window)

      const toastsBefore = await window.evaluate(() =>
        Array.from(document.querySelectorAll('.fl-flow-toast')).map(
          (t) => (t as HTMLElement).innerText,
        ),
      )

      await window.evaluate((id) => {
        document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: id } }))
      }, ids[ids.length - 1])
      await window.waitForTimeout(2000)

      const toastsAfter = await window.evaluate(() =>
        Array.from(document.querySelectorAll('.fl-flow-toast')).map(
          (t) => (t as HTMLElement).innerText,
        ),
      )
      const toldWhy = toastsAfter.some((t) => !toastsBefore.includes(t))

      expect(await chatMounted(window), 'conversation revealed or explained').toBe(true)
      expect((await chatMounted(window)) || toldWhy).toBe(true)
    },
  )

  // ── LIVE GUARD (passes on main) ────────────────────────────────────────────
  // The dirty-state machinery #1072 depends on: an unsaved edit marks the tab
  // and leaves the file on disk untouched.
  test('an unsaved edit marks the tab dirty and does not touch disk', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window, 'flow-ux-reload-', (d) => {
      writeFileSync(join(d, 'alpha.ts'), 'export const a = 1\n')
    })
    await activateProject(window, dir)
    await window.evaluate((rootPath) => {
      document.dispatchEvent(
        new CustomEvent('flow:open-file', { detail: { rootPath, relPath: 'alpha.ts' } }),
      )
    }, dir)
    await expect(window.locator('.monaco-editor')).toBeVisible({ timeout: 20000 })
    await window.waitForTimeout(1200)

    expect(await dirtyDots(window)).toBe(0)
    await window.locator('.monaco-editor').first().click()
    await window.keyboard.type('// UNSAVED_EDIT_MARKER')
    await window.waitForTimeout(1200)

    expect(await dirtyDots(window)).toBe(1)
    expect(readFileSync(join(dir, 'alpha.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  // ── TRIPWIRE (#1072) ───────────────────────────────────────────────────────
  // Fix-agnostic: after View ▸ Reload with a dirty buffer, the edit must either
  // survive (hot exit) or have been guarded by a dialog — silently discarding
  // it is the defect. Un-`fixme` when the menu drops the reload role or a
  // beforeunload guard lands.
  test.fixme(
    'View ▸ Reload does not silently discard an unsaved edit (#1072)',
    async ({ window, app }) => {
      const dialogs: string[] = []
      window.on('dialog', (d) => {
        dialogs.push(`${d.type()}: ${d.message()}`)
        void d.dismiss()
      })

      const dir = await seedProject(window, 'flow-ux-reload-', (d) => {
        writeFileSync(join(d, 'alpha.ts'), 'export const a = 1\n')
      })
      await activateProject(window, dir)
      await window.evaluate((rootPath) => {
        document.dispatchEvent(
          new CustomEvent('flow:open-file', { detail: { rootPath, relPath: 'alpha.ts' } }),
        )
      }, dir)
      await expect(window.locator('.monaco-editor')).toBeVisible({ timeout: 20000 })
      await window.waitForTimeout(1200)
      await window.locator('.monaco-editor').first().click()
      await window.keyboard.type('// UNSAVED_EDIT_MARKER')
      await window.waitForTimeout(1200)
      expect(await dirtyDots(window)).toBe(1)

      // The REAL View ▸ Reload item — the one ⌘R fires.
      const label = await app.evaluate(({ Menu, BrowserWindow }) => {
        const view = Menu.getApplicationMenu()?.items.find((i) => i.label === 'View')
        const reload = view?.submenu?.items.find((i) => i.label === 'Reload')
        if (!reload) return 'NO_ITEM'
        const win = BrowserWindow.getAllWindows()[0]
        reload.click(undefined as never, win, win.webContents as never)
        return `${reload.label} [${reload.accelerator ?? ''}]`
      })
      expect(label).toContain('Reload')
      await window.waitForTimeout(7000)

      const survived = await window.evaluate(
        () =>
          !!document
            .querySelector('.monaco-editor')
            ?.textContent?.includes('UNSAVED_EDIT_MARKER'),
      )
      // Either the edit is still there, or the user was asked first.
      expect(survived || dialogs.length > 0).toBe(true)
    },
  )
})
