import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, openEmptyThread } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Blueprint UX regression guard (sweep flow 10) — rewritten for blueprint-v2's
 * FLOW-FIRST board (blueprint-board.ts) and in-thread story card
 * (threads/story-card.ts). Drives the real status-bar Blueprint button and the
 * real editor-area tab; nothing here mocks the renderer.
 *
 * Unlike the retired BlueprintView spec, these probes pre-seed a real
 * `flow/brain/.structure/graph.json` (and `story.json`) fixture directly on
 * disk before activating the project. `blueprint:read` (main's
 * BlueprintObserver) reads those fixed paths verbatim — no CLI derive, no
 * credentials, no basic-graph fallback timing — so the board renders
 * deterministically and fast. See src/main/blueprint/blueprint-observer.ts
 * and src/renderer/blueprint/flow-model.ts (rollupGraph) for the exact shape
 * relied on below (module `meta.depth`, `contains` edges for the folder
 * spine, `uses`/`exposes` edges for periphery wires).
 */

/** A depth-1 "src" module with one child module (drillable) and one
 *  integration wired to it via a `uses` edge — enough to exercise the module
 *  rollup, the folder-spine drill, and a periphery wire in one fixture.
 *
 *  Two extra bare depth-1 roots (`lib`, `test`) keep the top level at THREE
 *  modules so the board holds its depth-1 view: `selectInitialFocus` (#537,
 *  flow-model.ts) auto-descends a *degenerate* single dominant root, which
 *  would drill straight into `src` and hide its card. `depthOne.length > 2`
 *  is exactly the "enough top-level structure — keep depth-1" guard, so the
 *  `src` card renders at the top level the probes below assert against. The
 *  bare roots carry no periphery edges, so the single `uses` wire count holds. */
const GRAPH_FIXTURE = {
  version: 1,
  derivedAt: new Date().toISOString(),
  coverage: { filesScanned: 2, filesTotal: 2, extractorsRun: ['ts'], graphifyEnriched: false },
  nodes: [
    { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
    {
      id: 'module:src/inner',
      kind: 'module',
      label: 'inner',
      sourceFile: 'src/inner',
      meta: { depth: 2 },
    },
    { id: 'module:lib', kind: 'module', label: 'lib', sourceFile: 'lib', meta: { depth: 1 } },
    { id: 'module:test', kind: 'module', label: 'test', sourceFile: 'test', meta: { depth: 1 } },
    { id: 'integration:stripe', kind: 'integration', label: 'Stripe', sourceFile: 'src/stripe.ts' },
  ],
  edges: [
    { source: 'module:src', target: 'module:src/inner', relation: 'contains' },
    { source: 'module:src', target: 'integration:stripe', relation: 'uses' },
  ],
}

/** A two-step compiled story, enough to exercise minimize + step navigation. */
const STORY_FIXTURE = {
  plan: 'blueprint-v2',
  sourcePath: 'flow/plans/plan_blueprint-v2_v1.md',
  mode: 'strict',
  steps: [
    {
      id: 'the-problem',
      title: 'The problem',
      body: 'The old board was a static tree; nothing showed how modules actually wire together.',
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
      body: 'A depth-1 rollup with curved wires, drill-down, and a node popover.',
      anchors: [],
      flow: [],
      phases: [2, 3],
      decisions: ['Roll up to depth-1 by default'],
      rejected: [],
      questions: [],
      unresolvedAnchors: [],
      draft: false,
    },
  ],
  warnings: [],
}

/** Write graph.json into `<root>/flow/brain/.structure/` (BlueprintObserver's
 *  fixed read path — no legacy dir needed since we write the preferred one). */
function seedGraphFixture(root: string): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH_FIXTURE))
}

/** Write story.json alongside graph.json (same fixed directory). */
function seedStoryFixture(root: string): void {
  const dir = join(root, 'flow', 'brain', '.structure')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'story.json'), JSON.stringify(STORY_FIXTURE))
}


