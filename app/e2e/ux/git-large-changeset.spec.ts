/**
 * UX sweep — flow `git` (rotation index 6, round 20): the Source Control panel at
 * SCALE, plus the two working-tree shapes whose diff has NO textual difference.
 *
 * Why this was un-probed: 26 git specs drive stage / unstage / commit / diff /
 * merge / pull / history / multi-root / refresh-vs-user-state — and every one of
 * them seeds a changeset of 1–4 files. Nobody had ever put a REAL-sized changeset
 * (the 40-file shape one agent run produces) in front of the panel, so three
 * things had zero coverage:
 *
 *   1. REACHABILITY AT SCALE. `createList` pins each section's box to
 *      `min(items, MAX_VISIBLE_*) * ROW_HEIGHT` (git-panel.ts:1317) — 8 rows for
 *      Changes — and virtualizes the rest behind an internal scroller. If that
 *      scroller ever stops responding, 32 of 40 files become unreachable: no
 *      stage, no diff, no discard (the #994 "overflowed tab strip has no route to
 *      off-screen tabs" failure, transplanted into the file list). This test
 *      reaches the LAST row by wheeling and opens its diff.
 *      (The fixed 8-row cap itself — 8 of 40 visible while ~370px of panel sits
 *      empty, with no scroll affordance at rest — is filed as #1184. Geometry is
 *      LOGGED here, never asserted, so the guard survives that fix.)
 *
 *   2. "REVERT ALL" AT SCALE. #506 made the bulk discard sequential precisely
 *      because concurrent `git checkout`s collide on `.git/index.lock` and
 *      silently leave files behind — but the guard for it is a unit test over an
 *      injected revert fn (discard-all.test.ts) plus a 2-file E2E. 40 real files,
 *      through the real IPC, with the app's own watcher-driven status refreshes
 *      racing each checkout, is the case the fix exists for. Asserted: the tree
 *      ends completely clean, and no "failed to revert" toast appears.
 *
 *   3. IDENTICAL-SIDE DIFFS. A `chmod +x` (mode-only) change and a brand-new
 *      0-byte file both land in Changes, and both diff to two identical sides.
 *      The invariant that must hold regardless: the row is listed, the click
 *      OPENS a diff overlay (never the #192 silent-failure path) and raises no
 *      uncaught error. That the mode change is never explained is filed as #1185;
 *      this spec asserts only what must be true either way.
 *
 * Account-independent (git only, no agent, no network) and deterministic: every
 * precondition is created with real git commands, and the panel is allowed to
 * settle before any action so the seed's own writes can't race the watcher.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')

/** Files in the large-changeset fixture — big enough to overflow the 8-row box
 *  several times over, small enough to stay fast. */
const BIG = 40

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

function name(i: number): string {
  return `file-${String(i).padStart(2, '0')}.txt`
}

