import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer), round 24: the OTHER producer that writes over
 * your draft — `flow:prefill-composer`.
 *
 * #980 filed and fixed exactly one draft-clobber in this composer: the "Next
 * step" suggestion button used to write `/${command.name}` over the textarea and
 * send it, destroying whatever the user was typing. Its fix dispatches directly
 * without touching the input (`#acceptNextStep`, composer.ts:1632 — "so an unsent
 * draft (text, chips, attachments) survives the click untouched (#980)").
 *
 * The composer has a SECOND way to be handed a prompt, and the fix never reached
 * it: the `flow:prefill-composer` listener (composer.ts:282) does
 *
 *     this.#textarea.value = detail.text        // ← raw, full-buffer replace
 *
 * and three real user surfaces fire it:
 *   - ⌘⇧P palette → any `/skill` row (palette-commands.ts `foldSlashCommands`
 *     → flow:compose-prompt → threads/index.ts:329 → prefill),
 *   - the chat thread's artifact card → "Ask agent" (conversation-pane.ts:1869),
 *   - the Blueprint peek drawer → "Ask agent" (peek-viewer.ts:504).
 *
 * A raw `textarea.value = …` is also the write #1214/#1273/#1369 spent three
 * issues converting to the undoable `#replaceRange` path, because it FLUSHES
 * Chromium's native undo stack — so ⌘Z cannot take the draft back either. And an
 * unsent draft is not in the ⬆ history (that records SENT messages only, #776).
 *
 * Test 1 (live control) — the palette's `/skill` row really does reach the
 * composer: it prefills the command text and never auto-sends.
 * Test 2 (test.fixme tripwire, confirmed RED against main) — running that same
 * row while a draft is in the input must not leave the draft unreachable.
 * Fix-agnostic: it passes if the draft survives in the input, OR comes back with
 * ⌘Z, OR is recallable with ⬆.
 *
 * Credential-free: nothing is sent to an agent — the palette row only writes the
 * composer.
 */

const PALETTE = '.fl-palette-panel'
const PALETTE_INPUT = '.fl-palette-input'
const PALETTE_ROW = '.fl-palette-row'
const SCREENS = 'e2e/ux/__screens'
const DRAFT =
  'before anything else: the token refresh in src/auth/session.ts drops the retry on a 401'

/** Real plan-flow skills so the palette has `/skill` rows to fold in. */
function populateSkills(dir: string): void {
  const commandsDir = join(dir, '.claude', 'commands')
  mkdirSync(commandsDir, { recursive: true })
  for (const [name, description] of [
    ['brainstorm', 'Explore an idea'],
    ['discovery-plan', 'Gather requirements'],
  ]) {
    writeFileSync(join(commandsDir, `${name}.md`), `---\ndescription: ${description}\n---\nBody\n`)
  }
}

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

/** Seed a project with skills, open a thread, and return the composer textarea. */
async function openThread(win: Page, title: string): Promise<void> {
  const dir = await seedProject(win, 'flow-ux-prefill-', populateSkills)
  await activateProject(win, dir)
  await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
}

/** Open ⌘⇧P command mode and run the `/brainstorm` row. */
async function runSlashCommandFromPalette(win: Page): Promise<void> {
  const panel = win.locator(PALETTE)
  await win.keyboard.press('ControlOrMeta+Shift+p')
  await expect(panel).toBeVisible()
  await panel.locator(PALETTE_INPUT).fill('>brainstorm')
  const row = win.locator(PALETTE_ROW, { hasText: '/brainstorm' })
  await expect(row.first()).toBeVisible({ timeout: 10_000 })
  await win.keyboard.press('Enter')
  await expect(panel).toBeHidden()
}

test.afterAll(() => cleanupSeeds())

test('the palette runs a /skill by prefilling the composer (never auto-sending)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  await openThread(window, 'Palette skill control')
  const textarea = window.locator(`${sel.composer} textarea`)

  await runSlashCommandFromPalette(window)

  // The command lands in the composer for review — the composer's own contract
  // for a prefill ("Sets the draft and focuses — NEVER sends", composer.ts:279).
  await expect(textarea).toHaveValue(/^\/brainstorm\s?$/, { timeout: 10_000 })
  // Nothing was sent: no user bubble in the transcript.
  await expect(window.locator('.fl-msg-user, .fl-message.user')).toHaveCount(0)

  expect(errors, errors.join(', ')).toEqual([])
})

test.fixme('running a palette /skill must not destroy the unsent draft', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  await openThread(window, 'Palette skill vs draft')
  const textarea = window.locator(`${sel.composer} textarea`)

  // The user is mid-thought, then reaches for the palette to run a skill.
  await textarea.click()
  await textarea.fill(DRAFT)
  await expect(textarea).toHaveValue(DRAFT)

  await runSlashCommandFromPalette(window)
  await expect(textarea).toHaveValue(/brainstorm/, { timeout: 10_000 })
  await window.waitForTimeout(300)

  const afterPrefill = await textarea.inputValue()
  // The moment itself: the sentence the user was writing is gone, replaced by
  // the command, with nothing said and nothing to click.
  await window.screenshot({ path: `${SCREENS}/composer-palette-prefill-clobber.png` })
  const survivedInInput = afterPrefill.includes(DRAFT)

  // ⌘Z — the recovery every other completion in this composer offers (#1214).
  let survivedInUndo = false
  if (!survivedInInput) {
    await textarea.click()
    for (let i = 0; i < 3 && !survivedInUndo; i += 1) {
      await window.keyboard.press('ControlOrMeta+z')
      await window.waitForTimeout(200)
      survivedInUndo = (await textarea.inputValue()).includes(DRAFT)
    }
  }

  // ⬆ recall — the composer's per-thread message history (#776).
  let survivedInHistory = false
  if (!survivedInInput && !survivedInUndo) {
    await textarea.click()
    await textarea.fill('')
    for (let i = 0; i < 6 && !survivedInHistory; i += 1) {
      await window.keyboard.press('ArrowUp')
      await window.waitForTimeout(120)
      survivedInHistory = (await textarea.inputValue()).includes(DRAFT)
    }
  }

  if (!survivedInInput && !survivedInUndo && !survivedInHistory) {
    await window.screenshot({ path: `${SCREENS}/composer-palette-prefill-draft-lost.png` })
  }

  expect(
    survivedInInput || survivedInUndo || survivedInHistory,
    `the palette /skill overwrote the draft and left it unreachable (input="${afterPrefill}")`,
  ).toBe(true)

  expect(errors, errors.join(', ')).toEqual([])
})
