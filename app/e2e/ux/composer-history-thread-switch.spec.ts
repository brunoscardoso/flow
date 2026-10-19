import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): message-history recall (#776) ACROSS a thread
 * switch.
 *
 * The composer is a SINGLETON (`threads/index.ts:51`) that rebinds via
 * `setThread` (`composer.ts:523`); recall history lives per-thread in a
 * `#histories` Map keyed by thread id. `composer-message-history.spec.ts`
 * drives recall INSIDE one thread only (session walk + persisted seeding).
 * Nothing had ever driven history through a REBIND, which exercises two seams:
 *
 *  1. Per-thread isolation — ArrowUp in thread B must never surface thread A's
 *     messages (the recall analog of the #688 draft leak / #472 queue drop).
 *     Holds today; pinned by a live guard below.
 *  2. Navigation-cursor teardown — `setThread`'s switch branch used to leave
 *     the leaving thread's navigation cursor (and the draft saved when the walk
 *     began) parked, so coming back resumed a walk the user could no longer see
 *     (#1013). Fixed: the switch branch now resets navigation, and the typed
 *     draft is preserved per-thread and restored openly in the textarea on
 *     return (#1067) instead of lingering as a zombie behind ArrowDown.
 *
 * Credential-free: messages are persisted via `messages.append` (what a prior
 * session's sends look like) and recall seeds from them (#776).
 */

const textarea = (win: Page) => win.locator(`${sel.composer} textarea`)

const OLDER = 'where is the auth middleware?'
const NEWEST = 'now add a rate limiter to it'

/** Create thread `title` under `root`, optionally with persisted user messages. */
async function seedThread(
  win: Page,
  root: string,
  title: string,
  messages: readonly string[] = [],
): Promise<void> {
  await win.evaluate(
    async ({ root, title, messages }) => {
      const flow = (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
        }
      ).flow
      const thread = await flow.threads.create({ projectRoot: root, title })
      for (const [index, content] of messages.entries()) {
        // Messages are ordered by `created_at ASC, id ASC` (thread-store.ts:590)
        // and ids are random, so same-millisecond appends have no stable order —
        // space them so "newest" is unambiguous.
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, 30))
        await flow.messages.append({ threadId: thread.id, role: 'user', content })
      }
    },
    { root, title, messages },
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.composer)).toBeVisible()
}

/**
 * Barrier for the async history seed. `#seedHistory` fills a freshly-opened
 * thread's recall history from `messages.list`; issuing our OWN list for the
 * same thread afterwards means the seed's reply has already been delivered, so
 * a following ArrowUp is deterministic instead of racing the seed.
 */
async function waitForHistorySeed(win: Page, title: string): Promise<void> {
  await win.evaluate(async (title) => {
    const flow = (
      window as unknown as {
        flow: {
          threads: { list(i: unknown): Promise<{ id: string; title: string }[]> }
          messages: { list(i: { threadId: string }): Promise<unknown> }
        }
      }
    ).flow
    const thread = (await flow.threads.list({})).find((t) => t.title === title)
    if (thread) await flow.messages.list({ threadId: thread.id })
  }, title)
}

/** Open `title` and take the FIRST step of a history walk from an empty box. */
async function firstRecall(win: Page, title: string, expected: string): Promise<void> {
  await waitForHistorySeed(win, title)
  const box = textarea(win)
  await box.click()
  await box.press('ArrowUp')
  await expect(box).toHaveValue(expected)
}

