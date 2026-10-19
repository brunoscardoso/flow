import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal): who owns a `Ctrl+<key>` chord while the shell
 * has keyboard focus.
 *
 * The shell registers its panel/palette shortcuts on `window` in the CAPTURE
 * phase (shell.ts:533) with `const mod = event.ctrlKey || event.metaKey` and no
 * terminal-focus exemption. Round 9 proved Ctrl+C / Ctrl+L reach the PTY — but
 * those two simply aren't in the router. The chords that ARE in it (B, J, P,
 * 1-5) are the reflexive readline / tmux / vim keys, and `preventDefault()`
 * does not stop propagation, so each one fires the app action *and* reaches the
 * shell:
 *
 *   Ctrl+P  → command palette opens & steals focus (readline previous-history)
 *   Ctrl+J  → the whole terminal panel hides (accept-line / literal LF)
 *   Ctrl+B  → the activity sidebar collapses (backward-char / tmux prefix)
 *   Ctrl+1-5 → the sidebar rail switches / Board / Blueprint open
 *
 * Live guards below cover what DOES work — the keystroke genuinely reaching the
 * PTY, and the INTENDED ⌘ bindings still working from inside the terminal (the
 * #683/#525-adjacent contract flow-12 round 8 pinned down). The #1099 guards
 * are live (fixed: the router yields Ctrl-only chords to a focused terminal);
 * the palette's focus loss on Escape remains #1100's tripwires.
 *
 * Panel state: a fresh profile no longer mounts the docked terminal (#674's
 * default has since moved), so `ensureScopedShell` reveals it with ⌃` ONLY when
 * it is absent — pressing the toggle unconditionally would hide an already
 * docked panel (see terminal-resize.spec.ts) — and starts the scoped shell with
 * the + button rather than the toggle.
 */

const SCREEN_DIR = 'e2e/ux/__screens'
const PALETTE = '.fl-settings-overlay:not([hidden]):has(.fl-palette-panel)'

const activeHost = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const activeRows = (win: Page) => activeHost(win).locator('.xterm-rows')
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

async function ensureScopedShell(win: Page): Promise<void> {
  // The docked panel is no longer mounted for a fresh profile, so reveal it
  // when it is genuinely absent. ⌃` TOGGLES — pressing it unconditionally would
  // hide an already-docked terminal (see terminal-resize.spec.ts).
  if ((await win.locator(sel.terminalRoot).count()) === 0) {
    await win.keyboard.press('Control+`')
  }
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) {
    await newBtn(win).click()
  }
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 15000,
  })
  await expect
    .poll(async () => ((await activeRows(win).innerText()) ?? '').trim().length, { timeout: 10000 })
    .toBeGreaterThan(0)
}

/** Click into the shell and prove xterm really holds the keyboard — without
 *  this every "the shortcut fired" assertion below would be vacuous. */
async function focusShell(win: Page): Promise<void> {
  await activeHost(win).click()
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea')).toBeFocused()
}

const rowsText = async (win: Page): Promise<string> => (await activeRows(win).innerText()) ?? ''

/** Is the activity sidebar (threads/files/source-control) on screen? */
const sidebarVisible = (win: Page): Promise<boolean> =>
  win.evaluate(() => {
    const el = document.querySelector('.fl-activity-sidebar')
    return !!el && el.getBoundingClientRect().width > 0
  })

const activeRail = (win: Page): Promise<string> =>
  win.evaluate(
    () =>
      document
        .querySelector('.fl-activity-bar .fl-rail-item.active')
        ?.getAttribute('data-rail-item') ?? 'none',
  )

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

async function seededShell(win: Page): Promise<void> {
  const proj = await seedProject(win)
  await activateProject(win, proj)
  await ensureScopedShell(win)
  await focusShell(win)
}

test.afterAll(() => cleanupSeeds())

