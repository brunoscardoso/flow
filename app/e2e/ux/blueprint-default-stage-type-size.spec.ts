import { test, expect } from '../fixtures/electron'
import type { Page } from '@playwright/test'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { diveIntoCell } from './fixtures/territory'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * HOW BIG IS THE TYPE, ON THE STAGE THE APP ACTUALLY OPENS WITH?
 *
 * The retired ring was one SVG figure fitted into whatever stage it was given,
 * and every label's `font-size: 11px` was in USER units — so the fit scaled the
 * TEXT down with the geometry. A short stage did not crop the ring: it shrank
 * the names, to 4.0px on this app's own default layout (#1493).
 *
 * TERRITORY REMOVED THE MULTIPLIER, IT DID NOT REMOVE THE QUESTION. A cell's
 * name is ordinary HTML at its declared size, and the sheet is packed into the
 * measured stage rather than scaled into it — so nothing shrinks the type. What
 * a short stage does instead is give each cell a SMALLER RECTANGLE, and
 * `cellLabelClass` answers that by dropping the name to a smaller tier and
 * eventually hiding it (the tooltip and the accessible name survive every
 * tier). This probe is what says the printed tiers stay readable.
 *
 * WHAT IS MEASURED
 * ================
 * The rendered cap height of each PRINTED cell name
 * (`getBoundingClientRect().height` on the real element) in the app's DEFAULT
 * layout — the window size the app opens at (1440×900) with the panels it opens
 * with, nothing hidden and nothing resized. Then the same board with the bottom
 * panel put away, which isolates the stage-height cause.
 *
 * THE FLOOR: 8px. Not a taste call — it is well below every other type size in
 * this app (the smallest is the 9.5px kicker) and below any platform minimum;
 * 11px is the board's own intent. A label under 8px is not small, it is gone.
 */

test.afterAll(() => cleanupSeeds())

/** Level-mates, so the root level is an ordinary one and the dive is real. */
const SIBLINGS: Array<[slug: string, name: string]> = [
  ['agents', 'Agents'],
  ['connectors', 'Connectors'],
  ['automations', 'Automations'],
]

const PARENT_SLUG = 'chats'
const PARENT_NAME = 'Chats'

/** Ten parts, sized the way a real store's are: names of very different
 *  lengths, which is what decides whether this board can print them. */
const PARTS: Array<[name: string, summary: string]> = [
  ['Chat UI', 'The per-chat conversation surface at /chats/[id].'],
  ['Chat SDK client', 'The streaming client wired to the chat transport.'],
  ['Message renderer', 'Turns the streamed message parts into the visible timeline.'],
  ['Chats list', 'The /chats index: lists, searches, opens, renames and deletes.'],
  ['Gateway BFF stream', 'The heart of a turn.'],
  ['SSE events endpoint', 'A long-lived SSE connection multiplexing live tokens.'],
  ['Agent core engine', 'The agent backend.'],
  ['History store', 'Rows in the relational store.'],
  ['Queue stream bus', 'The pub/sub backbone for live delivery.'],
  ['Chat control API', 'Stop, retry and cancel control for an in-flight turn.'],
]

/** The smallest type this board may render a name at and still have rendered it. */
const MIN_READABLE_PX = 8

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
            `anchors: src/${slug}/${partName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ts`,
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
      'Seeded by the default-stage type-size probe.',
      '',
      ...partSection,
    ].join('\n'),
  )
}

interface TypeMeasurement {
  nodeCount: number
  viewport: { width: number; height: number }
  sheet: { width: number; height: number } | null
  /** Declared `font-size` in user units (the board's intent). */
  declaredFontPx: number | null
  labels: Array<{
    text: string
    height: number
    width: number
    opacity: number
  }>
  /** Tallest rendered label — the best case on this stage. */
  maxHeight: number
  /** Is the bottom (terminal) panel taking stage height right now? */
  bottomPanelHeight: number
}

