import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX regression probe — flow 12 (panel toggles & keyboard shortcuts), round 21:
 * the ⌘P palette's REVEAL-YOUR-SURFACE contract, on the two commands that still
 * don't honour it.
 *
 * The contract is stated in the registry itself (`palette-commands.ts`):
 *
 *   > New terminal REVEALS the terminal panel (flow:show-terminal), not just
 *   > flow:terminal-new — otherwise the shell starts but stays hidden.
 *
 * and it is what #1057 (`flow:show-editor` reveals a ⌘⌥D-hidden editor), #1071
 * (`flow:show-chat` reveals a ⌘⌥C-hidden chat) and #1202 ("Show Git" / "Show
 * Review" reveal Source Control) each bought, one command at a time.
 *
 * Two commands were never brought inside it:
 *
 *  - **"Split terminal"** (`flow:terminal-split`, added with #1133) — #1313 — the registry
 *    asserts "the panel is already open whenever there is something to split, so
 *    this needs no reveal of its own". ⌃` hides the panel while every PTY stays
 *    alive, so that assumption is false. Measured: with the panel hidden the
 *    command is byte-for-byte silent, and the panes it makes only surface on the
 *    user's NEXT manual reveal. From a stock window (no terminal at all) it is a
 *    complete no-op — `splitTerminal()` early-returns on `activeId === null`.
 *  - **"New task"** (`flow:new-task`, #1314) — its only listener anchors the form to the
 *    thread sidebar's "New task" button (`#promptNewTask` → `#mountMenu`). With
 *    the rail on Files, or the sidebar hidden (⌘B), that anchor has a zero rect
 *    (or has left the DOM), so `#mountMenu` clamps the popup to (8, 4): a 280px
 *    form floating in the title-bar corner, under the macOS window controls.
 *
 * The live `test`s are the CONTROLS that keep the tripwires honest — they prove
 * the palette really drives these commands, that the reveal machinery works for
 * their siblings, and that the split really reaches main when the panel is up.
 * The `test.fixme`s state the expected behaviour and are RED on `main`; flip them
 * live with the fix.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((message) => message !== 'Canceled')
}

/** Open ⌘P in command mode and run the command with this exact label. */
async function runPaletteCommand(win: Page, label: string): Promise<void> {
  await win.keyboard.press('ControlOrMeta+p')
  const palette = win.locator('.fl-palette-panel')
  await palette.waitFor({ state: 'visible', timeout: 5000 })
  await win.locator('.fl-palette-input').fill(`>${label}`)
  await expect(win.locator('.fl-palette-row').first()).toContainText(label, { timeout: 5000 })
  await win.keyboard.press('Enter')
  await palette.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined)
  await win.waitForTimeout(600)
}

/** What the user can SEE of the terminal panel. `panes` counts live xterm hosts. */
async function terminalState(
  win: Page,
): Promise<{ visible: boolean; panes: number; screens: number; text: string }> {
  return win.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.fl-term-root')
    return {
      visible: !!root && !!root.offsetParent,
      panes: document.querySelectorAll('.fl-term-host').length,
      screens: document.querySelectorAll('.xterm-screen').length,
      text: Array.from(document.querySelectorAll('.xterm-rows'))
        .map((rows) => (rows.textContent ?? '').replace(/\s+/g, ' '))
        .join(' | '),
    }
  })
}

/** Geometry of the anchored thread-sidebar popup and of its anchor. */
async function popupGeometry(win: Page): Promise<{
  present: boolean
  top: number | null
  left: number | null
  overlapsTitlebar: boolean
  anchorOnScreen: boolean
}> {
  return win.evaluate(() => {
    const menu = document.querySelector<HTMLElement>('.fl-thread-menu')
    const rect = menu?.getBoundingClientRect() ?? null
    const titlebar = document.querySelector<HTMLElement>('.fl-titlebar')?.getBoundingClientRect()
    // The sidebar's `+` is the task flow's anchor now (thread-sidebar.ts
    // `#taskAnchor`) — the separate "New task" button left that toolbar.
    const anchor = document.querySelector<HTMLElement>('.fl-thread-sidebar fl-button[aria-label="New thread"]')
    return {
      present: !!menu,
      top: rect ? Math.round(rect.top) : null,
      left: rect ? Math.round(rect.left) : null,
      overlapsTitlebar: !!rect && !!titlebar && rect.top < titlebar.bottom,
      anchorOnScreen: !!anchor && !!anchor.offsetParent,
    }
  })
}

test.afterAll(() => cleanupSeeds())

