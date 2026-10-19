import { test, expect } from '../fixtures/electron'
import type { Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * "AFTER THE LEARNING OF A FEATURE, WE ARE NOT SHOWING THE NODES — ONLY IF I
 * FORCE REFRESH, QUIT AND OPEN AGAIN." — reported 2026-08-10, against a board
 * sitting on Skills with the toast "Feature view — Skills: 8 component(s) · 7
 * learning(s)" already delivered and the level still reading "no parts have
 * been learned".
 *
 * WHY THE BOARD READ AN EMPTY STORE AND WAS RIGHT TO
 * ==================================================
 * An understand pass is TWO steps (`understandFeature` in main):
 *
 *     const drawn = await drawFeatureView(request)   // broadcasts learn:featureViewed
 *     if (!drawn) return
 *     await learnFeatureParts(request)               // broadcasts learn:featureParts
 *
 * The board ended its running indicator on `learn:featureViewed` and re-fetched
 * the feature graph there. That re-fetch was real, and its answer was correctly
 * empty — the viewed event fires BETWEEN the two steps, at the one moment a
 * feature's parts are guaranteed not to be on disk yet. The parts landed
 * minutes later with nothing listening.
 *
 * `learn:featureParts` had existed in the IPC contract the whole time and main
 * broadcast it from two sites. It was never bridged in the preload, so the
 * event could not physically reach the renderer. Restarting worked because a
 * fresh board fetches the graph at mount, by which time the step had finished.
 *
 * WHAT THIS SPEC DOES, AND WHY IT DOES IT THAT WAY
 * ================================================
 * It does not run a real understand pass — that is minutes of model time and a
 * network dependency, and it would test the model rather than the wire. It
 * reproduces the exact SEQUENCE instead: a feature with no parts on the ring,
 * then parts written to the store the way `writeParts` writes them, then the
 * real `learn:featureParts` broadcast sent from main over the real channel and
 * through the real preload bridge. Everything between main's `broadcast` and
 * the repainted ring is the production path.
 *
 * The assertion is deliberately "without reloading anything": no navigation, no
 * re-open, no `window.reload()`. That is the whole of what was reported.
 *
 * FALSIFIED (2026-08-10, this machine): removing the `onFeatureParts` line from
 * `app/src/preload/index.ts` and rebuilding turns the last expectation RED with
 * the ring still empty — reproducing the report exactly — while every other
 * test in this file stays green. Restored, all pass.
 */

test.afterAll(() => cleanupSeeds())

const SIBLINGS: Array<[slug: string, name: string]> = [
  ['agents', 'Agents'],
  ['connectors', 'Connectors'],
]

const TARGET_SLUG = 'chats'
const TARGET_NAME = 'Chats'

/** A small decomposition, with names of deliberately different lengths. */
const PARTS: Array<[name: string, summary: string]> = [
  ['Chat UI', 'The per-chat conversation surface at /chats/[id].'],
  ['Gateway BFF stream', 'The heart of a turn.'],
  ['SSE events endpoint', 'A long-lived SSE connection multiplexing live tokens.'],
  ['Queue stream bus', 'The pub/sub backbone for live delivery.'],
]

const PART_NAMES = PARTS.map(([name]) => name)

function partAnchor(partName: string): string {
  return `src/${TARGET_SLUG}/${partName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ts`
}

/**
 * The feature file. `parts` empty writes NO `## Parts` section at all — which is
 * the pre-learn state the report starts from, not a section that happens to be
 * empty.
 */
function writeCore(root: string, slug: string, name: string, parts: typeof PARTS = []): void {
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  const partSection =
    parts.length === 0
      ? []
      : [
          '## Parts',
          '',
          ...parts.flatMap(([partName, summary]) => [
            `### ${partName}`,
            summary,
            `anchors: ${partAnchor(partName)}`,
            '',
          ]),
        ]
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
      'Seeded by the parts-refresh regression guard.',
      '',
      ...partSection,
    ].join('\n'),
  )
}