async function measureType(window: Page): Promise<TypeMeasurement> {
  return window.evaluate(() => {
    const sheetEl = document.querySelector('.fb-terr-sheet')
    const sheetRect = sheetEl?.getBoundingClientRect() ?? null
    // PRINTED names only. A cell whose rectangle could not hold one draws none
    // (`cellLabelClass`), and a zero-height box is not a small label — it is a
    // name that was deliberately withheld and kept in the tooltip.
    const labelEls = [...document.querySelectorAll<HTMLElement>('.fb-terr-cell-name')].filter(
      (el) => el.getBoundingClientRect().height > 0,
    )
    const labels = labelEls.map((el) => {
      const rect = el.getBoundingClientRect()
      return {
        text: el.textContent ?? '',
        height: rect.height,
        width: rect.width,
        opacity: Number.parseFloat(getComputedStyle(el).opacity || '1'),
      }
    })
    const declared =
      labelEls.length === 0
        ? null
        : Number.parseFloat(getComputedStyle(labelEls[0]).fontSize.replace('px', ''))
    const bottom = document.querySelector('#fl-panel-terminal')
    const bottomRect = bottom === null ? null : bottom.getBoundingClientRect()
    return {
      nodeCount: document.querySelectorAll('.fb-terr-cell').length,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      sheet: sheetRect === null ? null : { width: sheetRect.width, height: sheetRect.height },
      declaredFontPx: declared,
      labels,
      maxHeight: labels.reduce((max, l) => Math.max(max, l.height), 0),
      bottomPanelHeight: bottomRect === null ? 0 : bottomRect.height,
    }
  })
}

function report(title: string, m: TypeMeasurement): void {
  const lines = [
    `\n── ${title} ──────────────────────────────────────`,
    `viewport ${m.viewport.width}×${m.viewport.height}   sheet ${
      m.sheet === null ? 'MISSING' : `${Math.round(m.sheet.width)}×${Math.round(m.sheet.height)}`
    }   bottom panel ${Math.round(m.bottomPanelHeight)}px tall`,
    `cells ${m.nodeCount}   declared font-size ${m.declaredFontPx ?? '?'}px`,
    `RENDERED label height: max ${m.maxHeight.toFixed(1)}px  (floor for "readable" = ${MIN_READABLE_PX}px)`,
    '',
    'label                          rendered w × h    opacity',
  ]
  for (const l of m.labels) {
    lines.push(
      `${l.text.padEnd(30)} ${l.width.toFixed(1).padStart(6)} × ${l.height
        .toFixed(1)
        .padStart(4)}      ${l.opacity.toFixed(2)}`,
    )
  }
  // eslint-disable-next-line no-console -- the measurement IS the deliverable
  console.log(lines.join('\n'))
}

/** Seed, activate, open the Blueprint. Nothing is resized or put away. */
async function openBoard(window: Page, prefix: string): Promise<void> {
  const root = await seedProject(window, prefix, (dir) => {
    for (const [slug, name] of SIBLINGS) writeCore(dir, slug, name)
    writeCore(dir, PARENT_SLUG, PARENT_NAME, PARTS)
  })
  await activateProject(window, root)
  // The per-project flow-settings overlay auto-opens on first activation and
  // intercepts every click. `activateProject` presses Escape once within 1.5s;
  // on a slow first provision it can land later than that, so retry until the
  // shell is actually clickable (this is harness hygiene, not a finding).
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await window.locator('.fl-settings-overlay:not([hidden])').count()) === 0) break
    await window.keyboard.press('Escape')
    await window.waitForTimeout(500)
  }
  await expect(window.locator('.fl-settings-overlay:not([hidden])')).toHaveCount(0)
  // A freshly attached root is provisioned by a fire-and-forget background
  // write, and the board says "Setting up plan-flow…" until it lands — on a
  // loaded machine that can take minutes. Wait for the sidebar to stop saying
  // "setting up…" BEFORE opening the board, so a slow provision reads as a slow
  // provision instead of an empty sheet.
  await expect(
    window.locator('.fl-thread-sidebar', { hasText: 'setting up…' }),
    'the project never finished provisioning',
  ).toHaveCount(0, { timeout: 240_000 })
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  await expect(
    window.locator('.fb-terr-cell', { hasText: PARENT_NAME }).first(),
    'the seeded capabilities never reached the sheet — is planflow-ai resolvable?',
  ).toBeVisible({ timeout: 180_000 })
  await expect(window.locator('.fb-terr-cell')).toHaveCount(SIBLINGS.length + 1, {
    timeout: 30_000,
  })
  await window.waitForTimeout(1200)
}

/** Dive into the parent's PARTS. A first press OPENS a cell in place now and
 *  the next goes in (5dd9bf03), so this presses the way a person does. */
async function divetoParts(window: Page): Promise<void> {
  await diveIntoCell(window, PARENT_NAME)
  await expect(window.locator('.fb-terr-cell'), 'the dive never happened').toHaveCount(
    PARTS.length,
    { timeout: 30_000 },
  )
  await window.waitForTimeout(1400)
}

