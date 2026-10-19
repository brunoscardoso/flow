import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, waitForWorkspaceLink } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Regression guard for #1056 — reopening a thread must render each artifact
 * card (DISCOVERY / PLAN / BRAINSTORM doc preview) INLINE at the transcript
 * position where the doc was created, not piled at the bottom of the chat.
 *
 * Mechanism under test, end to end: the main-process ArtifactObserver persists
 * a `[artifact] <kind> <path>` system marker row (shared/artifact-marker.ts)
 * into the ACTIVE thread when it first observes a doc; the pane's history
 * builder renders that row as the same ArtifactCard the live path shows, at
 * the row's own position, and the feed-end pile skips marker-backed docs.
 *
 * Legacy docs (existing before any thread observed them — no marker anywhere)
 * keep the old fallback: one latest-per-kind card at the feed end, never
 * duplicated.
 */

const SCREENS = 'e2e/ux/__screens'

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

async function appendMessage(
  win: Page,
  threadId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): Promise<void> {
  await win.evaluate(
    async ({ threadId, role, content }) => {
      await (
        window as unknown as {
          flow: {
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
        }
      ).flow.messages.append({ threadId, role, content })
    },
    { threadId, role, content },
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

/** The feed's entry sequence, each entry tagged by what it renders. */
async function feedShape(win: Page): Promise<string[]> {
  return win.evaluate(() => {
    const entries = Array.from(document.querySelectorAll('.fl-conv-feed > .fl-conv-entry'))
    return entries.map((entry) => {
      if (entry.querySelector('.fl-artifact-card')) return 'artifact'
      const text = entry.textContent ?? ''
      if (text.includes('before the doc')) return 'user:before'
      if (text.includes('after the doc')) return 'user:after'
      return 'other'
    })
  })
}

test.describe('artifact card inline position (#1056)', () => {
  test.afterAll(() => cleanupSeeds())

  test('a doc observed mid-thread re-renders INLINE between its neighbors after reopen — not at the bottom', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    await activateProject(window, root)

    // Thread A — active when the doc lands, so the marker row is persisted here.
    const threadA = await createThread(window, root, 'Thread A')
    await openThread(window, 'Thread A')
    await expect(window.locator(sel.composer)).toBeVisible()

    await appendMessage(window, threadA, 'user', 'before the doc')
    await waitForWorkspaceLink(root)

    // A real brainstorm doc dropped under flow/ — picked up by the main-process
    // watcher, surfaced live, and durably marked at this transcript position.
    const dir = join(root, 'flow', 'brainstorms')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'brainstorm_widget.md'), '# Widget brainstorm\n\nLoose ideas.\n')
    await expect(window.locator('.fl-artifact-card')).toBeVisible({ timeout: 10_000 })

    await appendMessage(window, threadA, 'user', 'after the doc')

    // Leave for thread B, then reopen A — the feed rebuilds from persisted rows.
    await createThread(window, root, 'Thread B')
    await openThread(window, 'Thread B')
    await window.waitForTimeout(600)
    await openThread(window, 'Thread A')
    await expect(window.getByText('after the doc', { exact: true })).toBeVisible()

    // Exactly ONE card, positioned BETWEEN its neighbor messages — the bottom
    // pile (feed-end re-append) is gone.
    await expect(window.locator('.fl-artifact-card')).toHaveCount(1)
    const shape = await feedShape(window)
    const before = shape.indexOf('user:before')
    const card = shape.indexOf('artifact')
    const after = shape.indexOf('user:after')
    expect(shape.filter((kind) => kind === 'artifact')).toHaveLength(1)
    expect(before, `feed shape: ${shape.join(', ')}`).toBeGreaterThanOrEqual(0)
    expect(card, `feed shape: ${shape.join(', ')}`).toBeGreaterThan(before)
    expect(after, `feed shape: ${shape.join(', ')}`).toBeGreaterThan(card)
    expect(shape[shape.length - 1], 'card must not sit at the feed end').not.toBe('artifact')

    await window.screenshot({ path: `${SCREENS}/artifact-inline-after-reopen.png` })
    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('a regenerated discovery keeps a card PER VERSION, each at its own position, after reopen', async ({ window }) => {
    // User report 2026-10-01: a thread that regenerated its discovery eight
    // times showed only the first card — later versions were folded into it.
    // Every version now keeps its own card where it was written, so any two can
    // be compared. (This test asserted the opposite — ONE adopted card — until
    // that call.) The two marker rows are seeded directly — the rows main
    // persists when it observes each doc — because the chokidar watcher is
    // unreliable for a seeded macOS temp project (the live path is covered by
    // the test above).
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    const root = await seedProject(window, 'flow-ux-versions-', (dir) => {
      mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
      writeFileSync(join(dir, 'flow', 'discovery', 'discovery_widget_v1.md'), '# Widget discovery one\n\nFirst pass.\n')
      writeFileSync(join(dir, 'flow', 'discovery', 'discovery_widget_v2.md'), '# Widget discovery two\n\nSecond pass.\n')
    })
    await activateProject(window, root)
    const thread = await createThread(window, root, 'Regenerate thread')
    await appendMessage(window, thread, 'user', 'first discovery')
    await appendMessage(window, thread, 'system', '[artifact] discovery flow/discovery/discovery_widget_v1.md')
    await appendMessage(window, thread, 'user', 'generate again')
    await appendMessage(window, thread, 'system', '[artifact] discovery flow/discovery/discovery_widget_v2.md')
    await openThread(window, 'Regenerate thread')
    await expect(window.getByText('generate again', { exact: true })).toBeVisible()

    // TWO cards, in transcript order, each showing its OWN version's title.
    const cards = window.locator('.fl-artifact-card')
    await expect(cards).toHaveCount(2)
    await expect(cards.nth(0).locator('.fl-artifact-title')).toHaveText('Widget discovery one', { timeout: 10_000 })
    await expect(cards.nth(1).locator('.fl-artifact-title')).toHaveText('Widget discovery two', { timeout: 10_000 })
    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('a legacy doc with no marker renders NO card at all — history stays clean', async ({
    window,
  }) => {
    const root = await seedProject(window, 'flow-ux-legacy-', (dir) => {
      // The doc exists BEFORE the project is added/observed — no live watcher
      // event ever fires for it, so no marker row exists anywhere (#1056's
      // legacy-doc path: seeded via flow:listArtifacts on activation).
      mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
      writeFileSync(
        join(dir, 'flow', 'discovery', 'discovery_legacy_v1.md'),
        '# Legacy discovery\n\nOld doc.\n',
      )
    })
    await activateProject(window, root)

    await createThread(window, root, 'Legacy thread')
    await openThread(window, 'Legacy thread')
    // Follow-up to #1056 (user call 2026-07-28: "still showing on the bottom
    // things generated days ago"): SEEDED historical docs never pin a feed-end
    // card. Only a live change this session (which also writes a marker) does.
    // Placement in the Workspace copies the doc and the watch RE-LISTS it —
    // still history, never a write, so still no card.
    await waitForWorkspaceLink(root)
    await window.waitForTimeout(1_200)
    await expect(window.locator('.fl-artifact-card', { hasText: 'Legacy discovery' })).toHaveCount(0)

    // A LIVE change to the same doc during the session brings the card back —
    // at the observation position, marker-backed from here on.
    writeFileSync(
      join(root, 'flow', 'discovery', 'discovery_legacy_v1.md'),
      '# Legacy discovery\n\nOld doc, refreshed now.\n',
    )
    await expect(window.locator('.fl-artifact-card', { hasText: 'Legacy discovery' })).toBeVisible({
      timeout: 15_000,
    })

    await window.screenshot({ path: `${SCREENS}/artifact-legacy-clean.png` })
  })
})