test.describe('flow 3 — composer history recall across a thread switch (#776)', () => {
  test.afterAll(() => cleanupSeeds())

  // LIVE GUARD: recall is per-thread — thread B has sent nothing, so ArrowUp
  // there is a no-op, never a window into thread A's history.
  test('ArrowUp in a sibling thread does not recall the other thread\'s messages', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    await seedThread(window, dir, 'Recall A', [OLDER, NEWEST])
    await seedThread(window, dir, 'Recall B')

    await openThread(window, 'Recall A')
    await firstRecall(window, 'Recall A', NEWEST)

    await openThread(window, 'Recall B')
    const inB = textarea(window)
    await expect(inB).toHaveValue('')
    await inB.click()
    await inB.press('ArrowUp')
    await expect(inB, "thread B must not recall thread A's messages").toHaveValue('')

    expect(errors, errors.join(', ')).toHaveLength(0)
  })

  // LIVE GUARD (the baseline the tripwire below contrasts with): arriving at a
  // thread, the FIRST ArrowUp yields the NEWEST message and a second one steps
  // to the older message.
  test('a fresh walk recalls newest-first, then older', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    await seedThread(window, dir, 'Fresh walk', [OLDER, NEWEST])

    await openThread(window, 'Fresh walk')
    await firstRecall(window, 'Fresh walk', NEWEST)
    const box = textarea(window)
    await box.press('ArrowUp')
    await expect(box).toHaveValue(OLDER)

    expect(errors, errors.join(', ')).toHaveLength(0)
  })

  // TRIPWIRE (#1013 — fixed): switching away mid-walk used to leave the
  // navigation cursor parked, so coming back the first ArrowUp resumed the old
  // walk and the NEWEST message was unreachable. `setThread`'s switch branch
  // now resets the leaving thread's navigation, so this matches the
  // "fresh walk" guard above. (No draft was typed before the walk, so the
  // #1067 per-thread draft restore correctly restores an empty composer.)
  test(
    'after switching away and back, ArrowUp recalls the NEWEST message again',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))

      const dir = await seedProject(window)
      await activateProject(window, dir)
      await seedThread(window, dir, 'Cursor A', [OLDER, NEWEST])
      await seedThread(window, dir, 'Cursor B')

      await openThread(window, 'Cursor A')
      await firstRecall(window, 'Cursor A', NEWEST)

      // Leave mid-walk, then come back — the composer is empty either way.
      await openThread(window, 'Cursor B')
      await expect(textarea(window)).toHaveValue('')
      await openThread(window, 'Cursor A')
      const back = textarea(window)
      await expect(back).toHaveValue('')

      await back.click()
      await back.press('ArrowUp')
      await expect(back, 'the walk must restart from the newest message').toHaveValue(NEWEST)

      expect(errors, errors.join(', ')).toHaveLength(0)
    },
  )

  // TRIPWIRE (#1013 — fixed, composed with #1067): the draft saved when the
  // walk began used to survive the switch INSIDE the history state, so a single
  // ArrowDown on the seemingly-empty composer typed it back in — a zombie
  // channel. Now the switch resets navigation (no zombie ⬇) AND the typed draft
  // is preserved per-thread and restored OPENLY in the textarea when the user
  // returns (#1067) — the right channel, in plain sight. ArrowDown with no walk
  // in progress is a no-op and must not disturb the restored draft.
  test(
    'the draft survives the switch openly in the textarea — never via a zombie ArrowDown',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))

      const dir = await seedProject(window)
      await activateProject(window, dir)
      await seedThread(window, dir, 'Draft A', [OLDER, NEWEST])
      await seedThread(window, dir, 'Draft B')

      await openThread(window, 'Draft A')
      await waitForHistorySeed(window, 'Draft A')
      const box = textarea(window)
      await box.click()
      await box.fill('half-typed thought')
      await box.press('ArrowUp') // enters navigation, saving the draft
      await expect(box).toHaveValue(NEWEST)

      await openThread(window, 'Draft B')
      // The recalled entry on screen at switch time is NOT the draft — thread B
      // opens with its own (empty) composer, and returning restores the TYPED
      // draft, not the recalled history entry (#1067).
      await expect(textarea(window)).toHaveValue('')
      await openThread(window, 'Draft A')
      const back = textarea(window)
      await expect(back, 'the typed draft is restored openly on return (#1067)').toHaveValue(
        'half-typed thought',
      )

      // No walk is in progress after the rebind (#1013) — ArrowDown is a no-op
      // and must not clobber or duplicate the restored draft.
      await back.click()
      await back.press('ArrowDown')
      await expect(back, 'ArrowDown with no walk in progress is a no-op').toHaveValue(
        'half-typed thought',
      )

      expect(errors, errors.join(', ')).toHaveLength(0)
    },
  )
})
