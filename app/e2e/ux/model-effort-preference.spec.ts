import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * #848 — persisted model+effort preference. An explicit composer pick becomes
 * the app-wide default: every thread created WITHOUT an explicit model
 * (sidebar threads, task threads, imports — they all go through threads:create
 * with the model omitted) starts from the preference instead of Auto.
 * Auto stays Auto, so plan-flow's per-phase model routing is untouched.
 */

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const t = (await (
        window as unknown as {
          flow: { threads: { create(i: object): Promise<{ id: string; model: string | null }> } }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return t.id
    },
    { root, title },
  )
}

async function threadModel(win: Page, root: string, id: string): Promise<{ model: string | null; effort: string | null }> {
  return win.evaluate(
    async ({ root, id }) => {
      const threads = (await (
        window as unknown as {
          flow: { threads: { list(r: { projectRoot: string }): Promise<Array<{ id: string; model: string | null; effort: string | null }>> } }
        }
      ).flow.threads.list({ projectRoot: root })) as Array<{ id: string; model: string | null; effort: string | null }>
      const t = threads.find((x) => x.id === id)
      return { model: t?.model ?? null, effort: t?.effort ?? null }
    },
    { root, id },
  )
}

test.afterAll(() => cleanupSeeds())

/**
 * Pick a model / effort the way a person does now: the composer's one
 * model+effort MENU (2026-09-04). The two <select>s are still the STATE behind
 * it but are kept out of sight, so they cannot be clicked — the menu writes
 * them and fires their `change`, which is what persists the pick.
 */
async function pickFromMenu(win: Page, row: 'Model' | 'Effort', value: string): Promise<void> {
  const select = win.locator(`.fl-composer-select[aria-label="${row}"]`)
  const raw = ((await select.locator(`option[value="${value}"]`).textContent()) ?? value).replace(
    /^effort:\s*/i,
    '',
  )
  const shown = raw.charAt(0).toUpperCase() + raw.slice(1)
  await win.locator('.fl-composer .fl-me-trigger').click()
  await win.locator('.fl-composer .fl-me-row', { hasText: row }).click()
  await win
    .locator('.fl-composer .fl-me-submenu .fl-me-choice', { hasText: new RegExp(`^${shown}`) })
    .first()
    .click()
  await expect(select).toHaveValue(value)
}

test('an explicit pick becomes the default for later threads; Auto resets it (#848)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)

  // Thread A: open it and pick a concrete model + effort in the composer.
  const idA = await createThread(window, dir, 'Pref Thread A')
  await window.getByText('Pref Thread A', { exact: true }).first().click()
  const modelSelect = window.locator('.fl-composer-select[aria-label="Model"]')
  const effortSelect = window.locator('.fl-composer-select[aria-label="Effort"]')
  await expect(window.locator('.fl-composer .fl-me-trigger')).toBeVisible()
  await pickFromMenu(window, 'Model', 'opus')
  await pickFromMenu(window, 'Effort', 'high')
  await expect.poll(async () => (await threadModel(window, dir, idA)).model).toBe('opus')

  // Thread B (created with NO model in the request): starts from the preference.
  const idB = await createThread(window, dir, 'Pref Thread B')
  expect(await threadModel(window, dir, idB)).toEqual({ model: 'opus', effort: 'high' })
  // The composer reflects it when the thread opens.
  await window.getByText('Pref Thread B', { exact: true }).first().click()
  await expect(modelSelect).toHaveValue('opus')
  await expect(effortSelect).toHaveValue('high')

  // Task threads go through the SAME store path (#885) — a task created while
  // the preference is opus/high spawns its 1:1 thread on opus/high.
  const taskThreadId = await window.evaluate(
    async ({ root }) => {
      const task = (await (
        window as unknown as {
          flow: { tasks: { create(i: object): Promise<{ threadId: string | null }> } }
        }
      ).flow.tasks.create({ projectRoot: root, title: 'Pref Task' })) as { threadId: string | null }
      return task.threadId
    },
    { root: dir },
  )
  expect(taskThreadId).not.toBeNull()
  expect(await threadModel(window, dir, taskThreadId as string)).toEqual({ model: 'opus', effort: 'high' })

  // Picking Auto resets the preference — thread C is Auto with no manual effort.
  await pickFromMenu(window, 'Model', 'auto')
  await expect.poll(async () => (await threadModel(window, dir, idB)).model).toBe('auto')
  const idC = await createThread(window, dir, 'Pref Thread C')
  expect((await threadModel(window, dir, idC)).model).toBe('auto')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
