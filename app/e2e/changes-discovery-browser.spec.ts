import { test, expect } from './fixtures/electron'
import type { Page } from '@playwright/test'
import { statusButtonByText } from './selectors'
import { seedProject, activateProject, cleanupSeeds } from './ux/fixtures/seed'
import { diveIntoCell, openFeatureView } from './ux/fixtures/territory'
import { waitForLinkedStructure } from './ux/fixtures/linked-structure'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Changes & discoveries browser, end to end (changes-discovery-view #1532).
 *
 * The corpus index (`flow/brain/.derived/corpus-index.json`) is a persisted
 * file the CLI's discover pass writes; the board reads it over
 * `blueprint:corpusIndex` and renders the browser in the brief drawer. This
 * spec seeds a real project with a feature store, a code map, the doc FILES,
 * and the index fixture, then drives the browser the way a user would:
 *
 *   1 — a drilled feature node's top-edge control opens the browser
 *       PRE-FILTERED to that feature (visible, clearable chip); clearing the
 *       chip reveals the full list including the "No feature" group; search
 *       narrows; the archived copy carries its badge; a discovery row opens
 *       the doc (peek, since this discovery proposed nothing).
 *   2 — the brief bar's "Changes & discoveries" button is the second door to
 *       the same browser; a CHANGE row clicks through to the change's own
 *       feature brief; and the brief's inline `Changes:` line still renders —
 *       the browser is in ADDITION to it, not a replacement.
 */

test.afterAll(() => cleanupSeeds())

const CHATS = { slug: 'chats', name: 'Chats' }
const AGENTS = { slug: 'agents', name: 'Agents' }

/** The change record the browser clicks through to — in the store AND the corpus. */
const CHANGE = { slug: 'chat-session-cache-rework', name: 'Chat Session Cache Rework' }

const PARTS: Array<[name: string, summary: string]> = [
  ['Chat UI', 'The per-chat conversation surface.'],
  ['History store', 'Rows in the relational store.'],
]

/** The seeded corpus index — one entry per DOC FILE, dates included. */
const INDEX_ENTRIES = [
  {
    path: 'flow/plans/plan_chat-session-cache-rework_v1.md',
    kind: 'change',
    featureSlug: CHATS.slug,
    name: CHANGE.name,
    created: '2026-08-01T00:00:00.000Z',
    indexed: '2026-08-12T00:00:00.000Z',
    archived: false,
  },
  {
    // The ARCHIVED copy of the same plan — listed too, flagged, per-doc.
    path: 'flow/archive/plan_chat-session-cache-rework_v1.md',
    kind: 'change',
    featureSlug: CHATS.slug,
    name: CHANGE.name,
    created: '2026-07-01T00:00:00.000Z',
    indexed: '2026-08-12T00:00:00.000Z',
    archived: true,
  },
  {
    path: 'flow/plans/plan_agents-retry_v1.md',
    kind: 'change',
    featureSlug: AGENTS.slug,
    name: 'Agents Retry',
    created: '2026-06-05T00:00:00.000Z',
    indexed: '2026-08-12T00:00:00.000Z',
    archived: false,
  },
  {
    // Unparented — must land in the explicit "No feature" group, never dropped.
    path: 'flow/plans/plan_orphan-cleanup_v1.md',
    kind: 'change',
    featureSlug: null,
    name: 'Orphan Cleanup',
    created: '2026-05-01T00:00:00.000Z',
    indexed: '2026-08-12T00:00:00.000Z',
    archived: false,
  },
  {
    // A discovery parented to chats — the Discoveries tab's one row. It has
    // no proposals behind it, so its click-through is the read-only peek.
    path: 'flow/discovery/discovery_billing-alerts_v1.md',
    kind: 'discovery',
    featureSlug: CHATS.slug,
    name: 'Billing Alerts Discovery',
    created: '2026-04-01T00:00:00.000Z',
    indexed: '2026-08-12T00:00:00.000Z',
    archived: false,
  },
] as const

/** A core capability in the feature store, with optional parts. */
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
      'Seeded by the changes-discovery-browser guard.',
      '',
      ...partSection,
    ].join('\n'),
  )
}

/** The CHANGE record the corpus row resolves to: kind child, parented to chats. */
function writeChange(root: string): void {
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${CHANGE.slug}.md`),
    [
      '---',
      `id: feature:${CHANGE.slug}`,
      `name: ${CHANGE.name}`,
      'kind: child',
      `parent: feature:${CHATS.slug}`,
      'anchors: []',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${CHANGE.name}`,
      '',
      'Moved the turn loop onto orbit-core.',
      '',
    ].join('\n'),
  )
}