function identify(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/** Reveal Source Control → Changes and wait for the git panel to mount + load. */
async function openGitPanel(window: Page): Promise<void> {
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(window.locator('.gp-branch-name')).toBeVisible({ timeout: 15000 })
}

/** A repo with `count` tracked files, all committed. Every git call runs inside
 *  `prepare` — BEFORE the root is attached — so the app's watcher can't race the
 *  seed on `.git/index.lock` (harness hygiene, not a product concern). */
async function seedTracked(window: Page, prefix: string, count: number): Promise<string> {
  return seedProject(window, prefix, (dir) => {
    identify(dir)
    for (let i = 0; i < count; i += 1) writeFileSync(join(dir, name(i)), 'v0\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'baseline')
    git(dir, 'branch', '-M', 'main')
  })
}

/** The changes list's own scroller lives in fl-list's (open) shadow root. */
async function changesListGeometry(window: Page): Promise<{
  panelHeight: number
  panelScrolls: boolean
  listHeight: number
  scrollTop: number
  scrollHeight: number
}> {
  return window.evaluate(() => {
    const root = document.querySelector('.gp-root') as HTMLElement
    const lists = Array.from(document.querySelectorAll('fl-list')) as HTMLElement[]
    const changes = lists.find((l) => (l.getAttribute('data-list-key') ?? '').endsWith('changes'))
    const scroller = Array.from(changes?.shadowRoot?.children ?? []).find(
      (c) => (c as HTMLElement).scrollHeight > (c as HTMLElement).clientHeight,
    ) as HTMLElement | undefined
    return {
      panelHeight: root.getBoundingClientRect().height,
      panelScrolls: root.scrollHeight > root.clientHeight,
      listHeight: changes?.getBoundingClientRect().height ?? 0,
      scrollTop: scroller?.scrollTop ?? -1,
      scrollHeight: scroller?.scrollHeight ?? -1,
    }
  })
}

test.afterAll(() => cleanupSeeds())

test.describe('git — a real-sized changeset', () => {
  test('every one of 40 changes stays reachable: the last row scrolls into view and diffs', async ({
    window,
  }) => {
    test.setTimeout(120000)
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedTracked(window, 'flow-git-big-', BIG)
    for (let i = 0; i < BIG; i += 1) writeFileSync(join(dir, name(i)), `v1 ${i}\n`)

    await activateProject(window, dir)
    await openGitPanel(window)

    // The header counts the WHOLE changeset even though the box shows a slice.
    await expect(window.locator('.gp-root')).toContainText(`Changes (${BIG})`, { timeout: 20000 })
    await expect(window.locator('.gp-dirty')).toHaveText(`${BIG} changed`)

    const top = await changesListGeometry(window)
    console.log(
      `[#1184] panel ${top.panelHeight}px (scrolls: ${top.panelScrolls}) · changes list ` +
        `${top.listHeight}px · content ${top.scrollHeight}px`,
    )
    // The list must be a real scroller, not a silently truncated stub.
    expect(top.scrollHeight).toBeGreaterThan(top.listHeight)
    expect(top.scrollTop).toBe(0)

    // #1184 (fixed): the list uses the height the panel actually has, instead of
    // a hard 8-row / 224px cap that left ~370px of panel empty below it. It must
    // now claim a real share of the panel — and, since macOS overlay scrollbars
    // are invisible at rest, showing 8 of 40 files in a peephole was
    // indistinguishable from a list that simply held 8 files.
    expect(
      top.listHeight,
      `the changes list is still capped (${top.listHeight}px) inside a ${top.panelHeight}px panel`,
    ).toBeGreaterThan(224)
    expect(top.listHeight).toBeLessThanOrEqual(top.panelHeight)

    // The first row is visible; the last one is NOT rendered yet (virtualized).
    await expect(window.locator('.gp-name', { hasText: name(0) })).toBeVisible()
    await window.screenshot({ path: join(SHOTS, 'git-large-changeset-top.png') })

    // A user wheels over the list — that must reach the end of the changeset.
    await window.locator('.gp-name', { hasText: name(5) }).first().hover()
    await window.mouse.wheel(0, 2000)
    await expect(window.locator('.gp-name', { hasText: name(BIG - 1) })).toBeVisible({
      timeout: 10000,
    })

    const bottom = await changesListGeometry(window)
    expect(bottom.scrollTop).toBeGreaterThan(0)

    // …and the row it reached is a REAL row: clicking it opens that file's diff.
    await window.locator('.gp-name', { hasText: name(BIG - 1) }).first().click()
    const overlay = window.locator('.gd-overlay')
    await expect(overlay).toBeVisible({ timeout: 15000 })
    await expect(window.locator('.gd-title')).toHaveText(name(BIG - 1))
    await expect(overlay).toContainText(`v1 ${BIG - 1}`)
    await window.screenshot({ path: join(SHOTS, 'git-large-changeset-last-row-diff.png') })

    expect(errors).toEqual([])
  })

  test('"Revert all" on a 40-file changeset leaves nothing behind (#506 at scale)', async ({
    window,
  }) => {
    test.setTimeout(120000)
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    window.on('dialog', (dialog) => void dialog.accept()) // the destructive confirm

    const dir = await seedTracked(window, 'flow-git-bigrevert-', BIG)
    for (let i = 0; i < BIG; i += 1) writeFileSync(join(dir, name(i)), `v1 ${i}\n`)

    await activateProject(window, dir)
    await openGitPanel(window)
    await expect(window.locator('.gp-root')).toContainText(`Changes (${BIG})`, { timeout: 20000 })
    // Let the watcher-driven refreshes from the seed's own writes settle first.
    await window.waitForTimeout(3000)

    await window.locator('.gp-bulk-revert').click()

    // The panel returns to the clean state — every file, not most of them.
    await expect(window.locator('.gp-root')).toContainText('Working tree clean', { timeout: 60000 })
    // A clean tree prints NO dirty badge (git-panel.ts renders `.gp-dirty` only
    // while there are changes) — the "clean" word moved to the list's own line.
    await expect(window.locator('.gp-dirty')).toHaveCount(0)
    await window.screenshot({ path: join(SHOTS, 'git-large-changeset-reverted.png') })

    // Ground truth: git agrees, and no file was silently skipped (#506).
    expect(git(dir, 'status', '--porcelain').trim()).toBe('')
    // A partial revert raises "Couldn't discard some changes" — it must not.
    await expect(
      window.locator('.fl-flow-toast').filter({ hasText: "Couldn't discard" }),
    ).toHaveCount(0)

    expect(errors).toEqual([])
  })

  test('a chmod-only change and an empty new file are listed and their diffs open (#1185)', async ({
    window,
  }) => {
    test.setTimeout(120000)
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window, 'flow-git-modeonly-', (d) => {
      identify(d)
      writeFileSync(join(d, 'script.sh'), '#!/bin/sh\necho hi\n')
      writeFileSync(join(d, 'keep.txt'), 'v0\n')
      git(d, 'add', '.')
      git(d, 'commit', '-q', '-m', 'baseline')
      git(d, 'branch', '-M', 'main')
    })
    chmodSync(join(dir, 'script.sh'), 0o755) // mode-only change: content identical
    writeFileSync(join(dir, 'empty.txt'), '') // brand-new 0-byte file

    // Fixture self-check: git sees a mode-only change (same blob on both sides).
    expect(git(dir, 'status', '--porcelain=v2')).toContain('100644 100755')

    await activateProject(window, dir)
    await openGitPanel(window)
    await expect(window.locator('.gp-root')).toContainText('Changes (2)', { timeout: 20000 })

    // Both shapes are LISTED — a mode change is a change, an empty file is a file.
    await expect(window.locator('.gp-name', { hasText: 'script.sh' })).toBeVisible()
    await expect(window.locator('.gp-name', { hasText: 'empty.txt' })).toBeVisible()

    const overlay = window.locator('.gd-overlay')

    // Clicking the mode-only row OPENS a diff — never the #192 silent-failure path.
    await window.locator('.gp-name', { hasText: 'script.sh' }).first().click()
    await expect(overlay).toBeVisible({ timeout: 15000 })
    await expect(window.locator('.gd-title')).toHaveText('script.sh')
    await expect(
      window.locator('.fl-flow-toast').filter({ hasText: "Couldn't" }),
    ).toHaveCount(0)
    // #1185 (fixed): the diff SAYS what changed. Two byte-identical panes under
    // a "Working tree vs HEAD" header were indistinguishable from a diff that
    // failed to load — the panel insisting the file changed, the diff insisting
    // it didn't.
    await expect(window.locator('.gd-note')).toBeVisible()
    await expect(window.locator('.gd-note')).toContainText('100644')
    await expect(window.locator('.gd-note')).toContainText('100755')
    await window.screenshot({ path: join(SHOTS, 'git-large-changeset-mode-only-diff.png') })

    // Same for the empty new file.
    await window.locator('.gd-close:not(.gd-open)').click()
    await expect(overlay).toBeHidden({ timeout: 10000 })
    await window.locator('.gp-name', { hasText: 'empty.txt' }).first().click()
    await expect(overlay).toBeVisible({ timeout: 15000 })
    await expect(window.locator('.gd-title')).toHaveText('empty.txt')

    // The mode change still COMMITS correctly — only its explanation is missing.
    await window.locator('.gd-close:not(.gd-open)').click()
    await window.locator('.gp-name', { hasText: 'script.sh' }).first().hover()
    await window.locator('.gp-row', { hasText: 'script.sh' }).locator('.gp-action-btn').first().click()
    await expect(window.locator('.gp-root')).toContainText('Staged Changes (1)', { timeout: 15000 })
    await window.locator('.gp-commit-msg').fill('chore: make script executable')
    await window.locator('.gp-commit-btn').click()
    await expect(window.locator('.gp-root')).toContainText('Commits (2)', { timeout: 20000 })
    expect(git(dir, 'show', '--summary', '--format=%s', 'HEAD')).toContain('mode change 100644 => 100755')

    expect(errors).toEqual([])
  })
})
