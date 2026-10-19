/**
 * A thread writes, lands, and the work is on the project's branch
 * (thread-worktrees Phase 8, task 8.1).
 *
 * THE ONE TEST THAT MEETS THE FEATURE THE WAY A PERSON DOES: a repository is
 * added, a thread is opened, a message is sent, the thread's own checkout is
 * cut, something is written in it, and Merge is pressed. Everything asserted
 * afterwards is read from GIT and from the DISK — not from the app's report of
 * itself, which is the whole reason this file exists (forbidden-pattern #7).
 *
 * WHAT IS SIMULATED, AND WHY — read this before trusting the tick:
 *
 *   The FILE the thread "writes" is written by the test, through the app's own
 *   `project:writeFile` channel (the same one the editor writes through, and
 *   the one Phase 3.5 opened to a thread's checkout). A file authored by a real
 *   agent would need a real agent account, and pointing a test at the
 *   developer's own credentials is forbidden — it would be slow, billable and
 *   non-deterministic. So the WRITE is the app's; only its author is not.
 *
 *   The checkout's BRANCH is never named here, because nothing credential-free
 *   can name it: `thread/<title>` is created by `nameAfterTitle`, which runs
 *   only after a turn SUCCEEDS and the thread earns a title. So this spec lands
 *   a DETACHED checkout — the state a real thread is in for its whole first
 *   turn — and cannot assert "the `thread/*` branch survives". That assertion
 *   lives at unit level (`src/main/git/thread-merge.test.ts`: the release path
 *   never names a branch to git, and never passes `-D`). It is a gap in THIS
 *   file, stated rather than papered over.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { activateProject, cleanupSeeds } from './fixtures/seed'
import {
  AGENT_AUTH_ISOLATED,
  cleanupCheckouts,
  git,
  listThreads,
  readThread,
  registeredWorktrees,
  seedCommittedRepo,
  settleWorktree,
  waitForCheckout,
} from './fixtures/worktree'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

test.use({ appEnv: AGENT_AUTH_ISOLATED })

/** What the thread "changed", and where. */
const WORK_FILE = 'notes.md'
const WORK_TEXT = 'written inside the thread’s own checkout\n'

/** The message a person types into the landing box before pressing Merge. */
const LANDING_MESSAGE = 'feat: what this thread changed'

/** How long the landing itself may take: a commit, a merge, a ref move, a
 *  directory removal — four git calls against a one-file repository. */
const LANDING_BUDGET_MS = 45_000

/** How long the landing surface may take to notice there is something to land. */
const LANDING_READY_BUDGET_MS = 30_000

test.afterAll(() => {
  cleanupCheckouts()
  cleanupSeeds()
})

/** Open the Source Control panel's Changes view, where the landing bar lives. */
async function openSourceControl(win: Page): Promise<void> {
  await win.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await win.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(win.locator('.gp-root')).toBeVisible({ timeout: 15_000 })
}

/**
 * SKIPPED 2026-09-04 — the surface this drives was removed.
 *
 * Source Control's thread-landing block ("This thread's work", the waiting
 * line, the disk-quota count, Merge and "Let the workspace go") was taken out
 * on the user's call: it sat above the branch, the commit box and the log —
 * what the panel is actually opened for — and read as a second subject in a
 * panel that already had one.
 *
 * `Merge` lived only there, so landing a thread's worktree is no longer a UI
 * action at all. Releasing one survives as "Let it go" in the worktrees
 * manager. This spec is kept rather than deleted because it is the written
 * record of what the landing flow guaranteed, and the thing to un-skip if that
 * flow ever comes back.
 */
