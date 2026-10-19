/**
 * UX sweep — flow `project` (rotation index 1, round 21): a project folder that
 * is NOT the whole git repository, and what Source Control's Commit actually
 * takes when the repo index holds more than the project does.
 *
 * `ProjectRegistry.addRoot` only checks `isDirectory` and dedupes on exact
 * path, so both shapes below are ordinary "Open Project" outcomes:
 *
 *   A. ONE project = `mono/packages/app` — a package folder inside a bigger
 *      repo. Explicitly supported: #1040 anchored `GitManager` on
 *      `rev-parse --show-toplevel` and scopes the LISTING to the project
 *      subtree (`scopeChangesToProject`).
 *   B. TWO projects = `mono` AND `mono/packages/app` — two project roots in
 *      ONE repo, attachable through the real "New thread" chooser (#45/#131).
 *      `GitManager` designs for it (one chokidar watcher per resolved git dir,
 *      fanned out to the N roots anchored there). Two projects, one index.
 *
 * Every prior flow-1 probe attaches DISJOINT repos — the shared `seedProject`
 * fixture `git init`s each throwaway dir, so `project.spec`, `project-manage`,
 * `project-switch-reorder`, `project-group-switch`, `project-samename-…`,
 * `project-git-panel-rebind`, `project-open-already-added` (#1008),
 * `project-repo-root-mismatch` (#1040), `project-relaunch-restore` (#1080),
 * `project-live-vanish` (#1118) and `git-multiroot-groups` all drive one repo
 * per project. Nobody had put something in the index that the project's own
 * panel does not list, and then pressed Commit.
 *
 *  - Guard 1 (A) — the listing scope holds (#1040) and the Commit button is
 *    gated on the panel's OWN staged count (`commitBoxState`, #335): a file
 *    staged outside the project subtree is invisible AND does not arm Commit.
 *  - Guard 2 (B) — both roots attach through the real chooser, each group lists
 *    only its own subtree, and a group with nothing of its own staged keeps its
 *    Commit disabled while the shared index is non-empty.
 *    Both guards are the control that makes the tripwires non-vacuous: the panel
 *    really does promise per-project scope.
 *  - Tripwires (#1209, fix-agnostic) — the promise breaks at the action.
 *    `onCommit` (`renderer/git/index.ts:297`) calls `git:commitIndex`, and
 *    `GitManager.commitIndex` runs `git commit -m <msg>` at the REPO toplevel
 *    with NO pathspec, so the commit takes the whole index — including files
 *    the panel never listed, under the project's message. The Review panel had
 *    exactly this defect and was fixed by scoping the commit to the group's own
 *    files (#1051, `renderer/review/index.ts:150-158`); the git panel was not.
 *
 * Account-independent (git only, no agent, no network). No native dialog is
 * involved: roots are attached through `project:add`, the same code path
 * `project:open` runs after the user picks a folder.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, gitRetry, openThreadByTitle } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const SHOTS = join(__dirname, '__screens')

/** A monorepo: `README.md` at the root and `packages/app/main.ts` in a package,
 *  both committed, then both edited in the working tree. */
