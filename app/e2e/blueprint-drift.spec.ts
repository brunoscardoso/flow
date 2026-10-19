import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures/electron'
import { statusButtonByText } from './selectors'
import { seedProject, activateProject, cleanupSeeds } from './ux/fixtures/seed'
import type {
  BlueprintDrift,
  BlueprintDriftNode,
  BlueprintSnapshot,
} from '../src/shared/ipc-contract'
import { callBoard } from './board-hook'

/**
 * Blueprint DRIFT panel (drift feature, Phase 6) — the board's entry point to
 * "what changed since the blueprint was derived": a panel (opened from ⌘P
 * "Blueprint: Show Drift" since the header button and its badge were retired)
 * that groups external (dominant) vs your/agent (dimmed)
 * changes plus a system-change bucket, a per-card `.fb-drift-mark` glow, and an
 * `[acknowledge]` action wired to the ack IPC channel.
 *
 * ⚠ Like the other blueprint specs, this drives the BUILT app (`out/main`), so it
 * needs a full CLI + app rebuild (`npm run build` / `npm run rebuild`) and
 * `planflow-ai` on PATH before it will run — the ack test's post-ack refresh
 * re-reads the snapshot, which spawns the bundled `blueprint drift-check` CLI.
 *
 * Board state is injected HERMETICALLY: `blueprint drift-check` is a MAIN-side
 * spawn (drift is never read from a file), and the git-authored origin split
 * cannot be seeded deterministically, so instead of coaxing the real pipeline we
 * push a synthetic snapshot through the E2E-only `window.__flowBoard` hook
 * (exposed by the preload when `FLOW_E2E=1`, the same mechanism the change-
 * simulation spec's board-mount pattern relies on). We still seed a real
 * `graph.json` so the board mounts its module cards, then overlay the drift.
 */

/** >2 depth-1 modules so the top level renders; drift nodes below target these
 *  visible top-level cards by id so the per-card marker lands on real cards. */
const GRAPH_FIXTURE = {
  version: 1,
  derivedAt: '2026-07-20T00:00:00.000Z',
  coverage: { filesScanned: 3, filesTotal: 3, extractorsRun: ['ts'], graphifyEnriched: false },
  nodes: [
    { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1, degree: 5 } },
    { id: 'module:lib', kind: 'module', label: 'lib', sourceFile: 'lib', meta: { depth: 1, degree: 2 } },
    { id: 'module:test', kind: 'module', label: 'test', sourceFile: 'test', meta: { depth: 1, degree: 8 } },
  ],
  edges: [],
}

function seedStructure(root: string): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH_FIXTURE))
}

/** The id the seeded capability is drawn under, on both sides of the mark. */
const FEATURE_ID = 'feature:ingest-pipeline'

/** One capability, so `resolvePane` chooses the FEATURE board (the default
 *  view) instead of the code map — the sheet the cell assertion needs. */
function seedFeature(root: string): void {
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'ingest-pipeline.md'),
    [
      '---',
      `id: ${FEATURE_ID}`,
      'name: Ingest Pipeline',
      'kind: core',
      'anchors: [src/ingest/reader.ts]',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      '# Ingest Pipeline',
      '',
      'Seeded by the drift probe.',
    ].join('\n'),
  )
}

/** One drifted node with sensible defaults; override per test. */
function driftNode(nodeId: string, over: Partial<BlueprintDriftNode> = {}): BlueprintDriftNode {
  return {
    nodeId,
    label: nodeId.replace(/^module:/, ''),
    origin: 'external',
    changedFiles: [`${nodeId.replace(/^module:/, '')}/a.ts`],
    dependents: 1,
    acked: false,
    ...over,
  }
}

/** Wrap a drift projection in a snapshot carrying the seeded graph. */
function snapshotWithDrift(drift: BlueprintDrift): BlueprintSnapshot {
  return { graph: GRAPH_FIXTURE as unknown as BlueprintSnapshot['graph'], annotations: [], proposals: [], mtime: Date.now(), drift }
}

/**
 * Mount the board over a fresh seeded project, wait for its top-level cards, then
 * push the synthetic drift snapshot through the E2E board hook. Returns the
 * project root so a test can drive the real ack IPC against it.
 */