test.describe('terminal — control keys vs the global shortcut router', () => {
  // ── Live guards (green: this is the behavior that must not regress) ──────

  test('Ctrl+B reaches the PTY — the shell edits the line (backward-char)', async ({ window }) => {
    const errors = trackErrors(window)
    await seededShell(window)

    await window.keyboard.type('echo hello')
    await window.waitForTimeout(300)
    await window.keyboard.press('Control+b') // readline backward-char
    await window.waitForTimeout(300)
    await window.keyboard.type('X')

    // `hellXo` proves \x02 reached the shell and moved the cursor left.
    await expect
      .poll(async () => await rowsText(window), { timeout: 8000 })
      .toContain('echo hellXo')

    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('the INTENDED ⌘ bindings still work from inside the terminal', async ({ window }) => {
    const errors = trackErrors(window)
    await seededShell(window)

    // ⌘P — the palette's real binding (flow-12 round 8's capture-phase contract).
    // Wait for the palette input to actually take focus before Escape: `open()`
    // unhides the overlay synchronously but only focuses its input after an IPC
    // round trip, and Escape is handled ONLY on that input — an Escape landing
    // in the gap is swallowed (tripwire below, #1100).
    await window.keyboard.press('ControlOrMeta+p')
    await expect(window.locator(PALETTE)).toHaveCount(1)
    await expect(window.locator('.fl-palette-input')).toBeFocused()
    await window.keyboard.press('Escape')
    await expect(window.locator(PALETTE)).toHaveCount(0)

    // ⌘B — the sidebar's real binding, still reaching past xterm.
    await focusShell(window)
    const before = await sidebarVisible(window)
    await window.keyboard.press('ControlOrMeta+b')
    await window.waitForTimeout(400)
    expect(await sidebarVisible(window), '⌘B must still toggle the sidebar').toBe(!before)
    await window.keyboard.press('ControlOrMeta+b')
    await window.waitForTimeout(400)
    expect(await sidebarVisible(window)).toBe(before)

    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
  })

  // ── #1099 guards — the router exempts a focused terminal from Ctrl-only
  //    chords (shell.ts capture handler bails while .fl-term-host has focus). ──

  test(
    'Ctrl+P must not open the command palette while the terminal has focus (#1099)',
    async ({ window }) => {
      await seededShell(window)
      await window.keyboard.type('echo HIST_ONE')
      await window.keyboard.press('Enter')
      await expect.poll(async () => await rowsText(window), { timeout: 8000 }).toContain('HIST_ONE')
      await window.keyboard.type('git stat')
      await window.waitForTimeout(300)

      await window.keyboard.press('Control+p')
      await window.waitForTimeout(700)
      await window.screenshot({ path: `${SCREEN_DIR}/terminal-ctrlp-steal.png` })

      expect(await window.locator(PALETTE).count(), 'Ctrl+P belongs to the shell').toBe(0)
      // …and the half-typed line must survive (the shell may recall history,
      // but the app must not ALSO hijack the keystroke).
      await expect(
        window.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea'),
      ).toBeFocused()
    },
  )

  test(
    'Ctrl+J must not hide the terminal panel while the terminal has focus (#1099)',
    async ({ window }) => {
      await seededShell(window)
      await window.keyboard.type('echo CTRLJ_MARK_42')
      await window.waitForTimeout(300)

      await window.keyboard.press('Control+j') // accept-line / literal LF
      await window.waitForTimeout(900)
      await window.screenshot({ path: `${SCREEN_DIR}/terminal-ctrlj-steal.png` })

      expect(
        await window.locator(sel.terminalPanel).count(),
        'the panel must not vanish as the command runs',
      ).toBe(1)
      await expect.poll(async () => await rowsText(window), { timeout: 8000 }).toContain(
        'CTRLJ_MARK_42',
      )
    },
  )

  test(
    'Ctrl+B must not collapse the activity sidebar while the terminal has focus (#1099)',
    async ({ window }) => {
      await seededShell(window)
      const before = await sidebarVisible(window)

      await window.keyboard.type('echo hello')
      await window.keyboard.press('Control+b') // tmux prefix / backward-char
      await window.waitForTimeout(500)

      expect(await sidebarVisible(window), 'the tmux prefix must not move the layout').toBe(before)
    },
  )

  test(
    'Ctrl+1-5 must not navigate the app while the terminal has focus (#1099)',
    async ({ window }) => {
      await seededShell(window)
      const before = await activeRail(window)

      await window.keyboard.press('Control+2')
      await window.waitForTimeout(600)

      expect(await activeRail(window), 'the rail must not switch under the shell').toBe(before)
    },
  )

  // ── #1100 guards — the palette's dismissal contract (was: two tripwires).
  //    `open()` now focuses its input synchronously, and a CANCEL close hands
  //    the keyboard back to whoever had it (palette-focus.ts). ──────────────

  test(
    'Escape pressed right after ⌘P closes the palette (#1100, second facet)',
    async ({ window }) => {
      await seededShell(window)

      // The gesture of someone who opened the palette and immediately changed
      // their mind — no wait for the input to take focus, because `open()` no
      // longer defers that behind `project.active()` +
      // `loadCommandList()`. It used to, and the ONLY Escape handler lives on
      // that input, so an Escape in the gap was swallowed by xterm and the
      // palette stayed up (4 of 5 runs).
      await window.keyboard.press('ControlOrMeta+p')
      await expect(window.locator(PALETTE)).toHaveCount(1)
      await window.keyboard.press('Escape')

      await expect(window.locator(PALETTE)).toHaveCount(0)
    },
  )

  test(
    'dismissing the palette with Escape returns the keyboard to the terminal (#1100)',
    async ({ window }) => {
      await seededShell(window)
      await window.keyboard.type('echo BEFORE_PALETTE')
      await window.keyboard.press('Enter')
      await expect
        .poll(async () => await rowsText(window), { timeout: 8000 })
        .toContain('BEFORE_PALETTE')

      await window.keyboard.press('ControlOrMeta+p')
      await expect(window.locator(PALETTE)).toHaveCount(1)
      await window.waitForTimeout(500)
      await window.keyboard.press('Escape')
      await expect(window.locator(PALETTE)).toHaveCount(0)
      await window.waitForTimeout(400)

      // The keyboard must be back on the shell — never on <body>, where every
      // following keystroke is silently discarded until the user clicks.
      await expect(
        window.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea'),
      ).toBeFocused()
      await window.keyboard.type('git status --short')
      await expect
        .poll(async () => await rowsText(window), { timeout: 8000 })
        .toContain('git status --short')
    },
  )
})
