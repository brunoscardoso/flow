/**
 * Flow 1 — the Source-Control panel must FOLLOW an active-project switch.
 *
 * Sibling flow-1 probes cover the switcher/titlebar and the FILE-TREE rebind on
 * a switch (project-group-switch drives a per-project marker file into the tree).
 * None drive the OTHER project-scoped surface a user relies on after switching:
 * the Git / Source-Control panel. It is scoped to the active project and rebinds
 * on `project:activeChanged` (git/index.ts setActiveRoot 459-471 →
 * render() + refreshRoot(newRoot); the panel is scoped to `activeRoot`, ADR-002).
 *
 * Why this matters: if the panel kept showing project A's changes while project B
 * is active, a user would stage/commit against the wrong mental model — a silent
 * mis-target, the same class of harm as the #426 same-basename confusion. This
 * probe seeds two projects each holding a DISTINCTLY-NAMED working-tree change and
 * asserts the panel shows ONLY the active project's change and swaps cleanly on
 * every switch (A → B → A round-trip), never leaking the other project's file.
 *
 * Credential-free: everything is immediate `project:*` / `git:*` IPC; the native
 * "+ Open Project…" picker is never clicked. Git panel rows live in an OPEN shadow
 * DOM (invisible to innerText) — asserted via `.gp-name` locators. Watches
 * pageerrors throughout (benign Monaco cancellation noise filtered).
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

function configure(dir: string): void {
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'QA Bot'], { cwd: dir })
}

/** Monaco throws internal cancellation errors when a diff model is disposed; they
 *  have no user-visible effect and are framework noise, not app defects. */
const BENIGN_MONACO = [/^Canceled: Canceled$/, /no diff result available/i]
function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !BENIGN_MONACO.some((re) => re.test(e)))
}

/** Reveal Source Control → Changes and wait for the git panel to mount. */
async function openGitPanel(window: Page): Promise<void> {
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
}

/** Assert the panel shows `present` in CHANGES and NOT `absent` (poll to settle). */
async function expectOnlyChange(window: Page, present: string, absent: string): Promise<void> {
  await expect(async () => {
    expect(await window.locator('.gp-name', { hasText: present }).count()).toBeGreaterThan(0)
    expect(await window.locator('.gp-name', { hasText: absent }).count()).toBe(0)
  }).toPass({ timeout: 6000 })
}

test.afterAll(() => cleanupSeeds())

test('the Source-Control panel rebinds to the active project on every switch', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  // Two projects, each with a DISTINCTLY-NAMED untracked change so the panel's
  // contents are unambiguous about which project it is scoped to.
  const projA = await seedProject(window, 'flow-ux-gitA-')
  configure(projA)
  writeFileSync(join(projA, 'alpha-only.txt'), 'change in project A\n')

  const projB = await seedProject(window, 'flow-ux-gitB-')
  configure(projB)
  writeFileSync(join(projB, 'beta-only.txt'), 'change in project B\n')

  // Activate A and open the panel — it must show A's change and NOT B's.
  await activateProject(window, projA)
  await openGitPanel(window)
  await expectOnlyChange(window, 'alpha-only.txt', 'beta-only.txt')
  await window.screenshot({ path: 'e2e/ux/__screens/project-git-rebind-A.png' })

  // Switch to B — the panel must FOLLOW: B's change appears, A's is gone. A stale
  // panel still showing alpha-only.txt here would be the silent mis-target bug.
  await activateProject(window, projB)
  await expectOnlyChange(window, 'beta-only.txt', 'alpha-only.txt')
  await window.screenshot({ path: 'e2e/ux/__screens/project-git-rebind-B.png' })

  // Switch back to A — it rebinds again (round-trip, no stuck B state).
  await activateProject(window, projA)
  await expectOnlyChange(window, 'alpha-only.txt', 'beta-only.txt')

  expect(appErrors(errors), appErrors(errors).join(', ')).toEqual([])
})
