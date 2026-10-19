import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { openFeatureViewByName } from './fixtures/territory'
import { waitForLinkedStructure } from './fixtures/linked-structure'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE TRIGGER EXISTS — the regression net for a whole feature being unreachable.
 *
 * `learn:generateFeatureView` shipped complete on every layer except the one
 * that matters: contract, preload, main handler, caged pass, validated write —
 * and `grep -rn generateFeatureView app/src/renderer` returned NOTHING. Every
 * unit test passed. Six curated views existed in the world, all of them written
 * by the plan execution that built the pass, and thirty-four features had no way
 * to get one.
 *
 * No unit suite can catch that, ever: app jest runs `testEnvironment: 'node'`,
 * and "is this control reachable in the running app" is not a question the DOM-
 * less suite can ask. So every assertion here is about the LIVE window.
 *
 * NOTHING HERE SPENDS MODEL TIME. The feature it presses has no readable files,
 * so `runFeatureViewPass` refuses before opening a session — which is also the
 * point of the last third of this test: that refusal has to reach the screen.
 */

test.afterAll(() => cleanupSeeds())

const FEATURES: Array<[slug: string, name: string, anchors: string[]]> = [
  // Anchors that resolve ⇒ the DERIVED level, where the action lives in the bar.
  ['ingest-pipeline', 'Ingest Pipeline', ['module:src/ingest']],
  // No anchors ⇒ the EMPTY level, where the action lives in the band.
  ['billing-engine', 'Billing Engine', []],
  // Already drawn ⇒ the action must not appear at all.
  ['drawn-already', 'Drawn Already', ['module:src/ingest']],
]

/** A valid curated artifact — the hidden-when-curated case needs a real one. */
function seedCuratedView(structure: string): void {
  // `feature-views/` is a GENERATED sync class: seeded before the project joins
  // its Workspace it is dropped by the migration's copy, so this runs after.
  const viewDir = join(structure, 'feature-views')
  mkdirSync(viewDir, { recursive: true })
  writeFileSync(
    join(viewDir, 'drawn-already.json'),
    JSON.stringify({
      feature: 'drawn-already',
      provenance: 'code',
      generatedAt: '2026-08-08',
      meta: { title: 'Drawn Already', sub: 'seeded by the reachability probe' },
      brief: {},
      views: {
        root: {
          title: 'Drawn Already',
          kicker: 'Level 0 · seeded curated view',
          summary: 'A curated view already exists here, so nothing may offer to draw one.',
          nodes: [
            { id: 'reader', kind: 'module', title: 'Ingest Reader', delta: 'stable' },
            { id: 'writer', kind: 'module', title: 'Ingest Writer', delta: 'stable' },
          ],
          edges: [{ from: 'reader', to: 'writer', label: 'parsed rows', delta: 'kept' }],
        },
      },
    }),
  )
}

function seed(dir: string): void {
  mkdirSync(join(dir, 'src', 'ingest'), { recursive: true })
  writeFileSync(join(dir, 'src', 'ingest', 'reader.ts'), 'export const read = (): number => 1\n')
  writeFileSync(join(dir, 'src', 'ingest', 'writer.ts'), 'export const write = (): number => 2\n')
  const featureDir = join(dir, 'flow', 'brain', 'features')
  mkdirSync(featureDir, { recursive: true })
  for (const [slug, name, anchors] of FEATURES) {
    writeFileSync(
      join(featureDir, `${slug}.md`),
      [
        '---',
        `id: feature:${slug}`,
        `name: ${name}`,
        'kind: core',
        // UNQUOTED on purpose: `parseList` splits on commas and keeps quotes,
        // so `["module:x"]` yields an anchor that never resolves.
        `anchors: [${anchors.join(', ')}]`,
        'relates: []',
        'lastFullRead: null',
        'patchCount: 0',
        '---',
        '',
        `# ${name}`,
        '',
        'Seeded by the generate-feature-view reachability probe.',
        // A PART, so the feature has a level to dive into — its feature view's
        // door is that level's title control (a part-less feature reads as its
        // code story instead, cell-hover-diagram FR-6).
        '',
        '## Parts',
        '',
        '### Core',
        `The core of ${name}.`,
        '',
      ].join('\n'),
    )
  }
}

