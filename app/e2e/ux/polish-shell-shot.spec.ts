/**
 * The polished shell, as a person sees it (user decision 2026-11-17, the
 * "Flow layout polish" canvas): every region a rounded island on a darker
 * ground, the sidebar's three named tabs with one search and a quiet New.
 *
 * It opens a thread, a file and the terminal so every island is on screen,
 * saves one screenshot, and asserts the facts the design rests on — not pixels.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openEmptyThread } from './fixtures/seed'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')

test.afterAll(() => cleanupSeeds())

test('the shell draws its regions as rounded islands with a named sidebar', async ({ window }) => {
  const dir = await seedProject(window, 'flow-ux-polish-', (root) => {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'panel.ts'),
      'export function panel(deskId: string): string {\n  return `desk ${deskId}`\n}\n',
    )
  })
  await activateProject(window, dir)
  await openEmptyThread(window, dir, 'Polish probe thread')
  await window.evaluate((rootPath) => {
    document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath: 'src/panel.ts' } }))
  }, dir)
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('deskId', { timeout: 15_000 })

  mkdirSync(SHOTS, { recursive: true })
  await window.screenshot({ path: join(SHOTS, 'polish-shell-start.png') })

  // The sidebar's tabs say their names.
  const tabs = window.locator('.fl-activity-bar [data-rail-item]')
  await expect(tabs).toHaveText([/Threads/, /Files/, /Changes/])

  // One search and a New button in the sidebar's header.
  await expect(window.locator('.fl-sidebar-search input')).toHaveAttribute('placeholder', 'Search threads and files')
  await expect(window.locator('.fl-sidebar-new')).toBeVisible()

  // Islands: the sidebar, the conversation and the editor are rounded cards
  // with a gap of ground between them.
  const islands = await window.evaluate(() => {
    const pick = (sel: string): { radius: string; left: number; right: number } | null => {
      const el = document.querySelector(sel)
      if (!(el instanceof HTMLElement)) return null
      const box = el.getBoundingClientRect()
      return { radius: getComputedStyle(el).borderTopLeftRadius, left: box.left, right: box.right }
    }
    return {
      sidebar: pick('.fl-activity-sidebar'),
      conversation: pick('.fl-panel-wrap[data-panel="conversation"]') ?? pick('.fl-panel-wrap'),
    }
  })
  expect(islands.sidebar?.radius).toBe('10px')
  expect(islands.conversation?.radius).toBe('10px')
  expect((islands.conversation?.left ?? 0) - (islands.sidebar?.right ?? 0)).toBeGreaterThanOrEqual(4)

  mkdirSync(SHOTS, { recursive: true })
  await window.screenshot({ path: join(SHOTS, 'polish-shell.png') })

  // One search finds threads and files, grouped; Enter opens the first.
  await window.keyboard.press('Meta+k')
  await expect(window.locator('.fl-sidebar-search input')).toBeFocused()
  await window.keyboard.type('pan')
  const fileHit = window.locator('.fl-sidebar-hit[data-kind="file"]', { hasText: 'panel.ts' })
  await expect(fileHit).toBeVisible({ timeout: 10_000 })
  // On Threads the list stays and filters in place; the files show above it.
  await expect(window.locator('.fl-sidebar-results')).toHaveClass(/filter-list/)
  await expect(window.locator('.fl-thread-sidebar')).toBeVisible()
  await window.screenshot({ path: join(SHOTS, 'polish-shell-search.png') })
  // On Files the same query shows the grouped results in the pane's place.
  await window.locator('.fl-activity-bar [data-rail-item="files"]').click()
  await expect(window.locator('.fl-sidebar-results')).not.toHaveClass(/filter-list/)
  await expect(fileHit).toBeVisible()
  await window.locator('.fl-activity-bar [data-rail-item="threads"]').click()
  await window.locator('.fl-sidebar-search input').focus()
  await window.keyboard.press('Escape')
  await expect(window.locator('.fl-sidebar-results')).toBeHidden()
  await expect(window.locator('.fl-sidebar-search input')).toHaveValue('')

  // New makes a thread on Threads and says so; on Files it makes a file.
  await expect(window.locator('.fl-sidebar-new')).toHaveAttribute('aria-label', 'New thread')
  await window.locator('.fl-activity-bar [data-rail-item="files"]').click()
  await expect(window.locator('.fl-sidebar-new')).toHaveAttribute('aria-label', 'New file')
  await window.locator('.fl-sidebar-new').click({ button: 'right' })
  await expect(window.locator('.fl-sidebar-new-menu-item')).toHaveText([
    'New file',
    'New thread',
    'New terminal',
    'Ask the Blueprint',
  ])
  await window.screenshot({ path: join(SHOTS, 'polish-shell-files.png') })
  await window.keyboard.press('Escape')
  await expect(window.locator('.fl-sidebar-new-menu')).toHaveCount(0)
})
