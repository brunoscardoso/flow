import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, cleanupSeeds, dismissFlowOverlay } from './fixtures/seed'
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Notifications — PROJECT ATTRIBUTION on blocked-prompt cards (#1074) and
 * DETAIL RETENTION in the inbox (#1075). Flow 13 of the progressive UX sweep,
 * round 17.
 *
 * Every prior flow-13 spec drives the notification center's *lifecycle* — the
 * card is raised, replaced, dismissed, elevated, reattached, capped. None of
 * them asks the two questions a user with more than one managed project asks:
 *
 *   1. WHICH PROJECT is this card going to answer? (#1074)
 *   2. WHY did my task fail, ten seconds later? (#1075)
 *
 * Everything here is driven through the REAL main-process channel: prompts and
 * heartbeat events are written as real files under `<root>/flow/`, which the
 * main `FlowObserver` reads (prompt on watch-start, events via its chokidar
 * watcher) and pushes as real `blocked-prompt` / `heartbeat-event`
 * notifications. No renderer-side `flow:notify` shortcuts.
 */

const BLOCKED_TASK = 'progressive-qa-sweep'

const PROMPT_MD = `# Heartbeat prompt

**Task**: ${BLOCKED_TASK}

The scheduled task is blocked and needs a decision.

Should I proceed with the destructive step?
`

/** The multi-line failure message the production daemon really writes. */
const FAIL_HEADLINE = `Task failed (exit 1): ${BLOCKED_TASK}`
const FAIL_REASON =
  'SessionEnd hook [test -f .claude/hooks/session-summary.cjs && node .claude/hooks/session-summary.cjs || true] failed: Hook cancelled'

/** Seed a project that is already blocked on `BLOCKED_TASK`. */
async function seedBlockedProject(window: Page, prefix: string): Promise<string> {
  return seedProject(window, prefix, (dir) => {
    mkdirSync(join(dir, 'flow'), { recursive: true })
    writeFileSync(join(dir, 'flow', '.heartbeat-prompt.md'), PROMPT_MD)
  })
}

/** Whether a root still has a pending prompt (the daemon's resume signal). */
function promptPending(root: string): boolean {
  return existsSync(join(root, 'flow', '.heartbeat-prompt.md'))
}

function archivedPrompts(root: string): string[] {
  const dir = join(root, 'flow', 'archive', 'heartbeat-prompts')
  return existsSync(dir) ? readdirSync(dir) : []
}

/**
 * Everything on a card that could tell two cards apart: its visible text plus
 * any attribute a fix might use to carry the root (`data-root-id`, `title`, …).
 * Deliberately fix-agnostic — a project chip in the header, a tooltip, or a
 * data attribute all satisfy it.
 */
async function cardIdentities(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    Array.from(document.querySelectorAll('.fl-flow-toast:has(.fl-flow-reply)')).map((card) => {
      const attrs = Array.from(card.attributes)
        .filter((a) => a.name !== 'class' && a.name !== 'tone' && a.name !== 'dense')
        .map((a) => `${a.name}=${a.value}`)
        .join(',')
      const nested = Array.from(card.querySelectorAll('[title],[data-root-id],[data-root]'))
        .map(
          (el) =>
            `${el.getAttribute('title') ?? ''}|${el.getAttribute('data-root-id') ?? ''}|${
              el.getAttribute('data-root') ?? ''
            }`,
        )
        .join(',')
      return `${(card as HTMLElement).innerText}##${attrs}##${nested}`
    }),
  )
}

test.describe('notifications — attribution & detail', () => {
  test.afterEach(() => {
    // The app provisions `.claude/` + `flow/` into the seeded root, so an rmSync
    // can race the main process and throw ENOTEMPTY. Never fail a run on teardown.
    try {
      cleanupSeeds()
    } catch {
      /* best effort */
    }
  })

  test('a reply routes to exactly one project — the other stays blocked (control)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    // Two REAL projects, both blocked on the SAME scheduled task — exactly what
    // the daemon produces when one heartbeat task is configured in two projects.
    const rootA = await seedBlockedProject(window, 'flow-ux-notif-attr-A-')
    // Distinct mtimes → distinct prompt ids (`hb-<mtimeMs>`), so both cards live.
    await new Promise((r) => setTimeout(r, 60))
    const rootB = await seedBlockedProject(window, 'flow-ux-notif-attr-B-')

    const cards = window.locator('.fl-flow-toast:has(.fl-flow-reply)')
    await expect(cards).toHaveCount(2, { timeout: 15000 })
    await dismissFlowOverlay(window)

    expect(promptPending(rootA), 'A starts blocked').toBe(true)
    expect(promptPending(rootB), 'B starts blocked').toBe(true)

    // Answer the TOP card. The per-project flow-settings overlay can open a
    // beat late for the SECOND seeded root and intercept pointer events, so
    // clear it again right before the click (harness only — no assertion rides
    // on it).
    await window.locator('.fl-flow-reply').nth(0).fill('yes, proceed')
    await dismissFlowOverlay(window)
    await cards.nth(0).locator('fl-button', { hasText: 'Send reply' }).click()

    // Exactly one card resolves, and exactly one project's prompt is consumed:
    // the answer is archived there and the resume signal (prompt file removal)
    // fires for that root ONLY. This is the machinery #1074 is about — the reply
    // really does commit to one specific project's autonomous run.
    await expect(cards).toHaveCount(1, { timeout: 10000 })
    const consumed = [rootA, rootB].filter((r) => !promptPending(r))
    expect(consumed, 'exactly one project is unblocked by one reply').toHaveLength(1)
    expect(
      archivedPrompts(consumed[0]),
      'the answered project archives the responded prompt',
    ).toHaveLength(1)
    const stillBlocked = consumed[0] === rootA ? rootB : rootA
    expect(archivedPrompts(stillBlocked), 'the other project archives nothing').toHaveLength(0)

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('a multi-line failure reaches the toast in full and lands in the inbox (control)', async ({
    window,
  }) => {
    const root = await seedProject(window, 'flow-ux-notif-detail-', (dir) => {
      mkdirSync(join(dir, 'flow'), { recursive: true })
      writeFileSync(join(dir, 'flow', '.heartbeat-events.jsonl'), '')
    })
    await dismissFlowOverlay(window)

    appendFileSync(
      join(root, 'flow', '.heartbeat-events.jsonl'),
      `${JSON.stringify({
        id: 'ux-detail-1',
        timestamp: new Date().toISOString(),
        task: BLOCKED_TASK,
        type: 'task_failed',
        level: 'error',
        message: `${FAIL_HEADLINE}\n${FAIL_REASON}`,
      })}\n`,
    )

    // The reason DOES reach the renderer — the main-process channel carries the
    // whole body. (The loss in #1075 happens later, in the inbox render.)
    const toast = window.locator('.fl-flow-toast', { hasText: FAIL_HEADLINE })
    await expect(toast).toHaveCount(1, { timeout: 20000 })
    await expect(toast.first()).toContainText('SessionEnd hook')

    // And the failure is recorded in the durable inbox log.
    await window.locator(sel.flowLine).locator('.fl-flow-line-inbox').click()
    await expect(window.locator('.fl-flow-inbox')).toBeVisible()
    await expect(
      window.locator('.fl-flow-inbox-entry', { hasText: FAIL_HEADLINE }),
    ).toHaveCount(1)
  })

  // ── #1074 ────────────────────────────────────────────────────────────────
  // Two projects blocked on the SAME task render byte-identical reply cards:
  // same title, same body, same button, and no `data-root`/`title` anywhere. The
  // user picks one blind, and (per the control above) that pick really does
  // resume one specific project's autonomous task. Fix-agnostic: a project chip,
  // a tooltip, or a root data attribute all satisfy this. Live guard since
  // #1074 was fixed (project chip + data-root-id on every blocked-prompt card).
  test(
    'each blocked-prompt card identifies the project it will answer (#1074)',
    async ({ window }) => {
      await seedBlockedProject(window, 'flow-ux-notif-1074-alpha-')
      await new Promise((r) => setTimeout(r, 60))
      await seedBlockedProject(window, 'flow-ux-notif-1074-beta-')

      const cards = window.locator('.fl-flow-toast:has(.fl-flow-reply)')
      await expect(cards).toHaveCount(2, { timeout: 15000 })
      await dismissFlowOverlay(window)

      await window.screenshot({
        path: 'e2e/ux/__screens/notifications-two-blocked-projects.png',
      })

      const identities = await cardIdentities(window)
      expect(
        new Set(identities).size,
        `the two blocked projects' cards are indistinguishable — nothing (text, tooltip, or data attribute) says which project each will answer:\n${identities.join(
          '\n---\n',
        )}`,
      ).toBe(2)
    },
  )

  // ── #1075 ────────────────────────────────────────────────────────────────
  // The inbox keeps only `firstLine(body)`, the entry is not expandable, and the
  // toast holding the reason auto-dismisses after 6s — so the answer to "why did
  // my task fail" is destroyed. Fix-agnostic: the reason may survive as visible
  // text, as a `title`/dataset on the entry, or behind a click. Live guard since
  // #1075 was fixed (full body retained on the entry + click-to-expand).
  test(
    "a failure's reason survives the toast's auto-dismiss (#1075)",
    async ({ window }) => {
      const root = await seedProject(window, 'flow-ux-notif-1075-', (dir) => {
        mkdirSync(join(dir, 'flow'), { recursive: true })
        writeFileSync(join(dir, 'flow', '.heartbeat-events.jsonl'), '')
      })
      await dismissFlowOverlay(window)

      appendFileSync(
        join(root, 'flow', '.heartbeat-events.jsonl'),
        `${JSON.stringify({
          id: 'ux-1075-1',
          timestamp: new Date().toISOString(),
          task: BLOCKED_TASK,
          type: 'task_failed',
          level: 'error',
          message: `${FAIL_HEADLINE}\n${FAIL_REASON}`,
        })}\n`,
      )

      const toast = window.locator('.fl-flow-toast', { hasText: FAIL_HEADLINE })
      await expect(toast).toHaveCount(1, { timeout: 20000 })

      // The user opens their notification history and looks away for ten seconds.
      await window.locator(sel.flowLine).locator('.fl-flow-line-inbox').click()
      const entry = window.locator('.fl-flow-inbox-entry', { hasText: FAIL_HEADLINE })
      await expect(entry).toHaveCount(1)
      await expect(toast).toHaveCount(0, { timeout: 12000 }) // 6s auto-dismiss

      // Is the reason recoverable at all — visibly, via a tooltip/dataset, or
      // by expanding the entry?
      const reachable = async (): Promise<boolean> =>
        window.evaluate((reason) => {
          if (document.body.innerText.includes(reason)) return true
          return Array.from(document.querySelectorAll('.fl-flow-inbox-entry, .fl-flow-inbox-entry *'))
            .some((el) => {
              const title = el.getAttribute('title') ?? ''
              const data = Object.values((el as HTMLElement).dataset ?? {}).join(' ')
              return title.includes(reason) || data.includes(reason)
            })
        }, FAIL_REASON)

      if (!(await reachable())) {
        // Maybe it's behind an expand interaction — try clicking the entry.
        await entry.click({ trial: false }).catch(() => undefined)
        await window.waitForTimeout(300)
      }

      await window.screenshot({
        path: 'e2e/ux/__screens/notifications-inbox-detail-lost.png',
      })

      expect(
        await reachable(),
        `after the toast auto-dismissed, the failure REASON ("${FAIL_REASON}") is nowhere in the app — the inbox kept only the headline "${FAIL_HEADLINE}" and the entry cannot be expanded`,
      ).toBe(true)
    },
  )
})
