import { test, expect } from '../fixtures/electron'

/**
 * Notifications — blocked-prompt reply box UX regression guard (flow 13 of the
 * progressive sweep, round 4). The core `notifications.spec.ts` covers the
 * status line, toasts, badge, and #459 reachability; this file guards the
 * *reply interaction itself* — the only in-app way to answer a blocked task:
 *
 *   1. the reply box renders inside a sticky blocked-prompt toast,
 *   2. the prompt body is rendered via the escape-first markdown-lite pass
 *      (headings/bold/code) and can NEVER inject HTML (XSS guard),
 *   3. an empty Send is guarded with "Enter a reply first" and keeps the card,
 *   4. a failed send SURFACES the error ("Failed to send: …") and re-enables
 *      the button — the failure is never swallowed (forbidden-pattern #2), and
 *      the still-blocked task's reply affordance is preserved.
 *
 * Blocked prompts are driven headless via the renderer-side `flow:notify`
 * bridge (a CustomEvent carrying a FlowNotification) — the same path index.ts
 * consumes — so no Claude account / daemon is needed. A prompt seeded this way
 * has no matching daemon-side pending prompt, so a real `flow:respondPrompt`
 * IPC deterministically rejects; that is exactly the failure path we assert is
 * surfaced rather than swallowed.
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

test.describe('notifications / blocked-prompt reply box UX', () => {
  test('reply box renders safely, guards empty send, and surfaces send failures', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    // 1. A background task blocks → a sticky prompt card with an inline reply box.
    await blockedPrompt(window, {
      rootId: '/tmp/ux-notify-reply',
      promptId: 'p-reply-1',
      title: 'Task blocked: deploy',
      body: '# Approve?\n**Migrate** the db <script>alert(1)</script>?\n\n```\nyes / no\n```',
    })
    const reply = window.locator('.fl-flow-reply')
    await expect(reply).toHaveCount(1)

    // 2. The prompt body is rendered by the escape-first markdown-lite pass —
    //    heading + bold + code render as elements, and raw HTML is neutralized
    //    (the <script> becomes escaped text, never a live node).
    const md = window.locator('.fl-flow-md')
    await expect(md.locator('.fl-flow-md-h')).toHaveText('Approve?')
    await expect(md.locator('strong')).toHaveText('Migrate')
    await expect(md.locator('pre.fl-flow-code')).toHaveText('yes / no')
    const scriptInjected = await window.evaluate(
      () => document.querySelectorAll('.fl-flow-md script').length,
    )
    expect(scriptInjected, 'markdown-lite must escape HTML, never inject a live <script>').toBe(0)

    const sendBtn = window.locator('.fl-flow-toast fl-button:has-text("Send reply")')
    const status = window.locator('.fl-flow-prompt-actions .fl-flow-caption')

    // 3. Empty Send is guarded — no IPC, a hint is shown, and the card persists
    //    (the only in-app reply affordance must not be lost on a mis-click).
    await sendBtn.click()
    await expect(status).toHaveText('Enter a reply first')
    await expect(reply).toHaveCount(1)

    // 4. A real Send whose IPC rejects (no daemon-side pending prompt for this
    //    seeded id) must SURFACE the failure and re-enable the button — never a
    //    silent swallow, and the reply the user typed stays recoverable.
    await reply.fill('yes, approved')
    await sendBtn.click()
    await expect(status).toContainText('Failed to send:', { timeout: 10_000 })
    await expect(reply).toHaveCount(1)
    const sendDisabled = await window.evaluate(
      () =>
        document
          .querySelector('.fl-flow-prompt-actions fl-button')
          ?.hasAttribute('disabled') ?? null,
    )
    expect(sendDisabled, 'Send must re-enable after a failed reply so the user can retry').toBe(
      false,
    )

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })
})
