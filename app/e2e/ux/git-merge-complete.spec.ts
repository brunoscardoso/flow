/**
 * UX journey — FINISHING a conflicting merge from the Source Control panel.
 *
 * The merge flow is well probed up to (but never past) its terminal action:
 * git-merge-branch reaches the conflict, git-merge-abort clicks Abort,
 * conflict-identity-resolve asserts "Complete merge" gates and un-gates, and
 * review-conflicted-approve asserts a marker-laden file can't be landed. NOBODY
 * had ever CLICKED "Complete merge" — the button that actually writes the merge
 * commit — so everything downstream of it was unguarded.
 *
 * Test 1 (live guard) drives the whole journey with the panel's own controls:
 * Merge branch… → conflict → take one side from the row action → Complete merge
 * → assert against BOTH git (two-parent merge commit, no MERGE_HEAD, resolved
 * content) and the panel (banner gone, clean tree, the merge commit in history).
 *
 * Tests 2-4 cover the completion RECORD, which turns out to have three
 * disagreeing sources of truth for one question — "what did the user keep?":
 *
 *   · the stage-and-confirm review reads `getHunkResolutions`, written ONLY by
 *     the editor's per-hunk path (editor/conflict-hunk-actions.ts);
 *   · the merge summary (folded into the permanent commit message and written to
 *     flow/merges/*.md) reads `getMergeResolutionSession` + the still-unmerged
 *     set — the first is the AI-resolve flow's store, the second is empty by
 *     construction at completion time;
 *   · the panel's own row buttons (`onResolveSide`) and section keep-all
 *     (`onKeepAll`) write to neither.
 *
 * Test 2 is the live CONTROL (the review DOES work on the editor path). Test 3
 * is a fix-agnostic tripwire for the record (#1287): the commit says "0
 * conflict(s) resolved, risk: safe" one second after the dialog listed the
 * resolution. Test 4 is a fix-agnostic tripwire for the review (#1288): it reads
 * "No recorded hunk resolutions" right after the user resolved with the panel's
 * own button.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { activateProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')
const madeDirs: string[] = []

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** main + feature editing the same line → a guaranteed merge conflict. When
 *  `merge` is true the conflicting merge is left in progress on disk (the app
 *  then sees a genuine conflicted state the moment the root is added). */
function buildConflictRepo(prefix: string, merge = false): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  madeDirs.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  // The IDE auto-provisions .claude/, flow, .gitignore into every added root —
  // hide them so the clean-tree assertions describe only what this spec wrote.
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\nloops/\n')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  writeFileSync(join(dir, 'shared.txt'), 'line one\nline two\n')
  git(dir, 'add', 'shared.txt')
  git(dir, 'commit', '-q', '-m', 'feat: base')
  git(dir, 'checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'shared.txt'), 'line one FROM FEATURE\nline two\n')
  git(dir, 'add', 'shared.txt')
  git(dir, 'commit', '-q', '-m', 'feat: feature edits line one')
  git(dir, 'checkout', '-q', 'main')
  writeFileSync(join(dir, 'shared.txt'), 'line one FROM MAIN\nline two\n')
  git(dir, 'add', 'shared.txt')
  git(dir, 'commit', '-q', '-m', 'feat: main edits line one')
  if (merge) {
    try {
      git(dir, 'merge', 'feature')
    } catch {
      // Expected: a conflicting merge exits non-zero and leaves markers on disk.
    }
  }
  return dir
}

async function attachRoot(window: Page, dir: string): Promise<void> {
  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
}

async function panelText(window: Page): Promise<string> {
  return window.locator('.gp-root').innerText()
}
async function expectPanel(window: Page, needle: string): Promise<void> {
  await expect(async () => {
    expect(await panelText(window)).toContain(needle)
  }).toPass({ timeout: 12000 })
}

/** Reveal Source Control → Changes for an already-attached, active root. */
async function openSourceControl(window: Page): Promise<void> {
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible({ timeout: 15000 })
  await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 15000 })
}

/** Monaco fires a benign "Canceled" rejection on model disposal — not an app error. */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => !/Canceled|ResizeObserver/.test(m))
}

/**
 * Resolve the seeded one-hunk conflict through the EDITOR's per-hunk CodeLens —
 * the only path that calls `recordHunkResolution`. Opens the conflicted file the
 * way a Files-tree click does (`flow:open-file`), then clicks "Accept Current"
 * until the markers are gone (each splice re-provides the lens, so a lone click
 * can land on a detaching node).
 */
