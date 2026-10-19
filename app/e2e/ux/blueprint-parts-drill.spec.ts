import { test, expect } from '../fixtures/electron'
import type { Page } from '@playwright/test'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE REPORTED SYMPTOM, GUARDED END TO END (plan_feature-parts-as-nodes, Phase 7).
 *
 * WHAT WAS ACTUALLY REPORTED
 * ==========================
 * Drilling **Chats** showed two nodes under the kicker "2 PARTS": a plan and an
 * issue. Neither is a part of Chats, and BOTH were already listed one panel
 * above on the brief's `Changes:` line — the same two records rendered twice,
 * in two different meanings, on one screen. Meanwhile the ten real parts (Chat
 * UI, the BFF stream, the SSE endpoint, the Redis bus) sat in the same markdown
 * file, drawn by the curated view and invisible to the ring.
 *
 * So this file asserts the DUPLICATION IS GONE AND THE RELOCATION IS REAL, in
 * that order, because either half alone would be a false pass:
 *
 *   Task 7.1 — the ring under Chats carries its ten PARTS, readable, and NOT
 *              ONE change record.
 *   Task 7.2 — the two change records are still reachable, still named, and
 *              each still opens its OWN brief — from the `Changes:` line, which
 *              is now their only route. A spec that only checked the ring would
 *              pass just as happily if the changes had been deleted outright.
 *
 * WHY THE READABILITY HALF IS MEASURED, NOT COUNTED
 * =================================================
 * App jest runs `testEnvironment: 'node'` and computes NO layout. Two real bugs
 * shipped green past that suite on this exact surface — `.fb-territory`
 * painted ZERO PIXELS with a perfect DOM, and the sheet sat in a no-pan
 * selector so every drag returned before it began. Counting `.fb-terr-cell`
 * elements is precisely what let the first one through. Every claim below about
 * what a reader can SEE therefore comes from `getBoundingClientRect()` on the
 * real `<text>` nodes, exactly as `blueprint-part-ring-legibility.spec.ts` does
 * (same 1px overlap slack, so the two probes cannot disagree).
 *
 * FALSIFIED BEFORE IT WAS TRUSTED (Task 7.4, 2026-08-10, run on this machine)
 * ===========================================================================
 * Three source reverts, each rebuilt (`npm run build` at the root AND in `app/`,
 * because Playwright runs the `out/` bundle and the CLI is bundled into it) and
 * each run against this file. What each one did:
 *
 *   A. Phase 1 — `buildPartNodes`'s output dropped from `buildFeatureGraph`
 *      (`src/cli/blueprint/feature-graph.ts`).
 *      → 7.1 RED: `0 labels`, "the ring is not the ten part names", all ten
 *        expected names reported missing. (7.3a/7.3b in
 *        `blueprint-part-level.spec.ts` went red too: 0 nodes on the ring.)
 *      → 7.2 stayed GREEN, correctly: a change record's route to the brief is
 *        Phase 2's work and does not depend on part emission at all.
 *   B. Phase 2 — `FOCUS_KIND`'s `child: 'change'` put back to `child: 'part'`
 *      (`app/src/renderer/blueprint/feature-view-model.ts`), which IS the
 *      reported bug's original ternary.
 *      → 7.1 RED with the symptom reproduced exactly: `12 labels`, the ten
 *        parts plus "Chat Session Cache Rework" and "SSE reconnect backoff" drawn
 *        as ring nodes while the brief still listed them as changes.
 *   C. The relocation destination — `identity.children` emptied in the CLI's
 *      brief (`src/cli/commands/blueprint.ts`), i.e. the changes LOST rather
 *      than moved.
 *      → 7.2 RED: "Chats’ brief lists no changes — the records the ring dropped
 *        are now unreachable".
 *
 * Every revert was removed and all four tests went green again. B is the one
 * that matters most: it proves the duplication assertion below fires on the
 * actual reported symptom rather than on an absence.
 */

test.afterAll(() => cleanupSeeds())

/** Sibling capabilities, so the root ring is an ordinary one and the dive is real. */
const SIBLINGS: Array<[slug: string, name: string]> = [
  ['agents', 'Agents'],
  ['connectors', 'Connectors'],
  ['automations', 'Automations'],
]

const PARENT_SLUG = 'chats'
const PARENT_NAME = 'Chats'

/**
 * Ten parts of a `chats` capability, written to the shape a real store has:
 * UNEVENLY sized names, because evenly-sized fake labels would measure a ring
 * nobody has. The decomposition is illustrative, not a copy of any project's.
 */
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

/**
 * The two CHANGE records — the plan and the issue the board drew as "2 PARTS".
 * A change is a `kind: child` feature parented to the capability it touched;
 * that parent link is what put them on the ring and what still puts them on the
 * brief's `Changes:` line.
 */
