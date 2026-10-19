import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { rmSync } from 'node:fs'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal), round 22: opening a shell in a project root
 * that is GONE from disk.
 *
 * Terminal is the most-probed flow (32 specs across 21 rounds: open/run/close/
 * switch/resize/scoping/theme/cwd-title/rename/overflow/exit/drain/interrupt/
 * links/menu/split/height/unscoped-boot). Every one of them drives a root that
 * exists. Nothing drove the failure a user creates themselves — the project
 * folder deleted, moved by a `git worktree remove`, or on an unmounted volume
 * while Flow keeps running (`available` is computed at boot, so the root stays
 * listed and active).
 *
 * The seam: `+` → `terminal:create` → `#resolveCwd(rootId)` hands the missing
 * path to `new PtySession({cwd})` → `node-pty.spawn` → the shell can't chdir
 * and dies immediately. `terminal:create` still RESOLVES, so #209's
 * `terminalCreateFailedToast` never fires — the exit path is the only thing
 * that can tell the user anything.
 *
 * Guards here (green on main, all measured live):
 *   1. The dead shell is not disguised as a live one: the new tab is labelled
 *      `(exited)`, the exit banner is on screen, and `terminal:list` reports
 *      `exited: true` — the #439/#446/#957 "never hand back a live-looking dead
 *      shell" contract, on the spawn-failure path.
 *   2. The failure is contained: the project's pre-existing LIVE shell stays in
 *      the strip and still runs commands, and the panel does not vanish.
 *   3. Control — a shell that exits NORMALLY prints the banner exactly once.
 */

const SCREEN_DIR = 'e2e/ux/__screens'

const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const activeHost = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const activeRows = (win: Page) => activeHost(win).locator('.xterm-rows')

/** Tabs as the user sees them (fl-tabs renders its strip into an open shadow root). */
const stripTabs = (win: Page) =>
  win.evaluate(() => {
    const strip = document.querySelector('.fl-term-tabs')
    return [...(strip?.shadowRoot?.querySelectorAll('.tab') ?? [])].map((el) => ({
      id: el.getAttribute('data-id'),
      text: (el as HTMLElement).innerText.trim(),
    }))
  })

/** Terminals the MAIN process is holding, tab or no tab. */
const mainTerminals = (win: Page) =>
  win.evaluate(async () =>
    (
      window as unknown as {
        flow: {
          terminal: {
            list(): Promise<
              Array<{ terminalId: string; cwd: string; projectRoot?: string; exited?: boolean }>
            >
          }
        }
      }
    ).flow.terminal.list(),
  )

async function waitForLiveShell(win: Page): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible({ timeout: 20000 })
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

/** Re-reveal the docked panel if opening a project put it away (the round-22
 *  `setActiveProject` finding); a no-op once that is fixed. */
async function ensurePanelVisible(win: Page): Promise<void> {
  if (!(await win.locator(sel.terminalRoot).isVisible().catch(() => false))) {
    await win.keyboard.press('Control+`')
  }
}

/** Click a terminal tab by id (the strip lives in an open shadow root). */
async function selectTab(win: Page, id: string): Promise<void> {
  await win.evaluate((tabId) => {
    const strip = document.querySelector('.fl-term-tabs')
    const tab = strip?.shadowRoot?.querySelector(`.tab[data-id="${tabId}"]`)
    ;(tab as HTMLElement | null)?.click()
  }, id)
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

test.describe('terminal — the project folder is gone', () => {
  test('+ in a deleted project root surfaces the dead shell and spares the live one', async ({
    window,
  }) => {
    const errors = trackErrors(window)

    await waitForLiveShell(window) // the unscoped boot shell
    const proj = await seedProject(window, 'flow-ux-gone-')
    await activateProject(window, proj)
    await window.waitForTimeout(2000)
    await ensurePanelVisible(window)
    await waitForLiveShell(window) // the project's shell
    const before = await stripTabs(window)
    expect(before.length).toBeGreaterThan(0)
    const liveId = before[before.length - 1].id as string

    // The user deletes / moves / unmounts the project folder while Flow runs…
    rmSync(proj, { recursive: true, force: true })
    // …and then asks for another terminal, exactly as before.
    await newBtn(window).click()

    // 1. The shell that can't start is NOT disguised as a live one.
    await expect
      .poll(async () => (await stripTabs(window)).length, { timeout: 15000 })
      .toBe(before.length + 1)
    const added = (await stripTabs(window)).find((t) => !before.some((b) => b.id === t.id))
    expect(added, 'a tab was added for the requested terminal').toBeTruthy()
    // The shell dies a beat after the tab is built, so poll the LABEL rather
    // than snapshotting it — the assertion is "it ends up labelled", not "it is
    // labelled within one frame".
    await expect
      .poll(
        async () => (await stripTabs(window)).find((t) => t.id === added?.id)?.text ?? '',
        { timeout: 15000 },
      )
      .toContain('(exited)')
    await expect(activeRows(window)).toContainText(/process exited/i, { timeout: 10000 })
    await expect
      .poll(
        async () =>
          (await mainTerminals(window)).find((t) => t.terminalId === added?.id)?.exited === true,
        { timeout: 10000 },
      )
      .toBe(true)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-missing-root-plus.png` })

    // 2. The failure is contained — the panel stays, and the project's live
    //    shell is still reachable and still runs commands.
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await selectTab(window, liveId)
    await activeHost(window).click()
    await expect(window.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea')).toBeFocused()
    // The marker is assembled from a shell variable so only the OUTPUT can
    // match — the echoed command line must never satisfy the poll.
    await window.keyboard.type('M=GONE; printf "%sROOT_OK\\n" "$M"')
    await window.keyboard.press('Enter')
    await expect
      .poll(async () => /GONEROOT_OK/.test(await activeRows(window).innerText()), { timeout: 15000 })
      .toBe(true)

    // Deleting the folder legitimately makes the FILE TREE fail to list it
    // (console-only, the #1118 family) — that noise isn't this seam's business.
    const terminalErrors = errors.filter((e) => !/failed to list directory/.test(e))
    expect(
      terminalErrors,
      `uncaught errors on the missing-root path:\n${terminalErrors.join('\n')}`,
    ).toEqual([])
  })

  // ── Control ─────────────────────────────────────────────────────────────
  test('control: a shell that exits normally prints the exit banner exactly once', async ({
    window,
  }) => {
    await waitForLiveShell(window)
    await activeHost(window).click()
    await expect(window.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea')).toBeFocused()
    await window.keyboard.type('exit')
    await window.keyboard.press('Enter')
    await expect(activeRows(window)).toContainText(/process exited/i, { timeout: 15000 })
    await expect
      .poll(
        async () =>
          ((await activeRows(window).innerText()).match(/process exited with code/g) ?? []).length,
        { timeout: 5000 },
      )
      .toBe(1)
  })
})
