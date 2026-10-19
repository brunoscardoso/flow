/**
 * UX sweep — flow 5 (Review), round 19: the commit-message draft's lifecycle on
 * the NON-commit exits, and the keyboard/affordance parity between the review
 * panel's two commit surfaces.
 *
 * `ReviewPanel` keeps per-group message drafts keyed by GROUP LABEL ("Other
 * changes", "Phase N") in `#drafts` (review-panel.ts:55). Labels are recycled by
 * every later changeset, so a draft that outlives its changeset silently
 * describes somebody else's files. That is exactly #342, whose fix
 * (`dropCommittedDraft`, phase-drafts.ts) is wired into ONE exit —
 * `commitGroup`'s success path (review/index.ts:162). "Discard all" reverts the
 * whole group and never calls `clearDraft`, so the message written for the
 * discarded work is re-offered — and committable — on the next changeset.
 *
 * The second pair drives the two commit boxes that live behind the same
 * segmented control: Source Control → "Changes" (git panel, `.gp-commit-msg`,
 * ⌘/Ctrl+Enter + the ✨ wand) vs → "Phases" (review panel, `.fl-review-message`,
 * neither).
 *
 * Guards here are LIVE controls (they must keep passing); the two `test.fixme`
 * blocks are fix-agnostic tripwires that describe the correct UX and fail today
 * — #1140 (the discard exit leaks its draft) and #1141 (no keyboard commit in
 * Phases). Un-`fixme` them when the fix lands.
 */
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, gitRetry } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

const SHOTS = join(__dirname, '__screens')
/** The no-plan group label — also the message input's data-msg-key. */
const OTHER = 'Other changes'
/** Panel-only crop, so the evidence screenshot is legible in an issue. */
const PANEL_CLIP = { x: 30, y: 20, width: 430, height: 150 }

/** A repo with one commit and one working-tree change, opened as the project. */
async function seedReviewRepo(win: Page, prefix: string): Promise<string> {
  const dir = await seedProject(win, prefix, (d) => {
    execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: d })
    execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: d })
    writeFileSync(join(d, 'app.ts'), 'export const version = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: d })
    execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: d })
    writeFileSync(join(d, 'app.ts'), 'export const version = 2\n')
  })
  await activateProject(win, dir)
  return dir
}

