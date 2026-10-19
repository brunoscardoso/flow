import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal): background-terminal output is BUFFERED while the
 * tab is unopened and DRAINED into the xterm on first attach (#208), driven live.
 *
 * The core AI-IDE scenario: an agent (or any background) terminal produces output
 * while you're looking at a different shell tab. Its xterm doesn't exist yet, so
 * the bytes are held in a char-bounded `PendingBuffer` (#208). When you first open
 * that tab, the buffered output must drain into the freshly-attached xterm — if it
 * were dropped, you'd click the tab and silently see nothing the agent produced.
 *
 * This path had ZERO live e2e coverage: `pending-buffer.test.ts` unit-tests the
 * buffer class in isolation, and pr-210.spec.ts explicitly notes that observing
 * real pre-attach output "needs >256 KB ... not drivable from a fresh launch",
 * so it only guards that reveal+attach still mounts. It IS drivable: with a shell
 * already active, create a SECOND terminal via the IPC bridge (the same
 * `terminal:created` broadcast an agent terminal is born through) — it joins
 * hidden and never attaches — then write real output into its PTY and open it.
 *
 * We assert the full seam:
 *  1. the background tab exists but has NO xterm while output is produced;
 *  2. that output is NOT leaked into the active view (it's buffered, not shown);
 *  3. opening the tab attaches its xterm and DRAINS the buffered marker into it;
 *  4. the freshly-attached shell is live & interactive (not a static dump);
 *  5. zero uncaught errors throughout.
 *
 * Docked-aware, per terminal-resize.spec.ts: start the first shell with + (never
 * toggle-to-open, which hides the docked-by-default panel).
 */

const SCREEN_DIR = 'e2e/ux/__screens'

const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const activeRows = (win: Page) => win.locator('.fl-term-host:not([hidden]) .xterm-rows')
const allXterms = (win: Page) => win.locator('.fl-term-host .xterm')

/** Docked by default; after activating a project the strip is empty — start the
 *  first scoped live shell with + (never toggle-to-open, which hides the panel). */
async function ensureScopedShell(win: Page): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) {
    await newBtn(win).click()
  }
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 15000,
  })
  await expect
    .poll(async () => (await activeRows(win).innerText()).trim().length, { timeout: 8000 })
    .toBeGreaterThan(0)
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

test.describe('terminal — background output preserved on first attach (#208)', () => {
  test('a background terminal buffers its output and drains it into the xterm when first opened', async ({
    window,
  }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)
    await ensureScopedShell(window) // tab A: active + attached

    // Baseline of already-attached xterms (the active shell A, plus the
    // docked-panel boot terminal that stays mounted-but-hidden after the project
    // switch — VS Code-parity auto-start, not part of this flow). We assert the
    // background tab's attach as a DELTA against this, so the boot terminal can't
    // confound the count.
    const baseXterms = await allXterms(window).count()
    expect(baseXterms, 'at least the active shell is attached').toBeGreaterThanOrEqual(1)

    // Create a SECOND terminal directly via the IPC bridge — the same
    // `terminal:created` broadcast path a background/agent terminal is born
    // through. With A already active, addTab() joins it HIDDEN and never attaches
    // an xterm (clicking + would activate it; this deliberately does not).
    const bgId = await window.evaluate(async (rootId) => {
      const info = await (
        window as unknown as {
          flow: { terminal: { create(r: { rootId?: string; cols: number; rows: number }): Promise<{ terminalId: string }> } }
        }
      ).flow.terminal.create({ rootId, cols: 80, rows: 24 })
      return info.terminalId
    }, proj)
    expect(bgId, 'the background terminal was created').toBeTruthy()

    // Two visible tabs now (A + B) — but the attached-xterm count is UNCHANGED:
    // B joined hidden and has no xterm yet.
    await expect(termTabs(window)).toHaveCount(2)
    await expect(allXterms(window)).toHaveCount(baseXterms)

    // Drive real output INTO the background (unattached) terminal's PTY. Main
    // broadcasts terminal:data for it and the renderer, finding no xterm on that
    // tab, buffers the bytes in its PendingBuffer (#208) instead of dropping them.
    const MARKER = 'BG_TERMINAL_MARKER_47182'
    await window.evaluate(
      async ({ id, marker }) => {
        await (
          window as unknown as {
            flow: { terminal: { write(r: { terminalId: string; data: string }): Promise<void> } }
          }
        ).flow.terminal.write({ terminalId: id, data: `echo ${marker}\n` })
      },
      { id: bgId, marker: MARKER },
    )

    // Let the PTY run + broadcast. The marker must NOT be visible in the active
    // (A) view — it's buffered on the hidden B tab, not shown anywhere yet.
    await window.waitForTimeout(1500)
    expect(
      (await activeRows(window).innerText()).includes(MARKER),
      'background output is buffered on the hidden tab, not leaked into the active view',
    ).toBe(false)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-bg-output-01-buffered.png` })

    // Open the background tab for the FIRST time — its xterm attaches and the
    // buffered output must DRAIN into the view (attachXterm → pending.drain()).
    // If the buffer were lost, the marker would never appear.
    await termTabs(window).nth(1).click()
    await expect(window.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
      timeout: 15000,
    })
    await expect(allXterms(window)).toHaveCount(baseXterms + 1) // B now attached too

    await expect
      .poll(async () => (await activeRows(window).innerText()).includes(MARKER), { timeout: 12000 })
      .toBe(true)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-bg-output-02-drained.png` })

    // The freshly-attached shell is live & interactive, not just a static dump.
    await window.locator('.fl-term-host:not([hidden])').click()
    await window.keyboard.type('echo LIVE_AFTER_DRAIN')
    await window.keyboard.press('Enter')
    await expect
      .poll(async () => (await activeRows(window).innerText()).includes('LIVE_AFTER_DRAIN'), {
        timeout: 12000,
      })
      .toBe(true)

    expect(
      errors,
      `uncaught errors during background-output drain:\n${errors.join('\n')}`,
    ).toEqual([])
  })
})
