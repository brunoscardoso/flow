import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * UX sweep — flow 8 (Terminal): the panel's two POPUP surfaces, and the mouse
 * gesture that has none.
 *
 * Terminal is the most-covered flow in the rotation (28 specs across 18 rounds:
 * open/run/close/switch, resize, scoping, theme, exit recovery, rename, tab
 * overflow, cwd-follow, pending-buffer drain, control-key steal, interrupt,
 * project-switch, unscoped orphan, panel height, ⌘W, collapse, footer button,
 * rail mount, select-to-chat, slot replace, tab-switch isolation, background
 * drain). Every one of them drives a BUTTON, a KEY or a TAB. None asks what the
 * two right-hand-side affordances a real user reaches for actually do:
 *
 *   1. Right-click INSIDE the shell — the reflexive copy/paste gesture on every
 *      other terminal (VS Code, iTerm2, Terminal.app, Windows Terminal). The
 *      terminal body has no `contextmenu` handler at all, and main registers no
 *      `webContents.on('context-menu')` either (verified in-test), so the click
 *      is inert. Its own tab strip one row above DOES open a menu (#735) — the
 *      control below proves the gesture reaches the panel.
 *
 *   2. The "New terminal in:" root picker (multi-project threads, #927/#695) —
 *      the ONLY route to a shell in a secondary root. It dismisses on an outside
 *      mousedown only: Escape is dead, and it has no focus/arrow/Enter handling,
 *      so the palette's "New terminal" (the keyboard route that opens it) hands
 *      the keyboard user a popup they can neither operate nor dismiss. Same class as #638 (project switcher
 *      ignores Escape) and #539 (multi-project new-thread chooser, backdrop-only)
 *      — both accepted and fixed; this sibling popup was missed.
 *
 * Live controls here (the healthy behaviour these guards protect):
 *   - the tab strip's close-ops menu opens on right-click AND closes on Escape,
 *   - the root picker lists every scope root and opens the shell in the picked
 *     root's cwd (verified from the shell's own `pwd`, not the tab label).
 */

const activeHost = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const activeRows = (win: Page) => activeHost(win).locator('.xterm-rows')
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const rootMenu = (win: Page) => win.locator('.fl-term-root-menu')

async function revealTerminal(win: Page): Promise<void> {
  // ⌃` TOGGLES — press it only when the panel is genuinely absent.
  if ((await win.locator(sel.terminalRoot).count()) === 0) {
    await win.keyboard.press('Control+`')
  }
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
}

/** Wait for a real shell PROMPT, not merely the first byte: typing before zsh's
 *  ZLE starts is echoed by the tty line discipline and then re-echoed by the
 *  prompt, which looks like duplicated output. */
