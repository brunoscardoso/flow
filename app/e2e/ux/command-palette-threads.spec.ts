import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — the ⌘P palette's THREAD source. Threads come from the existing FTS
 * search (window.flow.threads.search over titles + message bodies). Seeds a
 * thread with a distinctive title, then proves content-mode typing surfaces it
 * as a blended candidate and Enter activates it. No agent/account needed — the
 * title is indexed on create.
 */

test.afterAll(() => cleanupSeeds())

test('content search surfaces a matching thread and Enter opens it', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const proj = await seedProject(window)
  await activateProject(window, proj)

  // Seed a thread with a distinctive, searchable title (FTS indexes it on create).
  await window.evaluate(async (root) => {
    await (
      window as unknown as {
        flow: { threads: { create(r: { projectRoot: string; title: string }): Promise<unknown> } }
      }
    ).flow.threads.create({ projectRoot: root, title: 'Zephyr deployment runbook' })
  }, proj)

  const panel = window.locator('.fl-palette-panel')
  const input = panel.locator('.fl-palette-input')

  await window.keyboard.press('ControlOrMeta+p') // plain content mode
  await expect(panel).toBeVisible()
  await input.fill('zephyr')

  // The thread surfaces as a blended candidate (thread source → FTS).
  const threadRow = window.locator('.fl-palette-row', { hasText: 'Zephyr deployment runbook' })
  await expect(threadRow).toBeVisible({ timeout: 10_000 })

  // Enter activates it and the palette closes.
  await window.keyboard.press('Enter')
  await expect(panel).toBeHidden()

  expect(errors).toEqual([])
})
