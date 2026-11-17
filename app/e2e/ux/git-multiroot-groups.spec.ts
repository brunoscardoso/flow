/**
 * UX sweep — flow `git` (rotation index 6), round 19: the MULTI-ROOT grouped
 * Source Control panel (multi-project threads Phase 4, `deriveGitGroups`).
 *
 * Every other git spec drives a SINGLE-root panel, where `deriveGitGroups`
 * returns chromeless groups and the whole grouping layer is inert. Nothing under
 * `e2e/ux/` has ever rendered `.gp-group` chrome (the only `.gp-group-head`
 * reference in the suite is `live-multi-project-probe.spec.ts`, which is skipped
 * on any machine without the orbit pair). This probe drives it seeded, so a
 * thread spanning TWO repos is exercised on every run:
 *
 *  - both repos render their own group (name + branch + change list + commit box)
 *  - each group's Changes list contains only THAT repo's file
 *  - committing in one group commits only that repo (per-root IPC)
 *  - the section fold is per-group, not global (#1143 tripwire)
 *  - destructive confirms name the repo they will destroy (#1144 tripwire)
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, gitRetry, openThreadByTitle } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'

const SHOTS = join(__dirname, '__screens')

/** One commit, then one uncommitted working-tree edit of `<name>.txt`. */
function populate(name: string) {
  return (dir: string): void => {
    gitRetry(dir, 'config', 'user.email', 'qa@flow.test')
    gitRetry(dir, 'config', 'user.name', 'QA Bot')
    writeFileSync(join(dir, `${name}.txt`), 'base\n')
    gitRetry(dir, 'add', `${name}.txt`)
    gitRetry(dir, 'commit', '-q', '-m', `feat: add ${name}`)
    writeFileSync(join(dir, `${name}.txt`), 'base\nEDITED\n')
  }
}

/** The SAME relative path changed in both repos — the shape that makes a
 *  repo-blind confirm indistinguishable between the two groups. */
function populateSameName(dir: string): void {
  populate('README')(dir)
}

/** Seed two repos, put them both in one thread's scope, and open Source Control.
 *  Uses the REAL attach path (`threads:setRoots`) the multi-project picker calls. */
async function openTwoRepoPanel(
  window: Page,
  prepare: (name: 'alpha' | 'beta') => (dir: string) => void = populate,
): Promise<{ dirA: string; dirB: string }> {
  const dirA = await seedProject(window, 'flow-ux-mrA-', prepare('alpha'))
  const dirB = await seedProject(window, 'flow-ux-mrB-', prepare('beta'))
  await activateProject(window, dirA)

  const title = 'Multi-repo scope probe'
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
    { projectRoot: dirA, title },
  )
  await openThreadByTitle(window, title)
  await window.evaluate(
    async ({ threadId, roots }) => {
      await (
        window as unknown as {
          flow: { threads: { setRoots(i: { threadId: string; roots: string[] }): Promise<unknown> } }
        }
      ).flow.threads.setRoots({ threadId, roots })
    },
    { threadId, roots: [dirB] },
  )

  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(window.locator('.gp-group-head')).toHaveCount(2, { timeout: 30_000 })
  return { dirA, dirB }
}

const groupFor = (window: Page, dir: string) =>
  window.locator('.gp-group', {
    has: window.locator('.gp-group-name', { hasText: basename(dir) }),
  })

/** One repository is open at a time (2026-11-17): open this one. */
async function openGroup(window: Page, dir: string): Promise<void> {
  const head = groupFor(window, dir).locator('.gp-group-head')
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
  await expect(head).toHaveAttribute('aria-expanded', 'true')
}

test.afterAll(() => cleanupSeeds())

