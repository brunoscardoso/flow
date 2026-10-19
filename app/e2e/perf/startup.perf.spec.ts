/**
 * How long the app takes to become usable — the complaint, measured.
 *
 * Reported like this: *"i click on the input when the app open, slow cursor
 * loading, every single action slow"*. That is three numbers wearing one
 * sentence, and the app produced none of them until now:
 *
 *   1. process launch → a window handed over (main's half)
 *   2. renderer script → shell mounted → first paint (the renderer's half)
 *   3. first press → the character on screen (what "usable" means)
 *
 * The second test is the one that matters: a RETURNING user, whose profile
 * already holds the project, opening the app the way they open it every
 * morning. A fresh profile with no project measures a state nobody is in twice.
 *
 * Run after a build:  npx playwright test e2e/perf/ --reporter=list
 * It asserts only that the app came up — it exists to produce numbers.
 */
import { test, expect } from '@playwright/test'

import {
  close,
  dismissOnboarding,
  ensurePerfRepo,
  freshUserData,
  launch,
  printTable,
  seedHeavyThread,
  slowLines,
  startupMarks,
} from './launch'

test('cold start: a profile that has never seen a project', async () => {
  test.setTimeout(180_000)
  const userData = freshUserData('cold')
  const { app, window, launchMs } = await launch(userData)
  const nav = await window.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0] as
      | { responseEnd: number; domContentLoadedEventEnd: number; loadEventEnd: number }
      | undefined
    return {
      html: entry?.responseEnd ?? 0,
      dom: entry?.domContentLoadedEventEnd ?? 0,
      load: entry?.loadEventEnd ?? 0,
    }
  })
  await window.locator('#app > *').first().waitFor({ timeout: 60_000 })
  const shellUp = await window.evaluate(() => performance.now())

  printTable('cold start (no project)', {
    'launch → window': launchMs,
    'html delivered': nav.html,
    'DOM ready': nav.dom,
    'load complete': nav.load,
    'shell on screen': shellUp,
  })
  await window.waitForTimeout(1_500)
  for (const mark of startupMarks(userData)) console.log(`  ${mark}`)
  await close(app)
  expect(launchMs).toBeGreaterThan(0)
})

test('warm start: the app a returning user opens, with a real project in it', async () => {
  test.setTimeout(600_000)
  const repo = ensurePerfRepo()
  const userData = freshUserData('warm')

  // FIRST RUN — adds the project and leaves a long thread open, which is the
  // state a returning user's profile is actually in. Provisioning, the first
  // derive and the feature bootstrap all happen here; none of it is timed.
  {
    const first = await launch(userData)
    await dismissOnboarding(first.window)
    const threadId = await first.window.evaluate(async (path) => {
      const flow = (
        window as unknown as {
          flow: {
            project: {
              add(r: { path: string }): Promise<unknown>
              list(): Promise<unknown>
              setActive(r: { rootPath: string }): Promise<unknown>
            }
            threads: {
              create(r: { projectRoot: string; title: string }): Promise<{ id: string }>
            }
            messages: { append(r: { threadId: string; role: string; content: string }): Promise<unknown> }
          }
        }
      ).flow
      await flow.project.add({ path })
      // macOS hands out /var/folders and the app may keep /private/var/folders;
      // ask which one it stored, or the thread lands under a root no surface
      // knows about.
      const roots = (await flow.project.list()) as Array<{ rootPath: string }>
      const canonical = roots.at(-1)?.rootPath ?? path
      await flow.project.setActive({ rootPath: canonical })
      const thread = await flow.threads.create({
        projectRoot: canonical,
        title: 'A long working day',
      })
      for (let i = 0; i < 400; i += 1) {
        await flow.messages.append({
          threadId: thread.id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `turn ${String(i)} — ${'lorem ipsum '.repeat(20)}`,
        })
      }
      return thread.id
    }, repo)
    await first.window.waitForTimeout(20_000)
    await close(first.app)
    // With the app closed — one writer at a time on a SQLite file.
    seedHeavyThread(userData, threadId, 600)
  }

  // THE MEASURED RUN. Same profile, same project, cold process.
  const launchStartedAt = Date.now()
  const { app, window, launchMs } = await launch(userData)
  const marks: Record<string, number | string> = { 'launch → window': launchMs }

  await dismissOnboarding(window)
  // Open the long thread — the click a person makes first thing in the morning.
  // By its TITLE: row 0 is the project header, and the sidebar's rows live in
  // an open shadow root, so this must be a locator rather than a DOM query.
  const openStarted = Date.now()
  await window
    .locator('.fl-thread-sidebar .row', { hasText: 'A long working day' })
    .first()
    .click({ timeout: 120_000 })
  const composer = window.locator('.fl-composer-input textarea').first()
  await composer.waitFor({ state: 'visible', timeout: 120_000 })
  marks['open a 600-call thread'] = Date.now() - openStarted
  marks['launch → typing possible'] = Date.now() - launchStartedAt

  // THE FIRST PRESS — not "is it in the DOM", but whether a keystroke reaches
  // the screen. That is the thing reported as broken.
  const pressStarted = Date.now()
  await composer.click()
  await composer.press('h')
  await expect(composer).toHaveValue(/h/, { timeout: 30_000 })
  marks['first keystroke → on screen'] = Date.now() - pressStarted

  // The renderer hands its observations over a second at a time; read after.
  await window.waitForTimeout(1_500)
  printTable('warm start (4,182-file project)', marks)
  for (const line of slowLines(userData)) console.log(`  ${line}`)
  await close(app)
  expect(launchMs).toBeGreaterThan(0)
})
