import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, gitRetry, waitForStableNode } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5 (Review): dismissing/completing ONE inline prompt while a
 * SIBLING inline prompt is open.
 *
 * The Review panel has two transient inline UIs — the Reject (✕) feedback prompt
 * (`ReviewPanel.#openRejectPrompt`) and the "Discard all" two-step confirm
 * (`#confirmDiscardGroup`). Both replace their host row's content in place, and
 * both raise the #182 refresh gate (`ReviewRefreshGate.open()`). Neither restores
 * its host row itself: every exit path (Cancel, Escape, Redo, Discard N) calls
 * `#closeInteraction()` and then relies on a RE-RENDER to rebuild the panel DOM.
 *
 * The gate is ref-counted (#188) so an overlapping prompt cannot unprotect its
 * sibling's typed feedback — correct, and guarded live below. The residual is
 * that `close()` returns null while the sibling is still open AND the follow-up
 * `onRefresh()` is deferred too, so the exiting prompt's own repaint never
 * happens: Cancel reads as a dead click, and a COMPLETED "Discard all" leaves the
 * panel listing changes that no longer exist with its destructive confirm still
 * armed (⟳ can't clear it — the gate defers that too).
 *
 * Filed as #1018.
 *
 * Distinct from #188 (typed feedback lost), #697 (no Cancel at all), #182
 * (background refresh tearing a prompt down), #951 (project switch with the
 * confirm armed), #659 (stale diff overlay).
 */

const SCREENS = 'e2e/ux/__screens'

/** Seed a committed baseline + TWO modified tracked files (one review group). */
async function seedReviewRepo(win: Page, prefix: string): Promise<string> {
  const dir = await seedProject(win, prefix)
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'alpha.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'beta.ts'), 'export const b = 1\n')
  // gitRetry: the app's own status refresh / auto-provisioner briefly take
  // .git/index.lock in a just-added root — a raw commit races it and flakes.
  gitRetry(dir, 'add', '-A')
  gitRetry(dir, 'commit', '-q', '-m', 'baseline')
  writeFileSync(join(dir, 'alpha.ts'), 'export const a = 2\n')
  writeFileSync(join(dir, 'beta.ts'), 'export const b = 2\n')
  await activateProject(win, dir)
  return dir
}

/** Reach review the way a real user does (post #663/#664): the activity-bar
 *  rail's `source-control` item, then the `Phases` view-mode button. */
async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator('.fl-sc-viewbtn').filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
  // The list rebuilds a couple of times as a fresh project settles; a click
  // landing on a replaced node is lost (#1093/#1094).
  await waitForStableNode(win, '.fl-review-file')
}

/** An open prompt reuses its file row (`row.textContent = ''`), so a row that is
 *  already a prompt no longer offers ✕ — always click the next intact row. */
function intactRows(win: Page) {
  return win.locator('.fl-review-file:not(.fl-review-reject-prompt)')
}

/**
 * The working tree's status, read WITHOUT git's optional index lock. A plain
 * `git status` from the test writes `.git/index.lock` while it refreshes stat
 * info, and polling it while the app reverts file after file made the app's own
 * `git checkout` fail on that lock — the test manufacturing the very leftover
 * it then reported.
 */
