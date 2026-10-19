import { test, expect } from './fixtures/electron'
import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { cleanupSeeds } from './ux/fixtures/seed'
import {
  seedThreadInPushedProject,
  seedThreadOnDivergedBranch,
  seedThreadOnUnboundBranch,
} from './fixtures/thread-worktree'

/**
 * Publishing a branch from the Changes tab, end to end (push-from-review).
 *
 * THE REMOTE IS A REAL REPOSITORY ON DISK — a bare repo beside the project, the
 * only remote any of this touches. Which matters because the whole point of the
 * feature is WHERE a push goes, and a test that reads the toolbar's own sentence
 * back to itself proves only that the app can print. Every assertion about a
 * push here is made twice: once against what the reader was told, and once
 * against `git` in the bare repo (allowed-pattern #24 — the refusals especially,
 * because a loud refusal that pushes anyway is precisely the bug this control
 * exists to prevent).
 *
 * Selectors are the card's own class names, the same ones change-review.spec.ts
 * uses (`.flow-change-review`, `.flow-cr-ahead`, `.flow-cr-publish-note`) plus
 * the binding dialog's (`.fl-remote-binding`).
 */

/** Bare repos live outside `seedProject`'s bookkeeping, so they are tracked here. */
const remotes: string[] = []

test.afterAll(() => {
  cleanupSeeds()
  for (const dir of remotes) rmSync(dir, { recursive: true, force: true })
})

/** Bind the card to a thread the way the shell does — the DOM event it follows. */
async function activateThread(window: Page, threadId: string): Promise<void> {
  await window.evaluate((id) => {
    document.dispatchEvent(new CustomEvent('flow:active-thread', { detail: { threadId: id } }))
  }, threadId)
}

/** Open the Changes tab — the review lives in the editor area and never opens itself. */
async function openChangeReview(window: Page): Promise<void> {
  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-change-review'))
  })
}

/** Every branch a repository holds, asked of git. The refusal tests' evidence. */
function refsOn(repo: string): string[] {
  return execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: repo })
    .toString()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

function revParse(repo: string, ref: string): string {
  return execFileSync('git', ['rev-parse', ref], { cwd: repo }).toString().trim()
}

/** Commit through the SAME channel the Source Control panel uses — no git backdoor. */
async function commitThroughFlow(window: Page, threadId: string, filePath: string): Promise<void> {
  await window.evaluate(
    async ({ id, path }: { id: string; path: string }) => {
      const flow = (
        window as unknown as {
          flow: {
            git: {
              changeReview(r: { threadId: string }): Promise<{ rootId: string } | null>
              commit(r: {
                rootId: string
                message: string
                filePaths: string[]
              }): Promise<unknown>
            }
          }
        }
      ).flow
      const review = await flow.git.changeReview({ threadId: id })
      if (review === null) throw new Error('no review to commit')
      await flow.git.commit({ rootId: review.rootId, message: 'e2e commit', filePaths: [path] })
    },
    { id: threadId, path: filePath },
  )
}

test('pressing Push publishes the branch, and the remote really has it', async ({ window }) => {
  test.setTimeout(180_000)
  const { root, threadId, bare } = await seedThreadInPushedProject(window)
  remotes.push(bare)
  await activateThread(window, threadId)
  await openChangeReview(window)

  const card = window.locator('.flow-change-review')
  const push = card.getByRole('button', { name: 'Push', exact: true })
  await expect(card.locator('.flow-cr-row')).toHaveCount(1, { timeout: 30_000 })
  // Nothing is committed yet, so there is nothing to publish and no control for
  // it — asserted BEFORE the affirmative case below, so the locator that goes
  // on to prove presence has already proved it can be absent.
  await expect(push).toBeHidden()

  await commitThroughFlow(window, threadId, 'a.ts')

  // No click, no reopen: the tab notices the commit on its own, and what it
  // finds is one commit the remote does not have and a way to send it.
  await expect(card.locator('.flow-cr-scope')).toHaveText('Committed', { timeout: 30_000 })
  await expect(card.locator('.flow-cr-ahead')).toHaveText('↑1')
  await expect(push, 'the committed state offered no way to publish').toBeVisible()

  const head = revParse(root, 'HEAD')
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })
    .toString()
    .trim()
  expect(revParse(bare, branch), 'the remote already had the commit before Push').not.toBe(head)

  await push.click()

  // THE FACT, NOT THE CLAIM. The toolbar's sentence is asserted below; this is
  // the remote being asked what it holds.
  await expect
    .poll(() => revParse(bare, branch), {
      message: 'the commit never reached the bare repository',
      timeout: 60_000,
    })
    .toBe(head)

  // …and the sentence says where it went, in the same place the reader is
  // already looking. It survives the toolbar, which is gone: with the branch
  // published there is nothing left to review here.
  const note = card.locator('.flow-cr-publish-note')
  await expect(note, 'the publish reported nothing').toBeVisible({ timeout: 30_000 })
  await expect(note).toHaveText(`Published to origin/${branch}.`)

  // `↑1` is gone, and it went WITHOUT a reopen — the publish announces its own
  // write. Asserted on the same locator that read `↑1` a moment ago, so an
  // absence here cannot be a selector that never matched.
  await expect(card.locator('.flow-cr-ahead')).toBeHidden({ timeout: 30_000 })
  await expect(push, 'Push stayed on a branch with nothing left to publish').toBeHidden()
  await window.screenshot({ path: 'e2e/__screens/publish-published.png' })
})

