/**
 * THE FOLDER-BEHIND NOTICE, AGAINST REAL GIT (user, 2026-10-12: "every new
 * thread branch created, we need to pull recent changes from main
 * automatically").
 *
 * The main half — fetch, compare, write the row once — is covered by
 * `thread-worktree.test.ts` with git faked. This is the half a person actually
 * meets: a real repository that is really behind a real remote, the card that
 * says so, and the button that brings it up to date. Both ends are checked on
 * disk, so a notice that said "up to date" over a folder that never moved
 * would fail here (allowed-pattern #7).
 *
 * The row is seeded rather than earned, because earning it needs an agent turn
 * and this spec is about the card, not the send path.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

test.afterAll(() => cleanupSeeds())

/** Run git in a directory, with an identity so commits are possible. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Flow Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Flow Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).toString()
}

/** How many commits a checkout's branch holds. */
function commitCount(dir: string): number {
  return Number(git(dir, 'rev-list', '--count', 'HEAD').trim())
}

test('a thread says the folder is behind, and the action really brings it up to date', async ({
  window: page,
}) => {
  test.setTimeout(240_000)

  let bare = ''
  const root = await seedProject(page, 'flow-ux-behind-', (dir) => {
    // A project with one commit on `main`, pushed to a bare remote of its own.
    writeFileSync(join(dir, 'README.md'), '# behind\n')
    git(dir, 'add', 'README.md')
    git(dir, 'commit', '-q', '-m', 'first')
    git(dir, 'branch', '-M', 'main')
    bare = mkdtempSync(join(tmpdir(), 'flow-ux-behind-remote-'))
    git(bare, 'init', '-q', '--bare')
    git(dir, 'remote', 'add', 'origin', bare)
    git(dir, 'push', '-q', '-u', 'origin', 'main')
    // …and then the remote moves on, twice, without this checkout.
    const other = mkdtempSync(join(tmpdir(), 'flow-ux-behind-other-'))
    git(other, 'clone', '-q', bare, 'work')
    const work = join(other, 'work')
    writeFileSync(join(work, 'second.md'), 'second\n')
    git(work, 'add', 'second.md')
    git(work, 'commit', '-q', '-m', 'second')
    writeFileSync(join(work, 'third.md'), 'third\n')
    git(work, 'add', 'third.md')
    git(work, 'commit', '-q', '-m', 'third')
    git(work, 'push', '-q', 'origin', 'main')
    // The checkout has not fetched, so it does not know yet.
    git(dir, 'fetch', '-q', 'origin', 'main')
  })
  await activateProject(page, root)

  // POSITIVE FIRST (allowed-pattern #28): the folder really is behind on disk,
  // so the assertions below are about the app rather than about the fixture.
  expect(commitCount(root)).toBe(1)
  expect(Number(git(root, 'rev-list', '--count', 'HEAD..origin/main').trim())).toBe(2)

  const thread = await page.evaluate(
    async (projectRoot) =>
      await (
        window as unknown as {
          flow: { threads: { create(r: unknown): Promise<{ id: string }> } }
        }
      ).flow.threads.create({ projectRoot, title: 'Behind thread' }),
    root,
  )
  await page.evaluate(
    async (threadId) => {
      const flow = (window as unknown as {
        flow: { messages: { append(r: unknown): Promise<unknown> } }
      }).flow
      // The row main writes on the first turn, then the message it was about.
      await flow.messages.append({ threadId, role: 'system', content: '[folder-behind] main origin/main' })
      await flow.messages.append({ threadId, role: 'user', content: 'have a look at the readme' })
    },
    thread.id,
  )
  await page.getByText('Behind thread', { exact: true }).first().click()

  // ── THE NOTICE, WITH THE LIVE NUMBERS ────────────────────────────────────
  const notice = page.locator('.fl-conv-entry-folder-behind')
  await expect(notice).toBeAttached({ timeout: 30_000 })
  await expect(notice.locator('.fl-folder-behind-headline')).toHaveText(
    'Your project folder is 2 commits behind main.',
    { timeout: 30_000 },
  )
  await expect(notice.locator('.fl-folder-behind-row')).toHaveAttribute('data-tone', 'behind')
  // The row is not a plain system line, and it carries no invocation
  // (forbidden-pattern #12).
  await expect(notice).not.toContainText('[folder-behind]')
  await expect(notice).not.toContainText('git ')

  // ── THE ACTION ───────────────────────────────────────────────────────────
  const action = notice.locator('.fl-folder-behind-action')
  await expect(action).toHaveText('Bring it up to date')
  await action.click()

  await expect(notice.locator('.fl-folder-behind-headline')).toHaveText(
    'Your project folder is up to date. 2 commits arrived.',
    { timeout: 60_000 },
  )
  // The control is gone once there is nothing left to do.
  await expect(notice.locator('.fl-folder-behind-action')).toHaveCount(0)

  // ── AND THE FILES REALLY MOVED ───────────────────────────────────────────
  // The claim on screen is checked against the repository it was about: the
  // whole point of the notice is that it reports a fact, not a hope.
  expect(commitCount(root)).toBe(3)
  expect(Number(git(root, 'rev-list', '--count', 'HEAD..origin/main').trim())).toBe(0)
})
