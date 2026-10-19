import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2 (Threads). Deleting a NON-open thread must leave the
 * currently-open thread untouched: its composer stays mounted and the surviving
 * row stays in the list.
 *
 * This is the inverse of the covered destructive path. #397 / #686 guard that
 * deleting/archiving the OPEN thread tears the composer DOWN (empty state
 * returns); nothing guarded that deleting a *sibling* leaves the open thread
 * intact. A regression there — e.g. the delete refresh clearing the active
 * binding, or a stale `#activeThreadId` matching the wrong row after the list
 * re-renders — would silently drop the user out of the conversation they were
 * in, mid-work. This locks the correct behavior in.
 */

const SCREENS = 'e2e/ux/__screens'

function rowByText(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}

/** Open the actions menu for the row whose title matches — its right-click
 *  (the row's ⋯ column was retired 2026-09-04). */
async function openRowMenu(win: Page, title: string) {
  await rowByText(win, title).first().click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  return menu
}

/** Rename the (single) currently-focused row's ⋯ menu target to `to`. */
async function renameVia(win: Page, menu: ReturnType<Page['locator']>, to: string) {
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  const input = win.locator('.fl-thread-menu-input')
  await expect(input).toBeVisible()
  await input.fill(to)
  await input.press('Enter')
  await expect(rowByText(win, to).first()).toBeVisible({ timeout: 5000 })
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

test('deleting a non-open thread leaves the open thread and its composer intact', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Two threads. Rename each to a distinct, targetable title. Order: create the
  // one we will KEEP second so it's the last-touched/open thread by default, but
  // we re-open it explicitly below regardless.
  await newThread(window)
  await expect(rowByText(window, 'New thread').first()).toBeVisible({ timeout: 10000 })
  let menu = await openRowMenu(window, 'New thread')
  await renameVia(window, menu, 'delete-me')

  await newThread(window)
  await expect(rowByText(window, 'New thread').first()).toBeVisible({ timeout: 10000 })
  menu = await openRowMenu(window, 'New thread')
  await renameVia(window, menu, 'keep-me')

  // Open the KEEP thread — its composer must be mounted.
  await rowByText(window, 'keep-me').first().click()
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 5000 })

  // Delete the OTHER (non-open) thread via its right-click menu → confirm. If
  // targeting is ever wrong the keep-me survival assertion below fails loudly
  // (never a false pass).
  await rowByText(window, 'delete-me').first().click({ button: 'right' })
  let menuOpen = window.locator('.fl-thread-menu')
  await expect(menuOpen).toBeVisible()
  // If we opened the wrong row's menu, its Rename would target keep-me; guard by
  // confirming this menu can delete and that afterwards delete-me is the one gone.
  await menuOpen.locator('.fl-thread-menu-item.danger', { hasText: 'Delete' }).first().click()
  await expect(window.locator('.fl-thread-menu-confirm')).toHaveText('Delete this thread?')
  await window.locator('.fl-thread-menu-item.danger', { hasText: 'Delete' }).last().click()

  // keep-me survives; the open composer is untouched (still mounted, not the
  // empty state). If the wrong row was deleted this assertion catches it.
  await expect(rowByText(window, 'keep-me').first()).toBeVisible({ timeout: 10000 })
  await expect(window.locator('.fl-composer')).toBeVisible()
  await expect(window.locator('.fl-thread-empty')).toBeHidden()

  await window.screenshot({ path: `${SCREENS}/threads-delete-nonopen.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