/** A code map the feature's anchors resolve against, so its level renders at all. */
function writeCodeMap(root: string): void {
  const src = join(root, 'src', TARGET_SLUG)
  mkdirSync(src, { recursive: true })
  for (const [partName] of PARTS) {
    const file = partAnchor(partName).split('/').pop() ?? 'index.ts'
    writeFileSync(join(src, file), `export const seeded = ${JSON.stringify(partName)}\n`)
  }
  const structure = join(root, 'flow', 'brain', '.structure')
  mkdirSync(structure, { recursive: true })
  writeFileSync(
    join(structure, 'graph.json'),
    JSON.stringify({
      version: 1,
      derivedAt: '2026-08-10T00:00:00.000Z',
      coverage: {
        filesScanned: PARTS.length,
        filesTotal: PARTS.length,
        extractorsRun: ['modules'],
        graphifyEnriched: false,
      },
      nodes: [
        { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
        {
          id: `module:src/${TARGET_SLUG}`,
          kind: 'module',
          label: TARGET_SLUG,
          sourceFile: `src/${TARGET_SLUG}`,
          meta: { depth: 2, fileCount: PARTS.length },
        },
      ],
      edges: [{ source: 'module:src', target: `module:src/${TARGET_SLUG}`, relation: 'contains' }],
      mustReview: [],
    }),
  )
}

/**
 * Send the REAL broadcast from main, exactly as `learnFeatureParts` does — same
 * channel, same payload shape. Sending it from the renderer instead would prove
 * only that a callback runs; this proves the channel is bridged.
 */
async function broadcastFeatureParts(app: ElectronApplication, rootPath: string): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('learn:featureParts', payload)
      }
    },
    {
      rootId: rootPath,
      featureRef: `feature:${TARGET_SLUG}`,
      parts: PARTS.length,
      learned: PARTS.length,
    },
  )
}

/** Every part name currently drawn on the sheet. */
async function ringNames(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.fb-terr-cell')].flatMap((glyph) => {
      const label = glyph.querySelector<HTMLElement>('.fb-terr-cell-name')
      const text = label?.textContent?.trim() ?? ''
      return text.length > 0 ? [text] : []
    }),
  )
}

test.describe('a learned feature fills its level without a restart', () => {
  test('parts written mid-session appear on the open level', async ({ app, window }) => {
    // ── The pre-learn store: Chats exists, and has no parts. ────────────────
    const root = await seedProject(window, 'parts-refresh', (dir) => {
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

    // ── No parts yet: the cell is the last level, so GOING IN reads its story
    // (plan cell-hover-diagram, FR-6) — there is no empty level to sit on. A
    // single press only opens the cell in place now (5dd9bf03); a double-click
    // is the way in. ──
    const target = window.locator('.fb-terr-cell', { hasText: TARGET_NAME }).first()
    await target.dblclick()
    await expect(window.locator('.fb-story'), 'a feature with no parts reads as its story').toHaveCount(1, {
      timeout: 30_000,
    })
    await window.keyboard.press('Escape')
    await expect(window.locator('.fb-story')).toHaveCount(0)
    await expect(window.locator('.fb-terr-crumb')).toHaveCount(1)

    // ── The parts land on disk, as the learn pass writes them. ──────────────
    // Written BEFORE the broadcast, in that order, because the board re-reads
    // the store when the event arrives — an event that outran the write would
    // measure the same empty store the bug did.
    writeCore(root, TARGET_SLUG, TARGET_NAME, PARTS)

    // ── The real broadcast, from main, over the real channel. ───────────────
    await broadcastFeatureParts(app, root)

    // ── THE REPORT: the parts are there, with nothing reloaded — the same cell
    // now has a level below it, so the same press dives onto its parts. ─────
    await expect
      .poll(
        async () => {
          if ((await window.locator('.fb-story').count()) > 0) await window.keyboard.press('Escape')
          await target.dblclick({ timeout: 2_000 }).catch(() => undefined)
          await window.waitForTimeout(800)
          return ringNames(window)
        },
        {
          timeout: 30_000,
          message:
            'the feature still has no parts after learn:featureParts — the board is not following the parts half of the pass (this is the reported bug)',
        },
      )
      .toEqual(expect.arrayContaining(PART_NAMES))
    await expect(window.locator('.fb-terr-crumb')).toHaveCount(2)
  })

  test('the event is bridged to the renderer at all', async ({ window }) => {
    // The narrowest statement of the root cause. `learn:featureParts` was in the
    // IPC contract and broadcast by main for its whole life; the preload never
    // exposed it, so no renderer could subscribe. A missing bridge is invisible
    // to every unit test in this repo — nothing throws, the event simply goes
    // nowhere — so it is asserted directly.
    const bridged = await window.evaluate(
      () => typeof window.flow.learn.onFeatureParts === 'function',
    )
    expect(bridged, 'preload does not expose onFeatureParts — the channel is unreachable').toBe(
      true,
    )
  })
})
