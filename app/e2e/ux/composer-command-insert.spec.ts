import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): the POSITIVE /-skill insertion path.
 *
 * This is the live regression guard the codebase always intended but never
 * enabled: composer.spec.ts still carries a `test.fixme` for "typing / opens
 * the command autocomplete and inserts the picked skill", left disabled since
 * #391 (picking a /-skill from a cold command cache stranded the last-typed
 * char, e.g. `/brainstorm r`). #391 was fixed (CLOSED/COMPLETED) by capturing
 * the replacement span from the live value at accept time
 * (`computeCommandInsertion` derives it from the leading `/\S*` token, immune to
 * the cold-cache keystroke race), yet the guard was never un-fixmed — so the
 * user-facing promise ("/ skill" in the composer placeholder) has NO end-to-end
 * coverage. The sibling @-file insert path IS covered (composer.spec.ts); the
 * /-command insert is the gap.
 *
 * Driven against a seeded project (no Claude account — `threads:create` +
 * `project:listCommands` need only a project root + `.claude/commands/*.md`).
 * The composer only mounts once a thread is active, so each test seeds a project,
 * populates it with real skills, and opens a thread first.
 *
 * `repeat-each` matters here: the original bug reproduced on ~2 of 3 attempts
 * (flaky, cold-cache dependent). A single green run proves little; a stable
 * repeat-each run proves the fix is deterministic, not lucky.
 */

const COMMAND_POPUP = '.fl-composer-commands'

/** Create a thread in `root` via the same IPC the "+" button calls. */
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

/** Populate the seeded repo with real slash-command skills for the /-autocomplete. */
function populateSkills(dir: string): void {
  const commandsDir = join(dir, '.claude', 'commands')
  mkdirSync(commandsDir, { recursive: true })
  writeFileSync(
    join(commandsDir, 'brainstorm.md'),
    '---\ndescription: Explore an idea\n---\nBrainstorm body\n',
  )
  writeFileSync(
    join(commandsDir, 'discovery-plan.md'),
    '---\ndescription: Gather requirements\n---\nDiscovery body\n',
  )
}

/** Seed a project, populate skills, activate it, create + open a thread → composer up. */
async function openComposer(win: Page, title = 'Command insert probe'): Promise<string> {
  const dir = await seedProject(win)
  populateSkills(dir)
  await activateProject(win, dir)
  await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
  return dir
}

test.afterAll(() => cleanupSeeds())

test('/-skill: picking a command (mouse) inserts exactly `/<name> ` with no stray char (#391)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  // Cold command cache: this thread's first `/` use → #listCommands does a real
  // IPC round-trip, the exact condition that raced in #391.
  await textarea.type('/br')

  const popup = window.locator(COMMAND_POPUP)
  await expect(popup).toBeVisible()
  const brainstorm = popup.locator('.fl-composer-command-row', { hasText: '/brainstorm' })
  await expect(brainstorm).toBeVisible()
  await brainstorm.click()

  // Exactly `/brainstorm ` — command + trailing space, NO stranded `r`.
  await expect(textarea).toHaveValue('/brainstorm ')
  await expect(popup).toBeHidden()

  // The inserted command is sendable content → Send re-enables (#433 syncEnabled).
  const send = window.locator(`${sel.composer} fl-button[variant="primary"]`)
  await expect(send).toContainText('Send')
  await expect(send).toBeEnabled()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('/-skill: keyboard Enter accepts the highlighted command instead of sending', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openComposer(window)
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.type('/disc')

  const popup = window.locator(COMMAND_POPUP)
  await expect(popup).toBeVisible()
  await expect(popup.locator('.fl-composer-command-row', { hasText: '/discovery-plan' })).toBeVisible()

  // Enter while the command popup is open ACCEPTS the highlighted item — it must
  // NOT send (the message would be lost as a half-typed `/disc`).
  await textarea.press('Enter')

  await expect(textarea).toHaveValue('/discovery-plan ')
  await expect(popup).toBeHidden()

  expect(errors, errors.join(', ')).toHaveLength(0)
})
