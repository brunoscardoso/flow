import { test, expect, dismissOnboarding } from '../fixtures/electron'
import { sel } from '../selectors'
import type { ElectronApplication, Locator, Page } from '@playwright/test'

/**
 * Notifications — the toast stack's scroll pin, and the inbox across a reload
 * (flow 13 of the progressive UX sweep, round 24).
 *
 * Two seams no prior flow-13 round drove. Earlier rounds covered the idle status
 * line, the toast→badge→inbox loop, the reply box (XSS / empty send / send
 * failure / "Reply sent"), multi-root prompt cards, actionable deep-link toasts,
 * per-level tones, the 200-entry cap, elevation over the open inbox
 * (#459/#463/#769) and stack CAPACITY clipping (#1036) — but never the stack's
 * SCROLL behaviour, and never a renderer reload.
 *
 * (A) #1458 — the pin-to-newest evicts the live reply box.
 *     #1036's fix stopped cards compressing and made the stack scroll, ending
 *     `showToast` with an unconditional `toastStack.scrollTop = scrollHeight`
 *     ("pin it to the newest card so the arrival is the one in view"). It has no
 *     exemption for the sticky blocked-prompt card — the ONLY in-app way to
 *     answer a blocked task, protected by #423 (no dismiss X), #459/#463
 *     (elevation) and #1036 itself — nor for the focused element. Ordinary
 *     heartbeat chatter therefore scrolls the reply box clean out of the window
 *     while the user types into it, and a manual scroll-back is undone by the
 *     very next toast.
 *
 * (B) #1459 — View ▸ Reload empties the inbox.
 *     `inboxList` is DOM built at `initFlowUi` time, never persisted. A reload
 *     leaves "No notifications yet" and an unread badge of 0, destroying the
 *     multi-line failure bodies the inbox is explicitly the durable record for
 *     (#1075) — including renderer-raised ones (save/git/terminal/review
 *     failures) that exist nowhere on disk.
 *
 * Both are driven headless via the `flow:notify` bridge (flow/index.ts:144-147 →
 * `center.notify`, the same FlowNotification shape FlowObserver pushes) — no
 * Claude account or daemon needed. Live guards below are green on current main;
 * the `test.fixme` tripwires state the target behaviour and are each verified
 * genuinely RED against main.
 */

/** Raise one notification through the renderer-side flow:notify bridge. */
async function notify(window: Page, detail: Record<string, unknown>): Promise<void> {
  await window.evaluate((d) => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: { timestamp: new Date().toISOString(), level: 'info', ...d },
      }),
    )
  }, detail)
}

/**
 * Raise `count` ordinary toasts in ONE round trip. Dispatching them one IPC hop
 * at a time can exceed TOAST_AUTO_DISMISS_MS (6s), so the earliest cards expire
 * mid-burst and the stack never fills — a harness artifact, not a fix.
 */
async function burst(window: Page, count: number, tag: string): Promise<void> {
  await window.evaluate(
    ({ count, tag }) => {
      for (let i = 0; i < count; i += 1) {
        document.dispatchEvent(
          new CustomEvent('flow:notify', {
            detail: {
              kind: 'state-change',
              title: `${tag} ${i}`,
              body: `background chatter ${i}`,
              timestamp: new Date().toISOString(),
              level: 'info',
            },
          }),
        )
      }
    },
    { count, tag },
  )
}

/** Raise the sticky blocked-prompt card and return its reply textarea. */
async function raisePrompt(window: Page, promptId: string): Promise<Locator> {
  await notify(window, {
    kind: 'blocked-prompt',
    rootId: '/tmp/ux-notif-scroll-pin',
    promptId,
    title: 'Task blocked: deploy to staging',
    body: '# Heartbeat Prompt\n\n**Task**: deploy to staging\n\nShall I push the release tag?',
    level: 'error',
  })
  const card = window.locator(`.fl-flow-toast[data-prompt-id="${promptId}"]`)
  await expect(card).toBeVisible()
  return card
}

/** Is the element inside the visible window, and inside its scroll container? */
function visibility(target: Locator): Promise<{ top: number; inWindow: boolean }> {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), inWindow: r.bottom > 0 && r.top < window.innerHeight }
  })
}

/** Exactly what the View ▸ Reload menu item (⌘R) invokes. */
async function reloadRenderer(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.reload()
  })
}

