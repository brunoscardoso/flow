import type { Locator, Page } from '@playwright/test'

/**
 * The door to one project's actions (archive all, remove, colour, new thread):
 * the `⋯` button on the project's row in the Workspace switcher. The per-project
 * sidebar headers that used to carry it went with the Workspaces hard migration
 * (2026-10-06); the switcher row dispatches `flow:project-menu`, and the thread
 * sidebar opens the menu.
 */
export function projectActionsButton(win: Page, name: string): Locator {
  return win.locator('.fl-ws-project', { hasText: name }).locator(`[aria-label="${name} actions"]`)
}

/** Open the Workspace switcher and press `name`'s actions button. */
export async function openProjectActions(win: Page, name: string): Promise<Locator> {
  const switcher = win.locator('.fl-project-current')
  await switcher.click()
  const button = projectActionsButton(win, name)
  await button.waitFor({ state: 'visible', timeout: 5_000 })
  await button.click()
  const menu = win.locator('.fl-thread-menu')
  await menu.waitFor({ state: 'visible', timeout: 5_000 })
  return menu
}

/**
 * Whether the Workspace switcher lists `name` as a project open in this app —
 * a row with its own actions (a project that is only in the Workspace's record
 * has none). The switcher closes again after.
 */
export async function switcherListsProject(win: Page, name: string): Promise<boolean> {
  await win.locator('.fl-project-current').click()
  const menu = win.locator('.fl-project-menu')
  await menu.waitFor({ state: 'visible', timeout: 5_000 })
  const count = await projectActionsButton(win, name).count()
  await win.keyboard.press('Escape')
  return count > 0
}
