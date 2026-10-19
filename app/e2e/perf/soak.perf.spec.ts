/**
 * Does the app get slower the longer it is used?
 *
 * "our ide is still slow recently" and "every single action slow" are reports
 * about a session that has been open for a while, not about a fresh launch —
 * and every probe here so far measures a fresh launch. So this one uses the app
 * the way a day does: switch threads, flip panels, open the board, again and
 * again, and watch what grows.
 *
 * Three things are watched, because a leak shows in a different one each time:
 * the renderer's heap, the DOM it holds, and the main process's heap. A number
 * that climbs and never comes back down is the finding.
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

/** How many times round the loop. Enough for a trend, short enough to run. */
const ROUNDS = 40

interface Sample {
  round: number
  heapMb: number
  domNodes: number
  listeners: number
  mainHeapMb: number
  switchMs: number
}

test('forty rounds of ordinary use', async () => {
  test.setTimeout(1_800_000)
  const repo = ensurePerfRepo()
  const userData = freshUserData('soak')
  const titles = ['Alpha thread', 'Beta thread', 'Gamma thread']

  {
    const first = await launch(userData)
    await dismissOnboarding(first.window)
    const ids = await first.window.evaluate(
      async ({ path, names }: { path: string; names: string[] }) => {
        const flow = (window as unknown as { flow: Record<string, any> }).flow
        await flow.project.add({ path })
        const roots = (await flow.project.list()) as Array<{ rootPath: string }>
        const canonical = roots.at(-1)?.rootPath ?? path
        await flow.project.setActive({ rootPath: canonical })
        const made: string[] = []
        for (const name of names) {
          const thread = await flow.threads.create({ projectRoot: canonical, title: name })
          for (let i = 0; i < 200; i += 1) {
            await flow.messages.append({
              threadId: thread.id,
              role: i % 2 === 0 ? 'user' : 'assistant',
              content: `${name} turn ${String(i)} ${'lorem ipsum '.repeat(20)}`,
            })
          }
          made.push(thread.id)
        }
        return made
      },
      { path: repo, names: titles },
    )
    await first.window.waitForTimeout(15_000)
    await close(first.app)
    for (const id of ids) seedHeavyThread(userData, id, 300)
  }

  const { app, window } = await launch(userData)
  await dismissOnboarding(window)
  await window.waitForTimeout(5_000)

  const samples: Sample[] = []
  for (let round = 0; round < ROUNDS; round += 1) {
    const title = titles[round % titles.length] ?? titles[0] ?? ''
    const switchedAt = Date.now()
    await window
      .locator('.fl-thread-sidebar .row', { hasText: title })
      .first()
      .click({ timeout: 60_000 })
    await window.locator('.fl-composer-input textarea').first().waitFor({ state: 'visible' })
    const switchMs = Date.now() - switchedAt

    // …and the panels a person flips through while they work.
    for (const rail of ['source-control', 'files', 'threads']) {
      const item = window.locator(`[data-rail-item="${rail}"]`)
      if ((await item.count()) > 0) await item.first().click().catch(() => undefined)
    }
    await window.waitForTimeout(150)

    if (round % 4 === 0 || round === ROUNDS - 1) {
      const rendererSample = await window.evaluate(() => {
        const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        return {
          heapMb: Math.round(((memory?.usedJSHeapSize ?? 0) / 1024 / 1024) * 10) / 10,
          domNodes: document.querySelectorAll('*').length,
          // Not a leak detector by itself, but a listener count that only ever
          // grows names the surface that forgot to unsubscribe.
          listeners: (window as unknown as { __flowListenerCount?: number }).__flowListenerCount ?? 0,
        }
      })
      const mainHeap = await app.evaluate(async () =>
        Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10,
      )
      samples.push({ round, switchMs, mainHeapMb: mainHeap, ...rendererSample })
    }
  }

  console.log('\n── forty rounds of switching threads and panels ─────────────')
  console.log('round   switch    renderer heap    DOM nodes    main heap')
  for (const sample of samples) {
    console.log(
      `${String(sample.round).padStart(5)}  ${`${String(sample.switchMs)}ms`.padStart(7)}  ` +
        `${`${sample.heapMb.toFixed(1)} MB`.padStart(14)}  ${String(sample.domNodes).padStart(10)}  ` +
        `${`${sample.mainHeapMb.toFixed(1)} MB`.padStart(10)}`,
    )
  }
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (first && last) {
    printTable('growth across the session', {
      'renderer heap': `${first.heapMb.toFixed(1)} → ${last.heapMb.toFixed(1)} MB`,
      'DOM nodes': `${String(first.domNodes)} → ${String(last.domNodes)}`,
      'main heap': `${first.mainHeapMb.toFixed(1)} → ${last.mainHeapMb.toFixed(1)} MB`,
      'thread switch': `${String(first.switchMs)} → ${String(last.switchMs)} ms`,
    })
  }
  for (const line of slowLines(userData).filter((l) => l.includes('blocked')).slice(-8)) {
    console.log(`  ${line}`)
  }

  await close(app)
  expect(samples.length).toBeGreaterThan(2)
})