function workingTree(dir: string): string {
  return execFileSync('git', ['status', '--porcelain'], {
    cwd: dir,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).toString()
}

test.afterAll(() => cleanupSeeds())

test('CONTROL: "Discard all" with no other prompt open reverts and empties the panel', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedReviewRepo(window, 'flow-ux-revoverlap-ctl-')
  await openReview(window)
  await expect(window.locator('.fl-review-file')).toHaveCount(2)

  await window.locator('.fl-review-discard-btn').first().click()
  await window
    .locator('.fl-review-discard-confirm')
    .locator('button', { hasText: /^Discard \d/ })
    .click()

  // Working tree is back at HEAD…
  await expect
    .poll(() => workingTree(dir), {
      timeout: 8000,
    })
    .toBe('')
  // …and the panel agrees: no rows, the empty state, and the used confirm is gone.
  await expect(window.locator('.fl-review-file')).toHaveCount(0)
  await expect(window.locator('.fl-review-empty')).toBeVisible()
  await expect(window.locator('.fl-review-discard-confirm')).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('#188 guard: a second reject prompt does not wipe the first one’s typed feedback', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedReviewRepo(window, 'flow-ux-revoverlap-gate-')
  await openReview(window)
  await expect(window.locator('.fl-review-file')).toHaveCount(2)

  await intactRows(window).first().locator('.fl-review-reject').click()
  await expect(window.locator('.fl-review-reject-prompt')).toHaveCount(1)
  await window.locator('.fl-review-reject-prompt input').fill('wrong approach')

  // Opening a prompt on the sibling file leaves the first prompt — and its text —
  // untouched (the ref-counted gate keeps deferring background re-renders).
  await intactRows(window).first().locator('.fl-review-reject').click()
  await expect(window.locator('.fl-review-reject-prompt')).toHaveCount(2)
  await window.locator('.fl-review-reject-prompt').nth(1).locator('input').fill('also wrong')
  await expect(window.locator('.fl-review-reject-prompt').first().locator('input')).toHaveValue(
    'wrong approach',
  )
  await window.screenshot({ path: `${SCREENS}/review-overlap-two-prompts.png` })

  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * Tripwire for #1018 (residual of #188's ref-counted gate): Cancel on one
 * reject prompt is swallowed while a sibling prompt is open — `#closeInteraction`
 * decrements the gate to a still-open depth, so neither the flush nor the
 * follow-up `onRefresh()` repaints the row the user just backed out of. Flips
 * green once a dismissal repaints its own row regardless of sibling prompts.
 */
test(
  'Cancel on one reject prompt dismisses THAT prompt while the sibling stays open',
  async ({ window }) => {
    const dir = await seedReviewRepo(window, 'flow-ux-revoverlap-cancel-')
    await openReview(window)
    await expect(window.locator('.fl-review-file')).toHaveCount(2)

    await intactRows(window).first().locator('.fl-review-reject').click()
    await window.locator('.fl-review-reject-prompt input').fill('wrong approach')
    await intactRows(window).first().locator('.fl-review-reject').click()
    await expect(window.locator('.fl-review-reject-prompt')).toHaveCount(2)
    await window.locator('.fl-review-reject-prompt').nth(1).locator('input').fill('also wrong')

    await window
      .locator('.fl-review-reject-prompt')
      .first()
      .locator('button', { hasText: /^cancel$/i })
      .click()

    // Exactly the prompt that was cancelled goes away…
    await expect(window.locator('.fl-review-reject-prompt')).toHaveCount(1)
    // …the surviving one keeps its feedback, and nothing was reverted.
    await expect(window.locator('.fl-review-reject-prompt input')).toHaveValue('also wrong')
    expect(readFileSync(join(dir, 'alpha.ts'), 'utf8')).toContain('a = 2')
    expect(readFileSync(join(dir, 'beta.ts'), 'utf8')).toContain('b = 2')
  },
)

/**
 * Tripwire for #1018: a COMPLETED "Discard all" performed while a reject
 * prompt is open reverts the files but leaves the panel showing them, with the
 * destructive confirm still armed and ⟳ inert. Flips green once a completed
 * destructive action repaints the panel from the real working tree.
 */
test(
  'a completed "Discard all" leaves the panel matching the real working tree even with a reject prompt open',
  async ({ window }) => {
    const dir = await seedReviewRepo(window, 'flow-ux-revoverlap-discard-')
    await openReview(window)
    await expect(window.locator('.fl-review-file')).toHaveCount(2)

    // A reject prompt is open on one file (the user is mid-thought)…
    await intactRows(window).first().locator('.fl-review-reject').click()
    await expect(window.locator('.fl-review-reject-prompt')).toHaveCount(1)

    // …and the user decides to throw the whole group away instead.
    await window.locator('.fl-review-discard-btn').first().click()
    await window
      .locator('.fl-review-discard-confirm')
      .locator('button', { hasText: /^Discard \d/ })
      .click()

    // The revert really happened on disk…
    await expect
      .poll(() => workingTree(dir), {
        timeout: 8000,
      })
      .toBe('')
    await window.screenshot({ path: `${SCREENS}/review-overlap-discard-stale.png` })

    // …so the panel must not keep listing changes that no longer exist, and the
    // confirm the user already used must not stay armed.
    await expect(window.locator('.fl-review-file')).toHaveCount(0)
    await expect(window.locator('.fl-review-empty')).toBeVisible()
    await expect(window.locator('.fl-review-discard-confirm')).toHaveCount(0)
  },
)