test.describe('notifications — toast-stack scroll pin + inbox across a reload', () => {
  test('a burst of ordinary toasts leaves the prompt card mounted, focused and holding its draft', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    await expect(window.locator(sel.flowLine)).toBeVisible()
    const card = await raisePrompt(window, 'p-live')
    const reply = card.locator('.fl-flow-reply')
    await reply.click()
    await reply.fill('yes, push it')

    await burst(window, 12, 'Heartbeat event')

    // What the pin does NOT break: the card survives (sticky cards are never
    // auto-dismissed), it keeps keyboard focus, and the draft is intact and
    // still receiving keystrokes. Only its position is wrong — see the
    // tripwires below.
    await expect(card).toHaveCount(1)
    expect(await window.evaluate(() => document.activeElement?.className ?? '')).toBe(
      'fl-flow-reply',
    )
    await window.keyboard.type(' now')
    expect(await reply.inputValue()).toBe('yes, push it now')
    expect(errors).toEqual([])
  })

  test(
    'an ordinary toast must not scroll the live reply box out of the window (#1458)',
    async ({ window }) => {
      await expect(window.locator(sel.flowLine)).toBeVisible()
      const card = await raisePrompt(window, 'p-evicted')
      const reply = card.locator('.fl-flow-reply')
      await reply.click()
      await reply.fill('yes, push it')
      expect((await visibility(reply)).inWindow).toBe(true)

      // Ordinary background chatter — exactly what a running plan produces, and
      // exactly when a task blocks.
      await burst(window, 12, 'Heartbeat event')

      // The only in-app way to answer the blocked task must still be on screen.
      const box = await visibility(reply)
      expect(box.inWindow, `reply box scrolled to top=${box.top}`).toBe(true)
      // "Send reply" sits directly below it and must be clickable, not just
      // CSS-visible (isVisible() ignores the viewport).
      const send = card.locator('.fl-flow-prompt-actions fl-button')
      expect((await visibility(send)).inWindow).toBe(true)
    },
  )

  test(
    'scrolling the reply box back into view survives the next toast (#1458)',
    async ({ window }) => {
      await expect(window.locator(sel.flowLine)).toBeVisible()
      const card = await raisePrompt(window, 'p-yanked')
      const reply = card.locator('.fl-flow-reply')
      await reply.click()
      await reply.fill('yes, push it')

      await burst(window, 12, 'Heartbeat event')
      // The user finds the card again by hand.
      await card.scrollIntoViewIfNeeded()
      expect((await visibility(reply)).inWindow).toBe(true)

      // ONE more informational toast must not undo that.
      await burst(window, 1, 'One more event')
      const box = await visibility(reply)
      expect(box.inWindow, `reply box yanked back to top=${box.top}`).toBe(true)
    },
  )

  test.fixme(
    'View ▸ Reload does not silently empty the notification inbox (#1459)',
    async ({ app, window }) => {
      const flowLine = window.locator(sel.flowLine)
      await expect(flowLine).toBeVisible()
      const badge = flowLine.locator('.fl-flow-line-unread')

      // An error whose body cannot fit in a 6s toast — the case #1075 keeps the
      // inbox copy for.
      await notify(window, {
        kind: 'state-change',
        rootId: '/tmp/ux-notif-scroll-pin',
        title: 'Plan execution failed',
        body: 'Phase 3 of plan_billing_v2 failed.\n\n```\nTypeError: cannot read x\n```\nRe-run after fixing the schema.',
        level: 'error',
      })
      await notify(window, { title: 'Lint finished', body: '3 repairs', level: 'warn' })
      await notify(window, { title: 'Module learned', body: 'src/billing', level: 'info' })

      await expect(badge).toHaveText('3')
      await flowLine.locator('.fl-flow-line-inbox').click()
      await expect(window.locator('.fl-flow-inbox-entry')).toHaveCount(3)

      await reloadRenderer(app)
      await expect(window.locator(sel.flowLine)).toBeVisible({ timeout: 20_000 })
      // A fresh userData dir has no account, so the first-run wizard remounts
      // over the shell after the reload and would intercept the inbox click.
      await dismissOnboarding(window)

      await window.locator(sel.flowLine).locator('.fl-flow-line-inbox').click()
      const inbox = window.locator('.fl-flow-inbox')
      await expect(inbox).toBeVisible()
      // The reload restores the terminal's live session (#1445) and the editor's
      // buffers; the durable notification record must not be the one thing it
      // destroys.
      await expect(inbox).not.toContainText('No notifications yet')
      await expect(inbox.locator('.fl-flow-inbox-entry')).toHaveCount(3)
      await expect(inbox).toContainText('Plan execution failed')
    },
  )

  test('the renderer survives a reload with notifications live, and remounts the flow line', async ({
    app,
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await expect(window.locator(sel.flowLine)).toBeVisible()
    await notify(window, { title: 'Lint finished', body: '3 repairs', level: 'warn' })
    await expect(window.locator('.fl-flow-inbox-entry')).toHaveCount(1)

    await reloadRenderer(app)
    // The reload is not awaited by `webContents.reload()`: wait for the NEW
    // document, then for its first-run onboarding overlay (the userData dir has
    // no account), which mounts after the shell and would swallow every click —
    // dismissing before it exists is a no-op. Harness bookkeeping, as in
    // notifications-inbox-survives-reload.spec.ts.
    await window.waitForLoadState('domcontentloaded')
    await expect(window.locator(sel.flowLine)).toBeVisible({ timeout: 20_000 })
    await window
      .locator('.fl-settings-overlay:not([hidden])')
      .first()
      .waitFor({ state: 'attached', timeout: 5_000 })
      .catch(() => undefined)
    await dismissOnboarding(window)

    // The status line and its inbox button come back and still work — the loss
    // in #1459 is the stored history, not the surface.
    await window.locator(sel.flowLine).locator('.fl-flow-line-inbox').click()
    await expect(window.locator('.fl-flow-inbox')).toBeVisible()
    await notify(window, { title: 'After the reload', body: 'still wired', level: 'info' })
    await expect(window.locator('.fl-flow-inbox-entry')).toHaveCount(1)
    await expect(window.locator('.fl-flow-inbox')).toContainText('After the reload')
    expect(errors).toEqual([])
  })
})
