import { test, expect } from '../fixtures/electron'

/**
 * Notifications — multi blocked-prompt card management (flow 13, round 11).
 *
 * The notification center keeps ONE live reply card per root: a newer prompt
 * for the SAME root REPLACES the older card (notification-center.ts:149,
 * `promptCards.get(rootId)?.remove()`), while prompts for DIFFERENT roots
 * COEXIST (one reply box per blocked task). Prior flow-13 rounds all drove a
 * single blocked prompt (reply / reply-sent / dismiss / actionable-toast) — the
 * multi-card bookkeeping was never exercised end-to-end.
 *
 * Why it matters to a user: if the same-root replacement broke, a superseded
 * prompt's reply box would linger beside the current one, and answering the
 * stale card would send a reply for a promptId the daemon has already moved past
 * — a silent mis-reply. If different-root coexistence broke, a second blocked
 * task would clobber the first task's only in-app reply affordance. This probe
 * asserts: (1) same-root replacement keeps exactly one card showing the CURRENT
 * question, (2) different roots each keep their own live card, and (3) the toast
 * stack stays elevated above the inbox while any prompt is live (#459/#463).
 *
 * Driven headless via the `flow:notify` bridge (same path index.ts consumes) —
 * no Claude account / daemon needed.
 */

/** Dispatch a sticky blocked-prompt via the flow:notify bridge. */
async function blockedPrompt(
  window: import('@playwright/test').Page,
  detail: { rootId: string; promptId: string; title: string; body: string },
): Promise<void> {
  await window.evaluate((d) => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'blocked-prompt',
          rootId: d.rootId,
          promptId: d.promptId,
          title: d.title,
          body: d.body,
          timestamp: new Date().toISOString(),
          level: 'error',
        },
      }),
    )
  }, detail)
}

const ROOT_A = '/tmp/ux-multi-prompt-a'
const ROOT_B = '/tmp/ux-multi-prompt-b'

test.describe('notifications / multiple blocked-prompt cards', () => {
  test('same-root prompt replaces its card, different roots coexist, stack stays elevated', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const replyCards = window.locator('.fl-flow-toast:has(.fl-flow-reply)')
    const stack = window.locator('.fl-flow-toasts')

    // 1. Root A blocks with its FIRST question → exactly one sticky reply card,
    //    rendering that question. The stack elevates above the inbox (a live
    //    reply box must never be occluded, #459).
    await blockedPrompt(window, {
      rootId: ROOT_A,
      promptId: 'a-1',
      title: 'Task blocked: deploy A',
      body: 'Approve **FIRST-A** migration?',
    })
    await expect(replyCards).toHaveCount(1)
    await expect(window.locator('.fl-flow-md', { hasText: 'FIRST-A' })).toHaveCount(1)
    await expect(stack).toHaveClass(/fl-flow-toasts--sticky/)

    // 2. Root A blocks again with a SECOND (superseding) question. The center
    //    keeps ONE card per root: the old card is removed and replaced, so the
    //    user sees only the current question — never a stale reply box beside it.
    await blockedPrompt(window, {
      rootId: ROOT_A,
      promptId: 'a-2',
      title: 'Task blocked: deploy A (revised)',
      body: 'Actually, approve **SECOND-A** rollback instead?',
    })
    await expect(replyCards).toHaveCount(1) // still ONE, not two
    await expect(window.locator('.fl-flow-md', { hasText: 'SECOND-A' })).toHaveCount(1)
    // The superseded question's card is gone — no lingering stale reply box.
    await expect(window.locator('.fl-flow-md', { hasText: 'FIRST-A' })).toHaveCount(0)

    // 3. A DIFFERENT task (root B) blocks. Its card must COEXIST with root A's —
    //    two blocked tasks, two independent reply affordances.
    await blockedPrompt(window, {
      rootId: ROOT_B,
      promptId: 'b-1',
      title: 'Task blocked: deploy B',
      body: 'Approve **ONLY-B** release?',
    })
    await expect(replyCards).toHaveCount(2)
    await expect(window.locator('.fl-flow-md', { hasText: 'SECOND-A' })).toHaveCount(1)
    await expect(window.locator('.fl-flow-md', { hasText: 'ONLY-B' })).toHaveCount(1)
    // Stack still elevated with two live prompts.
    await expect(stack).toHaveClass(/fl-flow-toasts--sticky/)

    // Both reply boxes are independently usable — typing into one does not touch
    // the other (they are distinct DOM nodes, not a shared textarea).
    const boxes = window.locator('.fl-flow-reply')
    await expect(boxes).toHaveCount(2)
    await boxes.nth(0).fill('answer for the first visible task')
    await expect(boxes.nth(0)).toHaveValue('answer for the first visible task')
    await expect(boxes.nth(1)).toHaveValue('')

    await window.screenshot({ path: 'e2e/ux/__screens/notifications-multi-prompt-cards.png' })

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })
})