/** Real files + derived graph so chats' anchors resolve and the brief renders. */
function writeCodeMap(root: string): void {
  const src = join(root, 'src', CHATS.slug)
  mkdirSync(src, { recursive: true })
  for (const [partName] of PARTS) {
    const file = `${partName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ts`
    writeFileSync(join(src, file), `export const seeded = ${JSON.stringify(partName)}\n`)
  }
  const structure = join(root, 'flow', 'brain', '.structure')
  mkdirSync(structure, { recursive: true })
  writeFileSync(
    join(structure, 'graph.json'),
    JSON.stringify({
      version: 1,
      derivedAt: '2026-08-12T00:00:00.000Z',
      coverage: {
        filesScanned: PARTS.length,
        filesTotal: PARTS.length,
        extractorsRun: ['modules'],
        graphifyEnriched: false,
      },
      nodes: [
        { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
        {
          id: `module:src/${CHATS.slug}`,
          kind: 'module',
          label: CHATS.slug,
          sourceFile: `src/${CHATS.slug}`,
          meta: { depth: 2, fileCount: PARTS.length },
        },
      ],
      edges: [{ source: 'module:src', target: `module:src/${CHATS.slug}`, relation: 'contains' }],
      mustReview: [],
    }),
  )
}

/** The corpus DOC FILES the index points at — click-through reads them. */
function writeCorpusDocs(root: string): void {
  for (const dir of ['plans', 'discovery', 'archive']) {
    mkdirSync(join(root, 'flow', dir), { recursive: true })
  }
  const doc = (relPath: string, title: string): void => {
    writeFileSync(join(root, relPath), `# ${title}\n\nSeeded corpus doc.\n`)
  }
  doc('flow/plans/plan_chat-session-cache-rework_v1.md', CHANGE.name)
  doc('flow/archive/plan_chat-session-cache-rework_v1.md', CHANGE.name)
  doc('flow/plans/plan_agents-retry_v1.md', 'Agents Retry')
  doc('flow/plans/plan_orphan-cleanup_v1.md', 'Orphan Cleanup')
  doc('flow/discovery/discovery_billing-alerts_v1.md', 'Billing Alerts Discovery')
}

/** The persisted index fixture — what the CLI's discover pass would have written. */
function writeCorpusIndexFixture(root: string): void {
  const dir = join(root, 'flow', 'brain', '.derived')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'corpus-index.json'),
    `${JSON.stringify({ indexedAt: '2026-08-12T00:00:00.000Z', entries: INDEX_ENTRIES }, null, 2)}\n`,
  )
}

/** Seed everything and open the Blueprint on the root ring. */
async function openBoard(window: Page, prefix: string): Promise<void> {
  const root = await seedProject(window, prefix, (dir) => {
    writeCore(dir, AGENTS.slug, AGENTS.name)
    writeCore(dir, CHATS.slug, CHATS.name, PARTS)
    writeChange(dir)
    writeCodeMap(dir)
    writeCorpusDocs(dir)
  })
  await activateProject(window, root)
  // The corpus index is a GENERATED file (`.derived/`): written before the
  // project joins its Workspace it is dropped by the migration's copy and
  // re-indexed from the doc FILENAMES — which parent the discovery to no
  // feature. Seed the fixture once the project sits in its Workspace.
  await waitForLinkedStructure(window, root)
  writeCorpusIndexFixture(root)
  // Give the board the editor's full height: the docked terminal is visible by
  // default (#674) and, at the spec window's 900px, leaves the corpus drawer's
  // list a sliver too small to hold a row.
  if (await window.locator('.fl-term-root').isVisible()) {
    await window.keyboard.press('Control+Backquote')
    await expect(window.locator('.fl-term-root')).toHaveCount(0)
  }
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  await expect(
    window.locator('.fb-terr-cell', { hasText: CHATS.name }).first(),
    'the seeded capabilities never reached the sheet — is the bundled CLI resolvable?',
  ).toBeVisible({ timeout: 120_000 })
}

/** The corpus drawer, its rows host, and its count line. */
const DRAWER = '.fb-corpus-drawer'

