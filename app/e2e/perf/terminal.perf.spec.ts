/**
 * A terminal under a flood — an agent running a test suite, a build, a log tail.
 *
 * Every pty chunk is broadcast to the renderer as it arrives. node-pty emits
 * small chunks fast, so a command that prints tens of thousands of lines is a
 * question about IPC volume, main-process CPU, and whether the window still
 * answers a keystroke while it happens.
 */
import { test, expect } from '@playwright/test'

import {
  close,
  dismissOnboarding,
  ensurePerfRepo,
  freshUserData,
  launch,
  printTable,
  slowLines,
} from './launch'

/** Lines of output. A `npm test` on a real repo is this order of magnitude. */
const LINES = 40_000

test('typing while a terminal floods', async () => {
  test.setTimeout(900_000)
  const repo = ensurePerfRepo()
  const userData = freshUserData('terminal')
  const { app, window } = await launch(userData)
  await dismissOnboarding(window)

  const title = 'Terminal thread'
  await window.evaluate(
    async ({ path, name }: { path: string; name: string }) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      await flow.project.add({ path })
      const roots = (await flow.project.list()) as Array<{ rootPath: string }>
      const canonical = roots.at(-1)?.rootPath ?? path
      await flow.project.setActive({ rootPath: canonical })
      await flow.threads.create({ projectRoot: canonical, title: name })
    },
    { path: repo, name: title },
  )
  await window
    .locator('.fl-thread-sidebar .row', { hasText: title })
    .first()
    .click({ timeout: 120_000 })
  const composer = window.locator('.fl-composer-input textarea').first()
  await composer.waitFor({ state: 'visible', timeout: 120_000 })
  await window.waitForTimeout(15_000)

  const marks: Record<string, number | string> = {}
  await composer.click()
  const quietAt = Date.now()
  await composer.press('q')
  await expect(composer).toHaveValue(/q/, { timeout: 20_000 })
  marks['keystroke, terminal quiet'] = Date.now() - quietAt

  // THE FLOOD. Created and written through the app's own terminal channels, so
  // the data takes the same path an agent's `npm test` would.
  const cpuBefore = await app.evaluate(async () => process.cpuUsage())
  const floodStarted = Date.now()
  const chunks = await window.evaluate(async (lines: number) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const roots = (await flow.project.list()) as Array<{ rootPath: string }>
    const rootPath = roots[0]?.rootPath ?? ''
    // cols/rows are required — a terminal with no size is a terminal that
    // never draws, which is how a first run of this probe measured zero.
    const info = (await flow.terminal.create({ rootId: rootPath, cols: 120, rows: 40 })) as {
      terminalId: string
    }
    if (typeof info?.terminalId !== 'string') throw new Error('terminal:create returned no id')
    let received = 0
    let bytes = 0
    const off = flow.terminal.onData((event: { terminalId: string; data: string }) => {
      if (event.terminalId !== info.terminalId) return
      received += 1
      bytes += event.data.length
    })
    await flow.terminal.write({
      terminalId: info.terminalId,
      data: `seq 1 ${String(lines)} | sed 's/^/line /'\n`,
    })
    // Let it run, then stop listening.
    await new Promise((resolve) => setTimeout(resolve, 12_000))
    off?.()
    return { received, bytes }
  }, LINES)
  marks['flood wall time'] = Date.now() - floodStarted
  marks['terminal:data events'] = chunks.received
  marks['bytes delivered'] = `${(chunks.bytes / 1024 / 1024).toFixed(2)} MB`

  // …and a keystroke made in the middle of the noise.
  const floodAt = Date.now()
  await composer.press('x')
  await expect(composer).toHaveValue(/x/, { timeout: 60_000 })
  marks['keystroke, mid-flood'] = Date.now() - floodAt

  const cpuAfter = await app.evaluate(async () => process.cpuUsage())
  marks['main CPU for the flood'] = Math.round(
    (cpuAfter.user - cpuBefore.user + (cpuAfter.system - cpuBefore.system)) / 1000,
  )

  await window.waitForTimeout(1_500)
  printTable('a flooding terminal', marks)
  for (const line of slowLines(userData).slice(-10)) console.log(`  ${line}`)

  await close(app)
  expect(chunks.received).toBeGreaterThan(0)
})
