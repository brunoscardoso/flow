import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { activateProject, removeTempDir } from './fixtures/seed'
import { parseConflictHunks } from '../../src/shared/conflict-hunks'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Conflict review card — "jump to hunk" navigation (reveal-on-open half), end to
 * end. The review-card row's "View in file" control dispatches the shared
 * `flow:open-file` channel with `revealConflictHunkId` set; the editor module
 * opens the file and scrolls THAT conflict hunk into view (revealing BY the
 * content-derived hunkId so it survives line shifts). This spec proves the editor
 * half deterministically and credential-lessly: it seeds a LONG two-hunk conflict
 * whose hunks sit far enough apart that only one fits the viewport, opens the file
 * (viewport starts at the TOP — the second hunk off-screen), then fires
 * `flow:open-file` with the SECOND hunk's id and asserts the viewport SCROLLED so
 * that hunk's region is now on screen.
 *
 * The card-click → dispatch half (the composer of that same event) is covered by
 * the model unit test (row carries rootPath + hunkId) plus the view's
 * `#navigateToRow`, and is honestly typecheck-verified rather than mounted
 * headlessly here — reaching a live card needs an agent turn (see the fixme in
 * conflict-identity-resolve.spec.ts).
 */

const SHOTS = join(__dirname, '__screens')

/** Monaco fires a benign "Canceled" rejection on model/editor disposal — not an app error. */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** Throwaway repos seeded this run (cleaned in afterAll). */
const seededDirs: string[] = []

/** Pad lines BETWEEN the two edit regions — wide enough that the two hunks cannot
 *  both fit the editor viewport, so revealing the second one must scroll. */
const PAD_LINES = 60

/**
 * Build a repo carrying a real merge conflict with TWO separate hunks in one file,
 * spaced far apart (PAD_LINES unchanged lines between them) so git keeps them as
 * distinct hunks AND only one hunk fits the viewport at a time. Returns { dir, file }.
 * Seeding the conflict BEFORE addRoot matters: the app's git watcher starts polling
 * the moment the root is added and would race the seed commits for the index lock.
 */
function seedLongTwoHunkConflictRepo(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-conflict-reveal-'))
  seededDirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')

  const file = 'notes.txt'
  const withRegions = (alpha: string, omega: string): string =>
    [
      'intro line',
      alpha,
      ...Array.from({ length: PAD_LINES }, (_v, i) => `pad ${i + 1}`),
      omega,
      'outro line',
      '',
    ].join('\n')

  writeFileSync(join(dir, file), withRegions('ALPHA base', 'OMEGA base'))
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', 'base')
  const mainBranch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()

  git(dir, 'checkout', '-q', '-b', 'topic-blue')
  writeFileSync(join(dir, file), withRegions('ALPHA blue', 'OMEGA blue'))
  git(dir, 'commit', '-q', '-am', 'topic-blue change')

  git(dir, 'checkout', '-q', mainBranch)
  writeFileSync(join(dir, file), withRegions('ALPHA trunk', 'OMEGA trunk'))
  git(dir, 'commit', '-q', '-am', 'trunk change')

  try {
    git(dir, 'merge', 'topic-blue')
  } catch {
    // Expected: merge exits non-zero on conflict. The working tree now has markers.
  }
  return { dir, file }
}

/** Add a pre-built repo dir as a project root (no native dialog). */
async function addRoot(window: Page, dir: string): Promise<void> {
  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
}

/** Dispatch the app's own `flow:open-file` channel (optionally with a reveal target). */
async function openFile(
  window: Page,
  dir: string,
  file: string,
  revealConflictHunkId?: string,
): Promise<void> {
  await window.evaluate(
    ({ rootPath, relPath, hunkId }) => {
      document.dispatchEvent(
        new CustomEvent('flow:open-file', {
          detail: {
            rootPath,
            relPath,
            ...(hunkId ? { revealConflictHunkId: hunkId } : {}),
          },
        }),
      )
    },
    { rootPath: dir, relPath: file, hunkId: revealConflictHunkId ?? null },
  )
}

test.afterAll(() => {
  while (seededDirs.length) {
    const dir = seededDirs.pop()
    if (dir) removeTempDir(dir)
  }
})

test('flow:open-file with revealConflictHunkId scrolls the named hunk into view', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const { dir, file } = seedLongTwoHunkConflictRepo()
  await addRoot(window, dir)
  await activateProject(window, dir)

  // The SECOND hunk's stable, content-derived id — computed from the real working
  // tree via the SAME shared parser the app uses (never a reimplemented digest).
  const markered = readFileSync(join(dir, file), 'utf8')
  const hunks = parseConflictHunks(markered)
  expect(hunks).toHaveLength(2)
  const secondHunkId = hunks[1]!.hunkId

  // Open the file at the TOP (no reveal target). The first hunk (ALPHA) sits near
  // line 2 and is on-screen; the second hunk (OMEGA) sits ~60 lines down, off-screen.
  await openFile(window, dir, file)
  const viewLines = window.locator('.monaco-editor .view-lines')
  await expect(viewLines).toContainText('<<<<<<<', { timeout: 15000 })
  await expect(viewLines).toContainText('ALPHA', { timeout: 15000 })
  // The second hunk's region is NOT rendered yet — the viewport is at the top.
  await expect(viewLines).not.toContainText('OMEGA')

  // Now navigate to the SECOND hunk BY id — the exact event the review card's
  // "View in file" control dispatches. The editor must scroll it into view.
  await openFile(window, dir, file, secondHunkId)

  // The viewport moved: the second hunk's region (OMEGA, off-screen at the top) is
  // now rendered in the visible lines. This is the reveal-on-open guarantee.
  await expect(viewLines).toContainText('OMEGA', { timeout: 10000 })

  await window.screenshot({ path: join(SHOTS, 'conflict-reveal-on-open.png') })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})
