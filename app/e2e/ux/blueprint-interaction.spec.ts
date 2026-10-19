import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import {
  seedProject,
  activateProject,
  cleanupSeeds,
  openEmptyThread,
  waitForWorkspaceLink,
} from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * blueprint-interaction regression guard (Phase 6) — the chat-surfaced
 * ArtifactCard (threads/artifact-card.ts, Phase 2). Drives the real app end to
 * end: a real `.md` file dropped into `flow/discovery/` is picked up by the
 * main-process ArtifactObserver (artifact-observer.ts) and surfaced as a live
 * card in the active thread's feed. It reacts to the real chokidar watcher, so
 * the probe writes the doc after the project is active and waits for the
 * debounced (300ms) `flow:artifactChanged` event.
 *
 * The board half (a code-map module popover's Files section → peek drawer →
 * promote) went with the code map, which the code storyline replaced
 * (plan_code-storyline_v1 phase 7).
 */

test.describe('blueprint-interaction (Phase 6): artifact card', () => {
  test.afterAll(() => cleanupSeeds())

  test('an uncompiled discovery doc surfaces as a chat artifact card with a Narrate action', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    await activateProject(window, root)

    // A thread must be active — the card mounts into the active feed only.
    // (Made directly: "+" opens the new-thread page, which sends a message.)
    await openEmptyThread(window, root)
    await expect(window.locator(sel.composer)).toBeVisible()
    await expect(window.locator('.fl-artifact-card')).toHaveCount(0)

    // A doc written before the project is placed in its Workspace is COPIED by
    // placement and re-listed as history — never a live write, so never a card.
    // A person writes into a placed project; so does this probe.
    await waitForWorkspaceLink(root)

    // Drop a real discovery doc with an uncompiled `## Story` section — no
    // story.json exists, so the doc's status can only ever read 'uncompiled'
    // (see artifact-card-model.ts's deriveStoryStatus). The main-process
    // ArtifactObserver watches flow/discovery for exactly this file.
    const discoveryDir = join(root, 'flow', 'discovery')
    mkdirSync(discoveryDir, { recursive: true })
    writeFileSync(
      join(discoveryDir, 'discovery_widget_v1.md'),
      '# Widget discovery\n\nSome requirements text.\n\n## Story\n\n### Step: The problem\n',
    )

    const card = window.locator('.fl-artifact-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(window.locator('.fl-conv-entry-artifact')).toBeVisible()
    await expect(card.locator('.fl-artifact-eyebrow')).toHaveText('DISCOVERY')
    await expect(card.locator('.fl-artifact-title')).toHaveText('Widget discovery')
    // No story-status pill: the doc's kind is its identity; the `## Story`
    // state is internal and only decides which action renders below.
    await expect(card.locator('.fl-artifact-status')).toHaveCount(0)

    // The card itself is the affordance (click → doc opens as rendered md
    // preview). Its action row is the discovery's NEXT STEPS since the artifact
    // and plan doors landed on the card (2026-10-08): Create the plan, Open md
    // file, and — no walkthrough page exists — Generate artifact. Nothing
    // about the Story: no Narrate button, as before.
    await expect(card.locator('.fl-artifact-btn')).toHaveText([
      'Create the plan',
      'Open md file',
      'Generate artifact',
    ])
    await expect(card).toHaveAttribute('role', 'button')
    await card.click()
    // The doc opens as an editor TAB (markdown preview active by default).
    await expect(
      window.locator('.fl-shell fl-tabs .tab', { hasText: 'discovery_widget_v1.md' }),
    ).toBeVisible({ timeout: 10_000 })

    expect(errors, `uncaught errors during artifact-card flow:\n${errors.join('\n')}`).toEqual([])
  })
})
