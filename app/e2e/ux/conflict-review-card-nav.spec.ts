/**
 * The "Resolve with AI" review card lets the user jump from a proposal to the hunk
 * in the file (read the code before Accept/Reject). Reaching a card from a real
 * agent turn needs credentials (see the fixme in conflict-identity-resolve.spec.ts),
 * so this drives the card directly: dispatch CONFLICT_REVIEW_EVENT to mount it, then
 * assert its per-row location control dispatches `flow:open-file` with the hunk id —
 * the same event the editor's reveal handler consumes to scroll the conflict in view.
 */
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'

test('review-card location control navigates to the hunk via flow:open-file', async ({
  window,
}: {
  window: Page
}) => {
  // Show Threads so the conversation-pane (owns the feed, listens for the review
  // event) is mounted.
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Threads"]').click()

  const result = await window.evaluate(async () => {
    const captured: Array<Record<string, unknown>> = []
    document.addEventListener('flow:open-file', (e) =>
      captured.push((e as CustomEvent).detail as Record<string, unknown>),
    )
    const noop = async (): Promise<void> => {}
    const detail = {
      inputs: [
        {
          proposal: {
            file: 'notes.txt',
            blockId: 0,
            choice: 'ours',
            resolvedContent: 'x',
            risk: 'safe',
            confidence: 0.9,
            why: 'keep the current side',
            how: '',
          },
          identity: { kind: 'ours', ref: 'HEAD', branch: 'main', isCurrentUser: true },
          side: 'a',
          rootPath: '/tmp/demo-root',
          filePath: 'notes.txt',
          hunkId: 'hunk-xyz-1',
        },
      ],
      onDecision: noop,
      onDecisionAll: noop,
    }
    document.dispatchEvent(new CustomEvent('flow:conflict-review', { detail }))
    await new Promise((r) => setTimeout(r, 300))
    const loc = document.querySelector<HTMLButtonElement>(
      '.fl-conflict-card .fl-conflict-row .fl-conflict-location',
    )
    const locText = loc?.textContent ?? null
    loc?.click()
    await new Promise((r) => setTimeout(r, 100))
    return { cardMounted: !!loc, locText, captured }
  })

  expect(result.cardMounted, 'the review card + its location control mounted').toBe(true)
  expect(result.locText).toContain('notes.txt')
  expect(result.captured.length, 'clicking the location dispatched flow:open-file').toBeGreaterThan(0)
  expect(result.captured[0]).toMatchObject({
    rootPath: '/tmp/demo-root',
    relPath: 'notes.txt',
    revealConflictHunkId: 'hunk-xyz-1',
  })
})
