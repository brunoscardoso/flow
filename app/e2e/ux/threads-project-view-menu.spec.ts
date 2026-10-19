import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * HOW A PROJECT'S LIST IS SHOWN — order, and whether it holds the archive.
 *
 * "i don't like where we are showing the archive access, lets have something
 * like that, a button to sort order of the repo beside of the plus icon … and
 * also a archieve option there, so, if the user press it, we should show the
 * itens archived on the list."
 *
 * Both answers used to be somewhere else. Order was not a question at all —
 * newest-first, always — and the archive was a row at the BOTTOM of the whole
 * sidebar, under every project, expanding into a mixed pile. Both are about one
 * project, so both are on it, beside the `+` that already acts on it.
 */
test.afterAll(() => cleanupSeeds())

// The control is an `fl-button` (the sidebar's ghost icon buttons), not a bare <button>.
const MENU_BTN = 'fl-button[aria-label^="Sort and filter"]'

/** Seed three chats with names that sort differently from their recency. */
async function seedList(window: Page, dir: string): Promise<void> {
  await window.evaluate(async (p) => {
    const flow = window.flow as unknown as {
      threads: {
        create(r: { projectRoot: string; title: string }): Promise<{ id: string }>
        update(r: { threadId: string; patch: { archived: boolean } }): Promise<unknown>
      }
    }
    // Created oldest-first, so "Zebra" is the LEAST recent and would sit last
    // by the default order — which is what makes the name sort observable.
    for (const title of ['Zebra chat', 'Alpha chat', 'Middle chat']) {
      await flow.threads.create({ projectRoot: p, title })
    }
    const gone = await flow.threads.create({ projectRoot: p, title: 'Put away chat' })
    await flow.threads.update({ threadId: gone.id, patch: { archived: true } })
  }, dir)
  // WAIT FOR THE LIST, NOT A CLOCK. The sidebar redraws off a debounced
  // `threads:updated`; asserting before it lands reads a menu built from an
  // empty project and calls the archive count zero.
  await expect.poll(() => titles(window), { timeout: 15_000 }).toHaveLength(3)
}

/** The chat titles the sidebar is showing, in order. Pierces the list's shadow. */
function titles(window: Page): Promise<string[]> {
  return window.locator('.fl-thread-sidebar fl-list').getByText(/chat$/).allTextContents()
}

test('the menu sits beside the +, and offers the order and the archive', async ({ window }) => {
  const dir = await seedProject(window, 'flow-ux-viewmenu1-')
  await activateProject(window, dir)
  await seedList(window, dir)

  const button = window.locator(MENU_BTN).first()
  await expect(button).toHaveCount(1)
  await button.click({ force: true })
  await expect(window.locator('.fl-thread-menu')).toBeVisible()

  // The current order is marked with the same "●" the lane menus use, so
  // "which one am I on" has one vocabulary across the app.
  await expect(
    window.locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'Last updated' }),
  ).toHaveText('● Last updated')
  // …and the archive carries its count, which is the only sign there is
  // anything behind it at all.
  await expect(
    window.locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'Archived' }),
  ).toHaveText('Archived (1)')
})

test('sorting by name re-orders the project\'s list', async ({ window }) => {
  const dir = await seedProject(window, 'flow-ux-viewmenu2-')
  await activateProject(window, dir)
  await seedList(window, dir)

  // THE DEFAULT IS NOT ASSERTED. It is recency, these three are written in the
  // same second, and `capThreadList`'s recency compare has no tie-break — so
  // which comes first is the store's order rather than a promise, and an
  // assertion about it fails roughly one run in three. What IS promised is
  // where the list lands after the choice, and that is what is checked.

  await window.locator(MENU_BTN).first().click({ force: true })
  await window.locator('.fl-thread-menu-item', { hasText: 'Name' }).click()

  await expect.poll(() => titles(window), { timeout: 10_000 }).toEqual([
    'Alpha chat',
    'Middle chat',
    'Zebra chat',
  ])
})

test('the archive option shows the ITEMS, not another thing to expand', async ({ window }) => {
  const dir = await seedProject(window, 'flow-ux-viewmenu3-')
  await activateProject(window, dir)
  await seedList(window, dir)

  await expect.poll(() => titles(window), { timeout: 10_000 }).not.toContain('Put away chat')

  await window.locator(MENU_BTN).first().click({ force: true })
  await window.locator('.fl-thread-menu-item', { hasText: 'Archived' }).click()

  // ONE PRESS. The section used to need a second click on its own header — a
  // toggle that revealed a toggle.
  await expect.poll(() => titles(window), { timeout: 10_000 }).toContain('Put away chat')

  // …and pressing again puts it back.
  await window.locator(MENU_BTN).first().click({ force: true })
  await window.locator('.fl-thread-menu-item', { hasText: 'Archived' }).click()
  await expect.poll(() => titles(window), { timeout: 10_000 }).not.toContain('Put away chat')
})

test('a project with nothing archived says so instead of offering a dead press', async ({
  window,
}) => {
  const dir = await seedProject(window, 'flow-ux-viewmenu4-')
  await activateProject(window, dir)
  await window.evaluate(async (p) => {
    const flow = window.flow as unknown as {
      threads: { create(r: { projectRoot: string; title: string }): Promise<{ id: string }> }
    }
    await flow.threads.create({ projectRoot: p, title: 'Only chat' })
  }, dir)

  await window.locator(MENU_BTN).first().click({ force: true })
  const archived = window.locator('.fl-thread-menu-item', { hasText: 'Archived' })
  await expect(archived).toHaveText('Archived (0)')
  await expect(archived).toBeDisabled()
  // A control that cannot act owes its reason in its own terms.
  await expect(archived).toHaveAttribute('title', 'Nothing in this project has been archived.')
})
