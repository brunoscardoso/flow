import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal): the UNSCOPED boot shell vs. opening a project.
 *
 * The docked terminal auto-starts a shell on boot (`ensureStarted` on mount).
 * With no project active yet — first run, or any launch that lands on "No
 * project" — that shell is created UNSCOPED (`projectRoot: undefined`, cwd `~`).
 * Every prior flow-8 probe drove shells that already belonged to a project
 * (open/run/close/switch/resize/scoping/theme/cwd/rename/exit/drain/overflow);
 * none ever drove the shell a user gets BEFORE they open anything.
 *
 * Live guards here (must stay green):
 *   1. With no project open, the auto-started shell is real and usable — it
 *      accepts a command and prints its output.
 *   2. After a project is opened, `+` still hands back a live shell scoped to
 *      that project (`pwd` is the project root), with no uncaught errors — the
 *      documented recovery from the empty strip.
 *
 * #1024 guard (live):
 *   A. Opening the first project must not strand the boot shell.
 *      `setActiveProject` now settles unscoped tabs before scoping hides them
 *      (unscopedTabAction): a boot shell the user TYPED INTO is adopted by the
 *      activating project (tab + processes stay reachable); a pristine one is
 *      disposed and a fresh project-scoped shell auto-starts (ensureStarted on
 *      the switch path). The invariant asserted is fix-agnostic: every terminal
 *      `terminal:list` reports must be reachable as a tab.
 *
 * Docked-visible by default (terminalVisible defaults on, shell.ts) — never
 * toggle-to-open (that HIDES the docked panel), per terminal-resize.spec.ts.
 */

const SCREEN_DIR = 'e2e/ux/__screens'

const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const activeHost = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const activeRows = (win: Page) => activeHost(win).locator('.xterm-rows')

/** Terminals the MAIN process is holding, tab or no tab. */
const mainTerminals = (win: Page) =>
  win.evaluate(async () =>
    (
      window as unknown as {
        flow: { terminal: { list(): Promise<Array<{ terminalId: string; projectRoot?: string }>> } }
      }
    ).flow.terminal.list(),
  )

async function waitForLiveShell(win: Page): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) {
    await newBtn(win).click()
  }
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 15000,
  })
  await expect
    .poll(async () => (await activeRows(win).innerText()).trim().length, { timeout: 10000 })
    .toBeGreaterThan(0)
}

/** Run a command in the focused shell and wait for its echoed line + output. */
async function run(win: Page, command: string, marker: RegExp): Promise<void> {
  await activeHost(win).click()
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea')).toBeFocused()
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
  await expect
    .poll(async () => ((await activeRows(win).innerText()).match(marker) ?? []).length, {
      timeout: 12000,
    })
    .toBeGreaterThanOrEqual(2) // the echoed command line + its output
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

test.afterAll(() => cleanupSeeds())

test.describe('terminal — the unscoped boot shell', () => {
  test('with no project open, the auto-started shell is real and usable', async ({ window }) => {
    const errors = trackErrors(window)

    await waitForLiveShell(window)
    // It really is unscoped — no project has been activated yet.
    const before = await mainTerminals(window)
    expect(before.length).toBeGreaterThan(0)
    expect(before.every((t) => t.projectRoot == null)).toBe(true)

    await run(window, 'echo NO_PROJECT_SHELL_6C1D', /NO_PROJECT_SHELL_6C1D/g)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-unscoped-01-boot-shell.png` })

    expect(errors, `uncaught errors in the no-project shell:\n${errors.join('\n')}`).toEqual([])
  })

  test('after opening a project, the panel hands back a live shell scoped to it', async ({
    window,
  }) => {
    const errors = trackErrors(window)

    await waitForLiveShell(window) // the unscoped boot shell — pristine (never typed into)
    const proj = await seedProject(window)
    await activateProject(window, proj)

    // #1024: the pristine boot shell is disposed and the switch path
    // auto-starts a fresh shell scoped to the project (ensureStarted parity
    // with the reveal path) — no `+` click, no blank panel.
    await expect(termTabs(window)).toHaveCount(1, { timeout: 15000 })
    await expect(window.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
      timeout: 15000,
    })
    await expect
      .poll(async () => (await activeRows(window).innerText()).trim().length, { timeout: 10000 })
      .toBeGreaterThan(0)

    // The shell is really rooted in the project (not the boot shell's ~).
    await run(window, 'pwd', new RegExp(proj.split('/').pop() ?? 'flow-ux', 'g'))
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-unscoped-02-project-shell.png` })

    const list = await mainTerminals(window)
    expect(list.some((t) => t.projectRoot === proj)).toBe(true)
    // …and the pristine unscoped boot PTY was disposed, not left leaking.
    expect(list.every((t) => t.projectRoot != null)).toBe(true)

    // `+` still opens an ADDITIONAL project-scoped shell.
    await newBtn(window).click()
    await expect(termTabs(window)).toHaveCount(2, { timeout: 15000 })

    expect(errors, `uncaught errors opening a project shell:\n${errors.join('\n')}`).toEqual([])
  })

  // ── #1024 guard ─────────────────────────────────────────────────────────
  test(
    '#1024 — opening a project must not strand the boot shell (every live terminal stays reachable)',
    async ({ window }) => {
      await waitForLiveShell(window)
      await run(window, 'echo BOOT_SHELL_WORK_44A1', /BOOT_SHELL_WORK_44A1/g)
      const bootIds = (await mainTerminals(window)).map((t) => t.terminalId)
      expect(bootIds.length).toBeGreaterThan(0)

      const proj = await seedProject(window)
      await activateProject(window, proj)
      await window.waitForTimeout(1500)

      // The boot shell was USED (a command ran in it), so it must be ADOPTED by
      // the project — either way, no terminal may linger alive-but-unreachable.
      const live = await mainTerminals(window)
      const tabIds = await window.evaluate(() => {
        // fl-tabs renders its strip in an open shadow root — pierce it.
        const strip = document.querySelector('.fl-term-tabs')
        return [...(strip?.shadowRoot?.querySelectorAll('.tab') ?? [])].map((el) =>
          el.getAttribute('data-id'),
        )
      })
      const stranded = live.filter((t) => !tabIds.includes(t.terminalId))
      expect(stranded, `terminals alive in main with no tab: ${JSON.stringify(stranded)}`).toEqual(
        [],
      )

      // …and the visible panel is not left blank right after opening a project.
      await expect(window.locator('.fl-term-empty')).toBeHidden()
    },
  )
})
