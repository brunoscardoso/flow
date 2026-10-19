import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openEmptyThread } from './fixtures/seed'

/**
 * Escape from a thread row's right-click menu hands the keyboard back to the
 * thread list.
 *
 * The ⋯ button left the rows on 2026-09-04 and the ROW became the menu's
 * anchor. The row's content is a plain `<div>` inside `<fl-list>`'s shadow
 * root: it cannot take focus, and the list recreates it on every render. So
 * Escape's "focus the anchor" did nothing, and the menu's own removal left the
 * user on `<body>` — arrows no longer moved through the threads.
 */
test.describe('thread row menu — Escape returns focus', () => {
  test.afterAll(() => cleanupSeeds())

  test('Escape from a row menu puts focus back on the thread list', async ({ window }) => {
    const root = await seedProject(window, 'flow-ux-rowmenu-focus-')
    await activateProject(window, root)
    await openEmptyThread(window, root, 'Row menu focus thread')

    const row = window
      .locator('.fl-thread-sidebar')
      .getByText('Row menu focus thread', { exact: true })
      .first()
    await row.click({ button: 'right' })
    const menu = window.locator('.fl-thread-menu')
    await expect(menu).toBeVisible()
    // The positive first (#28): the menu really took the keyboard.
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.classList.contains('fl-thread-menu-item') ?? false))
      .toBe(true)

    await window.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect
      .poll(() =>
        window.evaluate(() => {
          const active = document.activeElement
          if (active === null || active === document.body) return 'BODY'
          return active.closest('.fl-thread-sidebar') !== null ? active.tagName.toLowerCase() : 'ELSEWHERE'
        }),
      )
      .toBe('fl-list')
  })

  test('acting from a row menu by keyboard puts focus back on the thread list', async ({ window }) => {
    // The module's contract is "Escape (or acting) returns focus". Only Escape
    // did: choosing Pin closed the menu that held focus, and nothing handed
    // the keyboard back, so it fell to <body>.
    const root = await seedProject(window, 'flow-ux-rowmenu-act-')
    await activateProject(window, root)
    await openEmptyThread(window, root, 'Row menu action thread')

    const row = window
      .locator('.fl-thread-sidebar')
      .getByText('Row menu action thread', { exact: true })
      .first()
    await row.click({ button: 'right' })
    const menu = window.locator('.fl-thread-menu')
    await expect(menu).toBeVisible()
    // The positive first (#28): the keyboard is on Pin, and Enter really pins.
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.textContent ?? ''))
      .toBe('Pin')
    await window.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    await expect(
      window.locator('.fl-thread-sidebar').getByRole('button', { name: 'Unpin', exact: true }).first(),
    ).toBeVisible()
    await expect
      .poll(() =>
        window.evaluate(() => {
          const active = document.activeElement
          if (active === null || active === document.body) return 'BODY'
          return active.closest('.fl-thread-sidebar') !== null ? active.tagName.toLowerCase() : 'ELSEWHERE'
        }),
      )
      .toBe('fl-list')
  })
})
