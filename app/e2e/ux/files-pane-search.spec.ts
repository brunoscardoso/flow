/**
 * SEARCH LIVES IN THE FILES PANE, BETWEEN THE WORKTREE AND THE TREE.
 *
 * It had a rail item and a pane of its own, which meant leaving the explorer to
 * look for a file and coming back to it to open one (user, 2026-09-18: "lets
 * move the search to file explorer tab, between the worktree and the file
 * explorer").
 *
 * THE ORDER IS THE POINT, so this reads the pane's actual children rather than
 * asserting each part exists somewhere: three surfaces in one column, and the
 * one in the middle is the one that moved.
 *
 * And the SIZE is the other half. An idle search must take only the row its
 * input needs — a results list holding half the explorer open to say "Type to
 * search file contents." is exactly the reserved gutter this layout avoids — so
 * the geometry is measured, not assumed.
 */
import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

test.afterAll(() => cleanupSeeds())

const NEEDLE = 'exportPipelineNeedle'

test('the search box sits between the worktree panel and the tree', async ({ window }) => {
  test.setTimeout(300_000)

  const root = await seedProject(window, 'orbit-app-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir })
    for (const name of ['alpha', 'beta']) {
      mkdirSync(join(dir, name), { recursive: true })
      writeFileSync(join(dir, name, 'index.ts'), `export const ${name} = '${NEEDLE}'\n`)
    }
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir })
  })
  await activateProject(window, root)
  const threadId = await window.evaluate(async (p: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    return (await flow.threads.create({ projectRoot: p, title: 'Compliance audit' })).id
  }, root)
  await window.evaluate((id: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: id } }))
  }, threadId)

  await window.locator('[data-rail-item="files"]').click()
  const pane = window.locator('.fl-sidebar-files')
  await expect(pane).toBeVisible({ timeout: 30_000 })
  await expect(window.locator('.fl-search-input')).toBeVisible({ timeout: 30_000 })

  // THE ORDER, read off the pane itself.
  const order = await pane.evaluate((el) =>
    Array.from(el.children).map((child) => child.className.split(' ')[0] ?? ''),
  )
  expect(order).toEqual(['fl-wt-dock', 'fl-files-search', 'fl-files-tree'])

  // IDLE TAKES ONE ROW. Measured against the pane, because "small" is a
  // relationship and not a number.
  const paneBox = await pane.boundingBox()
  const idleBox = await window.locator('.fl-files-search').boundingBox()
  expect(paneBox).not.toBeNull()
  expect(idleBox).not.toBeNull()
  expect(idleBox!.height, 'the idle search box is holding the explorer open').toBeLessThan(
    paneBox!.height * 0.2,
  )
  // …and the tree has the rest of it.
  const treeBox = await window.locator('.fl-files-tree').boundingBox()
  expect(treeBox!.height).toBeGreaterThan(paneBox!.height * 0.5)

  // TYPING GIVES IT ROOM, AND ONLY AS MUCH AS IT USES.
  await window.locator('.fl-search-input').fill(NEEDLE)
  await expect(window.locator('.fl-search-status')).toContainText('match', { timeout: 30_000 })
  const busyBox = await window.locator('.fl-files-search').boundingBox()
  // The positive first: it DID grow (allowed-pattern #28) …
  expect(busyBox!.height).toBeGreaterThan(idleBox!.height)
  // …and it stops at half the pane, which is where the tree stops being usable.
  expect(busyBox!.height).toBeLessThanOrEqual(paneBox!.height * 0.5 + 1)
  // The tree is still there to open what was found.
  await expect(window.locator('.fl-files-tree')).toBeVisible()
})
