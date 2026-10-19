import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, openEmptyThread, waitForWorkspaceLink } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The story renders INSIDE its doc's artifact card, not beside it (user call
 * 2026-08-11: "we don't need two, and the story will be nice to have inside of
 * the discovery").
 *
 * Two things have to hold for that merge to be an improvement rather than a
 * regression, and only one of them is about layout:
 *
 * 1. ONE card. The story is nested in the discovery card and owns no feed entry
 *    of its own — a `.fl-conv-entry-story` wrapper still in the feed would mean
 *    the pair never actually merged.
 * 2. The nested story is still USABLE. The artifact card is itself the
 *    open-the-doc affordance, so without stopPropagation every click inside the
 *    story — Next, Back, an anchor chip — would ALSO open the markdown behind
 *    it. That is asserted on the real `flow:open-file-path` event the card
 *    dispatches, not on a downstream tab, so the probe fails at the cause.
 *
 * Seeding mirrors blueprint.spec: story.json is written to the observer's fixed
 * path, and the doc lands through the real watcher, so nothing here mocks the
 * renderer. `plan` MUST equal the doc's derived feature — that match is what the
 * pane keys the nesting on.
 */

const SLUG = 'ledger-sync'
const DOC = `discovery_${SLUG}_v1.md`

const STORY_FIXTURE = {
  plan: SLUG,
  sourcePath: `flow/discovery/${DOC}`,
  mode: 'draft',
  warnings: [],
  steps: [
    {
      id: 'the-problem',
      title: 'The problem',
      body: 'Ledger rows drift from the upstream statement with no way to see it.',
      anchors: [],
      flow: [],
      phases: [1],
      decisions: [],
      rejected: [],
      questions: [],
      unresolvedAnchors: [],
      draft: false,
    },
    {
      id: 'the-shape',
      title: 'The shape',
      body: 'A reconciliation pass that reports the delta before it writes anything.',
      anchors: [],
      flow: [],
      phases: [2],
      decisions: [],
      rejected: [],
      questions: [],
      unresolvedAnchors: [],
      draft: false,
    },
  ],
}

function seedStory(root: string): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'story.json'), JSON.stringify(STORY_FIXTURE))
}

function writeDiscoveryDoc(root: string): void {
  const dir = join(root, 'flow', 'discovery')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, DOC), `# Discovery: Ledger Sync\n\nReconcile the ledger.\n`)
}

test.afterAll(() => cleanupSeeds())

test('the story renders inside its discovery card, and stays clickable there', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const root = await seedProject(window)
  await activateProject(window, root)
  // AFTER the Workspace link: activating moves the project into its Workspace,
  // which links `flow/` there and copies what it held — except the generated
  // class, which `.structure/story.json` belongs to (rebuilt by `narrate` on
  // each machine). Seeded before the link lands, the snapshot stays behind in
  // `flow.pre-workspace-<date>/` and no story ever reaches the pane.
  await waitForWorkspaceLink(root)
  seedStory(root)

  // An open, empty thread (made directly: "+" opens the new-thread page, whose
  // Create sends a first message — not what this spec is about).
  await openEmptyThread(window, root)
  await expect(window.locator(sel.composer)).toBeVisible()

  // The doc lands live — the watcher surfaces it as the discovery card.
  writeDiscoveryDoc(root)
  const artifact = window.locator('.fl-artifact-card')
  await expect(artifact.first()).toBeVisible({ timeout: 30_000 })
  await expect(
    window.locator('.fl-artifact-card .fl-artifact-eyebrow', { hasText: 'DISCOVERY' }).first(),
  ).toBeVisible()

  // The story compiles into the same feature — the pane re-reads the snapshot on
  // the same decoupled signal the status-bar Blueprint button dispatches.
  await window.locator(statusButtonByText('Blueprint')).click()

  // ── 1. ONE card ─────────────────────────────────────────────────────────────
  const nested = window.locator('.fl-artifact-card .fl-story-card')
  await expect(nested).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('.fl-story-card')).toHaveCount(1)
  // No standalone feed entry survives — that wrapper IS the second card.
  await expect(window.locator('.fl-conv-entry-story')).toHaveCount(0)
  await expect(nested.locator('.fl-story-title')).toHaveText('The problem')

  // ── 2. Still usable inside its host ─────────────────────────────────────────
  await window.evaluate(() => {
    const opens: unknown[] = []
    ;(window as unknown as { __docOpens: unknown[] }).__docOpens = opens
    document.addEventListener('flow:open-file-path', (event) => {
      opens.push((event as CustomEvent).detail)
    })
  })

  await nested.locator('.fl-story-nav-btn', { hasText: 'Next' }).click()
  await expect(nested.locator('.fl-story-title')).toHaveText('The shape')

  // The click drove the story and did NOT fall through to the host card.
  expect(
    await window.evaluate(() => (window as unknown as { __docOpens: unknown[] }).__docOpens),
  ).toEqual([])

  // The host is still the doc's affordance — clicking the card itself opens it.
  await window.locator('.fl-artifact-title').first().click()
  expect(
    await window.evaluate(
      () => (window as unknown as { __docOpens: { path: string }[] }).__docOpens.length,
    ),
  ).toBe(1)

  // RETRIED, because the feed can re-mount the card once after the doc opens.
  // A screenshot resolves its element once and then waits for it to be stable;
  // a node replaced inside that wait throws "not attached to the DOM" and failed
  // this case AFTER every assertion above had passed. Seen when it runs after
  // story-any-language.spec.ts (3 of 6 paired runs), never alone.
  await expect(async () => {
    await window.locator('.fl-artifact-card').first().screenshot({
      path: 'e2e/ux/__screens/story-inside-artifact-card.png',
      timeout: 5_000,
    })
  }).toPass({ timeout: 20_000 })

  expect(errors).toEqual([])
})
