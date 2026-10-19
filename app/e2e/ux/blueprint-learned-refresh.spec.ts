import { test, expect } from '../fixtures/electron'
import type { Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE PROSE HALF OF THE SAME BUG `blueprint-parts-refresh.spec.ts` GUARDS.
 *
 * An understand pass has three products and main broadcasts one event per
 * product: the picture (`learn:featureViewed`), the parts (`learn:featureParts`)
 * and the learnings (`learn:featureLearned`). The parts half was found unwired
 * on 2026-08-10 and fixed. The prose half was left exactly as it was:
 *
 *     app/src/main/index.ts   broadcast('learn:featureLearned', …)
 *     app/src/preload/index.ts  onFeatureLearned: subscribe(…)
 *     app/src/renderer/**       — nobody
 *
 * The broadcast site's own comment claimed "a brief that is open on this feature
 * repaints on this event". No renderer had ever subscribed, so nothing
 * repainted on it: a feature's learnings appeared only after an app restart,
 * whose fresh board re-fetches the feature graph at mount. That is the same
 * report — "only if I force refresh, quit and open again" — one step later in
 * the same pass.
 *
 * WHAT THIS SPEC ASSERTS, AND WHY THAT AND NOT THE BRIEF
 * =====================================================
 * The wiring refreshes TWO surfaces: the feature graph (the ring's per-feature
 * understanding dot) and, when a brief for that feature is open, the brief
 * itself. Only the first is reachable without a model call — an open brief is
 * `blueprint:brief` over the bundled CLI, and its learnings chips need a stored
 * curated view that only a real pass writes. So the assertion here is the dot,
 * which is a full trip through the production path: main's real broadcast, the
 * real preload bridge, the board's subscription, `#loadFeatureGraph`'s IPC
 * re-fetch of the store, and the repaint.
 *
 * `understandingOf` (src/cli/blueprint/feature-graph.ts) is what turns the
 * written learnings into `learned` — a feature's own `## Learned` entries, never
 * its modules' (d5ae3b83). So `fb-learn-none` → `fb-learn-learned` on the disc
 * is exactly "the learnings this pass wrote are now on screen".
 *
 * No reload, no navigation, no re-open — that is the whole of what was reported.
 *
 * FALSIFIED (2026-08-10, this machine): removing the `onFeatureLearned`
 * subscription from `blueprint-board.ts` and rebuilding turns the last
 * expectation RED with the dot still `fb-learn-none`, reproducing the report;
 * restored, it passes.
 */

test.afterAll(() => cleanupSeeds())

const SIBLINGS: Array<[slug: string, name: string]> = [
  ['agents', 'Agents'],
  ['connectors', 'Connectors'],
]

const TARGET_SLUG = 'chats'
const TARGET_NAME = 'Chats'

/** `- text <!-- learned: <provenance> <date> -->` — what `writeLearned` writes. */
const LEARNINGS = [
  'The turn is teed by the Gateway BFF before the queue ever sees it.',
  'Live delivery rides one SSE connection multiplexed per chat.',
]

/**
 * The feature file. `learnings` empty writes NO `## Learned` section at all —
 * the pre-learn state the report starts from, not a section that is empty.
 *
 * `lastFullRead: null` matters: a stamped full read is a THIRD signal
 * `understandingOf` counts as learned, and a seed carrying one would report
 * `learned` before any learning was written and make this spec vacuous.
 */
function writeCore(
  root: string,
  slug: string,
  name: string,
  learnings: readonly string[] = [],
): void {
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  const learnedSection =
    learnings.length === 0
      ? []
      : ['## Learned', '', ...learnings.map((text) => `- ${text} <!-- learned: code 2026-08-10 -->`)]
  writeFileSync(
    join(dir, `${slug}.md`),
    [
      '---',
      `id: feature:${slug}`,
      `name: ${name}`,
      'kind: core',
      `anchors: [module:src/${slug}]`,
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${name}`,
      '',
      'Seeded by the learned-refresh regression guard.',
      '',
      ...learnedSection,
    ].join('\n'),
  )
}

/** A code map the feature's anchors resolve against, so its card renders at all. */
function writeCodeMap(root: string): void {
  const src = join(root, 'src', TARGET_SLUG)
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'index.ts'), 'export const seeded = true\n')
  const structure = join(root, 'flow', 'brain', '.structure')
  mkdirSync(structure, { recursive: true })
  writeFileSync(
    join(structure, 'graph.json'),
    JSON.stringify({
      version: 1,
      derivedAt: '2026-08-10T00:00:00.000Z',
      coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: false },
      nodes: [
        { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
        {
          id: `module:src/${TARGET_SLUG}`,
          kind: 'module',
          label: TARGET_SLUG,
          sourceFile: `src/${TARGET_SLUG}`,
          meta: { depth: 2, fileCount: 1 },
        },
      ],
      edges: [{ source: 'module:src', target: `module:src/${TARGET_SLUG}`, relation: 'contains' }],
      mustReview: [],
    }),
  )
}

/**
 * Send the REAL broadcast from main, exactly as the `learn:generateFeatureView`
 * handler does — same channel, same payload shape. Sending it from the renderer
 * would prove only that a callback runs; this proves the channel is bridged and
 * that something on the board is listening to it.
 */
async function broadcastFeatureLearned(app: ElectronApplication, rootPath: string): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('learn:featureLearned', payload)
      }
    },
    { rootId: rootPath, featureRef: `feature:${TARGET_SLUG}`, learnings: LEARNINGS.length },
  )
}

/** The learn-dot class currently drawn on the target feature's cell. */
async function dotClass(window: Page, name: string): Promise<string> {
  return window.evaluate((featureName) => {
    const glyphs = [...document.querySelectorAll<HTMLElement>('.fb-terr-cell')]
    const glyph = glyphs.find(
      (node) => node.querySelector('.fb-terr-cell-name')?.textContent?.trim() === featureName,
    )
    return glyph?.querySelector('.fb-learn-dot')?.getAttribute('class') ?? 'no-dot'
  }, name)
}

test.describe('learned prose reaches the board without a restart', () => {
  test('a feature learned mid-session flips its understanding dot', async ({ app, window }) => {
    // ── The pre-learn store: Chats exists and nobody has learned it. ────────
    const root = await seedProject(window, 'learned-refresh', (dir) => {
      for (const [slug, name] of SIBLINGS) writeCore(dir, slug, name)
      writeCore(dir, TARGET_SLUG, TARGET_NAME)
      writeCodeMap(dir)
    })
    await activateProject(window, root)
    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator('.flow-board-root')).toBeVisible()
    await expect(
      window.locator('.fb-terr-cell', { hasText: TARGET_NAME }).first(),
      'the seeded capabilities never reached the sheet — is the bundled CLI resolvable?',
    ).toBeVisible({ timeout: 120_000 })

    // Not vacuous: it really starts unlearned.
    await expect
      .poll(() => dotClass(window, TARGET_NAME), { timeout: 30_000 })
      .toContain('fb-learn-none')

    // ── The learnings land on disk, as the learn pass writes them. ──────────
    // Written BEFORE the broadcast, in that order, because the board re-reads
    // the store when the event arrives — an event that outran the write would
    // measure the same unlearned store the bug did.
    writeCore(root, TARGET_SLUG, TARGET_NAME, LEARNINGS)

    // ── The real broadcast, from main, over the real channel. ───────────────
    await broadcastFeatureLearned(app, root)

    // ── THE REPORT: the feature reads as learned, with nothing reloaded. ────
    await expect
      .poll(() => dotClass(window, TARGET_NAME), {
        timeout: 30_000,
        message:
          'the dot stayed unlearned after learn:featureLearned — the board is not following the prose half of the pass (this is the reported bug)',
      })
      .toContain('fb-learn-learned')

    // The reader was not moved: a refresh that bounced the board to some other
    // level would be its own bug.
    await expect(window.locator('.fb-terr-crumb')).toHaveCount(1)
  })

  test('the event is bridged to the renderer at all', async ({ window }) => {
    // The narrowest statement of the wire. `learn:featureParts` was broken by a
    // missing preload bridge; `learn:featureLearned` was bridged all along and
    // broken by a missing subscriber. Asserted separately so a future
    // regression in either half names itself.
    const bridged = await window.evaluate(
      () => typeof window.flow.learn.onFeatureLearned === 'function',
    )
    expect(bridged, 'preload does not expose onFeatureLearned — the channel is unreachable').toBe(
      true,
    )
  })
})
