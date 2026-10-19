/**
 * #696 (comprehensive) — Next.js App Router **route groups** and other
 * parenthesis/bracket/at folder conventions must all appear + expand in the Files
 * tree. route-group-folder.spec covers a single top-level `app/(protected)/`; this
 * covers the shapes a real App Router project actually uses and that the minimal
 * repro didn't: MULTIPLE route groups, a NESTED route group `(app)/(dashboard)`,
 * an `app/` whose ONLY children are route groups (no plain file to "carry" the
 * listing), and the sibling `[id]` (dynamic) + `@modal` (parallel) conventions —
 * all of which contain shell/regex metacharacters.
 *
 * Everything is driven through the real Files surface (main listDirectory →
 * renderer tree render → expand), so a drop at ANY layer fails here. All-green is
 * the evidence that closes #696: the tree handles these names at every layer.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function pane(win: Page) {
  // Inactive side panels are display:none (not [hidden]) — `:visible` isolates the
  // one active Files pane; `:not([hidden])` would match all three panels.
  return win.locator('.fl-sidebar-pane:visible')
}
async function clickRow(win: Page, name: string): Promise<void> {
  await pane(win).getByText(name, { exact: true }).first().click()
}
async function expectRow(win: Page, name: string): Promise<void> {
  await expect(pane(win).getByText(name, { exact: true }).first()).toBeVisible({ timeout: 8000 })
}

test.afterAll(() => cleanupSeeds())

test('nested + multiple route groups (and [id]/@modal) all appear and expand (#696)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const dir = await seedProject(window)
  // A route-group-ONLY app dir (no plain file directly in app/), multiple groups,
  // a NESTED group, plus [id] (dynamic) and @modal (parallel) siblings.
  const files = [
    'app/(marketing)/page.tsx',
    'app/(marketing)/about/page.tsx',
    'app/(app)/(dashboard)/page.tsx', // nested route groups
    'app/(app)/settings/page.tsx',
    'app/[id]/page.tsx', // dynamic segment (brackets)
    'app/@modal/default.tsx', // parallel route (at-sign)
  ]
  for (const rel of files) {
    mkdirSync(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(join(dir, rel), 'export default function P() {}\n')
  }
  await activateProject(window, dir)

  await window.locator('[data-rail-item="files"]').click()
  await pickFilesProject(window)
  await expect(pane(window)).toBeVisible()

  // Expand app/ → both top-level route groups + the metachar siblings show.
  await clickRow(window, 'app')
  await expectRow(window, '(marketing)')
  await expectRow(window, '(app)')
  await expectRow(window, '[id]')
  await expectRow(window, '@modal')

  // A route group expands to its children…
  await clickRow(window, '(marketing)')
  await expectRow(window, 'about')

  // …and a NESTED route group inside another route group expands too.
  await clickRow(window, '(app)')
  await expectRow(window, '(dashboard)')
  await clickRow(window, '(dashboard)')
  await expectRow(window, 'page.tsx')

  expect(errors).toEqual([])
})
