import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Bottom-slot arbitration: the terminal shortcut (⌃` / ⌘J) governs ONE slot.
 * Blueprint panes (learning panel, peek drawer, story, drift) open in the same
 * strip the terminal lives in; before this fix, toggling the terminal while the
 * learning panel was open STACKED both into an unreadable sliver. The shortcut
 * arbitrates the slot ONLY on the REVEAL path (#1034): revealing closes the
 * occupying pane and the terminal replaces it; hiding never evicts a pane —
 * parity with the rail Terminal item.
 */

const GRAPH = {
  version: 1,
  derivedAt: '2026-07-17T00:00:00Z',
  coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: false },
  nodes: [{ id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } }],
  edges: [],
}

test.afterAll(() => cleanupSeeds())

test('⌃` replaces an open learning panel with the terminal instead of stacking', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await seedProject(window)
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH))
  await activateProject(window, root)

  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-blueprint'))
    document.dispatchEvent(new CustomEvent('flow:open-learning-panel'))
  })
  const panel = window.locator('.fb-learn-panel')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  const termRoot = window.locator('.fl-term-root')
  await expect(termRoot).toBeVisible() // docked-visible by default (#674)

  // Terminal already visible → ⌃` is a plain HIDE: the learning panel the user
  // is reading is never evicted as a side effect (#1034).
  await window.keyboard.press('Control+Backquote')
  await expect(termRoot).toBeHidden()
  await expect(panel).toBeVisible()

  // Slot occupied + terminal hidden → the REVEAL replaces the pane with the
  // terminal (panel gone, terminal visible — never both stacked).
  await window.keyboard.press('Control+Backquote')
  await expect(panel).toHaveCount(0)
  await expect(termRoot).toBeVisible()

  // Slot now holds only the terminal → plain toggle hides it…
  await window.keyboard.press('Control+Backquote')
  await expect(termRoot).toBeHidden()

  // …and another press brings it back (empty slot → terminal appears).
  await window.keyboard.press('Control+Backquote')
  await expect(termRoot).toBeVisible()
  await expect(window.locator('.fb-learn-panel')).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
