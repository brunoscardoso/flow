/**
 * Multi-project threads (plan multi-project-threads, Phase 7) — the seeded
 * end-to-end journey over the thread-scope layer.
 *
 * Two throwaway git repos (alpha, beta) become project roots; a thread on
 * alpha carries beta in `thread_roots` (created through the real
 * `threads:create` seam — the same request the multi-project chooser sends).
 * Activating that thread must scope every v1 surface at once:
 *
 *  - Files: one collapsible section per root — 3px left accent border + name,
 *    alpha's header carrying the "primary project" tooltip (the primary
 *    marker is non-textual; the old "main" text tag read as a branch name and
 *    was removed) — with beta's files openable and beta's fold state
 *    persisted.
 *  - Source Control: one group per repo (branch in the header); staging and
 *    committing inside beta's group commits BETA's repo only (asserted on the
 *    real repos with git, not on panel text).
 *  - Terminal: + offers "New terminal in:" both roots; a shell spawned in
 *    beta carries beta's accent dot.
 *
 * The control thread (single root) is the NFR1 guard: NO scope chrome anywhere
 * (no tree headers, no git group heads, no terminal dots, no root menu) —
 * byte-identical to the pre-scope app. Live attach via `threads:setRoots`
 * (the picker's one write path) must flip all three surfaces WITHOUT a reload.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures/electron'
import { sel } from './selectors'
import { seedProject, activateProject, cleanupSeeds, gitRetry, pickFilesProject } from './ux/fixtures/seed'

/** Accent chrome (tree header borders, terminal dots) is inline-styled
 *  `var(--fl-project-accent-<hash>)` references (project-accent.ts) — the one
 *  stable marker across tree/git/terminal. */
const ACCENT_SPAN = 'span[style*="--fl-project-accent-"]'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

