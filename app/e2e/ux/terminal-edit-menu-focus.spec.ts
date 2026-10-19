import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal), round 23: the two KEYBOARD seams around the
 * terminal's own copy/paste menu (#1149), neither of which any of the 33 prior
 * terminal specs touches.
 *
 * Prior rounds drove open/run/close/switch, resize, scoping, theme (#399), cwd
 * title (OSC 7), rename (#774/#959), exit recovery (#439/#957), background
 * drain (#208), Ctrl+C / Ctrl+L forwarding, ⌘L select-to-chat (#152), tab
 * overflow (#993/#994), the unscoped boot shell (#1024), panel height (#1059),
 * Ctrl ownership (#1099), the two popup surfaces (#1149/#1150), OSC 8 links
 * (#1190), split lifetime (#1293/#1294) and the first-project vanish (#1341).
 * Nobody had asked what the shell's KEYBOARD does around that menu.
 *
 * Two findings, both confirmed end-to-end against current main:
 *
 *  1. **#1387 — clicking any item on the terminal context menu drops keyboard
 *     focus to `<body>`.** terminal-menu.ts's item handler is
 *     `closeTerminalMenu(); handlers.x()` — the menu button held focus, the
 *     button is removed, and nothing hands focus back to the shell. The shell
 *     still looks focused (cursor, live selection), so the next thing you type
 *     is silently discarded, and the ⌘C that naturally follows the menu's own
 *     "Select All" copies nothing — leaving whatever was on the clipboard
 *     before, which then gets pasted. Same class as #1100 (palette Escape) and
 *     #1173 (thread ⋯ menu), which were both fixed on their own surfaces.
 *
 *  2. **#1388 — Edit ▸ Select All (⌘A) is inert in the terminal.** #1338 routed
 *     Undo/Redo/Select All through `editor:editAction` and taught the renderer
 *     to hand them to Monaco; every other surface still falls through to
 *     `document.execCommand('selectAll')`, which has no editable target in
 *     xterm's empty helper textarea. The menu item is never greyed out, ⌘A is a
 *     menu accelerator so it never reaches the shell either, and the terminal's
 *     own right-click Select All (2px away) does the job — so the capability is
 *     present, wired and reachable by mouse only.
 *
 * Everything that DOES work is asserted green so this file also guards the
 * healthy half: drag-select + ⌘C, right-click Copy, Paste on both routes.
 *
 * Docked-visible by default (`terminalVisible` defaults on, shell.ts) — start a
 * scoped shell with +, never toggle-to-open (which HIDES the docked panel).
 */

const SCREENS = 'e2e/ux/__screens'
const CONTROL = 'input[placeholder="Search threads"]'
const MARKER = 'TERMEDIT_ALPHA_77'

const activeHost = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const activeRows = (win: Page) => activeHost(win).locator('.xterm-rows')
const activeScreen = (win: Page) => win.locator('.fl-term-host:not([hidden]) .xterm-screen')
const helperTextarea = (win: Page) =>
  win.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea')
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

/** xterm paints its selection as absolutely-positioned rects; 0 = nothing selected. */
const selectionRects = (win: Page) =>
  win.locator('.fl-term-host:not([hidden]) .xterm-selection div')

const activeElement = (win: Page) =>
  win.evaluate(() => document.activeElement?.className ?? 'NONE')

const clipboardText = (app: ElectronApplication): Promise<string> =>
  app.evaluate(({ clipboard }) => clipboard.readText())
const setClipboard = (app: ElectronApplication, text: string): Promise<void> =>
  app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)

/**
 * Fire what Edit ▸ Undo / Redo / Select All do. Post-#1338 those three are
 * ordinary `click` callbacks whose whole body is
 * `BrowserWindow.getFocusedWindow()?.webContents.send('editor:editAction', a)`
 * — so sending that message to the window IS the menu item. (Invoking the
 * `MenuItem` from `app.evaluate` is inert under Playwright: the launched window
 * is not `getFocusedWindow()`, verified — the same reason
 * editor-edit-menu.spec.ts issues the command rather than the item.) The
 * control test below proves this channel really drives a surface.
 */
async function editMenuAction(
  app: ElectronApplication,
  action: 'undo' | 'redo' | 'selectAll',
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, a: string) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('editor:editAction', a)
  }, action)
}

async function editRole(app: ElectronApplication, method: 'copy' | 'paste'): Promise<void> {
  await app.evaluate(({ BrowserWindow }, name: string) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents as unknown as Record<
      string,
      () => void
    >
    contents[name]?.()
  }, method)
}

async function ensureScopedShell(win: Page): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) await newBtn(win).click()
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 15000,
  })
  await expect
    .poll(async () => (await activeRows(win).innerText()).trim().length, { timeout: 10000 })
    .toBeGreaterThan(0)
}