async function mountBoardWithDrift(
  app: import('@playwright/test').ElectronApplication,
  window: import('@playwright/test').Page,
  drift: BlueprintDrift,
): Promise<string> {
  // THE DRIFT RIDES ON EVERY REAL READ. Pushing a synthetic snapshot into the
  // board raced the board's own reads (its load, a graphify landing's
  // re-derive): whichever landed last won, so the same build passed and
  // failed. Main's `blueprint:read` is wrapped instead, adding this drift to
  // the REAL snapshot — until the real ack channel is called, after which the
  // real (drift-free) snapshot is what the board reads, exactly as an ack
  // advancing the baseline would leave it.
  await app.evaluate(({ ipcMain }, injected) => {
    type Handler = (event: unknown, request: unknown) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const read = handlers.get('blueprint:read')
    const ack = handlers.get('blueprint:ackDrift')
    if (read === undefined || ack === undefined) throw new Error('no blueprint:read / blueprint:ackDrift handler to wrap')
    let acked = false
    ipcMain.removeHandler('blueprint:read')
    ipcMain.handle('blueprint:read', async (event, request: unknown) => {
      const snapshot = (await read(event, request)) as Record<string, unknown>
      return acked ? snapshot : { ...snapshot, drift: injected }
    })
    ipcMain.removeHandler('blueprint:ackDrift')
    ipcMain.handle('blueprint:ackDrift', async (event, request: unknown) => {
      const answer = await ack(event, request)
      acked = true
      return answer
    })
  }, drift)
  const root = await seedProject(window)
  seedStructure(root)
  await activateProject(window, root)

  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  // WAIT FOR THE DEFAULT SHEET, WHICH IS THE TERRITORY.
  await expect(window.locator('.fb-territory')).toBeVisible({ timeout: 30_000 })
  return root
}

/**
 * Open the drift panel the way a person can today. The board's header Drift
 * button (and its unacked badge) went when drift moved under the Learning
 * panel (user call 2026-07-23); the standalone panel's remaining door is the
 * ⌘P command "Blueprint: Show Drift" (palette-commands.ts).
 */
async function openDriftFromPalette(window: import('@playwright/test').Page): Promise<void> {
  await window.keyboard.press('ControlOrMeta+p')
  await window.locator('.fl-palette-panel').waitFor({ state: 'visible', timeout: 5000 })
  await window.locator('.fl-palette-input').fill('>Blueprint: Show Drift')
  await expect(window.locator('.fl-palette-row').first()).toContainText('Blueprint: Show Drift')
  await window.keyboard.press('Enter')
  await expect(window.locator('.fb-drift-panel')).toBeVisible()
}

