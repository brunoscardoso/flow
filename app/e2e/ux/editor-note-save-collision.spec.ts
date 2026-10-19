import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, dismissFlowOverlay, pickFilesProject } from './fixtures/seed'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX regression probe — flow `editor` (open file / tabs / Monaco / conflict
 * resolve), round 24: the **"Save note as" write** — the one place in the app
 * where the user types a *destination path* for content and Flow writes it.
 *
 * Editor is the most-probed flow (25+ specs across rounds 4–23: tabs, dirty
 * save, close-ops #735/#827, overflow #700, same-name #991, conflict merge
 * #618, markdown preview #575, external reload #353/#357, project follow, LSP,
 * hidden editor #1057, find & replace #1146/#1147, file-tree menu #1187/#1188,
 * agent-edit review #1290/#1291, Edit menu #1338, Finder drops #1339). The ⌘N
 * scratch note (#941) has exactly ONE spec — `editor-new-note.spec.ts` — and it
 * drives only the happy path: a fresh name, into a folder that doesn't exist
 * yet, which succeeds. Nobody had asked what the name prompt does when the name
 * is already TAKEN, or when the write FAILS.
 *
 * Two defects found and filed (both in `saveUntitled`, `editor/index.ts:1069`):
 *
 *  - #1384 — naming a note after an existing file silently DESTROYS that file.
 *    `saveUntitled` calls `project:writeFile` straight from the typed name
 *    with no existence check, and `writeProjectFile` is an unconditional
 *    atomic replace (correct for an ordinary ⌘S, which owns its path). The
 *    sibling create affordance one menu away knows better: `createProjectPath`
 *    refuses a collision (`Path already exists`, plus `'wx'` on the write) and
 *    the tree reports it as a toast (#196). Test 1's control drives exactly
 *    that contrast on the SAME file in the SAME repo.
 *
 *  - #1385 — a note save that fails tells the user nothing. `saveUntitled`'s catch
 *    is `console.error` + `return false`: the name bar closes like a success,
 *    the tab stays `Untitled-N` and dirty, and no toast/inbox entry ever fires.
 *    This is verbatim the harm #195 fixed for the ordinary save path — whose
 *    own header comment even enumerates this failure mode ("path became a
 *    directory") — on the sibling path the fix never reached.
 *
 * Both confirmed end-to-end against the built app with zero uncaught renderer
 * errors. Un-fixme each tripwire when its fix lands.
 */

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Every notification surface's text, flattened (toasts + inbox cards). */
async function feedback(win: Page): Promise<string[]> {
  return win.evaluate(() =>
    [...document.querySelectorAll('.fl-flow-toast, .fl-toast, [class*="toast"], [class*="notification"]')]
      .map((n) => (n as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
      .filter(Boolean),
  )
}

/** Editor tab labels (fl-tabs uses an OPEN shadow root — host innerText is empty). */
async function tabLabels(win: Page): Promise<string[]> {
  return win.locator('.fl-shell fl-tabs .tab').allInnerTexts()
}

/** ⌘N a scratch note and type into it (the #941 flow, exactly as a user does). */
async function newNote(win: Page, text: string): Promise<void> {
  await win.keyboard.press('ControlOrMeta+n')
  const lines = win.locator('.monaco-editor .view-lines').first()
  await lines.waitFor({ timeout: 15_000 })
  await lines.click()
  await win.keyboard.type(text, { delay: 15 })
  await expect(lines).toContainText(text.slice(0, 20), { timeout: 10_000 })
}

/** ⌘S → the inline "Save note as" bar → type a name → Save. */
async function saveNoteAs(win: Page, name: string): Promise<void> {
  await win.keyboard.press('ControlOrMeta+s')
  const bar = win.locator('.fl-note-save-bar')
  await expect(bar).toBeVisible({ timeout: 10_000 })
  await bar.locator('input').fill(name)
  await bar.locator('.fl-note-save-confirm').click()
}

/** Select the Files rail and right-click a tree row, then wait for its menu. */
async function treeCtx(win: Page, row: string): Promise<void> {
  const files = win.locator('[data-rail-item="files"]')
  if (!/\bactive\b/.test((await files.getAttribute('class')) ?? '')) await files.click()
  await pickFilesProject(win)
  const target = win.locator('.fl-sidebar-pane:visible').getByText(row, { exact: true })
  await target.waitFor({ state: 'visible', timeout: 15_000 })
  await target.click({ button: 'right' })
  await expect(win.locator('.fl-tree-menu')).toBeVisible({ timeout: 5000 })
}

const CHECKLIST = '# Release checklist\n\n- [ ] bump version\n- [ ] tag\n- [ ] publish\n'

/** A repo holding one precious file and one directory, plus a settled app. */
async function seedNoteRepo(win: Page, prefix: string): Promise<string> {
  const root = await seedProject(win, prefix, (dir) => {
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'IMPORTANT.md'), CHECKLIST)
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const hello = 1\n')
  })
  await activateProject(win, root)
  await dismissFlowOverlay(win)
  // Let the fire-and-forget auto-provisioner finish scaffolding the root so its
  // watcher burst doesn't land in the middle of an assertion.
  await win.waitForTimeout(2500)
  return root
}

test.afterAll(() => cleanupSeeds())

// ── Live coverage (green on main) ─────────────────────────────────────────

test('control: a note saves to a FRESH name, and the sibling New File… refuses a colliding one', async ({
  window,
}) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await seedNoteRepo(window, 'flow-ux-note-ctl-')

  // (a) The note path itself WORKS — so a red tripwire below can never be read
  //     as "⌘N/⌘S is broken", only as "this specific case is unguarded".
  await newNote(window, 'a genuinely new note')
  await saveNoteAs(window, 'notes/fresh.md')
  await expect(() => expect(existsSync(join(root, 'notes', 'fresh.md'))).toBe(true)).toPass({
    timeout: 15_000,
  })
  expect(readFileSync(join(root, 'notes', 'fresh.md'), 'utf8')).toContain('a genuinely new note')
  // The scratch tab became the real file.
  await expect(() => expect(tabLabels(window)).resolves.not.toContain('Untitled-1')).toPass({
    timeout: 10_000,
  })

  // (b) The SIBLING create affordance — the Files tree's New File… — refuses a
  //     name that is already taken AND says so (#196). Same repo, same file the
  //     tripwire below destroys: this is the invariant the app already holds.
  await treeCtx(window, 'docs')
  await window.locator('.fl-tree-menu').getByText('New File…', { exact: true }).click()
  const nameInput = window.locator('.fl-tree-menu input')
  await expect(nameInput).toBeVisible({ timeout: 5000 })
  await nameInput.fill('IMPORTANT.md')
  await nameInput.press('Enter')

  await expect(() =>
    expect(feedback(window)).resolves.toEqual(
      expect.arrayContaining([expect.stringMatching(/Couldn't create/i)]),
    ),
  ).toPass({ timeout: 15_000 })
  // …and the existing file is untouched.
  expect(readFileSync(join(root, 'docs', 'IMPORTANT.md'), 'utf8')).toBe(CHECKLIST)

  await window.screenshot({ path: `${SCREENS}/editor-note-collision-control.png` })
  expect(appErrors(errors)).toEqual([])
})

// ── Tripwires for the filed defects ───────────────────────────────────────

test.fixme(
  '#1384: naming a note after an existing file must not silently destroy that file',
  async ({ window }) => {
    test.setTimeout(180_000)
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const root = await seedNoteRepo(window, 'flow-ux-note-clash-')
    const target = join(root, 'docs', 'IMPORTANT.md')
    expect(readFileSync(target, 'utf8')).toBe(CHECKLIST)

    await newNote(window, 'just a scratch thought, nothing important')
    await saveNoteAs(window, 'docs/IMPORTANT.md')
    await window.waitForTimeout(3000)

    await window.screenshot({ path: `${SCREENS}/editor-note-collision-clobber.png` })

    // Either the write is refused/confirmed, or the user is told — but the
    // release checklist must not vanish without a word.
    const said = (await feedback(window)).join(' | ')
    const survived = readFileSync(target, 'utf8').includes('Release checklist')
    expect(
      survived || /overwrit|already exists|replace/i.test(said),
      `docs/IMPORTANT.md was replaced by the scratch note with no warning (feedback: ${said || 'none'})`,
    ).toBe(true)
    expect(appErrors(errors)).toEqual([])
  },
)

test.fixme('#1385: a note save that FAILS must tell the user', async ({ window }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await seedNoteRepo(window, 'flow-ux-note-fail-')

  // `src` is an existing DIRECTORY — the atomic rename onto it fails (EISDIR),
  // one of the exact failure modes #195's own header comment enumerates.
  await newNote(window, 'second note that cannot be written')
  await saveNoteAs(window, 'src')
  await window.waitForTimeout(3000)

  // Nothing was written (the precondition for the feedback claim).
  expect(statSync(join(root, 'src')).isDirectory()).toBe(true)
  expect(readFileSync(join(root, 'src', 'index.ts'), 'utf8')).toContain('export const hello')
  // The buffer is intact but still unsaved — the dirty dot reads as "unsaved
  // edits", not "your save just failed" (#195, forbidden pattern #2).
  expect(await tabLabels(window)).toEqual(expect.arrayContaining([expect.stringMatching(/Untitled/)]))

  await window.screenshot({ path: `${SCREENS}/editor-note-savefail.png` })

  const said = (await feedback(window)).join(' | ')
  expect(
    /couldn.t|could not|failed|error/i.test(said),
    `the note save failed with EISDIR and no surface said anything (feedback: ${said || 'none'})`,
  ).toBe(true)
  expect(appErrors(errors)).toEqual([])
})