async function resolveInEditor(window: Page, dir: string): Promise<void> {
  await window.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath: dir, relPath: 'shared.txt' },
  )
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('<<<<<<<', {
    timeout: 20000,
  })
  const acceptCurrent = window
    .locator('.monaco-editor .codelens-decoration a')
    .filter({ hasText: 'Accept Current' })
  await expect(acceptCurrent).toHaveCount(1, { timeout: 20000 })
  await expect(async () => {
    await acceptCurrent.first().click({ timeout: 3000 })
    await expect(window.locator('.monaco-editor .view-lines')).not.toContainText('<<<<<<<', {
      timeout: 4000,
    })
  }).toPass({ timeout: 25000 })
}

/**
 * Take the conflict's first side from its row — LOOK BEFORE YOU LEAP: the
 * first press previews that side and arms the button, the second (confirmed)
 * press resolves. Checked against git BEFORE each press, so a press that has
 * already resolved the file is never followed by one aimed at a row that has
 * left the Merge section.
 */
async function takeFirstSide(window: Page, dir: string): Promise<void> {
  const side = window.locator('.gp-action-side').first()
  await expect(side).toBeVisible({ timeout: 12000 })
  await side.click() // preview + arm
  await expect(side).toHaveClass(/gp-action-side-armed/)
  await side.click() // apply (the confirm is accepted by the spec's dialog handler)
  await expect(async () => {
    expect(git(dir, 'status', '--porcelain')).not.toMatch(/UU\s+shared\.txt/)
  }).toPass({ timeout: 15000 })
}

test.afterAll(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true })
})