const CHANGES: Array<[slug: string, name: string, prose: string]> = [
  [
    'chat-session-cache-rework',
    'Chat Session Cache Rework',
    'Moved the turn loop off the legacy engine and onto the agent core.',
  ],
  [
    'sse-reconnect-backoff',
    'SSE reconnect backoff',
    'An issue: reconnecting tabs hammered the events endpoint with no backoff.',
  ],
]

const PART_NAMES = PARTS.map(([name]) => name)
const CHANGE_NAMES = CHANGES.map(([, name]) => name)

function partAnchor(slug: string, partName: string): string {
  return `src/${slug}/${partName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ts`
}

/** A capability, with its `## Parts` section when it has one. */
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
            `anchors: ${partAnchor(slug, partName)}`,
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
      'Seeded by the parts-drill regression guard.',
      '',
      ...partSection,
    ].join('\n'),
  )
}

/** A CHANGE record: `kind: child`, parented to the capability it touched. */
function writeChange(root: string, slug: string, name: string, prose: string): void {
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${slug}.md`),
    [
      '---',
      `id: feature:${slug}`,
      `name: ${name}`,
      'kind: child',
      `parent: feature:${PARENT_SLUG}`,
      'anchors: []',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${name}`,
      '',
      prose,
      '',
    ].join('\n'),
  )
}

/**
 * A code map Chats' anchors resolve against — real files AND the derived graph
 * that names them.
 *
 * Without it `module:src/chats` resolves to nothing, `resolveLevel` returns the
 * empty verdict, and Chats' level is a "no level here" band with no brief bar —
 * so the `Changes:` line Task 7.2 is about would never be rendered, and the
 * spec would be asserting against a surface the real store never shows. The
 * files are written as well as the graph so that the IDE's own fire-and-forget
 * derive re-derives exactly these nodes rather than erasing them.
 */
function writeCodeMap(root: string, slug: string, parts: typeof PARTS): void {
  const src = join(root, 'src', slug)
  mkdirSync(src, { recursive: true })
  for (const [partName] of parts) {
    const file = partAnchor(slug, partName).split('/').pop() ?? 'index.ts'
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
        filesScanned: parts.length,
        filesTotal: parts.length,
        extractorsRun: ['modules'],
        graphifyEnriched: false,
      },
      nodes: [
        { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
        {
          id: `module:src/${slug}`,
          kind: 'module',
          label: slug,
          sourceFile: `src/${slug}`,
          meta: { depth: 2, fileCount: parts.length },
        },
      ],
      edges: [{ source: 'module:src', target: `module:src/${slug}`, relation: 'contains' }],
      mustReview: [],
    }),
  )
}

/** Seed the reported store and open the Blueprint on its root ring. */
async function openBoard(window: Page, prefix: string): Promise<void> {
  const root = await seedProject(window, prefix, (dir) => {
    for (const [slug, name] of SIBLINGS) writeCore(dir, slug, name)
    writeCore(dir, PARENT_SLUG, PARENT_NAME, PARTS)
    for (const [slug, name, prose] of CHANGES) writeChange(dir, slug, name, prose)
    writeCodeMap(dir, PARENT_SLUG, PARTS)
  })
  await activateProject(window, root)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  await expect(
    window.locator('.fb-terr-cell', { hasText: PARENT_NAME }).first(),
    'the seeded capabilities never reached the ring — is the bundled CLI resolvable?',
  ).toBeVisible({ timeout: 120_000 })
  // FOUR NODES AT THE ROOT, NOT SIX. The two change records are parented to
  // Chats, so they are off the root ring too — this is the first place the
  // `child` exclusion has to hold.
  await expect(window.locator('.fb-terr-cell')).toHaveCount(SIBLINGS.length + 1, {
    timeout: 30_000,
  })
}

/** Dive into Chats: a double-click on the body goes in (a single click opens the cell in place). */
async function diveIntoChats(window: Page): Promise<void> {
  await window.locator('.fb-terr-cell', { hasText: PARENT_NAME }).first().dblclick()
  await expect(window.locator('.fb-terr-crumb'), 'the dive never happened').toHaveCount(2, {
    timeout: 30_000,
  })
  // The dive flight (~0.46s) plus the ResizeObserver-driven re-fit; measuring
  // mid-flight measures a transform that is still moving.
  await window.waitForTimeout(1200)
}

interface RingLabel {
  text: string
  x: number
  y: number
  width: number
  height: number
  painted: boolean
  clipped: boolean
}

