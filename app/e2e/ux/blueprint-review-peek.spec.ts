import { test, expect, type Page } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * blueprint Review-Mode peek (#609) — flow 10 (Blueprint), UX sweep.
 *
 * Prior blueprint-interaction.spec covers the CLEAN-file peek (open, swap,
 * re-peek, promote, close). blueprint-review.spec only pokes the review SEAMS
 * abstractly (dispatching flow:blueprint-review / flow:prefill-composer with no
 * cards), on the premise that a real dirty-repo board needs a Claude account.
 * It does not — the peek drawer's Review Mode reads git.diff and stages via
 * git.stage, none of which needs credentials. This probe drives the genuine
 * end-to-end Review-Mode peek: a CHANGED file peeked from the board defaults to
 * its working-tree diff, exposes a Diff/File toggle + Approve/Refuse verdict
 * buttons, and Approve actually stages the file.
 */

const GRAPH_FIXTURE = {
  version: 1,
  derivedAt: new Date().toISOString(),
  coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['ts'], graphifyEnriched: false },
  nodes: [{ id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } }],
  edges: [],
}

/** git init + one committed src/alpha.ts, then modify it on disk so `git status`
 *  reports it MODIFIED (a HEAD side exists → Review Mode diff is available). */
function prepareDirtyRepo(dir: string): void {
  const structure = join(dir, 'flow', 'brain', '.structure')
  mkdirSync(structure, { recursive: true })
  writeFileSync(join(structure, 'graph.json'), JSON.stringify(GRAPH_FIXTURE))

  const src = join(dir, 'src')
  mkdirSync(src, { recursive: true })
  const alpha = join(src, 'alpha.ts')
  writeFileSync(alpha, 'export const ALPHA = "committed-baseline"\n')

  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'QA',
        GIT_AUTHOR_EMAIL: 'qa@example.com',
        GIT_COMMITTER_NAME: 'QA',
        GIT_COMMITTER_EMAIL: 'qa@example.com',
      },
    })
  }
  git('add', 'src/alpha.ts')
  git('commit', '-q', '-m', 'baseline')
  // Working-tree edit → MODIFIED (unstaged) against HEAD.
  writeFileSync(alpha, 'export const ALPHA = "worktree-edit-v2"\n')
}

/**
 * Peek the modified file from the board.
 *
 * The door used to be a module card's popover → Changes tab → the file's row,
 * on the code map. The code map is retired (0803facb), and with it that door;
 * every peek entry that survives (story anchors, annotation links, the corpus
 * browser, the storyline) dispatches `flow:peek-file` into the board's ONE
 * listener (blueprint/index.ts) — so this asks it the same way. The drawer and
 * its Review Mode are what this spec is about, and they are unchanged.
 */
async function peekChangedFile(window: Page): Promise<void> {
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  // The board learns the tree's git state when it loads (`#loadGitStatus`),
  // and Review Mode is chosen from it at the moment of the peek — a peek that
  // lands first opens the CLEAN view. Peek until the board knows (re-peeking
  // the same path is the drawer's own re-open, not a second drawer).
  await expect
    .poll(
      async () => {
        await window.evaluate(() =>
          document.dispatchEvent(new CustomEvent('flow:peek-file', { detail: { relPath: 'src/alpha.ts' } })),
        )
        await window.waitForTimeout(1_000)
        return window.locator('.fb-peek-drawer .gd-overlay').isVisible()
      },
      { timeout: 30_000, intervals: [100], message: 'the changed file never opened in Review Mode' },
    )
    .toBe(true)
}

test.describe('blueprint Review-Mode peek (#609): changed file diff + verdict', () => {
  test.afterAll(() => cleanupSeeds())

  test('peeking a changed file defaults to its working-tree diff with a File toggle', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window, 'flow-ux-review-', prepareDirtyRepo)
    await activateProject(window, root)

    await peekChangedFile(window)

    const drawer = window.locator('.fb-peek-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('.fb-peek-title')).toHaveText('src/alpha.ts')

    // Review Mode: a changed file DEFAULTS to the working-tree diff overlay.
    const diffOverlay = drawer.locator('.gd-overlay')
    await expect(diffOverlay).toBeVisible({ timeout: 10_000 })
    await expect(diffOverlay.locator('.gd-subtitle')).toHaveText('Working tree vs HEAD')

    // The header shows a toggle labelled "File" (click → full file) and the
    // Approve/Refuse verdict buttons — all only shown for a changed file.
    const toggle = drawer.locator('.fb-peek-toggle-mode')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveText('File')
    await expect(drawer.locator('.fb-peek-approve')).toHaveText('Approve')
    await expect(drawer.locator('.fb-peek-refuse')).toHaveText('Refuse')

    // Toggle → full file editor shows the worktree content, diff overlay hides.
    await toggle.click()
    await expect(toggle).toHaveText('Diff')
    await expect(drawer.locator('.fb-peek-body .monaco-editor .view-lines')).toContainText(
      'worktree-edit-v2',
      { timeout: 10_000 },
    )

    expect(errors, `uncaught errors during review-peek flow:\n${errors.join('\n')}`).toEqual([])
  })

  test('Approve in the peek drawer stages the changed file', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window, 'flow-ux-review-', prepareDirtyRepo)
    await activateProject(window, root)

    await peekChangedFile(window)

    const drawer = window.locator('.fb-peek-drawer')
    await expect(drawer).toBeVisible()
    const approve = drawer.locator('.fb-peek-approve')
    await expect(approve).toHaveText('Approve')

    await approve.click()

    // The button settles into its decided state...
    await expect(approve).toHaveText('Approved ✓', { timeout: 10_000 })

    // ...and the file is genuinely staged (git.status reports staged: true).
    const staged = await window.evaluate(async (rootId) => {
      const status = await (
        window as unknown as {
          flow: { git: { status(a: { rootId: string }): Promise<{ changes: Array<{ filePath: string; staged: boolean }> }> } }
        }
      ).flow.git.status({ rootId })
      return status.changes.find((c) => c.filePath === 'src/alpha.ts')?.staged ?? null
    }, root)
    expect(staged).toBe(true)

    expect(errors, `uncaught errors during approve flow:\n${errors.join('\n')}`).toEqual([])
  })
})
