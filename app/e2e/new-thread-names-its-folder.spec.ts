/**
 * THE NAME TYPED ON THE NEW-THREAD PAGE IS THE FOLDER ON DISK.
 *
 * Reported 2026-09-17, with a screenshot of a shell prompt: "created a new
 * worktree, new branch, but we are still showing the uuid, is showing the label
 * correctly only for the one that was migrated". The panel above the terminal
 * read `Branch worktree/work-test-branch`; the prompt read
 * `6418475d-0a52-46d8-a854-4440abc99960`.
 *
 * It was a DROPPED FIELD, not a naming bug. The chip on that page has always
 * worked the folder's name out (`prepareRequestFor` returns `worktreeName`),
 * `ThreadDraft` had nowhere to carry it, and `withBranch` copied the branch and
 * the start across and let the third one fall on the floor. Main was then asked
 * for a checkout with no name for it, and its documented fallback is the
 * thread's id.
 *
 * Every existing spec missed it because each tested one half: the chip's unit
 * tests asserted `prepareRequestFor` RETURNS the name, and the panel's e2e
 * proved the OTHER surface (the explorer switch) puts it on disk. Nothing
 * followed a name from this page to a directory — which is the whole trip.
 *
 * So this asks the store and GIT'S OWN REGISTRY, never the chip's own sentence
 * about itself (forbidden-pattern #7).
 */
import { test, expect } from './fixtures/electron'
import { activateProject, cleanupSeeds } from './ux/fixtures/seed'
import { AGENT_AUTH_ISOLATED, cleanupCheckouts, seedCommittedRepo, settleWorktree } from './ux/fixtures/worktree'
import { execFileSync } from 'node:child_process'

test.use({ appEnv: AGENT_AUTH_ISOLATED })

test.afterAll(() => {
  cleanupCheckouts()
  cleanupSeeds()
})

/** The stem a person types — nothing derives this from the title. */
const STEM = 'export-pipeline'

test('a thread created from the page lands in the folder its chip named', async ({ window }) => {
  test.setTimeout(300_000)

  const project = await seedCommittedRepo(window, 'flow-newthread-folder-')
  await activateProject(window, project)
  await settleWorktree(window, project)

  await window.locator('fl-button[aria-label="New thread"]').click()
  await expect(window.locator('.fl-newthread')).toBeVisible({ timeout: 20_000 })
  // AN ASK THAT WOULD NAME IT DIFFERENTLY, so a folder named from the subject
  // instead of from the field cannot pass by coincidence. (The title box is
  // hidden on this tab; the subject a thread is named from is what is typed
  // here.)
  await window.locator('.fl-newthread-body').fill('Rewrite the shipping calculator')

  await window.locator('.fl-newbranch-chip').click()
  const menu = window.locator('.fl-fmenu')
  await expect(menu).toBeVisible()
  // A CHECKOUT OF ITS OWN — the switch is what makes any of this happen.
  await menu.locator('.fl-wt-track').click()
  // THE FOLDER'S FIELD IS FIRST, with `worktree/` drawn inside it.
  const folder = menu.locator('.fl-fmenu-input').first()
  await expect(menu.locator('.fl-wt-fixed')).toHaveText('worktree/')
  await folder.fill(STEM)
  await window.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  await window.locator('.fl-newthread-footer fl-button', { hasText: 'Create thread' }).click()
  await expect(window.locator('.fl-newthread')).toBeHidden({ timeout: 30_000 })

  // The record catches up a moment after git does, so this polls.
  const recorded = await expect
    .poll(
      async () =>
        window.evaluate(async (root: string) => {
          const flow = (window as unknown as { flow: Record<string, any> }).flow
          const threads = await flow.threads.list({ projectRoot: root })
          return threads[0]?.worktreePath ?? null
        }, project),
      { timeout: 120_000 },
    )
    .not.toBeNull()
    .then(async () =>
      window.evaluate(async (root: string) => {
        const flow = (window as unknown as { flow: Record<string, any> }).flow
        const threads = await flow.threads.list({ projectRoot: root })
        return {
          path: (threads[0]?.worktreePath ?? null) as string | null,
          branch: (threads[0]?.worktreeBranch ?? null) as string | null,
          id: threads[0]?.id as string,
        }
      }, project),
    )

  // THE NAME, NOT THE ID. This is the assertion the report is about.
  expect(recorded.path).toMatch(new RegExp(`/worktree/${STEM}$`))
  expect(
    recorded.path ?? '',
    'the checkout was named after the thread rather than after the person',
  ).not.toContain(recorded.id)

  // GIT AGREES — a path the store holds and git has never heard of is a
  // checkout the next verb cannot find.
  expect(execFileSync('git', ['worktree', 'list'], { cwd: project }).toString()).toContain(
    recorded.path as string,
  )

  // …and the branch is not the folder wearing its prefix twice.
  expect(recorded.branch ?? '').not.toContain('worktree/worktree/')
})