test.describe('git merge completion', () => {
  test('resolving the conflict and pressing "Complete merge" lands a real merge commit and restores a clean panel', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    // Completion is gated by a window.confirm review — accept it.
    const dialogs: string[] = []
    window.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.accept()
    })

    const dir = buildConflictRepo('flow-git-mergedone-')
    await attachRoot(window, dir)
    await activateProject(window, dir)
    await openSourceControl(window)
    await expectPanel(window, 'Working tree clean')

    // Merge `feature` from a terminal — Source Control's Merge branch… picker
    // was removed (2026-09-04), so this is now the user's path to a merge. What
    // this test guards starts here: the panel finishing what git started.
    try {
      git(dir, 'merge', 'feature')
    } catch {
      // Expected: a conflicting merge exits non-zero and leaves markers on disk.
    }
    await expect(async () => {
      expect(git(dir, 'status', '--porcelain')).toMatch(/UU\s+shared\.txt/)
    }).toPass({ timeout: 15000 })
    await expectPanel(window, 'MERGE CHANGES (1)')
    await expect(window.locator('.gp-merge-banner')).toBeVisible()
    await expect(window.locator('.gp-merge-complete')).toBeDisabled()
    await window.screenshot({ path: join(SHOTS, 'git-merge-complete-1-conflict.png') })

    // Resolve by taking OUR side (the row's first identity-labelled side button).
    await takeFirstSide(window, dir)

    // The banner reflects it and un-gates completion.
    await expect(window.locator('.gp-merge-complete')).toBeEnabled({ timeout: 12000 })
    await window.screenshot({ path: join(SHOTS, 'git-merge-complete-2-resolved.png') })

    // FINISH the merge.
    await window.locator('.gp-merge-complete').click()

    // git: a real two-parent merge commit landed and the merge state is gone.
    await expect(async () => {
      expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false)
      const parents = git(dir, 'log', '-1', '--format=%P').trim().split(/\s+/)
      expect(parents).toHaveLength(2)
    }).toPass({ timeout: 20000 })
    const merged = readFileSync(join(dir, 'shared.txt'), 'utf8')
    expect(merged).toContain('FROM MAIN')
    expect(merged).not.toContain('<<<<<<<')

    // Panel: the merge UI is gone and the tree reads clean again.
    await expect(window.locator('.gp-merge-banner')).toHaveCount(0, { timeout: 15000 })
    await expect(async () => {
      expect(await panelText(window)).not.toContain('MERGE CHANGES')
    }).toPass({ timeout: 15000 })
    await expectPanel(window, 'Working tree clean')

    // The merge commit is visible in the panel's own history. Commit rows live in
    // fl-list's shadow DOM (invisible to innerText) — assert the row locator.
    const subject = git(dir, 'log', '-1', '--format=%s').trim()
    await window.screenshot({ path: join(SHOTS, 'git-merge-complete-3-done.png') })
    await expect(window.locator('.gp-subject', { hasText: subject })).toHaveCount(1, {
      timeout: 15000,
    })

    const appErrs = appErrors(errors)
    expect(appErrs, appErrs.join(', ')).toHaveLength(0)
    expect(dialogs.join('\n')).toContain('Complete the merge?')
  })

  // CONTROL (live): the completion REVIEW works — resolving the very same conflict
  // through the EDITOR's per-hunk path makes the confirm name the file and the side
  // kept, and the merge lands. This is the contrast for the two tripwires below:
  // the review machinery exists and is wired; the panel's own controls just never
  // feed it, and the permanent record never reads it at all.
  test('CONTROL: resolving in the editor makes the completion review name the file and the side kept', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))
    const dialogs: string[] = []
    window.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.accept()
    })

    const dir = buildConflictRepo('flow-git-mergectl-', true)
    await attachRoot(window, dir)
    await activateProject(window, dir)
    await openSourceControl(window)
    await expectPanel(window, 'MERGE CHANGES (1)')
    await resolveInEditor(window, dir)

    await expect(window.locator('.gp-merge-complete')).toBeEnabled({ timeout: 15000 })
    await window.locator('.gp-merge-complete').click()
    await expect(async () => {
      expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false)
    }).toPass({ timeout: 30000 })

    const review = dialogs.join('\n')
    expect(review).toContain('shared.txt')
    expect(review).toContain('hunk resolved')
    expect(review).not.toContain('No recorded hunk resolutions')

    const appErrs = appErrors(errors)
    expect(appErrs, appErrs.join(', ')).toHaveLength(0)
  })

  // FIXED (#1287). The PERMANENT record contradicted the
  // review the user just confirmed: the merge summary folded into the commit
  // message (and the flow/merges/*.md doc) is built from a THIRD store
  // (`getMergeResolutionSession`, written by the AI resolve flow) plus the
  // still-unmerged set — which is empty by construction at completion time. So
  // every manually resolved merge is recorded as "0 conflict(s) resolved, risk:
  // safe" even when the confirm dialog listed the resolution one second earlier.
  // buildMergeSummaryInput now folds in the SAME per-resolution store the
  // completion review renders, so one source of truth feeds the review, the
  // doc and the commit trailer.
  test(
    'the merge commit record counts the conflicts the user actually resolved',
    async ({ window }) => {
      window.on('dialog', (d) => void d.accept())

      const dir = buildConflictRepo('flow-git-mergerec-', true)
      await attachRoot(window, dir)
      await activateProject(window, dir)
      await openSourceControl(window)
      await expectPanel(window, 'MERGE CHANGES (1)')
      await resolveInEditor(window, dir)

      await expect(window.locator('.gp-merge-complete')).toBeEnabled({ timeout: 15000 })
      await window.locator('.gp-merge-complete').click()
      await expect(async () => {
        expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false)
      }).toPass({ timeout: 30000 })

      const body = git(dir, 'log', '-1', '--format=%B')
      expect(body).not.toContain('0 conflict(s) resolved')
      expect(body).toContain('1 conflict(s) resolved')
    },
  )

  // FIXED (#1288). The panel's OWN resolve controls (the
  // row "keep this side" buttons, and the section keep-all) never call
  // `recordHunkResolution`, so the stage-and-confirm review that is supposed to
  // show "every resolved hunk in identity terms" shows nothing at all — it reads
  // "No recorded hunk resolutions" immediately after the user resolved the
  // conflict with the panel's own button (contrast: the CONTROL above). They
  // now record a whole-file resolution through the same store.
  test(
    'a conflict resolved from the panel row is named in the completion review',
    async ({ window }) => {
      const dialogs: string[] = []
      window.on('dialog', (d) => {
        dialogs.push(d.message())
        void d.accept()
      })

      const dir = buildConflictRepo('flow-git-mergerow-', true)
      await attachRoot(window, dir)
      await activateProject(window, dir)
      await openSourceControl(window)
      await expectPanel(window, 'MERGE CHANGES (1)')

      await takeFirstSide(window, dir)
      await expect(window.locator('.gp-merge-complete')).toBeEnabled({ timeout: 12000 })
      await window.locator('.gp-merge-complete').click()
      await expect(async () => {
        expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false)
      }).toPass({ timeout: 30000 })

      const review = dialogs.join('\n')
      expect(review).toContain('shared.txt')
      expect(review).not.toContain('No recorded hunk resolutions')
    },
  )
})
