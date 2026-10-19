/**
 * The board, drawn against a real graph.
 *
 * The blueprint is the heaviest SURFACE in the app: a derived graph of every
 * module, endpoint, datastore and integration in a project, rendered as an
 * interactive map. This repo's own graph is 1.1 MB. Opening it is one click,
 * and what that click costs has never been measured.
 *
 * Uses THIS repository as the project — it is the one checkout with a real
 * derived structure layer sitting in it, and a synthetic graph would measure a
 * renderer nobody has.
 */
import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { close, dismissOnboarding, freshUserData, launch, printTable, slowLines } from './launch'
import { sel, statusButtonByText } from '../selectors'

/** The repo this app lives in — derived, real, and already provisioned. */
const SELF = resolve(__dirname, '../../..')

test('opening the blueprint board on a real graph', async () => {
  test.setTimeout(900_000)
  test.skip(!existsSync(`${SELF}/flow/brain/.structure/graph.json`), 'no derived graph here')
  const userData = freshUserData('board')
  const { app, window } = await launch(userData)
  await dismissOnboarding(window)

  await window.evaluate(async (path) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    await flow.project.add({ path })
    const roots = (await flow.project.list()) as Array<{ rootPath: string }>
    await flow.project.setActive({ rootPath: roots.at(-1)?.rootPath ?? path })
  }, SELF)
  await window.waitForTimeout(20_000)

  const marks: Record<string, number | string> = {}

  // 1. THE READ, on its own — what main hands over for a board to exist.
  //
  // `rootId`, NOT `rootPath` (#1841). The channel's contract is
  // `{ rootId: string }` (ipc-contract.ts) and the handler destructures exactly
  // that (blueprint-observer.ts), so the old key arrived as `undefined` and this
  // whole block measured an empty snapshot — "0 nodes, 0 edges" against a real
  // 1.2 MB graph, reported as a number. The value is right either way: the live
  // board calls `read({ rootId: rootPath })`. `flow` is `Record<string, any>`
  // inside an evaluate, so nothing typechecked the request object.
  const read = await window.evaluate(async (path: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const started = performance.now()
    const snapshot = await flow.blueprint.read({ rootId: path })
    const ms = performance.now() - started
    const graph = (snapshot as { graph?: { nodes?: unknown[]; edges?: unknown[] } }).graph
    return {
      ms,
      bytes: new TextEncoder().encode(JSON.stringify(snapshot ?? null)).length,
      nodes: graph?.nodes?.length ?? 0,
      edges: graph?.edges?.length ?? 0,
    }
  }, SELF)
  marks['blueprint:read'] = read.ms
  marks['snapshot payload'] = `${(read.bytes / 1024).toFixed(0)} KB`
  marks['graph'] = `${String(read.nodes)} nodes, ${String(read.edges)} edges`

  // 2. THE CLICK. Status bar → board on screen.
  //
  // Both selectors here come from the shared map, and the miss is an assertion
  // rather than a skip. This spec used to hand-roll `.fl-status-btn` — the class
  // is `.fl-status-button`, and the typo sat inside a `count() === 0` guard, so
  // a measurement spec logged "skipping the click half" and passed green while
  // taking none of the three numbers it exists to take (#1817). A perf guard
  // that cannot find its target has to FAIL: reporting success while measuring
  // nothing is how a real regression in board open time goes unnoticed.
  const openedAt = Date.now()
  const button = window.locator(statusButtonByText('Blueprint')).first()
  await expect(button).toBeVisible({ timeout: 30_000 })
  await button.click()
  await window.locator(sel.blueprintRoot).first().waitFor({ state: 'visible', timeout: 120_000 })
  marks['click → board visible'] = Date.now() - openedAt
  await window.waitForTimeout(2_000)
  const dom = await window.evaluate(() => document.querySelectorAll('*').length)
  // A COUNT, so it goes in as a string: printTable suffixes every number with
  // `ms`, and this mark has never once printed before now (#1817) — so nobody
  // had seen it claim the board renders "431ms nodes".
  marks['DOM nodes after board'] = `${String(dom)} nodes`

  // 3. STILL RESPONSIVE? A drag across the board, then a keystroke.
  const dragAt = Date.now()
  await window.mouse.move(700, 400)
  await window.mouse.down()
  for (let i = 0; i < 20; i += 1) await window.mouse.move(700 + i * 12, 400 + i * 6)
  await window.mouse.up()
  marks['a 20-step drag'] = Date.now() - dragAt

  await window.waitForTimeout(1_500)
  printTable('the blueprint board', marks)
  for (const line of slowLines(userData).slice(-12)) console.log(`  ${line}`)

  await close(app)

  // Asserted after close(app) so a failure does not strand the Electron
  // process, and asserted on the NODE COUNT rather than the old
  // `read.ms >= 0`, which no read could ever fail. A read that finds nothing is
  // not a fast read: the spec already skipped out if there were no graph.json,
  // so by here one exists, and an empty snapshot means the request never
  // reached it — exactly how the `rootPath` key hid for as long as it did.
  // Same rule the click half got in #1817: a measurement that cannot find its
  // subject fails, it does not report zero.
  expect(
    read.nodes,
    'blueprint:read returned an empty graph though graph.json exists',
  ).toBeGreaterThan(0)
})
