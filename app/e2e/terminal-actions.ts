import type { Page } from '@playwright/test'

/**
 * The terminal header has no + (user decision 2026-11-24): terminals open from
 * the Run menu. With one project it offers "New terminal"; with several it
 * lists them (three at most, then "More projects"), each one click. These
 * helpers press it the way a person does, so a spec says what it wants instead
 * of which buttons exist today.
 */
const runPill = (win: Page) => win.locator('.fl-run-pill-run')
const entry = (win: Page, kind: string) => win.locator(`.fl-run-menu [data-menu-entry="${kind}"]`)

/** The open Run menu. */
export function runMenu(win: Page) {
  return win.locator('.fl-run-menu')
}

/** The Run menu's project rows (open the menu first). */
export function projectRows(win: Page) {
  return entry(win, 'terminal')
}

/** A project row's name, without its "this conversation" note. */
export function projectRowName(win: Page, index: number) {
  return projectRows(win).nth(index).locator('.fl-run-menu-grow')
}

/** Open the Run menu (closing it first if it is open). */
export async function openRunMenu(win: Page): Promise<void> {
  if ((await runMenu(win).count()) > 0) await win.keyboard.press('Escape')
  await runPill(win).click()
}

/**
 * A new terminal: open Run and press "New terminal". With several projects the
 * menu lists them instead, and is left open for the spec to pick one
 * (`newTerminalIn`).
 */
export async function clickNewTerminal(win: Page): Promise<void> {
  await openRunMenu(win)
  // The menu is drawn in the click handler itself, so a count right after the
  // click is not racing anything.
  const plain = entry(win, 'new-terminal')
  if ((await plain.count()) > 0) await plain.click()
}

/** A new terminal in the project whose name holds `name`. */
export async function newTerminalIn(win: Page, name: string): Promise<void> {
  await openRunMenu(win)
  const row = projectRows(win).filter({ hasText: name }).first()
  // Not in the short list: it is behind "More projects".
  if ((await row.count()) === 0) await entry(win, 'more-projects').click()
  await row.click()
}

/** Split the focused terminal: open Run, then "Split …". */
export async function clickSplitTerminal(win: Page): Promise<void> {
  await openRunMenu(win)
  await splitChoice(win).click()
}

/** The Run menu's split row (open the menu first). */
export function splitChoice(win: Page) {
  return entry(win, 'split-terminal')
}