interface Seen {
  present: boolean
  label: string
  title: string
  ariaBusy: string | null
  disabled: boolean | null
  tabbable: boolean | null
  running: boolean
  host: string
  failure: string | null
}

test('a feature with no curated view can be drawn — and says so when it cannot', async ({
  window,
}) => {
  test.setTimeout(240_000)
  const root = await seedProject(window, 'flow-gen-view-', seed)
  await activateProject(window, root)
  seedCuratedView(await waitForLinkedStructure(window, root))
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  await expect(window.locator('.fb-terr-cell').first()).toBeVisible({ timeout: 120_000 })
  await window.waitForTimeout(800)

  const seeAction = async (): Promise<Seen> =>
    window.evaluate(() => {
      const draw = document.querySelector<HTMLButtonElement>('.fb-brief-draw')
      const failed = document.querySelector('.fb-brief-draw-failed')
      return {
        present: draw !== null,
        label: draw?.textContent ?? '',
        title: draw?.title ?? '',
        ariaBusy: draw?.getAttribute('aria-busy') ?? null,
        disabled: draw?.disabled ?? null,
        tabbable: draw === null ? null : draw.tabIndex >= 0,
        running: draw?.classList.contains('fb-brief-draw-running') ?? false,
        // The level's own actions sit in the board header's slot now
        // (`.fb-brief-headactions`); 'brief-bar' names that place.
        host: draw?.closest('.fb-brief-band') !== null ? 'empty-band' : 'brief-bar',
        failure: failed?.textContent ?? null,
      }
    })

  /** Open one feature's view BY NAME — the sheet's order is not this test's business. */
  const openLevel = async (name: string): Promise<void> => {
    await openFeatureViewByName(window, name)
    await expect(window.locator('.fb-brief-draw').first()).toBeVisible({ timeout: 60_000 })
    await window.waitForTimeout(600)
  }

  // ── THE DERIVED LEVEL — the case the whole feature is about. ──
  await openLevel('Ingest Pipeline')
  const derived = await seeAction()
  expect(derived.present, 'no way to draw a feature whose level is DERIVED').toBe(true)
  expect(derived.host, 'the action is not in the level it belongs to').toBe('brief-bar')
  expect(derived.title, 'the action does not say what it will read').toContain('1 module')
  expect(derived.title, 'the action does not say what it costs').toContain('several minutes')
  expect(derived.tabbable, 'the action is not a tab stop').toBe(true)
  // ONE CONTROL. This bar carried `Learn this feature (N)` beside `Draw this
  // feature` — two ten-minute passes over the same files, differing only in
  // which internal store they wrote. One button, and it writes both.
  expect(derived.label, 'the action is still named after the store it writes').toBe(
    'Understand this feature',
  )
  const barButtons = await window.evaluate(() =>
    [...(document.querySelector('.fb-brief-headactions')?.querySelectorAll('button') ?? [])].map(
      (b) => b.textContent ?? '',
    ),
  )
  expect(barButtons, 'the retired pair is still on the bar').not.toContain('Learn this feature')
  expect(
    barButtons.filter((l) => l === 'Understand this feature'),
    'more than one slow-pass control on one bar',
  ).toHaveLength(1)

  // ── THE CURATED LEVEL — OFFERED, as a RE-RUN. ──
  //
  // This assertion used to read "never offered, the picture is already there",
  // guarding the rule that a finished surface must not become a control panel.
  // THE RULE CHANGED, for a measured reason (#1435): 6 of 29 code excerpts
  // across this machine's six PASSING curated views cite lines that no longer
  // match, within four days of being drawn — one cites a line that no longer
  // exists at all, so the drawer shows deleted code as current evidence. A
  // drawn feature now reports `learned`, so with no door here the sequence was
  // drawn → learned → drifted → `stale` → nothing to press.
  //
  // What the rule becomes: offered, but never wearing the first-read wording,
  // because a reader looking at a picture reads "Understand this feature" as a
  // button that does nothing.
  await openLevel('Drawn Already')
  const curated = await seeAction()
  console.log(`[measured] curated level action: ${JSON.stringify(curated)}`)
  expect(curated.present, 'a curated feature has no way to redraw a stale picture').toBe(true)
  expect(curated.label, 'the re-run wears the first-read wording').not.toBe(
    'Understand this feature',
  )
  expect(curated.label).toBe('Understand it again')
  expect(curated.title, 'the re-run does not say it replaces the current drawing').toMatch(
    /replace the drawing that is there now/,
  )
  expect(curated.title, 'the re-run does not say the previous drawing survives').toContain(
    '.prev.json',
  )
  expect(curated.title).toContain('several minutes')
  expect(curated.host, 'the re-run is not on the bar of the level it redraws').toBe('brief-bar')
  expect(curated.tabbable, 'the re-run is not a tab stop').toBe(true)
  // AND STILL EXACTLY ONE slow-pass control — the pair does not come back in
  // through the door that was just reopened.
  const curatedBar = await window.evaluate(() =>
    [...(document.querySelector('.fb-brief-headactions')?.querySelectorAll('button') ?? [])].map(
      (b) => b.textContent ?? '',
    ),
  )
  expect(curatedBar).not.toContain('Learn this feature')
  expect(curatedBar).not.toContain('Draw this feature')
  expect(curatedBar.filter((l) => l === 'Understand it again')).toHaveLength(1)

  // ── THE EMPTY LEVEL — same gap, so the same way out, in the band. ──
  await openLevel('Billing Engine')
  const empty = await seeAction()
  expect(empty.present, 'no way to draw a feature whose level is EMPTY').toBe(true)
  expect(empty.host, 'the empty level’s action is not on the band that named the absence').toBe(
    'empty-band',
  )

  // ── KEYBOARD ONLY. This is the only door; a mouse must not be required. ──
  await window.evaluate(() => document.querySelector<HTMLButtonElement>('.fb-brief-draw')?.focus())
  expect(
    await window.evaluate(
      () => document.activeElement?.classList.contains('fb-brief-draw') ?? false,
    ),
    'the action cannot take keyboard focus',
  ).toBe(true)

  // The running state can end within a frame here (this feature has nothing to
  // read), so watch for it rather than sampling once — "too quick to catch" is
  // not the same claim as "never shown".
  const sawRunning = window
    .waitForFunction(
      () =>
        document.querySelector('.fb-brief-draw')?.classList.contains('fb-brief-draw-running') ??
        false,
      undefined,
      { timeout: 15_000, polling: 16 },
    )
    .then(() => true)
    .catch(() => false)
  await window.keyboard.press('Enter')
  expect(await sawRunning, 'pressing the action showed no running state at all').toBe(true)
  await window.screenshot({ path: '/tmp/one-button-running.png' })

  // ── AND THE FAILURE REACHES THE SCREEN. A fire-and-forget call whose only
  //    failure mode is "nothing happens" is the bug this replaced. ──
  const failure = await window
    .waitForFunction(
      () => document.querySelector('.fb-brief-draw-failed')?.textContent ?? null,
      undefined,
      { timeout: 120_000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null)
  await window.screenshot({ path: '/tmp/one-button-failed.png' })
  expect(failure, 'the drawing failed silently — no reason anywhere on the level').not.toBeNull()
  expect(String(failure)).toContain('Billing Engine')
  // The running state ENDED with it — a spinner with no exit is the same bug.
  expect((await seeAction()).running, 'the running state outlived the failure').toBe(false)
})
