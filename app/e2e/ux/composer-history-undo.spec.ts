import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer), round 23: the ONE composer write #1214 never
 * reached, and the only one that overwrites the WHOLE draft.
 *
 * #1214 ("⌘Z is dead after any @-mention or /-skill completion") enumerated four
 * places the composer writes the textarea for the user with a raw
 * `this.#textarea.value = …` — which flushes Chromium's native undo stack:
 *
 *   #acceptMention · #acceptCommand · #insertNewline · ArrowUp history recall
 *
 * The fix routed the first three through `#replaceRange` (execCommand insertText,
 * undoable). The fourth — `#onKeydown`'s history recall, composer.ts:1400 — is
 * still a raw assignment:
 *
 *     this.#textarea.value = step.text
 *
 * It is also the worst of the four, because the other three INSERT into the
 * draft while this one REPLACES it entirely. The damage compounds with #776's
 * (correct, shell-style) history semantics: `resetNavigation` drops the stashed
 * draft the moment the user edits mid-walk, so once you touch the recalled text,
 * ⬇ can no longer bring the draft back — and ⌘Z, the universal fallback, is dead.
 *
 * Structure:
 *  - LIVE guards document the healthy half: ⬇ restores an UNTOUCHED walk, and an
 *    @-mention completion (the sibling path #1214 DID fix) is fully undoable.
 *    That mention leg is the causation control — same field, same undo channel,
 *    same composer instance: only the recall path flushes the stack.
 *  - The `test.fixme` tripwires state the target behaviour and are red on
 *    current main — filed as #1369. Flip them live with the fix.
 *
 * Credential-free: history is seeded from PERSISTED messages via
 * `messages.append` (what a previous session's sends look like, #776), so no
 * agent turn is needed. Undo is driven through the renderer's own
 * `execCommand('undo')` — the same UndoStack the Edit ▸ Undo menu role drives.
 */

const MENTION_POPUP = '.fl-composer-mentions:not(.fl-composer-commands)'
const SCREENS = 'e2e/ux/__screens'
/** Far more undos than the keystrokes each leg types — a stalled value means the
 *  stack was FLUSHED, not that the loop ran out of patience. */
const UNDO_PRESSES = 40

const DRAFT = 'half-typed thought I still need'

function box(win: Page) {
  return win.locator(`${sel.composer} textarea`)
}

/** Seed a project + a thread carrying two persisted user messages, and open it.
 *  Returns the seeded root (which also holds a mentionable README.md). */
async function openThreadWithHistory(win: Page, title: string): Promise<string> {
  const root = await seedProject(win)
  writeFileSync(join(root, 'README.md'), '# root\n')
  await activateProject(win, root)
  await win.evaluate(
    async ({ root, title }) => {
      const flow = (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
        }
      ).flow
      const thread = await flow.threads.create({ projectRoot: root, title })
      await flow.messages.append({ threadId: thread.id, role: 'user', content: 'older question' })
      // Messages are listed `ORDER BY created_at ASC, id ASC` and ids are random
      // uuids — two appends inside the same millisecond tie and come back in
      // arbitrary order, which would flake the "newest first" recall. Separate
      // them in time so the seeded history is deterministic.
      await new Promise((resolve) => setTimeout(resolve, 20))
      await flow.messages.append({ threadId: thread.id, role: 'user', content: 'newest question' })
    },
    { root, title },
  )
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.composer)).toBeVisible()
  return root
}

/** Undo, many times, on the focused composer field. */
async function undoRepeatedly(win: Page): Promise<void> {
  await box(win).click()
  for (let i = 0; i < UNDO_PRESSES; i++) {
    await win.evaluate(() => document.execCommand('undo'))
  }
}

test.afterAll(() => cleanupSeeds())

// ── live guards (the healthy half) ───────────────────────────────────────────

test('LIVE: an UNTOUCHED history walk gives the draft back on ⬇ (the designed escape hatch)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  await openThreadWithHistory(window, 'recall-untouched')
  const field = box(window)
  await field.click()
  await field.type(DRAFT)

  await field.press('ArrowUp')
  await expect(field).toHaveValue('newest question')
  await field.press('ArrowUp')
  await expect(field).toHaveValue('older question')
  // Forward past the newest entry restores the stashed draft — as long as the
  // walk was never edited. This is the ONLY recovery the composer offers today.
  await field.press('ArrowDown')
  await expect(field).toHaveValue('newest question')
  await field.press('ArrowDown')
  await expect(field).toHaveValue(DRAFT)

  expect(errors, `pageerrors: ${errors.join('\n')}`).toEqual([])
})

test('LIVE: the sibling write #1214 fixed — an @-mention completion stays undoable', async ({
  window,
}) => {
  // Causation control for the tripwires: identical field, identical undo
  // channel, a programmatic whole-token write — and ⌘Z walks the draft all the
  // way back, because #acceptMention goes through #replaceRange.
  await openThreadWithHistory(window, 'mention-undoable')
  const field = box(window)
  const popup = window.locator(MENTION_POPUP)

  await field.click()
  await field.type('please read @READ')
  await expect(popup).toBeVisible()
  await popup.locator('.fl-composer-mention-row', { hasText: /^README\.md$/ }).click()
  await expect(field).toHaveValue('please read @README.md ')

  await undoRepeatedly(window)
  expect(
    await field.inputValue(),
    'the @-mention path is undoable back to empty (#1214 fix works here)',
  ).toBe('')
})

// ── tripwires (target behaviour; red on current main — #1369) ────────────────

test.fixme(
  '⌘Z must take back an ArrowUp recall — the draft it overwrote has to be reachable',
  async ({ window }) => {
    await openThreadWithHistory(window, 'recall-undo')
    const field = box(window)
    await field.click()
    await field.type(DRAFT)
    await expect(field).toHaveValue(DRAFT)

    // One ArrowUp — the same keystroke a user presses to move the caret up in
    // what they think is a multi-line box — replaces the entire draft.
    await field.press('ArrowUp')
    await expect(field).toHaveValue('newest question')

    await undoRepeatedly(window)
    // Today: stalls at 'newest question'. The raw `.value =` flushed the stack, so
    // there is nothing to undo — the draft is not on it any more.
    expect(
      await field.inputValue(),
      'undo must walk back past the recalled message to the typed draft',
    ).not.toBe('newest question')
  },
)

test.fixme(
  'a draft must not become unrecoverable: recall, then edit, then nothing brings it back',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openThreadWithHistory(window, 'recall-lost-draft')
    const field = box(window)
    await field.click()
    await field.type(DRAFT)

    // ⬆ recalls; the user then edits the recalled text (a perfectly ordinary
    // "actually, let me tweak the last question" move). #776's resetNavigation
    // correctly ends the walk — and with it, the stashed draft.
    await field.press('ArrowUp')
    await expect(field).toHaveValue('newest question')
    await field.type(' again')
    await expect(field).toHaveValue('newest question again')

    // ⬇ no longer restores the draft (the walk is over) …
    await field.press('ArrowDown')
    await expect(field).toHaveValue('newest question again')

    // … so ⌘Z is the last resort. It is dead.
    await undoRepeatedly(window)
    const recovered = await field.inputValue()
    await window.screenshot({ path: `${SCREENS}/composer-recall-draft-lost.png` })

    expect(errors, `pageerrors: ${errors.join('\n')}`).toEqual([])
    expect(
      recovered,
      'after ⬆ + an edit, SOMETHING must still get the typed draft back (⬇ or ⌘Z)',
    ).toContain('half-typed')
  },
)
