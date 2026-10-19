import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 7 (Editor): the ⌘L "add editor selection to chat" path (#462).
 *
 * The terminal analog (terminal-select-chat.spec.ts, #152) is probed; the editor
 * side — select code in Monaco, press ⌘L, get a context chip in the composer —
 * was not. It's a credential-less core affordance (monaco-host addAction
 * 'flow.addSelectionToChat' → dispatches `flow:add-to-chat` with source:'file',
 * which the composer renders as a chip whose KIND label is the file's base name).
 *
 * Drives the real flow: seed a project, open a thread (composer visible), open a
 * code file via the decoupled `flow:open-file` event, select its text in Monaco,
 * press ⌘L, and assert a context chip labelled with the filename lands carrying
 * the selected code. Monaco's benign internal "Canceled" on model dispose is
 * filtered — see editor.spec.ts for the rationale.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

/** Open a project file through the app's real decoupled `flow:open-file` event —
 *  the same path the Files tree and blueprint file-rows dispatch (independent of
 *  the #663/#664 activity-bar markup). */
async function openFile(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

/** Create a thread in the seeded project and open it → composer becomes visible. */
async function openThread(win: Page, projectRoot: string): Promise<void> {
  await win.evaluate(async (root) => {
    const flow = (
      window as unknown as {
        flow: {
          threads: {
            create(r: { projectRoot: string; additionalRoots: string[] }): Promise<{ id: string }>
          }
        }
      }
    ).flow
    const thread = await flow.threads.create({ projectRoot: root, additionalRoots: [] })
    document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: thread.id } }))
  }, projectRoot)
  await expect(win.locator('.fl-composer-input textarea')).toBeVisible({ timeout: 8000 })
}

test.afterAll(() => cleanupSeeds())

test('selecting code in the editor + ⌘L attaches a filename context chip to the composer', async ({
  window,
}) => {
  const errors = trackErrors(window)

  const dir = await seedProject(window)
  const MARKER = 'EDITOR_SELECT_TARGET'
  writeFileSync(
    join(dir, 'sample.ts'),
    `export const ${MARKER} = 'add-me-to-chat'\nexport function helper() { return ${MARKER} }\n`,
  )
  await activateProject(window, dir)
  await openThread(window, dir)

  // Open the file into the editor and wait for Monaco to render its content.
  await openFile(window, dir, 'sample.ts')
  const viewLines = window.locator('.monaco-editor .view-lines')
  await expect(viewLines).toContainText(MARKER, { timeout: 15000 })

  // Select all the code the way a user would: focus Monaco, ⌘A.
  await viewLines.click()
  await window.keyboard.press('ControlOrMeta+a')
  await window.screenshot({ path: `${SCREENS}/editor-select-01-selected.png` })

  // ⌘L should attach the selection to the composer as a context chip — NOT run
  // Monaco's default "expand line selection" (the addAction overrides that key).
  await window.keyboard.press('ControlOrMeta+l')

  // A context chip whose KIND label is the file's base name must appear.
  const chipKind = window.locator('.fl-composer-chip-kind', { hasText: 'sample.ts' })
  await expect(chipKind).toBeVisible({ timeout: 5000 })
  await window.screenshot({ path: `${SCREENS}/editor-select-02-chip.png` })

  // The chip carries the selected code (its title holds the full selection).
  const chip = window.locator('.fl-composer-chip', { has: chipKind })
  await expect(chip).toHaveAttribute('title', new RegExp(MARKER))

  expect(
    appErrors(errors),
    `uncaught errors during ⌘L editor→chat:\n${errors.join('\n')}`,
  ).toEqual([])
})
