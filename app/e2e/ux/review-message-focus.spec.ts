import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5: Review, commit-message focus + draft survival across a
 * BACKGROUND refresh (#282 / #342).
 *
 * The phase-grouped Review panel rebuilds its ENTIRE DOM on every refresh
 * (`ReviewPanel.#render` does `container.textContent = ''` then re-appends every
 * group). Refreshes fire constantly in normal use: on `git:changed`, on a
 * debounced `project:fileChanged`, and on project switches. This is exactly
 * what happens while an agent is editing files — the working tree changes under
 * the user while they are typing a commit message.
 *
 * Two things must survive that background teardown:
 *  - the DRAFT the user typed (kept in `#drafts`, re-applied as `input.value`),
 *    so a refresh doesn't silently revert their message to the suggested one;
 *  - the FOCUS + CARET (the #282 capture/restore machinery), so a user typing
 *    mid-word isn't ejected from the field every time a file changes on disk.
 *
 * These probes drive that seam against a seeded repo (no Claude account needed —
 * `review:list` groups the git working tree). Guard 1 uses the manual ⟳ button
 * (deterministic: draft value survives a refresh). Guard 2 drives the authentic
 * background path — a new file appears on disk while the input is focused mid
 * caret — and asserts focus + caret + value all survive the rebuild.
 */

const SCREENS = 'e2e/ux/__screens'
const OTHER = 'Other changes' // the no-plan group label == the input's data-msg-key

async function seedReviewRepo(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-revfocus-')
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  // One working-tree change so the review list is non-empty on open.
  writeFileSync(join(dir, 'app.ts'), 'export const version = 2\n')
  await activateProject(win, dir)
  return dir
}

async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

/** selectionStart of the currently-focused element (or -1 if none/not an input). */
async function focusedCaret(win: Page): Promise<number> {
  return win.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null
    if (!el || typeof el.selectionStart !== 'number') return -1
    return el.selectionStart
  })
}

test.afterAll(() => cleanupSeeds())

test('draft: a typed commit message survives a manual ⟳ refresh (not reverted to the suggestion)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedReviewRepo(window)
  await openReview(window)

  const input = window.locator(`.fl-review-message[data-msg-key="${OTHER}"]`)
  await expect(input).toBeVisible()

  // Replace whatever suggestion is there with a distinctive user draft.
  const draft = 'fix: my hand-typed message'
  await input.fill(draft)
  await expect(input).toHaveValue(draft)

  // A background refresh rebuilds the whole panel DOM. Trigger it deterministically
  // via the ⟳ button (this blurs the input — expected, the user clicked away — so
  // we assert only the DRAFT here, not focus).
  await window.locator('.fl-review-refresh').click()

  // The rebuilt input must still carry the user's draft, NOT snap back to the
  // suggested message (#342 keeps drafts; a lost draft would silently discard the
  // message the user was composing).
  await expect(window.locator(`.fl-review-message[data-msg-key="${OTHER}"]`)).toHaveValue(draft)

  await window.screenshot({ path: `${SCREENS}/revfocus-draft-survives-refresh.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('focus + caret: typing a commit message survives a background refresh from a disk change (#282)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedReviewRepo(window)
  await openReview(window)

  // One file at open. Let ALL post-activation settle refreshes drain first
  // (debounce is 500ms) so our caret setup isn't torn down by a refresh we didn't
  // trigger — we want to measure ONLY the deliberate disk-change refresh below.
  await expect(window.locator('.fl-review-file')).toHaveCount(1)
  await window.waitForTimeout(1200)

  const input = window.locator(`.fl-review-message[data-msg-key="${OTHER}"]`)
  const draft = 'chore: wip message'
  await input.fill(draft)
  const caret = 6 // after "chore:", mid-string — a real "still typing" position
  await input.evaluate((el, pos) => {
    ;(el as HTMLInputElement).focus()
    ;(el as HTMLInputElement).setSelectionRange(pos, pos)
  }, caret)
  await expect(input).toBeFocused()

  // The caret must be STABLE at 6 with no refresh in flight — assert it holds over
  // a debounce window, so a pass below is genuinely about the deliberate refresh.
  expect(await focusedCaret(window)).toBe(caret)
  await window.waitForTimeout(700)
  expect(await focusedCaret(window)).toBe(caret)

  // Now the AUTHENTIC background scenario: a new file appears on disk (as an
  // agent would create one) while the user is mid-type. The project file watcher
  // fires project:fileChanged → debounced refresh → full DOM rebuild. We do NOT
  // touch the page, so nothing but the app itself moves focus.
  writeFileSync(join(dir, 'feature.ts'), 'export const feature = true\n')

  // The rebuild landed once the new file shows up as a second reviewable row.
  await expect(window.locator('.fl-review-file')).toHaveCount(2, { timeout: 8000 })

  // #282: the recreated input must keep the focus, the caret position, AND the
  // draft — otherwise every file an agent writes ejects the user mid-word and
  // resets their message. This is the whole point of the capture/restore machinery.
  const rebuilt = window.locator(`.fl-review-message[data-msg-key="${OTHER}"]`)
  await expect(rebuilt).toHaveValue(draft)
  await expect(rebuilt).toBeFocused()
  expect(await focusedCaret(window)).toBe(caret)

  await window.screenshot({ path: `${SCREENS}/revfocus-caret-survives-background.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
