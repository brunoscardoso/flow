import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Cross-surface journey: edit a file in the editor → save → the change surfaces in
 * Source Control → stage → commit → it lands in the log. Every sibling git spec
 * seeds a pre-modified file straight to DISK; NONE drive the editor→git handoff
 * (an in-editor ⌘S save must reach the git panel via the working-tree watcher).
 * This guards that full Files → editor → Source Control → Commits chain end-to-end.
 * Credential-free (editor + local git only).
 *
 * Watcher note: step 3 relies on the working-tree watcher surfacing the edit. Unlike
 * the flaky new-file/delete detection on macOS temp dirs (see the deleted
 * delete-open-file probe), an in-editor save is an ATOMIC RENAME over an existing
 * tracked file (writeProjectFile: temp + rename) — a reliable fsevents signal;
 * verified 7/7 locally, and CI runs on Linux (inotify) with retries.
 */
function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** Click a file-tree row (Files rail; retries through the cold-launch overlay). */
async function openFromTree(win: Page, name: string): Promise<void> {
  const row = win.locator('.fl-sidebar-pane:visible').getByText(name, { exact: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    const overlay = win.locator('.fl-settings-overlay:not([hidden])')
    if (await overlay.count()) {
      await win.keyboard.press('Escape')
      await overlay.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined)
    }
    const files = win.locator('[data-rail-item="files"]')
    const cls = (await files.getAttribute('class')) ?? ''
    if (!/\bactive\b/.test(cls)) await files.click().catch(() => undefined)
    await pickFilesProject(win)
    try {
      await row.waitFor({ state: 'visible', timeout: 8000 })
      await row.click({ timeout: 4000 })
      return
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
}

async function openSourceControl(win: Page): Promise<void> {
  await win.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await win.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(win.locator('.gp-root')).toBeVisible()
}

async function panelText(win: Page): Promise<string> {
  return win.locator('.gp-root').innerText()
}
async function expectPanel(win: Page, needle: string): Promise<void> {
  await expect(async () => {
    expect(await panelText(win)).toContain(needle)
  }).toPass({ timeout: 8000 })
}

test.afterAll(() => cleanupSeeds())

test('journey: edit a file → save → it appears in Source Control → stage → commit → log (#full-chain)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  // A repo with alpha.txt COMMITTED (clean tree).
  const dir = await seedProject(window, 'flow-journey-')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  writeFileSync(join(dir, 'alpha.txt'), 'first line\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'feat: alpha')
  await activateProject(window, dir)

  // 1) Open alpha.txt from the Files tree and edit it in Monaco.
  await openFromTree(window, 'alpha.txt')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('first line', {
    timeout: 15000,
  })
  await window.locator('.monaco-editor .view-lines').click()
  await window.keyboard.press('End')
  await window.keyboard.type('\nJOURNEY_EDIT')

  // 2) Save (⌘S) — the tab's dirty dot clears once the write lands.
  const dirtyDot = window.locator('.fl-shell fl-tabs .tab', { hasText: 'alpha.txt' }).locator('.dirty-dot')
  await expect(dirtyDot).toBeVisible()
  await window.keyboard.press('ControlOrMeta+s')
  await expect(dirtyDot).toHaveCount(0, { timeout: 8000 })

  // 3) THE HANDOFF: the in-editor save must surface in Source Control's Changes
  //    (via the working-tree watcher) — no direct-to-disk write did this.
  await openSourceControl(window)
  await expectPanel(window, 'CHANGES (1)')
  await expect(
    window.locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) }),
  ).toBeVisible({ timeout: 8000 })

  // 4) Stage alpha via its inline (+) → it moves to Staged Changes.
  await window
    .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'alpha.txt' }) })
    .first()
    .locator('.gp-action-btn[title="Stage"]')
    .click()
  await expectPanel(window, 'STAGED CHANGES (1)')

  // 5) Commit with a message → alpha clears and the commit tops the log.
  await window.locator('.gp-commit-msg').fill('chore: journey commit of alpha')
  await expect(window.locator('.gp-commit-btn')).toBeEnabled()
  await window.locator('.gp-commit-btn').click()

  await expect(async () => {
    expect(await panelText(window)).not.toContain('STAGED CHANGES')
  }).toPass({ timeout: 8000 })
  await expect(
    window.locator('.gp-subject', { hasText: 'chore: journey commit of alpha' }),
  ).toBeVisible({ timeout: 8000 })

  // The commit actually contains the in-editor edit.
  expect(git(dir, 'show', '--stat', 'HEAD')).toContain('alpha.txt')
  expect(git(dir, 'show', 'HEAD:alpha.txt')).toContain('JOURNEY_EDIT')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
