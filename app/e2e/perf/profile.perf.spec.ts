/**
 * What the main process is actually doing — from V8, not from a hypothesis.
 *
 * The stall log says `[main] blocked for 1,132ms` and the channel in flight at
 * the time (blueprint:read) turns out to be innocent: its own stages, now
 * instrumented, add up to under twenty milliseconds. So main is busy with
 * something that never crosses IPC, and no amount of handler timing will name
 * it. This takes a real CPU profile across the busiest stretch there is —
 * adding a project, which provisions, derives, bootstraps features and starts
 * every watcher — and prints the frames with the most self time.
 */
import { test, expect } from '@playwright/test'

import { resolve } from 'node:path'

import { close, dismissOnboarding, ensurePerfRepo, freshUserData, launch } from './launch'
import { MainProfiler, hotFrames, profileCpuMs } from './profiler'

const INSPECT_PORT = 9333

test('a CPU profile of main while a project is added', async () => {
  test.setTimeout(900_000)
  // FLOW_PROFILE_ROOT points this at a specific project — the interesting case
  // is rarely the tidy clone. `self` means this repository, whose derived
  // structure layer and 453 MB of git history are what the reporter actually
  // works in.
  const target = process.env['FLOW_PROFILE_ROOT'] ?? ''
  const repo =
    target === 'self' ? resolve(__dirname, '../../..') : target === '' ? ensurePerfRepo() : target
  const userData = freshUserData('profile')
  const { app, window } = await launch(userData, INSPECT_PORT)
  await dismissOnboarding(window)

  const profiler = new MainProfiler(INSPECT_PORT)
  await profiler.connect()
  await profiler.start()

  await window.evaluate(async (path) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    await flow.project.add({ path })
    const roots = (await flow.project.list()) as Array<{ rootPath: string }>
    await flow.project.setActive({ rootPath: roots.at(-1)?.rootPath ?? path })
  }, repo)
  await window.waitForTimeout(60_000)

  const profile = await profiler.stop()
  profiler.close()

  const wallMs = (profile.endTime - profile.startTime) / 1000
  const cpuMs = profileCpuMs(profile)
  console.log('\n── main-process CPU while adding a project ─────────────────')
  console.log(
    `${wallMs.toFixed(0)}ms wall, ${cpuMs.toFixed(0)}ms sampled — ` +
      `${((cpuMs / wallMs) * 100).toFixed(1)}% of one core\n`,
  )
  for (const frame of hotFrames(profile, 30)) {
    if (frame.ms < 5) continue
    console.log(`${`${frame.ms.toFixed(0)}ms`.padStart(8)}  ${frame.name.slice(0, 38).padEnd(38)} ${frame.place}`)
  }
  console.log('')

  await close(app)
  expect(profile.nodes.length).toBeGreaterThan(0)
})