async function focusShell(win: Page): Promise<void> {
  await activeHost(win).click()
  await expect(helperTextarea(win)).toBeFocused()
}

/** Seed a project, open a scoped shell and print a known line into it. */
async function shellWithOutput(win: Page): Promise<void> {
  const proj = await seedProject(win)
  await activateProject(win, proj)
  await ensureScopedShell(win)
  await focusShell(win)
  await win.keyboard.type(`echo ${MARKER}\n`)
  await expect
    .poll(async () => (await activeRows(win).innerText()).includes(MARKER), { timeout: 12000 })
    .toBe(true)
}

/** Drag a selection across the top rows of the shell (xterm builds it from
 *  mousedown → move → up on .xterm-screen). */
async function dragSelect(win: Page): Promise<void> {
  const box = await activeScreen(win).boundingBox()
  if (!box) throw new Error('terminal screen has no box')
  await win.mouse.move(box.x + 6, box.y + 4)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width - 6, box.y + 40, { steps: 8 })
  await win.mouse.up()
  await expect(selectionRects(win).first()).toBeVisible({ timeout: 5000 })
}

async function termMenuItem(win: Page, id: string): Promise<void> {
  await activeScreen(win).click({ button: 'right', position: { x: 40, y: 20 } })
  await expect(win.locator('.fl-term-ctx-menu')).toBeVisible()
  await win.locator(`.fl-term-ctx-menu [data-term-menu="${id}"]`).click()
  await expect(win.locator('.fl-term-ctx-menu')).toHaveCount(0)
}

const appErrors = (errors: string[]): string[] => errors.filter((m) => m !== 'Canceled')

test.afterAll(() => cleanupSeeds())

