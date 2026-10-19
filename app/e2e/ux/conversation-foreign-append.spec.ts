import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject, openThreadByTitle } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

test.afterAll(() => cleanupSeeds())

/**
 * A MESSAGE WRITTEN BY MAIN MUST APPEAR WITHOUT RE-OPENING THE THREAD.
 *
 * The conversation's transcript is loaded when a thread is opened and extended
 * by the live stream. Main appends system rows the pane knows nothing about — a
 * worktree's dependency note, a debug session's summary — and `threads:updated`
 * carries them as `entity: 'message'`, which nothing in the pane was listening
 * for. The row landed in the store and stayed invisible until the thread was
 * re-opened.
 *
 * That is how the debug session came to look completely dead: the agent had the
 * summary in its context and the person could not see it (user, 2026-09-21:
 * "seems that the agent had access to something, but im not seeing nothing
 * related to that md file, or any context information attached").
 *
 * Driven through a real selection and a real session, because the bug lives
 * exactly in the gap between "the row exists" and "somebody can see it".
 */
test('a summary appended by main appears without re-opening the thread', async ({ window }) => {
  test.setTimeout(300_000)
  const root = await seedProject(window, 'flow-pane-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir })
  })
  await activateProject(window, root)

  const threadId = await window.evaluate(async (projectRoot: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const t = await flow.threads.create({ projectRoot, title: 'Pane probe' })
    // Give it a message so the pane has something to draw at all.
    await flow.messages.append({ threadId: t.id, role: 'user', content: 'hello there' })
    return t.id
  }, root)

  // A real press on the row's title (the row no longer carries a titled
  // span), waiting until that row is the CURRENT one and its composer is up.
  await openThreadByTitle(window, 'Pane probe')

  // The positive first: the thread IS open and drawn.
  await expect(window.locator('.fl-conversation')).toContainText('hello there')
  expect(await window.locator('.fl-conv-system').count()).toBe(0)

  // A MAIN-SIDE APPEND, with nothing streaming — a debug session's summary.
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:debug-toggle')))
  await window.waitForTimeout(1200)
  // STOPPED THE WAY THE BUTTON STOPS IT.
  //
  // Calling `flow.debug.stop()` directly skips the runner — which is the layer
  // that opens the file and attaches the chip — so a test that did that was
  // asserting against a path the app never takes, and reported the feature
  // broken when it was the test that was.
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:debug-toggle')))
  await window.waitForTimeout(2500)

  // A CONTEXT CHIP above the composer — not a wall of text in the transcript.
  const chip = window.locator('.fl-composer-chips', { hasText: 'Debug session' }).first()
  await expect(chip).toBeVisible({ timeout: 30_000 })

  // …and the record itself is OPEN, because a file nobody can reach is not a
  // record.
  // …and the record itself OPENS, because a file nobody can reach is not a
  // record. The editor is revealed first — opening into a hidden surface is
  // indistinguishable from not opening at all.
  // THE RECORD ITSELF — asserted from a second session stopped through the
  // IPC, because the button's path consumes its own result and the seeded
  // project is deleted when the run ends. Same writer either way.
  const second = (await window.evaluate(async () => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    await flow.debug.start({ threadId: null })
    return flow.debug.stop({})
  })) as { timelinePath: string | null; artifactDir: string | null } | null

  expect(second?.timelinePath, 'no record was written').toBeTruthy()
  // In a folder a person can SEE — not Application Support, where the first
  // version put it and where nothing could open it, and not a dot-directory,
  // which the file-ref resolution and the explorer both skip.
  expect(second?.timelinePath?.startsWith(join('flow', 'debug-sessions'))).toBe(true)
  // Resolved against the root the RESULT names — the project the session
  // belongs to, which is the thread's own and not whatever the app is pointing
  // at. Those differ here precisely because the harness has a project of its
  // own, which is how the distinction got noticed.
  const artifactRoot = second?.projectRoot as string
  expect(existsSync(join(artifactRoot, second!.timelinePath as string))).toBe(true)
  // …and it stays out of `git status` without touching the project's own file.
  expect(readFileSync(join(artifactRoot, 'flow', 'debug-sessions', '.gitignore'), 'utf8')).toContain(
    '*',
  )

  // NOT ASSERTED HERE: that the file OPENS in the editor. The runner dispatches
  // `flow:show-editor` then `flow:open-file-path` (reveal-first, per #1057), but
  // Monaco never mounts under this harness — a control opening README.md leaves
  // `.monaco-editor` at zero too — so an assertion would be testing the harness,
  // not the feature.

  // Nothing was dumped into the conversation.
  expect(await window.locator('.fl-conv-system', { hasText: 'Debug session' }).count()).toBe(0)
  expect(threadId).toBeTruthy()
})
