import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): the effort selector must be LOCKED while the
 * model is "Auto", and editable only when a concrete model is pinned (#332).
 *
 * The composer exposes two <select>s in its control row: Model (aria-label
 * "Model", options Auto/Opus/Sonnet/Haiku) and Effort (aria-label "Effort",
 * options low/medium/high). "Auto" delegates the tier to plan-flow MODEL
 * ROUTING — the routing map ({low,medium,high} → model) owns effort under it.
 * If the user could also drive effort in Auto mode, the user (not the routing)
 * would be choosing the tier, so the routing would never actually force
 * anything (#332). The fix: `effortControlState` (effort-control.ts) returns
 * `disabled: true` under Auto, and `#syncEffortEnabled` (composer.ts:1412)
 * applies it to the live <select> on construction AND on every model `change`.
 *
 * The pure decision has a unit test, but the LIVE control — an enabled-looking
 * Effort dropdown under Auto that silently does nothing would be a dead control
 * (the exact #430/#433 dead-affordance class the composer guards elsewhere) —
 * had ZERO e2e coverage: no composer spec drives the Effort <select> disabled
 * state, and composer-draft-switch only reads the MODEL select's value round-trip.
 *
 * Driven against a seeded project (no Claude account — threads:create +
 * project:add need only a project root; nothing is sent, no agent runs).
 */

const AUTO_TITLE = /model routing/i

async function createThread(win: Page, root: string, title: string): Promise<void> {
  await win.evaluate(
    async ({ root, title }) => {
      await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow.threads.create({ projectRoot: root, title })
    },
    { root, title },
  )
}

// The selects are still the STATE and still carry the rule; since 2026-09-04
// they are hidden behind one model+effort menu, so a person reaches them
// through it. Assertions read the selects (that is where the truth is); actions
// go through the menu (that is what a person can actually press).
const modelSelect = (win: Page) => win.locator(`${sel.composer} select[aria-label="Model"]`)
const effortSelect = (win: Page) => win.locator(`${sel.composer} select[aria-label="Effort"]`)
const menuTrigger = (win: Page) => win.locator(`${sel.composer} .fl-me-trigger`)

/** Open the menu, drill into `row`, and click the option labelled `choice`. */
async function pick(win: Page, row: 'Model' | 'Effort', choice: string): Promise<void> {
  await menuTrigger(win).click()
  await win.locator(`${sel.composer} .fl-me-row`, { hasText: row }).click()
  await win.locator(`${sel.composer} .fl-me-choice`, { hasText: choice }).first().click()
}

/** Whether the menu's own row for `name` is offered or explained-away. */
async function rowDisabled(win: Page, name: 'Model' | 'Effort'): Promise<boolean> {
  await menuTrigger(win).click()
  const row = win.locator(`${sel.composer} .fl-me-row`, { hasText: name })
  const disabled = await row.isDisabled()
  await win.keyboard.press('Escape')
  return disabled
}

test.afterAll(() => cleanupSeeds())

test('effort is locked under Auto, unlocks when a model is pinned, and re-locks on Auto (#332)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(window, dir)
  await createThread(window, dir, 'Effort Thread')

  await window.getByText('Effort Thread', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()

  const model = modelSelect(window)
  const effort = effortSelect(window)

  // 1. DEFAULT (fresh thread → model 'auto'): effort is LOCKED, and its tooltip
  //    explains why (routing owns it). An enabled dropdown here would be a dead
  //    control — the user picks a tier the routing then overrides.
  await expect(model).toHaveValue('auto')
  await expect(effort, 'effort must be disabled while the model is Auto').toBeDisabled()
  await expect(effort).toHaveAttribute('title', AUTO_TITLE)
  // …and the menu says so too: a row a person cannot use must not look usable.
  expect(await rowDisabled(window, 'Effort'), 'the Effort row must be off under Auto').toBe(true)

  // 2. PIN a concrete model (Opus): effort UNLOCKS synchronously (the model
  //    `change` handler calls #syncEffortEnabled in the same tick).
  await pick(window, 'Model', 'Opus')
  await expect(model).toHaveValue('opus')
  await expect(effort, 'pinning a concrete model must enable effort').toBeEnabled()
  // Now editable: pick a non-default tier and confirm it takes (not a no-op control).
  await pick(window, 'Effort', 'High')
  await expect(effort).toHaveValue('high')

  // 3. BACK to Auto: effort RE-LOCKS immediately (the dynamic transition the
  //    unit test can't cover — a stale enabled control here is the bug).
  await pick(window, 'Model', 'Auto')
  await expect(model).toHaveValue('auto')
  await expect(effort, 'switching back to Auto must re-disable effort').toBeDisabled()
  await expect(effort).toHaveAttribute('title', AUTO_TITLE)
  expect(await rowDisabled(window, 'Effort'), 'the Effort row must be off again').toBe(true)

  await window.screenshot({ path: join(__dirname, '__screens', 'composer-effort-auto-gating.png') })

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// The menu's Escape listener used to be added in a `setTimeout(0)` after the
// opening click. An Escape that reached the page before that timer ran — a
// busy renderer, or a quick hand — was dropped, so the menu stayed open and the
// next press on the trigger CLOSED it instead of opening it. That is how the
// test above flaked inside a shard (`.fl-me-row` "not visible") and passed
// alone. Here the Escape is sent in the same task as the click, so no timer can
// run between them.
test('Escape closes the model+effort menu even when it follows the opening click at once', async ({
  window,
}) => {
  const dir = await seedProject(window)
  await activateProject(window, dir)
  await createThread(window, dir, 'Escape Thread')
  await window.getByText('Escape Thread', { exact: true }).click()
  await expect(menuTrigger(window)).toBeVisible()

  const state = await window.evaluate((composer) => {
    const trigger = document.querySelector<HTMLButtonElement>(`${composer} .fl-me-trigger`)!
    const panel = document.querySelector<HTMLElement>(`${composer} .fl-me-panel`)!
    trigger.click()
    const openedByClick = !panel.hidden
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return { openedByClick, hiddenAfterEscape: panel.hidden }
  }, sel.composer)

  // The click really opened it (the positive), and the Escape really closed it.
  expect(state.openedByClick, 'the trigger click must open the menu').toBe(true)
  expect(state.hiddenAfterEscape, 'an immediate Escape must close the menu').toBe(true)
  await expect(window.locator(`${sel.composer} .fl-me-panel`)).toBeHidden()
})
