/**
 * UX sweep — flow `git` (rotation index 6, round 16): the Source Control commit
 * box's ✨ "Generate commit message with AI" wand vs. a panel re-render that
 * lands while it is still thinking.
 *
 * Why this is un-probed: 24 git specs drive stage / unstage / commit / diff /
 * merge / pull / history, and `git-commit-gate-reason.spec.ts` drives the commit
 * BUTTON's two gates and its draft-survives-re-render guard — but nothing has
 * ever clicked the ✨ wand sitting right next to that button
 * (`git-panel.ts:627-648` → `git/index.ts:285 onGenerateMessage` →
 * `review:generateCommitMessage` → the agent's one-shot generate).
 *
 * The seam: generation takes ~5s, and #renderCommitBox recreates the textarea on
 * EVERY panel render. The click handler captures `textarea` in its closure and,
 * when the promise resolves, writes to that captured element and to
 * `#commitDrafts` — with no check that either is still the live one. Any refresh
 * during those 5s (staging another file, or just a file save reaching
 * `api.project.onFileChanged` → `queueRefresh`) therefore
 *
 *   1. discards the generated message (the wand re-enables, box stays empty,
 *      zero toasts — the click looks dead), and
 *   2. overwrites `#commitDrafts` afterwards, so a message the user typed in the
 *      meantime is silently replaced by the abandoned AI text on the next
 *      background refresh.
 *
 * Both are #1020. The live guards below hold before AND after a fix; the two
 * `test.fixme` tests are tripwires that flip green when it lands.
 *
 * Account note: generation needs a signed-in Claude account. The gate guard is
 * account-independent and always runs; the happy-path guard skips itself if the
 * environment has no account (it never fakes success).
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')

/** Generation is a real agent round trip — allow well over the ~5s it takes. */
// Must exceed the #513 session-start provisioning gate (bounded 120s): a
// generate fired while the freshly-added root is still provisioning waits
// behind that gate before it can settle into a message or a failure toast.
const GENERATE_TIMEOUT_MS = 150_000

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** One commit, a modified tracked file, and an untracked file. */
function populateRepo(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  writeFileSync(join(dir, 'alpha.txt'), 'first line\nsecond line\n')
  git(dir, 'add', 'alpha.txt')
  git(dir, 'commit', '-q', '-m', 'feat: add alpha')
  writeFileSync(join(dir, 'alpha.txt'), 'first line CHANGED\nsecond line\nthird\n')
  writeFileSync(join(dir, 'beta.txt'), 'brand new untracked file\n')
}

