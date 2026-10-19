import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Notifications / flow status line UX regression guard — flow 13 of the
 * progressive sweep.
 *
 * The status line (bottom-right of the status bar) shows `flow: idle`,
 * `autopilot off`, and an inbox button. Clicking the inbox toggles the
 * notification center panel. In-session toasts are raised by any component
 * dispatching a `flow:notify` CustomEvent (the renderer-side toast bridge,
 * flow/index.ts) — the same path the Review panel / kanban / editor use — so
 * we can drive real toasts headless, no Claude account needed.
 *
 * This drives, against a fresh launch (no project needed — the status line is
 * always mounted):
 *   1. the status line renders idle + inbox button,
 *   2. the inbox opens to its empty state and toggles closed,
 *   3. dispatched notifications raise toasts AND bump the unread badge,
 *   4. opening the inbox clears the badge and lists the entries.
 *
 * A `pageerror`/`console.error` listener fails the flow on any uncaught
 * renderer error during these interactions.
 */

/** Dispatch a renderer-side flow:notify toast (the FlowNotification bridge). */
async function notify(
  window: import('@playwright/test').Page,
  detail: { title: string; body?: string; level?: 'info' | 'warn' | 'error' },
): Promise<void> {
  await window.evaluate((d) => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '/tmp/ux-notify',
          title: d.title,
          body: d.body ?? '',
          timestamp: new Date().toISOString(),
          level: d.level ?? 'info',
        },
      }),
    )
  }, detail)
}

test.describe('notifications / flow status line UX', () => {
  test('status line renders idle, inbox toggles, toasts bump then clear the badge', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    // 1. The flow status line is mounted in the status bar with an inbox button.
    //    (Its `flow: idle` / `autopilot off` readouts were retired 2026-09-04 —
    //    status-line.ts keeps only what is a notification: blocked + unread.)
    const flowLine = window.locator(sel.flowLine)
    await expect(flowLine).toBeVisible()
    await expect(flowLine.locator('.fl-flow-line-blocked')).toBeHidden()
    const inboxBtn = flowLine.locator('.fl-flow-line-inbox')
    await expect(inboxBtn).toBeVisible()
    // Fresh launch, no notifications → no unread badge.
    await expect(flowLine.locator('.fl-flow-line-unread')).toBeHidden()

    const inbox = window.locator('.fl-flow-inbox')
    await expect(inbox).toBeHidden()

    // 2. Open the inbox → empty state; toggle closed again.
    await inboxBtn.click()
    await expect(inbox).toBeVisible()
    await expect(inbox.locator('.fl-flow-inbox-header')).toHaveText('Notifications')
    await expect(inbox.locator('.fl-flow-inbox-empty')).toHaveText('No notifications yet')
    await window.screenshot({ path: 'e2e/ux/__screens/notifications-inbox-empty.png' })
    await inboxBtn.click()
    await expect(inbox).toBeHidden()

    // 3. Dispatch two toasts → toasts render and the unread badge counts them.
    await notify(window, { title: 'Task completed', body: 'Phase 2 done', level: 'info' })
    await notify(window, { title: 'Lint failed', body: '3 problems', level: 'warn' })
    const toasts = window.locator('.fl-flow-toast')
    await expect(toasts).toHaveCount(2)
    const unread = flowLine.locator('.fl-flow-line-unread')
    await expect(unread).toBeVisible()
    await expect(unread).toHaveText('2')
    await window.screenshot({ path: 'e2e/ux/__screens/notifications-toasts.png' })

    // 4. Open the inbox → badge clears and both entries are listed (newest first).
    await inboxBtn.click()
    await expect(inbox).toBeVisible()
    await expect(unread).toBeHidden()
    const entries = inbox.locator('.fl-flow-inbox-entry')
    await expect(entries).toHaveCount(2)
    await expect(entries.first().locator('.fl-flow-title')).toHaveText('Lint failed')
    await expect(inbox.locator('.fl-flow-inbox-empty')).toHaveCount(0)

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })

  // Regression guard for #459 (fixed by #463): when the inbox is OPEN and a task
  // then blocks, the sticky blocked-prompt toast — which carries the ONLY reply
  // affordance (textarea + Send reply) — used to render behind the inbox panel and
  // be unreachable. Both `.fl-flow-toasts` (z 1000) and `.fl-flow-inbox` (z 1001)
  // are fixed at the same bottom-right 340px slot, so an open inbox opaquely
  // covered the prompt. The fix (#463) lifts the toast stack to z 1002 while any
  // sticky prompt is live (`.fl-flow-toasts--sticky`), so the reply box is always
  // reachable. This guard asserts that invariant — the reply box is the topmost
  // element at its own center even with the inbox open.
  test(
    'a blocked-prompt reply box is reachable even when the inbox is open (#459)',
    async ({ window }) => {
      const flowLine = window.locator(sel.flowLine)
      await expect(flowLine).toBeVisible()
      const inboxBtn = flowLine.locator('.fl-flow-line-inbox')

      // User is browsing notification history — inbox open.
      await inboxBtn.click()
      const inbox = window.locator('.fl-flow-inbox')
      await expect(inbox).toBeVisible()

      // A background task blocks → a sticky blocked-prompt toast with a reply box.
      await window.evaluate(() => {
        document.dispatchEvent(
          new CustomEvent('flow:notify', {
            detail: {
              kind: 'blocked-prompt',
              rootId: '/tmp/ux-notify',
              promptId: 'p-occlude-1',
              title: 'Task blocked: deploy',
              body: 'Approve the migration? Reply yes/no.',
              timestamp: new Date().toISOString(),
              level: 'error',
            },
          }),
        )
      })

      const reply = window.locator('.fl-flow-reply')
      await expect(reply).toHaveCount(1)

      // The reply box must be the topmost element at its own center — i.e. not
      // covered by the inbox panel (the #463 z-index elevation guarantees this).
      const topElIsReply = await window.evaluate(() => {
        const r = document.querySelector('.fl-flow-reply') as HTMLElement | null
        if (!r) return false
        const box = r.getBoundingClientRect()
        const topEl = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return topEl === r || r.contains(topEl)
      })
      expect(
        topElIsReply,
        'blocked-prompt reply box should be reachable (topmost at its own center), not hidden behind the inbox',
      ).toBe(true)
    },
  )
})
