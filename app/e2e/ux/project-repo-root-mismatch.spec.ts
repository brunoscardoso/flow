/**
 * UX sweep — flow `project` (rotation index 1, round 17): the project root is
 * NOT the git repo root.
 *
 * Every prior flow-1 probe (project.spec, project-manage, project-group-switch,
 * project-switch-reorder, project-active-invariants, project-samename-…,
 * project-git-panel-rebind, project-switcher-overflow, project-open-already-added)
 * opens a folder that is itself a fresh `git init` repo — the shared
 * `seedProject` fixture always does exactly that. So the two shapes a real user
 * reaches constantly were never driven:
 *
 *   A. The folder is NOT a repository at all (a brand-new project directory, a
 *      notes folder). `ProjectRegistry.addRoot` only checks `isDirectory`, and
 *      the git layer is deliberately graceful (`GitManager.status` returns null
 *      on "not a git repository" → the panel's "Not a git repository" notice).
 *      Guards 1-2 pin that this stays coherent, including across a switch.
 *
 *   B. The folder is a SUBDIRECTORY of a repository (`monorepo/app`, the normal
 *      way a package is opened). Was broken — filed as #1040, fixed by
 *      anchoring GitManager on `rev-parse --show-toplevel`: `git status
 *      --porcelain` reports paths relative to the REPO root, and GitManager now
 *      runs every operation at that root, translating project-relative paths
 *      at the API boundary and scoping status to the project subtree. Guard 3
 *      is the honest-repo control that proves the staging recipe works; guard 4
 *      is the #1040 tripwire (formerly a fixme).
 *
 * Account-independent (git only, no agent, no network). No native dialog is
 * involved: roots are attached through `project:add`, the same code path
 * `project:open` runs after the user picks a folder.
 */
import { basename, join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds, pickFilesProject } from './fixtures/seed'

const SHOTS = join(__dirname, '__screens')
const scratchDirs: string[] = []

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

function identify(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/** Attach `path` as a project root — what `project:open` does after
 *  the user picks a folder in the (Playwright-invisible) native dialog. */
async function addRoot(win: Page, path: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, path)
}

/** A plain, NOT git-initialized folder, attached as a project root. */
async function seedPlainFolder(win: Page, prefix: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, 'NOGIT_MARKER.txt'), 'plain folder\n')
  scratchDirs.push(dir)
  await addRoot(win, dir)
  return dir
}

/**
 * A repo with a committed-then-edited file inside `app/` and another inside
 * `docs/`. Returns the repo root; `<repo>/app` is what the subdirectory guards
 * open as the project.
 */
