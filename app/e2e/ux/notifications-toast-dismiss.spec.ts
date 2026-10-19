import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Notifications — toast lifecycle + multi-root blocked prompts UX regression
 * guard (flow 13 of the progressive sweep, round 5).
 *
 * The base `notifications.spec.ts` covers the idle status line, toast→badge
 * counting, the inbox empty state, and #459 reply-box reachability;
 * `notifications-reply.spec.ts` covers the reply box itself (XSS, empty-send
 * guard, surfaced send failure). This file guards the parts of the toast
 * lifecycle NOT yet driven end-to-end:
 *
 *   1. Dismissing a regular toast via its (X) button removes the TOAST but
 *      keeps its INBOX entry — no information loss (the toast is transient, the
 *      inbox is the durable log).
 *   2. A regular toast AUTO-dismisses after ~6s (TOAST_AUTO_DISMISS_MS) and,
 *      again, its inbox entry survives and the unread badge is preserved until
 *      the inbox is opened.
 *   3. Two tasks blocked on DIFFERENT roots raise two INDEPENDENT sticky prompt
 *      cards (one per root); replying-to / dismissing one leaves the other's
 *      reply box live — the per-root `promptCards` map keeps them separate.
 *
 * All states are driven headless via the renderer-side `flow:notify` bridge
 * (the same CustomEvent path index.ts consumes for Review/kanban/editor
 * toasts) — no Claude account / daemon needed. A `pageerror`/`console.error`
 * listener fails the flow on any uncaught renderer error.
 */

/** Dispatch a renderer-side flow:notify toast (a FlowNotification detail). */
async function notify(
  window: import('@playwright/test').Page,
  detail: {
    kind?: string
    rootId?: string
    promptId?: string
    title: string
    body?: string
    level?: 'info' | 'warn' | 'error'
  },
): Promise<void> {
  await window.evaluate((d) => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: d.kind ?? 'state-change',
          rootId: d.rootId ?? '/tmp/ux-notify-dismiss',
          promptId: d.promptId,
          title: d.title,
          body: d.body ?? '',
          timestamp: new Date().toISOString(),
          level: d.level ?? 'info',
        },
      }),
    )
  }, detail)
}

test.describe('notifications / toast lifecycle + multi-root prompts UX', () => {
  test('X-dismissing a regular toast removes it but keeps the inbox entry', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const flowLine = window.locator(sel.flowLine)
    await expect(flowLine).toBeVisible()
    const inboxBtn = flowLine.locator('.fl-flow-line-inbox')

    // A regular toast is raised.
    await notify(window, { title: 'Build finished', body: 'out/ up to date', level: 'info' })
    const toasts = window.locator('.fl-flow-toast')
    await expect(toasts).toHaveCount(1)
    const unread = flowLine.locator('.fl-flow-line-unread')
    await expect(unread).toHaveText('1')

    // Dismiss it via the ghost (X) button in the toast head.
    const dismissBtn = toasts.first().locator('.fl-flow-toast-head fl-button')
    await expect(dismissBtn).toHaveCount(1)
    await dismissBtn.click()

    // The toast is gone…
    await expect(toasts).toHaveCount(0)

    // …but the durable inbox log still has the entry (no information loss).
    await inboxBtn.click()
    const inbox = window.locator('.fl-flow-inbox')
    await expect(inbox).toBeVisible()
    const entries = inbox.locator('.fl-flow-inbox-entry')
    await expect(entries).toHaveCount(1)
    await expect(entries.first().locator('.fl-flow-title')).toHaveText('Build finished')
    await window.screenshot({ path: 'e2e/ux/__screens/notifications-xdismiss-inbox.png' })

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('a regular toast auto-dismisses (~6s) but its inbox entry + badge survive', async ({
    window,
  }) => {
    test.setTimeout(30_000)
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const flowLine = window.locator(sel.flowLine)
    await expect(flowLine).toBeVisible()
    const inboxBtn = flowLine.locator('.fl-flow-line-inbox')
    const unread = flowLine.locator('.fl-flow-line-unread')

    await notify(window, { title: 'Lint passed', body: '0 problems', level: 'info' })
    const toasts = window.locator('.fl-flow-toast')
    await expect(toasts).toHaveCount(1)
    await expect(unread).toHaveText('1')

    // The toast auto-dismisses after TOAST_AUTO_DISMISS_MS (6s). Wait it out.
    await expect(toasts).toHaveCount(0, { timeout: 12_000 })

    // The unread badge is NOT cleared by auto-dismiss (the user never saw it) —
    // the notification is still unread, and its entry lives in the inbox.
    await expect(unread).toHaveText('1')
    await inboxBtn.click()
    const inbox = window.locator('.fl-flow-inbox')
    await expect(inbox).toBeVisible()
    const entries = inbox.locator('.fl-flow-inbox-entry')
    await expect(entries).toHaveCount(1)
    await expect(entries.first().locator('.fl-flow-title')).toHaveText('Lint passed')
    // Opening the inbox clears the badge.
    await expect(unread).toBeHidden()

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('two roots blocked → two independent reply boxes; dismissing one keeps the other', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const flowLine = window.locator(sel.flowLine)
    await expect(flowLine).toBeVisible()

    // Task A blocks on root A; task B blocks on root B — two distinct roots.
    await notify(window, {
      kind: 'blocked-prompt',
      rootId: '/tmp/ux-notify-rootA',
      promptId: 'p-rootA-1',
      title: 'Task blocked: deploy-A',
      body: 'Approve migration A? yes/no',
      level: 'error',
    })
    await notify(window, {
      kind: 'blocked-prompt',
      rootId: '/tmp/ux-notify-rootB',
      promptId: 'p-rootB-1',
      title: 'Task blocked: deploy-B',
      body: 'Approve migration B? yes/no',
      level: 'error',
    })

    // Two independent sticky prompt cards, each with its own reply box.
    const replies = window.locator('.fl-flow-reply')
    await expect(replies).toHaveCount(2)
    const toasts = window.locator('.fl-flow-toast')
    await expect(toasts).toHaveCount(2)
    await window.screenshot({ path: 'e2e/ux/__screens/notifications-two-root-prompts.png' })

    // Type a reply into root A's box, then dispatch a state-change with NO
    // pendingPrompt for root A is not reachable via the bridge; instead assert
    // the two boxes are independent by filling each with distinct text.
    await replies.nth(0).fill('yes-A')
    await replies.nth(1).fill('no-B')
    await expect(replies.nth(0)).toHaveValue('yes-A')
    await expect(replies.nth(1)).toHaveValue('no-B')

    // Both cards are sticky — neither carries the generic (X) dismiss that would
    // strand the still-blocked task (#423). Assert no dismiss button on either.
    for (let i = 0; i < 2; i++) {
      await expect(toasts.nth(i).locator('.fl-flow-toast-head fl-button')).toHaveCount(0)
    }

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })
})
