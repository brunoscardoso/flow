/**
 * UX sweep — flow `git` (rotation index 6, round 11): the Source Control commit
 * box's KEYBOARD commit affordance (⌘/Ctrl+Enter) and its gate.
 *
 * Why this is un-probed: the commit box advertises "Message (⌘/Ctrl+Enter to
 * commit)" as its placeholder and wires a keydown handler (git-panel.ts ~563)
 * that fires the SAME `doCommit()` as the button. But EVERY prior git spec
 * (git-stage-commit / git-selective-commit / git-unstage-bulk / git-commit-
 * gate-reason / git-commit-fail-feedback …) commits by CLICKING `.gp-commit-btn`.
 * The keyboard path — a primary, advertised affordance — is never driven live.
 *
 * Two user-facing guards ride on that keydown path, both distinct from the
 * button and never exercised:
 *
 *   1. GATE. `doCommit()` re-checks `commitBoxState(stagedCount, message)` before
 *      firing, so ⌘/Ctrl+Enter must NOT commit when the gate is closed (nothing
 *      staged, or a blank/whitespace-only message). A keyboard path that skipped
 *      the gate would let a user fire an empty-message or no-op commit by reflex —
 *      a data-integrity foot-gun the button is protected from. We assert the HEAD
 *      commit count is UNCHANGED after each blocked keypress (non-vacuous: no
 *      phantom commit is created).
 *
 *   2. HAPPY PATH. With a file staged and a real message, ⌘/Ctrl+Enter commits:
 *      the file leaves the panel, the message box clears (draft consumed), and the
 *      typed subject lands in the git log — exactly the button's contract, but
 *      reached the way the placeholder tells the user to reach it.
 *
 * Account-independent: git-only, no agent. Reuses the standard seed + Source
 * Control opener (#335) and the populateRepo/alphaRow helpers from the sibling
 * git specs.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** How many commits are on HEAD right now (0 if the repo is unborn). */
function commitCount(dir: string): number {
  try {
    return Number(git(dir, 'rev-list', '--count', 'HEAD').trim())
  } catch {
    return 0
  }
}

/** Seed a repo with one commit, a modified tracked file, and an untracked file. */
function populateRepo(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  writeFileSync(join(dir, 'alpha.txt'), 'first line\nsecond line\n')
  git(dir, 'add', 'alpha.txt')
  git(dir, 'commit', '-q', '-m', 'feat: add alpha')
  writeFileSync(join(dir, 'alpha.txt'), 'first line CHANGED\nsecond line\nthird\n')
  writeFileSync(join(dir, 'beta.txt'), 'brand new untracked file\n')
}

/** Reveal Source Control → Changes and wait for the git panel to mount + load.
 *  The repo is populated inside `prepare` (pre-addRoot) so the app's own git
 *  activity can't race the seed on index.lock. */
async function openGitPanel(window: Page): Promise<string> {
  const dir = await seedProject(window, undefined, populateRepo)
  await activateProject(window, dir)
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(async () => {
    expect(await window.locator('.gp-name').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 6000 })
  return dir
}

async function panelText(window: Page): Promise<string> {
  return window.locator('.gp-root').innerText()
}

async function expectPanel(window: Page, needle: string): Promise<void> {
  await expect(async () => {
    expect(await panelText(window)).toContain(needle)
  }).toPass({ timeout: 8000 })
}

function alphaRow(window: Page) {
  return window
    .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
    .first()
}

test.afterAll(() => cleanupSeeds())

test.describe('git commit via keyboard (⌘/Ctrl+Enter)', () => {
  test('⌘/Ctrl+Enter respects the gate — no phantom commit when nothing staged or message blank', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await openGitPanel(window)
    await expectPanel(window, 'CHANGES (2)')

    const msg = window.locator('.gp-commit-msg')
    // Placeholder advertises the keyboard affordance to the user — assert it's there.
    await expect(msg).toHaveAttribute('placeholder', /Enter to commit/i)

    const before = commitCount(dir)
    expect(before).toBe(1) // the seed's single "feat: add alpha" — non-vacuous baseline

    // (a) NOTHING staged + a real message → gate closed. ⌘/Ctrl+Enter must no-op.
    await msg.fill('feat: keyboard fire with nothing staged')
    await msg.press('ControlOrMeta+Enter')
    await msg.press('Control+Enter') // cover both modifiers the handler accepts
    // The message box must NOT be cleared (a commit would consume the draft)…
    await expect(msg).toHaveValue('feat: keyboard fire with nothing staged')
    // …and NO commit may have landed.
    expect(commitCount(dir)).toBe(before)

    // (b) Now stage alpha, clear the message → staged but BLANK message → gate closed.
    await msg.fill('')
    await alphaRow(window).locator('.gp-action-btn[title="Stage"]').click()
    await expectPanel(window, 'STAGED CHANGES (1)')
    await msg.press('ControlOrMeta+Enter')
    await expect(window.locator('.gp-commit-btn')).toBeDisabled()
    expect(commitCount(dir)).toBe(before)

    // (c) Whitespace-only is still "blank" — the keyboard gate must not be fooled.
    await msg.fill('   ')
    await msg.press('ControlOrMeta+Enter')
    // Still staged (nothing committed), still disabled, still no new commit.
    await expectPanel(window, 'STAGED CHANGES (1)')
    expect(commitCount(dir)).toBe(before)
    await window.screenshot({ path: join(SHOTS, 'git-kbd-1-gate-blocked.png') })

    expect(errors).toEqual([])
  })

  test('⌘/Ctrl+Enter commits staged changes with a real message (button parity)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await openGitPanel(window)
    await expectPanel(window, 'CHANGES (2)')

    const msg = window.locator('.gp-commit-msg')
    const SUBJECT = 'fix: commit alpha via keyboard shortcut'

    // Stage alpha and type a real message → gate open, button live.
    await alphaRow(window).locator('.gp-action-btn[title="Stage"]').click()
    await expectPanel(window, 'STAGED CHANGES (1)')
    await msg.fill(SUBJECT)
    await expect(window.locator('.gp-commit-btn')).toBeEnabled()
    await window.screenshot({ path: join(SHOTS, 'git-kbd-2-ready.png') })

    const before = commitCount(dir)
    expect(before).toBe(1)

    // Fire the commit via the KEYBOARD, not the button.
    await msg.press('ControlOrMeta+Enter')

    // Contract, reached via the placeholder-advertised path:
    //  - alpha leaves the panel (Staged Changes section gone),
    await expect(async () => {
      expect(await panelText(window)).not.toContain('STAGED CHANGES')
    }).toPass({ timeout: 8000 })
    //  - the message box clears (draft consumed),
    await expect(msg).toHaveValue('')
    //  - exactly one new commit landed with the typed subject.
    await expect(async () => {
      expect(commitCount(dir)).toBe(before + 1)
    }).toPass({ timeout: 8000 })
    expect(git(dir, 'log', '-1', '--pretty=%s').trim()).toBe(SUBJECT)
    //  - and the git panel shows the new commit's subject in its history.
    await expect(
      window.locator('.gp-subject', { hasText: SUBJECT }),
    ).toBeVisible({ timeout: 6000 })
    await window.screenshot({ path: join(SHOTS, 'git-kbd-3-committed.png') })

    expect(errors).toEqual([])
  })
})
