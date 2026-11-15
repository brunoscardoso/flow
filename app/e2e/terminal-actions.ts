import type { Page } from '@playwright/test'

/**
 * The terminal header has ONE + button (user decision 2026-11-15). With no
 * terminal open it opens one straight away; with one open it asks: "New
 * terminal" or "Split terminal". These helpers press it the way a person does,
 * so a spec says what it wants instead of which buttons exist today.
 */
const plus = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const choice = (win: Page, label: string) =>
  win.locator('.fl-term-root-menu .fl-term-root-item', { hasText: new RegExp(`^${label}$`) })

/** A new full terminal: press +, and pick "New terminal" when it asks. */
export async function clickNewTerminal(win: Page): Promise<void> {
  await plus(win).click()
  // The menu is drawn in the click handler itself, so a count right after the
  // click is not racing anything.
  const item = choice(win, 'New terminal')
  if ((await item.count()) > 0) await item.click()
}

/** Split the focused terminal: press +, then "Split terminal". */
export async function clickSplitTerminal(win: Page): Promise<void> {
  await plus(win).click()
  await choice(win, 'Split terminal').click()
}

/** The "Split terminal" row of the + menu (open the menu first). */
export function splitChoice(win: Page) {
  return choice(win, 'Split terminal')
}
