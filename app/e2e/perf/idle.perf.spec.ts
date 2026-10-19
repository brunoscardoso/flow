/**
 * What the app costs when nobody is touching it.
 *
 * An app that burns CPU while idle has nothing left for the click that comes
 * next — which is what "every single action slow" feels like from the outside.
 * This sits still for a minute with a real project open and reports what each
 * process did anyway: CPU, IPC traffic, and whatever the app itself recorded.
 *
 * The measurement to beat is boring: near-zero CPU, a handful of calls.
 */
import { test, expect } from '@playwright/test'

import {
  close,
  dismissOnboarding,
  ensurePerfRepo,
  ensurePerfRepos,
  freshUserData,
  launch,
  slowLines,
} from './launch'

interface Metric {
  type: string
  pid: number
  cpu: { percentCPUUsage: number }
  memory?: { workingSetSize?: number }
}

/** Seconds of sitting still. Long enough for a poll to show up more than once. */
const IDLE_MS = 60_000

test('the cost of an idle window', async () => {
  test.setTimeout(600_000)
  const repo = ensurePerfRepo()
  const userData = freshUserData('idle')
  const { app, window } = await launch(userData)
  await dismissOnboarding(window)

  await window.evaluate(async (path) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    await flow.project.add({ path })
    const roots = (await flow.project.list()) as Array<{ rootPath: string }>
    await flow.project.setActive({ rootPath: roots.at(-1)?.rootPath ?? path })
  }, repo)

  // Let the one-off work finish: provisioning, first derive, feature bootstrap.
  await window.waitForTimeout(45_000)

  const before = await app.evaluate(async ({ app: electronApp }) => ({
    cpu: process.cpuUsage(),
    metrics: electronApp.getAppMetrics(),
  }))
  const startedAt = Date.now()
  await window.waitForTimeout(IDLE_MS)
  const after = await app.evaluate(async ({ app: electronApp }) => ({
    cpu: process.cpuUsage(),
    metrics: electronApp.getAppMetrics(),
  }))
  const elapsed = Date.now() - startedAt

  const mainCpuMs = Math.round(
    (after.cpu.user - before.cpu.user + (after.cpu.system - before.cpu.system)) / 1000,
  )
  const byType = new Map<string, number>()
  for (const metric of after.metrics as Metric[]) {
    byType.set(metric.type, (byType.get(metric.type) ?? 0) + metric.cpu.percentCPUUsage)
  }

  console.log(`\n── ${String(Math.round(elapsed / 1000))}s of doing nothing ────────────────────`)
  console.log(`main process CPU              ${String(mainCpuMs)}ms  (${(
    (mainCpuMs / elapsed) *
    100
  ).toFixed(1)}% of one core)`)
  for (const [type, percent] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`${type.padEnd(30)}${percent.toFixed(1)}% CPU (instantaneous)`)
  }
  const lines = slowLines(userData)
  const chatty = lines.filter((line) => line.includes('IPC calls in'))
  console.log('\nIPC traffic while idle:')
  for (const line of chatty.slice(-4)) console.log(`  ${line}`)
  const stalls = lines.filter((line) => line.includes('blocked for'))
  console.log(`\nstalls recorded while idle: ${String(stalls.length)}`)
  for (const line of stalls.slice(-6)) console.log(`  ${line}`)
  console.log('')

  await close(app)
  expect(mainCpuMs).toBeGreaterThanOrEqual(0)
})

/**
 * The same nothing, times five.
 *
 * A profile with several projects open is the one the stall reports came from:
 * every watcher, every git process, every provisioning pass multiplied by the
 * number of things somebody is working on at once. If idle cost scales with
 * project count, a person with six repos pays six times for sitting still.
 */
test('the cost of five idle projects', async () => {
  test.setTimeout(900_000)
  const repos = ensurePerfRepos(5)
  const userData = freshUserData('idle-many')
  const { app, window } = await launch(userData)
  await dismissOnboarding(window)

  await window.evaluate(async (paths: string[]) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    for (const path of paths) await flow.project.add({ path })
    const roots = (await flow.project.list()) as Array<{ rootPath: string }>
    await flow.project.setActive({ rootPath: roots[0]?.rootPath ?? paths[0] })
  }, repos)

  // Five projects to provision, derive and bootstrap — none of it is the point.
  await window.waitForTimeout(90_000)

  const before = await app.evaluate(async () => process.cpuUsage())
  const startedAt = Date.now()
  await window.waitForTimeout(IDLE_MS)
  const after = await app.evaluate(async () => process.cpuUsage())
  const elapsed = Date.now() - startedAt
  const mainCpuMs = Math.round(
    (after.user - before.user + (after.system - before.system)) / 1000,
  )

  console.log(`\n── ${String(Math.round(elapsed / 1000))}s of doing nothing, 5 projects ──────`)
  console.log(
    `main process CPU              ${String(mainCpuMs)}ms  (${((mainCpuMs / elapsed) * 100).toFixed(1)}% of one core)`,
  )
  const lines = slowLines(userData)
  const stalls = lines.filter((line) => line.includes('blocked for'))
  console.log(`stalls recorded: ${String(stalls.length)}`)
  for (const line of stalls.slice(-8)) console.log(`  ${line}`)
  for (const line of lines.filter((l) => l.includes('IPC calls in')).slice(-3)) {
    console.log(`  ${line}`)
  }
  console.log('')

  await close(app)
  expect(mainCpuMs).toBeGreaterThanOrEqual(0)
})