test('an unaimed branch asks where to publish, and cancelling sends nothing', async ({
  window,
}) => {
  test.setTimeout(180_000)
  const { root, threadId, bare, branch } = await seedThreadOnUnboundBranch(window)
  remotes.push(bare)
  await activateThread(window, threadId)
  await openChangeReview(window)

  const card = window.locator('.flow-change-review')
  await expect(card.locator('.flow-cr-row')).toHaveCount(1, { timeout: 30_000 })
  await expect(card.locator('.flow-cr-branch-name')).toHaveText(branch)

  // R1: the control is PRESENT on a branch nobody has published, even though
  // `↑N` is absent. There is no upstream for it to be ahead of, so the count is
  // zero for the opposite reason a fully-published branch's is — and answering
  // a first publish with "there is nothing to publish" is the bug `bound` exists
  // to prevent.
  await expect(card.locator('.flow-cr-ahead')).toBeHidden()
  const push = card.getByRole('button', { name: 'Push', exact: true })
  await expect(push, 'a branch that has never been published offered no way to').toBeVisible()

  await push.click()

  const dialog = window.locator('.fl-remote-binding')
  await expect(dialog, 'pressing Push on an unaimed branch asked nothing').toBeVisible({
    timeout: 60_000,
  })
  await window.screenshot({ path: 'e2e/__screens/publish-unbound-ask.png' })

  await dialog.locator('.fl-remote-binding-cancel').click()

  // THE TRANSCRIPT: the question closed and the button is back at rest, not
  // stuck mid-publish.
  await expect(dialog, 'cancelling left the question on screen').toHaveCount(0)
  await expect(push).toBeVisible()
  await expect(push).toHaveText('Push')
  await expect(push).toBeEnabled()
  // Dismissing is an answer that changes nothing, so there is nothing to report.
  // Counted first: the note element is always in the card, so a `toBeHidden` on
  // a selector that matched nothing would pass for the wrong reason.
  await expect(card.locator('.flow-cr-publish-note')).toHaveCount(1)
  await expect(card.locator('.flow-cr-publish-note')).toBeHidden()

  // THE ABSENCE OF THE EFFECT (allowed-pattern #24). `refsOn` is proved against
  // the checkout FIRST — a helper that silently returned nothing would make the
  // assertion below pass for the wrong reason, which is exactly how an absence
  // test lies.
  expect(refsOn(root), 'refsOn read no branches at all — the assertion below proves nothing')
    .toContain(`refs/heads/${branch}`)
  expect(refsOn(bare), 'something was published to the remote nobody chose').toEqual([])
})

test('a diverged branch is refused in words, and nothing is sent', async ({ window }) => {
  test.setTimeout(180_000)
  const { threadId, bare, branch, clone } = await seedThreadOnDivergedBranch(window)
  remotes.push(bare, clone)
  await activateThread(window, threadId)
  await openChangeReview(window)

  const card = window.locator('.flow-change-review')
  await expect(card.locator('.flow-cr-scope')).toHaveText('Committed', { timeout: 30_000 })
  await expect(card.locator('.flow-cr-ahead')).toHaveText('↑1')

  const theirCommit = revParse(bare, branch)
  const push = card.getByRole('button', { name: 'Push', exact: true })
  await expect(push).toBeVisible()
  await push.click()

  // The toolbar says what is true — the other side has commits this branch does
  // not — and offers no pull, rebase or force, because the decision is not this
  // control's to make.
  const note = card.locator('.flow-cr-publish-note')
  await expect(note, 'a diverged branch was refused silently').toBeVisible({ timeout: 60_000 })
  await expect(note).toHaveText(
    'The remote has 1 commit this branch does not. Nothing was sent — bring those down first.',
  )
  await window.screenshot({ path: 'e2e/__screens/publish-diverged.png' })

  // NOTHING WAS SPAWNED: the refusal is made above the push, so the remote is
  // exactly where the other clone left it.
  expect(refsOn(bare), 'the remote lost or gained a branch during a refusal').toEqual([
    `refs/heads/${branch}`,
  ])
  expect(revParse(bare, branch), 'a refused publish moved the remote anyway').toBe(theirCommit)

  // …and the branch is still offered, with its commit still unpublished: the
  // refusal changed the reader's information, not their repository.
  await expect(card.locator('.flow-cr-ahead')).toHaveText('↑1')
  await expect(push).toBeVisible()
})
