import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'
import { join } from 'node:path'

/**
 * The new-thread page's Model picker offers the runtime's own models (#1918).
 *
 * Reported live: a user configured Copilot models in Settings → Models but could
 * not pick any of them when STARTING a session — the new-thread page's Model
 * dropdown was hardcoded to `modelOptionsFor('claude')` (Auto/Fable/Opus/Sonnet/
 * Haiku) and read no runtime. So a Copilot account's configured ids were
 * structurally unselectable there, and any pick was a Claude alias that Copilot's
 * CLI drops.
 *
 * The composer already followed the runtime (`composer-model-follow.spec.ts`);
 * this proves the SESSION-START surface does too. Account-independent: it only
 * writes settings and reads the rendered <select> — nothing is sent to an agent.
 */

const modelSelect = (win: Page) => win.locator('.fl-newthread select[aria-label="Model"]')

test.afterAll(() => cleanupSeeds())

/**
 * THE TWO PICKERS AGREE. They read the runtime separately once — one function
 * each, same two IPC calls — and disagreed on screen: the composer offered
 * Copilot's ids while this page still showed Claude's aliases (user,
 * 2026-09-16). One read now feeds both, and this is the assertion that keeps
 * them from drifting apart again.
 */
test('the new-thread page and the composer offer the same models (#1918)', async ({ window }) => {
  const dir = await seedProject(window)
  await activateProject(window, dir)

  await window.evaluate(async () => {
    const flow = (
      window as unknown as {
        flow: {
          settings: {
            setDefaultProvider(i: { provider: string }): Promise<unknown>
            setRuntimeModels(i: { provider: string; models: string[] }): Promise<unknown>
          }
        }
      }
    ).flow
    await flow.settings.setDefaultProvider({ provider: 'copilot' })
    await flow.settings.setRuntimeModels({ provider: 'copilot', models: ['claude-sonnet-5'] })
    document.dispatchEvent(new CustomEvent('flow:runtime-changed'))
  })

  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:new-thread'))
  })
  await expect(window.locator('.fl-newthread')).toBeVisible()

  const optionsOf = async (locator: ReturnType<Page['locator']>): Promise<string[]> =>
    locator.locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))

  const page = modelSelect(window)
  await expect(page.locator('option[value="claude-sonnet-5"]')).toHaveCount(1, { timeout: 30_000 })

  // Claude's aliases belong to a runtime this account is not using — their
  // presence here was the visible half of the drift.
  await expect(page.locator('option[value="opus"]')).toHaveCount(0)
  await expect(page.locator('option[value="fable"]')).toHaveCount(0)

  const composerModel = window.locator(`${sel.composer} select[aria-label="Model"]`)
  if ((await composerModel.count()) > 0) {
    expect(await optionsOf(page), 'both pickers read one answer').toEqual(
      await optionsOf(composerModel),
    )
  }
})

test('the new-thread model picker offers a configured Copilot model (#1918)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Configure a Copilot model and make Copilot the active runtime — exactly what
  // the Settings → Models editor persists.
  await window.evaluate(async () => {
    const flow = (window as unknown as {
      flow: {
        settings: {
          setDefaultProvider(i: { provider: string }): Promise<unknown>
          setRuntimeModels(i: { provider: string; models: string[] }): Promise<unknown>
        }
      }
    }).flow
    await flow.settings.setDefaultProvider({ provider: 'copilot' })
    await flow.settings.setRuntimeModels({ provider: 'copilot', models: ['gpt-5-mini'] })
  })

  // Open the new-thread page (the session-start surface).
  await window.locator(sel.newThread).first().click()
  await expect(window.locator('.fl-newthread')).toBeVisible()

  // The configured Copilot id is present and selectable — impossible on main,
  // where the picker only ever held the Claude aliases.
  const model = modelSelect(window)
  await expect(
    model.locator('option[value="gpt-5-mini"]'),
    'the configured Copilot model must be offered when starting a session',
  ).toHaveCount(1)
  // A Claude alias must NOT be offered under Copilot — it is the wrong runtime's
  // model and the CLI would reject it.
  await expect(model.locator('option[value="opus"]')).toHaveCount(0)

  // Picked the way a person does: the page's model+effort MENU (the <select>
  // is the state behind it and is kept out of sight, 2026-09-04).
  await window.locator('.fl-newthread .fl-me-trigger').click()
  await window.locator('.fl-newthread .fl-me-row', { hasText: 'Model' }).click()
  const label = (await model.locator('option[value="gpt-5-mini"]').textContent()) ?? 'gpt-5-mini'
  const shown = label.charAt(0).toUpperCase() + label.slice(1) // the menu's own casing
  await window
    .locator('.fl-newthread .fl-me-submenu .fl-me-choice', { hasText: shown })
    .first()
    .click()
  await expect(model).toHaveValue('gpt-5-mini')

  await window.screenshot({ path: join(__dirname, '__screens', 'new-thread-model-picker.png') })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
