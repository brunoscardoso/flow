import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { waitForLinkedStructure } from './fixtures/linked-structure'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * Docs-tab verification surface (doc-verification): a verified doc shows its
 * per-claim rollup + provenance and a Verify (⚙) action; when a WITNESS file
 * changes on disk, the verdict revokes — the row flips to 'stale — trust
 * expired' with a ⟳ Re-verify. Seeded store, no live agent run.
 */

const GRAPH = {
  version: 1,
  derivedAt: '2026-07-25T00:00:00Z',
  coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: false },
  nodes: [{ id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } }],
  edges: [],
}

const sha = (content: string): string => createHash('sha256').update(content).digest('hex')

test.afterAll(() => cleanupSeeds())

test('verified doc shows rollup; witness change revokes to stale + Re-verify', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await seedProject(window)
  await activateProject(window, root)
  // The tier store and the graph are GENERATED files: written before the
  // project joins its Workspace they are dropped by the migration's copy and
  // rebuilt by the first derive. Seed them once it has settled.
  const dir = await waitForLinkedStructure(window, root)
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  const docContent = '# API\nAuth uses sessions.\n'
  const witnessContent = 'export const auth = "session"\n'
  writeFileSync(join(root, 'docs', 'api.md'), docContent)
  writeFileSync(join(root, 'src', 'auth.ts'), witnessContent)
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH))
  writeFileSync(
    join(dir, 'file-tiers.json'),
    JSON.stringify({
      derivedAt: '2026-07-25T00:00:00Z',
      entries: [
        {
          path: 'docs/api.md',
          tier: 'claim',
          verdict: {
            verdict: 'corroborated',
            docHash: sha(docContent),
            verifiedAgainst: [{ path: 'src/auth.ts', contentHash: sha(witnessContent) }],
            ts: '2026-07-25T00:00:00Z',
            provenance: 'verify-agent',
            claims: [
              { claim: 'Auth uses sessions', outcome: 'corroborated', witnesses: ['src/auth.ts'] },
            ],
          },
        },
      ],
    }),
  )
  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-blueprint'))
    document.dispatchEvent(new CustomEvent('flow:open-learning-panel'))
  })

  const panel = window.locator('.fb-learn-panel')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await panel.locator('.fb-learn-tab', { hasText: 'Docs' }).click()

  // Verified state: rollup + provenance chip + agent-verify action present.
  const row = panel.locator('.fb-learn-row', { hasText: 'docs/api.md' })
  await expect(row).toBeVisible()
  await expect(row.locator('.fb-learn-pill')).toHaveText('verified')
  await expect(row.locator('.fb-tier-rollup')).toHaveText('1 ✓ · 0 ✗ · 0 ?')
  await expect(row.locator('.fb-tier-verify')).toBeVisible()

  // A teammate's change lands in the witness → trust expires on next read.
  writeFileSync(join(root, 'src', 'auth.ts'), 'export const auth = "totally different"\n')
  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-learning-panel'))
  })
  // Force a re-read via the panel's ⟳? Snapshot re-read happens on refresh —
  // drive it through the board's refresh entry (blueprint tab is open).
  await window.locator('.fb-learn-recheck').click()

  const staleRow = panel.locator('.fb-learn-row', { hasText: 'docs/api.md' })
  await expect(staleRow.locator('.fb-learn-pill')).toHaveText('stale', { timeout: 15_000 })
  await expect(staleRow.locator('.fb-tier-verify')).toHaveText('⟳')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
