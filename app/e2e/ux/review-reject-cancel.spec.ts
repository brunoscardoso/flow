import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5 (Review): the Reject (✕) inline prompt's back-out affordance.
 *
 * Clicking ✕ on a review file swaps its row for an inline prompt (a feedback
 * text field + a "Redo" button). "Redo" is DESTRUCTIVE: it reverts the file to
 * HEAD and asks the active thread's agent to redo it (renderer/review/index.ts
 * `rejectFile`). The prompt is opened by `ReviewPanel.#openRejectPrompt`.
 *
 * The prompt offers NO Cancel button — only "Redo". The only non-destructive way
 * out is Escape, and that handler is bound to the text INPUT's keydown, so it
 * works ONLY while the input keeps focus. The moment the user clicks anywhere
 * else in the panel (the natural instinct to dismiss a popover), the prompt
 * becomes un-dismissable: outside-click doesn't close it, Escape is now dead
 * (focus left the input), and even the ⟳ refresh button can't tear it down (the
 * #182 refresh gate defers re-renders while the prompt is open). The user's only
 * remaining button is "Redo" — which reverts their uncommitted work.
 *
 * The SIBLING destructive inline prompt — "Discard all" — correctly offers an
 * explicit Cancel button (`ReviewPanel.#confirmDiscardGroup`). This spec pins the
 * shipped behaviors that work, contrasts the Discard Cancel, and carries a
 * `test.fixme` tripwire (issue below) that flips green once the Reject prompt
 * gains a non-destructive back-out.
 *
 * Distinct from #188 (overlapping reject/discard prompts), #397 (reject with no
 * thread), #659 (stale diff overlay).
 */

const SCREENS = 'e2e/ux/__screens'

/** Seed a committed baseline + one modified tracked file (the review target). */
async function seedReviewRepo(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-rejcancel-')
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 2\n')
  await activateProject(win, dir)
  return dir
}

/** Reach review the way a real user now does (post #663/#664): the activity-bar
 *  rail's `source-control` item, then the `Phases` view-mode button. */
async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator('.fl-sc-viewbtn').filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

test.afterAll(() => cleanupSeeds())

test('reject prompt: Escape cancels it WHILE the input is focused (shipped)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedReviewRepo(window)
  await openReview(window)
  await expect(window.locator('.fl-review-file')).toHaveCount(1)

  await window.locator('.fl-review-file').first().locator('.fl-review-reject').click()
  const prompt = window.locator('.fl-review-reject-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt.locator('input')).toBeFocused()

  // Escape from the still-focused input cancels — the file row comes back.
  await window.keyboard.press('Escape')
  await expect(prompt).toBeHidden()
  await expect(window.locator('.fl-review-file')).toHaveCount(1)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('discard confirm CONTRAST: the sibling destructive prompt offers a Cancel', async ({
  window,
}) => {
  await seedReviewRepo(window)
  await openReview(window)
  await expect(window.locator('.fl-review-file')).toHaveCount(1)

  await window.locator('.fl-review-discard-btn').first().click()
  const confirm = window.locator('.fl-review-discard-confirm')
  await expect(confirm).toBeVisible()
  // Cancel + Discard — a non-destructive back-out is present.
  await expect(confirm.locator('button', { hasText: 'Cancel' })).toBeVisible()
  await expect(confirm.locator('button', { hasText: /^Discard/ })).toBeVisible()
})

/**
 * Regression for #697: once the user clicks away from the reject input, the
 * prompt must still be dismissable without the destructive "Redo". The fix adds
 * a Cancel button to `#openRejectPrompt` (mirroring `#confirmDiscardGroup`) that
 * dismisses regardless of focus — so a mis-click on ✕ followed by a click-away
 * is no longer a destructive-only trap.
 */
test('reject prompt: a Cancel button dismisses it after focus leaves the input (#697)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedReviewRepo(window)
  await openReview(window)
  await expect(window.locator('.fl-review-file')).toHaveCount(1)

  await window.locator('.fl-review-file').first().locator('.fl-review-reject').click()
  const prompt = window.locator('.fl-review-reject-prompt')
  await expect(prompt).toBeVisible()

  // The user clicks the panel title (natural "dismiss this popover" instinct) —
  // focus leaves the input, killing the input-bound Escape handler.
  await window.locator('.fl-review-title').click()

  // The prompt still offers a non-destructive back-out: a visible Cancel button.
  const cancel = prompt.locator('button', { hasText: /^cancel$/i })
  await expect(cancel).toBeVisible()
  await window.screenshot({ path: `${SCREENS}/review-reject-dismissable.png` })

  // Clicking Cancel dismisses the prompt and restores the file row — the file is
  // NOT reverted (no destructive Redo fired).
  await cancel.click()
  await expect(prompt).toBeHidden()
  await expect(window.locator('.fl-review-file')).toHaveCount(1)
  // The working-tree change survives — Cancel never touched the file.
  expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toContain('version = 2')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
