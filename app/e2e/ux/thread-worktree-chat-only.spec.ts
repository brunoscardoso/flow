/**
 * A thread nobody sends a message to is exactly as it was
 * (thread-worktrees Phase 8, task 8.2).
 *
 * THE USER'S STATED GUARANTEE, and the reason it is worth a whole spec: this
 * feature gives threads a second copy of the repository, a branch namespace and
 * a new surface in the Source Control panel. None of that may reach a thread
 * that has not asked for it. The guarantee is a fact about WHERE creation is
 * called from — the send path and nowhere else — so the honest way to test it
 * is to leave a thread alone and look at the disk.
 *
 * TWO THREADS, ON PURPOSE. A spec with one untouched thread would pass just as
 * happily if the feature were switched off entirely, or broken, or never
 * wired up. The second thread sends a message and gets a checkout in the same
 * project, in the same run — so the first thread's emptiness is a decision the
 * app made, not an absence of the feature.
 *
 * WHAT "CHAT-ONLY" MEANS HERE. It means a thread that never sends. A thread
 * that sends even a pure conversational message DOES get a checkout — creation
 * hangs off the first message, never off the first write (a brainstorm
 * rejection, settled deliberately). So the landing bar this spec asserts is
 * absent for an unmessaged thread WILL appear for a thread you only chatted to.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { activateProject, cleanupSeeds } from './fixtures/seed'
import {
  AGENT_AUTH_ISOLATED,
  cleanupCheckouts,
  git,
  localBranches,
  readThread,
  registeredWorktrees,
  seedCommittedRepo,
  settleWorktree,
  threadCheckoutContainer,
  waitForCheckout,
} from './fixtures/worktree'
import { existsSync } from 'node:fs'

test.use({ appEnv: AGENT_AUTH_ISOLATED })

/** Titles that say which thread is which in the sidebar. */
const QUIET_THREAD = 'Only ever read'
const WORKING_THREAD = 'Sent a message'

/** Long enough for a checkout to have appeared if one were ever coming: the
 *  working thread's own checkout arrives inside this, in the same run. */
const SETTLE_MS = 3_000

test.afterAll(() => {
  cleanupCheckouts()
  cleanupSeeds()
})

/** Create a thread in a project without going through the sidebar's menus, so
 *  two threads can be told apart by name rather than by row order. */
async function createThread(win: Page, projectRoot: string, title: string): Promise<string> {
  return win.evaluate(
    async ([root, name]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const thread = await flow.threads.create({ title: name, projectRoot: root })
      return thread.id as string
    },
    [projectRoot, title],
  )
}

/** Select a thread by its title in the sidebar — a click, as a person does it. */
async function selectThread(win: Page, title: string): Promise<void> {
  await win.locator('fl-list').getByText(title, { exact: true }).first().click()
  await expect(win.locator('.fl-composer')).toBeVisible()
}

test('a thread that never sends has no checkout, no branch and no landing', async ({
  window,
}) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  window.on('pageerror', (event) => errors.push(event.message))

  const project = await seedCommittedRepo(window, 'flow-wt-chatonly-')
  await activateProject(window, project)
  await settleWorktree(window, project)

  const quiet = await createThread(window, project, QUIET_THREAD)
  const working = await createThread(window, project, WORKING_THREAD)

  // ── The proof the feature is live: the other thread sends, and gets one ──
  await selectThread(window, WORKING_THREAD)
  const composer = window.locator('.fl-composer textarea')
  await composer.click()
  await composer.fill('have a look at this project')
  await composer.press('Enter')
  const busy = await waitForCheckout(window, project, working)
  expect(busy.worktreePath, 'the messaging thread should own a checkout').not.toBeNull()

  // ── The guarantee: the quiet thread is untouched ────────────────────────
  await selectThread(window, QUIET_THREAD)
  await new Promise((settle) => setTimeout(settle, SETTLE_MS))

  const record = await readThread(window, project, quiet)
  expect(record?.worktreePath, 'a thread that never sent a message owns no checkout').toBeNull()
  expect(record?.worktreeBranch).toBeNull()
  expect(record?.worktreeBase).toBeNull()

  // Nothing of it on disk. The container exists (the other thread has one), so
  // this asserts the ABSENCE OF THIS THREAD'S directory rather than of the
  // feature — a directory named after it would be exactly what it must not have.
  expect(existsSync(`${threadCheckoutContainer(project)}/${quiet}`)).toBe(false)
  const worktrees = registeredWorktrees(project)
  expect(worktrees.some((path) => path.includes(quiet))).toBe(false)

  // No branch was minted for it either.
  expect(localBranches(project).filter((branch) => branch.startsWith('thread/'))).toEqual([])

  // NO MERGE AFFORDANCE. The landing bar hides itself for a thread with no
  // checkout, which is cheaper to assert than the disk and is what the reader
  // actually experiences: the panel looks like it always did.
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('.gp-landing')).toBeHidden()
  await expect(window.locator('.gp-landing-btn')).toHaveCount(0)

  // And the project's own tree is where it was — the quiet thread changed
  // nothing, and the busy one changed nothing HERE.
  expect(git(project, 'status', '--porcelain').trim()).toBe('')

  expect(errors, errors.join(', ')).toEqual([])
})