function seedRepoWithSubdirs(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(repo)
  git(repo, 'init', '-q')
  identify(repo)
  mkdirSync(join(repo, 'app'), { recursive: true })
  mkdirSync(join(repo, 'docs'), { recursive: true })
  writeFileSync(join(repo, 'app', 'inside.txt'), 'v0\n')
  writeFileSync(join(repo, 'docs', 'outside.txt'), 'v0\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'baseline')
  writeFileSync(join(repo, 'app', 'inside.txt'), 'v1 edited\n')
  writeFileSync(join(repo, 'docs', 'outside.txt'), 'v1 edited\n')
  return repo
}

/**
 * The ACTIVE project's folder name. The titlebar no longer names it — the
 * switcher names the Workspace since the hard migration ("Default", or
 * "Setting up your Workspace…" while that runs) — so this asks the app which
 * project is active, the fact the old label stood for.
 */
async function activeProjectName(win: Page): Promise<string> {
  const root = await win.evaluate(async () => {
    const context = await (
      window as unknown as { flow: { project: { active(): Promise<{ rootPath?: string } | null> } } }
    ).flow.project.active()
    return context?.rootPath ?? ''
  })
  return basename(root)
}

async function selectRail(win: Page, id: 'threads' | 'files' | 'source-control'): Promise<void> {
  await win.locator(`.fl-activity-bar [data-rail-item="${id}"]`).click()
}

/** Reveal Source Control → Changes and wait for the git panel to mount.
 *
 *  Only clicks the rail when the pane isn't already showing: re-clicking the
 *  ACTIVE rail item collapses the sidebar by design (shell.ts onRailSelect), and
 *  side-panel selection is per-project, so after a switch the pane may already
 *  be up — an unconditional click would close it. */
async function openChanges(win: Page): Promise<void> {
  if (!(await win.locator('.fl-sc-body').isVisible().catch(() => false))) {
    await selectRail(win, 'source-control')
  }
  await win.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(win.locator('.gp-root')).toBeVisible()
}

/** Hover a change row and click its inline "Stage" (+) action. */
async function stageRow(win: Page, name: string): Promise<void> {
  const row = win.locator('.gp-row', { hasText: name }).first()
  await row.hover()
  await row.locator('.gp-row-actions button[title="Stage"]').click()
}

test.describe('project root vs git repo root', () => {
  test.afterAll(() => {
    cleanupSeeds()
    while (scratchDirs.length) rmSync(scratchDirs.pop()!, { recursive: true, force: true })
  })

  test('a folder that is not a repository is still a usable project', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const plain = await seedPlainFolder(window, 'flow-nongit-')
    await activateProject(window, plain)
    await expect.poll(() => activeProjectName(window)).toBe(basename(plain))

    // Files rail: the folder's contents load like any other project.
    await selectRail(window, 'files')
    await pickFilesProject(window)
    const filesPane = window.locator('.fl-sidebar-pane:visible')
    await expect(filesPane.getByText('NOGIT_MARKER.txt')).toBeVisible({ timeout: 8000 })

    // Source Control: an explicit notice, and NO repo affordances that would be
    // dead clicks (no branch header, no commit box).
    await openChanges(window)
    await expect(window.locator('.gp-empty', { hasText: 'Not a git repository' })).toBeVisible({
      timeout: 8000,
    })
    await expect(window.locator('.gp-branch-name')).toHaveCount(0)
    await expect(window.locator('.gp-commit-box, .gp-commit-input')).toHaveCount(0)
    await window.screenshot({ path: `${SHOTS}/project-nongit-source-control.png` })

    expect(errors, errors.join(', ')).toEqual([])
  })

  test('switching between a repo project and a non-repo project rebinds both ways', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const repo = await seedProject(window, 'flow-nongit-repo-', (dir) => {
      identify(dir)
      writeFileSync(join(dir, 'REPO_ONLY.txt'), 'r\n')
      git(dir, 'add', 'REPO_ONLY.txt')
      git(dir, 'commit', '-q', '-m', 'baseline')
    })
    const plain = await seedPlainFolder(window, 'flow-nongit-plain-')

    await activateProject(window, repo)
    await openChanges(window)
    await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 10000 })

    // → non-repo project: the branch header must go, the notice must appear.
    // (Side-panel selection is per-project — #panels-per-project-persist — so
    // re-reveal Source Control after each switch rather than assuming it stuck.)
    await activateProject(window, plain)
    await dismissFlowOverlay(window)
    await openChanges(window)
    await expect(window.locator('.gp-empty', { hasText: 'Not a git repository' })).toBeVisible({
      timeout: 8000,
    })
    await expect(window.locator('.gp-branch-name')).toHaveCount(0)

    // → back to the repo project: the branch header must come back.
    await activateProject(window, repo)
    await openChanges(window)
    await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 10000 })
    await expect(window.locator('.gp-empty', { hasText: 'Not a git repository' })).toHaveCount(0)

    expect(errors, errors.join(', ')).toEqual([])
  })

  test('CONTROL: opening the repo ROOT lists only its own changes and Stage works', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const repo = seedRepoWithSubdirs('flow-reporoot-')
    await addRoot(window, repo)
    await activateProject(window, repo)
    await openChanges(window)

    // Both edited files belong to this project, and their paths resolve.
    await expect(window.locator('.gp-row', { hasText: 'inside.txt' })).toHaveCount(1)
    await expect(window.locator('.gp-row', { hasText: 'outside.txt' })).toHaveCount(1)

    await stageRow(window, 'inside.txt')
    await expect(async () => {
      expect(git(repo, 'diff', '--cached', '--name-only')).toContain('app/inside.txt')
    }).toPass({ timeout: 8000 })
    await expect(window.locator('.gp-section')).toContainText('Staged Changes', { timeout: 8000 })

    expect(errors, errors.join(', ')).toEqual([])
  })

  test(
    '#1040: a project opened at a repo SUBDIRECTORY scopes and stages correctly',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))

      const repo = seedRepoWithSubdirs('flow-subdir-')
      const sub = join(repo, 'app')
      await addRoot(window, sub)
      await activateProject(window, sub)
      await expect.poll(() => activeProjectName(window)).toBe('app')

      await openChanges(window)
      await expect(window.locator('.gp-row', { hasText: 'inside.txt' })).toHaveCount(1)

      // A sibling folder's change is NOT part of this project.
      await expect(window.locator('.gp-row', { hasText: 'outside.txt' })).toHaveCount(0)

      // The diff must show the working-tree edit, not an empty/HEAD-only side.
      await window.locator('.gp-row', { hasText: 'inside.txt' }).first().click()
      await expect(window.locator('.gd-body')).toContainText('v1 edited', { timeout: 8000 })
      await window.locator('.gd-close:not(.gd-open)').click()

      // Stage must actually stage — pre-#1040: "Couldn't stage … pathspec
      // 'app/inside.txt' did not match any files", and the index stayed empty.
      await stageRow(window, 'inside.txt')
      await expect(async () => {
        expect(git(repo, 'diff', '--cached', '--name-only')).toContain('app/inside.txt')
      }).toPass({ timeout: 8000 })
      await expect(
        window.locator('.fl-flow-toast', { hasText: "Couldn't stage" }),
      ).toHaveCount(0)

      expect(errors, errors.join(', ')).toEqual([])
    },
  )
})
