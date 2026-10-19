import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { openLearningPanel } from './fixtures/territory'
import { waitForLinkedStructure } from './fixtures/linked-structure'

/**
 * Trust tiers (Phase 5 e2e): a seeded `file-tiers.json` with adjudication
 * verdicts must surface as the Learning panel's Sync-section "Docs" row.
 *
 * The chain under test crosses three committed layers end-to-end:
 * BlueprintObserver reads `flow/brain/.structure/file-tiers.json` and tallies
 * it into `snapshot.tiers` (`parseTierSummary`, counts only), the board's
 * `#renderSyncSection` asks `tierTalliesLine` for the one-line summary, and the
 * row renders under the "Docs" heading inside the Learning panel — opened via
 * the learn chip (the sync surface folded into the Learning panel; the old
 * "Sync status" header button stays retired, see blueprint-sync-active.spec).
 *
 * Fixture: 4 claim docs — 2 corroborated, 1 contradicted, 1 unadjudicated →
 * `4 docs · 2 verified · 1 contradicted · 1 unverified` (vocabulary mapping in
 * sync-status-model.ts: verified = corroborated; unverified = unadjudicated +
 * unverifiable). Non-claim entries (code/own) must not count as docs.
 */

/** Three depth-1 roots so the top-level spine renders without auto-descending
 *  (matches the other blueprint specs) and the learn chip has a module total. */
const GRAPH_FIXTURE = {
  version: 1,
  derivedAt: new Date().toISOString(),
  coverage: { filesScanned: 3, filesTotal: 3, extractorsRun: ['ts'], graphifyEnriched: false },
  nodes: [
    { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
    { id: 'module:lib', kind: 'module', label: 'lib', sourceFile: 'lib', meta: { depth: 1 } },
    { id: 'module:test', kind: 'module', label: 'test', sourceFile: 'test', meta: { depth: 1 } },
  ],
  edges: [],
}

/** A recorded verdict in the CLI's `TierVerdict` shape (file-tiers.ts).
 *  Doc + witness hashes are REAL (computed over the seeded files) — the
 *  read-time revocation pass re-hashes them, and fake hashes would honestly
 *  flip every verdict to 'stale'. */
function verdictOf(
  kind: 'corroborated' | 'contradicted' | 'unverifiable',
  docHash: string,
  witnessHash: string,
) {
  return {
    verdict: kind,
    docHash,
    verifiedAgainst: [{ path: 'src/a.ts', contentHash: witnessHash }],
    ts: '2026-07-21T00:00:00.000Z',
  }
}

/** The contradicted doc, recorded the way a verify-agent run records one:
 *  with its evidence note and per-claim breakdown (#1131). Without these the
 *  row can state a verdict but never say WHY. */
function contradictedVerdict(docHash: string, witnessHash: string) {
  return {
    ...verdictOf('contradicted', docHash, witnessHash),
    provenance: 'verify-agent',
    evidence: 'The doc documents a v1 endpoint the code no longer serves.',
    claims: [
      {
        claim: 'POST /v1/login returns a session token',
        outcome: 'contradicted',
        witnesses: ['src/a.ts'],
        note: 'a.ts exports only `a`; no /v1/login route exists',
      },
      { claim: 'The module exports a constant', outcome: 'corroborated', witnesses: ['src/a.ts'] },
    ],
  }
}

/** 4 claim docs (2 corroborated, 1 contradicted, 1 without a verdict) plus
 *  entries that must NOT count toward the Docs tallies (code, own, an image). */
const fileTiersFixture = (docHash: string, witnessHash: string) => ({
  derivedAt: new Date().toISOString(),
  entries: [
    { path: 'src/a.ts', tier: 'code' },
    { path: 'flow/plans/plan_x_v1.md', tier: 'own' },
    { path: 'docs/architecture.md', tier: 'claim', verdict: verdictOf('corroborated', docHash, witnessHash) },
    { path: 'docs/setup.md', tier: 'claim', verdict: verdictOf('corroborated', docHash, witnessHash) },
    { path: 'docs/api.md', tier: 'claim', verdict: contradictedVerdict(docHash, witnessHash) },
    // The claim doc with no verdict is the provisioner's own CLAUDE.md — a doc
    // every project has, so a derive the board runs on open lists it too and
    // the tally holds either side of that derive.
    { path: 'CLAUDE.md', tier: 'claim' },
    // An image is never a claim doc to adjudicate (#1130): it must not count.
    { path: 'assets/diagram.png', tier: 'claim' },
  ],
})

/** Seed graph + tier sidecar + learning state into the observer's fixed paths. */
function seedStructure(root: string): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  // Real doc + witness files: the tier verdicts stamp THEIR hashes, so the
  // read-time revocation pass sees everything fresh (not stale).
  const docContent = '# doc\n'
  const witnessContent = 'export const a = 1\n'
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  for (const doc of ['architecture.md', 'setup.md', 'api.md']) {
    writeFileSync(join(root, 'docs', doc), docContent)
  }
  writeFileSync(join(root, 'src', 'a.ts'), witnessContent)
  const docHash = createHash('sha256').update(docContent).digest('hex')
  const witnessHash = createHash('sha256').update(witnessContent).digest('hex')
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH_FIXTURE))
  writeFileSync(join(dir, 'file-tiers.json'), JSON.stringify(fileTiersFixture(docHash, witnessHash)))
  // A learned module keeps the learn chip's text deterministic (and the project
  // honestly in sync — the Docs row must render regardless of the verdict).
  writeFileSync(
    join(dir, 'learning-state.jsonl'),
    JSON.stringify({ module: 'src', status: 'learned', notedAt: '2026-07-18T10:00:00Z' }),
  )
}