test.describe('multi-root Source Control groups', () => {
  test('a thread spanning two repos renders one group per repo, each committing only its own', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const { dirA, dirB } = await openTwoRepoPanel(window)
    const groupA = groupFor(window, dirA)
    const groupB = groupFor(window, dirB)

    // Each group lists ONLY its own repo's changed file.
    await openGroup(window, dirA)
    await expect(groupA.locator('.gp-name', { hasText: 'alpha.txt' })).toHaveCount(1)
    await expect(groupA.locator('.gp-name', { hasText: 'beta.txt' })).toHaveCount(0)
    await openGroup(window, dirB)
    await expect(groupB.locator('.gp-name', { hasText: 'beta.txt' })).toHaveCount(1)
    await expect(groupB.locator('.gp-name', { hasText: 'alpha.txt' })).toHaveCount(0)

    // Each group carries its own commit box; drafts are per-root and survive
    // the group being folded while the other one is open.
    await openGroup(window, dirA)
    await expect(groupA.locator('.gp-commit-msg')).toHaveCount(1)
    await groupA.locator('.gp-commit-msg').fill('chore: only alpha')
    await openGroup(window, dirB)
    expect(await groupB.locator('.gp-commit-msg').inputValue()).toBe('')
    await openGroup(window, dirA)
    await expect(groupA.locator('.gp-commit-msg')).toHaveValue('chore: only alpha')

    // Stage + commit in group A only.
    await groupA
      .locator('.gp-section-head', { hasText: 'Changes' })
      .locator('.gp-bulk-approve')
      .click()
    await expect(groupA.locator('.gp-commit-btn')).toBeEnabled({ timeout: 10_000 })
    await groupA.locator('.gp-commit-btn').click()

    // A got the commit; B's tree is untouched.
    await expect
      .poll(() => gitRetry(dirA, 'log', '-1', '--format=%s').trim(), { timeout: 15_000 })
      .toBe('chore: only alpha')
    expect(gitRetry(dirB, 'log', '-1', '--format=%s').trim()).toBe('feat: add beta')
    expect(gitRetry(dirB, 'status', '--porcelain').trim()).toContain('beta.txt')

    await window.screenshot({ path: join(SHOTS, 'git-multiroot-groups.png') })
    expect(errors, errors.join(', ')).toHaveLength(0)
  })

  test('a working-tree change written to the SECONDARY repo on disk surfaces in its group', async ({
    window,
  }) => {
    const { dirA, dirB } = await openTwoRepoPanel(window)
    const groupA = groupFor(window, dirA)
    const groupB = groupFor(window, dirB)

    await openGroup(window, dirB)
    writeFileSync(join(dirB, 'live-b.txt'), 'written straight to disk\n')
    await expect(groupB.locator('.gp-name', { hasText: 'live-b.txt' })).toHaveCount(1, {
      timeout: 15_000,
    })
    // …and it lands in B's group only.
    await expect(groupA.locator('.gp-name', { hasText: 'live-b.txt' })).toHaveCount(0)
  })

  test(
    '#1143: folding one repo group\'s "Changes" section must not fold the other repo\'s',
    async ({ window }) => {
      const { dirA, dirB } = await openTwoRepoPanel(window)
      const groupA = groupFor(window, dirA)
      const groupB = groupFor(window, dirB)

      await openGroup(window, dirA)
      await expect(groupA.locator('.gp-name', { hasText: 'alpha.txt' })).toHaveCount(1)

      // Fold ONLY group A's "Changes" section.
      await groupA
        .locator('.gp-section-head', { hasText: 'Changes' })
        .locator('.gp-section-toggle')
        .click()

      await expect(groupA.locator('.gp-name', { hasText: 'alpha.txt' })).toHaveCount(0)
      // The other repo's section was never touched — its rows must survive.
      await openGroup(window, dirB)
      await expect(groupB.locator('.gp-name', { hasText: 'beta.txt' })).toHaveCount(1)
      // …and A's fold is still A's when it is opened again.
      await openGroup(window, dirA)
      await expect(groupA.locator('.gp-name', { hasText: 'alpha.txt' })).toHaveCount(0)
    },
  )

  test(
    '#1144: the irreversible discard confirms must name the repo they will destroy',
    async ({ window }) => {
      // Both repos have the SAME relative path changed, so the confirm copy is
      // the only thing that can tell the two "Revert all" buttons apart.
      const { dirA, dirB } = await openTwoRepoPanel(window, () => populateSameName)
      const groupA = groupFor(window, dirA)
      const groupB = groupFor(window, dirB)

      const messages: string[] = []
      window.on('dialog', async (dialog) => {
        messages.push(dialog.message())
        await dialog.dismiss()
      })

      await openGroup(window, dirA)
      await groupA
        .locator('.gp-section-head', { hasText: 'Changes' })
        .locator('.gp-bulk-revert')
        .click()
      await expect.poll(() => messages.length, { timeout: 5000 }).toBe(1)
      await openGroup(window, dirB)
      await groupB
        .locator('.gp-section-head', { hasText: 'Changes' })
        .locator('.gp-bulk-revert')
        .click()
      await expect.poll(() => messages.length, { timeout: 5000 }).toBe(2)

      // Each confirm must identify ITS repo — otherwise the two irreversible
      // actions ask a byte-identical question.
      expect(messages[0]).toContain(basename(dirA))
      expect(messages[1]).toContain(basename(dirB))
      expect(messages[0]).not.toBe(messages[1])
    },
  )

  test('one repository is open at a time, and its graph fills the pane down to the folded ones', async ({
    window,
  }) => {
    const { dirA, dirB } = await openTwoRepoPanel(window)
    const headA = groupFor(window, dirA).locator('.gp-group-head')
    const headB = groupFor(window, dirB).locator('.gp-group-head')
    // Never two open: the first starts open, the second folded.
    await expect(headA).toHaveAttribute('aria-expanded', 'true')
    await expect(headB).toHaveAttribute('aria-expanded', 'false')
    await expect(window.locator('.gp-commit-msg')).toHaveCount(1)

    // Opening B folds A.
    await headB.click()
    await expect(headB).toHaveAttribute('aria-expanded', 'true')
    await expect(headA).toHaveAttribute('aria-expanded', 'false')
    await expect(window.locator('.gp-commit-msg')).toHaveCount(1)

    // Pressing the open one folds it: none open is allowed.
    await headB.click()
    await expect(headB).toHaveAttribute('aria-expanded', 'false')
    await expect(headA).toHaveAttribute('aria-expanded', 'false')

    // The graph takes what the pane leaves: no empty band under the folded
    // repository below it, and nothing pushed out of view. Seed enough history
    // to be taller than the pane.
    for (let i = 0; i < 80; i += 1) gitRetry(dirA, 'commit', '--allow-empty', '-q', '-m', `history ${i}`)
    await headA.click()
    await expect(headA).toHaveAttribute('aria-expanded', 'true')
    const graph = groupFor(window, dirA).locator('fl-list.gp-graph-list')
    await expect(graph).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        () =>
          window.locator('.gp-root').evaluate((root) => {
            const last = root.querySelector('.gp-group:last-child .gp-group-head')!.getBoundingClientRect()
            const box = root.getBoundingClientRect()
            return {
              overflow: root.scrollHeight - root.clientHeight,
              gapBelow: Math.round(box.bottom - last.bottom),
            }
          }),
        { timeout: 10_000 },
      )
      .toEqual(expect.objectContaining({ overflow: 0 }))
    const fit = await window.locator('.gp-root').evaluate((root) => {
      const last = root.querySelector('.gp-group:last-child .gp-group-head')!.getBoundingClientRect()
      const graphBox = root.querySelector('fl-list.gp-graph-list')!.getBoundingClientRect()
      return { gapBelow: root.getBoundingClientRect().bottom - last.bottom, graph: graphBox.height, pane: root.clientHeight }
    })
    // The folded repository sits at the bottom (one row of padding at most)…
    expect(fit.gapBelow).toBeLessThan(22 + 40)
    // …and the graph is the bulk of the pane, not a 40% slice.
    expect(fit.graph).toBeGreaterThan(fit.pane * 0.45)
    await window.screenshot({ path: join(SHOTS, 'git-multiroot-one-open.png') })
  })
})
