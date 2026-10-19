// LIVE probe (multi-project threads Phase 7, per the live-testing directive):
// drive the REAL orbit-app + orbit-core pair — not seeded fixtures — through
// the thread-scope surfaces. Add both repos as project roots, activate
// orbit-app, create a thread and attach orbit-core over the real attach
// path (`threads:setRoots`, the multi-project picker's one write seam), then
// assert the sectioned tree (accent dots + "main" tag) and the two-repo Source
// Control groups showing each repo's REAL branch. Untracked probe — skipped
// wholesale when the pair is absent (CI, other machines).
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures/electron'
import { activateProject } from './ux/fixtures/seed'
import { LIVE_SIBLING_VAR, liveRoot, noLiveProject } from './fixtures/live-root'

const LIVE_PROJECT = liveRoot()
const LIVE_SIBLING = liveRoot(LIVE_SIBLING_VAR)

const ACCENT_SPAN = 'span[style*="--fl-project-accent-"]'
const pane = (win: Page) => win.locator('.fl-sidebar-pane:visible')

function realBranch(dir: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
    .toString()
    .trim()
}

test('live: orbit-app + orbit-core thread scopes the tree and git groups', async ({
  window,
}) => {
  test.skip(
    LIVE_PROJECT === '' || LIVE_SIBLING === '',
    `${noLiveProject()} and ${LIVE_SIBLING_VAR} to a sibling`,
  )
  // Fresh e2e userData → the auto-provisioner may run on both roots before the
  // surfaces settle (~150s first paint on the live pair — see live-plan-pop).
  test.setTimeout(360_000)

  for (const path of [LIVE_PROJECT, LIVE_SIBLING]) {
    await window.evaluate(async (p) => {
      await (
        window as unknown as {
          flow: { project: { add(r: { path: string }): Promise<unknown> } }
        }
      ).flow.project.add({ path: p })
    }, path)
  }
  await activateProject(window, LIVE_PROJECT)

  // A real thread on orbit-app…
  const title = 'Live multi-project probe'
  const threadId = await window.evaluate(
    async ({ projectRoot, title }) => {
      const created = await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot, title })
      return created.id
    },
    { projectRoot: LIVE_PROJECT, title },
  )
  // Click the ROW (a multi-root badge can crush the flex:1 title span).
  await window
    .locator('.fl-thread-sidebar .row', { has: window.locator(`span[title="${title}"]`) })
    .first()
    .click()

  // …then orbit-core attached over the REAL attach path (what the picker calls).
  await window.evaluate(
    async ({ threadId, roots }) => {
      await (
        window as unknown as {
          flow: { threads: { setRoots(i: { threadId: string; roots: string[] }): Promise<unknown> } }
        }
      ).flow.threads.setRoots({ threadId, roots })
    },
    { threadId, roots: [LIVE_SIBLING] },
  )

  // Sectioned tree: both real repos, accent-dotted, orbit-app tagged "main".
  const files = window.locator('[data-rail-item="files"]')
  if (!/\bactive\b/.test((await files.getAttribute('class')) ?? '')) await files.click()
  await expect(pane(window).getByText('orbit-app', { exact: true })).toBeVisible({
    timeout: 150_000,
  })
  // orbit-app's expanded root listing is long enough to push orbit-core's
  // section header below the virtualized fl-list window — collapse the first
  // section (a real fold interaction) so both headers share the viewport.
  await pane(window).getByText('orbit-app', { exact: true }).click()
  await expect(pane(window).getByText('orbit-core', { exact: true })).toBeVisible({
    timeout: 30_000,
  })
  await expect(pane(window).locator('span[title="This thread’s primary project"]')).toHaveCount(1)
  expect(await pane(window).locator(ACCENT_SPAN).count()).toBeGreaterThanOrEqual(2)

  // Source Control: two REAL repo groups, each header showing its repo's
  // actual current branch (read from the repos themselves, never hardcoded).
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(window.locator('.gp-group-head')).toHaveCount(2, { timeout: 60_000 })
  const appGroup = window.locator('.gp-group', {
    has: window.locator('.gp-group-name', { hasText: 'orbit-app' }),
  })
  const coreGroup = window.locator('.gp-group', {
    has: window.locator('.gp-group-name', { hasText: 'orbit-core' }),
  })
  await expect(appGroup.locator('.gp-group-tag', { hasText: 'main' })).toBeVisible()
  await expect(appGroup.locator('.gp-group-branch')).toHaveText(realBranch(LIVE_PROJECT), {
    timeout: 60_000,
  })
  await expect(coreGroup.locator('.gp-group-branch')).toHaveText(realBranch(LIVE_SIBLING), {
    timeout: 60_000,
  })

  await window.screenshot({ path: '/tmp/live-multi-project.png' })
})
