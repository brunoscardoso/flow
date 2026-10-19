import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * #703 — a visible "Hide terminal" affordance ON the terminal, so a user can
 * collapse it to see the editor without knowing the ⌘J / ⌃` / rail toggles.
 * The header's collapse button (chevron-down) dispatches flow:hide-terminal,
 * which the shell hides as a pure HIDE (never a reveal). This drives the real
 * flow: terminal visible → click collapse → it leaves the editor stack → the
 * Terminal rail item brings it back.
 */

test.afterAll(() => cleanupSeeds())

test('the terminal header collapse button hides the terminal; the rail restores it', async ({
  window,
}) => {
  const proj = await seedProject(window)
  await activateProject(window, proj)

  // Terminal is docked by default (terminalVisible defaults on).
  const termRoot = window.locator('.fl-term-root')
  await expect(termRoot).toBeVisible()

  // The collapse button lives in the terminal header, next to New terminal.
  const collapse = window.locator('.fl-term-tool.fl-term-collapse')
  await expect(collapse).toBeVisible()
  await expect(collapse).toHaveAttribute('aria-label', 'Hide terminal')

  // Clicking it removes the terminal from the editor stack (the editor fills it).
  await collapse.click()
  await expect(termRoot).toBeHidden()

  // It's a pure hide, not a toggle: clicking again does nothing (button is gone
  // with the panel), and the terminal stays hidden until an explicit reveal.
  await expect(collapse).toHaveCount(0)

  // The Terminal rail item brings it back.
  // The terminal is docked-VISIBLE by default (#674), and since #1341 it
  // survives opening your first project — so clicking the rail item now
  // HIDES it. Reveal only when it isn't already on screen.
  if (!(await window.locator('.fl-term-root').isVisible())) {
    await window.locator('.fl-editor-actions .fl-rail-item[aria-label="Terminal"]').click()
  }
  await expect(termRoot).toBeVisible()
})
