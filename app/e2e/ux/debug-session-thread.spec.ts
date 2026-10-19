import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject, openThreadByTitle } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

test.afterAll(() => cleanupSeeds())

/**
 * WHICH CONVERSATION A SESSION BELONGS TO, when nobody told it.
 *
 * The feature shipped broken and its own e2e passed, because the spec selected
 * a thread by dispatching `flow:open-thread` and the app's sidebar does not:
 * that event is fired only by TASK surfaces opening a task's chat. In normal
 * use the renderer's idea of the active thread was null, so no summary was ever
 * posted and the feature looked dead (user, 2026-09-21: "nothing happens...
 * not seeing nothing being added to the context").
 *
 * The answer now comes from main — `ProjectContext.activeThreadId`, persisted
 * on the real selection path — so this guards the RESOLUTION rather than the
 * renderer's bookkeeping. It selects a thread by clicking its row, which is the
 * only way this test is worth having.
 */
test('a session finds its thread when the renderer never said which', async ({ window }) => {
  test.setTimeout(300_000)
  const root = await seedProject(window, 'flow-repro-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir })
  })
  await activateProject(window, root)

  const threadId = await window.evaluate(async (projectRoot: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    return (await flow.threads.create({ projectRoot, title: 'Repro thread' })).id
  }, root)

  // THE REAL PATH: click the thread row in the sidebar, like a person does.
  // NOT `document.dispatchEvent(flow:open-thread)`, which is what the passing
  // e2e used and which only task surfaces actually fire.
  // A real press on the row's title (the row no longer carries a titled
  // span), waiting until that row is the CURRENT one and its composer is up.
  await openThreadByTitle(window, 'Repro thread')

  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:debug-toggle')))
  await window.waitForTimeout(1200)
  const live = (await window.evaluate(async () =>
    (window as unknown as { flow: Record<string, any> }).flow.debug.status({}),
  )) as { threadId: string | null } | null

  console.log('SESSION_THREAD ' + JSON.stringify(live?.threadId) + ' EXPECTED ' + threadId)

  const stopped = (await window.evaluate(async () =>
    (window as unknown as { flow: Record<string, any> }).flow.debug.stop({}),
  )) as { projectRoot: string | null } | null

  // THE THREAD IS WHAT THE SESSION IS FOR. Without it the session recorded no
  // terminals and its record had nowhere of its own to go.
  expect(live?.threadId, 'the session did not know which thread it belonged to').toBe(threadId)
  // …and the record lands in THAT thread's project, not wherever the app is
  // pointing — the two differ here because the harness has a project of its own.
  // Compared RESOLVED: on macOS /var is a symlink to /private/var, so the seed's
  // path and the one main reports are the same directory spelled two ways.
  expect(
    realpathSync(stopped?.projectRoot as string),
    'the record went to the wrong project',
  ).toBe(realpathSync(root))
})
