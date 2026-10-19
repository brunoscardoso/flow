import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { sel } from '../selectors'

/**
 * UX sweep — flow 8 (Terminal). The side-by-side split (#1133) is brand new, and
 * `terminal-split.spec.ts` guards the happy loop: split → two live panes → focus
 * follows the click → closing one collapses the row. What NOTHING guards is what
 * happens to a split row over its LIFETIME:
 *
 *  1. **A pane whose shell dies.** The app states the same contract three times —
 *     "never leave the user on a dead (exited) terminal while a live one exists"
 *     (#439 reveal path, #957 project-switch path, `firstLiveVisibleTab`'s own
 *     doc comment). Both fixes fire only when NO live shell exists, so in a split
 *     row — where a live shell is literally beside the corpse — neither ever runs.
 *     `onExit` marks the tab, writes the marker, re-renders the strip, and leaves
 *     keyboard focus (and the panel's own blue `focused` border) in the dead pane.
 *
 *  2. **The ratio you drag.** `fl-split` resets `#sizes` whenever the pane COUNT
 *     changes, and `renderPanes` empties the row into the stash every time the
 *     visible group changes — so one trip to another terminal tab (or a project
 *     switch and back) silently returns a tuned 82/18 row to 50/50. The panel
 *     HEIGHT learned to survive exactly this (#1059); the new row didn't inherit it.
 *
 * Live guards keep the regressions honest: the split really produces two live
 * panes, the divider drag really re-sizes them, and the exit path really fires.
 * The two tripwires below were each verified genuinely RED against main, and
 * are now live — #1293 hands the keyboard to a live sibling when a shell dies
 * in place, #1294 remembers the row's ratio across leaving and re-entering it.
 */

const SCREEN_DIR = 'e2e/ux/__screens'
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const splitBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="Split terminal"]')
/** The panes currently on screen — the row. */
const panes = (win: Page) => win.locator('.fl-term-split .fl-term-host:not([hidden])')
const rowsOf = (win: Page, i: number) => panes(win).nth(i).locator('.xterm-rows')

/** Wait for a real shell PROMPT, not merely the first byte: typing before zsh's
 *  ZLE starts is echoed by the tty line discipline and looks like real output. */
async function waitPrompt(win: Page, i: number): Promise<void> {
  await expect(panes(win).nth(i).locator('.xterm')).toBeVisible({ timeout: 20000 })
  // Match ANY shell prompt, not one machine's theme. This waited for `git:(` —
  // an oh-my-zsh git segment that exists only on the author's setup, so the
  // spec failed on every other machine and on CI. A prompt is a line ending in
  // one of the standard sigils, optionally followed by the cursor's space.
  await expect
    .poll(async () => (await rowsOf(win, i).innerText()) ?? '', { timeout: 25000 })
    .toMatch(/(?:[$%#>]\s*$)|(?:➜[^\n]*$)/m)
}

async function runIn(win: Page, i: number, cmd: string): Promise<void> {
  await panes(win).nth(i).click({ position: { x: 6, y: 6 } })
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
}

async function paneWidths(win: Page): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < (await panes(win).count()); i++) {
    out.push(Math.round((await panes(win).nth(i).boundingBox())?.width ?? 0))
  }
  return out
}

/** Drag the divider by `dx` px. The handle lives in <fl-split>'s shadow root, so
 *  it has no light-DOM locator — measure it, then drive the real mouse. */
async function dragDivider(win: Page, dx: number): Promise<void> {
  const at = await win.locator('.fl-term-split').evaluate((el) => {
    const shadow = (el as HTMLElement & { shadowRoot: ShadowRoot }).shadowRoot
    const box = (shadow.querySelector('.handle') as HTMLElement).getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })
  await win.mouse.move(at.x, at.y)
  await win.mouse.down()
  await win.mouse.move(at.x + dx / 2, at.y, { steps: 6 })
  await win.mouse.move(at.x + dx, at.y, { steps: 6 })
  await win.mouse.up()
}

/** A seeded project pops a "Run a basic discovery?" prompt over the bottom-right
 *  work surface — dismiss it so it can't overlap the evidence screenshots. */
async function dismissDiscoveryToast(win: Page): Promise<void> {
  const notNow = win.locator('button', { hasText: 'Not now' })
  if (await notNow.count()) await notNow.first().click().catch(() => undefined)
}

/** Seed a project, reveal the terminal, and split its shell into two live panes. */
async function openSplitRow(win: Page): Promise<void> {
  const root = await seedProject(win)
  await activateProject(win, root)
  // The terminal is docked-VISIBLE by default (#674), and since #1341 it
  // survives opening your first project — so clicking the rail item now
  // HIDES it. Reveal only when it isn't already on screen.
  if (!(await win.locator('.fl-term-root').isVisible())) {
    await win.locator('.fl-editor-actions .fl-rail-item[aria-label="Terminal"]').click()
  }
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) await newBtn(win).click()
  await waitPrompt(win, 0)
  await splitBtn(win).click()
  await expect(panes(win)).toHaveCount(2, { timeout: 20000 })
  await waitPrompt(win, 1)
  await dismissDiscoveryToast(win)
}

test.afterAll(() => cleanupSeeds())
test.describe.configure({ mode: 'default' })
test.setTimeout(220_000)

// ── Live guards ────────────────────────────────────────────────────────────