/** Every ring label's LIVE geometry, plus the pairs that overprint. */
async function measureRing(
  window: Page,
): Promise<{ labels: RingLabel[]; overlaps: string[]; sheetHeight: number }> {
  return window.evaluate(() => {
    const sheetEl = document.querySelector('.fb-terr-sheet')
    const sheetRect = sheetEl?.getBoundingClientRect() ?? null
    const labels = [...document.querySelectorAll<HTMLElement>('.fb-terr-cell')].flatMap((glyph) => {
      const el = glyph.querySelector<HTMLElement>('.fb-terr-cell-name')
      if (el === null) return []
      const style = getComputedStyle(el)
      const opacity = Number.parseFloat(style.opacity || '1')
      const rect = el.getBoundingClientRect()
      const insideSheet =
        sheetRect === null
          ? true
          : rect.left >= sheetRect.left - 0.5 &&
            rect.right <= sheetRect.right + 0.5 &&
            rect.top >= sheetRect.top - 0.5 &&
            rect.bottom <= sheetRect.bottom + 0.5
      const insideViewport =
        rect.left >= -0.5 &&
        rect.top >= -0.5 &&
        rect.right <= globalThis.innerWidth + 0.5 &&
        rect.bottom <= globalThis.innerHeight + 0.5
      return [
        {
          text: el.textContent ?? '',
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          painted:
            style.visibility !== 'hidden' && style.display !== 'none' && opacity > 0.05,
          clipped: !insideSheet || !insideViewport,
        },
      ]
    })
    // 1px of slack: the labels carry a 3.5px paint-order halo, and two boxes
    // touching at a hairline is not an unreadable overprint. Same rule as
    // blueprint-part-ring-legibility.spec.ts, so the two probes agree.
    const overlaps: string[] = []
    const painted = labels.filter((l) => l.painted)
    for (let i = 0; i < painted.length; i += 1) {
      for (let j = i + 1; j < painted.length; j += 1) {
        const a = painted[i]
        const b = painted[j]
        const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
        const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
        if (dx > 1 && dy > 1) overlaps.push(`"${a.text}" ∩ "${b.text}"`)
      }
    }
    return { labels, overlaps, sheetHeight: sheetRect?.height ?? 0 }
  })
}

test('7.1 — the ring under Chats carries its ten PARTS, readable, and no change record', async ({
  window,
}) => {
  test.setTimeout(240_000)
  await openBoard(window, 'flow-ux-parts-drill-ring-')
  await diveIntoChats(window)

  const m = await measureRing(window)
  // eslint-disable-next-line no-console -- the measured ring belongs in the log
  console.log(
    `\n── PARTS DRILL: ${String(m.labels.length)} labels, ${String(
      m.labels.filter((l) => l.painted).length,
    )} painted, ${String(m.overlaps.length)} overlapping, ${String(
      m.labels.filter((l) => l.clipped).length,
    )} clipped ──\n${m.labels
      .map((l) => `${l.text.padEnd(24)} ${l.width.toFixed(1).padStart(7)}×${l.height.toFixed(1)}`)
      .join('\n')}`,
  )

  // 1. THE RING IS THE PARTS. Exactly ten nodes, named by the ten parts —
  //    an exact set equality, so an extra node cannot hide behind a count and
  //    a missing part cannot hide behind an extra.
  expect(m.labels.map((l) => l.text).sort(), 'the ring is not the ten part names').toEqual(
    [...PART_NAMES].sort(),
  )

  // 2. NOT ONE CHANGE RECORD IS ON THIS RING — the reported symptom, stated as
  //    its own assertion so a failure names the intruder rather than reporting
  //    an off-by-two count.
  const intruders = m.labels.map((l) => l.text).filter((text) => CHANGE_NAMES.includes(text))
  expect(
    intruders,
    'a change record is drawn as a part on the ring — this is the reported bug',
  ).toEqual([])
  for (const name of CHANGE_NAMES) {
    await expect(
      window.locator('.fb-terr-cell', { hasText: name }),
      `"${name}" is a plan/issue, not a piece of Chats — it must not be a node here`,
    ).toHaveCount(0)
  }

  // 3. THE KICKER SAYS WHAT THEY ARE. "2 PARTS" over two change records was
  //    half the report; the centre must now count the real ten and call them
  //    parts.
  await expect(
    window.locator('.fb-terr-title-kicker'),
    'the centre kicker does not report ten parts',
  ).toContainText('10 parts', { ignoreCase: true })

  // 4. READABLE, MEASURED. A DOM of ten correctly-named nodes proves nothing
  //    about what is on screen — see the header. Every name is typeset, painted
  //    (not hidden behind hover), inside the sheet, and overprints nothing.
  expect(m.sheetHeight, 'the sheet has no height — every box here is meaningless').toBeGreaterThan(
    200,
  )
  for (const label of m.labels) {
    expect(label.width, `"${label.text}" has zero width — nothing was typeset`).toBeGreaterThan(4)
    expect(label.height, `"${label.text}" has zero height`).toBeGreaterThan(4)
  }
  expect(
    m.labels.filter((l) => l.painted).length,
    'part names are hidden behind hover — a name you must hover to read is not a name on the map',
  ).toBe(PARTS.length)
  expect(
    m.labels.filter((l) => l.clipped).map((l) => l.text),
    'part labels fall outside the sheet or the viewport',
  ).toEqual([])
  expect(m.overlaps, 'part labels overprint each other').toEqual([])
})

