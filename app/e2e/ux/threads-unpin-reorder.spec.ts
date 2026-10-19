import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads, the UNPIN round-trip (inverse of the pin guard).
 *
 * The sibling probe `threads-actions.spec.ts` (PR #387) covers the pin *forward*
 * direction — pinning an older thread floats it above a newer sibling and shows
 * the pin glyph. NOTHING drives the reverse: after a user unpins, does the glyph
 * disappear AND does the thread fall back to its correct recency position, or
 * does it stay stuck at the top (a lingering "pinned" feel that would confuse a
 * user who deliberately unpinned it)?
 *
 * This is the regression guard for #164 (CLOSED) — "Unpinning a thread bumps
 * updated_at, wrongly reordering it to the top of the sidebar." Step 2 below is
 * the tripwire: after unpinning the OLDER "First", it must drop BELOW the newer
 * "Second". If unpin ever bumps updated_at again (the #164 defect), First would
 * float to the top and this assertion fails.
 *
 * The seam under test:
 *   thread-sidebar.ts #setPinned(thread, false) → threads.update({pinned:false})
 *   thread-grouping.ts capThreadList: pinned = items.filter(pinnedAt!==null),
 *     rest = filter(pinnedAt===null).sort(byRecency). Unpinning moves a row from
 *     `pinned` back into `rest`, re-sorted by updatedAt — so an OLD thread that
 *     was floated up must drop BELOW a newer unpinned sibling again, and the
 *     pin glyph (rendered only when pinnedAt!==null) must vanish.
 *
 * Credential-free: threads.create / threads.update are immediate IPC — no Claude
 * account needed.
 */


/** A thread row's title span, matched by text inside the fl-list shadow root. */
function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}

/** Open the ⋯ actions menu for a row via right-click. */
async function openRowMenu(win: Page, title: string) {
  await threadRow(win, title).first().click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  return menu
}

/** Create a thread and rename it (create auto-names it "New thread"). */
async function createNamed(win: Page, name: string) {
  await newThread(win)
  const menu = await openRowMenu(win, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  await win.locator('.fl-thread-menu-input').fill(name)
  await win.locator('.fl-thread-menu-input').press('Enter')
  await expect(threadRow(win, name).first()).toBeVisible({ timeout: 5000 })
}


/**
 * Make an EMPTY thread called "New thread" in the active project and open it —
 * what the toolbar "+" used to do. Since 2026-09-04 "+" opens the new-thread
 * PAGE, whose Create sends a first message; this spec is about the thread list,
 * not about starting a conversation, so the thread is made over the same IPC
 * the page ends in and opened by its row.
 */
async function newThread(win: Page): Promise<void> {
  await win.evaluate(async () => {
    const flow = (
      window as unknown as {
        flow: {
          project: { active(): Promise<{ rootPath: string } | null> }
          threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> }
        }
      }
    ).flow
    const active = await flow.project.active()
    if (active === null) throw new Error('newThread: no active project')
    await flow.threads.create({ projectRoot: active.rootPath, title: 'New thread' })
  })
  await openThreadByTitle(win, 'New thread')
}

test.afterAll(() => cleanupSeeds())

test('unpin: the pin glyph clears and the thread falls back to recency order', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // "First" is created first; "Second" (newer) sorts above it by recency.
  await createNamed(window, 'First')
  await createNamed(window, 'Second')

  // Baseline: Second (newer) sits above First.
  const firstBase = await threadRow(window, 'First').first().boundingBox()
  const secondBase = await threadRow(window, 'Second').first().boundingBox()
  expect(secondBase!.y).toBeLessThan(firstBase!.y)

  // Pin First → it floats above Second and gains the pin glyph.
  let menu = await openRowMenu(window, 'First')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Pin' }).click()
  // Every row now carries a hover "Pin" button with its own pin icon; the
  // pinned glyph is the one titled "Pinned".
  await expect(window.locator('fl-list').locator('fl-icon[name="pin"][title="Pinned"]')).toHaveCount(1, {
    timeout: 5000,
  })
  const firstPinned = await threadRow(window, 'First').first().boundingBox()
  const secondPinned = await threadRow(window, 'Second').first().boundingBox()
  expect(firstPinned!.y).toBeLessThan(secondPinned!.y)

  // Unpin First. The row menu now offers "Unpin" (label flips on pin state).
  menu = await openRowMenu(window, 'First')
  const unpin = menu.locator('.fl-thread-menu-item', { hasText: 'Unpin' })
  await expect(unpin).toBeVisible()
  await unpin.click()

  // 1) The pin glyph must disappear entirely.
  await expect(window.locator('fl-list').locator('fl-icon[name="pin"][title="Pinned"]')).toHaveCount(0, {
    timeout: 5000,
  })

  // 2) First must fall back BELOW Second (its older recency position) — not stay
  //    stuck at the top with a phantom "still pinned" ordering.
  await expect
    .poll(
      async () => {
        const f = await threadRow(window, 'First').first().boundingBox()
        const s = await threadRow(window, 'Second').first().boundingBox()
        return f && s ? s.y < f.y : null
      },
      { timeout: 5000 },
    )
    .toBe(true)

  // 3) STORE: the unpin persisted (pinnedAt cleared), not just the row UI.
  const pinStates = await window.evaluate(async (root) => {
    const api = (window as unknown as {
      flow: {
        threads: {
          list(r: { projectRoot: string }): Promise<Array<{ title: string; pinnedAt: string | null }>>
        }
      }
    }).flow
    return (await api.threads.list({ projectRoot: root })).map((t) => ({
      title: t.title,
      pinnedAt: t.pinnedAt,
    }))
  }, dir)
  expect(pinStates.find((t) => t.title === 'First')?.pinnedAt ?? null).toBeNull()

  expect(errors, errors.join(', ')).toHaveLength(0)
})
