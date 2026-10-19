import { test, expect } from '../fixtures/electron'
import type { Page } from '@playwright/test'

/**
 * Notifications — WHAT THE OPEN INBOX COSTS YOU (#1113) and WHETHER YOU CAN
 * CLOSE IT (#1114). Flow 13 of the progressive UX sweep, round 18.
 *
 * Fifteen prior flow-13 specs drive the notification center's lifecycle — the
 * card is raised, replaced, dismissed, elevated, reattached, capped, attributed,
 * detail-retained. Every one of them asks whether a notification ARRIVES. None
 * asks what the panel that exists to show notifications does to the ones that
 * arrive WHILE IT IS OPEN, or how a user gets rid of it.
 *
 * The two closed neighbours are the reason this matters: #459 (the open inbox
 * occluded the sticky blocked-prompt reply box) and #769 (it occluded an
 * actionable toast) were both fixed by ELEVATING that specific kind of card
 * above the panel — `shouldElevateToasts(promptCards.size, actionToasts.size)`.
 * A plain `error` toast — the task-failed / commit-failed / save-failed class
 * that every panel in the app raises through the universal `flow:notify` bridge
 * — got no such elevation, and it is the one with no second chance, because it
 * auto-dismisses after 6s.
 *
 * Driven through the `flow:notify` bridge (the same path `flow/index.ts`
 * consumes for real `flow:notification` pushes), so no account or daemon is
 * needed and the timing is deterministic. Both findings were ALSO reproduced
 * end-to-end through the real main-process channel (a real `task_failed` line
 * appended to a seeded project's `flow/.heartbeat-events.jsonl`, read by the
 * real `FlowObserver`) before filing.
 *
 * Live here: the three controls that make the tripwires attributable —
 *   1. with the inbox CLOSED the same error IS announced (toast + badge),
 *   2. the #459/#769 elevation still holds for a sticky prompt card,
 *   3. the shell's sibling overlays DO close on Escape, and the inbox's own
 *      documented exit (the status-bar icon) works.
 */

const ERROR_TITLE = 'Task failed (exit 1): progressive-qa-sweep'

/** Raise a notification through the renderer-side flow:notify bridge. */
async function notify(window: Page, detail: Record<string, unknown>): Promise<void> {
  await window.evaluate((d) => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: { timestamp: new Date().toISOString(), level: 'info', ...d },
      }),
    )
  }, detail)
}

/** Raise the failure notification a dead background task produces. */
async function raiseFailure(window: Page): Promise<void> {
  await notify(window, {
    kind: 'heartbeat-event',
    rootId: '/tmp/ux-blind-spot',
    title: ERROR_TITLE,
    body: 'SessionEnd hook failed: Hook cancelled',
    level: 'error',
  })
}

/**
 * Every channel the app has for announcing a notification, measured the way a
 * user experiences it: the toast must be HIT-TESTABLE (not merely present in the
 * DOM behind the panel — the #459/#769 reachability test), the badge must be
 * shown, and the inbox entry must be inside the list's scroll viewport.
 */
async function announcementChannels(window: Page, phrase: string) {
  return window.evaluate((p) => {
    const toast = [...document.querySelectorAll('.fl-flow-toast')].find((t) =>
      (t as HTMLElement).innerText.includes(p),
    ) as HTMLElement | undefined
    let toastVisible = false
    if (toast) {
      const b = toast.getBoundingClientRect()
      const points: Array<[number, number]> = [
        [b.left + 8, b.top + 8],
        [b.left + b.width / 2, b.top + b.height / 2],
        [b.right - 8, b.bottom - 8],
      ]
      toastVisible = points.some(([x, y]) => {
        const hit = document.elementFromPoint(x, y)
        return !!hit && toast.contains(hit)
      })
    }
    const badge = document.querySelector('.fl-flow-line-unread') as HTMLElement | null
    const list = document.querySelector('.fl-flow-inbox-list') as HTMLElement | null
    const inbox = document.querySelector('.fl-flow-inbox') as HTMLElement | null
    const entry = [...document.querySelectorAll('.fl-flow-inbox-entry')].find((e) =>
      (e as HTMLElement).innerText.includes(p),
    ) as HTMLElement | undefined
    let entryVisible = false
    if (entry && list && inbox && !inbox.hidden) {
      const eb = entry.getBoundingClientRect()
      const lb = list.getBoundingClientRect()
      entryVisible = eb.bottom > lb.top + 1 && eb.top < lb.bottom - 1
    }
    return {
      toastExists: !!toast,
      toastVisible,
      badgeShown: !!badge && !badge.hidden && (badge.textContent ?? '0') !== '0',
      badgeText: badge?.textContent ?? '',
      inboxOpen: !!inbox && !inbox.hidden,
      entryExists: !!entry,
      entryVisible,
      listScrollTop: list?.scrollTop ?? 0,
    }
  }, phrase)
}

