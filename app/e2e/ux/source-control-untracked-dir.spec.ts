import { test, expect, type Page } from '../fixtures/electron'
import { activateProject, removeTempDir } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * #615 — new files under a NEW folder (e.g. a Next.js `(protected)` route group)
 * are invisible in Source Control: git rolls a brand-new untracked directory up
 * into one `dir/` entry. The panel now renders that row with an EXPAND chevron
 * (#615) that reveals the folder's individual untracked files as child rows, so
 * they can be seen + peeked without losing the folder's discard/commit actions.
 *
 * Driven against a REAL git repo (a committed root + a new untracked folder).
 */
const seeded: string[] = []

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir })
}

/** A repo with a tracked `app/` + a brand-new untracked `(protected)/` folder. */
function seedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-untracked-'))
  seeded.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  mkdirSync(join(dir, 'app'), { recursive: true })
  writeFileSync(join(dir, 'app', 'index.ts'), 'export const x = 1\n')
  git(dir, 'add', 'app/index.ts')
  git(dir, 'commit', '-q', '-m', 'base')
  // A brand-new route-group folder with two files — git rolls it up to `app/(protected)/`.
  mkdirSync(join(dir, 'app', '(protected)'), { recursive: true })
  writeFileSync(join(dir, 'app', '(protected)', 'page.tsx'), 'export default () => null\n')
  writeFileSync(join(dir, 'app', '(protected)', 'layout.tsx'), 'export default () => null\n')
  return dir
}

async function addRoot(window: Page, dir: string): Promise<void> {
  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
}

async function openChanges(window: Page): Promise<void> {
  // Post-#674 activity-bar rail opener (was the removed `.fl-sidetabs-tab`).
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
}

test.afterAll(() => {
  while (seeded.length) {
    const dir = seeded.pop()
    if (dir) removeTempDir(dir)
  }
})

test('a new untracked folder expands to reveal its individual files (#615)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = seedRepo()
  await addRoot(window, dir)
  await activateProject(window, dir)
  await openChanges(window)

  // The rolled-up folder row appears with an expand chevron — its files are hidden.
  const folderRow = window.locator('.gp-row', {
    has: window.locator('.gp-name', { hasText: '(protected)' }),
  })
  await expect(folderRow).toBeVisible({ timeout: 8000 })
  await expect(folderRow.locator('.gp-chevron')).toBeVisible()
  await expect(window.locator('.gp-name', { hasText: 'page.tsx' })).toHaveCount(0)

  // Expand → the two new files appear as indented child rows, peekable.
  await folderRow.locator('.gp-chevron').click()
  await expect(window.locator('.gp-row-child .gp-name', { hasText: 'page.tsx' })).toBeVisible({
    timeout: 5000,
  })
  await expect(window.locator('.gp-row-child .gp-name', { hasText: 'layout.tsx' })).toBeVisible()

  // Collapse → the child rows hide again.
  await folderRow.locator('.gp-chevron').click()
  await expect(window.locator('.gp-row-child')).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('a file added to an already-expanded folder surfaces on git refresh (#647)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = seedRepo()
  await addRoot(window, dir)
  await activateProject(window, dir)
  await openChanges(window)

  const folderRow = window.locator('.gp-row', {
    has: window.locator('.gp-name', { hasText: '(protected)' }),
  })
  await expect(folderRow).toBeVisible({ timeout: 8000 })

  // Expand early — only page.tsx + layout.tsx exist so far.
  await folderRow.locator('.gp-chevron').click()
  await expect(window.locator('.gp-row-child .gp-name', { hasText: 'page.tsx' })).toBeVisible({
    timeout: 5000,
  })
  await expect(window.locator('.gp-row-child .gp-name', { hasText: 'error.tsx' })).toHaveCount(0)

  // Now add a THIRD file while the folder is still expanded — the file watcher
  // fires a git refresh; the cache must re-fetch, not stay frozen (#647).
  writeFileSync(join(dir, 'app', '(protected)', 'error.tsx'), 'export default () => null\n')

  await expect(window.locator('.gp-row-child .gp-name', { hasText: 'error.tsx' })).toBeVisible({
    timeout: 10_000,
  })
  // The earlier children remain.
  await expect(window.locator('.gp-row-child .gp-name', { hasText: 'page.tsx' })).toBeVisible()

  expect(errors, errors.join(', ')).toHaveLength(0)
})