test('a split pane whose shell exits is marked dead beside a live sibling', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  await openSplitRow(window)

  // Prove the LEFT pane is alive and stays alive — without it, "the right pane
  // is dead" says nothing about the app leaving you in the wrong one.
  await runIn(window, 0, 'echo LEFT_PANE_IS_ALIVE')
  await expect
    .poll(async () => rowsOf(window, 0).innerText(), { timeout: 15000 })
    .toContain('LEFT_PANE_IS_ALIVE')

  // Kill the right pane's shell — the one the split just handed focus to.
  await runIn(window, 1, 'exit')
  await expect
    .poll(async () => rowsOf(window, 1).innerText(), { timeout: 15000 })
    .toContain('process exited')
  // The row does NOT collapse: the corpse keeps its half of the screen, and the
  // strip labels it. Both are the app's deliberate "keep the scrollback" stance.
  await expect(panes(window)).toHaveCount(2)
  await expect(termTabs(window).filter({ hasText: '(exited)' })).toHaveCount(1)
  await window.screenshot({ path: `${SCREEN_DIR}/terminal-split-dead-pane.png` })

  expect(errors, `renderer errors:\n${errors.join('\n')}`).toEqual([])
})

test('the divider drag really re-sizes the row and the PTYs follow it', async ({ window }) => {
  await openSplitRow(window)

  const even = await paneWidths(window)
  expect(even, 'a fresh split starts even').toHaveLength(2)
  expect(Math.abs(even[0]! - even[1]!), 'a fresh split starts even').toBeLessThan(12)

  await dragDivider(window, 220)
  await expect
    .poll(async () => (await paneWidths(window))[0]! - (await paneWidths(window))[1]!, {
      timeout: 5000,
    })
    .toBeGreaterThan(120)

  // A drag that moves pixels but never reaches the shell would leave running
  // programs wrapping at the old width — ask each shell what IT thinks.
  await runIn(window, 0, 'echo "WIDE=$(tput cols)"')
  await expect.poll(async () => rowsOf(window, 0).innerText(), { timeout: 15000 }).toMatch(/WIDE=\d+/)
  await runIn(window, 1, 'echo "NARROW=$(tput cols)"')
  await expect.poll(async () => rowsOf(window, 1).innerText(), { timeout: 15000 }).toMatch(/NARROW=\d+/)
  const wide = Number(/WIDE=(\d+)/.exec((await rowsOf(window, 0).innerText()).split('echo').join(''))?.[1])
  const narrow = Number(/NARROW=(\d+)/.exec((await rowsOf(window, 1).innerText()).split('echo').join(''))?.[1])
  expect(wide, 'the widened pane\'s PTY followed the divider').toBeGreaterThan(narrow)
  await window.screenshot({ path: `${SCREEN_DIR}/terminal-split-ratio-tuned.png` })
})

// ── Both FIXED (#1293, #1294); the guards below are live ───────────────────

// #1293: the exit handler now hands the keyboard to a live pane in the same
// row (right, then left — the adjacency rule used everywhere else), and
// re-renders so the focus marker stops claiming a dead pane.
test(
  'a shell that exits must not keep the keyboard while a live pane sits beside it',
  async ({ window }) => {
    await openSplitRow(window)
    await runIn(window, 0, 'echo LEFT_PANE_IS_ALIVE')
    await expect
      .poll(async () => rowsOf(window, 0).innerText(), { timeout: 15000 })
      .toContain('LEFT_PANE_IS_ALIVE')

    const deadId = await panes(window).nth(1).getAttribute('data-terminal-id')
    await runIn(window, 1, 'exit')
    await expect
      .poll(async () => rowsOf(window, 1).innerText(), { timeout: 15000 })
      .toContain('process exited')
    await window.waitForTimeout(1500)

    // The contract, in the app's own words (`firstLiveVisibleTab`, #439, #957):
    // an arrival must never hand the user a dead "(exited)" host while a live
    // sibling exists. Dying in place is an arrival too. Any fix satisfies this —
    // close the pane, move focus to the survivor, or restart the shell.
    const focusIsInCorpse = await window.evaluate((id) => {
      const host = (document.activeElement as HTMLElement | null)?.closest('.fl-term-host')
      return (host as HTMLElement | null)?.dataset['terminalId'] === id
    }, deadId)
    expect(
      focusIsInCorpse,
      'keyboard focus stayed inside the exited shell — everything typed is silently swallowed',
    ).toBe(false)
    // ...and the panel must not point its "your keystrokes go here" marker at it.
    await expect(panes(window).nth(1)).not.toHaveClass(/focused/)
  },
)

// #1294: ratios are remembered per ROW (keyed by membership) and persisted,
// and re-applied after fl-split's MutationObserver rebuild resets them.
test('a tuned split ratio survives leaving and re-entering the row', async ({ window }) => {
  await openSplitRow(window)
  await dragDivider(window, 220)
  await expect
    .poll(async () => (await paneWidths(window))[0]! - (await paneWidths(window))[1]!, {
      timeout: 5000,
    })
    .toBeGreaterThan(120)
  const tuned = await paneWidths(window)

  // Leave the row: a NEW terminal opens in its own group, so the split's hosts
  // are stashed. Then come back to it — the way anyone with three terminals does.
  await newBtn(window).click()
  await expect(panes(window)).toHaveCount(1, { timeout: 20000 })
  await termTabs(window).nth(0).click()
  await expect(panes(window)).toHaveCount(2, { timeout: 20000 })
  await window.waitForTimeout(1200)

  const back = await paneWidths(window)
  await window.screenshot({ path: `${SCREEN_DIR}/terminal-split-ratio-reset.png` })
  expect(
    Math.abs(back[0]! - tuned[0]!),
    `the row you tuned to ${tuned.join('/')} came back as ${back.join('/')}`,
  ).toBeLessThan(40)
})
