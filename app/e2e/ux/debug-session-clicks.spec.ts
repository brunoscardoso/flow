/**
 * THE CLICKS HAVE TO REACH THE SESSION.
 *
 * Every artifact from a real session said "Nothing was captured from the page
 * itself — no clicks and no navigation" while the person had been clicking
 * throughout (user, 2026-09-21). Both ends existed — the guest recorded, the
 * session had an `interaction` method — and nothing joined them: the guest can
 * only `sendToHost`, which reaches the renderer, and the session lives in main.
 * Nothing forwarded.
 *
 * This drives a REAL click in a REAL page and asserts it comes out in the
 * artifact, which is the only place the whole chain is visible.
 */
import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

test.afterAll(() => cleanupSeeds())

test('a click in the page reaches the session artifact', async ({ window }) => {
  test.setTimeout(300_000)
  const root = await seedProject(window, 'flow-click-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir })
  })
  await activateProject(window, root)

  const page = `file://${resolve('e2e/fixtures/pages/net-probe.html')}`
  await window.evaluate((url: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-browser', { detail: { url } }))
  }, page)
  await expect(window.locator('webview')).toBeVisible({ timeout: 60_000 })
  await window.waitForTimeout(2500)

  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:debug-toggle')))
  await window.waitForTimeout(1200)

  // A REAL CLICK, dispatched inside the guest — the recorder listens on the
  // page's own document, which is the thing under test.
  await window.evaluate(async () => {
    const view = document.querySelector('webview') as unknown as {
      executeJavaScript(code: string): Promise<unknown>
    } | null
    await view?.executeJavaScript(`document.getElementById('go').click(); 1`)
  })
  await window.waitForTimeout(2000)

  const live = (await window.evaluate(async () =>
    (window as unknown as { flow: Record<string, any> }).flow.debug.status({}),
  )) as { records: number } | null
  // The positive first: the session is live and counting.
  expect(live?.records, 'the session recorded nothing at all').toBeGreaterThan(0)

  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:debug-toggle')))
  await window.waitForTimeout(2500)

  const dir = join(root, 'flow', 'debug-sessions')
  expect(existsSync(dir), 'no session folder was written').toBe(true)
  const id = readdirSync(dir).filter((n) => n.startsWith('dbg-'))[0] as string
  const summary = readFileSync(join(dir, id, 'summary.md'), 'utf8')

  // THE CLICK IS IN THE ARTIFACT, named by what was clicked.
  expect(summary, 'the summary still claims nothing was captured from the page').not.toContain(
    'Nothing was captured from the page itself',
  )
  expect(summary).toContain('## What you did')
  expect(summary).toContain('clicked')
  expect(summary).toContain('Save template')
})