test.describe('blueprint ux (v2 flow-first board)', () => {
  test.afterAll(() => cleanupSeeds())

  // RETIRED 2026-10-09: the module-card tests (wired module nodes, Drill, the
  // node popover's Attach, the camera) drove the global CODE MAP, which the
  // code storyline replaced (0803facb, plan_code-storyline_v1 phase 7) and
  // which no render path draws any more (blueprint-board.ts: `codeMap: false`).
  // The storyline's own behaviour is guarded by code-storyline.spec.ts.

  test('story card auto-opens on flow:open-blueprint, minimizes, and steps forward', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    // Seed a graph but NOT the story yet — the story card must be absent until
    // story.json exists and the open-blueprint signal re-reads the snapshot.
    const root = await seedProject(window)
    seedGraphFixture(root)
    await activateProject(window, root)

    // A thread must be active for the story card to render into the feed
    // (made directly — "+" opens the new-thread page, which sends a message).
    await openEmptyThread(window, root)
    await expect(window.locator(sel.composer)).toBeVisible()
    await expect(window.locator('.fl-story-card')).toHaveCount(0)

    // Now the story compiles (e.g. `blueprint narrate` ran) — write it, then
    // fire the same decoupled 'flow:open-blueprint' signal the status-bar
    // Blueprint button dispatches (conversation-pane.ts's #openBlueprintHandler
    // re-reads the active root's snapshot on this event).
    seedStoryFixture(root)
    await window.locator(statusButtonByText('Blueprint')).click()

    const storyCard = window.locator('.fl-story-card')
    await expect(storyCard).toBeVisible({ timeout: 10_000 })
    await expect(window.locator('.fl-conv-entry-story')).toBeVisible()
    await expect(storyCard.locator('.fl-story-title')).toHaveText('The problem')
    await expect(storyCard.locator('.fl-story-nav-label')).toHaveText('STEP 1 / 2')

    // Minimize collapses the body and flips the toggle label.
    const toggle = storyCard.locator('.fl-story-toggle')
    await expect(toggle).toHaveText('Minimize')
    await toggle.click()
    await expect(storyCard).toHaveClass(/fl-story-minimized/)
    await expect(toggle).toHaveText('Expand')
    await expect(storyCard.locator('.fl-story-body')).toBeHidden()

    // Expand again, then Next advances to the second step.
    await toggle.click()
    await expect(storyCard).not.toHaveClass(/fl-story-minimized/)
    await storyCard.locator('.fl-story-nav-btn', { hasText: 'Next' }).click()
    await expect(storyCard.locator('.fl-story-title')).toHaveText('The shape')
    await expect(storyCard.locator('.fl-story-nav-label')).toHaveText('STEP 2 / 2')

    expect(errors, `uncaught errors during story-card flow:\n${errors.join('\n')}`).toEqual([])
  })

  // A story belongs to the thread that engaged with it — it must NOT leak into
  // an unrelated, brand-new thread (the reported bug: a fresh thread showed a
  // story from another thread). Owning-thread scoping (story-card-model
  // StoryOwnership): a thread adopts an orphan story on open-blueprint; other
  // threads never show it.
  test('a story does not appear in an unrelated new thread (owning-thread scoping)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    seedGraphFixture(root)
    seedStoryFixture(root)
    await activateProject(window, root)

    // Thread A: on creation the orphan story is NOT auto-shown (the bug was that
    // it auto-opened everywhere). It appears only after an intentional engage —
    // opening the blueprint from this thread (adopt).
    await openEmptyThread(window, root, 'Thread A')
    await expect(window.locator(sel.composer)).toBeVisible()
    await expect(window.locator('.fl-story-card')).toHaveCount(0)
    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator('.fl-story-card')).toBeVisible({ timeout: 10_000 })

    // Thread B: a brand-new, unrelated thread must NOT show thread A's story.
    await openEmptyThread(window, root, 'Thread B')
    await expect(window.locator(sel.composer)).toBeVisible()
    await expect(window.locator('.fl-story-card')).toHaveCount(0)

    expect(errors, `uncaught errors during story-scoping flow:\n${errors.join('\n')}`).toEqual([])
  })

})
