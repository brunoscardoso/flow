import { expect, type Page } from '@playwright/test'

/**
 * DIVE INTO A TERRITORY CELL, the way a person does now.
 *
 * A press on a cell used to dive. Since the cell-hover work (#openOnClick,
 * user 2026-10-08: "calm, details on hover") a FIRST press OPENS the cell in
 * place — its details grow where it stands — and a press on the opened cell
 * goes IN when it has no diagram to explore. The sheet also re-lays once its
 * project is known, which can swallow an early press. So this presses until
 * the title strip names the cell, and fails with a sentence if it never does.
 */
export async function diveIntoCell(win: Page, name: string, timeout = 45_000): Promise<void> {
  const title = win.locator('.flow-board-root .fb-terr-title-name').first()
  await expect
    .poll(
      async () => {
        if ((await title.textContent().catch(() => null)) === name) return true
        await win
          .locator('.fb-terr-cell', { hasText: name })
          .first()
          .click({ position: { x: 8, y: 26 }, timeout: 5_000 })
          .catch(() => undefined)
        await win.waitForTimeout(1_200)
        return (await title.textContent().catch(() => null)) === name
      },
      { timeout, intervals: [100], message: `the dive into ${name} never happened` },
    )
    .toBe(true)
}

/**
 * Open the DIVED level's feature view — the header's `[data-control-glyph="diagram"]`
 * control (the cell's own door is gone, plan cell-hover-diagram FR-5).
 */
export async function openFeatureView(win: Page, name: string): Promise<void> {
  await win.mouse.move(0, 0)
  await win.getByRole('button', { name: new RegExp(`^Open ${escapeRegExp(name)}'s feature view`) }).click()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The Learning panel's door. The header's learn CHIP (`.fb-learn-chip`) is
 * only painted by the module-card stage (`#buildBoard` → `#renderLearnChip`),
 * which the Territory never draws; the permanent "Learn" header button is the
 * door a person has on the default sheet.
 */
export const LEARN_BUTTON = '.flow-board-root fl-button[title="Show learning progress"]'

export async function openLearningPanel(win: Page): Promise<void> {
  // The board is ONE instance per window: a panel left open in another
  // project's scope is still open here, and the button TOGGLES — so open only
  // what is closed.
  if (await win.locator('.flow-board-root .fb-learn-panel').first().isVisible()) return
  const button = win.locator(LEARN_BUTTON).first()
  await expect(button).toBeVisible({ timeout: 30_000 })
  await button.click()
  await expect(win.locator('.flow-board-root .fb-learn-panel').first()).toBeVisible({ timeout: 15_000 })
}

/**
 * The drift panel's door. The board's header Drift button and badge are
 * retired, and the Learning panel no longer carries a Drift tab (its tabs are
 * Modules and Docs since 82538cd9); the standalone panel opens from the ⌘P
 * command "Blueprint: Show Drift" (palette-commands.ts, `flow:blueprint-drift`).
 */
export async function openDriftPanel(win: Page): Promise<void> {
  await win.keyboard.press('ControlOrMeta+p')
  await win.locator('.fl-palette-panel').waitFor({ state: 'visible', timeout: 5000 })
  await win.locator('.fl-palette-input').fill('>Blueprint: Show Drift')
  await expect(win.locator('.fl-palette-row').first()).toContainText('Blueprint: Show Drift')
  await win.keyboard.press('Enter')
  await expect(win.locator('.flow-board-root .fb-drift-panel')).toBeVisible({ timeout: 15_000 })
}

/**
 * OPEN A FEATURE'S VIEW FROM WHEREVER THE SHEET IS — back to the top, in, and
 * through the dived level's own door.
 *
 * Only a feature with PARTS has a level to dive into (a part-less one reads as
 * its code story, plan cell-hover-diagram FR-6), and the feature view's door is
 * the dived level's title control — so a spec that opens one seeds a part.
 * Double-click goes IN on any cell; a single press opens a cell in place, and
 * on a cell with a drawn diagram it pins that diagram instead of diving.
 */
export async function openFeatureViewByName(win: Page, name: string): Promise<void> {
  const title = win.locator('.flow-board-root .fb-terr-title-name').first()
  const cell = win.locator('.fb-terr-cell', { hasText: name }).first()
  for (let i = 0; i < 5 && (await cell.count()) === 0; i += 1) {
    await win.keyboard.press('Escape')
    await win.waitForTimeout(500)
  }
  await expect(cell, `${name} is not on the sheet to open`).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(
      async () => {
        if ((await title.textContent().catch(() => null)) === name) return true
        await win.mouse.move(0, 0)
        await cell.dblclick({ position: { x: 8, y: 26 }, timeout: 5_000 }).catch(() => undefined)
        await win.waitForTimeout(1_200)
        return (await title.textContent().catch(() => null)) === name
      },
      { timeout: 45_000, intervals: [100], message: `the dive into ${name} never happened` },
    )
    .toBe(true)
  await openFeatureView(win, name)
}

/**
 * BE INSIDE `project` on the board. In a Workspace of two or more projects the
 * board's ROOT is the Workspace sheet — every project as a country, its
 * features standing inside — so a spec about one project's own level presses
 * that project's country the way a person does. A no-op when the board already
 * opened inside it.
 */
export async function enterProject(win: Page, project: string): Promise<void> {
  const title = win.locator('.flow-board-root .fb-terr-title-name').first()
  await expect
    .poll(
      async () => {
        if ((await title.textContent().catch(() => null)) === project) return true
        await win
          .locator('.flow-board-root .fb-ws-name', { hasText: project })
          .first()
          .click({ timeout: 3_000 })
          .catch(() => undefined)
        await win.waitForTimeout(800)
        return (await title.textContent().catch(() => null)) === project
      },
      { timeout: 45_000, intervals: [200], message: `the board never showed project ${project}` },
    )
    .toBe(true)
}