async function openPhases(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

const messageInput = (win: Page) => win.locator(`.fl-review-message[data-msg-key="${OTHER}"]`)
/** The group's phase button ("Approve all (n/m)" → "Commit phase"). */
const phaseBtn = (win: Page) => win.locator('.fl-review-commit-btn').last()

/** Approve every file in the group, then commit it with whatever message is in
 *  the box (what a user does when the field already looks filled in for them). */
async function approveAndCommit(win: Page): Promise<void> {
  await phaseBtn(win).click()
  await expect(phaseBtn(win)).toHaveText('Commit phase', { timeout: 8000 })
  await phaseBtn(win).click()
  await expect(win.locator('.fl-review-empty')).toBeVisible({ timeout: 10_000 })
}

test.afterAll(() => cleanupSeeds())

test('CONTROL: a committed draft is consumed — the next changeset gets a fresh suggested message (#342)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedReviewRepo(window, 'flow-ux-revdraft-commit-')
  await openPhases(window)

  const input = messageInput(window)
  await expect(input).toBeVisible()
  const suggested = await input.inputValue()
  expect(suggested.length, 'the group arrives with a suggested message').toBeGreaterThan(0)

  const draft = 'fix: my hand-typed message for app.ts'
  await input.fill(draft)
  await approveAndCommit(window)
  expect(gitRetry(dir, 'log', '-1', '--format=%s').trim()).toBe(draft)

  // A later, unrelated changeset reuses the group label.
  writeFileSync(join(dir, 'unrelated.ts'), 'export const unrelated = true\n')
  await expect(window.locator('.fl-review-file')).toHaveCount(1, { timeout: 10_000 })

  // The draft died with the commit that consumed it — the box is back to the
  // freshly suggested message, so nothing describes the previous changeset.
  await expect(messageInput(window)).not.toHaveValue(draft)
  await expect(messageInput(window)).toHaveValue(suggested)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('CONTROL: the sibling "Changes" commit box commits on ⌘/Ctrl+Enter and offers the ✨ wand', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedReviewRepo(window, 'flow-ux-revkeys-changes-')
  await window.locator('[data-rail-item="source-control"]').click()
  await window.locator(sel.scViewBtn).filter({ hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()

  const row = window
    .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'app.ts' }) })
    .first()
  await row.locator('.gp-action-btn[title="Stage"]').click()
  await expect(async () => {
    expect(await window.locator('.gp-root').innerText()).toContain('STAGED CHANGES (1)')
  }).toPass({ timeout: 8000 })

  // The affordance is even advertised in the placeholder, and the ✨ wand is
  // enabled once something is staged.
  const box = window.locator('.gp-commit-msg')
  expect(await box.getAttribute('placeholder')).toContain('Enter to commit')
  await expect(window.locator('.gp-commit-generate')).toBeEnabled()

  await box.fill('chore: committed with the keyboard')
  await box.press('ControlOrMeta+Enter')
  await expect(async () => {
    expect(gitRetry(dir, 'log', '-1', '--format=%s').trim()).toBe(
      'chore: committed with the keyboard',
    )
  }).toPass({ timeout: 10_000 })

  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * GUARD (#1140, fixed) — the discard exit consumes the draft.
 *
 * Type a message for a changeset, throw that changeset away with "Discard all",
 * then let an unrelated file appear. The recycled "Other changes" group offers
 * its OWN suggested message: a draft's lifetime is now its group's PRESENCE in
 * the listing, so every exit that destroys a changeset takes its message with
 * it — not just the commit path #342 fixed.
 */
test(
  'the "Discard all" exit must consume the draft too — a discarded changeset\'s message never re-offers itself',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedReviewRepo(window, 'flow-ux-revdraft-discard-')
    await openPhases(window)

    const input = messageInput(window)
    await expect(input).toBeVisible()
    const suggested = await input.inputValue()

    const draft = 'fix: bump app.ts' // short enough to stay legible in the evidence shot
    await input.fill(draft)

    // Throw the changeset away instead of committing it.
    await window.locator('.fl-review-discard-btn').first().click()
    await expect(window.locator('.fl-review-discard-confirm')).toBeVisible()
    await window.locator('.fl-review-discard-btn.confirm').click()
    await expect(window.locator('.fl-review-empty')).toBeVisible({ timeout: 8000 })
    expect(gitRetry(dir, 'status', '--porcelain'), 'the discard really reverted').toBe('')

    // A later, unrelated changeset reuses the label.
    writeFileSync(join(dir, 'unrelated.ts'), 'export const unrelated = true\n')
    await expect(window.locator('.fl-review-file')).toHaveCount(1, { timeout: 10_000 })
    await window.screenshot({
      path: join(SHOTS, 'review-draft-discard-leak.png'),
      clip: PANEL_CLIP,
    })

    // Same contract as the committed exit above.
    await expect(
      messageInput(window),
      'the discarded changeset\'s message is re-offered for unrelated.ts',
    ).not.toHaveValue(draft)
    await expect(messageInput(window)).toHaveValue(suggested)

    // …and it is not merely cosmetic: committing as-offered writes it to history.
    await approveAndCommit(window)
    expect(gitRetry(dir, 'log', '-1', '--format=%s').trim()).not.toBe(draft)

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)

/**
 * GUARD (#1141, fixed) — the Phases commit row has parity with its sibling.
 *
 * The "Changes" box (control above) commits on ⌘/Ctrl+Enter, says so in its
 * placeholder, and offers the ✨ wand. "Phases" is one segmented-control click
 * away and had none of the three: both keys inert, no hint, no wand.
 *
 * Ordering matters here: the affordances are asserted while the group is still
 * listed, because a successful keyboard commit empties the panel — the two
 * cannot be checked in the same breath.
 */
test('the "Phases" commit row offers the same keyboard commit (and ✨) as the "Changes" box', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedReviewRepo(window, 'flow-ux-revkeys-phases-')
  await openPhases(window)

  const input = messageInput(window)
  await expect(input).toBeVisible()

  // ── The affordances, while the changeset is still on screen ──────────────
  await expect(input, 'the field advertises the shortcut like its sibling does').toHaveAttribute(
    'placeholder',
    /Enter to commit/,
  )
  expect(
    await window.locator('.fl-review .fl-review-generate, .fl-review .gp-commit-generate').count(),
    'a ✨ generate affordance exists on this commit row too',
  ).toBeGreaterThan(0)

  // Contrast shot: the same panel's other view, one segmented-control click away.
  await window.locator(sel.scViewBtn).filter({ hasText: 'Changes' }).click()
  await expect(window.locator('.gp-commit-msg')).toBeVisible()
  await window.screenshot({
    path: join(SHOTS, 'review-changes-commit-box-contrast.png'),
    clip: { ...PANEL_CLIP, height: 240 }, // taller: the ✨ wand sits under the box
  })
  await window.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(messageInput(window)).toBeVisible()

  // ── The keyboard must not ARM: Enter on an unapproved group commits nothing
  const premature = 'chore: this must never reach history'
  await messageInput(window).fill(premature)
  await messageInput(window).press('ControlOrMeta+Enter')
  await window.waitForTimeout(500)
  expect(gitRetry(dir, 'log', '-1', '--format=%s').trim()).toBe('baseline')
  await expect(phaseBtn(window)).not.toHaveText('Commit phase')

  // ── Armed, the same keystroke commits ────────────────────────────────────
  await phaseBtn(window).click()
  await expect(phaseBtn(window)).toHaveText('Commit phase', { timeout: 8000 })

  const msg = 'feat: committed from the keyboard in Phases'
  await messageInput(window).fill(msg)
  await messageInput(window).press('ControlOrMeta+Enter')
  await expect(window.locator('.fl-review-empty')).toBeVisible({ timeout: 10_000 })
  await window.screenshot({
    path: join(SHOTS, 'review-phases-keyboard-commit.png'),
    clip: PANEL_CLIP,
  })
  expect(gitRetry(dir, 'log', '-1', '--format=%s').trim()).toBe(msg)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
