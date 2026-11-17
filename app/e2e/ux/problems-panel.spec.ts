/**
 * THE PROBLEMS LIST — the bottom panel's second view, beside Terminal.
 *
 * A real TypeScript project with one type error is opened in the editor; the
 * main-process language server reports it, and:
 *   1. the Problems tab carries the count ("Problems 1"),
 *   2. the list shows the file group and the problem (message, source, line:col),
 *   3. clicking the problem opens its file with the caret at that position,
 *   4. Fix with agent is disabled with a plain reason while no conversation is
 *      open, and with one open it sends ONE message through the composer.
 *
 * Nothing reaches an agent: `threads:sendMessage` is answered in MAIN (the
 * renderer's `window.flow` is a contextBridge proxy — assigning to it does
 * nothing) and records what the renderer sent.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

test.afterAll(() => cleanupSeeds())

/** package.json + tsconfig.json make it a root the language server serves. */
function prepareTsProject(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'flow-problems-probe', version: '1.0.0' }))
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'Bundler' } }),
  )
  writeFileSync(join(dir, 'lib.ts'), 'export const fine = 1\n')
  writeFileSync(join(dir, 'user.ts'), ['import { fine } from "./lib"', '', 'export const ok = fine', 'export const bad: string = 42', ''].join('\n'))
}

async function openInEditor(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

async function api<T>(win: Page, fn: string, arg: unknown): Promise<T> {
  return win.evaluate(
    async ({ fn, arg }) => {
      const flow = (window as unknown as { flow: Record<string, Record<string, (i: unknown) => Promise<unknown>>> }).flow
      const [ns, method] = fn.split('.')
      return (await flow[ns]![method]!(arg)) as unknown
    },
    { fn, arg },
  ) as Promise<T>
}

async function spySend(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __problemSends?: unknown[] }
    g.__problemSends = []
    ipcMain.removeHandler('threads:sendMessage')
    ipcMain.handle('threads:sendMessage', (_event, request) => {
      g.__problemSends?.push(request)
      return { messageId: `problems-stub-${g.__problemSends?.length ?? 0}` }
    })
  })
}

async function sent(app: ElectronApplication): Promise<Array<{ threadId: string; content: string }>> {
  return app.evaluate(() =>
    ((globalThis as unknown as { __problemSends?: Array<{ threadId: string; content: string }> }).__problemSends ?? []).map(
      (request) => ({ threadId: request.threadId, content: request.content }),
    ),
  )
}

/** The text of the editor's (1-based) line, by rendered position. */
async function editorLine(win: Page, line: number): Promise<string> {
  return win.evaluate((index) => {
    const lines = (Array.from(document.querySelectorAll('.monaco-editor .view-line')) as HTMLElement[]).sort(
      (a, b) => parseInt(a.style.top) - parseInt(b.style.top),
    )
    return (lines[index]?.textContent ?? '').replace(/ /g, ' ')
  }, line - 1)
}

test('Problems lists a real type error, jumps to it, and Fix with agent sends one message', async ({ app, window: page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (error) => {
    if (error.message !== 'Canceled') errors.push(error.message) // Monaco's benign dispose cancel
  })

  const root = await seedProject(page, 'flow-ux-problems-', prepareTsProject)
  await activateProject(page, root)
  await spySend(app)

  const terminalRoot = page.locator(sel.terminalRoot)
  await expect(terminalRoot).toBeVisible()
  const problemsTab = terminalRoot.locator('.fl-problems-view[data-view="problems"]')
  const terminalTab = terminalRoot.locator('.fl-problems-view[data-view="terminal"]')
  await expect(terminalTab).toHaveText('Terminal')
  await expect(problemsTab).toHaveText('Problems')

  // ── A real type error, reported by the language server ──────────────────
  await openInEditor(page, root, 'user.ts')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('export const bad', { timeout: 15_000 })
  await expect(page.locator('.monaco-editor .squiggly-error').first()).toBeVisible({ timeout: 60_000 })

  // The count reaches the tab label while the terminal is the view shown.
  await expect(problemsTab).toHaveText('Problems 1', { timeout: 15_000 })

  await problemsTab.click()
  await expect(problemsTab).toHaveClass(/active/)
  await expect(terminalRoot.locator('.fl-term-hosts')).toBeHidden()
  const group = terminalRoot.locator('.fl-problems-group[data-file="user.ts"]')
  await expect(group).toHaveCount(1)
  await expect(group.locator('.fl-problems-file-name')).toHaveText('user.ts')
  await expect(group.locator('.fl-problems-count.fl-problems-error')).toHaveText('1')
  const row = group.locator('.fl-problems-row')
  await expect(row).toHaveCount(1)
  await expect(row).toHaveAttribute('data-severity', 'error')
  await expect(row.locator('.fl-problems-message')).toContainText("Type 'number' is not assignable to type 'string'")
  await expect(row.locator('.fl-problems-source')).toContainText('2322')
  await expect(row.locator('.fl-problems-position')).toHaveText('4:14')
  await expect(terminalRoot.locator('.fl-problems-summary')).toHaveText('1 error')

  // ── Click jumps: another file is shown, the row brings user.ts back with the
  //    caret at line 4, column 14 (typing proves where the caret is) ─────────
  await openInEditor(page, root, 'lib.ts')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('export const fine = 1', { timeout: 15_000 })
  await row.click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('export const bad', { timeout: 15_000 })
  await page.waitForTimeout(300)
  await page.keyboard.type('Z')
  await expect.poll(() => editorLine(page, 4)).toBe('export const Zbad: string = 42')
  await page.keyboard.press('Meta+z')
  await expect.poll(() => editorLine(page, 4)).toBe('export const bad: string = 42')

  // ── No conversation: Fix is there, and disabled with a plain reason ────────
  const fixAll = terminalRoot.locator('.fl-problems-fix-all')
  await expect(fixAll).toBeVisible()
  await expect(fixAll).toBeDisabled()
  await expect(fixAll).toHaveAttribute('title', /Open a conversation first/)
  await expect(row.getByRole('button', { name: 'Fix with agent' })).toBeDisabled()

  // ── With a conversation open, Fix with agent sends ONE message ─────────────
  const thread = await api<{ id: string }>(page, 'threads.create', { projectRoot: root, title: 'Problems thread' })
  await page.getByText('Problems thread', { exact: true }).first().click()
  await expect(page.locator(sel.composer)).toBeVisible()
  // The panel may have been re-laid for the conversation; show Problems again.
  await expect(terminalRoot).toBeVisible()
  if (!(await problemsTab.getAttribute('class'))?.includes('active')) await problemsTab.click()
  const rowFix = row.getByRole('button', { name: 'Fix with agent' })
  await expect(rowFix).toBeEnabled({ timeout: 10_000 })
  await expect(fixAll).toBeEnabled()

  await row.hover()
  await rowFix.click()
  await expect.poll(() => sent(app), { timeout: 10_000 }).toHaveLength(1)
  const [message] = await sent(app)
  expect(message!.threadId).toBe(thread.id)
  expect(message!.content).toContain('Fix this problem.')
  expect(message!.content).toMatch(/- user\.ts:4:14 — error: Type 'number' is not assignable to type 'string'\. \(\w+ 2322\)/)
  await page.waitForTimeout(1_000)
  expect(await sent(app)).toHaveLength(1)

  expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
})