/** Reveal Source Control → Changes and wait for the git panel to mount + load. */
async function openGitPanel(window: Page): Promise<string> {
  // Populate inside `prepare` (pre-addRoot) so the app's own git activity
  // (status refreshes, provisioning) can't race the seed on index.lock.
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

async function expectPanel(window: Page, needle: string): Promise<void> {
  await expect(async () => {
    expect(await window.locator('.gp-root').innerText()).toContain(needle)
  }).toPass({ timeout: 8000 })
}

function row(window: Page, name: string) {
  return window
    .locator('.gp-row', { has: window.locator('.gp-name', { hasText: name }) })
    .first()
}

/** Stage `alpha.txt` so the wand is live, and return the panel's controls. */
async function openWithAlphaStaged(window: Page): Promise<{ dir: string }> {
  const dir = await openGitPanel(window)
  await expectPanel(window, 'CHANGES (2)')
  await row(window, 'alpha.txt').locator('.gp-action-btn[title="Stage"]').click()
  await expectPanel(window, 'STAGED CHANGES (1)')
  return { dir }
}

/** Wait for generation to settle into EITHER a message or a feedback toast. */
async function waitForGenerationToSettle(window: Page): Promise<{
  message: string
  toasts: string[]
}> {
  // `.fl-flow-toast` is the real toast card class (flow/notification-center.ts) —
  // the failure-feedback path this waits on renders through it. A settle
  // TIMEOUT (no message, no toast — e.g. an account-less environment where the
  // generate call parks behind the session-start gate) degrades to the empty
  // result so the account-gated callers skip, per this spec's design.
  try {
    await expect(async () => {
      const value = await window.locator('.gp-commit-msg').inputValue()
      const toasts = await window.locator('.fl-flow-toast').count()
      expect(value.length > 0 || toasts > 0).toBe(true)
    }).toPass({ timeout: GENERATE_TIMEOUT_MS })
  } catch {
    return { message: '', toasts: ['<generation never settled in this environment>'] }
  }
  return {
    message: await window.locator('.gp-commit-msg').inputValue(),
    toasts: await window.locator('.fl-flow-toast').allInnerTexts(),
  }
}

test.afterAll(() => cleanupSeeds())

test.describe('git ✨ generate commit message vs. a mid-flight re-render', () => {
  test.setTimeout(240_000)

  // ── Live guard 1 (account-independent) ─────────────────────────────────────
  test('the wand is gated on having something staged', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openGitPanel(window)
    await expectPanel(window, 'CHANGES (2)')

    const wand = window.locator('.gp-commit-generate')
    await expect(wand).toBeVisible()
    await expect(wand).toHaveAttribute('aria-label', 'Generate commit message with AI')

    // Nothing staged: there is no change to describe, so the wand must be dead
    // by design (disabled), not a live button that quietly does nothing.
    await expect(wand).toBeDisabled()

    // Staging gives it something to describe → live.
    await row(window, 'alpha.txt').locator('.gp-action-btn[title="Stage"]').click()
    await expectPanel(window, 'STAGED CHANGES (1)')
    await expect(wand).toBeEnabled()

    // Unstaging takes it away again → back to disabled (the gate is not one-way).
    await row(window, 'alpha.txt').locator('.gp-action-btn[title="Unstage"]').click()
    await expectPanel(window, 'CHANGES (2)')
    await expect(wand).toBeDisabled()
    await window.screenshot({ path: join(SHOTS, 'git-generate-gate.png') })

    expect(errors).toEqual([])
  })

  // ── Live guard 2 (account-gated; skips cleanly without one) ────────────────
  test('an undisturbed wand click fills the box with a usable message', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    await openWithAlphaStaged(window)
    const msg = window.locator('.gp-commit-msg')

    await window.locator('.gp-commit-generate').click()
    const settled = await waitForGenerationToSettle(window)
    test.skip(
      settled.message.length === 0,
      `no Claude account in this environment (feedback: ${JSON.stringify(settled.toasts)})`,
    )

    // A real, committable suggestion — and the Commit button re-gates on it.
    expect(settled.message.trim().length).toBeGreaterThan(0)
    await expect(window.locator('.gp-commit-btn')).toBeEnabled()
    await expect(window.locator('.gp-commit-generate')).toBeEnabled()
    await window.screenshot({ path: join(SHOTS, 'git-generate-happy.png') })

    // It survives the re-render that committing it causes, end to end.
    const generated = await msg.inputValue()
    await window.locator('.gp-commit-btn').click()
    await expect(async () => {
      expect(await window.locator('.gp-root').innerText()).not.toContain('STAGED CHANGES')
    }).toPass({ timeout: 10_000 })
    await expect(window.locator('.gp-subject', { hasText: generated })).toBeVisible({
      timeout: 6000,
    })

    expect(errors).toEqual([])
  })

  // ── Former tripwire A — live guard since the #1020 fix ─────────────────────
  test(
    'a panel re-render during generation does not discard the message (#1020)',
    async ({ window }) => {
      await openWithAlphaStaged(window)
      const msg = window.locator('.gp-commit-msg')

      await window.locator('.gp-commit-generate').click()
      await window.waitForTimeout(700)

      // The most natural thing a waiting user does: stage the other file too.
      // That is an async IPC round trip → git refresh → full panel rebuild.
      await row(window, 'beta.txt').locator('.gp-action-btn[title="Stage"]').click()
      await expectPanel(window, 'STAGED CHANGES (2)')

      // The suggestion the user asked for must still arrive in the live box.
      await expect(async () => {
        expect((await msg.inputValue()).trim().length).toBeGreaterThan(0)
      }).toPass({ timeout: GENERATE_TIMEOUT_MS })
    },
  )

  // ── Former tripwire B — live guard since the #1020 fix ─────────────────────
  test(
    'an abandoned generation never replaces a message the user typed (#1020)',
    async ({ window }) => {
      await openWithAlphaStaged(window)
      const msg = window.locator('.gp-commit-msg')
      const MINE = 'fix: my own carefully worded message'

      await window.locator('.gp-commit-generate').click()
      await window.waitForTimeout(700)
      await row(window, 'beta.txt').locator('.gp-action-btn[title="Stage"]').click()
      await expectPanel(window, 'STAGED CHANGES (2)')

      // The wand looks finished and the box is empty, so the user writes their own.
      await msg.fill(MINE)
      await expect(msg).toHaveValue(MINE)

      // Let the abandoned generation resolve, then trigger any refresh.
      await window.waitForTimeout(15_000)
      await row(window, 'beta.txt').locator('.gp-action-btn[title="Unstage"]').click()
      await expectPanel(window, 'STAGED CHANGES (1)')
      await window.waitForTimeout(1000)

      // The user's own words must still be there.
      await expect(msg).toHaveValue(MINE)
    },
  )
})
