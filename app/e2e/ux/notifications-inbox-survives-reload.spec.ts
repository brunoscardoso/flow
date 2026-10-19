import { test, expect, dismissOnboarding } from '../fixtures/electron'
import { sel } from '../selectors'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * Notifications — the inbox is a DURABLE record, so View ▸ Reload must not
 * empty it (#1459).
 *
 * The inbox exists precisely because toasts are not durable: a toast holding a
 * multi-line failure reason auto-dismisses after 6s, so notification-center
 * keeps the WHOLE body in the inbox entry and expands it on click (#1075). It
 * is also the ONLY place renderer-raised notifications live — a failed save
 * (#195), a failed git diff (#192), a failed terminal spawn (#209), a review
 * commit outcome (#73) exist nowhere on disk.
 *
 * `inboxList` used to be plain DOM built at `initFlowUi` time and never
 * persisted, so `webContents.reload()` — the stock View ▸ Reload menu item —
 * destroyed all of it: the panel read "No notifications yet", the unread badge
 * reset to 0, and nothing indicated anything had ever been there. The same
 * reload deliberately restores the terminal session (#1445) and the editor's
 * buffers, which is what makes the silent loss a bug rather than a policy.
 *
 * Driven headless through the real `flow:notify` bridge (the CustomEvent path
 * index.ts consumes for FlowObserver / Review / kanban / editor) and the real
 * reload seam, so no daemon or Claude account is needed.
 */

/** Dispatch a renderer-side flow:notify (a FlowNotification detail). */
async function notify(
  window: Page,
  detail: { title: string; body?: string; level?: 'info' | 'warn' | 'error' },
): Promise<void> {
  await window.evaluate((d) => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '/tmp/ux-inbox-reload',
          title: d.title,
          body: d.body ?? '',
          timestamp: new Date().toISOString(),
          level: d.level ?? 'info',
        },
      }),
    )
  }, detail)
}

/** Exactly what the View ▸ Reload menu item (⌘R) invokes. */
async function reloadRenderer(app: ElectronApplication, window: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.reload()
  })
  await window.waitForLoadState('domcontentloaded')
  // The rebuilt renderer re-runs first-run onboarding (the userData dir still
  // has no Claude account), and its overlay would swallow every click below.
  // The launch fixture does this once; a reload needs it again — and only
  // AFTER the shell is up, because the overlay mounts later than
  // `domcontentloaded` and dismissing before it exists is a no-op.
  // Harness bookkeeping, not the behaviour under test.
  await expect(window.locator(sel.flowLine)).toBeVisible()
  const overlay = window.locator('.fl-settings-overlay:not([hidden])')
  await overlay.first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => undefined)
  await dismissOnboarding(window)
  // Escape closes every other modal that reuses this class (palette, both
  // settings views), so the shell is clickable whichever one came back.
  for (let attempt = 0; attempt < 5 && (await overlay.count()) > 0; attempt++) {
    await window.keyboard.press('Escape')
    await window.waitForTimeout(150)
  }
  await expect(overlay).toHaveCount(0)
}

/** The exact #1075 case: a failure body the toast cannot hold for more than 6s. */
const FAILURE_BODY =
  'Phase 3 of plan_billing_v2 failed.\n\n```\nTypeError: cannot read x\n```\nRe-run after fixing the schema.'

test.describe('notifications — the inbox survives View ▸ Reload', () => {
  test('entries, the retained multi-line body and the unread badge all come back', async ({
    app,
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const flowLine = window.locator(sel.flowLine)
    await expect(flowLine).toBeVisible()
    const unread = flowLine.locator('.fl-flow-line-unread')
    await expect(unread).toBeHidden()

    // 1. Raise three notifications, including the multi-line error the inbox is
    //    the durable copy of.
    await notify(window, { title: 'Plan execution failed', body: FAILURE_BODY, level: 'error' })
    await notify(window, { title: 'Lint finished', body: '3 problems', level: 'warn' })
    await notify(window, { title: 'Module learned', body: 'chat/manager', level: 'info' })

    await expect(unread).toHaveText('3')
    // Counted WITHOUT opening the panel: opening is what clears the counter
    // (#232/#376), and the badge state carried across the reload has to be the
    // one the user really had — unread. Entries are in the DOM either way.
    let inbox = window.locator('.fl-flow-inbox')
    await expect(inbox).toBeHidden()
    await expect(inbox.locator('.fl-flow-inbox-entry')).toHaveCount(3)

    // 2. View ▸ Reload.
    await reloadRenderer(app, window)

    // 3. The record is still there. Everything below is re-located after the
    //    reload: the old handles point at a destroyed document.
    const flowLineAfter = window.locator(sel.flowLine)
    const unreadAfter = flowLineAfter.locator('.fl-flow-line-unread')
    await expect(unreadAfter).toBeVisible()
    await expect(unreadAfter).toHaveText('3')

    await flowLineAfter.locator('.fl-flow-line-inbox').click()
    inbox = window.locator('.fl-flow-inbox')
    await expect(inbox).toBeVisible()
    await expect(inbox.locator('.fl-flow-inbox-empty')).toHaveCount(0)
    const entries = inbox.locator('.fl-flow-inbox-entry')
    await expect(entries).toHaveCount(3)
    // Newest first, as before the reload.
    await expect(entries.nth(0).locator('.fl-flow-title')).toHaveText('Module learned')
    await expect(entries.nth(1).locator('.fl-flow-title')).toHaveText('Lint finished')
    await expect(entries.nth(2).locator('.fl-flow-title')).toHaveText('Plan execution failed')

    // 4. The retained multi-line body — the one thing the toast could not hold
    //    — is still recoverable, and still expands on click (#1075).
    const failure = entries.nth(2)
    await expect(failure).toHaveAttribute('data-body', FAILURE_BODY)
    await expect(failure).toHaveClass(/fl-flow-inbox-entry--expandable/)
    await failure.click()
    await expect(failure.locator('.fl-flow-inbox-body-full')).toContainText(
      'TypeError: cannot read x',
    )

    // 5. Opening the inbox clears the counter, and THAT survives too — a
    //    reload must not resurrect a badge the user already read away.
    await expect(unreadAfter).toBeHidden()
    await reloadRenderer(app, window)
    await expect(window.locator(sel.flowLine).locator('.fl-flow-line-unread')).toBeHidden()
    await window.locator(sel.flowLine).locator('.fl-flow-line-inbox').click()
    await expect(window.locator('.fl-flow-inbox').locator('.fl-flow-inbox-entry')).toHaveCount(3)

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })
})