test.describe('blueprint drift panel', () => {
  test.afterAll(() => cleanupSeeds())

  test('"Blueprint: Show Drift" opens the panel and lists the changed nodes', async ({ app, window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    await mountBoardWithDrift(app, window, {
      nodes: [driftNode('module:src'), driftNode('module:test', { dependents: 8 })],
      system: [],
      shown: 2,
      overflow: 0,
    })

    // The panel lists one row per changed node.
    await openDriftFromPalette(window)
    await expect(window.locator('.fb-drift-panel .fb-drift-row')).toHaveCount(2)
    await expect(window.locator('.fb-drift-panel')).toContainText('src')
    await expect(window.locator('.fb-drift-panel')).toContainText('test')

    expect(errors, `renderer errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('external-origin rows are visually dominant vs your/agent rows', async ({ app, window }) => {
    await mountBoardWithDrift(app, window, {
      nodes: [
        driftNode('module:test', { origin: 'external', author: 'Other Dev', commit: 'abcdef1234', dependents: 8 }),
        driftNode('module:src', { origin: 'yours', dependents: 5 }),
      ],
      system: [],
      shown: 2,
      overflow: 0,
    })

    await openDriftFromPalette(window)

    // External changes form the dominant group; your/agent changes the dimmed one.
    await expect(window.locator('.fb-drift-panel .fb-drift-external')).toBeVisible()
    await expect(window.locator('.fb-drift-panel .fb-drift-self')).toBeVisible()
    await expect(window.locator('.fb-drift-panel .fb-drift-row-dominant')).toHaveCount(1)
    await expect(window.locator('.fb-drift-panel .fb-drift-row-dim')).toHaveCount(1)
    // The dominant (external) row carries the external author.
    await expect(window.locator('.fb-drift-panel .fb-drift-row-dominant')).toContainText('Other Dev')
  })

  test('[acknowledge] calls the ack channel and the acknowledged drift leaves the panel', async ({ app, window }) => {
    await mountBoardWithDrift(app, window, {
      nodes: [
        driftNode('module:src', { commit: 'aaaaaaa1', dependents: 5 }),
        driftNode('module:test', { commit: 'bbbbbbb2', dependents: 8 }),
      ],
      system: [],
      shown: 2,
      overflow: 0,
    })

    // Two unacked nodes → two rows, each with its [acknowledge] action. (The
    // header's unacked badge left with the header Drift button.)
    await openDriftFromPalette(window)
    const rows = window.locator('.fb-drift-panel .fb-drift-row')
    await expect(rows).toHaveCount(2)

    // Clicking an [acknowledge] action runs #ackDrift → the ack IPC channel, then
    // refreshes the snapshot. The real read has no file-stamps baseline seeded, so
    // drift clears (cold index) and its rows leave the panel (which closes
    // itself once nothing has drifted — #refreshDriftSurfaces).
    await window
      .locator('.fb-drift-panel .fb-drift-action', { hasText: 'acknowledge' })
      .first()
      .click()
    await expect(rows).toHaveCount(0, { timeout: 30_000 })
  })

  /**
   * THE DRIFT BADGE, ON THE TERRITORY.
   *
   * The board's default view is the territory, so the mark has to be on the
   * sheet a reader actually opens. The cell reads the drift store by id,
   * through the shared lookup and badge builder — so this asserts the CLASSES,
   * which is the part a second implementation would have quietly got different.
   *
   * The drift node is injected against the FEATURE's id (the snapshot is
   * synthetic here) because that is what the sheet draws.
   */
  test('the same .fb-drift-mark renders on a territory cell, beside its learn dot', async ({
    window,
  }) => {
    const root = await seedProject(window, 'flow-drift-cell-', (dir) => {
      seedStructure(dir)
      seedFeature(dir)
    })
    await activateProject(window, root)
    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator('.flow-board-root')).toBeVisible()
    const cell = window.locator(`.fb-terr-cell[data-feature-id="${FEATURE_ID}"]`)
    await expect(cell).toBeVisible({ timeout: 120_000 })

    // THE SYNTHETIC SNAPSHOT RACES THE REAL ONE. `setSnapshot` stands in for a
    // store the app is ALSO loading in the background, and a real snapshot
    // landing after the push legitimately replaces it — taking the mark with
    // it. A single push plus a fixed wait is therefore a coin toss: measured
    // over two runs of this file, the same build passed it once and failed it
    // once, with the wiring unchanged. The push is repeated until the render
    // on screen is one that carries the mark; every assertion below is
    // untouched.
    const drift = snapshotWithDrift({
      nodes: [driftNode(FEATURE_ID, { origin: 'external', dependents: 3 })],
      system: [],
      shown: 1,
      overflow: 0,
    })
    const pushDrift = async (): Promise<void> => {
      await callBoard(window, 'setSnapshot', [drift])
    }
    const marked = window.locator(`.fb-terr-cell[data-feature-id="${FEATURE_ID}"]`)
    await expect
      .poll(
        async () => {
          await pushDrift()
          await window.waitForTimeout(400)
          return marked.locator('.fb-drift-mark').count()
        },
        { timeout: 30_000, message: 'no render ever carried the drift mark on the cell' },
      )
      .toBeGreaterThan(0)

    await expect(marked.locator('.fb-drift-mark')).toBeVisible()
    await expect(marked.locator('.fb-drift-mark.fb-drift-mark-external')).toHaveCount(1)
    // BOTH CLAIMS, LEGIBLY AT ONCE — which is the whole reason the drift mark is
    // a cool diamond and the learning dot is a round amber one. A seeded feature
    // has been understood by nobody, so its dot reads `none` and the two states
    // coexist on one 12px row.
    await expect(marked.locator('.fb-learn-dot')).toHaveCount(1)
    await expect(marked.locator('.fb-learn-dot.fb-learn-none')).toHaveCount(1)
    // …and the badge never lands on the control's corner.
    const boxes = await window.evaluate((id: string) => {
      const el = document.querySelector(`.fb-terr-cell[data-feature-id="${id}"]`)
      const mark = el?.querySelector('.fb-drift-mark')?.getBoundingClientRect()
      const control = el?.querySelector('.fb-terr-control')?.getBoundingClientRect()
      return mark === undefined || control === undefined
        ? null
        : { markRight: mark.right, controlLeft: control.left }
    }, FEATURE_ID)
    console.log(`[measured] drift mark vs control: ${JSON.stringify(boxes)}`)
    if (boxes !== null) {
      expect(boxes.markRight, 'the drift badge overlaps the open-level control').toBeLessThanOrEqual(
        boxes.controlLeft,
      )
    }
  })

  test('a large drift set shows the "…and N more" overflow affordance', async ({ app, window }) => {
    await mountBoardWithDrift(app, window, {
      // main already capped the projection: two shown nodes, five more beyond the cap.
      nodes: [driftNode('module:test', { dependents: 8 }), driftNode('module:src', { dependents: 5 })],
      system: [],
      shown: 2,
      overflow: 5,
    })

    await openDriftFromPalette(window)
    await expect(window.locator('.fb-drift-panel .fb-learn-more')).toContainText('and 5 more')
  })
})