test.skip('a thread’s work lands on the project’s branch and its checkout goes', async ({
  window,
}) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  window.on('pageerror', (event) => errors.push(event.message))

  const project = await seedCommittedRepo(window, 'flow-wt-landing-')
  await activateProject(window, project)
  // Let the freshly-added project finish being provisioned — a warm project is
  // what a real thread opens in, and it is what stops a scope refresh this spec
  // did not cause from standing in for one it did.
  await settleWorktree(window, project)
  const baseTipBefore = git(project, 'rev-parse', 'main').trim()

  // A thread, and its first message.
  await window.locator('fl-button[aria-label="New thread"]').click()
  await window.getByText('New thread', { exact: true }).first().click()
  await expect(window.locator('.fl-composer')).toBeVisible()
  const threadId = (await listThreads(window, project))[0]?.id ?? ''
  expect(threadId, 'the new thread should be in the store').not.toBe('')

  const composer = window.locator('.fl-composer textarea')
  await composer.click()
  await composer.fill('take a look at this project')
  await composer.press('Enter')

  // THE CHECKOUT IS CUT BY THE MESSAGE. Waiting for the user's own bubble would
  // not be waiting for this — the optimistic echo is on screen before the
  // worktree step even starts.
  const withCheckout = await waitForCheckout(window, project, threadId)
  const checkout = withCheckout.worktreePath ?? ''
  expect(registeredWorktrees(project), 'git itself should know the checkout').toContain(checkout)

  // The thread's work, written where the thread works.
  await window.evaluate(
    async ([root, relPath, content]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      await flow.project.writeFile({ rootPath: root, relPath, content })
    },
    [checkout, WORK_FILE, WORK_TEXT],
  )
  expect(existsSync(join(checkout, WORK_FILE))).toBe(true)
  // …and nowhere else. The project's own tree has not seen it.
  expect(existsSync(join(project, WORK_FILE))).toBe(false)

  // The landing surface: it appears because this thread HAS a checkout, and it
  // offers Merge because Flow knows which branch the work belongs on.
  await openSourceControl(window)
  const bar = window.locator('.gp-landing')
  await expect(bar).toBeVisible({ timeout: LANDING_READY_BUDGET_MS })
  const merge = bar.locator('.gp-landing-primary')
  await expect(merge).toHaveText('Merge')
  await expect(merge, 'Merge must be live once the checkout holds work').toBeEnabled({
    timeout: LANDING_READY_BUDGET_MS,
  })

  // ── IT BELONGS TO ONE PROJECT (landing-per-project) ──────────────────────
  //
  // The controls used to sit in a bar above the whole panel, which on this very
  // shape — the thread's checkout AND the project's own tree, both listed —
  // read as acting on both. It acts on one. So: exactly one group carries the
  // block, and it is the group whose header says which one.
  const owner = window.locator('.gp-group').filter({ has: window.locator('.gp-landing') })
  await expect(owner, 'one group carries the landing, not the panel').toHaveCount(1)
  await expect(owner.locator('.gp-group-name').first()).toHaveText(
    `${basename(project)} (this thread)`,
  )
  // …and the project's own tree, listed right below it, offers nothing that
  // would land anything.
  const own = window
    .locator('.gp-group')
    .filter({ hasNot: window.locator('.gp-landing') })
    .first()
  await expect(own.locator('.gp-landing-btn')).toHaveCount(0)

  // THE TYPED MESSAGE SURVIVES A BACKGROUND REFRESH. The block is inside the
  // panel's scroll area now, and the panel rebuilds its whole DOM on every
  // status read — which is exactly what the message box used to be lifted out
  // of the way of. Type half of it, provoke a real refresh, and check.
  const messageBox = bar.locator('.gp-landing-msg')
  const half = LANDING_MESSAGE.slice(0, 12)
  await messageBox.click()
  await messageBox.fill(half)
  await window.evaluate(
    async ([root, relPath]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      await flow.project.writeFile({ rootPath: root, relPath, content: 'a background write\n' })
    },
    [project, 'background-write.md'],
  )
  await expect(async () => {
    const listed = await window.locator('.gp-name').allTextContents()
    expect(listed.join(' '), 'the refresh really happened').toContain('background-write.md')
  }).toPass({ timeout: LANDING_READY_BUDGET_MS })
  await expect(messageBox, 'a half-typed landing message survives the rebuild').toHaveValue(half)

  // The message box INSIDE the block — and it no longer shares a class with the
  // panel's own commit boxes, which now sit in the same group.
  await messageBox.fill(LANDING_MESSAGE)
  await merge.click()

  // ── What actually happened, read from git ───────────────────────────────

  await expect(async () => {
    const log = git(project, 'log', '--oneline', '-3', 'main')
    expect(log).toContain(LANDING_MESSAGE)
  }).toPass({ timeout: LANDING_BUDGET_MS })

  // The base branch MOVED, and it moved onto work that did not exist in it.
  expect(git(project, 'rev-parse', 'main').trim()).not.toBe(baseTipBefore)
  expect(git(project, 'show', `main:${WORK_FILE}`)).toContain('inside the thread’s own checkout')
  // The project's own working tree carries it now — a fast-forward of the
  // checkout the reader is standing in, which is what "landed" means to them.
  expect(existsSync(join(project, WORK_FILE))).toBe(true)

  // THE CHECKOUT IS GONE — pressing Merge prunes it (`pruneAfter: true`), so
  // this needs no second press.
  await expect(async () => {
    expect(existsSync(checkout), 'the checkout directory should be gone').toBe(false)
    expect(registeredWorktrees(project), 'git should no longer list it').not.toContain(checkout)
  }).toPass({ timeout: LANDING_BUDGET_MS })

  // And the thread no longer claims one, so every surface reads it as a thread
  // working in the project's own files again.
  await expect(async () => {
    const after = await readThread(window, project, threadId)
    expect(after?.worktreePath).toBeNull()
  }).toPass({ timeout: LANDING_BUDGET_MS })

  // The landing surface goes with it: there is nothing left to land.
  await expect(bar).toBeHidden({ timeout: LANDING_BUDGET_MS })

  expect(errors, errors.join(', ')).toEqual([])
})
