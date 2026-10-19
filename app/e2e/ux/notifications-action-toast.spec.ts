import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Notifications — actionable ("deep-link") toast UX regression guard (flow 13 of
 * the progressive sweep, round 10). Covers a previously un-probed core surface:
 * the ACTION-button notification (#582).
 *
 * Most flow-notifications auto-dismiss after ~6s (TOAST_AUTO_DISMISS_MS). But a
 * notification carrying an `action` (e.g. "… · [Open blueprint]", raised by the
 * learn-orchestrator when a background learn/discovery finishes) is DIFFERENT in
 * two user-critical ways (notification-center.ts ~L157-179):
 *   1. It is PERSISTENT — it does NOT auto-dismiss, because a 6s timeout would
 *      rob the user of the action before they could click it.
 *   2. Clicking its action button dispatches the deep-link CustomEvent
 *      (`flow:open-blueprint`, and — with `openLearning` — `flow:open-learning-panel`)
 *      AND removes the toast. A dead action button, or a toast that vanished
 *      before the click, would strand the user at the very moment the app is
 *      inviting them somewhere.
 *
 * Every prior flow-13 round drove regular toasts, the badge, the inbox, the
 * blocked-prompt reply box, and multi-root prompts — NONE drove an actionable
 * toast's persistence or its action button. This guard drives both.
 *
 * Toasts are raised headless via the renderer-side `flow:notify` bridge (index.ts
 * L103-105 forwards the full FlowNotification detail — `action` included — to
 * center.notify, exactly as the main-process FlowObserver path does), so no
 * Claude account / daemon is needed. The action's real target (`flow:open-blueprint`)
 * opens the live Blueprint board as an editor tab (blueprint/index.ts
 * openBlueprintTab), which we assert mounts.
 *
 * A `pageerror`/`console.error` listener fails the flow on any uncaught error.
 */

test.afterAll(() => cleanupSeeds())

const TOAST_AUTO_DISMISS_MS = 6_000

/** Dispatch a renderer-side flow:notify toast (a FlowNotification detail). */
async function notify(
  window: Page,
  detail: {
    title: string
    body?: string
    level?: 'info' | 'warn' | 'error'
    action?: { label: string; event: string; openLearning?: boolean }
  },
): Promise<void> {
  await window.evaluate((d) => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '/tmp/ux-action-notify',
          title: d.title,
          body: d.body ?? '',
          timestamp: new Date().toISOString(),
          level: d.level ?? 'info',
          ...(d.action ? { action: d.action } : {}),
        },
      }),
    )
  }, detail)
}

test('an actionable toast is PERSISTENT while a regular toast auto-dismisses (#582)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  window.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })

  await expect(window.locator(sel.flowLine)).toBeVisible()

  // Raise a REGULAR toast and an ACTIONABLE toast back to back.
  await notify(window, { title: 'Lint finished', body: 'no problems', level: 'info' })
  await notify(window, {
    title: 'Module learned',
    body: 'src · understanding refreshed',
    level: 'info',
    action: { label: 'Open blueprint', event: 'flow:open-blueprint', openLearning: true },
  })

  const regular = window.locator('.fl-flow-toast', { hasText: 'Lint finished' })
  const actionable = window.locator('.fl-flow-toast', { hasText: 'Module learned' })
  await expect(regular).toBeVisible()
  await expect(actionable).toBeVisible()

  // The actionable toast carries a working action button (not a dead affordance).
  const actionBtn = actionable.locator('.fl-flow-prompt-actions fl-button')
  await expect(actionBtn).toHaveText('Open blueprint')

  await window.screenshot({ path: 'e2e/ux/__screens/notifications-action-toast.png' })

  // Wait past the auto-dismiss window: the REGULAR toast is gone, the ACTIONABLE
  // one PERSISTS (a 6s timeout would rob the user of the action).
  await expect(regular).toBeHidden({ timeout: TOAST_AUTO_DISMISS_MS + 3_000 })
  await expect(actionable).toBeVisible()
  await expect(actionBtn).toHaveText('Open blueprint')

  expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
})

test('clicking the toast action button opens the target AND dismisses the toast (#582)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  window.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })

  // A project must be active for the Blueprint board to mount when the deep-link
  // fires (openBlueprintTab → board.ensureLoaded needs a project root).
  const proj = await seedProject(window)
  await activateProject(window, proj)

  // Blueprint board is not open yet.
  await expect(window.locator('.flow-board-root')).toHaveCount(0)

  await notify(window, {
    title: 'Basic discovery started',
    body: 'Generating your project map…',
    level: 'info',
    action: { label: 'Open blueprint', event: 'flow:open-blueprint', openLearning: true },
  })

  const actionable = window.locator('.fl-flow-toast', { hasText: 'Basic discovery started' })
  await expect(actionable).toBeVisible()
  const actionBtn = actionable.locator('.fl-flow-prompt-actions fl-button')
  await expect(actionBtn).toHaveText('Open blueprint')

  // Click the deep-link: it opens the LIVE Blueprint board as an editor tab
  // (not a dead click). `.flow-board-root` mounts regardless of whether a graph
  // has been derived — the seeded repo has none, so the board shows its empty
  // state, but the NAVIGATION is what the action promises and is what we assert.
  await actionBtn.click()
  await expect(window.locator('.flow-board-root')).toBeVisible({ timeout: 10_000 })
  // `openLearning: true` also fires `flow:open-learning-panel` → the learning
  // panel (#582) reveals inside the board. This proves the compound deep-link
  // (both events) fired, not just the primary one.
  await expect(window.locator('.flow-board-root .fb-learn-panel')).toBeVisible({
    timeout: 10_000,
  })

  // … and dismisses its own toast (the invitation is consumed, no lingering card).
  await expect(actionable).toBeHidden({ timeout: 5_000 })

  // The durable inbox entry survives the toast dismissal (no information loss).
  await window.locator(sel.flowLine).locator('.fl-flow-line-inbox').click()
  const inbox = window.locator('.fl-flow-inbox')
  await expect(inbox).toBeVisible()
  await expect(
    inbox.locator('.fl-flow-inbox-entry', { hasText: 'Basic discovery started' }),
  ).toHaveCount(1)

  await window.screenshot({ path: 'e2e/ux/__screens/notifications-action-opened.png' })

  expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
})
