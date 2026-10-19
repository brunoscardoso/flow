import { test, expect } from '../fixtures/electron'

/**
 * Notifications — blocked-prompt reply reachability when the toast stack fills up
 * (flow 13, round 16).
 *
 * A blocked task's sticky card carries the ONLY in-app way to answer it: a reply
 * textarea plus a "Send reply" button (notification-center.ts `buildPromptBody`).
 * Three separate bugs have already been filed and fixed to keep that affordance
 * reachable — the generic X that stranded it (#423), the open inbox that occluded
 * it (#459/#463), and the same occlusion for persistent actionable toasts (#769).
 *
 * This probe drives the remaining reachability seam: the stack's own CAPACITY.
 * `.fl-flow-toasts` is a fixed flex column capped at `calc(100vh - 64px)`; its
 * children have the default `flex-shrink: 1` and each `.fl-flow-toast` is
 * `overflow: hidden`, so once the live cards exceed the cap the cards COMPRESS
 * instead of the container scrolling — and the first thing clipped off the bottom
 * of every card is the actions row holding "Send reply". The container never
 * scrolls (`scrollHeight === clientHeight`), so there is no scrollbar to recover
 * it, sticky cards have no X, and the inbox lists prompts without a reply box.
 *
 * Driven headless via the `flow:notify` bridge (the same path index.ts consumes)
 * — no Claude account or daemon needed.
 */

/** Raise a notification through the renderer-side flow:notify bridge. */
async function notify(
  window: import('@playwright/test').Page,
  detail: Record<string, unknown>,
): Promise<void> {
  await window.evaluate((d) => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: { timestamp: new Date().toISOString(), level: 'info', ...d },
      }),
    )
  }, detail)
}

/** Raise a sticky blocked-prompt card for a root. */
async function blockedPrompt(
  window: import('@playwright/test').Page,
  index: number,
): Promise<void> {
  await notify(window, {
    kind: 'blocked-prompt',
    rootId: `/tmp/ux-stack-cap-${index}`,
    promptId: `cap-${index}`,
    title: `Task blocked: project ${index}`,
    body: ['## Decision needed', '', 'Confirm before I continue.'].join('\n'),
    level: 'error',
  })
  await expect(window.locator('.fl-flow-toast:has(.fl-flow-reply)')).toHaveCount(index)
}

/**
 * How many live prompt cards actually PAINT their own "Send reply" button —
 * hit-tested at the button's centre, the same reachability test #459 used. A
 * button clipped by its card (or pushed under the next card / the status bar)
 * scores 0 even though the element still exists in the DOM.
 */
async function reachableSendButtons(window: import('@playwright/test').Page): Promise<number> {
  return window.evaluate(() => {
    let reachable = 0
    for (const card of [...document.querySelectorAll('.fl-flow-toast')] as HTMLElement[]) {
      const send = [...card.querySelectorAll('fl-button')].find((button) =>
        (button.textContent ?? '').includes('Send reply'),
      ) as HTMLElement | undefined
      if (!send) continue
      const box = send.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      if (hit && (send.contains(hit as Node) || hit === send)) reachable++
    }
    return reachable
  })
}

/**
 * Like `reachableSendButtons`, but for a SCROLLING stack: when the live cards
 * overflow the viewport a fully-intact card can sit outside the scrollport, so
 * each card is scrolled into view before its button is hit-tested. Still zero
 * on the pre-fix compression bug — shrunken cards have no overflow to scroll
 * and their buttons are clipped by the card's own `overflow: hidden`.
 */
async function reachableSendButtonsScrolled(
  window: import('@playwright/test').Page,
): Promise<number> {
  return window.evaluate(() => {
    let reachable = 0
    for (const card of [...document.querySelectorAll('.fl-flow-toast')] as HTMLElement[]) {
      const send = [...card.querySelectorAll('fl-button')].find((button) =>
        (button.textContent ?? '').includes('Send reply'),
      ) as HTMLElement | undefined
      if (!send) continue
      card.scrollIntoView({ block: 'nearest' })
      const box = send.getBoundingClientRect()
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      if (hit && (send.contains(hit as Node) || hit === send)) reachable++
    }
    return reachable
  })
}

