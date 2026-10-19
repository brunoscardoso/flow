import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Flow 12 — the BOTTOM-SLOT ARBITRATION behind ⌃` / ⌘J (#1034).
 *
 * `⌃\`` / `⌘J` govern the bottom slot, not just the terminal: blueprint bottom
 * panes (peek drawer, learning, story, drift) open in the
 * same strip, so the shortcut first asks the board (`flow:terminal-will-toggle`,
 * synchronous). If a pane was open the board closes it and claims the event, and
 * the shell REVEALS the terminal into the freed slot — "replace, never stack"
 * (shell.ts `toggleBottomArea`, blueprint-board.ts `#onTerminalWillToggle`).
 *
 * The premise only holds on the REVEAL path. The peek drawer lives inside the
 * blueprint editor tab while the docked terminal lives under the editor stack,
 * so with the terminal visible (the boot default, #674) both are on screen at
 * once. Pressing ⌃` there claims-and-evicts but skips the compensating toggle
 * (`if (!(layout.editorVisible && terminalVisible)) toggleTerminal()`): the
 * terminal doesn't move and the drawer the user was reading is destroyed —
 * #1034. The mouse control with the same intent (rail "Terminal") is correct in
 * the same state, so the two input paths disagree.
 *
 * Guards here: the correct mouse sibling, the documented reveal/replace path,
 * and a tripwire for #1034 (fails today).
 */

const GRAPH_FIXTURE = {
  version: 1,
  derivedAt: new Date().toISOString(),
  coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['ts'], graphifyEnriched: false },
  nodes: [{ id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } }],
  edges: [],
}

/** git repo with a derived-graph fixture and one MODIFIED file, so the module
 *  popover's Changes tab lists a file whose row opens the review peek drawer. */
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
  writeFileSync(alpha, 'export const ALPHA = "worktree-edit-v2"\n')
}

const PEEK_DRAWER = '.fb-peek-drawer'

/** Open the Blueprint tab and peek the changed file — the bottom pane occupant.
 *  The code map's module popover (its Changes tab was the old door) is retired;
 *  `flow:peek-file` is the one entry every remaining peek door dispatches
 *  (story anchors, popover annotations — blueprint/index.ts). */
async function openPeek(window: Page): Promise<void> {
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root').first()).toBeVisible({ timeout: 15_000 })
  await window.evaluate(() =>
    document.dispatchEvent(new CustomEvent('flow:peek-file', { detail: { relPath: 'src/alpha.ts' } })),
  )
  await expect(window.locator(PEEK_DRAWER)).toBeVisible({ timeout: 15_000 })
  await expect(window.locator(PEEK_DRAWER)).toContainText('alpha.ts')
}

test.describe('flow 12 — bottom-slot arbitration (⌃`) vs. the blueprint peek drawer', () => {
  test.afterAll(() => cleanupSeeds())

  test('rail "Terminal" hides the terminal and leaves the peek drawer open (mouse sibling)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window, 'flow-ux-slot-', prepareDirtyRepo)
    await activateProject(window, root)

    const term = window.locator(sel.terminalRoot)
    const drawer = window.locator(PEEK_DRAWER)

    await openPeek(window)
    // Both occupy the screen at once — the state the arbitration assumes away.
    await expect(term).toBeVisible()
    await expect(drawer).toBeVisible()

    // Terminal-specific controls keep their exact semantics: hide the terminal,
    // never touch a board pane.
    await window.locator(statusButtonByText('Terminal')).click()
    await expect(term).toHaveCount(0)
    await expect(drawer).toBeVisible()

    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('⌃` with the terminal hidden replaces the peek drawer with the terminal', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window, 'flow-ux-slot-', prepareDirtyRepo)
    await activateProject(window, root)

    const term = window.locator(sel.terminalRoot)
    const drawer = window.locator(PEEK_DRAWER)

    await openPeek(window)
    // Hide the terminal via its own control so the slot is genuinely free.
    await window.locator(statusButtonByText('Terminal')).click()
    await expect(term).toHaveCount(0)
    await expect(drawer).toBeVisible()

    // Documented replace semantics on the REVEAL path: the pane yields the slot
    // and the terminal takes it — one action, never both stacked into a sliver.
    await window.keyboard.press('Control+Backquote')
    await expect(term).toBeVisible()
    await expect(drawer).toHaveCount(0)

    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
  })

  // #1034 — with the terminal ALREADY visible, ⌃` is a plain hide: the shell
  // only dispatches flow:terminal-will-toggle on the REVEAL path now, so the
  // board never gets a chance to evict its pane while the user is hiding the
  // terminal — parity with the rail "Terminal" item.
  test(
    '⌃` with the terminal visible hides the terminal and keeps the peek drawer (#1034)',
    async ({ window }) => {
      const root = await seedProject(window, 'flow-ux-slot-', prepareDirtyRepo)
      await activateProject(window, root)

      const term = window.locator(sel.terminalRoot)
      const drawer = window.locator(PEEK_DRAWER)

      await openPeek(window)
      await expect(term).toBeVisible()
      await expect(drawer).toBeVisible()

      await window.keyboard.press('Control+Backquote')

      // Parity with the rail "Terminal" item above: the terminal goes away…
      await expect(term).toHaveCount(0)
      // …and the pane the user was reading survives. Today: drawer count 0,
      // terminal still visible.
      await expect(drawer).toBeVisible()
    },
  )
})
