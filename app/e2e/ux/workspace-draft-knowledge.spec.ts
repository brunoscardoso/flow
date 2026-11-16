import { test, expect } from '../fixtures/electron'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, removeTempDir, waitForWorkspaceLink } from './fixtures/seed'

/**
 * A DRAFT IS TAGGED ON THE MAP (plan workspace_knowledge_draft_solid, note 10).
 *
 * One feature's only learning is stamped on a branch that is not the default
 * branch; another's is unstamped (solid). The real bundled CLI resolves the
 * status, and the board must draw the draft cell with a dashed outline and a
 * `draft · <branch>` tag — and the solid cell with neither.
 *
 * Nothing in main is stubbed: the graph comes from the CLI over seeded files.
 */

test.afterAll(() => cleanupSeeds())

const SCREENSHOT = process.env['FLOW_DRAFT_TAG_SHOT']

/** A provenance record line exactly as the CLI's record writer writes it. */
function provenance(branch: string, commit = 'a'.repeat(40)): { id: string; line: string } {
  const body = JSON.stringify({ branch, commit, onDefault: false, hashes: [] })
  const id = createHash('sha256').update(body).digest('hex').slice(0, 16)
  return { id, line: `{"id":${JSON.stringify(id)},${body.slice(1)}` }
}

function writeFeature(root: string, slug: string, name: string, learning: string): void {
  mkdirSync(join(root, 'src', slug), { recursive: true })
  const anchors = Array.from({ length: 4 }, (_, i) => `src/${slug}/file-${String(i)}.ts`)
  for (const file of anchors) {
    writeFileSync(join(root, file), Array.from({ length: 40 }, (_, n) => `export const v${String(n)} = ${String(n)}`).join('\n') + '\n')
  }
  writeFileSync(
    join(root, 'flow', 'brain', 'features', `${slug}.md`),
    [
      '---',
      `id: feature:${slug}`,
      `name: ${name}`,
      'kind: core',
      `anchors: [${anchors.join(', ')}]`,
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${name}`,
      '',
      'Seeded by the draft knowledge probe.',
      '',
      '## Learned',
      learning,
      '',
    ].join('\n'),
  )
}

function seedDraft(root: string): void {
  mkdirSync(join(root, 'flow', 'brain', 'features'), { recursive: true })
  mkdirSync(join(root, 'flow', 'brain', '.structure'), { recursive: true })
  const record = provenance('feat/refunds')
  writeFileSync(join(root, 'flow', 'brain', '.structure', 'knowledge-provenance.jsonl'), `${record.line}\n`)
  writeFeature(root, 'refunds', 'Refunds', `- Refunds settle nightly. <!-- learnedAt: ${record.id} --> <!-- learned: code 2026-11-10 -->`)
  writeFeature(root, 'invoices', 'Invoices', '- Invoices are issued monthly. <!-- learned: code 2026-11-10 -->')
  // A default branch to name in the hover: commit on `main`.
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root })
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['-c', 'user.email=e2e@flow.test', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'seed'], { cwd: root })
}

test('a feature learned on an unmerged branch is drawn dashed with its branch tag', async ({ window }) => {
  const root = await seedProject(window, 'flow-ux-draft-', seedDraft, { onboarded: true })
  await activateProject(window, root)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()

  const draftCell = window.locator('.fb-terr-cell[data-feature-id="feature:refunds"]')
  const solidCell = window.locator('.fb-terr-cell[data-feature-id="feature:invoices"]')
  await expect(draftCell).toBeVisible({ timeout: 120_000 })
  await expect(solidCell).toBeVisible()

  // Positive first: the draft cell carries the tag, naming the branch.
  const tag = draftCell.locator('.fb-terr-draft-tag')
  await expect(tag).toBeVisible({ timeout: 30_000 })
  await expect(tag).toHaveText('draft · feat/refunds')
  await expect(tag.locator('.fb-terr-draft-branch')).toHaveText('feat/refunds')
  await expect(tag).toHaveAttribute(
    'title',
    'Learned on feat/refunds, not merged yet. This becomes part of the map once the branch is merged to main. ' +
      'Until then agents and Ask treat it as work in progress.',
  )
  await expect(draftCell).toHaveClass(/fb-terr-draft/)
  expect(await draftCell.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('dashed')
  const branchFont = await tag.locator('.fb-terr-draft-branch').evaluate((el) => getComputedStyle(el).fontFamily)
  expect(branchFont.toLowerCase()).toMatch(/mono/)

  // …and the solid cell carries neither.
  await expect(solidCell.locator('.fb-terr-draft-tag')).toHaveCount(0)
  expect(await solidCell.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid')

  if (SCREENSHOT !== undefined && SCREENSHOT !== '') {
    await window.waitForTimeout(400)
    await window.locator('.flow-board-root').screenshot({ path: SCREENSHOT })
  }
})

/** The CLI the app ships — the same file the app's own promotion spawns. */
const BUNDLED_CLI = join(__dirname, '../../resources/cli/planflow-ai.mjs')

const remotes: string[] = []
test.afterAll(() => {
  for (const dir of remotes.splice(0)) removeTempDir(dir)
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=e2e@flow.test', '-c', 'user.name=e2e', ...args], { cwd, encoding: 'utf8' }).trim()
}

/**
 * The refunds learning is stamped on a REAL commit of `feat/refunds`, which is
 * pushed to a real (bare) `origin` but not merged — so the cell starts as a
 * draft, and a real merge plus the real promotion checker can make it solid.
 */
function seedMergeable(root: string): void {
  mkdirSync(join(root, 'flow', 'brain', 'features'), { recursive: true })
  mkdirSync(join(root, 'flow', 'brain', '.structure'), { recursive: true })
  writeFeature(root, 'invoices', 'Invoices', '- Invoices are issued monthly. <!-- learned: code 2026-11-10 -->')
  writeFeature(root, 'refunds', 'Refunds', '- placeholder')
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root })
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'seed')

  git(root, 'checkout', '-q', '-b', 'feat/refunds')
  writeFileSync(join(root, 'src', 'refunds', 'file-0.ts'), 'export const settles = "nightly"\n')
  git(root, 'commit', '-q', '-am', 'refunds settle nightly')
  const commit = git(root, 'rev-parse', 'HEAD')
  git(root, 'checkout', '-q', 'main')

  const record = provenance('feat/refunds', commit)
  writeFileSync(join(root, 'flow', 'brain', '.structure', 'knowledge-provenance.jsonl'), `${record.line}\n`)
  writeFeature(root, 'refunds', 'Refunds', `- Refunds settle nightly. <!-- learnedAt: ${record.id} --> <!-- learned: code 2026-11-10 -->`)

  const origin = mkdtempSync(join(tmpdir(), 'flow-ux-draft-origin-'))
  remotes.push(origin)
  git(origin, 'init', '-q', '--bare')
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'push', '-q', 'origin', 'main', 'feat/refunds')
  git(root, 'remote', 'set-head', 'origin', 'main')
}

test('a draft cell loses its tag once its branch is merged and promoted', async ({ window, userDataDir }) => {
  const root = await seedProject(window, 'flow-ux-draft-promote-', seedMergeable, { onboarded: true })
  await activateProject(window, root)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()

  const draftCell = window.locator('.fb-terr-cell[data-feature-id="feature:refunds"]')
  await expect(draftCell).toBeVisible({ timeout: 120_000 })

  // Positive first (allowed-pattern #28): before the merge the cell IS tagged.
  const tag = draftCell.locator('.fb-terr-draft-tag')
  await expect(tag).toBeVisible({ timeout: 30_000 })
  await expect(tag).toHaveText('draft · feat/refunds')
  await expect(draftCell).toHaveClass(/fb-terr-draft/)

  // The branch lands on the default branch, on the remote.
  git(root, 'merge', '-q', '--no-ff', '-m', 'Merge feat/refunds', 'feat/refunds')
  git(root, 'push', '-q', 'origin', 'main')

  // The real promotion checker, through the bundled CLI the app spawns.
  await waitForWorkspaceLink(root)
  const out = execFileSync(process.execPath, [BUNDLED_CLI, 'workspace', 'promote', '--target', root, '--json'], {
    cwd: root,
    encoding: 'utf8',
    // Workspace git children allow https/ssh only; a spec's bare `origin` is a
    // local path, which the E2E-only override lets through (file protocol).
    env: {
      ...process.env,
      PLAN_FLOW_HOME: join(userDataDir, 'plan-flow-home'),
      FLOW_E2E: '1',
      FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS: 'file',
    },
  })
  const payload = JSON.parse(
    out
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .pop() ?? 'null',
  ) as { action: string; totals: { solid: number } }
  expect(payload.action).toBe('promote')
  expect(payload.totals.solid, out).toBeGreaterThanOrEqual(1)

  await window.evaluate(() => (window as unknown as { __flowBoard: { refresh(): Promise<void> } }).__flowBoard.refresh())

  // …and now the same cell is drawn solid, with no tag.
  await expect(draftCell).toBeVisible()
  await expect(tag).toHaveCount(0, { timeout: 30_000 })
  await expect(draftCell).not.toHaveClass(/fb-terr-draft/)
  expect(await draftCell.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid')
})
