import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * The IN-SESSION composer offers the runtime's own models (#1918).
 *
 * THE SURFACE THE ISSUE WAS ABOUT, AND THE ONE NOTHING TESTED. A Copilot
 * account with four models pinned in Settings → Models opened a thread and
 * found a Model menu containing one entry: Auto. The list was built by a
 * dedupe written as
 *
 *     .filter((v) => v !== '' && !taken.has(v) && !taken.add(v))
 *
 * and `Set.add` returns the SET — truthy — so the negation was always false and
 * every configured model was discarded. Worse than a short list: the composer
 * hides the picker at `options.length < 2`, so the bug removed the control.
 *
 * It survived a fix and a close because the coverage pointed elsewhere.
 * `composer-model-follow.spec.ts` picks and persists a model under CLAUDE,
 * whose base aliases are never empty, so it passes with the extras all gone;
 * `new-thread-model-picker.spec.ts` drives the new-thread page. Neither ever
 * asserted that this surface LISTS what the runtime was configured with.
 *
 * Account-independent: it writes settings and reads the rendered <select>.
 * Nothing is sent to an agent, and no Copilot session is started.
 */

const PINNED = ['claude-sonnet-5', 'claude-sonnet-4.5', 'claude-haiku-4.5', 'gpt-5-mini']

const modelSelect = (win: Page) => win.locator(`${sel.composer} select[aria-label="Model"]`)

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

test.afterAll(() => cleanupSeeds())

test('the composer lists the models configured for the active runtime (#1918)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Exactly what the Settings → Models editor persists, and what the reporter's
  // machine held: Copilot as the runtime, four models pinned.
  await window.evaluate(async (models) => {
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
    await flow.settings.setRuntimeModels({ provider: 'copilot', models })
    // The cue the composer listens for — the same one Settings dispatches on save.
    document.dispatchEvent(new CustomEvent('flow:runtime-changed'))
  }, PINNED)

  await createThread(window, dir, 'Copilot models')
  await window.getByText('Copilot models', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()

  const model = modelSelect(window)

  for (const id of PINNED) {
    await expect(
      model.locator(`option[value="${id}"]`),
      `${id} is configured for this runtime and must be selectable in a session`,
    ).toHaveCount(1, { timeout: 30_000 })
  }

  // Auto stays, and it is not the only thing there — the exact shape of the bug.
  await expect(model.locator('option[value="auto"]')).toHaveCount(1)
  const optionCount = await model.locator('option').count()
  expect(optionCount).toBeGreaterThan(1)

  // THE CONTROL EXISTS AT ALL — and offers them. Since the model+effort menu
  // (2026-09-04) the <select> is the STATE and is always kept out of sight; the
  // surface a person uses is the menu's trigger, then its Model row. Under the
  // bug the Model row offered one entry, Auto.
  const trigger = window.locator(`${sel.composer} .fl-me-trigger`)
  await expect(trigger).toBeVisible()
  await trigger.click()
  await window.locator(`${sel.composer} .fl-me-row`, { hasText: 'Model' }).click()
  const choices = window.locator(`${sel.composer} .fl-me-submenu .fl-me-choice`)
  await expect(choices).toHaveCount(optionCount)
  await window.keyboard.press('Escape')

  // A Claude alias is not on offer under Copilot: its CLI refuses those, which
  // is why the list is built from the runtime rather than from a constant.
  await expect(model.locator('option[value="opus"]')).toHaveCount(0)

  expect(errors, 'no renderer errors while building the model list').toEqual([])
})