/** Resize to a realistic laptop window height (default is 1440x900). */
async function resize(
  app: import('@playwright/test').ElectronApplication,
  window: import('@playwright/test').Page,
  height: number,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, h) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1280, h)
  }, height)
  await expect.poll(() => window.evaluate(() => window.innerHeight)).toBeLessThanOrEqual(height)
}

test.describe('notifications / blocked-prompt stack capacity', () => {
  test('concurrent blocked prompts each keep a reachable Send reply button', async ({
    app,
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    await resize(app, window, 900)

    // Three projects block at once — one sticky card per root (they coexist, the
    // invariant #459/#463 guard). Every card must stay fully usable: a reply box
    // AND the Send button that is the only way to submit it.
    for (let i = 1; i <= 3; i++) {
      await blockedPrompt(window, i)
      await expect
        .poll(() => reachableSendButtons(window), {
          message: `all ${i} live prompt cards must expose a clickable Send reply`,
        })
        .toBe(i)
    }

    // The reply box accepts text and the Send button sits inside its own card
    // (nothing is clipped away below the card's border).
    await window.locator('.fl-flow-reply').first().fill('yes, approved')
    const clipped = await window.evaluate(() =>
      [...document.querySelectorAll('.fl-flow-toast')].filter((card) => {
        const send = [...card.querySelectorAll('fl-button')].find((b) =>
          (b.textContent ?? '').includes('Send reply'),
        )
        return send
          ? send.getBoundingClientRect().bottom > card.getBoundingClientRect().bottom + 1
          : false
      }).length,
    )
    expect(clipped).toBe(0)

    await window.screenshot({ path: 'e2e/ux/__screens/notifications-stack-capacity.png' })
    expect(errors).toEqual([])
  })

  // Live guard since #1036 was fixed: `.fl-flow-toast { flex: none; }` — cards
  // never shrink below their content, the stack SCROLLS instead (pinned to the
  // newest card), so no card's actions row is ever clipped away. When the live
  // cards exceed the viewport a correct card can sit outside the scrollport, so
  // this probe scrolls each card into view before hit-testing its button — the
  // issue's Expected ("if the stack runs out of room it scrolls"). It remains a
  // tripwire for the original bug: shrink-compressed cards have no overflow to
  // scroll and their buttons are clipped by `overflow: hidden`, so the old code
  // still scores 0 of 4.
  test(
    'a fourth concurrent blocked prompt must not clip every card Send reply button (#1036)',
    async ({ app, window }) => {
      await resize(app, window, 740)
      for (let i = 1; i <= 4; i++) await blockedPrompt(window, i)
      expect(await reachableSendButtonsScrolled(window)).toBe(4)
      // The stack really does scroll now — the recovery #1036 found missing.
      const scrollable = await window.evaluate(() => {
        const stack = document.querySelector('.fl-flow-toasts') as HTMLElement
        return stack.scrollHeight > stack.clientHeight
      })
      expect(scrollable, 'the overfull stack must scroll, not compress its cards').toBe(true)
    },
  )

  // Live guard since #1036 was fixed, via its more reachable trigger — the
  // stack does not have to be all prompts. With three blocked projects two
  // ORDINARY notifications arriving must not clip the Send buttons out from
  // under a reply the user is mid-way through typing.
  test(
    'ordinary toasts arriving beside blocked prompts must not clip the Send buttons (#1036)',
    async ({ app, window }) => {
      await resize(app, window, 740)
      for (let i = 1; i <= 3; i++) await blockedPrompt(window, i)
      await window.locator('.fl-flow-reply').first().fill('yes, approved')
      for (const title of ['Phase 3 complete', 'Lint passed']) {
        await notify(window, { kind: 'state-change', rootId: '/tmp/other', title, body: 'plan-flow' })
      }
      expect(await reachableSendButtonsScrolled(window)).toBe(3)
      // The draft being typed survives the arrivals.
      await expect(window.locator('.fl-flow-reply').first()).toHaveValue('yes, approved')
    },
  )
})
