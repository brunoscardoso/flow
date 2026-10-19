import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal): the ⌘L "add terminal selection to chat" path (#152).
 *
 * A user selects text in the terminal and presses ⌘L to attach it to the composer
 * as a context chip (Cursor-style), instead of the keystroke going to the shell.
 * This drives that real feature end-to-end: seed a project, open a thread so the
 * composer is visible, run a command, select its output, press ⌘L, and assert a
 * "Terminal" context chip lands in the composer carrying the selected text.
 */

const SCREEN_DIR = 'e2e/ux/__screens'

function activeHost(win: Page) {
  return win.locator('.fl-term-host:not([hidden])')
}
function activeRows(win: Page) {
  return activeHost(win).locator('.xterm-rows')
}

async function openTerminalWithShell(win: Page): Promise<void> {
  // Docked-visible by default (#674) — the toggle would HIDE it; reveal only
  // when it isn't on screen.
  if (!(await win.locator(sel.terminalRoot).isVisible())) {
    const toggle = win.locator(statusButtonByText('Terminal'))
    await expect(toggle).toBeVisible()
    await toggle.click()
  }
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  await expect(win.locator('.fl-term-host .xterm').first()).toBeVisible({ timeout: 15000 })
  await expect
    .poll(async () => (await activeRows(win).innerText()).trim().length, { timeout: 8000 })
    .toBeGreaterThan(0)
}

async function runCommand(win: Page, cmd: string, marker: string): Promise<void> {
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  await expect
    .poll(
      async () => ((await activeRows(win).innerText()).match(new RegExp(marker, 'g')) ?? []).length,
      { timeout: 10000 },
    )
    .toBeGreaterThanOrEqual(2)
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

/** Create a thread in the seeded project and open it (composer becomes visible). */
async function openThread(win: Page, projectRoot: string): Promise<void> {
  await win.evaluate(async (root) => {
    const flow = (
      window as unknown as {
        flow: { threads: { create(r: { projectRoot: string; additionalRoots: string[] }): Promise<{ id: string }> } }
      }
    ).flow
    const thread = await flow.threads.create({ projectRoot: root, additionalRoots: [] })
    document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: thread.id } }))
  }, projectRoot)
  await expect(win.locator('.fl-composer-input textarea')).toBeVisible({ timeout: 8000 })
}

test.describe('terminal — ⌘L selection → chat (#152)', () => {
  test('selecting terminal output + ⌘L attaches a Terminal context chip to the composer', async ({
    window,
  }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)
    await openThread(window, proj)

    await openTerminalWithShell(window)
    await activeHost(window).click()
    await runCommand(window, 'echo SELECT_ME_TARGET', 'SELECT_ME_TARGET')

    // Select the output via a mouse drag over the xterm screen (xterm builds its
    // selection from mousedown→move→up on .xterm-screen). Drag across the first
    // few lines so the echoed command + output land in the selection.
    const screen = activeHost(window).locator('.xterm-screen')
    const box = await screen.boundingBox()
    if (!box) throw new Error('no xterm screen box')
    await window.mouse.move(box.x + 6, box.y + 4)
    await window.mouse.down()
    await window.mouse.move(box.x + box.width - 6, box.y + 40, { steps: 8 })
    await window.mouse.up()
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-select-01-selection.png` })

    // ⌘L should attach the selection to the composer, NOT send an 'l' to the shell.
    await window.keyboard.press('ControlOrMeta+l')

    // A "Terminal" context chip must appear in the composer.
    const chipKind = window.locator('.fl-composer-chip-kind', { hasText: 'Terminal' })
    await expect(chipKind).toBeVisible({ timeout: 5000 })
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-select-02-chip.png` })

    // The chip carries the selected text (its title holds the full selection).
    const chip = window.locator('.fl-composer-chip', { has: chipKind })
    await expect(chip).toHaveAttribute('title', /SELECT_ME_TARGET/)

    expect(errors, `uncaught errors during ⌘L attach:\n${errors.join('\n')}`).toEqual([])
    cleanupSeeds()
  })
})
