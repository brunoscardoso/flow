import { test, expect, dismissOnboarding } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds } from './fixtures/seed'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal), round 24: the RENDERER RELOAD seam.
 *
 * View ▸ Reload (⌘R — the stock Electron `role: 'viewMenu'` in main/menu.ts)
 * tears the renderer down in place while every PTY keeps running in the MAIN
 * process. terminal-panel.ts's boot path is built for exactly that: it calls
 * `terminal:list`, re-adds a tab per surviving terminal, and main replays each
 * one's retained scrollback as `terminal:data` (the panel's header calls out
 * that the replay "can race terminal:list's response", which is why the pending
 * buffer exists).
 *
 * None of the 35 prior terminal specs reload the window — they drive shell
 * lifecycle (open/run/close/switch/split/resize/scoping/theme/cwd/rename/exit
 * recovery/drain/Ctrl keys/clipboard). So "your shells survive ⌘R" has never
 * been observed end-to-end, even though the editor's equivalent (#1072) is
 * guarded by editor-window-reload-dirty.spec.ts.
 *
 * Test 1 (green) locks in the healthy half: the same PTY comes back — same
 * `$$`, same tab, with its scrollback — and keeps taking input.
 *
 * Test 2 is the finding: a SPLIT ROW does not survive the reload. Both shells
 * live on, but `layout` is renderer-only in-memory state rebuilt from
 * `terminal:list` with `addTerminal` (one group per terminal), so the
 * side-by-side row the user arranged collapses into plain tabs — while the
 * pane SIZES they dragged *are* persisted (`localStorage[SPLIT_SIZES_KEY]`),
 * so the one piece of the layout that survives is the one that no longer has
 * anything to size.
 *
 * NOTE for future probes: `terminal:list` doubles as the scrollback-replay
 * channel (main re-sends every terminal's history to the caller), so a spec
 * must NOT call `flow.terminal.list()` to introspect — each call re-prints the
 * whole history into the live xterm and looks exactly like a duplication bug.
 * Observe the shell through `$$` and the DOM instead.
 */

const SCREENS = 'e2e/ux/__screens'
const MARKER = 'RELOAD_BEFORE_4471'
const AFTER = 'RELOAD_AFTER_9922'

const activeHost = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const activeRows = (win: Page) => activeHost(win).first().locator('.xterm-rows')
const helperTextarea = (win: Page) =>
  win.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea').first()
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const splitBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="Split terminal"]')
/** Panes currently on screen together — the split row. */
const panes = (win: Page) => win.locator('.fl-term-split .fl-term-host:not([hidden])')
const renameInput = (win: Page) => win.locator('.fl-term-tabs .rename-input')

const appErrors = (errors: string[]): string[] => errors.filter((m) => m !== 'Canceled')

/** Wait for a real shell PROMPT, not merely the first byte: typing before zsh's
 *  ZLE starts is echoed by the tty line discipline and then re-echoed by the
 *  prompt, which looks like duplicated output. Matches a bare `$ % # >` at end
 *  of line or an oh-my-zsh style `➜ dir git:(main)` arrow — never one
 *  machine's theme. */
async function waitPrompt(win: Page): Promise<void> {
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 20000,
  })
  await expect
    .poll(async () => (await activeRows(win).innerText()) ?? '', { timeout: 25000 })
    .toMatch(/(?:[$%#>]\s*$)|(?:➜[^\n]*$)/m)
}

/** Start a project-scoped shell with the + button (never the toggle, which
 *  HIDES the docked-by-default panel — #674) and wait for its first prompt. */
async function ensureScopedShell(win: Page): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) await newBtn(win).click()
  await waitPrompt(win)
}

async function focusShell(win: Page): Promise<void> {
  await activeHost(win).first().click()
  await expect(helperTextarea(win)).toBeFocused()
}

/** Run a command and wait for `marker` to come back as OUTPUT — a line of its
 *  own, not the echoed command. That distinction is what proves the shell
 *  really executed it (a tty echo before ZLE starts looks identical). */
async function runAndExpect(win: Page, command: string, marker: RegExp): Promise<string> {
  await focusShell(win)
  await win.keyboard.type(`${command}\n`)
  await expect
    .poll(async () => (await activeRows(win).innerText()) ?? '', { timeout: 15000 })
    .toMatch(marker)
  return (await activeRows(win).innerText()) ?? ''
}

/** The live shell's own pid — the identity check a tab label can't fake. */
async function shellPid(win: Page, label: string): Promise<string> {
  const rows = await runAndExpect(
    win,
    `echo ${label}=$$`,
    new RegExp(`^\\s*${label}=\\d+\\s*$`, 'm'),
  )
  return new RegExp(`^\\s*${label}=(\\d+)\\s*$`, 'm').exec(rows)?.[1] ?? ''
}

/** Exactly what the View ▸ Reload menu item invokes. */
async function reloadRenderer(app: ElectronApplication, win: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.reload()
  })
  await win.waitForTimeout(500)
  await win.waitForLoadState('domcontentloaded')
  await dismissOnboarding(win)
  await dismissFlowOverlay(win)
}

