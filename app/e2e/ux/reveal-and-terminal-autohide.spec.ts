/**
 * #1063 — "Reveal in Finder" on the file tree's context menu, and
 * #940 — closing the LAST terminal gives the bottom slot back to the editor.
 *
 * Both are user-filed asks. The reveal handoff itself is an OS call
 * (shell.showItemInFolder) that cannot be asserted from Playwright, so this
 * pins everything up to the boundary: the item exists, is platform-worded, and
 * invoking it calls project:revealPath with the clicked node's path (asserted
 * by stubbing the bridge method in the renderer).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'

test.afterAll(() => cleanupSeeds())

test('#1063: the file tree offers Reveal in Finder and passes the clicked path', async ({
  app,
  window,
}) => {
  test.setTimeout(120_000)
  const root = await seedProject(window, 'flow-ux-reveal-', (dir) => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'target.ts'), 'export const x = 1\n')
  })
  await activateProject(window, root)

  // Record the OS handoff in MAIN (the preload bridge is frozen, so a renderer
  // stub silently no-ops) — this exercises the real menu → IPC → handler path
  // and stops at the boundary instead of opening Finder on the test machine.
  await app.evaluate(({ shell }) => {
    const record: string[] = []
    ;(globalThis as unknown as { __revealed: string[] }).__revealed = record
    shell.showItemInFolder = (fullPath: string) => {
      record.push(fullPath)
    }
  })

  const files = window.locator('[data-rail-item="files"]')
  if (!/\bactive\b/.test((await files.getAttribute('class')) ?? '')) await files.click()
  await pickFilesProject(window)
  const srcRow = window.locator('.fl-sidebar-pane:visible').getByText('src', { exact: true })
  await expect(srcRow).toBeVisible({ timeout: 15_000 })
  await srcRow.click({ button: 'right' })

  // Platform-worded (macOS here) and present for a directory row.
  const reveal = window.locator('button', {
    hasText: /^Reveal in (Finder|Explorer|file manager)$/,
  }).last()
  await expect(reveal).toBeVisible({ timeout: 5_000 })
  await reveal.click()

  // The handler resolved the project-relative path to a real absolute path
  // inside the root before handing it to the OS.
  await expect
    .poll(
      () => app.evaluate(() => (globalThis as unknown as { __revealed: string[] }).__revealed),
      { timeout: 10_000 },
    )
    .toEqual([join(root, 'src')])
})

test('#940: closing the last terminal hides the terminal area', async ({ window }) => {
  test.setTimeout(120_000)
  const root = await seedProject(window, 'flow-ux-autohide-')
  await activateProject(window, root)

  // Reveal the terminal (auto-starts a shell, #439) and wait for its tab.
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:show-terminal')))
  const term = window.locator('.fl-term-root')
  await expect(term).toBeVisible({ timeout: 20_000 })
  const tabs = window.locator('.fl-term-tabs .tab')
  await expect(tabs.first()).toBeVisible({ timeout: 20_000 })

  // Close every visible tab; the LAST close must give the slot back.
  for (let guard = 0; guard < 6; guard++) {
    // The area going away IS the outcome — its (now hidden) strip can't be
    // pressed any more, so stop pressing rather than wait on it.
    if (!(await term.isVisible())) break
    const count = await tabs.count()
    if (count === 0) break
    // The ACTIVE tab's ✕: an inactive tab's close is visibility:hidden until
    // its tab is hovered, so it is not a thing to press blind.
    const closer = window.locator('.fl-term-tabs .tab.active .close').first()
    if ((await closer.count()) === 0) break
    await closer.click()
    await window.waitForTimeout(300)
  }
  await expect(term).toBeHidden({ timeout: 10_000 })
})