async function waitPrompt(win: Page): Promise<void> {
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 20000,
  })
  await expect
    .poll(async () => (await activeRows(win).innerText()) ?? '', { timeout: 25000 })
    .toMatch(/(?:[$%#>]\s*$)|(?:➜[^\n]*$)/m) // any shell prompt, not one machine's theme
}

async function typeInShell(win: Page, text: string): Promise<void> {
  await activeHost(win).click()
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea')).toBeFocused()
  await win.keyboard.type(text)
  await win.keyboard.press('Enter')
}

/** The fl-tabs close-ops menu lives in the strip's (open) shadow root. */
const tabCtxItems = (win: Page): Promise<string[]> =>
  win.evaluate(() => {
    const strip = document.querySelector('.fl-term-tabs') as HTMLElement | null
    return [...(strip?.shadowRoot?.querySelectorAll('.ctx-item') ?? [])].map(
      (i) => (i as HTMLElement).textContent?.trim() ?? '',
    )
  })

/** Seed two projects and put the terminal under a REAL multi-root thread scope. */
async function multiRootScope(win: Page): Promise<{ alpha: string; beta: string }> {
  const alpha = await seedProject(win, 'flow-alpha-')
  const beta = await seedProject(win, 'flow-beta-')
  await activateProject(win, alpha)
  const thread = await win.evaluate(
    async ({ a, b }) =>
      (window as never as { flow: { threads: { create(r: unknown): Promise<{ id: string }> } } }).flow.threads.create({
        projectRoot: a,
        additionalRoots: [b],
        title: 'multi alpha+beta',
      }),
    { a: alpha, b: beta },
  )
  await win.evaluate(
    async ({ root, tid }) => {
      await (
        window as never as {
          flow: { project: { setActiveThread(r: unknown): Promise<void> } }
        }
      ).flow.project.setActiveThread({ rootPath: root, threadId: tid })
    },
    { root: alpha, tid: thread.id },
  )
  // Since f6ef9977 a shell belongs to the conversation ON SCREEN: the project
  // view keeps spawning in its own root, so the thread has to be opened.
  await openThreadByTitle(win, 'multi alpha+beta')
  await expect
    .poll(
      async () =>
        win.evaluate(async () =>
          (
            await (
              window as never as {
                flow: { project: { getThreadScope(): Promise<{ list: { name: string }[] }> } }
              }
            ).flow.project.getThreadScope()
          ).roots.length,
        ),
      { timeout: 10000 },
    )
    .toBe(2)
  return { alpha, beta }
}

test.afterAll(() => cleanupSeeds())

test.describe('terminal popup affordances', () => {
  test('control: the tab strip close-ops menu opens on right-click and closes on Escape', async ({
    window: win,
  }) => {
    const dir = await seedProject(win, 'flow-term-ctx-')
    await activateProject(win, dir)
    await revealTerminal(win)
    await waitPrompt(win)
    await expect(termTabs(win)).toHaveCount(1)

    await termTabs(win).first().click({ button: 'right' })
    await expect.poll(() => tabCtxItems(win), { timeout: 5000 }).toEqual([
      'Close',
      'Close Others',
      'Close to the Left',
      'Close to the Right',
      'Close All',
    ])

    // Escape closes it — the in-app convention this spec measures the terminal's
    // OWN root picker against (fl-tabs.ts dismiss handler).
    await win.keyboard.press('Escape')
    await expect.poll(() => tabCtxItems(win), { timeout: 5000 }).toEqual([])
  })

  test('control: the root picker lists every scope root and lands the shell in the picked cwd', async ({
    window: win,
  }) => {
    const { beta } = await multiRootScope(win)
    await revealTerminal(win)
    await waitPrompt(win)

    // The palette's "New terminal" (flow:show-terminal on an already-visible
    // panel → flow:terminal-new) is the KEYBOARD route into this popup; the +
    // button is the mouse one. Both land in the same picker.
    await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:show-terminal')))
    await expect(rootMenu(win)).toBeVisible({ timeout: 5000 })
    await expect(rootMenu(win).locator('.fl-term-root-menu-label')).toHaveText('New terminal in:')
    const rows = rootMenu(win).locator('.fl-term-root-item')
    await expect(rows).toHaveCount(2)

    await rows.filter({ hasText: 'flow-beta-' }).first().click()
    await expect(rootMenu(win)).toHaveCount(0)
    await expect(termTabs(win)).toHaveCount(2, { timeout: 20000 })
    await waitPrompt(win)

    // The shell's OWN cwd, not the tab label — a mislabelled tab in the right
    // repo and a right-labelled tab in the WRONG repo look identical otherwise.
    const proof = join(beta, 'CWD-PROOF.txt')
    await typeInShell(win, `pwd > ${proof}`)
    await expect.poll(() => existsSync(proof), { timeout: 20000 }).toBe(true)
    expect(readFileSync(proof, 'utf8').trim()).toBe(beta)
  })

  // ── Tripwires for the two filed defects (fix-agnostic) ─────────────────

  test('right-click inside the shell opens a context menu', async ({ window: win, app }) => {
    const dir = await seedProject(win, 'flow-term-rc-')
    await activateProject(win, dir)
    await revealTerminal(win)
    await waitPrompt(win)

    // Rule out a NATIVE menu Playwright cannot see (runbook caution): main
    // registers no context-menu handler, so nothing is hidden from the assert.
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.listenerCount('context-menu'),
      ),
    ).toBe(0)

    const box = await activeRows(win).boundingBox()
    await win.mouse.click((box?.x ?? 0) + 60, (box?.y ?? 0) + 30, { button: 'right' })
    await win.waitForTimeout(500)
    const menus = await win.evaluate(() => {
      const inLight = document.querySelectorAll('.ctx-menu, .fl-context-menu').length
      const inShadow = [...document.querySelectorAll('*')].filter(
        (el) => (el as HTMLElement).shadowRoot?.querySelector('.ctx-menu'),
      ).length
      return inLight + inShadow
    })
    expect(menus, 'right-click in the terminal body opened no menu').toBeGreaterThan(0)
  })

  test('the "New terminal in:" root picker is keyboard-operable (#1150)', async ({
    window: win,
  }) => {
    await multiRootScope(win)
    await revealTerminal(win)
    await waitPrompt(win)

    await newBtn(win).click()
    await expect(rootMenu(win)).toBeVisible({ timeout: 5000 })

    // Escape closes it — the dead key this issue was filed for.
    await win.keyboard.press('Escape')
    await expect(rootMenu(win)).toHaveCount(0)

    // …and Enter does not stack a SECOND picker on the first: with focus back
    // on +, re-opening replaces rather than accumulates.
    await win.keyboard.press('Enter')
    await expect(rootMenu(win)).toHaveCount(1)
    await win.keyboard.press('Enter')
    await expect(rootMenu(win)).toHaveCount(1)

    // Arrows move between roots without a click.
    await win.keyboard.press('ArrowDown')
    expect(
      await win.evaluate(() =>
        document.activeElement?.classList.contains('fl-term-root-item'),
      ),
      'ArrowDown focuses the first root row',
    ).toBe(true)
    await win.keyboard.press('Escape')
    await expect(rootMenu(win)).toHaveCount(0)
  })
})