const boardRoot = '.flow-board-root'
const learnPanel = '.flow-board-root .fb-learn-panel'

test.describe('blueprint trust tiers — Docs tallies in the Learning panel Sync section', () => {
  test.afterAll(() => cleanupSeeds())

  test('a seeded tier store with verdicts renders the Docs row with honest tallies', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    await activateProject(window, root)
    // The tier store is a GENERATED file: seeded before the project joins its
    // Workspace it is dropped by the migration's copy and rebuilt by the first
    // derive. Seed it once the link and that derive have landed.
    await waitForLinkedStructure(window, root)
    seedStructure(root)

    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator(boardRoot)).toBeVisible()
    // The Learning panel's door on the Territory is the header's "Learn"
    // button (the learn chip is painted only by the retired module map, whose
    // card this used to wait for).
    await openLearningPanel(window)
    const panel = window.locator(learnPanel)
    await expect(panel).toBeVisible()

    // The Docs surface moved into the panel's Docs TAB (user redesign
    // 2026-07-23 → doc-verification): the tab carries the count, and each
    // claim doc renders a row with its adjudication pill.
    const docsTab = panel.locator('.fb-learn-tab', { hasText: 'Docs (4)' })
    await expect(docsTab).toBeVisible()
    await docsTab.click()
    await expect(panel.locator('.fb-learn-pill').filter({ hasText: /^verified$/ })).toHaveCount(2)
    await expect(panel.locator('.fb-learn-pill').filter({ hasText: /^contradicted$/ })).toHaveCount(1)
    await expect(panel.locator('.fb-learn-pill').filter({ hasText: /^unverified$/ })).toHaveCount(1)
    // 'unverified' matches the unadjudicated pill; verify per-row verify ⚙
    // actions exist (the tab is a pipeline now, not a list).
    await expect(panel.locator('.fb-tier-verify').first()).toBeVisible()

    expect(errors, `renderer errors during trust-tiers flow:\n${errors.join('\n')}`).toEqual([])
  })

  test('without a tier sidecar the Docs row is withheld entirely (no empty-state claim)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    await activateProject(window, root)
    // Graph + learning state, but NO file-tiers.json — seeded once the project
    // sits in its Workspace (a derived file seeded earlier is dropped by the
    // migration's copy). The provisioner's CLAUDE.md is a real claim doc, so it
    // goes too: a derive the board runs on its own (graphify landing) would
    // otherwise write a sidecar that honestly lists it, and this test is about
    // a project with no tier store to report.
    const dir = await waitForLinkedStructure(window, root)
    rmSync(join(dir, 'file-tiers.json'), { force: true })
    rmSync(join(root, 'CLAUDE.md'), { force: true })
    writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH_FIXTURE))
    writeFileSync(
      join(dir, 'learning-state.jsonl'),
      JSON.stringify({ module: 'src', status: 'learned', notedAt: '2026-07-18T10:00:00Z' }),
    )

    await window.locator(statusButtonByText('Blueprint')).click()
    await openLearningPanel(window)
    const panel = window.locator(learnPanel)
    await expect(panel).toBeVisible()

    // The panel renders its Modules tab — and NO Docs tab at all (a missing
    // sidecar must never produce an empty-state Docs claim).
    await expect(panel.locator('.fb-learn-tab', { hasText: 'Modules' })).toBeVisible()
    await expect(panel.locator('.fb-learn-tab', { hasText: 'Docs' })).toHaveCount(0)

    expect(errors, `renderer errors during no-sidecar flow:\n${errors.join('\n')}`).toEqual([])
  })

  test('a contradicted doc explains itself: why, who, when, against what, claim by claim (#1131)', async ({
    window,
  }) => {
    // The list stated verdicts and showed a `5 ✓ · 1 ✗ · 1 ?` rollup, a trust
    // tier and ⚙/✓/✕ buttons — and explained none of them. Clicking a row just
    // opened the file, so a doc marked `contradicted` could never say what it
    // was contradicting or what to do about it.
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    await activateProject(window, root)
    // The tier store is a GENERATED file: seeded before the project joins its
    // Workspace it is dropped by the migration's copy and rebuilt by the first
    // derive. Seed it once the link and that derive have landed.
    await waitForLinkedStructure(window, root)
    seedStructure(root)

    await window.locator(statusButtonByText('Blueprint')).click()
    await openLearningPanel(window)
    const panel = window.locator(learnPanel)
    await expect(panel).toBeVisible()
    await panel.locator('.fb-learn-tab', { hasText: 'Docs (4)' }).click()

    // The tier itself is defined up front — "why is this Tier 2?" had no answer.
    const legend = panel.locator('.fb-tier-legend')
    await expect(legend).toContainText('Tier-2')
    await expect(legend).toContainText('Code is Tier 1')

    // The verdict pill is the WHY control, not decoration.
    const contradicted = panel.locator('.fb-learn-pill').filter({ hasText: /^contradicted$/ })
    await expect(contradicted).toHaveAttribute('aria-expanded', 'false')
    await contradicted.click()
    await expect(contradicted).toHaveAttribute('aria-expanded', 'true')

    const why = panel.locator('.fb-tier-why')
    await expect(why).toBeVisible()
    // What it means, and what to do next.
    await expect(why.locator('.fb-tier-why-meaning')).toContainText('Trust the code')
    await expect(why.locator('.fb-tier-why-next')).toContainText('verify again')
    // Who decided, and when.
    await expect(why.locator('.fb-tier-why-meta')).toContainText('verification agent')
    // The verifier's own note — the most useful line, previously dropped.
    await expect(why.locator('.fb-tier-why-evidence')).toContainText('no longer serves')
    // What it was checked AGAINST, clickable.
    await expect(why.locator('.fb-tier-why-witness')).toHaveText(['src/a.ts'])
    // Claim by claim: WHICH statement failed, not just that one did.
    const claims = why.locator('.fb-tier-why-claim')
    await expect(claims).toHaveCount(2)
    await expect(claims.first()).toContainText('POST /v1/login returns a session token')
    await expect(claims.first()).toContainText('no /v1/login route exists')

    // It closes again.
    await contradicted.click()
    await expect(panel.locator('.fb-tier-why')).toHaveCount(0)

    expect(errors, `renderer errors during doc-explanation flow:\n${errors.join('\n')}`).toEqual([])
  })
})
