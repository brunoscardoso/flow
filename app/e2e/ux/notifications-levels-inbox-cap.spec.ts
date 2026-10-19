import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'

/**
 * Notifications — per-level rendering + bounded inbox log (flow 13 of the
 * progressive sweep, round 13).
 *
 * Prior flow-13 rounds drove the idle status line, the toast→badge→inbox loop,
 * the blocked-prompt reply box (XSS / empty-send / send-failure / reply-sent),
 * multi-root prompt cards, actionable ("deep-link") toasts, and toast-stack
 * elevation over the inbox (#459/#463/#769). Two core rendering invariants were
 * NEVER driven end-to-end:
 *
 *   1. Per-LEVEL styling. A notification's `level` (info | warn | error) drives
 *      BOTH the toast card `tone` (LEVEL_TONES: info→accent, warn→warning,
 *      error→error) AND the inbox entry's coloured level dot
 *      (`.fl-flow-level-{info,warn,error}`). If an `error` notification silently
 *      lost its red tone/dot, a user would miss that something actually failed —
 *      the whole point of the level. This guards the mapping and newest-first
 *      inbox ordering.
 *
 *   2. Bounded inbox growth. The inbox is the DURABLE log (toasts are transient),
 *      capped at INBOX_MAX_ENTRIES = 200 (notification-center.ts:109-111 evicts
 *      the oldest once over the cap). A long-running session raises hundreds of
 *      heartbeat events; without the cap the panel would grow without bound and
 *      jank. This guards that the log stays capped at exactly 200, keeps the
 *      NEWEST entries, and evicts the oldest — with no crash.
 *
 * Both are driven headless via the renderer-side `flow:notify` bridge (the same
 * CustomEvent path index.ts consumes for the FlowObserver / Review / kanban /
 * editor) — no Claude account or daemon needed. A `pageerror`/`console.error`
 * listener fails the flow on any uncaught renderer error.
 *
 * Empirically confirmed on current `main` (rebuilt bundle): tones
 * [accent, warning, error], inbox dots [error, warn, info] newest-first, and the
 * inbox caps at exactly 200 after 205 dispatches — no product bug this round.
 */

/** Dispatch a renderer-side flow:notify toast (a FlowNotification detail). */
async function notify(
  window: import('@playwright/test').Page,
  detail: { title: string; body?: string; level?: 'info' | 'warn' | 'error' },
): Promise<void> {
  await window.evaluate((d) => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '/tmp/ux-levels',
          title: d.title,
          body: d.body ?? '',
          timestamp: new Date().toISOString(),
          level: d.level ?? 'info',
        },
      }),
    )
  }, detail)
}

test.describe('notifications — per-level rendering + bounded inbox', () => {
  test('level drives toast tone + inbox dot, newest-first', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const flowLine = window.locator(sel.flowLine)
    await expect(flowLine).toBeVisible()
    const inboxBtn = flowLine.locator('.fl-flow-line-inbox')

    // Raise one notification per level (dispatch order: info, warn, error).
    await notify(window, { title: 'Info event', body: 'all good', level: 'info' })
    await notify(window, { title: 'Warn event', body: 'heads up', level: 'warn' })
    await notify(window, { title: 'Error event', body: 'it failed', level: 'error' })

    // Each toast card carries the tone mapped from its level.
    const toasts = window.locator('.fl-flow-toast')
    await expect(toasts).toHaveCount(3)
    const tones = await window.evaluate(() =>
      Array.from(document.querySelectorAll('.fl-flow-toast')).map((t) => t.getAttribute('tone')),
    )
    // Dispatch order info→warn→error; toasts are appended in arrival order.
    expect(tones).toEqual(['accent', 'warning', 'error'])

    // Open the inbox: entries are newest-first with a matching coloured dot.
    await inboxBtn.click()
    const inbox = window.locator('.fl-flow-inbox')
    await expect(inbox).toBeVisible()
    const entries = inbox.locator('.fl-flow-inbox-entry')
    await expect(entries).toHaveCount(3)
    // Newest-first: error (dispatched last) at top, info at the bottom.
    await expect(entries.nth(0).locator('.fl-flow-title')).toHaveText('Error event')
    await expect(entries.nth(1).locator('.fl-flow-title')).toHaveText('Warn event')
    await expect(entries.nth(2).locator('.fl-flow-title')).toHaveText('Info event')
    const dotLevels = await window.evaluate(() =>
      Array.from(document.querySelectorAll('.fl-flow-inbox-entry .fl-flow-level-dot')).map((d) =>
        d.classList.contains('fl-flow-level-error')
          ? 'error'
          : d.classList.contains('fl-flow-level-warn')
            ? 'warn'
            : d.classList.contains('fl-flow-level-info')
              ? 'info'
              : 'none',
      ),
    )
    expect(dotLevels).toEqual(['error', 'warn', 'info'])

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('inbox is a bounded log — caps at 200, keeps newest, evicts oldest', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const flowLine = window.locator(sel.flowLine)
    await expect(flowLine).toBeVisible()
    const inboxBtn = flowLine.locator('.fl-flow-line-inbox')

    // Raise 205 notifications (> INBOX_MAX_ENTRIES) in one microtask burst,
    // exactly as a long-running session's heartbeat backlog would.
    const TOTAL = 205
    const CAP = 200
    await window.evaluate((total) => {
      for (let i = 0; i < total; i++) {
        document.dispatchEvent(
          new CustomEvent('flow:notify', {
            detail: {
              kind: 'state-change',
              rootId: '/tmp/ux-levels',
              title: `event ${i}`,
              body: '',
              timestamp: new Date().toISOString(),
              level: 'info',
            },
          }),
        )
      }
    }, TOTAL)

    await inboxBtn.click()
    const inbox = window.locator('.fl-flow-inbox')
    await expect(inbox).toBeVisible()

    // The durable log is bounded at exactly the cap — never unbounded growth.
    await expect(inbox.locator('.fl-flow-inbox-entry')).toHaveCount(CAP)

    // Newest-first + oldest evicted: entry 204 is on top, entries 0-4 are gone.
    await expect(inbox.locator('.fl-flow-inbox-entry').first().locator('.fl-flow-title')).toHaveText(
      `event ${TOTAL - 1}`,
    )
    const titles = await window.evaluate(() =>
      Array.from(document.querySelectorAll('.fl-flow-inbox-entry .fl-flow-title')).map(
        (t) => t.textContent,
      ),
    )
    // The oldest (event 0..4) fell off; the newest cap-worth survive.
    expect(titles).not.toContain('event 0')
    expect(titles).toContain(`event ${TOTAL - CAP}`) // event 5 — the oldest survivor

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })
})
