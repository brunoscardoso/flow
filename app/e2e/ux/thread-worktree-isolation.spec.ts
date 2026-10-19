/**
 * The thread works in its own checkout, and cannot reach the project's
 * (thread-worktrees Phase 8, task 8.3).
 *
 * Two claims, both asserted against what the app really does:
 *
 *   1. THE THREAD'S ROOTS MOVE. Once a thread owns a checkout, the scope layer
 *      reports THAT as its root — and the project's own tree is not in the set
 *      at all. This is the one derivation the editor, the terminal and the git
 *      panel all read, so it is where "the project follows the thread" is
 *      either true or a claim.
 *
 *   2. A WRITE OUTSIDE IT IS REFUSED, and refused in a way that leaves nothing
 *      behind. Asserted by attempting one and then looking on disk — a check of
 *      the root LIST alone would pass while the door was open, which is exactly
 *      the shape of the hole Phase 4 had to close (the main checkout is a known
 *      project root, so a containment denial was being undone by auto-attach
 *      one line later).
 *
 * WHAT THIS SPEC DOES NOT REACH, stated plainly:
 *
 *   The agent's own `PreToolUse` containment — the hook that denies `Write`,
 *   `Edit`, `Bash` and friends outside the thread's roots, and the `knownRoots`
 *   filter that stops auto-attach re-opening the main checkout — lives inside a
 *   live agent session. Starting one needs a real agent account, and pointing a
 *   test at the developer's own credentials is forbidden here. So this spec
 *   drives the app's OWN write channel (`project:writeFile`, the editor's
 *   path, opened to a thread's checkout by Phase 3.5) instead. The hook itself
 *   is covered by `src/main/agent/agent-manager.test.ts` — "denies a write into
 *   the main checkout, and never auto-attaches it (it is a known root)" — which
 *   invokes the real hook built by the real `buildSessionOptions`.
 */
import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds } from './fixtures/seed'
import {
  AGENT_AUTH_ISOLATED,
  cleanupCheckouts,
  git,
  seedCommittedRepo,
  settleWorktree,
  startThreadInCheckout,
  waitForCheckout,
} from './fixtures/worktree'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

test.use({ appEnv: AGENT_AUTH_ISOLATED })

/** How long the thread's roots may take to follow its new checkout. */
const SCOPE_BUDGET_MS = 20_000

/** The file an escape would land on if one got through. */
const ESCAPE_FILE = 'escaped.md'

test.afterAll(() => {
  cleanupCheckouts()
  cleanupSeeds()
})

test('the thread’s roots are its own checkout, and a write outside it is refused', async ({
  window,
}) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  window.on('pageerror', (event) => errors.push(event.message))

  const project = await seedCommittedRepo(window, 'flow-wt-isolation-')
  await activateProject(window, project)
  await settleWorktree(window, project)
  const readmeBefore = readFileSync(join(project, 'README.md'), 'utf8')

  const threadId = await startThreadInCheckout(window, project, 'take a look at this project')

  const record = await waitForCheckout(window, project, threadId)
  const checkout = record.worktreePath ?? ''

  // ── 1. The thread's roots ───────────────────────────────────────────────
  await expect(async () => {
    const scope = (await window.evaluate(async () => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      return flow.project.getThreadScope({})
    })) as { threadId: string | null; roots: { rootPath: string; primary: boolean }[] }

    expect(scope.threadId).toBe(threadId)
    const paths = scope.roots.map((root) => root.rootPath)
    expect(paths, 'the thread’s root is its own checkout').toEqual([checkout])
    expect(
      scope.roots.find((root) => root.primary)?.rootPath,
      'and the checkout is the primary one',
    ).toBe(checkout)
    expect(paths, 'the project’s own tree is not one of the thread’s roots').not.toContain(project)
  }).toPass({ timeout: SCOPE_BUDGET_MS })

  // ── 2. Writes: inside is allowed, outside is refused ────────────────────
  const attempts = await window.evaluate(
    async ([root, projectName, escapeFile]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const write = async (relPath: string, content: string): Promise<string> => {
        try {
          await flow.project.writeFile({ rootPath: root, relPath, content })
          return 'written'
        } catch (error) {
          return String(error)
        }
      }
      return {
        inside: await write('inside.md', 'the thread’s own work\n'),
        // Up out of the checkout's container and back down into the project —
        // the exact path an agent standing in the checkout would take to reach
        // the tree the reader is standing in.
        intoProject: await write(`../../${projectName}/${escapeFile}`, 'escaped\n'),
        // And straight up, into the container the checkouts live in.
        intoContainer: await write(`../${escapeFile}`, 'escaped\n'),
      }
    },
    [checkout, basename(project), ESCAPE_FILE],
  )

  expect(attempts.inside, 'the thread may write in its own checkout').toBe('written')
  expect(existsSync(join(checkout, 'inside.md'))).toBe(true)

  expect(attempts.intoProject, 'a write into the project’s tree is refused').toContain(
    'escapes the project folder',
  )
  expect(attempts.intoContainer, 'a write above the checkout is refused').toContain(
    'escapes the project folder',
  )

  // REFUSED MEANS NOTHING HAPPENED. A denial that still wrote the file would
  // report exactly the same string.
  expect(existsSync(join(project, ESCAPE_FILE)), 'nothing was written into the project').toBe(false)

  // The project's own checkout is untouched — same content, same clean tree it
  // had before a thread ever ran.
  expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe(readmeBefore)
  expect(git(project, 'status', '--porcelain').trim()).toBe('')

  expect(errors, errors.join(', ')).toEqual([])
})