test.afterAll(() => cleanupSeeds())

test('a renderer reload (View ▸ Reload / ⌘R) hands back the same live shell, with its scrollback', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await ensureScopedShell(window)
  await runAndExpect(window, `echo ${MARKER}`, new RegExp(`^\\s*${MARKER}\\s*$`, 'm'))
  const pidBefore = await shellPid(window, 'PIDONE')
  expect(pidBefore).not.toBe('')

  const tabsBefore = await termTabs(window).count()
  await window.screenshot({ path: `${SCREENS}/terminal-reload-01-before.png` })

  await reloadRenderer(app, window)

  await expect(window.locator(sel.terminalRoot)).toBeVisible({ timeout: 15000 })
  await expect(window.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 15000,
  })
  await window.screenshot({ path: `${SCREENS}/terminal-reload-02-after.png` })

  // No duplicate shell, and the tab is LIVE — a reload must never hand back a
  // dead "(exited)" host that silently swallows keystrokes (#439/#957).
  await expect(termTabs(window)).toHaveCount(tabsBefore)
  await expect(termTabs(window).first()).not.toContainText('exited')

  // Scrollback replay: what the user ran before the reload is still readable…
  await expect
    .poll(async () => (await activeRows(window).innerText()) ?? '', { timeout: 15000 })
    .toMatch(new RegExp(`^\\s*${MARKER}\\s*$`, 'm'))

  // …and the shell they get back is the SAME process, still taking input.
  await waitPrompt(window)
  await runAndExpect(window, `echo ${AFTER}`, new RegExp(`^\\s*${AFTER}\\s*$`, 'm'))
  expect(await shellPid(window, 'PIDTWO')).toBe(pidBefore)
  await window.screenshot({ path: `${SCREENS}/terminal-reload-03-alive.png` })

  expect(appErrors(errors), appErrors(errors).join(', ')).toEqual([])
})

/** Arrange the panel the way a user would: split into a row, name the panes
 *  apart. Returns the tab count that must survive the reload. */
async function arrangeSplitAndRename(window: Page, name: string): Promise<number> {
  await expect(panes(window)).toHaveCount(1)
  await splitBtn(window).click()
  await expect(panes(window)).toHaveCount(2, { timeout: 20000 })
  await expect(panes(window).nth(1).locator('.xterm')).toBeVisible({ timeout: 15000 })

  // Name the two shells apart (#774) — without it both tabs carry the same
  // project name, which is the whole reason rename exists.
  await termTabs(window).nth(0).dblclick()
  await expect(renameInput(window)).toBeVisible()
  await renameInput(window).fill(name)
  await renameInput(window).press('Enter')
  await expect(termTabs(window).nth(0)).toContainText(name)
  return termTabs(window).count()
}

test('both shells of a split row survive a renderer reload and stay reachable', async ({
  app,
  window,
}) => {
  // The healthy half of #1445: the PTYs are main-process state, so nothing is
  // destroyed by the reload — both terminals come back in the strip, and the
  // one on screen is live.
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await ensureScopedShell(window)
  const tabsBefore = await arrangeSplitAndRename(window, 'server')
  expect(tabsBefore).toBe(2)
  await window.screenshot({ path: `${SCREENS}/terminal-reload-04-split-before.png` })

  await reloadRenderer(app, window)

  await expect(window.locator(sel.terminalRoot)).toBeVisible({ timeout: 15000 })
  await expect(window.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 15000,
  })
  await expect(termTabs(window)).toHaveCount(tabsBefore, { timeout: 15000 })
  await expect(termTabs(window).first()).not.toContainText('exited')
  await window.screenshot({ path: `${SCREENS}/terminal-reload-05-split-after.png` })

  // The terminal handed back is a working shell, not a restored husk.
  await waitPrompt(window)
  await runAndExpect(window, 'echo SPLIT_ALIVE_31', /^\s*SPLIT_ALIVE_31\s*$/m)

  expect(appErrors(errors), appErrors(errors).join(', ')).toEqual([])
})

// ── #1445 tripwire ─────────────────────────────────────────────────────────
// What the reload does NOT hand back is everything the user ARRANGED. `layout`
// (terminal-split.ts) and `tab.customTitle` are renderer-closure state rebuilt
// from `terminal:list` as one unnamed group per terminal, so the row collapses
// into plain tabs and the names revert — leaving two identically-labelled tabs
// and no split, with no message. Un-fixme when #1445 lands.
test(
  '#1445: a split row and its custom tab names survive View ▸ Reload (⌘R)',
  async ({ app, window }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    await ensureScopedShell(window)
    const tabsBefore = await arrangeSplitAndRename(window, 'server')

    await reloadRenderer(app, window)

    await expect(termTabs(window)).toHaveCount(tabsBefore, { timeout: 15000 })
    // Observed on current main: 1 pane (the row collapsed) …
    await expect(panes(window)).toHaveCount(2, { timeout: 10000 })
    // … and the tab reads the project name again, not "server".
    await expect(termTabs(window).nth(0)).toContainText('server')
  },
)