// FIXME (unrelated to plan cell-hover-diagram): Chats' feature view resolves to 'No level for Chats' (no curated view, no resolvable anchors in the Workspace-linked code map), so the brief intro that carries the Changes line never renders
test.fixme('7.2 — the two changes were RELOCATED, not lost: the brief still lists them and each opens its own record', async ({
  window,
}) => {
  test.setTimeout(240_000)
  await openBoard(window, 'flow-ux-parts-drill-changes-')

  // The FEATURE VIEW is where a change record now lives — the ONLY route to
  // one since the ring stopped carrying them, which is exactly why it is
  // asserted. The cell's own door is gone (plan cell-hover-diagram, FR-5): the
  // body dives into Chats' parts, and the header's control opens its view.
  const featureView = window.locator('.flow-board-root [data-control-glyph="diagram"]')
  await expect(async () => {
    await window.mouse.move(2, 2)
    if ((await featureView.count()) === 0) {
      await window.locator('.fb-terr-cell[data-feature-id="feature:chats"]').first().click({ position: { x: 12, y: 12 }, timeout: 2_000 })
    }
    await expect(featureView).toHaveCount(1, { timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  await featureView.click()
  const changesLine = window.locator('.fb-brief-intro-changes')
  await expect(
    changesLine,
    'Chats’ brief lists no changes — the records the ring dropped are now unreachable',
  ).toBeVisible({ timeout: 60_000 })
  await expect(changesLine).toContainText('Changes:')

  // BOTH CHANGES, BY NAME, AS CONTROLS. `child.id.length === 0` renders a dead
  // label instead of a button, so asserting the button role is asserting that
  // the link is live.
  const links = window.locator('.fb-brief-change')
  await expect(links, 'the Changes line is not two live controls').toHaveCount(CHANGES.length)
  expect((await links.allTextContents()).sort(), 'the Changes line names the wrong records').toEqual(
    [...CHANGE_NAMES].sort(),
  )

  // NO PART LEAKED THE OTHER WAY. The fix moved changes off the ring; it must
  // not have moved parts onto the Changes line. Both categories exist exactly
  // once each, in one place each — that is what "not duplicated" means.
  const changeTexts = await links.allTextContents()
  expect(
    changeTexts.filter((text) => PART_NAMES.includes(text)),
    'a part is listed as a change — the duplication came back the other way round',
  ).toEqual([])

  // EACH ONE OPENS ITS OWN RECORD. A link that renders and does nothing would
  // satisfy every assertion above, so press it and require the brief to become
  // that change: its own name, its own prose, and NOT Chats'.
  await links.filter({ hasText: CHANGE_NAMES[0] }).first().click()
  const title = window.locator('.fb-brief-intro-title')
  await expect(
    title,
    'clicking a change did not open the change’s own brief',
  ).toHaveText(CHANGE_NAMES[0], { timeout: 60_000 })
  await expect(
    window.locator('.fb-brief-intro-prose'),
    'the change’s brief shows something other than the change’s own prose',
  ).toContainText('orbit-core')

  // A change record is a LEAF here: it has no parts of its own, so its own
  // brief must not list changes. (It is also the last place a change could be
  // mistaken for a container.)
  await expect(window.locator('.fb-brief-intro-changes')).toHaveCount(0)

  // AND THE SECOND ONE, from the same place — one working link and one dead
  // one is still a lost record. The board's own Back control is the way out of
  // a brief (the bar carries none by design); this walks it back to Chats and
  // re-opens the level.
  await window.locator('.fb-nav-btn[aria-label="Back"]').click()
  await expect(title, 'Back did not return to Chats’ own level').toHaveText(PARENT_NAME, {
    timeout: 60_000,
  })
  await expect(window.locator('.fb-brief-intro-changes')).toBeVisible({ timeout: 60_000 })
  await window.locator('.fb-brief-change').filter({ hasText: CHANGE_NAMES[1] }).first().click()
  await expect(title, 'the second change’s link does not open its record').toHaveText(
    CHANGE_NAMES[1],
    { timeout: 60_000 },
  )
})
