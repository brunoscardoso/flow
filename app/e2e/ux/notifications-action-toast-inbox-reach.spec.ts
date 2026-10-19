import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import type { Page } from '@playwright/test'

/**
 * Notifications — actionable toast reachability WHILE THE INBOX IS OPEN
 * (flow 13 of the progressive sweep, round 10). Probes a previously un-probed
 * seam between two shipped invariants:
 *
 *   - #459/#463: the toast stack (`.fl-flow-toasts`, z 1000) and the inbox panel
 *     (`.fl-flow-inbox`, z 1001) occupy the SAME fixed bottom-right 340px slot, so
 *     an OPEN inbox opaquely covers whatever is in the toast stack. #463 fixed this
 *     for STICKY blocked-prompt cards by lifting the stack to z 1002 while any
 *     sticky card is live (`.fl-flow-toasts--sticky`).
 *   - #582: an ACTIONABLE toast ("… · [Open blueprint]") is PERSISTENT and carries
 *     a click-required action button — the whole point is the user clicks it.
 *
 * The elevation in #463 fires ONLY for sticky blocked-prompts
 * (`shouldElevateToasts(promptCards.size)`; an actionable toast is a `state-change`
 * with an `action`, never added to `promptCards`). So an actionable toast that
 * arrives while the inbox is open is the EXACT #459 failure mode, unfixed: its
 * action button renders behind the open inbox and is un-clickable.
 *
 * This drives it end-to-end: open the inbox, raise an actionable toast, and assert
 * the action button is the topmost element at its own center (reachable).
 *
 * STATUS: this reproduces issue #769 (OPEN) — on current `main` the action button
 * IS occluded by the inbox (`elementFromPoint` at its center returns an inbox
 * entry, not the button), so this assertion currently fails. It is kept as a
 * `test.fixme` pending regression guard: when #769 is fixed (extend the #463
 * toast-stack elevation to cover actionable toasts, not just sticky prompt cards),
 * drop the `.fixme` to make it a live guard.
 */

/** Dispatch a renderer-side flow:notify actionable toast. */
async function notifyAction(window: Page): Promise<void> {
  await window.evaluate(() => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '/tmp/ux-action-reach',
          title: 'Module learned',
          body: 'src · understanding refreshed',
          timestamp: new Date().toISOString(),
          level: 'info',
          action: { label: 'Open blueprint', event: 'flow:open-blueprint', openLearning: true },
        },
      }),
    )
  })
}

test('an actionable toast is reachable even when the inbox is open (#769)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  window.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })

  const flowLine = window.locator(sel.flowLine)
  await expect(flowLine).toBeVisible()

  // User is browsing notification history — inbox open.
  await flowLine.locator('.fl-flow-line-inbox').click()
  const inbox = window.locator('.fl-flow-inbox')
  await expect(inbox).toBeVisible()

  // A background learn/discovery finishes → a persistent actionable toast with a
  // click-required "Open blueprint" button.
  await notifyAction(window)
  const actionable = window.locator('.fl-flow-toast', { hasText: 'Module learned' })
  await expect(actionable).toBeVisible()
  const actionBtn = actionable.locator('.fl-flow-prompt-actions fl-button')
  await expect(actionBtn).toHaveText('Open blueprint')

  await window.screenshot({
    path: 'e2e/ux/__screens/notifications-action-toast-inbox-open.png',
  })

  // The action button must be the topmost element at its own center — i.e. not
  // covered by the inbox panel. This is the same reachability invariant #463
  // guarantees for sticky prompt cards; an actionable toast should get it too.
  const topElIsBtn = await window.evaluate(() => {
    const btn = document.querySelector(
      '.fl-flow-toast .fl-flow-prompt-actions fl-button',
    ) as HTMLElement | null
    if (!btn) return { reachable: false, topTag: 'none' }
    const box = btn.getBoundingClientRect()
    const topEl = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    return {
      reachable: topEl === btn || btn.contains(topEl) || (topEl != null && topEl.closest('.fl-flow-toast') != null),
      topTag: topEl ? `${topEl.tagName.toLowerCase()}.${(topEl as HTMLElement).className}` : 'null',
    }
  })

  expect(
    topElIsBtn.reachable,
    `actionable toast's action button should be reachable (topmost at its own center) even with the inbox open, but the top element there is ${topElIsBtn.topTag} — the inbox occludes it`,
  ).toBe(true)

  expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
})
