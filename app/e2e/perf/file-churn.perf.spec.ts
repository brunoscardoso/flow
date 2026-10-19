/**
 * What the app does while the project it is watching changes underneath it.
 *
 * This is not an edge case: it is `npm run build`, a test run, a branch switch,
 * an agent writing forty files. The watcher fires, and everything downstream
 * fires with it — git status, the review list, the blueprint read, the brain
 * capture. A person is typing through all of it.
 *
 * Measured: a keystroke during the churn, the CPU main spends on it, and what
 * the app itself recorded while it happened.
 */
import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  close,
  dismissOnboarding,
  ensurePerfRepo,
  freshUserData,
  launch,
  printTable,
  slowLines,
} from './launch'

/** Files touched — a build's output directory, roughly. */
const FILES = 1_500

test('typing while a build rewrites the project', async () => {
  test.setTimeout(900_000)
  const repo = ensurePerfRepo()
  const userData = freshUserData('churn')
  const title = 'Churn thread'

  const { app, window } = await launch(userData)
  await dismissOnboarding(window)
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
  // Let provisioning settle so we measure the churn, not the scaffolding.
  await window.waitForTimeout(30_000)

  const marks: Record<string, number | string> = {}
  await composer.click()
  const quietAt = Date.now()
  await composer.press('q')
  await expect(composer).toHaveValue(/q/, { timeout: 20_000 })
  marks['keystroke, tree quiet'] = Date.now() - quietAt

  // THE BUILD. Written from the spec's own process, so the app learns about it
  // exactly the way it learns about a real one: from the filesystem.
  const cpuBefore = await app.evaluate(async () => process.cpuUsage())
  const churnStarted = Date.now()
  const outDir = join(repo, 'perf-build-output')
  mkdirSync(outDir, { recursive: true })
  for (let i = 0; i < FILES; i += 1) {
    writeFileSync(join(outDir, `chunk-${String(i)}.js`), `export const n = ${String(i)};\n`.repeat(20))
  }
  marks['writing 1,500 files'] = Date.now() - churnStarted

  // …and a keystroke while the app is digesting it.
  const churnAt = Date.now()
  await composer.press('x')
  await expect(composer).toHaveValue(/x/, { timeout: 60_000 })
  marks['keystroke, mid-churn'] = Date.now() - churnAt

  // Then let it settle, and see what the whole episode cost.
  await window.waitForTimeout(20_000)
  const cpuAfter = await app.evaluate(async () => process.cpuUsage())
  marks['main CPU for the episode'] = Math.round(
    (cpuAfter.user - cpuBefore.user + (cpuAfter.system - cpuBefore.system)) / 1000,
  )

  const settledAt = Date.now()
  await composer.press('z')
  await expect(composer).toHaveValue(/z/, { timeout: 30_000 })
  marks['keystroke, after settling'] = Date.now() - settledAt

  printTable('a build, under a watching app', marks)
  const lines = slowLines(userData)
  for (const line of lines
    .filter((l) => l.includes('blocked') || l.includes('IPC calls') || l.includes('[ipc]'))
    .slice(-12)) {
    console.log(`  ${line}`)
  }
  console.log('')

  await close(app)
  expect(marks['keystroke, mid-churn']).toBeGreaterThan(0)
})
