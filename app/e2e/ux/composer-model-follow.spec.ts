import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): the model + effort picker FOLLOWS THE THREAD.
 *
 * The composer is a SINGLETON (`threads/index.ts:51`), so its two control-row
 * <select>s (Model — aria-label "Model", options Auto/Opus/Sonnet/Haiku — and
 * Effort — aria-label "Effort") are shared DOM across every thread. Picking a
 * concrete model calls `#pushModelSelection` → `threads:setModel`, which the main
 * process persists onto the thread record (`agent-manager.setModel` →
 * `threadStore.updateThread({ model, effort })`). On a genuine thread switch
 * `composer.setThread(thread)` re-reads `thread.model` / `thread.effort`
 * (`composer.ts:557-561`) from the freshly-listed thread object.
 *
 * That is a per-thread state-consistency seam with two distinct user harms if it
 * regresses:
 *   - LEAK: pin Opus in thread A, switch to a fresh thread B, and B silently
 *     shows/uses Opus — the user's next turn runs on the wrong (pricier) model.
 *   - LOSS: switch A→B→A and A has forgotten the Opus the user just pinned,
 *     silently falling back to Auto/routing.
 * Either way the turn runs on a model the user did not choose — a silent
 * mis-target of the model the app actually invokes.
 *
 * Un-probed: `composer-effort-auto-gating.spec.ts` (#332) drives the Model/Effort
 * selects within a SINGLE thread (locks effort under Auto, unlocks on a pinned
 * model). `composer-draft-switch.spec.ts` (#688) asserts the selector RESETS on a
 * switch — but only with both threads fresh (auto→auto), so it never proves a
 * NON-DEFAULT pick survives a round-trip nor that it doesn't leak into a sibling.
 * This probe drives the full follow-the-thread loop.
 *
 * Account-independent: `threads:create` + `project:add` + `threads:setModel`
 * need only a project root; nothing is sent to an agent.
 */

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

/** Read a thread's PERSISTED model/effort from the store (kills the async race). */
async function persistedSelection(
  win: Page,
  title: string,
): Promise<{ model: string | null; effort: string | null } | null> {
  return win.evaluate(async (title) => {
    const list = (await (
      window as unknown as {
        flow: {
          threads: {
            list(i: {
              includeArchived: boolean
            }): Promise<Array<{ title: string; model: string | null; effort: string | null }>>
          }
        }
      }
    ).flow.threads.list({ includeArchived: false })) as Array<{
      title: string
      model: string | null
      effort: string | null
    }>
    const t = list.find((x) => x.title === title)
    return t ? { model: t.model, effort: t.effort } : null
  }, title)
}

// Since 2026-09-04 model and effort share one menu; the selects are still the
// state and still what this asserts on, and the menu is how a person changes
// them.
const modelSelect = (win: Page) => win.locator(`${sel.composer} select[aria-label="Model"]`)
const effortSelect = (win: Page) => win.locator(`${sel.composer} select[aria-label="Effort"]`)

/** Open the menu, drill into `row`, and click the option labelled `choice`. */
async function pick(win: Page, row: 'Model' | 'Effort', choice: string): Promise<void> {
  await win.locator(`${sel.composer} .fl-me-trigger`).click()
  await win.locator(`${sel.composer} .fl-me-row`, { hasText: row }).click()
  await win.locator(`${sel.composer} .fl-me-choice`, { hasText: choice }).first().click()
}

test.afterAll(() => cleanupSeeds())

test('the composer model+effort pick follows the thread — persists on return, no leak into a sibling', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'README.md'), '# seeded\n')
  await activateProject(window, dir)
  await createThread(window, dir, 'Model Alpha')
  await createThread(window, dir, 'Model Beta')

  const model = modelSelect(window)
  const effort = effortSelect(window)

  // ── Open Alpha and pin a concrete model + a manual effort ──────────────────
  // (effort unlocks only once a concrete model is pinned — #332).
  await window.getByText('Model Alpha', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()
  await expect(model, 'fresh thread defaults to Auto').toHaveValue('auto')
  await expect(effort, 'effort is locked under Auto (#332)').toBeDisabled()

  await pick(window, 'Model', 'Opus')
  await expect(effort, 'pinning a concrete model unlocks effort').toBeEnabled()
  await pick(window, 'Effort', 'High')

  // The persistence roundtrip (setModel → updateThread) is async and fire-and-forget;
  // poll the store so the switch below can't race ahead of the IPC write.
  await expect
    .poll(() => persistedSelection(window, 'Model Alpha'), {
      message: 'Alpha should persist the pinned Opus + high effort',
    })
    .toEqual({ model: 'opus', effort: 'high' })

  // ── Switch to Beta: fresh thread → Auto, and Alpha's Opus must NOT leak ─────
  await window.getByText('Model Beta', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()
  await expect(model, "Beta is fresh — Alpha's Opus must NOT leak into it").toHaveValue('auto')
  await expect(effort, 'effort re-locks under Beta\'s Auto').toBeDisabled()

  // ── Switch BACK to Alpha: Opus + high RESTORED from the thread record ───────
  await window.getByText('Model Alpha', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()
  await expect(model, 'Alpha must restore the Opus the user pinned before leaving').toHaveValue(
    'opus',
  )
  await expect(effort, 'Alpha restores its unlocked effort control').toBeEnabled()
  await expect(effort, 'Alpha restores the high effort the user picked').toHaveValue('high')

  // ── Round-trip once more: no stuck Alpha state; each thread keeps its own ───
  await window.getByText('Model Beta', { exact: true }).click()
  await expect(model, 'Beta still Auto on the second visit — no stuck Opus').toHaveValue('auto')
  await window.getByText('Model Alpha', { exact: true }).click()
  await expect(model, 'Alpha still Opus on the second visit').toHaveValue('opus')
  await expect(effort).toHaveValue('high')

  await window.screenshot({ path: join(__dirname, '__screens', 'composer-model-follow.png') })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
