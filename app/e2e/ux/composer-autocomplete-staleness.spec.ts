import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): the LIFETIME of the two autocomplete caches.
 *
 * Prior flow-3 coverage (20 committed specs) exercises what the `@`-file and
 * `/`-skill popups do with a listing they already have — arrow nav, deep-path
 * descend, mid-text insertion, the #391 cold-cache range race, dismissal. None
 * asks whether the listing is still TRUE. `Composer` holds two caches:
 *
 *   #dirCache  Map<relPath, DirectoryEntry[]>   (composer.ts:142)
 *   #commands  SlashCommand[] | null            (composer.ts:148)
 *
 * and both are cleared in exactly ONE place — `setThread()` (composer.ts:531-532).
 * The composer is the only renderer surface that never subscribes to
 * `project.onFileChanged`; the file tree, editor, review panel, git panel and
 * blueprint board all do. So a project that changes while the user sits in one
 * thread is invisible to the composer's autocompletes.
 *
 * `#listCommands` compounds it: `if (this.#commands) return this.#commands`
 * (composer.ts:1259) — `[]` is truthy, so a listing fetched before provisioning
 * has written `.claude/commands/` is cached EMPTY and never refetched.
 *
 * The live tests below are the controls that make those two failures
 * attributable to the caches (the IPC channels themselves are live, and a
 * thread switch does restore truth). The two tripwires assert the user-facing
 * promise and are fix-agnostic (they assert what the popup offers, not how the
 * cache is cleared). Fixed in #1123/#1124: a fresh `/`/`@` session refetches
 * (an empty command listing is never trusted as warm cache), and
 * project.onFileChanged invalidates both caches mid-session.
 */

const MENTION_POPUP = '.fl-composer-mentions:not(.fl-composer-commands)'
const COMMAND_POPUP = '.fl-composer-commands'
const SCREENS = 'e2e/ux/__screens'

async function createThread(win: Page, root: string, title: string): Promise<void> {
  await win.evaluate(
    async ({ root, title }) => {
      await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow.threads.create({ projectRoot: root, title })
    },
    { root, title },
  )
}

