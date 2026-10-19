import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { waitForLinkedStructure } from './fixtures/linked-structure'
import { expectBoardHook } from '../board-hook'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A HIDDEN BOARD PAYS NOTHING (#1666 — the #1640 doctrine on this surface).
 *
 * Once the blueprint tab had been opened once, every debounced
 * `blueprint:changed` ran the full refresh pipeline while the tab was hidden:
 * a snapshot IPC read, a full re-render, and a ~0.9s bundled-CLI spawn for the
 * feature graph — and auto-capture churns the watched dirs once per chat turn,
 * so simply chatting billed the hidden board continuously.
 *
 * This drives the real path through the built app: open the board, hide the
 * editor the way a user does (the panel toggle), fire the change notification
 * the watcher fires, and demand ZERO reads while hidden and EXACTLY ONE on
 * reveal.
 */

test.afterAll(() => cleanupSeeds())

function writeFeature(root: string, slug: string, name: string): void {
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${slug}.md`),
    [
      '---',
      `id: feature:${slug}`,
      `name: ${name}`,
      'kind: core',
      'anchors: []',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${name}`,
      '',
      'Seeded by the hidden-board deferral probe.',
    ].join('\n'),
  )
}

interface ReadCounters {
  refresh: number
}

test('a hidden board defers changes; the reveal refreshes exactly once', async ({ window }) => {
  test.setTimeout(180_000)

  const root = await seedProject(window, 'flow-ux-hidden-defer-', (dir) =>
    writeFeature(dir, 'chats', 'Chats'),
  )
  await activateProject(window, root)
  // Let the project finish joining its Workspace (its first derive) so the
  // board is not still receiving real changes while it is measured.
  await waitForLinkedStructure(window, root)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  await expect(window.locator('.fb-terr-cell', { hasText: 'Chats' }).first()).toBeVisible({
    timeout: 120_000,
  })

  // The hook must be there — a missing one used to fail later as a bare
  // TypeError on `board.refresh` with no hint of why.
  await expectBoardHook(window)

  // Instrument the ONE seam the fix gates: board.refresh() fronts the
  // snapshot IPC read, the full render AND the lazy feature-graph CLI spawn.
  // (window.flow is a contextBridge surface — non-writable — so the IPC
  // methods themselves cannot be wrapped from the page; the board instance
  // can.)
  await window.evaluate(() => {
    const board = (window as unknown as { __flowBoard: { refresh(): Promise<void> } }).__flowBoard
    const counters = { refresh: 0 }
    ;(window as unknown as { __probeCounters: typeof counters }).__probeCounters = counters
    const original = board.refresh.bind(board)
    board.refresh = () => {
      counters.refresh += 1
      return original()
    }
  })

  // QUIET FIRST. A freshly added project's first derive is still landing its
  // files for a few seconds, and each write is a REAL `blueprint:changed` —
  // one that lands after the reveal is genuine news, not a backlog replay, and
  // would be counted against the reveal. Wait until the board has heard no
  // change for three seconds before measuring anything.
  await window.evaluate(() => {
    const board = (window as unknown as { __flowBoard: { handleChanged(r: string, l?: boolean): void } })
      .__flowBoard
    const probe = window as unknown as { __lastChange: number }
    probe.__lastChange = Date.now()
    const original = board.handleChanged.bind(board)
    board.handleChanged = (rootId: string, learningOnly?: boolean) => {
      probe.__lastChange = Date.now()
      original(rootId, learningOnly)
    }
  })
  await expect
    .poll(
      () => window.evaluate(() => Date.now() - (window as unknown as { __lastChange: number }).__lastChange),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(3_000)
  await window.evaluate(() => {
    ;(window as unknown as { __probeCounters: ReadCounters }).__probeCounters.refresh = 0
  })

  // Hide the editor the way a user does (⌘⌥D / Ctrl+Alt+D toggles the center
  // editor area) and prove the board is really off screen.
  await window.keyboard.press('Control+Alt+d')
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          (window as unknown as { __flowBoard: { element: HTMLElement } }).__flowBoard.element
            .offsetParent === null,
      ),
    )
    .toBe(true)

  // Count from the moment it is hidden: a refresh that a real change (the
  // provisioner's first derive landing) started while the board was still on
  // screen is not the question. Everything from here on is.
  await window.evaluate(() => {
    ;(window as unknown as { __probeCounters: ReadCounters }).__probeCounters.refresh = 0
  })

  // Three change events while hidden — what a short chat exchange produces.
  await window.evaluate((rootPath) => {
    const board = (window as unknown as { __flowBoard: { handleChanged(r: string): void } })
      .__flowBoard
    board.handleChanged(rootPath)
    board.handleChanged(rootPath)
    board.handleChanged(rootPath)
  }, root)
  await window.waitForTimeout(800)

  const hidden = (await window.evaluate(
    () => (window as unknown as { __probeCounters: ReadCounters }).__probeCounters,
  )) as ReadCounters
  expect(hidden, 'a hidden board must pay for nothing').toEqual({ refresh: 0 })

  // Reveal the way a user does. The Blueprint button lived in the status bar
  // and the rail; it sits on the EDITOR's own top bar now, which ⌘⌥D just put
  // away with the editor — so the same toggle brings both back. Prove the
  // board is really on screen before counting.
  await window.keyboard.press('Control+Alt+d')
  await expect
    .poll(() =>
      window.evaluate(
        () =>
          (window as unknown as { __flowBoard: { element: HTMLElement } }).__flowBoard.element
            .offsetParent !== null,
      ),
    )
    .toBe(true)
  await expect
    .poll(async () =>
      (
        (await window.evaluate(
          () => (window as unknown as { __probeCounters: ReadCounters }).__probeCounters,
        )) as ReadCounters
      ).refresh,
    )
    .toBe(1)
  await window.waitForTimeout(800)

  const revealed = (await window.evaluate(
    () => (window as unknown as { __probeCounters: ReadCounters }).__probeCounters,
  )) as ReadCounters
  expect(revealed.refresh, 'one reveal, one refresh — never a backlog replay').toBe(1)
  await expect(window.locator('.fb-terr-cell', { hasText: 'Chats' }).first()).toBeVisible()
})
