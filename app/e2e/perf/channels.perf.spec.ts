/**
 * Every loader, timed on the real path.
 *
 * The jest probes measure functions; this measures CHANNELS — the round trip a
 * surface actually waits on, in the real main process, against a real 4,182-file
 * repo. It is the map: which of the ~170 things the renderer can ask for are
 * worth optimizing, and which were never the problem.
 *
 * Each channel is called five times and the MEDIAN is reported, plus the first
 * call separately — a cold answer and a warm one are different products, and
 * the first is what a person gets when they open the app.
 */
import { test, expect } from '@playwright/test'

import { close, dismissOnboarding, ensurePerfRepo, freshUserData, launch, slowLines } from './launch'

interface ChannelResult {
  channel: string
  coldMs: number
  medianMs: number
  bytes: number
  note?: string
}

test('the cost of every loader a surface waits on', async () => {
  test.setTimeout(600_000)
  const repo = ensurePerfRepo()
  const userData = freshUserData('channels')
  const { app, window } = await launch(userData)
  await dismissOnboarding(window)

  const root = await window.evaluate(async (path) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    await flow.project.add({ path })
    const roots = (await flow.project.list()) as Array<{ rootPath: string }>
    const canonical = roots.at(-1)?.rootPath ?? path
    await flow.project.setActive({ rootPath: canonical })
    return canonical
  }, repo)

  // Let provisioning and the first derive finish — we are timing steady state,
  // not the one-off scaffolding a project gets on the day it is added.
  await window.waitForTimeout(30_000)

  const results = await window.evaluate(async (rootPath: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const out: Array<{ channel: string; coldMs: number; medianMs: number; bytes: number }> = []

    async function time(
      channel: string,
      call: () => Promise<unknown>,
      runs = 5,
    ): Promise<void> {
      const timings: number[] = []
      let last: unknown
      for (let i = 0; i < runs; i += 1) {
        const started = performance.now()
        try {
          last = await call()
        } catch (error) {
          last = { failed: String(error).slice(0, 80) }
        }
        timings.push(performance.now() - started)
      }
      const sorted = [...timings].sort((a, b) => a - b)
      out.push({
        channel,
        coldMs: Math.round((timings[0] ?? 0) * 100) / 100,
        medianMs: Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 100) / 100,
        bytes: new TextEncoder().encode(JSON.stringify(last ?? null)).length,
      })
    }

    await time('git:status', () => flow.git.status({ rootId: rootPath }))
    await time('git:mergeState', () => flow.git.mergeState({ rootId: rootPath }))
    await time('git:log', () => flow.git.log({ rootId: rootPath, limit: 100 }))
    await time('review:list', () => flow.review.list({ rootPath }))
    await time('blueprint:read', () => flow.blueprint.read({ rootPath }))
    await time('threads:list', () => flow.threads.list({ includeArchived: true }))
    await time('tasks:list', () => flow.tasks.list({ projectRoot: rootPath }))
    // THE STARTUP BURST, on purpose: three surfaces asking at once. One scan
    // or three is the difference between a coalesced read and a stampede.
    await time('3× git:status at once', () =>
      Promise.all([
        flow.git.status({ rootId: rootPath }),
        flow.git.status({ rootId: rootPath }),
        flow.git.status({ rootId: rootPath }),
      ]),
    )
    await time('status + review together', () =>
      Promise.all([flow.git.status({ rootId: rootPath }), flow.review.list({ rootPath })]),
    )
    await time('project:list', () => flow.project.list())
    await time('project:listAllFiles', () => flow.project.listAllFiles({ rootPath }))
    await time('project:listFiles', () => flow.project.listFiles({ rootPath }))
    await time('learn:status', () => flow.learn?.status?.({ rootPath }) ?? Promise.resolve(null))
    await time('learn:log', () => flow.learn?.log?.({ rootPath }) ?? Promise.resolve(null))
    await time('loops:status', () => flow.loops?.status?.({ rootPath }) ?? Promise.resolve(null))
    await time('settings:get', () => flow.settings?.get?.() ?? Promise.resolve(null))
    await time('accounts:status', () => flow.accounts?.status?.() ?? Promise.resolve(null))
    return out
  }, root)

  const rows = results as ChannelResult[]
  rows.sort((a, b) => b.coldMs - a.coldMs)
  const width = Math.max(...rows.map((r) => r.channel.length))
  console.log('\n── every loader, on a 4,182-file project ────────────────────')
  console.log(`${'channel'.padEnd(width)}  ${'cold'.padStart(9)}  ${'median'.padStart(9)}   payload`)
  for (const row of rows) {
    const kb = row.bytes < 1024 ? `${String(row.bytes)} B` : `${(row.bytes / 1024).toFixed(1)} KB`
    console.log(
      `${row.channel.padEnd(width)}  ${`${row.coldMs.toFixed(1)}ms`.padStart(9)}  ` +
        `${`${row.medianMs.toFixed(1)}ms`.padStart(9)}   ${kb}`,
    )
  }
  console.log('')
  for (const line of slowLines(userData).slice(-25)) console.log(`  ${line}`)

  await close(app)
  expect(rows.length).toBeGreaterThan(0)
})
