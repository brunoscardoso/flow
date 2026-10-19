import { test, expect } from '../fixtures/electron'
import { dismissFlowOverlay, pickFilesProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX regression probe — flow `editor` (open file / tabs / Monaco / conflict
 * resolve), round 20: the **file-tree context menu** (New File… / New Folder… /
 * Rename… / Delete).
 *
 * Editor is the most-probed flow (24 specs across rounds 4–19: tabs, dirty save,
 * close-ops #735/#827, overflow #700, same-name #991, conflict merge #618,
 * markdown preview #575, external reload #353/#357, project follow, LSP, hidden
 * editor area #1057, find & replace #1146/#1147) — but every one of them drives
 * a file that ALREADY exists. Nobody had driven the surface a user reaches for
 * to *make* and *destroy* files, which is the file tree's right-click menu and
 * the app's only create/delete affordance for paths.
 *
 * Findings (filed):
 *  - #1187 — Delete on a FOLDER is an unwarned, unrecoverable `rm -rf`. The
 *    inline confirm is byte-identical in shape to a single file's
 *    (`Delete service?`), the tree keeps folders collapsed so the user never saw
 *    what was inside, `deleteProjectPath` calls `fsPromises.rm(recursive,
 *    force)` instead of Electron's `shell.trashItem`, and gitignored files
 *    (`.env`, `*.local`) inside have no recovery path at all — `git checkout`
 *    brings back only the tracked ones.
 *  - #1188 — New Folder… inside a COLLAPSED folder is a silent no-op on screen:
 *    the directory is created on disk, the tree neither expands nor shows it,
 *    and there is no toast. New File… at least opens a tab; New Folder… has no
 *    such tell, so the app's only create-folder affordance looks dead.
 *
 * Harness note (worth keeping): chokidar's `unlink` events are UNRELIABLE under
 * macOS `/var/folders` (the `tmpdir()` the shared `seedProject` fixture uses) —
 * `change` events arrive in ~0.5s there while file deletions frequently produce
 * no event at all, which makes a deleted file look like a stale-tab bug. The
 * same actions reconcile in 0.5s from an ordinary directory, so this spec seeds
 * its throwaway repo under `homedir()` and removes it in `afterAll`. Do not
 * "simplify" it back onto `seedProject`.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

function pane(win: Page) {
  return win.locator('.fl-sidebar-pane:visible')
}
function treeRow(win: Page, name: string) {
  return pane(win).getByText(name, { exact: true })
}
function tab(win: Page, name: string) {
  return win.locator('.fl-shell fl-tabs .tab', { hasText: name })
}
function menu(win: Page) {
  return win.locator('.fl-tree-menu')
}

/** Every notification surface's text, flattened (toasts + inbox cards). */
async function feedback(win: Page): Promise<string[]> {
  return win.evaluate(() =>
    [...document.querySelectorAll('.fl-toast, [class*="toast"], [class*="notification"]')]
      .map((n) => (n as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
      .filter(Boolean),
  )
}

const seeded: string[] = []

/** A throwaway git repo under $HOME (see the harness note above) added as a
 *  project root and made the active project. */
async function seedHomeRepo(win: Page, build: (dir: string) => void): Promise<string> {
  const dir = mkdtempSync(join(homedir(), '.flow-ux-ftree-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  // Keep the IDE's own auto-provisioned scaffold out of `git status`.
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n')
  build(dir)
  seeded.push(dir)
  await win.evaluate(async (p) => {
    await (
      window as unknown as { flow: { project: { add(r: { path: string }): Promise<unknown> } } }
    ).flow.project.add({ path: p })
  }, dir)
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, dir)
  await dismissFlowOverlay(win)
  const files = win.locator('[data-rail-item="files"]')
  if (!/\bactive\b/.test((await files.getAttribute('class')) ?? '')) await files.click()
  await pickFilesProject(win)
  // Let the fire-and-forget provisioning scaffold settle so its watcher burst
  // doesn't land in the middle of an assertion.
  await win.waitForTimeout(3000)
  return dir
}

/** Right-click a tree row and wait for its action menu. */
async function ctx(win: Page, row: string): Promise<void> {
  await treeRow(win, row).click({ button: 'right' })
  await expect(menu(win)).toBeVisible()
}

/** Pick a prompting menu item, type a name, submit. */
async function submitName(win: Page, item: string, value: string): Promise<void> {
  await menu(win).getByText(item, { exact: true }).click()
  const input = win.locator('.fl-tree-menu input')
  await expect(input).toBeVisible()
  await input.fill(value)
  await input.press('Enter')
}

test.afterAll(() => {
  while (seeded.length) rmSync(seeded.pop() as string, { recursive: true, force: true })
})

// ── Live coverage ─────────────────────────────────────────────────────────

test('file tree: New File… creates the file, opens it as a tab, and shows it in the tree', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedHomeRepo(window, (d) => {
    writeFileSync(join(d, 'existing.ts'), 'export const E = 1\n')
  })

  await ctx(window, 'existing.ts')
  await expect(menu(window)).toContainText('New File…')
  await submitName(window, 'New File…', 'created.ts')

  // On disk...
  await expect(() => expect(existsSync(join(dir, 'created.ts'))).toBe(true)).toPass({
    timeout: 10000,
  })
  // ...open in the editor...
  await expect(tab(window, 'created.ts')).toHaveCount(1, { timeout: 10000 })
  // ...and visible in the tree (the root is expanded).
  await expect(treeRow(window, 'created.ts')).toHaveCount(1, { timeout: 10000 })

  expect(appErrors(errors)).toEqual([])
})

test('file tree: Rename… moves the file and refuses to clobber an existing name', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedHomeRepo(window, (d) => {
    writeFileSync(join(d, 'before.ts'), 'export const B = 1\n')
    writeFileSync(join(d, 'occupied.ts'), 'export const O = 1\n')
  })

  await ctx(window, 'before.ts')
  await submitName(window, 'Rename…', 'after.ts')
  await expect(() => {
    expect(existsSync(join(dir, 'before.ts'))).toBe(false)
    expect(existsSync(join(dir, 'after.ts'))).toBe(true)
  }).toPass({ timeout: 10000 })
  await expect(treeRow(window, 'after.ts')).toHaveCount(1, { timeout: 10000 })

  // Renaming ONTO an existing file must not silently destroy it (#257's guard).
  await ctx(window, 'after.ts')
  await submitName(window, 'Rename…', 'occupied.ts')
  await window.waitForTimeout(2500)
  expect(existsSync(join(dir, 'after.ts'))).toBe(true)
  expect(existsSync(join(dir, 'occupied.ts'))).toBe(true)
  // ...and the refusal is surfaced, never swallowed (#196).
  const said = (await feedback(window)).join(' | ')
  expect(said).toMatch(/already exists|Couldn't rename/i)

  expect(appErrors(errors)).toEqual([])
})

test('file tree: Delete on a single file confirms first, and Cancel keeps the file', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedHomeRepo(window, (d) => {
    writeFileSync(join(d, 'doomed.ts'), 'export const D = 1\n')
    writeFileSync(join(d, 'spared.ts'), 'export const S = 1\n')
  })

  // Cancel keeps it.
  await ctx(window, 'spared.ts')
  await menu(window).getByText('Delete', { exact: true }).click()
  await expect(menu(window)).toContainText('Delete spared.ts?')
  await menu(window).getByText('Cancel', { exact: true }).click()
  await window.waitForTimeout(1500)
  expect(existsSync(join(dir, 'spared.ts'))).toBe(true)

  // Confirming deletes it, and the tree drops the row.
  await ctx(window, 'doomed.ts')
  await menu(window).getByText('Delete', { exact: true }).click()
  await expect(menu(window)).toContainText('Delete doomed.ts?')
  await menu(window).getByText('Delete', { exact: true }).click()
  await expect(() => expect(existsSync(join(dir, 'doomed.ts'))).toBe(false)).toPass({
    timeout: 10000,
  })
  await expect(treeRow(window, 'doomed.ts')).toHaveCount(0, { timeout: 10000 })

  expect(appErrors(errors)).toEqual([])
})

// ── Tripwires (fix-agnostic; un-fixme when the issues are fixed) ───────────

test(
  '#1187 — Delete on a folder must disclose its blast radius or be recoverable',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedHomeRepo(window, (d) => {
      mkdirSync(join(d, 'service', 'node_modules', 'left-pad'), { recursive: true })
      writeFileSync(join(d, '.gitignore'), '.env\nnode_modules/\n*.local\n')
      writeFileSync(join(d, 'service', 'index.ts'), 'export const svc = 1\n')
      writeFileSync(join(d, 'service', 'server.ts'), 'export const srv = 1\n')
      writeFileSync(join(d, 'service', '.env'), 'STRIPE_KEY=sk_live_realsecret\n')
      writeFileSync(join(d, 'service', 'notes.local'), 'personal notes\n')
      writeFileSync(join(d, 'service', 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n')
      execFileSync('git', ['add', '-A'], { cwd: d })
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
        cwd: d,
      })
    })

    // The user never expands service/ — the tree keeps folders collapsed, so the
    // five files inside were never on screen.
    await expect(treeRow(window, 'index.ts')).toHaveCount(0)
    await ctx(window, 'service')
    await menu(window).getByText('Delete', { exact: true }).click()
    // #1187: the confirm names the FOLDER (it used to read "Delete service?",
    // byte-identical in shape to deleting one file).
    await expect(menu(window)).toContainText('service')
    const confirmText = await menu(window).innerText()
    await window.screenshot({ path: `${SCREENS}/file-tree-folder-delete-confirm.png` })

    // The confirm must say SOMETHING about what is at stake: that it is a
    // directory, how many files, or that it can't be undone.
    expect(
      confirmText,
      'the folder-delete confirm is identical in shape to a single file\'s and never mentions the folder\'s contents or that the delete is permanent',
    ).toMatch(/folder|director|\b\d+\s+(file|item)|can'?t be undone|cannot be undone|permanent/i)

    await menu(window).getByText('Delete', { exact: true }).click()
    await expect(() => expect(existsSync(join(dir, 'service'))).toBe(false)).toPass({
      timeout: 10000,
    })

    // ...and the delete is RECOVERABLE: it goes to the OS trash now, which is
    // the path gitignored contents never had (#1187). The trash itself isn't
    // portably inspectable from here, so what this asserts is the contract the
    // user is shown — the confirm promises the Trash — plus the fact that the
    // tracked half still restores from git, i.e. the delete didn't do something
    // stranger than advertised.
    expect(confirmText).toMatch(/trash/i)
    execFileSync('git', ['checkout', '--', '.'], { cwd: dir })
    const restored = existsSync(join(dir, 'service')) ? readdirSync(join(dir, 'service')) : []
    expect(restored).toEqual(expect.arrayContaining(['index.ts', 'server.ts']))

    expect(appErrors(errors)).toEqual([])
  },
)

test(
  '#1188 — New Folder… inside a collapsed folder must show up somewhere on screen',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedHomeRepo(window, (d) => {
      mkdirSync(join(d, 'packages'), { recursive: true })
      writeFileSync(join(d, 'packages', 'p.ts'), 'export const P = 1\n')
    })

    // `packages` is collapsed — its child isn't rendered.
    await expect(treeRow(window, 'p.ts')).toHaveCount(0)

    await ctx(window, 'packages')
    await submitName(window, 'New Folder…', 'brandnew')
    await expect(() => expect(existsSync(join(dir, 'packages', 'brandnew'))).toBe(true)).toPass({
      timeout: 10000,
    })
    await window.waitForTimeout(3000)
    await window.screenshot({ path: `${SCREENS}/file-tree-new-folder-revealed.png` })

    const visible = await treeRow(window, 'brandnew').count()
    const said = (await feedback(window)).join(' | ')
    expect(
      visible > 0 || /brandnew/i.test(said),
      'the folder was created on disk but the tree never expanded to show it and nothing was announced — the only create-folder affordance in the app looks dead',
    ).toBe(true)

    expect(appErrors(errors)).toEqual([])
  },
)
