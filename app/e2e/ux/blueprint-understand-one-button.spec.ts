import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { openFeatureViewByName } from './fixtures/territory'
import { waitForLinkedStructure } from './fixtures/linked-structure'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ONE BUTTON, AND A DOT THAT TELLS THE TRUTH ABOUT WHY.
 *
 * The question that produced this: "why do we have a button to learn and
 * another to draw?" There was no answer — the two read the same ranked files in
 * the same cage for the same several minutes, and differed only in which
 * internal store came out. The board then compounded it: drawing a feature did
 * NOT light its understanding dot, because `understandingOf` read only the
 * `## Learned` section. The richest artifact the system can produce left a
 * feature looking unexamined.
 *
 * Both halves are measured here, in the LIVE window:
 *  - the Learn/Draw pair is gone from every surface that rendered it
 *  - a VALID curated view lights the dot with no `## Learned` anywhere
 *  - an INVALID one does NOT — the `d5ae3b83` guard. That commit removed a lie
 *    where module learning made features report `learned`; counting a broken
 *    file would be the same lie wearing a different hat.
 *  - a feature that IS drawn still has a door, worded as a re-run — because a
 *    drawing that passed the validator four days ago is not a drawing that is
 *    still true (#1435).
 *
 * NOTHING HERE SPENDS MODEL TIME. Every artifact is seeded; nothing is pressed
 * that opens a session.
 */

test.afterAll(() => cleanupSeeds())

const SHOT = '/tmp'

/** A view that PASSES `validateFeatureView`. */
function validView(slug: string, title: string): Record<string, unknown> {
  return {
    feature: slug,
    provenance: 'code',
    generatedAt: '2026-08-09',
    meta: { title },
    brief: {},
    views: {
      root: {
        title,
        kicker: 'Level 0 · seeded by the one-button probe',
        summary: 'Seeded so the board has a valid drawing and no prose at all.',
        nodes: [
          { id: 'reader', kind: 'module', title: 'Ingest Reader', delta: 'stable' },
          { id: 'writer', kind: 'module', title: 'Ingest Writer', delta: 'stable' },
        ],
        edges: [{ from: 'reader', to: 'writer', label: 'parsed rows', delta: 'kept' }],
      },
    },
  }
}

/** `parts` gives a feature a level below it — the only way to its feature
 *  view now (a part-less feature reads as its code story). */
function writeFeature(dir: string, slug: string, name: string, anchors: string[], parts: string[] = []): void {
  const featureDir = join(dir, 'flow', 'brain', 'features')
  mkdirSync(featureDir, { recursive: true })
  writeFileSync(
    join(featureDir, `${slug}.md`),
    [
      '---',
      `id: feature:${slug}`,
      `name: ${name}`,
      'kind: core',
      // UNQUOTED: `parseList` splits on commas and keeps quotes.
      `anchors: [${anchors.join(', ')}]`,
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${name}`,
      '',
      // NO `## Learned` SECTION ANYWHERE. Every lit dot below therefore comes
      // from the curated view and from nothing else.
      'Seeded by the one-button probe. There is no ## Learned section here.',
      ...(parts.length === 0 ? [] : ['', '## Parts', '', ...parts.flatMap((part) => [`### ${part}`, `The ${part}.`, ''])]),
    ].join('\n'),
  )
}

function seed(dir: string): void {
  mkdirSync(join(dir, 'src', 'ingest'), { recursive: true })
  writeFileSync(join(dir, 'src', 'ingest', 'reader.ts'), 'export const read = (): number => 1\n')

  // 1. A VALID view, no prose → must report `learned`.
  writeFeature(dir, 'drawn-only', 'Drawn Only', ['module:src/ingest'], ['Reader'])

  // 2. An INVALID view (an edge from a component that is not on the level — a
  //    line from nowhere, one of the validator's own refusals) → must report
  //    `none`. This is the guard: on disk is not the same as valid.
  writeFeature(dir, 'broken-drawing', 'Broken Drawing', ['module:src/ingest'])

  // 3. Nothing at all → the control appears here, exactly once.
  writeFeature(dir, 'nothing-known', 'Nothing Known', ['module:src/ingest'], ['Reader'])

  // 4. A VALID view over code that has DRIFTED → `stale`, and the re-run must
  //    say why. This is the state the reopened door exists for: 6 of 29
  //    excerpts across this machine's six PASSING views cite lines that no
  //    longer match, within four days of being drawn (#1435).
  mkdirSync(join(dir, 'src', 'drifted'), { recursive: true })
  writeFileSync(join(dir, 'src', 'drifted', 'engine.ts'), 'export const go = (): number => 3\n')
  writeFeature(dir, 'drifted-drawing', 'Drifted Drawing', ['module:src/drifted'], ['Engine'])
  // The module tier is where drift is detected — `understandingOf` reads this
  // store for the stale half, whichever artifact supplies the evidence.
  const structure = join(dir, 'flow', 'brain', '.structure')
  mkdirSync(structure, { recursive: true })
  writeFileSync(
    join(structure, 'learning-state.jsonl'),
    `${JSON.stringify({ module: 'src/drifted', status: 'stale' })}\n`,
  )
}

/**
 * The curated views — written once the project sits in its Workspace, because
 * `feature-views/` is a GENERATED sync class: the migration's copy drops
 * anything seeded there before the add.
 */
function seedViews(structure: string): void {
  const viewDir = join(structure, 'feature-views')
  mkdirSync(viewDir, { recursive: true })
  writeFileSync(join(viewDir, 'drawn-only.json'), JSON.stringify(validView('drawn-only', 'Drawn Only')))
  const broken = validView('broken-drawing', 'Broken Drawing')
  ;(broken.views as { root: { edges: unknown[] } }).root.edges = [
    { from: 'ghost', to: 'writer', label: 'parsed rows', delta: 'kept' },
  ]
  writeFileSync(join(viewDir, 'broken-drawing.json'), JSON.stringify(broken))
  writeFileSync(
    join(viewDir, 'drifted-drawing.json'),
    JSON.stringify(validView('drifted-drawing', 'Drifted Drawing')),
  )
}

/** The understanding class on a feature's corner dot, or null when it has none. */
async function dotOf(
  win: import('@playwright/test').Page,
  slug: string,
): Promise<string | null> {
  return win.evaluate((id: string) => {
    const cell = document.querySelector(`.fb-terr-cell[data-feature-id="feature:${id}"]`)
    const dot = cell?.querySelector('.fb-learn-dot')
    if (!dot) return null
    // The status class, not the dot's own `fb-learn-dot` (which comes first).
    return [...dot.classList].find((c) => c.startsWith('fb-learn-') && c !== 'fb-learn-dot') ?? null
  }, slug)
}

// The feature view's slow-pass control lives in the board HEADER's action slot
// (`.fb-brief-headactions`) since the brief's controls moved up out of the old
// brief bar; "the bar" below is that slot.
test('one control, and a curated view that lights the dot it earned', async ({ window }) => {
  test.setTimeout(240_000)
  const root = await seedProject(window, 'flow-one-button-', seed)
  await activateProject(window, root)
  seedViews(await waitForLinkedStructure(window, root))
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  await expect(window.locator('.fb-terr-cell').first()).toBeVisible({ timeout: 120_000 })
  await window.waitForTimeout(1200)

  // ── UNDERSTANDING, from the drawing alone ────────────────────────────────
  const drawn = await dotOf(window, 'drawn-only')
  const brokenDot = await dotOf(window, 'broken-drawing')
  const nothing = await dotOf(window, 'nothing-known')
  const drifted = await dotOf(window, 'drifted-drawing')
  await window.screenshot({ path: `${SHOT}/one-button-dots.png` })
  console.log(
    `[measured] dots: drawn-only=${String(drawn)} broken-drawing=${String(brokenDot)} ` +
      `nothing-known=${String(nothing)} drifted-drawing=${String(drifted)}`,
  )

  expect(
    drawn,
    'a feature with a VALID curated view and no ## Learned still reads as unexamined',
  ).toBe('fb-learn-learned')
  // THE d5ae3b83 GUARD. `d5ae3b83` removed a lie where MODULE learning made a
  // feature report `learned`. A curated view is the feature's OWN artifact, so
  // counting it is that rule applied — but only when it is VALID. An artifact
  // that merely exists on disk proves nothing, and this repo's own stored view
  // was dead for four days with three validator errors nobody ever saw.
  expect(brokenDot, 'a BROKEN drawing was counted as knowledge').toBe('fb-learn-none')
  expect(nothing, 'a feature with nothing claimed something').toBe('fb-learn-none')
  // A drawn feature whose code has moved is STALE, not `learned` — the same
  // rule for either artifact, because both halves come from one read of the
  // same files (and a view is the more code-bound of the two: it cites lines).
  expect(drifted, 'a drawn feature over drifted code still reads as current').toBe('fb-learn-stale')

  // ── ONE CONTROL, where two used to stand ─────────────────────────────────
  await openFeatureViewByName(window, 'Nothing Known')
  await expect(window.locator('.fb-brief-draw').first()).toBeVisible({ timeout: 60_000 })
  await window.waitForTimeout(800)

  const bar = await window.evaluate(() => {
    const buttons = [
      ...(document.querySelector('.fb-brief-headactions')?.querySelectorAll<HTMLButtonElement>('button') ??
        []),
    ]
    const slow = document.querySelector<HTMLButtonElement>('.fb-brief-draw')
    return {
      labels: buttons.map((b) => b.textContent ?? ''),
      slowLabel: slow?.textContent ?? null,
      slowTitle: slow?.title ?? null,
      ariaLabel: slow?.getAttribute('aria-label') ?? null,
    }
  })
  await window.screenshot({ path: `${SHOT}/one-button-derived.png` })
  console.log(`[measured] brief bar: ${JSON.stringify(bar)}`)

  expect(bar.slowLabel, 'the one control is missing or renamed').toBe('Understand this feature')
  expect(bar.labels, 'the retired Learn button is still here').not.toContain('Learn this feature')
  expect(bar.labels, 'the retired Draw button is still here').not.toContain('Draw this feature')
  expect(
    bar.labels.filter((l) => l.startsWith('Understand this feature')),
    'more than one slow-pass control on one bar',
  ).toHaveLength(1)
  // IT SAYS WHAT IT COSTS, before it is pressed, to a screen reader too.
  expect(bar.slowTitle).toMatch(/several minutes/)
  expect(bar.ariaLabel).toMatch(/several minutes/)

  // ── AND A DOOR WHERE THE WORK IS DONE, worded as a RE-RUN ────────────────
  //
  // Not "nothing here". A curated view rots: 6 of 29 excerpts across this
  // machine's six PASSING views cite lines that no longer match, within four
  // days of being drawn (#1435). A drawn feature reports `learned`, so a board
  // with no door here goes drawn → learned → drifted → `stale` → nothing to
  // press. What must NOT happen is the first-read wording on a level that
  // already shows a picture, which reads as a button that does nothing.
  await openFeatureViewByName(window, 'Drawn Only')
  await expect(window.locator('.fb-brief-draw').first()).toBeVisible({ timeout: 60_000 })
  await window.waitForTimeout(800)
  await window.screenshot({ path: `${SHOT}/one-button-curated.png` })
  await window.screenshot({ path: `${SHOT}/one-button-rerun.png` })
  const curated = await window.evaluate(() => {
    const slow = document.querySelector<HTMLButtonElement>('.fb-brief-draw')
    return {
      present: slow !== null,
      label: slow?.textContent ?? null,
      title: slow?.title ?? null,
      disabled: slow?.disabled ?? null,
      labels: [
        ...(document.querySelector('.fb-brief-headactions')?.querySelectorAll('button') ?? []),
      ].map((b) => b.textContent ?? ''),
    }
  })
  console.log(`[measured] curated bar: ${JSON.stringify(curated)}`)
  expect(curated.present, 'a drawn feature has no way to redraw a stale picture').toBe(true)
  expect(curated.label).toBe('Understand it again')
  expect(curated.disabled).toBe(false)
  expect(curated.title, 'the re-run hides that it overwrites').toMatch(
    /replace the drawing that is there now/,
  )
  expect(curated.title, 'the re-run does not say the previous drawing survives').toContain(
    '.prev.json',
  )
  // STILL ONE CONTROL. The reopened door must not let the pair back in.
  expect(curated.labels).not.toContain('Learn this feature')
  expect(curated.labels).not.toContain('Draw this feature')
  expect(curated.labels).not.toContain('Understand this feature')
  expect(curated.labels.filter((l) => l === 'Understand it again')).toHaveLength(1)
  // NOT STALE ⇒ the control is there and does not argue for itself.
  expect(curated.title).not.toMatch(/drifted/)

  // ── AND WHEN IT IS STALE, IT SAYS WHY ────────────────────────────────────
  //
  // The board already knows the code has moved. Withholding that leaves the
  // reader guessing whether a re-run is worth ten minutes — and it is the only
  // argument this control will ever have.
  await openFeatureViewByName(window, 'Drifted Drawing')
  await expect(window.locator('.fb-brief-draw').first()).toBeVisible({ timeout: 60_000 })
  await window.waitForTimeout(800)
  await window.screenshot({ path: `${SHOT}/one-button-rerun-stale.png` })
  const stale = await window.evaluate(() => {
    const slow = document.querySelector<HTMLButtonElement>('.fb-brief-draw')
    return { label: slow?.textContent ?? null, title: slow?.title ?? null }
  })
  console.log(`[measured] stale curated bar: ${JSON.stringify(stale)}`)
  expect(stale.label).toBe('Understand it again')
  expect(stale.title, 'a stale drawing does not say why it is worth redrawing').toMatch(
    /code has drifted since this was drawn/,
  )
  expect(stale.title).toMatch(/may no longer be true/)
  expect(stale.title).toContain('.prev.json')
})
