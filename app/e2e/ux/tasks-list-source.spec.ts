import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeDirective } from './fixtures/loops'

/**
 * "Where does this project's work come from" — the setting that decides whether
 * the board has a Remote column at all.
 *
 * IT HAD NO HOME FOR A DAY. Deleting the Loops screen took the only control
 * that could re-point a project's list, so a mission could be steered and its
 * queue could not. This walks the path a person now has.
 *
 * IT IS NOT THE REMOTE COLUMN'S SOURCE — see the tail of this test, and
 * tasks-remote-column.spec.ts for the question that column actually asks.
 *
 * The write lands in the DIRECTIVE, which is the store, so this asserts the
 * file on disk rather than the panel's own optimism.
 */
test.afterAll(() => cleanupSeeds())

test('Settings can point this project at a GitHub list, and the file says so', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  const dir = await seedProject(window)
  writeDirective(dir, { loop: 'fix', engine: 'consumer', paused: true, mission: 'Drain the list' })
  await activateProject(window, dir)

  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  // Settings is a tabbed PAGE now; this setting lives under Tasks.
  await window.locator('.fl-settings-tab', { hasText: 'Tasks' }).click()
  const section = window.locator('.fl-settings-section', { hasText: 'Task list' })
  await expect(section).toBeVisible({ timeout: 15_000 })
  // It reads what the project has now — the seeded list is the project's own.
  await expect(section).toContainText('This project', { timeout: 15_000 })

  const picker = section.locator('select')
  const repo = section.locator('input[type="text"]')
  const save = section.locator('.fl-settings-inline-btn', { hasText: 'Use this list' })

  await picker.selectOption('github')
  // REFUSED BEFORE THE WRITE LEAVES THE APP. "widgets" is not a repository, and
  // the sentence about it is about the box on screen rather than a file on disk.
  await repo.fill('widgets')
  await expect(section).toContainText('acme/widgets')
  await expect(save).toBeDisabled()

  await repo.fill('acme/widgets')
  await expect(save).toBeEnabled()
  await save.click()
  await expect(section).toContainText('1 loop', { timeout: 15_000 })

  // THE FILE IS THE STORE. The panel is a view of it, so this asserts the
  // directive rather than the sentence the panel printed.
  await expect
    .poll(() => readFileSync(join(dir, 'loops', 'fix.md'), 'utf-8'), { timeout: 10_000 })
    .toContain('queue: github')
  expect(readFileSync(join(dir, 'loops', 'fix.md'), 'utf-8')).toContain('repo: acme/widgets')

  // IT DOES NOT DRIVE THE REMOTE COLUMN, and that is the correction this whole
  // area needed. This setting says where a LOOP reads its work — a repository's
  // list, in a committed file. The column says what is assigned to YOU, which
  // an integration answers (tasks-remote-column.spec.ts). Building the column
  // on this setting is what made it unreachable for a project reading a local
  // list, which is what the user hit twice.
  await window.locator('.fl-rail-item[aria-label="Tasks"]').click()
  await expect(window.locator('.fl-board-lane-btn[aria-label="New task"]')).toBeVisible({
    timeout: 20_000,
  })
  await expect(window.locator('.fl-board-remote')).toBeHidden()

  expect(errors).toEqual([])
})
