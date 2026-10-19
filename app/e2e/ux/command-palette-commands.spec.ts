import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — the ⌘P palette's COMMAND mode (the `>` path the file/thread spec
 * doesn't cover). ⌘⇧P opens straight into command mode; typing filters the
 * command registry; Enter runs the selected command's real effect. Uses
 * "Open Blueprint" as the observable — it opens the board as an editor tab.
 */

test.afterAll(() => cleanupSeeds())

test('⌘⇧P command mode filters the registry and runs a command', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const proj = await seedProject(window)
  await activateProject(window, proj)

  const panel = window.locator('.fl-palette-panel')
  const input = panel.locator('.fl-palette-input')
  const rows = window.locator('.fl-palette-row')

  // ⌘⇧P opens straight into command mode: the input is pre-filled with `>` and
  // the list shows command rows.
  await window.keyboard.press('ControlOrMeta+Shift+p')
  await expect(panel).toBeVisible()
  await expect(input).toHaveValue('>')
  await expect(rows.first()).toBeVisible()

  // Filter to a specific command; wait for its row so Enter can't race a stale one.
  await input.fill('>blueprint')
  const bpRow = window.locator('.fl-palette-row', { hasText: 'Open Blueprint' })
  await expect(bpRow).toBeVisible()
  await window.keyboard.press('Enter')

  // The palette closes and the command's real effect happens: the Blueprint
  // opens as an editor tab. (The full board root needs the planflow-ai CLI,
  // absent for a seeded temp project, so assert the tab — the command's effect.)
  await expect(panel).toBeHidden()
  await expect(
    window.locator('.fl-shell fl-tabs .tab', { hasText: 'Blueprint' }),
  ).toBeVisible({ timeout: 10_000 })

  expect(errors).toEqual([])
})

test('the palette "New file" command opens a name prompt at the root', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const proj = await seedProject(window)
  await activateProject(window, proj)

  const panel = window.locator('.fl-palette-panel')
  const input = panel.locator('.fl-palette-input')

  await window.keyboard.press('ControlOrMeta+Shift+p')
  await expect(panel).toBeVisible()
  await input.fill('>new file')
  await expect(window.locator('.fl-palette-row', { hasText: 'New file' })).toBeVisible()
  await window.keyboard.press('Enter')

  // The palette closes and the file tree's inline new-file prompt appears.
  await expect(panel).toBeHidden()
  await expect(window.locator('.fl-tree-menu input')).toBeVisible({ timeout: 10_000 })

  expect(errors).toEqual([])
})

test('the palette "New terminal" REVEALS a hidden terminal panel', async ({ window }) => {
  const proj = await seedProject(window)
  await activateProject(window, proj)

  const termRoot = window.locator('.fl-term-root')
  // Start from a hidden terminal so the palette below does the revealing. ⌃`
  // TOGGLES, and a fresh profile no longer mounts the docked panel, so press it
  // only when a terminal is actually up.
  if ((await termRoot.count()) > 0) {
    await window.keyboard.press('Control+Backquote')
  }
  await expect(termRoot).toBeHidden()

  const panel = window.locator('.fl-palette-panel')
  await window.keyboard.press('ControlOrMeta+Shift+p')
  await panel.locator('.fl-palette-input').fill('>new terminal')
  await expect(window.locator('.fl-palette-row', { hasText: 'New terminal' })).toBeVisible()
  await window.keyboard.press('Enter')

  await expect(panel).toBeHidden()
  await expect(termRoot).toBeVisible({ timeout: 10_000 })
})

test('a compose prompt with NO open thread opens the new-thread page with the prompt in it', async ({ window }) => {
  const proj = await seedProject(window)
  await activateProject(window, proj)

  // What a ⌘P slash command fires. No thread is open, so the handler must start
  // one and keep the prompt — previously a silent no-op without an open chat.
  // Starting a thread is the new-thread PAGE now (its description is the first
  // message), so the prompt belongs there, ready to finish and create — not in
  // the hidden composer of a conversation that does not exist yet.
  await window.evaluate(() =>
    document.dispatchEvent(new CustomEvent('flow:compose-prompt', { detail: { text: '/brainstorm ' } })),
  )

  await expect(window.locator('.fl-newthread')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('.fl-newthread-body')).toHaveValue('/brainstorm ')
  await expect(window.locator('.fl-newthread-body')).toBeFocused()
  // The seeded prompt counts as the description: Create can act on it.
  await expect(
    window.locator('.fl-newthread-footer fl-button', { hasText: 'Create thread' }),
  ).toHaveAttribute('aria-disabled', 'false')
})
