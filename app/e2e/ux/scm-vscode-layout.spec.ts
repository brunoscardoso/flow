/**
 * Source Control, rebuilt to VS Code's layout (2026-11) — the whole loop on a
 * seeded repository with a real upstream:
 *
 *   rows read NAME then folder · the row's Stage moves a file to Staged Changes
 *   · the commit button reads Commit All with nothing staged and Commit once
 *   something is · the graph draws lanes (a merge opens a second one) and a
 *   commit expands to its files · a file opens as an editor TAB titled
 *   "(Working Tree)" · Stage hunk stages exactly one hunk · the commit lands ·
 *   the status line names the branch and the sync counts.
 *
 * Every assertion about the repository is read back from git itself, never
 * from the panel's own claim (forbidden #7).
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { sel } from '../selectors'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')
const TEN = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

function run(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

function populate(dir: string): void {
  run(dir, 'config', 'user.email', 'qa@flow.test')
  run(dir, 'config', 'user.name', 'QA Bot')
  run(dir, 'checkout', '-q', '-B', 'main')
  writeFileSync(join(dir, 'alpha.txt'), TEN)
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'src', 'lib', 'util.ts'), 'export const a = 1\n')
  run(dir, 'add', '.')
  run(dir, 'commit', '-q', '-m', 'feat: seed')
  run(dir, 'checkout', '-q', '-b', 'side')
  writeFileSync(join(dir, 'side.txt'), 'side\n')
  run(dir, 'add', '.')
  run(dir, 'commit', '-q', '-m', 'feat: on side')
  run(dir, 'checkout', '-q', 'main')
  writeFileSync(join(dir, 'main.txt'), 'main\n')
  run(dir, 'add', '.')
  run(dir, 'commit', '-q', '-m', 'feat: on main')
  run(dir, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
  // A real upstream, so the status line has something to count against.
  const remote = mkdtempSync(join(tmpdir(), 'flow-scm-remote-'))
  run(remote, 'init', '-q', '--bare')
  run(dir, 'remote', 'add', 'origin', remote)
  run(dir, 'push', '-q', '-u', 'origin', 'main')
  // Two separate edits to alpha (two hunks), and a modified file in a folder.
  writeFileSync(
    join(dir, 'alpha.txt'),
    TEN.replace('line 2\n', 'line 2 EDITED\n').replace('line 28\n', 'line 28 EDITED\n'),
  )
  writeFileSync(join(dir, 'src', 'lib', 'util.ts'), 'export const a = 2\n')
}

async function open(window: Page): Promise<string> {
  const dir = await seedProject(window, undefined, populate)
  await activateProject(window, dir)
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator(sel.scViewBtn, { hasText: 'Changes' }).click()
  await expect(window.locator(sel.gitPanelRoot)).toBeVisible()
  await expect(window.locator(sel.scmCommitMsg)).toBeVisible({ timeout: 15_000 })
  return dir
}

const rowFor = (window: Page, name: string) =>
  window.locator(sel.scmFileRow, { has: window.locator('.gp-name', { hasText: name }) }).first()

async function panelText(window: Page): Promise<string> {
  return window.locator(sel.gitPanelRoot).innerText()
}

async function expectPanel(window: Page, needle: string): Promise<void> {
  await expect(async () => expect(await panelText(window)).toContain(needle)).toPass({ timeout: 10_000 })
}

test.afterAll(() => cleanupSeeds())

test('Source Control: rows, staging, commit button, graph, diff tab, hunk stage, status line', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(String(error)))
  const dir = await open(window)

  // ── The title row and the sections ────────────────────────────────────
  await expect(window.locator(sel.scHeader)).toContainText('Source Control')
  await expect(window.locator(sel.scHeaderAction('Commit'))).toBeVisible()
  await expectPanel(window, 'CHANGES (2)')

  // ── A row reads NAME first, then its folder ────────────────────────────
  const util = rowFor(window, 'util.ts')
  await expect(util.locator('.gp-name')).toHaveText('util.ts')
  await expect(util.locator('.gp-dir')).toHaveText('src/lib')
  const order = await util.evaluate((row) => {
    const kids = [...row.children].map((child) => child.className)
    return { name: kids.findIndex((c) => c.includes('gp-name')), dir: kids.findIndex((c) => c.includes('gp-dir')) }
  })
  expect(order.name).toBeGreaterThanOrEqual(0)
  expect(order.name).toBeLessThan(order.dir)

  // ── Commit All with nothing staged ────────────────────────────────────
  await window.locator(sel.scmCommitMsg).fill('wip')
  await expect(window.locator(sel.scmCommitBtn)).toContainText('Commit All')
  await window.locator(sel.scmCommitMsg).fill('')

  // ── The row's Stage moves util.ts to Staged Changes; the label follows ─
  await util.hover()
  await util.locator('.gp-action-btn[title="Stage"]').click()
  await expectPanel(window, 'STAGED CHANGES (1)')
  await expect(async () => expect(run(dir, 'diff', '--cached', '--name-only').trim()).toBe('src/lib/util.ts')).toPass({
    timeout: 10_000,
  })
  await window.locator(sel.scmCommitMsg).fill('x')
  await expect(window.locator(sel.scmCommitBtn)).toHaveText(/^Commit$/)
  await window.locator(sel.scmCommitMsg).fill('')

  // ── The graph: lanes, a merge with a second lane, expand to files ──────
  await expect(window.locator(sel.scmLanes).first()).toBeVisible()
  const mergeRow = window.locator(sel.scmGraphRow, { has: window.locator('.gp-subject', { hasText: 'merge side' }) })
  await expect(mergeRow.locator('.gp-node-merge')).toHaveCount(1)
  expect(Number(await mergeRow.locator('svg.gp-lanes').getAttribute('width'))).toBeGreaterThan(18)
  await expect(mergeRow.locator('.gp-ref-branch', { hasText: 'main' })).toBeVisible()
  await expect(mergeRow.locator('.gp-ref-remote', { hasText: 'origin/main' })).toBeVisible()
  await window.locator(sel.scmGraphRow, { has: window.locator('.gp-subject', { hasText: 'feat: on side' }) }).click()
  await expect(window.locator(sel.scmGraphChild, { has: window.locator('.gp-name', { hasText: 'side.txt' }) })).toBeVisible({
    timeout: 10_000,
  })
  await window.screenshot({ path: join(SHOTS, 'scm-layout-1-graph.png') })

  // ── The diff opens as an editor tab, "(Working Tree)", italic ──────────
  await rowFor(window, 'alpha.txt').click()
  await expect(window.locator(sel.scmDiffTab)).toBeVisible({ timeout: 10_000 })
  const tab = window.locator(sel.scmDiffTabStrip)
  await expect(tab).toContainText('alpha.txt (Working Tree)')
  await expect(tab).toHaveClass(/pending/)
  await expect(window.locator('.gd-overlay')).toHaveCount(0)

  // ── Stage hunk stages exactly one of the two hunks ─────────────────────
  await expect(window.locator(sel.scmHunkStage)).toHaveCount(2, { timeout: 10_000 })
  await window.locator(sel.scmHunkStage).first().dispatchEvent('mousedown')
  await expect(async () => {
    const cached = run(dir, 'diff', '--cached', '-U0', '--', 'alpha.txt')
    expect(cached).toContain('+line 2 EDITED')
    expect(cached).not.toContain('line 28 EDITED')
  }).toPass({ timeout: 10_000 })
  await expect(window.locator(sel.scmHunkStage)).toHaveCount(1, { timeout: 10_000 })
  await window.screenshot({ path: join(SHOTS, 'scm-layout-2-diff-tab.png') })

  // ── The commit happens ────────────────────────────────────────────────
  await window.locator(sel.scmCommitMsg).fill('feat: scm rebuild commit')
  await expect(window.locator(sel.scmCommitBtn)).toHaveText(/^Commit$/)
  await window.locator(sel.scmCommitBtn).click()
  await expect(async () => expect(run(dir, 'log', '-1', '--format=%s').trim()).toBe('feat: scm rebuild commit')).toPass({
    timeout: 10_000,
  })
  // Only the staged half went in: the second alpha edit is still unstaged.
  expect(run(dir, 'diff', '--', 'alpha.txt')).toContain('line 28 EDITED')
  await expect(window.locator('.gp-subject', { hasText: 'feat: scm rebuild commit' })).toBeVisible({ timeout: 10_000 })

  // ── The status line: branch (dirty) and sync counts ────────────────────
  await expect(window.locator(sel.scmStatusBranch)).toContainText('main*', { timeout: 10_000 })
  await expect(window.locator(sel.scmStatusSync)).toContainText('0↓ 1↑', { timeout: 10_000 })
  await window.screenshot({ path: join(SHOTS, 'scm-layout-3-committed.png') })

  expect(errors).toEqual([])
})