function populate(dir: string): void {
  writeFileSync(join(dir, 'README.md'), '# root\n')
  writeFileSync(join(dir, 'DOOMED.md'), '# doomed\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), '// x\n')
}

async function openComposer(win: Page, title: string): Promise<string> {
  const root = await seedProject(win)
  populate(root)
  await activateProject(win, root)
  await createThread(win, root, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
  return root
}

/** Wait until IDE provisioning has written the bundled slash commands. */
async function waitForCommands(win: Page, root: string): Promise<number> {
  const dir = join(root, '.claude', 'commands')
  for (let i = 0; i < 60; i++) {
    if (existsSync(dir) && readdirSync(dir).length > 5) break
    await win.waitForTimeout(500)
  }
  return existsSync(dir) ? readdirSync(dir).length : 0
}

/** Rows currently offered by a popup (empty when it is closed). */
async function rowsOf(win: Page, popup: string, rowSel: string): Promise<string[]> {
  const el = win.locator(popup)
  if (!(await el.isVisible())) return []
  return el.locator(rowSel).allInnerTexts()
}

async function typeQuery(win: Page, query: string): Promise<void> {
  const textarea = win.locator('.fl-composer-input textarea')
  await textarea.click()
  await textarea.fill('')
  await textarea.type(query)
  await win.waitForTimeout(800)
}

test.afterAll(() => cleanupSeeds())

// ── Live guard 1 ────────────────────────────────────────────────────────────
// The `/` popup DOES list provisioned skills when the composer binds after
// provisioning. This is the control that makes the cold-start failure below
// attributable to the CACHE rather than to a missing channel or missing files.
test('/-skill: the popup lists the provisioned skills when bound after provisioning', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const root = await seedProject(window)
  populate(root)
  await activateProject(window, root)
  const onDisk = await waitForCommands(window, root)
  expect(onDisk).toBeGreaterThan(5)

  // Bind the composer AFTER the commands exist on disk.
  await createThread(window, root, 'warm-slash')
  await window.getByText('warm-slash', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()

  await typeQuery(window, '/')
  const rows = await rowsOf(window, COMMAND_POPUP, '.fl-composer-command-name')
  expect(rows.length, 'the / popup offers the provisioned skills').toBeGreaterThan(5)
  expect(rows).toContain('/create-plan')
  expect(errors, 'no uncaught errors').toEqual([])
})

// ── Live guard 2 ────────────────────────────────────────────────────────────
// The DATA SOURCES are live: project:listDir and project:listCommands both
// report a mid-session create immediately. Only the composer's copies are
// stale — this pins the defect to the renderer cache.
test('the project channels report a mid-session create immediately (data source is live)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const root = await openComposer(window, 'source-live')
  await waitForCommands(window, root)

  // Create a file the way the Files tree does, and a skill the way /setup does.
  await window.evaluate(async (rootPath) => {
    await (
      window as unknown as {
        flow: {
          project: {
            createPath(r: {
              rootPath: string
              relPath: string
              kind: 'file' | 'directory'
            }): Promise<unknown>
          }
        }
      }
    ).flow.project.createPath({ rootPath, relPath: 'NOTES-zebra.md', kind: 'file' })
  }, root)
  mkdirSync(join(root, '.claude', 'commands'), { recursive: true })
  writeFileSync(join(root, '.claude', 'commands', 'qaprobe.md'), '# qaprobe\n')
  await window.waitForTimeout(1200)

  const seen = await window.evaluate(async (rootPath) => {
    const w = window as unknown as {
      flow: {
        project: {
          listDir(r: { rootPath: string }): Promise<Array<{ name: string }>>
          listCommands(r: { rootPath: string }): Promise<Array<{ name: string }>>
        }
      }
    }
    const [files, commands] = await Promise.all([
      w.flow.project.listDir({ rootPath }),
      w.flow.project.listCommands({ rootPath }),
    ])
    return { files: files.map((f) => f.name), commands: commands.map((c) => c.name) }
  }, root)

  expect(seen.files, 'listDir sees the new file').toContain('NOTES-zebra.md')
  expect(seen.commands, 'listCommands sees the new skill').toContain('qaprobe')
  expect(errors, 'no uncaught errors').toEqual([])
})

// ── Live guard 3 ────────────────────────────────────────────────────────────
// A thread SWITCH does refresh the mention listing (setThread clears #dirCache).
// This is the isolating control: the same file that `@` refuses below becomes
// mentionable purely by switching away and back — nothing on disk changed.
test('@-file: a thread switch re-reads the directory listing (the cache is the variable)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const root = await openComposer(window, 'switch-refresh')

  // Warm the root listing.
  await typeQuery(window, '@')
  await expect(window.locator(MENTION_POPUP)).toBeVisible()
  await window.keyboard.press('Escape')

  await window.evaluate(async (rootPath) => {
    await (
      window as unknown as {
        flow: {
          project: {
            createPath(r: {
              rootPath: string
              relPath: string
              kind: 'file' | 'directory'
            }): Promise<unknown>
          }
        }
      }
    ).flow.project.createPath({ rootPath, relPath: 'NOTES-zebra.md', kind: 'file' })
  }, root)
  await window.waitForTimeout(1000)

  // Switch away and back — setThread() clears #dirCache on both hops.
  await createThread(window, root, 'switch-refresh-b')
  await window.getByText('switch-refresh-b', { exact: true }).click()
  await window.waitForTimeout(400)
  await window.getByText('switch-refresh', { exact: true }).first().click()
  await window.waitForTimeout(400)

  await typeQuery(window, '@NOTES')
  const rows = await rowsOf(window, MENTION_POPUP, '.fl-composer-mention-row')
  expect(rows.join('|'), 'after a thread switch the new file is mentionable').toContain(
    'NOTES-zebra.md',
  )
  await window.locator('.fl-composer-input textarea').fill('')
  expect(errors, 'no uncaught errors').toEqual([])
})

