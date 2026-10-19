/**
 * The evidence has to be REACHABLE.
 *
 * The performance log exists so the next "it is slow" has an answer, and the
 * only way a person gets it out of the app is Help ▸ Copy Performance Report.
 * A menu item that does not work is worse than none: it looks like the app
 * answered.
 */
import { test, expect } from '@playwright/test'

import { close, dismissOnboarding, freshUserData, launch } from './launch'

test('Help offers the performance report, and it copies something real', async () => {
  test.setTimeout(300_000)
  const userData = freshUserData('menu')
  const { app, window } = await launch(userData)
  await dismissOnboarding(window)

  // The menu, as the OS was handed it.
  const items = await app.evaluate(async ({ Menu }) => {
    const menu = Menu.getApplicationMenu()
    const help = menu?.items.find((item) => item.role === 'help')
    return (help?.submenu?.items ?? []).map((item) => item.label)
  })
  expect(items).toContain('Copy Performance Report')
  expect(items).toContain('Show Performance Log')

  // …and pressing it puts the log on the clipboard.
  const copied = await app.evaluate(async ({ Menu, clipboard }) => {
    clipboard.writeText('')
    const help = Menu.getApplicationMenu()?.items.find((item) => item.role === 'help')
    const copy = help?.submenu?.items.find((item) => item.label === 'Copy Performance Report')
    copy?.click()
    return clipboard.readText()
  })
  // Either the log's tail or the honest empty answer — never nothing at all.
  expect(copied).toMatch(/Flow .* — (performance log|nothing has been slow)/)

  await close(app)
})