/** Fill the inbox log so it is scrollable — what any real session produces. */
async function fillLog(window: Page, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await notify(window, { title: `Phase ${i} complete`, body: `task ${i} ok` })
  }
}

test.describe('notifications — the open inbox blind spot', () => {
  // ── Control ────────────────────────────────────────────────────────────────
  // With the inbox CLOSED, the very same error IS announced, twice over: a
  // hit-testable toast and an unread badge. This is what makes #1113 a property
  // of the OPEN panel rather than of the notification itself.
  test('CONTROL: with the inbox closed, an error is announced by toast AND badge', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    await raiseFailure(window)
    await expect(window.locator('.fl-flow-toast', { hasText: ERROR_TITLE })).toHaveCount(1)

    const channels = await announcementChannels(window, ERROR_TITLE)
    expect(channels.inboxOpen, 'precondition: the inbox is closed').toBe(false)
    expect(
      channels.toastVisible,
      `the error toast must be hit-testable, not just present: ${JSON.stringify(channels)}`,
    ).toBe(true)
    expect(
      channels.badgeShown,
      `the unread badge must count it: ${JSON.stringify(channels)}`,
    ).toBe(true)
    expect(channels.badgeText).toBe('1')

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })

  // ── Control ────────────────────────────────────────────────────────────────
  // The #459/#769 fixes: a sticky blocked-prompt card raised while the inbox is
  // OPEN is elevated above it and stays reachable. This is the mechanism that
  // exists for prompt/action cards and NOT for plain error toasts (#1113) — if
  // this ever regresses, a blocked task becomes unanswerable in-app again.
  test('CONTROL: a sticky prompt raised while the inbox is open stays on top (#459/#769)', async ({
    window,
  }) => {
    await fillLog(window, 6)
    await window.locator('.fl-flow-line-inbox').click()
    await expect(window.locator('.fl-flow-inbox')).toBeVisible()

    await notify(window, {
      kind: 'blocked-prompt',
      rootId: '/tmp/ux-blind-spot',
      promptId: 'blind-spot-1',
      title: 'Task blocked: progressive-qa-sweep',
      body: '## Decision needed\n\nShould I proceed with the destructive step?',
      level: 'error',
    })
    const card = window.locator('.fl-flow-toast:has(.fl-flow-reply)')
    await expect(card).toHaveCount(1)

    const reachable = await window.evaluate(() => {
      const el = document.querySelector('.fl-flow-toast:has(.fl-flow-reply)') as HTMLElement
      const send = [...el.querySelectorAll('fl-button')].find((b) =>
        (b.textContent ?? '').includes('Send reply'),
      ) as HTMLElement | undefined
      if (!send) return { found: false, onTop: false }
      const b = send.getBoundingClientRect()
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
      return { found: true, onTop: !!hit && (send.contains(hit) || hit === send) }
    })
    expect(reachable.found, 'the sticky card renders its Send reply button').toBe(true)
    expect(
      reachable.onTop,
      'the sticky prompt card must sit ABOVE the open inbox (#459/#769)',
    ).toBe(true)
  })

  // ── Control ────────────────────────────────────────────────────────────────
  // The shell's dismissal contract that #1114 breaks: the palette and the app
  // settings overlay both close on Escape, and the inbox's own documented exit
  // (its status-bar icon) really does toggle the panel shut.
  test('CONTROL: sibling overlays close on Escape, and the inbox icon toggles the panel', async ({
    window,
  }) => {
    const inbox = window.locator('.fl-flow-inbox')
    const overlay = window.locator('.fl-settings-overlay:not([hidden])')

    // Sibling 1 — the command palette.
    await window.keyboard.press('ControlOrMeta+p')
    await expect(overlay).toHaveCount(1)
    await window.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)

    // (Sibling 2 was the app Settings OVERLAY. Settings is a tab in the editor
    // area now — a page you close like any tab, not an overlay over the shell —
    // so it is no longer a sibling of the inbox at all.)

    // The inbox's documented exit works — the icon is a real toggle.
    await notify(window, { title: 'Phase 1 complete', body: 'ok' })
    await window.locator('.fl-flow-line-inbox').click()
    await expect(inbox).toBeVisible()
    await window.locator('.fl-flow-line-inbox').click()
    await expect(inbox).toBeHidden()
  })

  // ── #1113 ──────────────────────────────────────────────────────────────────
  // An error arriving while the inbox is open + scrolled is announced by NOTHING:
  // the toast is occluded (`.fl-flow-toasts` z-index 1000 under the panel's 1001,
  // same fixed rect), the badge is suppressed (`if (inbox.hidden) setUnread(...)`),
  // and the entry is prepended above the list's scroll viewport. Six seconds later
  // the toast is gone and the badge still reads 0.
  //
  // Fix-agnostic: ANY of the three channels doing its job satisfies this — a
  // visible toast (elevate error toasts the way #459/#769 elevate prompt/action
  // cards), a bumped badge, or the new entry scrolled into view. Live guard
  // since #1113 was fixed (the badge now counts arrivals the open panel does
  // not actually show — entries prepended above a scrolled viewport).
  test(
    'an error arriving while the inbox is open is announced by at least one channel (#1113)',
    async ({ window }) => {
      await fillLog(window, 30)
      // The toasts from the session's own history clear on their own (6s).
      await expect(window.locator('.fl-flow-toast')).toHaveCount(0, { timeout: 15000 })

      // The user opens the notification history and scrolls down to read it.
      await window.locator('.fl-flow-line-inbox').click()
      await expect(window.locator('.fl-flow-inbox')).toBeVisible()
      await window.evaluate(() => {
        ;(document.querySelector('.fl-flow-inbox-list') as HTMLElement).scrollTop = 500
      })
      await expect
        .poll(() => window.evaluate(() => (document.querySelector('.fl-flow-inbox-list') as HTMLElement).scrollTop))
        .toBeGreaterThan(0)

      await raiseFailure(window)
      await expect(window.locator('.fl-flow-toast', { hasText: ERROR_TITLE })).toHaveCount(1)

      const channels = await announcementChannels(window, ERROR_TITLE)
      expect(channels.inboxOpen, 'precondition: the inbox is open').toBe(true)
      expect(channels.entryExists, 'precondition: it did reach the inbox log').toBe(true)

      await window.screenshot({
        path: 'e2e/ux/__screens/notifications-open-inbox-blind-spot.png',
      })

      const announced = channels.toastVisible || channels.badgeShown || channels.entryVisible
      expect(
        announced,
        `an error notification arrived while the notification panel was open and NOTHING announced it — ` +
          `the toast is occluded behind the panel (toastVisible=${channels.toastVisible}), the unread badge ` +
          `was never bumped (badge="${channels.badgeText}"), and the new entry was prepended above the ` +
          `scroll viewport (entryVisible=${channels.entryVisible}, scrollTop=${channels.listScrollTop}). ` +
          `Six seconds from now the toast auto-dismisses and the badge still reads 0.`,
      ).toBe(true)
    },
  )

  // ── #1114 ──────────────────────────────────────────────────────────────────
  // The inbox is a 340 x up-to-50vh opaque panel over the work surface with no
  // dismiss affordance at all: Escape is ignored, an outside click is ignored,
  // and the panel contains zero buttons. Every sibling overlay closes on Escape
  // (see the control above); #638 was filed and fixed for exactly this
  // inconsistency on the project switcher.
  //
  // Fix-agnostic: Escape, a click outside, or a close control in the header all
  // satisfy it. Live guard since #1114 was fixed (all three now work).
  test('the inbox can be dismissed without hunting for its status-bar icon (#1114)', async ({
    window,
  }) => {
    await fillLog(window, 4)
    await window.locator('.fl-flow-line-inbox').click()
    const inbox = window.locator('.fl-flow-inbox')
    await expect(inbox).toBeVisible()

    // Everything a user would try, in the order they would try it.
    await window.keyboard.press('Escape')
    await window.waitForTimeout(200)
    const afterEscape = await inbox.isVisible()

    await window.mouse.click(600, 400)
    await window.waitForTimeout(200)
    const afterOutsideClick = await inbox.isVisible()

    const closeControls = await window.evaluate(
      () =>
        document.querySelectorAll(
          '.fl-flow-inbox button, .fl-flow-inbox fl-button, .fl-flow-inbox [role=button]',
        ).length,
    )

    await window.screenshot({
      path: 'e2e/ux/__screens/notifications-inbox-undismissable.png',
    })

    expect(
      !afterEscape || !afterOutsideClick || closeControls > 0,
      `the Notifications panel has no way out: Escape left it up (${afterEscape}), a click outside left ` +
        `it up (${afterOutsideClick}), and it contains ${closeControls} close controls — while the command ` +
        `palette and both settings overlays all close on Escape.`,
    ).toBe(true)
  })
})