// ── Tripwire 1 (#1123 — fixed) ──────────────────────────────────────────────
// First-run: press `/` while provisioning is still writing `.claude/commands`.
// `#commands` used to cache the empty array (truthy) and the popup stayed dead
// for the whole thread. Now an empty listing is never trusted as warm cache and
// every fresh `/` session refetches, so the popup recovers as soon as the
// skills land on disk.
test(
  '/-skill: the popup recovers once provisioning lands the skills (cold first-run)',
  async ({ window }) => {
    const root = await seedProject(window)
    writeFileSync(join(root, 'README.md'), '# root\n')
    await activateProject(window, root)
    await createThread(window, root, 'cold-slash')
    await window.getByText('cold-slash', { exact: true }).click()
    await expect(window.locator(sel.composer)).toBeVisible()

    // The user tries `/` immediately — before provisioning has written anything.
    await typeQuery(window, '/')
    const cold = await rowsOf(window, COMMAND_POPUP, '.fl-composer-command-name')
    await window.locator('.fl-composer-input textarea').fill('')

    const onDisk = await waitForCommands(window, root)
    await window.waitForTimeout(1500)

    // Try again, same thread. The skills exist now — the popup must show them.
    await typeQuery(window, '/')
    const warm = await rowsOf(window, COMMAND_POPUP, '.fl-composer-command-name')
    await window.screenshot({ path: `${SCREENS}/composer-cold-slash.png` })

    expect(
      warm.length,
      `pressing / before provisioning finished poisoned the skill list for the whole thread: ` +
        `cold=${cold.length}, ${onDisk} skills on disk, popup still offers ${warm.length}`,
    ).toBeGreaterThan(5)
  },
)

// ── Tripwire 2 (#1124 — fixed) ──────────────────────────────────────────────
// The @-file popup used to be frozen at first use, in BOTH directions. Now a
// fresh `@` session drops `#dirCache` (and project.onFileChanged invalidates
// it mid-session), so the popup tracks files created and deleted live.
test(
  '@-file: the popup tracks files created and deleted during the session',
  async ({ window }) => {
    const root = await openComposer(window, 'fs-drift')

    // Warm the root listing (DOOMED.md is present).
    await typeQuery(window, '@DOOM')
    await expect(window.locator(MENTION_POPUP)).toBeVisible()
    await window.keyboard.press('Escape')
    await window.locator('.fl-composer-input textarea').fill('')

    // The user creates one file and deletes another, through the app's own
    // Files-tree channels.
    await window.evaluate(async (rootPath) => {
      const w = window as unknown as {
        flow: {
          project: {
            createPath(r: {
              rootPath: string
              relPath: string
              kind: 'file' | 'directory'
            }): Promise<unknown>
            deletePath(r: { rootPath: string; relPath: string }): Promise<unknown>
          }
        }
      }
      await w.flow.project.createPath({ rootPath, relPath: 'NOTES-zebra.md', kind: 'file' })
      await w.flow.project.deletePath({ rootPath, relPath: 'DOOMED.md' })
    }, root)
    await window.waitForTimeout(1500)

    await typeQuery(window, '@NOTES')
    const created = await rowsOf(window, MENTION_POPUP, '.fl-composer-mention-row')
    await window.locator('.fl-composer-input textarea').fill('')

    await typeQuery(window, '@DOOM')
    const deleted = await rowsOf(window, MENTION_POPUP, '.fl-composer-mention-row')
    await window.screenshot({ path: `${SCREENS}/composer-mention-drift.png` })
    await window.locator('.fl-composer-input textarea').fill('')

    expect(
      created.join('|'),
      `a file created during the session is not offered by @ (popup offered ${JSON.stringify(created)})`,
    ).toContain('NOTES-zebra.md')
    expect(
      deleted.join('|'),
      `a file deleted during the session is STILL offered by @ (popup offered ${JSON.stringify(deleted)})`,
    ).not.toContain('DOOMED.md')
  },
)