test.describe('flow 12 — the ⌘P palette’s reveal-your-surface contract', () => {
  // ── CONTROL 1 ────────────────────────────────────────────────────────────
  // The sibling command DOES reveal. This proves the probe drives the palette
  // correctly and that `flow:show-terminal` really surfaces a hidden panel — so
  // a silent "Split terminal" below cannot be blamed on the harness.
  test('control: "New terminal" reveals a hidden panel', async ({ window: win }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(error.message))

    const root = await seedProject(win, 'flow-ux-pal-nt-', (dir) => {
      writeFileSync(join(dir, 'seed.txt'), 'hello\n')
    })
    await activateProject(win, root)
    await win.waitForTimeout(800)

    // The docked terminal is visible by default since #674, so put it away
    // first — the stock window is no longer the hidden-panel state.
    await expect.poll(async () => (await terminalState(win)).visible, { timeout: 20000 }).toBe(true)
    await win.keyboard.press('Control+Backquote')
    await expect.poll(async () => (await terminalState(win)).visible, { timeout: 10000 }).toBe(false)

    await runPaletteCommand(win, 'New terminal')
    await expect
      .poll(async () => (await terminalState(win)).panes, { timeout: 20000 })
      .toBeGreaterThan(0)
    expect((await terminalState(win)).visible).toBe(true)

    expect(appErrors(errors)).toEqual([])
  })

  // ── CONTROL 2 ────────────────────────────────────────────────────────────
  // "Split terminal" really reaches main and really adds a pane when the panel
  // is up. Without this the hidden-panel tripwire could pass vacuously on a
  // command that is simply broken everywhere.
  test('control: "Split terminal" adds a pane while the panel is visible', async ({
    window: win,
  }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(error.message))

    const root = await seedProject(win, 'flow-ux-pal-sv-', (dir) => {
      writeFileSync(join(dir, 'seed.txt'), 'hello\n')
    })
    await activateProject(win, root)
    await win.waitForTimeout(800)

    // Visible by default (#674) with its one auto-started shell — no ⌃` needed
    // (pressing it now would HIDE the panel).
    await expect
      .poll(async () => (await terminalState(win)).panes, { timeout: 20000 })
      .toBe(1)
    expect((await terminalState(win)).visible).toBe(true)

    await runPaletteCommand(win, 'Split terminal')
    await expect
      .poll(async () => (await terminalState(win)).panes, { timeout: 20000 })
      .toBe(2)
    expect((await terminalState(win)).visible).toBe(true)

    expect(appErrors(errors)).toEqual([])
  })

  // ── CONTROL 3 ────────────────────────────────────────────────────────────
  // The "New task" form opens anchored under its button and really creates the
  // task when the Threads pane is the one on screen.
  test('control: "New task" opens under its button and creates the task', async ({
    window: win,
  }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(error.message))

    const root = await seedProject(win, 'flow-ux-pal-nk-', (dir) => {
      writeFileSync(join(dir, 'seed.txt'), 'hello\n')
    })
    await activateProject(win, root)
    await win.waitForTimeout(800)

    await runPaletteCommand(win, 'New task')
    const anchored = await popupGeometry(win)
    expect(anchored.present).toBe(true)
    expect(anchored.anchorOnScreen).toBe(true)
    // Opened BELOW the title bar, i.e. genuinely anchored to its button.
    expect(anchored.overlapsTitlebar).toBe(false)

    await win.locator('.fl-thread-menu input[type="text"]').first().fill('ANCHORED_TASK')
    await win.locator('.fl-thread-menu button', { hasText: 'Create task' }).first().click()
    await expect
      .poll(
        async () =>
          win.evaluate(
            async (path) =>
              (
                await (
                  window as unknown as {
                    flow: { tasks: { list(request: { projectRoot: string }): Promise<{ title: string }[]> } }
                  }
                ).flow.tasks.list({ projectRoot: path })
              ).map((task) => task.title),
            root,
          ),
        { timeout: 15000 },
      )
      .toContain('ANCHORED_TASK')

    expect(appErrors(errors)).toEqual([])
  })

  // ── TRIPWIRE 1 ───────────────────────────────────────────────────────────
  test.fixme(
    '"Split terminal" surfaces the terminal it split (hidden panel, live shell)',
    async ({ window: win }) => {
      const errors: string[] = []
      win.on('pageerror', (error) => errors.push(error.message))

      const root = await seedProject(win, 'flow-ux-pal-sh-', (dir) => {
        writeFileSync(join(dir, 'seed.txt'), 'hello\n')
      })
      await activateProject(win, root)
      await win.waitForTimeout(800)

      // A live shell, then ⌃` to put the panel away (the PTY stays alive).
      await win.keyboard.press('Control+Backquote')
      await expect
        .poll(async () => (await terminalState(win)).panes, { timeout: 20000 })
        .toBe(1)
      await win.keyboard.press('Control+Backquote')
      await expect
        .poll(async () => (await terminalState(win)).visible, { timeout: 10000 })
        .toBe(false)

      await runPaletteCommand(win, 'Split terminal')
      await win.waitForTimeout(2000)
      await win.screenshot({ path: `${SCREENS}/panels-palette-split-hidden.png` })

      // The user asked for a split and must be able to SEE the result of it —
      // exactly what "New terminal" does from the same state (control 1).
      const after = await terminalState(win)
      expect(
        after.visible,
        `the palette split the terminal but left the panel hidden — panes=${after.panes}, nothing on screen`,
      ).toBe(true)
      expect(after.panes).toBe(2)

      expect(appErrors(errors)).toEqual([])
    },
  )

  // ── TRIPWIRE 2 ───────────────────────────────────────────────────────────
  test.fixme(
    '"New task" does not mount its form in the title-bar corner when the sidebar is hidden',
    async ({ window: win }) => {
      const errors: string[] = []
      win.on('pageerror', (error) => errors.push(error.message))

      const root = await seedProject(win, 'flow-ux-pal-nh-', (dir) => {
        writeFileSync(join(dir, 'seed.txt'), 'hello\n')
      })
      await activateProject(win, root)
      await win.waitForTimeout(800)

      // ⌘B — the full-width working state. The form's anchor leaves the DOM.
      await win.keyboard.press('ControlOrMeta+KeyB')
      await win.waitForTimeout(600)

      await runPaletteCommand(win, 'New task')
      const geometry = await popupGeometry(win)
      await win.screenshot({ path: `${SCREENS}/panels-palette-newtask-detached.png` })

      expect(geometry.present).toBe(true)
      // Either the command reveals the sidebar first (so the form is anchored
      // to a visible button), or it opens as a centred modal — both keep it out
      // of the title bar, where the macOS window controls are drawn.
      expect(
        geometry.overlapsTitlebar,
        `the New-task form opened at (${geometry.left}, ${geometry.top}), over the title bar; anchor on screen = ${geometry.anchorOnScreen}`,
      ).toBe(false)

      expect(appErrors(errors)).toEqual([])
    },
  )
})
