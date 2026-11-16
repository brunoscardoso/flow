import { expect, type Locator, type Page } from '@playwright/test'

/**
 * THE BOARD'S FLOATING CHROME (mockup J3, user pick 2026-11-15). On a
 * territory view (a project's map at any depth, the Workspace sheet) the board
 * header is not drawn; the chrome floats over the map:
 *   · top-left: the Ask field, and the trail under it (‹ ›, crumbs, actions);
 *   · bottom-left: the Layers button — what the map shows, one at a time;
 *   · bottom-right: the Knowledge pill — opens the Learning panel.
 */
export const TRAIL = '.flow-board-root .fb-float-trail'
export const CRUMBS = `${TRAIL} .fb-terr-crumbs`
export const LAYERS_BUTTON = '.flow-board-root .fb-layers-btn'
export const KNOWLEDGE = '.flow-board-root .fb-knowledge-pill'

export type Layer = 'map' | 'connections' | 'learning' | 'changes'

/** The Back arrow wherever it is drawn — the trail on a territory, the header elsewhere. */
export function backArrow(page: Page): Locator {
  return page.locator('.flow-board-root .fb-nav-btn[aria-label^="Back"], .flow-board-root .fb-nav-btn[aria-label^="Nothing to go back"]').first()
}

/** The layer the map shows now. */
export async function currentLayer(page: Page): Promise<string | null> {
  return page.locator(LAYERS_BUTTON).first().getAttribute('data-layer')
}

/** Pick a layer from the Layers menu, the way a person does. */
export async function chooseLayer(page: Page, layer: Layer): Promise<void> {
  const button = page.locator(LAYERS_BUTTON).first()
  await expect(button).toBeVisible({ timeout: 30_000 })
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  const item = page.locator(`.flow-board-root .fb-layers-item[data-layer="${layer}"]`)
  await expect(item).toBeEnabled({ timeout: 10_000 })
  await item.click()
  await expect(page.locator(LAYERS_BUTTON).first()).toHaveAttribute('data-layer', layer, { timeout: 10_000 })
}

/** Which layers the menu offers here — opened and closed again. */
export async function offeredLayers(page: Page): Promise<string[]> {
  const button = page.locator(LAYERS_BUTTON).first()
  await button.click()
  const ids = await page.locator('.flow-board-root .fb-layers-item').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset['layer'] ?? ''))
  await page.keyboard.press('Escape')
  await expect(page.locator('.flow-board-root .fb-layers-menu')).toHaveCount(0)
  return ids
}

/** Open the Learning panel from the Knowledge pill (a no-op when open). */
export async function openKnowledgePanel(page: Page): Promise<void> {
  if (await page.locator('.flow-board-root .fb-learn-panel').first().isVisible()) return
  await page.locator(KNOWLEDGE).first().click()
  await expect(page.locator('.flow-board-root .fb-learn-panel').first()).toBeVisible({ timeout: 15_000 })
}

export async function closeKnowledgePanel(page: Page): Promise<void> {
  if (!(await page.locator('.flow-board-root .fb-learn-panel').first().isVisible())) return
  await page.locator(KNOWLEDGE).first().click()
  await expect(page.locator('.flow-board-root .fb-learn-panel')).toHaveCount(0, { timeout: 15_000 })
}
