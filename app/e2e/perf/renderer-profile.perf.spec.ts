/**
 * The renderer's own CPU, while it does the two things a person waits on:
 * starting up, and opening a heavy thread.
 *
 * Main has been profiled and fixed; the renderer never has. Everything it does
 * is on one thread — the same one that has to answer a keystroke — so a slow
 * render and a slow click are the same problem seen from two ends.
 */
import { test, expect } from '@playwright/test'

import {
  close,
  dismissOnboarding,
  ensurePerfRepo,
  freshUserData,
  launch,
  seedHeavyThread,
} from './launch'
import { hotFrames, profileCpuMs, type CpuProfile } from './profiler'

test('a CPU profile of the renderer opening a heavy thread', async () => {
  test.setTimeout(900_000)
  const repo = ensurePerfRepo()
  const userData = freshUserData('rprofile')
  const title = 'The heavy one'

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
        for (let i = 0; i < 600; i += 1) {
          await flow.messages.append({
            threadId: thread.id,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `turn ${String(i)} — ${'lorem ipsum dolor '.repeat(25)}`,
          })
        }
        return thread.id
      },
      { path: repo, name: title },
    )
    await first.window.waitForTimeout(15_000)
    await close(first.app)
    seedHeavyThread(userData, threadId, 900)
  }

  const { app, window } = await launch(userData)
  await dismissOnboarding(window)
  const session = await app.context().newCDPSession(window)
  await session.send('Profiler.enable')
  await session.send('Profiler.setSamplingInterval', { interval: 200 })
  await session.send('Profiler.start')

  await window
    .locator('.fl-thread-sidebar .row', { hasText: title })
    .first()
    .click({ timeout: 120_000 })
  await window.locator('.fl-composer-input textarea').first().waitFor({ state: 'visible' })
  await window.waitForTimeout(3_000)
  // …and some scrolling, which is the other thing hands do in a transcript.
  await window.mouse.move(700, 400)
  for (let i = 0; i < 30; i += 1) await window.mouse.wheel(0, -500)
  await window.waitForTimeout(1_000)

  const { profile } = (await session.send('Profiler.stop')) as { profile: CpuProfile }
  const wallMs = (profile.endTime - profile.startTime) / 1000
  const cpuMs = profileCpuMs(profile)
  console.log('\n── renderer CPU: opening a 900-call thread and scrolling it ──')
  console.log(`${wallMs.toFixed(0)}ms wall, ${cpuMs.toFixed(0)}ms sampled\n`)
  for (const frame of hotFrames(profile, 28)) {
    if (frame.ms < 4) continue
    console.log(
      `${`${frame.ms.toFixed(0)}ms`.padStart(8)}  ${frame.name.slice(0, 36).padEnd(36)} ${frame.place}`,
    )
  }
  console.log('')

  await close(app)
  expect(profile.nodes.length).toBeGreaterThan(0)
})