function configureIdentity(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/** Alpha: one commit + one UNTRACKED file that must still be untracked after
 *  the beta-side commit (the "alpha untouched" assertion). */
function populateAlpha(dir: string): void {
  configureIdentity(dir)
  writeFileSync(join(dir, 'README.md'), '# alpha\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-q', '-m', 'alpha initial')
  writeFileSync(join(dir, 'alpha-dirty.txt'), 'alpha uncommitted\n')
}

/** Beta: one commit holding a file the panel will see MODIFIED (stage+commit
 *  target) plus a committed note file the tree-open assertion reads. */
function populateBeta(dir: string): void {
  configureIdentity(dir)
  writeFileSync(join(dir, 'beta-note.md'), 'BETA NOTE CONTENT\n')
  writeFileSync(join(dir, 'beta-change.txt'), 'v1\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'beta initial')
  writeFileSync(join(dir, 'beta-change.txt'), 'v1\nv2 modified\n')
}

/** Create a thread over the real `threads:create` IPC (the chooser's seam —
 *  `additionalRoots` is exactly what it sends) and return its id. */
async function createThread(
  win: Page,
  projectRoot: string,
  title: string,
  additionalRoots: string[] = [],
): Promise<string> {
  return win.evaluate(
    async ({ projectRoot, title, additionalRoots }) => {
      const created = await (
        window as unknown as {
          flow: {
            threads: {
              create(i: {
                projectRoot: string
                title: string
                additionalRoots?: string[]
              }): Promise<{ id: string }>
            }
          }
        }
      ).flow.threads.create({ projectRoot, title, additionalRoots })
      return created.id
    },
    { projectRoot, title, additionalRoots },
  )
}

/** Activate a thread the way the user does: click its sidebar row (that path
 *  calls project:setActiveThread, which re-derives the scope). Click the ROW,
 *  not the title span — a multi-root thread's "+<project>" badge (#45) is
 *  flex:none and can crush the flex:1 title to zero width when the seeded
 *  tmpdir basenames are long. */
async function openThread(win: Page, title: string): Promise<void> {
  // The row only renders in the visible Threads pane — switch the rail back
  // if another pane (Files, Source Control) is currently showing.
  const threadsRail = win.locator('[data-rail-item="threads"]')
  const cls = (await threadsRail.getAttribute('class')) ?? ''
  if (!/\bactive\b/.test(cls)) await threadsRail.click()
  const row = win
    .locator('.fl-thread-sidebar .row', { hasText: title })
    .first()
  // The list can re-render between resolving the row and the click landing
  // (a just-created thread's broadcast redraws it), so a press that opened
  // nothing is pressed again rather than read as a broken thread list.
  await expect(row).toBeVisible({ timeout: 15_000 })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // On the TITLE, not the row's centre: the row's second line is the
    // project name, and a press there is not "open this thread".
    await row.getByText(title, { exact: true }).click({ timeout: 5_000 }).catch(() => undefined)
    try {
      await expect(win.locator(sel.composer)).toBeVisible({ timeout: 3_000 })
      return
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
}

/** Switch the left side panel to the Files rail (default rail is Threads).
 *  Clicking the ACTIVE rail item collapses the sidebar, so guard on state. */
async function showFilesPane(win: Page): Promise<void> {
  const files = win.locator('[data-rail-item="files"]')
  const cls = (await files.getAttribute('class')) ?? ''
  if (!/\bactive\b/.test(cls)) await files.click()
  await pickFilesProject(win)
}

/** The visible left side-panel pane (tree rows render inside it). */
const pane = (win: Page) => win.locator('.fl-sidebar-pane:visible')

/** The primary root's section header — its tooltip is the primary marker
 *  (no text tag; the old "main" chip read as branch information). */
const primaryHeader = (win: Page) =>
  pane(win).locator('span[title="Primary project — owns plans and flow state"]')

async function openGitChanges(win: Page): Promise<void> {
  await win.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await win.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(win.locator(sel.gitPanelRoot)).toBeVisible()
}

const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newTerminalBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

test.afterAll(() => cleanupSeeds())

test('multi-root thread: sectioned tree, per-repo git groups + independent commit, scoped terminals', async ({
  window,
}) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const alpha = await seedProject(window, 'flow-mpt-alpha-', populateAlpha)
  const beta = await seedProject(window, 'flow-mpt-beta-', populateBeta)
  const alphaName = basename(alpha)
  const betaName = basename(beta)
  await activateProject(window, alpha)

  const multiTitle = 'Multi-root thread'
  await createThread(window, alpha, multiTitle, [beta])
  await createThread(window, alpha, 'Detour thread') // for the fold round trip
  await openThread(window, multiTitle)

  // ── Files: two sections, left accent borders, primary tooltip on alpha ───
  await showFilesPane(window)
  await expect(pane(window).getByText(alphaName, { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(pane(window).getByText(betaName, { exact: true })).toBeVisible()
  // Exactly one primary: the header row carrying the primary tooltip, on alpha.
  await expect(primaryHeader(window)).toHaveCount(1)
  // Both section headers carry their project accent (left border reference).
  expect(await pane(window).locator(ACCENT_SPAN).count()).toBeGreaterThanOrEqual(2)

  // A thread with more than one project opens with EVERY project folded, so
  // the person sees there is more than one folder to open (user, 2026-10-06).
  await expect(pane(window).getByText('beta-note.md', { exact: true })).toBeHidden()
  await expect(pane(window).getByText('README.md', { exact: true })).toBeHidden()
  await window.screenshot({ path: 'e2e/ux/__screens/files-multi-project-folded.png' })

  // Unfold beta: its files are first-class — click one open, Monaco renders it.
  await pane(window).getByText(betaName, { exact: true }).click()
  await pane(window).getByText('beta-note.md', { exact: true }).click()
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('BETA NOTE CONTENT', {
    timeout: 15_000,
  })
  await window.screenshot({ path: 'e2e/ux/__screens/files-multi-project-beta-open.png' })

  // The unfold is kept while the thread stays open (opening a file re-derives
  // nothing that refolds it)…
  await expect(pane(window).getByText('beta-note.md', { exact: true })).toBeVisible()
  // …and a fold made by hand is kept too.
  await pane(window).getByText(betaName, { exact: true }).click()
  await expect(pane(window).getByText('beta-note.md', { exact: true })).toBeHidden()
  await pane(window).getByText(betaName, { exact: true }).click()
  await expect(pane(window).getByText('beta-note.md', { exact: true })).toBeVisible()

  // Opening another thread and coming back starts folded again.
  await openThread(window, 'Detour thread')
  await openThread(window, multiTitle)
  await showFilesPane(window)
  await expect(pane(window).getByText(betaName, { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(pane(window).getByText('beta-note.md', { exact: true })).toBeHidden()
  await expect(pane(window).getByText('README.md', { exact: true })).toBeHidden()
  // Re-expand: beta's listing comes back (the fold is state, not loss).
  await pane(window).getByText(betaName, { exact: true }).click()
  await expect(pane(window).getByText('beta-note.md', { exact: true })).toBeVisible()

  // ── User accent override: one IPC write repaints every surface live ──────
  // project:setRootAccent is the color picker's one write path (it now
  // lives in the sidebar's ⋯ project menu); the override fans out via
  // rootsChanged/threadScopeChanged and lands in the shared
  // --fl-project-accent-<hash> custom property, so existing var() references
  // (tree header borders, git group head borders, terminal tabs) repaint in
  // place.
  // A pick from the RETIRED pastel set (2026-07-28) — the project palette is the
  // Workspace map's eight hues since 2026-10-06, and an old pick maps to its
  // family's slot (project-accent.ts LEGACY_OVERRIDES: magenta → slot 4, rose).
  // So this is also the guard that an existing user's saved colour still lands.
  const OVERRIDE = '#e3aed6'
  const OVERRIDE_PAINT = 'var(--fl-project-hue-4, #e07a9a)'
  await window.evaluate(
    async ({ rootPath, color }) => {
      await (
        window as unknown as {
          flow: {
            project: {
              setRootAccent(i: { rootPath: string; color: string | null }): Promise<unknown>
            }
          }
        }
      ).flow.project.setRootAccent({ rootPath, color })
    },
    { rootPath: beta, color: OVERRIDE },
  )
  await expect
    .poll(
      () =>
        window.evaluate(() => {
          const style = document.documentElement.style
          const values: string[] = []
          for (let i = 0; i < style.length; i++) {
            const name = style[i]
            if (name.startsWith('--fl-project-accent-')) values.push(style.getPropertyValue(name))
          }
          return values
        }),
      { timeout: 15_000 },
    )
    .toContain(OVERRIDE_PAINT)
  // What that paint IS in the current theme — the token is theme-aware.
  const overrideRgb = await window.evaluate((paint) => {
    const probe = document.createElement('div')
    probe.style.color = paint
    document.body.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, OVERRIDE_PAINT)

  // ── Git: one group per repo, commit in beta's group only ────────────────
  await openGitChanges(window)
  const groupHeads = window.locator('.gp-group-head')
  await expect(groupHeads).toHaveCount(2, { timeout: 15_000 })
  const alphaGroup = window.locator('.gp-group', {
    has: window.locator('.gp-group-name', { hasText: alphaName }),
  })
  const betaGroup = window.locator('.gp-group', {
    has: window.locator('.gp-group-name', { hasText: betaName }),
  })
  // No 'main' TEXT tag anywhere (it read as a branch name — user call
  // 2026-07-28): the primary is the header tooltip alone.
  await expect(alphaGroup.locator('.gp-group-tag', { hasText: 'main' })).toHaveCount(0)
  await expect(alphaGroup.locator('.gp-group-head')).toHaveAttribute('title', /Primary project/)
  // …and the OTHER group says what it IS. Its tooltip was the repo's ABSOLUTE
  // PATH — the app's internal spelling, on screen, on every multi-root thread
  // (forbidden-pattern #12). A path answers a question nobody asked of a
  // tooltip on a name they can already see.
  await expect(betaGroup.locator('.gp-group-head')).toHaveAttribute(
    'title',
    /Another project this thread works in/,
  )
  const betaTitle = (await betaGroup.locator('.gp-group-head').getAttribute('title')) ?? ''
  expect(betaTitle, 'a filesystem path reached the group tooltip').not.toContain('/')
  // Beta's group head renders the user override as its LEFT ACCENT BORDER
  // (live repaint via the shared CSS custom property — no reload between the
  // IPC write and this paint). Same border grammar as the tree headers.
  await expect
    .poll(
      () =>
        betaGroup
          .locator('.gp-group-head')
          .evaluate((el) => getComputedStyle(el).borderLeftColor),
      { timeout: 15_000 },
    )
    .toBe(overrideRgb)
  // Branch shown per group — asserted against each repo's REAL branch name.
  //
  // READ FROM THE SECTION, NOT THE HEADER. `.gp-group-branch` is the FOLDED
  // summary: the header carries the branch only while a group is collapsed,
  // because expanded it sat one line above the section's own branch line and
  // printed the same value twice, adjacent, for every group on screen. These
  // groups are expanded, so the section line is where the branch is.
  const alphaBranch = git(alpha, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  const betaBranch = git(beta, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  await expect(alphaGroup.locator('.gp-branch-name')).toHaveText(alphaBranch)
  await expect(betaGroup.locator('.gp-branch-name')).toHaveText(betaBranch)

  // Stage beta's modified file inside BETA's group and commit there.
  const betaRow = betaGroup
    .locator('.gp-row', { has: window.locator('.gp-name', { hasText: 'beta-change.txt' }) })
    .first()
  await expect(betaRow).toBeVisible({ timeout: 15_000 })
  await betaRow.locator('.gp-action-btn[title="Stage"]').click()
  const commitMessage = 'feat: beta commit from e2e'
  await betaGroup.locator('.gp-commit-msg').fill(commitMessage)
  await expect(betaGroup.locator('.gp-commit-btn')).toBeEnabled({ timeout: 15_000 })
  await betaGroup.locator('.gp-commit-btn').click()

  // Real-repo assertions: beta got EXACTLY this commit; alpha is untouched.
  await expect
    .poll(() => gitRetry(beta, 'log', '--format=%s', '-n', '1').trim(), { timeout: 20_000 })
    .toBe(commitMessage)
  expect(gitRetry(beta, 'status', '--porcelain').trim()).toBe('')
  expect(gitRetry(alpha, 'log', '--format=%s').trim()).toBe('alpha initial')
  expect(gitRetry(alpha, 'status', '--porcelain')).toContain('?? alpha-dirty.txt')

  // ── Terminal: + offers both roots; a beta shell carries beta's accent ────
  await expect(window.locator(sel.terminalRoot)).toBeVisible()
  const tabsBefore = await termTabs(window).count()
  await newTerminalBtn(window).click()
  const rootMenu = window.locator('.fl-term-root-menu')
  await expect(rootMenu).toBeVisible()
  await expect(rootMenu.locator('.fl-term-root-item')).toHaveCount(2)
  await expect(rootMenu.locator('.fl-term-root-item', { hasText: alphaName })).toBeVisible()
  const betaItem = rootMenu.locator('.fl-term-root-item', { hasText: betaName })
  await expect(betaItem).toBeVisible()
  await betaItem.click()
  await expect(termTabs(window)).toHaveCount(tabsBefore + 1, { timeout: 15_000 })
  // The new (active) tab is beta's: accent dot present, project-name tooltip.
  const activeTab = window.locator('.fl-term-tabs .tab.active')
  await expect(activeTab.locator('.project-dot')).toBeVisible()
  await expect(activeTab).toHaveAttribute('title', betaName)

  expect(errors, `renderer errors:\n${errors.join('\n')}`).toEqual([])
})

test('single-root control shows NO scope chrome (NFR1); live attach flips all surfaces without reload', async ({
  window,
}) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const alpha = await seedProject(window, 'flow-mpt-solo-', populateAlpha)
  const beta = await seedProject(window, 'flow-mpt-attach-', populateBeta)
  const alphaName = basename(alpha)
  const betaName = basename(beta)
  await activateProject(window, alpha)

  const soloTitle = 'Solo control thread'
  const soloId = await createThread(window, alpha, soloTitle)
  await openThread(window, soloTitle)

  // Files: today's tree exactly — no section headers, no accent chrome.
  await showFilesPane(window)
  await expect(pane(window).getByText('README.md', { exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await expect(primaryHeader(window)).toHaveCount(0)
  await expect(pane(window).locator(ACCENT_SPAN)).toHaveCount(0)

  // Git: rows render but ZERO group chrome.
  await openGitChanges(window)
  await expect(async () => {
    expect(await window.locator('.gp-name').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 15_000 })
  await expect(window.locator('.gp-group-head')).toHaveCount(0)

  // Terminal: + spawns directly — no root menu, and no accent dots on tabs.
  await expect(window.locator(sel.terminalRoot)).toBeVisible()
  const tabsBefore = await termTabs(window).count()
  await newTerminalBtn(window).click()
  await expect(window.locator('.fl-term-root-menu')).toHaveCount(0)
  await expect(termTabs(window)).toHaveCount(tabsBefore + 1, { timeout: 15_000 })
  await expect(window.locator('.fl-term-tabs .tab .project-dot')).toHaveCount(0)

  // ── Live attach: threads:setRoots (the picker's write path) — no reload ──
  await window.evaluate(
    async ({ threadId, roots }) => {
      await (
        window as unknown as {
          flow: { threads: { setRoots(i: { threadId: string; roots: string[] }): Promise<unknown> } }
        }
      ).flow.threads.setRoots({ threadId, roots })
    },
    { threadId: soloId, roots: [beta] },
  )

  // Git flips to two groups live (Source Control pane is currently visible).
  await expect(window.locator('.gp-group-head')).toHaveCount(2, { timeout: 15_000 })

  // The tree now has both sections, alpha carrying the primary tooltip.
  await showFilesPane(window)
  // `visible: true`: the Files panel's Workspace picker keeps its (hidden)
  // project buttons in the pane, so each name also matches there.
  await expect(
    pane(window).getByText(betaName, { exact: true }).filter({ visible: true }),
  ).toBeVisible({ timeout: 15_000 })
  await expect(pane(window).getByText(alphaName, { exact: true }).filter({ visible: true })).toBeVisible()
  await expect(primaryHeader(window)).toHaveCount(1)

  // The terminal strip re-rendered scoped: the existing alpha tab gained its
  // accent dot, and + now offers both roots.
  await expect(
    window.locator('.fl-term-tabs .tab .project-dot').first(),
  ).toBeVisible({ timeout: 15_000 })
  await newTerminalBtn(window).click()
  const rootMenu = window.locator('.fl-term-root-menu')
  await expect(rootMenu).toBeVisible()
  await expect(rootMenu.locator('.fl-term-root-item')).toHaveCount(2)
  await window.keyboard.press('Escape')

  expect(errors, `renderer errors:\n${errors.join('\n')}`).toEqual([])
})