test.describe('terminal — Edit menu + context-menu focus', () => {
  test('Edit ▸ Select All is shipped and always advertised as enabled', async ({ app, window }) => {
    // Main is read after the first window: evaluated during startup its context
    // can be replaced under the call ("Execution context was destroyed").
    await window.waitForLoadState('domcontentloaded')
    const item = await app.evaluate(({ Menu }) => {
      const edit = Menu.getApplicationMenu()?.items.find((i) => /^edit$/i.test(i.label))
      const sa = edit?.submenu?.items.find((i) => i.label === 'Select All')
      return sa ? { label: sa.label, enabled: sa.enabled, accelerator: sa.accelerator } : null
    })
    expect(item).not.toBeNull()
    // Never greyed out — which is what makes #1388 silent: an enabled item that
    // does nothing gives the shell's user no signal at all.
    expect(item?.enabled).toBe(true)
  })

  test('control: the Edit menu drives Flow’s own plain input', async ({ window, app }) => {
    // Proves the drive channel used below is faithful: the exact message the
    // menu item sends does work on an ordinary input in this same window.
    const search = window.locator(CONTROL).first()
    await search.click()
    await window.keyboard.type('control-text')
    await expect(search).toHaveValue('control-text')

    await editMenuAction(app, 'selectAll')
    await expect
      .poll(
        () =>
          window.evaluate((s) => {
            const el = document.querySelector(s) as HTMLInputElement | null
            return el ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0) : ''
          }, CONTROL),
        { timeout: 5000 },
      )
      .toBe('control-text')

    await setClipboard(app, 'SENTINEL_STALE')
    await editRole(app, 'copy')
    await expect.poll(() => clipboardText(app), { timeout: 5000 }).toBe('control-text')
  })

  test('the terminal’s own right-click menu copies, selects and pastes', async ({
    window,
    app,
  }) => {
    // The healthy half — and the proof that "select all the shell" is a
    // capability this terminal HAS, reachable by mouse (#1149).
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))
    await shellWithOutput(window)

    await focusShell(window)
    await expect(selectionRects(window)).toHaveCount(0)
    await termMenuItem(window, 'select-all')
    await expect(selectionRects(window).first()).toBeVisible({ timeout: 5000 })

    await setClipboard(app, 'SENTINEL_STALE')
    await termMenuItem(window, 'copy')
    await expect.poll(() => clipboardText(app), { timeout: 8000 }).toContain(MARKER)

    await setClipboard(app, 'OWNPASTE_MARKER_77')
    await focusShell(window)
    await termMenuItem(window, 'paste')
    await expect
      .poll(async () => (await activeRows(window).innerText()).includes('OWNPASTE_MARKER_77'), {
        timeout: 8000,
      })
      .toBe(true)

    expect(appErrors(errors), appErrors(errors).join(', ')).toEqual([])
  })

  test('a mouse-drag selection copies with ⌘C, and Edit ▸ Paste reaches the shell', async ({
    window,
    app,
  }) => {
    // Green: while the shell itself holds focus, the clipboard roles are fine.
    // This is what makes the two findings below focus/routing bugs and not a
    // missing clipboard wire.
    await shellWithOutput(window)

    await dragSelect(window)
    await expect(helperTextarea(window)).toBeFocused()
    await setClipboard(app, 'SENTINEL_STALE')
    await editRole(app, 'copy')
    await expect.poll(() => clipboardText(app), { timeout: 8000 }).toContain(MARKER)

    await setClipboard(app, 'PASTED_MARKER_77')
    await focusShell(window)
    await editRole(app, 'paste')
    await expect
      .poll(async () => (await activeRows(window).innerText()).includes('PASTED_MARKER_77'), {
        timeout: 8000,
      })
      .toBe(true)
  })

  // ── #1387 tripwire ───────────────────────────────────────────────────────
  test(
    'the shell keeps the keyboard after a context-menu action',
    async ({ window, app }) => {
      await shellWithOutput(window)
      await focusShell(window)

      // Copy — the menu's most-used item — must not cost the shell its keyboard.
      await dragSelect(window)
      await termMenuItem(window, 'copy')
      await expect(helperTextarea(window)).toBeFocused()

      // …and the ⌘C a user presses right after the menu's own Select All must
      // copy the selection they can see, not leave the stale clipboard behind.
      await termMenuItem(window, 'select-all')
      await expect(selectionRects(window).first()).toBeVisible()
      await setClipboard(app, 'SENTINEL_STALE')
      await editRole(app, 'copy')
      await expect.poll(() => clipboardText(app), { timeout: 8000 }).toContain(MARKER)

      // …and the next command typed must reach the shell.
      await window.keyboard.type('echo AFTERMENU_77\n')
      await expect
        .poll(async () => (await activeRows(window).innerText()).includes('AFTERMENU_77'), {
          timeout: 8000,
        })
        .toBe(true)
    },
  )

  // ── #1388 tripwire ───────────────────────────────────────────────────────
  test('Edit ▸ Select All selects the whole terminal buffer', async ({ window, app }) => {
    await shellWithOutput(window)
    await focusShell(window)
    await expect(selectionRects(window)).toHaveCount(0)

    await editMenuAction(app, 'selectAll')
    await expect(selectionRects(window).first()).toBeVisible({ timeout: 8000 })
  })

  // RETIRED 2026-10-09: "evidence: one menu click, and the shell is no longer
  // listening" pinned #1387's broken state, and said it would turn red the
  // moment the defect was fixed so the tripwires above could go live. It did:
  // after the context menu's Select All the shell keeps the keyboard.
})
