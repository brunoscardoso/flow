/**
 * Typing while the agent works.
 *
 * This is how the app is USED — a turn running, tool calls landing every few
 * hundred milliseconds, and a person still reading, scrolling and typing. It is
 * also when it was reported as unusable. The store broadcasts a batch every
 * 50ms during a turn, and this repo has fixed the same bug four times: a hot
 * broadcast answered with a full refresh (forbidden-pattern #14).
 *
 * A real turn needs a model, so the traffic is simulated at the layer that
 * matters — writes into the store, which produce exactly the same broadcasts —
 * and what is measured is what a person feels: a keystroke, during the storm.
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
} from './launch'

/** Writes per burst — a busy agent turn's worth of traffic. */
const WRITES = 400

test('a keystroke lands while a turn is streaming', async () => {
  test.setTimeout(900_000)
  const repo = ensurePerfRepo()
  const userData = freshUserData('stream')
  const title = 'Streaming into this one'

  {
    const first = await launch(userData)
    await dismissOnboarding(first.window)
    const threadId = await first.window.evaluate(
      async ({ path, name }: { path: string; name: string }) => {
        const flow = (window as unknown as { flow: Record<string, any> }).flow
        await flow.project.add({ path })
        const roots = (await flow.project.list()) as Array<{ rootPath: string }>
        const canonical = roots.at(-1)?.rootPath ?? path
        await flow.project.setActive({ rootPath: canonical })
        const thread = await flow.threads.create({ projectRoot: canonical, title: name })
        for (let i = 0; i < 300; i += 1) {
          await flow.messages.append({
            threadId: thread.id,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `history ${String(i)} ${'lorem '.repeat(30)}`,
          })
        }
        return thread.id
      },
      { path: repo, name: title },
    )
    await first.window.waitForTimeout(15_000)
    await close(first.app)
    seedHeavyThread(userData, threadId, 600)
  }

  const { app, window } = await launch(userData)
  await dismissOnboarding(window)
  await window
    .locator('.fl-thread-sidebar .row', { hasText: title })
    .first()
    .click({ timeout: 120_000 })
  const composer = window.locator('.fl-composer-input textarea').first()
  await composer.waitFor({ state: 'visible', timeout: 120_000 })
  await window.waitForTimeout(3_000)

  const marks: Record<string, number | string> = {}

  // QUIET BASELINE — the same press, with nothing else happening.
  await composer.click()
  const quietAt = Date.now()
  await composer.press('q')
  await expect(composer).toHaveValue(/q/, { timeout: 20_000 })
  marks['keystroke, app quiet'] = Date.now() - quietAt

  // THE STORM. Writes land as fast as the store accepts them; the broadcasts
  // they produce are the same ones a live turn makes.
  const cpuBefore = await app.evaluate(async () => process.cpuUsage())
  const storm = window.evaluate(
    async ({ name, writes }: { name: string; writes: number }) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const threads = (await flow.threads.list({ includeArchived: true })) as Array<{
        id: string
        title: string
      }>
      const target = threads.find((t) => t.title === name)
      if (!target) throw new Error('thread missing')
      const started = performance.now()
      for (let i = 0; i < writes; i += 1) {
        await flow.messages.append({
          threadId: target.id,
          role: 'assistant',
          content: `streamed chunk ${String(i)} ${'token '.repeat(20)}`,
        })
      }
      return performance.now() - started
    },
    { name: title, writes: WRITES },
  )

  // …and the press, made in the middle of it.
  await window.waitForTimeout(400)
  const stormAt = Date.now()
  await composer.press('x')
  await expect(composer).toHaveValue(/x/, { timeout: 30_000 })
  marks['keystroke, mid-stream'] = Date.now() - stormAt

  const stormMs = await storm
  const cpuAfter = await app.evaluate(async () => process.cpuUsage())
  marks[`${String(WRITES)} writes`] = stormMs
  marks['per write'] = Math.round((stormMs / WRITES) * 100) / 100
  marks['main CPU during storm'] = Math.round(
    (cpuAfter.user - cpuBefore.user + (cpuAfter.system - cpuBefore.system)) / 1000,
  )

  await window.waitForTimeout(2_000)
  printTable('typing while a turn streams', marks)
  const lines = slowLines(userData)
  for (const line of lines
    .filter((l) => l.includes('blocked') || l.includes('IPC calls'))
    .slice(-8)) {
    console.log(`  ${line}`)
  }
  console.log('')

  await close(app)
  expect(marks['keystroke, mid-stream']).toBeGreaterThan(0)
})