test('1 — drilled-node entry: pre-filter chip, clear to full list, search, archived badge, discovery peek', async ({
  window,
}) => {
  test.setTimeout(240_000)
  await openBoard(window, 'flow-ux-corpus-browser-')

  // Dive into Chats — the corpus control rides the DRILLED level's title strip.
  await diveIntoCell(window, CHATS.name)
  await window.waitForTimeout(1200) // dive flight + re-fit settle

  // The top-edge control opens the browser scoped to this feature.
  // (It is a plain button on the drilled level's strip, named for what it opens.)
  await window.getByRole('button', { name: `Open ${CHATS.name}'s changes & discoveries` }).click()
  await expect(window.locator(DRAWER), 'the corpus drawer did not open').toBeVisible({
    timeout: 30_000,
  })

  // PRE-FILTERED, AND IT SAYS SO: the chip names the feature and is clearable.
  const chip = window.locator('.fb-corpus-chip')
  await expect(chip, 'no filter chip — a pre-filtered list must say so').toBeVisible()
  await expect(chip.locator('.fb-corpus-chip-slug')).toHaveText(CHATS.slug)

  // Only chats' two change docs (live + archived copy) — agents' and the
  // orphan are filtered out, and the "No feature" group is empty under a chip.
  const rows = window.locator(`${DRAWER} .fb-corpus-row`)
  await expect(rows, 'the pre-filtered list is not exactly chats' + "' docs").toHaveCount(2)
  for (const text of await rows.allTextContents()) {
    expect(text, 'a non-chats doc leaked through the feature pre-filter').toContain(CHANGE.name)
  }
  await expect(window.locator('.fb-corpus-nofeature')).toHaveCount(0)

  // THE ARCHIVED COPY IS LISTED AND FLAGGED — per doc file, badge as the story.
  await expect(
    window.locator(`${DRAWER} .fb-corpus-badge`, { hasText: 'archived' }),
    'the archived copy lost its badge (or the badge lost its row)',
  ).toHaveCount(1)

  // CLEAR THE CHIP → the full changes tab: three parented rows plus the
  // "No feature" group carrying the unparented doc — counted, never lost.
  await chip.locator('.fb-corpus-chip-clear').click()
  await expect(window.locator('.fb-corpus-chip')).toHaveCount(0)
  const noFeature = window.locator('.fb-corpus-nofeature')
  await expect(noFeature, 'the unparented doc has no "No feature" group').toBeVisible()
  await expect(noFeature.locator('summary')).toContainText('No feature · 1')
  await expect(rows, 'clearing the chip did not reveal the full list').toHaveCount(4)
  await expect(window.locator(`${DRAWER} .fb-corpus-count`)).toHaveText('4 of 4 on this tab')

  // SEARCH NARROWS — literal substring over name/path/slug, live repaint.
  //
  // `cache` matches the two copies of the cache-rework plan (live + archived)
  // and neither `agents-retry` nor `orphan-cleanup`. This searched `engine`,
  // a word that appears NOWHERE in the seeded corpus — the fixtures were
  // renamed to `chat-session-cache-rework` and the term was left behind, so
  // the search correctly returned nothing and the spec had been failing on a
  // product that was working.
  await window.locator(`${DRAWER} input[type="search"]`).fill('cache')
  await expect(rows, 'search did not narrow to the two cache-rework docs').toHaveCount(2)
  await expect(window.locator(`${DRAWER} .fb-corpus-count`)).toHaveText('2 of 4 on this tab')
  await expect(noFeature).toHaveCount(0)
  await window.locator(`${DRAWER} input[type="search"]`).fill('')
  await expect(rows).toHaveCount(4)

  // THE DISCOVERIES TAB, AND A DISCOVERY'S CLICK-THROUGH: the doc itself, in
  // the read-only peek (the board's discovery view was retired 2026-10-08).
  await window.locator(`${DRAWER} .fb-learn-tab`, { hasText: 'Discoveries (1)' }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Billing Alerts Discovery')
  await window.screenshot({ path: 'e2e/__screens/changes-discovery-browser.png' })
  await rows.first().click()
  await expect(
    window.locator('.fb-peek-drawer'),
    'the discovery doc did not open in the peek drawer',
  ).toBeVisible({ timeout: 60_000 })
  await expect(window.locator('.fb-peek-drawer')).toContainText('discovery_billing-alerts_v1.md')
})

test('2 — feature-view entry: browser button, change click-through to its brief, the view still lists its changes', async ({
  window,
}) => {
  test.setTimeout(240_000)
  await openBoard(window, 'flow-ux-corpus-brief-')

  // Open chats' feature view via its open-level control. The control rides
  // the DRILLED level's title strip (cells have no door of their own any more;
  // pressing one dives), so dive first.
  await diveIntoCell(window, CHATS.name)
  await openFeatureView(window, CHATS.name)

  // THE FEATURE VIEW STILL LISTS THE RECORDS THAT TOUCHED IT — the browser adds
  // a door, it does not remove the view's own listing. (It was the brief bar's
  // inline `Changes:` line; the feature view is a derived level now, whose
  // stage carries the changes as a strip of pills — `#buildChangesStrip`.)
  const changesStrip = window.locator('.flow-board-root .fb-terr-changes')
  await expect(changesStrip, 'the feature view lost its changes listing').toBeVisible({
    timeout: 60_000,
  })
  await expect(
    changesStrip.locator('.fb-terr-change-label', { hasText: `change · ${CHANGE.name}` }),
  ).toHaveCount(1)

  // The header's "Changes & discoveries" button is the second entrance —
  // same browser, same pre-filter.
  await window.locator('.flow-board-root .fb-brief-time', { hasText: 'discoveries' }).click()
  await expect(window.locator(DRAWER)).toBeVisible({ timeout: 30_000 })
  await expect(window.locator('.fb-corpus-chip-slug')).toHaveText(CHATS.slug)

  // A CHANGE ROW OPENS THE CHANGE'S OWN BRIEF — the same door as the inline
  // line, resolved from the doc filename's slug. The drawer yields the stage.
  await window
    .locator(`${DRAWER} .fb-corpus-row`, { hasText: CHANGE.name })
    .first()
    .click()
  await expect(
    window.locator('.fb-brief-intro-title'),
    'clicking a change row did not open the change record' + "'s own brief",
  ).toHaveText(CHANGE.name, { timeout: 60_000 })
  await expect(window.locator(DRAWER)).toHaveCount(0)
  await window.screenshot({ path: 'e2e/__screens/changes-discovery-clickthrough.png' })
})
