import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, ElectronApplication } from '@playwright/test'

/**
 * The open file rides along with the chat (active-file-chip.ts).
 *
 * The file focused in the editor shows as an automatic chip above the
 * composer; it follows tab focus, × hides it for that focus, closing every tab
 * removes it, and a send carries its PATH (never its content).
 *
 * `window.flow` is frozen in the renderer, so the send is observed at MAIN by
 * re-registering `threads:sendMessage` (same seam as composer-send-gating).
 */

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const t = await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> } }
        }
      ).flow.threads.create({ projectRoot: root, title })
      return t.id
    },
    { root, title },
  )
}

async function spySend(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __qaSends?: unknown[] }
    g.__qaSends = []
    ipcMain.removeHandler('threads:sendMessage')
    ipcMain.handle('threads:sendMessage', (_event, request) => {
      g.__qaSends?.push(request)
      return { messageId: `qa-stub-${g.__qaSends?.length ?? 0}` }
    })
  })
}

async function sentContents(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() =>
    ((globalThis as unknown as { __qaSends?: { content: string }[] }).__qaSends ?? []).map((r) => r.content),
  )
}

async function openInEditor(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

const autoChip = (win: Page) => win.locator(`${sel.composer} .fl-composer-chip.auto`)
const editorTab = (win: Page, name: string) => win.locator('fl-tabs .tab', { hasText: name })

test.afterAll(() => cleanupSeeds())

test('the open editor file rides along with the chat: follows focus, dismisses, and is sent as a path', async ({
  app,
  window,
}) => {
  const dir = await seedProject(window)
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'alpha.ts'), 'export const alpha = "SECRET-ALPHA-CONTENT"\n')
  writeFileSync(join(dir, 'src', 'beta.ts'), 'export const beta = 2\n')
  await activateProject(window, dir)
  const title = 'Open file rides along'
  await createThread(window, dir, title)
  await window.getByText(title, { exact: true }).first().click()
  await expect(window.locator(sel.composer)).toBeVisible()
  await spySend(app)

  // 1. An open file shows as the automatic chip: name on the badge, relative path on hover.
  await openInEditor(window, dir, 'src/alpha.ts')
  await expect(autoChip(window)).toHaveCount(1)
  await expect(autoChip(window).locator('.fl-composer-chip-label')).toHaveText('alpha.ts')
  await expect(autoChip(window)).toHaveAttribute('title', 'src/alpha.ts')

  // 2. It follows a tab switch — replaced, never stacked.
  await openInEditor(window, dir, 'src/beta.ts')
  await expect(autoChip(window).locator('.fl-composer-chip-label')).toHaveText('beta.ts')
  await expect(autoChip(window)).toHaveCount(1)
  await editorTab(window, 'alpha.ts').click()
  await expect(autoChip(window).locator('.fl-composer-chip-label')).toHaveText('alpha.ts')

  // 3. × hides it for that file (positive asserted above, absence now).
  await autoChip(window).locator('.fl-composer-chip-dismiss').click()
  await expect(autoChip(window)).toHaveCount(0)
  // …a different file brings a chip back, and so does returning to alpha later.
  await editorTab(window, 'beta.ts').click()
  await expect(autoChip(window).locator('.fl-composer-chip-label')).toHaveText('beta.ts')
  await editorTab(window, 'alpha.ts').click()
  await expect(autoChip(window).locator('.fl-composer-chip-label')).toHaveText('alpha.ts')

  // 4. On send it travels as the path only — no file content — and stays for the next message.
  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.fill('what does this file do?')
  await textarea.press('Enter')
  await expect.poll(() => sentContents(app)).toHaveLength(1)
  const [content] = await sentContents(app)
  expect(content).toContain('Open in the editor (path only, not attached): src/alpha.ts')
  expect(content).toContain('what does this file do?')
  expect(content).not.toContain('SECRET-ALPHA-CONTENT')
  await expect(autoChip(window)).toHaveCount(1)

  // 5. Closing every editor tab removes it.
  await editorTab(window, 'alpha.ts').locator('.close').click()
  await expect(autoChip(window).locator('.fl-composer-chip-label')).toHaveText('beta.ts')
  await editorTab(window, 'beta.ts').locator('.close').click()
  await expect(editorTab(window, 'beta.ts')).toHaveCount(0)
  await expect(autoChip(window)).toHaveCount(0)
})

test('a file outside the thread project gets no chip', async ({ window }) => {
  const dir = await seedProject(window)
  writeFileSync(join(dir, 'inside.ts'), 'x\n')
  const other = await seedProject(window, 'flow-ux-other-')
  writeFileSync(join(other, 'outside.ts'), 'y\n')
  await activateProject(window, dir)
  const title = 'Only this project'
  await createThread(window, dir, title)
  await window.getByText(title, { exact: true }).first().click()
  await expect(window.locator(sel.composer)).toBeVisible()

  // Positive first: a file of the thread's project does get the chip…
  await openInEditor(window, dir, 'inside.ts')
  await expect(autoChip(window).locator('.fl-composer-chip-label')).toHaveText('inside.ts')
  // …and a file of another project replaces it with nothing.
  await openInEditor(window, other, 'outside.ts')
  await expect(editorTab(window, 'outside.ts')).toHaveCount(1)
  await expect(autoChip(window)).toHaveCount(0)
})