function monorepo(dir: string): void {
  gitRetry(dir, 'config', 'user.email', 'qa@flow.test')
  gitRetry(dir, 'config', 'user.name', 'QA Bot')
  mkdirSync(join(dir, 'packages', 'app'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# mono\n')
  writeFileSync(join(dir, 'packages', 'app', 'main.ts'), 'export const a = 1\n')
  gitRetry(dir, 'add', '-A')
  gitRetry(dir, 'commit', '-q', '-m', 'feat: monorepo base')
  writeFileSync(join(dir, 'README.md'), '# mono\nROOT EDIT\n')
  writeFileSync(join(dir, 'packages', 'app', 'main.ts'), 'export const a = 2\n')
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

/** Drop a seeded root. `removeProject` cascades (its tasks + threads go too),
 *  which is a no-op here — every root this spec removes is a freshly seeded
 *  repo that owns neither. */
async function removeRoot(win: Page, path: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { remove(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.remove({ rootPath: p })
  }, path)
}

async function openSourceControl(win: Page): Promise<void> {
  await win.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await win.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(win.locator('.gp-root')).toBeVisible()
}

/** SHAPE A — exactly one project, and it is `mono/packages/app`. */
async function openPackageProject(win: Page): Promise<{ mono: string; child: string }> {
  const mono = await seedProject(win, 'flow-ux-sub-', monorepo)
  const child = join(mono, 'packages', 'app')
  await addRoot(win, child)
  await activateProject(win, child)
  await removeRoot(win, mono) // exactly one project open — no group chrome
  await openSourceControl(win)
  await expect(win.locator('.gp-name', { hasText: 'main.ts' })).toHaveCount(1, { timeout: 30_000 })
  return { mono, child }
}

/** SHAPE B — `mono` and `mono/packages/app` both open, one thread spanning both
 *  (created through the REAL "New thread" chooser). */
async function openOverlappingProjects(win: Page): Promise<{ mono: string; child: string }> {
  const mono = await seedProject(win, 'flow-ux-mono-', monorepo)
  await activateProject(win, mono)
  const child = join(mono, 'packages', 'app')
  await addRoot(win, child)

  // A thread over BOTH projects. The "Projects for this thread" dialog this
  // ticked became the new-thread page's project chips, and that page's Create
  // sends a first message; the thread is made over the same IPC instead
  // (`additionalRoots` is exactly what the chips send) and opened by its row.
  await win.evaluate(
    async ({ projectRoot, additionalRoots }) => {
      await (
        window as unknown as {
          flow: {
            threads: {
              create(i: { projectRoot: string; title: string; additionalRoots: string[] }): Promise<unknown>
            }
          }
        }
      ).flow.threads.create({ projectRoot, title: 'Two projects, one repo', additionalRoots })
    },
    { projectRoot: mono, additionalRoots: [child] },
  )
  await openThreadByTitle(win, 'Two projects, one repo')

  await openSourceControl(win)
  await expect(win.locator('.gp-group-head')).toHaveCount(2, { timeout: 30_000 })
  return { mono, child }
}

const groupFor = (win: Page, dir: string) =>
  win.locator('.gp-group', { has: win.locator('.gp-group-name', { hasText: basename(dir) }) })

/** Stage one row via its per-row Stage button (rows live in an open shadow DOM,
 *  so locate by `.gp-name` — `querySelectorAll` never sees them). */
async function stageRow(scope: ReturnType<typeof groupFor> | Page, win: Page, name: string) {
  await scope
    .locator('.gp-row', { has: win.locator('.gp-name', { hasText: name }) })
    .first()
    .locator('.gp-action-btn[title="Stage"]')
    .click()
}

/** Filenames in the tip commit, repo-relative. */
function commitFiles(repo: string): string[] {
  return gitRetry(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').filter(Boolean)
}

test.afterAll(() => cleanupSeeds())

test.describe('a project that is a subfolder of its repo — commit scope', () => {
  test('the panel lists only the project subtree, and Commit is gated on the panel’s own staged count', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const { mono } = await openPackageProject(window)

    // Something outside the project folder is staged (the user's own terminal,
    // another editor, or the agent). #1040 scoping hides it — correctly.
    gitRetry(mono, 'add', 'README.md')
    await expect(window.locator('.gp-name', { hasText: 'README.md' })).toHaveCount(0)
    await expect(window.locator('.gp-section-head', { hasText: 'STAGED' })).toHaveCount(0, {
      timeout: 15_000,
    })

    // …and it does not arm Commit either: the button counts only what the panel
    // shows. That is the panel's promise of project scope.
    await window.locator('.gp-commit-msg').fill('fix: package change')
    await expect(window.locator('.gp-commit-btn')).toBeDisabled()

    expect(errors, errors.join(', ')).toHaveLength(0)
  })

  // TRIPWIRE (#1209) — fix-agnostic: whatever scoping the fix uses, Commit must
  // take only what the panel showed as staged for THIS project.
  test(
    'Commit takes only the project’s own staged file, not one staged outside the project folder',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(e.message))

      const { mono } = await openPackageProject(window)
      gitRetry(mono, 'add', 'README.md') // staged outside the project folder

      await stageRow(window, window, 'main.ts')
      await expect(window.locator('.gp-section-head', { hasText: 'STAGED CHANGES (1)' })).toHaveCount(
        1,
        { timeout: 15_000 },
      )
      await window.locator('.gp-commit-msg').fill('fix: package change')
      await expect(window.locator('.gp-commit-btn')).toBeEnabled()
      await window.screenshot({ path: join(SHOTS, 'project-subfolder-commit-scope.png') })

      await window.locator('.gp-commit-btn').click()
      await expect
        .poll(() => gitRetry(mono, 'log', '-1', '--format=%s').trim(), { timeout: 20_000 })
        .toBe('fix: package change')

      const committed = commitFiles(mono)
      expect(
        committed,
        `the panel showed 1 staged file (main.ts) but the commit took ${committed.length}: ${committed.join(', ')}`,
      ).toEqual(['packages/app/main.ts'])
      expect(gitRetry(mono, 'status', '--porcelain').trim()).toContain('README.md')
      expect(errors, errors.join(', ')).toHaveLength(0)
    },
  )
})

test.describe('two projects in one repo — Source Control group scope', () => {
  test('each group lists only its own subtree, and a group with nothing staged keeps Commit disabled', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const { mono, child } = await openOverlappingProjects(window)
    const gMono = groupFor(window, mono)
    const gApp = groupFor(window, child)

    await expect(gMono.locator('.gp-name', { hasText: 'README.md' })).toHaveCount(1)
    await expect(gMono.locator('.gp-name', { hasText: 'main.ts' })).toHaveCount(1)
    await expect(gApp.locator('.gp-name', { hasText: 'main.ts' })).toHaveCount(1)
    await expect(gApp.locator('.gp-name', { hasText: 'README.md' })).toHaveCount(0)

    await stageRow(gMono, window, 'README.md')
    await expect(gMono.locator('.gp-section-head', { hasText: 'STAGED CHANGES (1)' })).toHaveCount(
      1,
      { timeout: 15_000 },
    )
    await gApp.locator('.gp-commit-msg').fill('fix: app only')
    await expect(gApp.locator('.gp-commit-btn')).toBeDisabled()
    await expect(gApp.locator('.gp-section-head', { hasText: 'STAGED' })).toHaveCount(0)

    expect(errors, errors.join(', ')).toHaveLength(0)
  })

  // TRIPWIRE (#1209) — the same defect between two projects: the package group's
  // Commit must not consume the monorepo group's staged work.
  test(
    'committing in the package group leaves the monorepo group’s staged file alone',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(e.message))

      const { mono, child } = await openOverlappingProjects(window)
      const gMono = groupFor(window, mono)
      const gApp = groupFor(window, child)

      await stageRow(gMono, window, 'README.md')
      await expect(gMono.locator('.gp-section-head', { hasText: 'STAGED CHANGES (1)' })).toHaveCount(
        1,
        { timeout: 15_000 },
      )
      await stageRow(gApp, window, 'main.ts')
      await expect(gApp.locator('.gp-section-head', { hasText: 'STAGED CHANGES (1)' })).toHaveCount(
        1,
        { timeout: 15_000 },
      )
      await gApp.locator('.gp-commit-msg').fill('fix: app only')
      await expect(gApp.locator('.gp-commit-btn')).toBeEnabled()
      await window.screenshot({ path: join(SHOTS, 'project-nested-commit-scope.png') })

      await gApp.locator('.gp-commit-btn').click()
      await expect
        .poll(() => gitRetry(mono, 'log', '-1', '--format=%s').trim(), { timeout: 20_000 })
        .toBe('fix: app only')

      const committed = commitFiles(mono)
      expect(
        committed,
        `the package group showed 1 staged file (main.ts) but the commit took ${committed.length}: ${committed.join(', ')}`,
      ).toEqual(['packages/app/main.ts'])
      expect(gitRetry(mono, 'status', '--porcelain').trim()).toContain('README.md')
      expect(errors, errors.join(', ')).toHaveLength(0)
    },
  )
})