/**
 * THE FILED BUG (#1493), and what settled it.
 *
 * MEASURED on the ring, twice, identical both runs:
 *
 *   state (same 1440×900 window, same ring)   pane      fit scale   name height
 *   root ring, 4 features                     778×348      0.297        4.5px
 *   part ring, 10 parts                       778×348      0.253        4.0px
 *   part ring, zoomed to the camera's clamp    778×348      0.506        7.0px
 *   part ring, bottom panel put away          778×769      0.928       13.5px
 *
 * `MAX_SCALE = 2` (camera.ts) was why the third row was the ceiling: no zoom
 * the app offered reached 8px on that stage.
 *
 * TERRITORY SETTLED IT BY REMOVING THE MULTIPLIER. There is no fit and no
 * camera on the feature map — a name is HTML at its declared size, and a cell
 * too small for one drops a tier rather than shrinking the type. The assertion
 * below is unchanged in meaning: whatever the sheet PRINTS, it prints readably.
 */
test('the type on the DEFAULT stage — root level and part level, measured', async ({
  window,
}) => {
  test.setTimeout(360_000)
  await openBoard(window, 'flow-ux-type-default-')

  const root = await measureType(window)
  report('ROOT LEVEL — app default layout, nothing touched', root)
  await window.screenshot({
    path: 'e2e/ux/__screens/bp-type-default-root.png',
  })

  await divetoParts(window)
  const parts = await measureType(window)
  report('PART LEVEL (10 parts) — app default layout, nothing touched', parts)
  await window.screenshot({
    path: 'e2e/ux/__screens/bp-type-default-parts.png',
  })

  expect(root.nodeCount, 'the root level lost its cells').toBe(SIBLINGS.length + 1)
  expect(parts.nodeCount, 'the part level lost its cells').toBe(PARTS.length)

  // THE VERDICT. A name rendered under 8px tall has not been rendered.
  expect(
    root.maxHeight,
    `root-level names render ${root.maxHeight.toFixed(1)}px tall on the stage the app opens ` +
      `with (declared ${root.declaredFontPx}px)`,
  ).toBeGreaterThanOrEqual(MIN_READABLE_PX)
  expect(
    parts.maxHeight,
    `part names render ${parts.maxHeight.toFixed(1)}px tall on the stage the app opens with ` +
      `(declared ${parts.declaredFontPx}px)`,
  ).toBeGreaterThanOrEqual(MIN_READABLE_PX)
})

/**
 * THE GREEN GUARD, and the cause of #1493 in one measurement.
 *
 * It asserts the property that is TRUE today and must survive any change: on a
 * full-height stage the sheet's names render at a readable size. The default
 * stage's numbers are printed beside them, so a reader of a failing run sees
 * both — but only the tall-stage claim is asserted, because Territory
 * (correctly) flattened the delta between the two.
 */
test('the same level, with the bottom panel put away, renders readable names', async ({
  window,
}) => {
  test.setTimeout(360_000)
  await openBoard(window, 'flow-ux-type-nobottom-')
  await divetoParts(window)

  const before = await measureType(window)
  report('PART LEVEL — default layout (bottom panel up)', before)

  // Put the bottom panel away the way a user does (⌃`), then re-measure the
  // identical level. Nothing else changes, so the delta IS the panel's cost.
  await window.keyboard.press('Control+`')
  await window.waitForTimeout(1800)
  const after = await measureType(window)
  report('PART LEVEL — bottom panel put away', after)

  // A screenshot pair, so the difference is visible and not only numeric.
  await window.screenshot({
    path: 'e2e/ux/__screens/bp-type-no-bottom-panel.png',
  })

  expect(after.nodeCount, 'putting the panel away changed the level').toBe(before.nodeCount)
  expect(
    after.bottomPanelHeight,
    'the bottom panel never went away — ⌃` did not reach the shell',
  ).toBeLessThan(before.bottomPanelHeight)
  // THE GUARD. Ten real part names on a full-height stage must be rendered at a
  // size a person can read. Measured 13.5px on current main; anything that drags
  // this under 8px has taken the level's names away, whatever else it fixed.
  expect(
    after.maxHeight,
    `part names render ${after.maxHeight.toFixed(1)}px tall on a full-height stage ` +
      `(declared ${after.declaredFontPx}px); ` +
      `on the app's DEFAULT stage the same level measured ${before.maxHeight.toFixed(1)}px — see #1493`,
  ).toBeGreaterThanOrEqual(MIN_READABLE_PX)
})
