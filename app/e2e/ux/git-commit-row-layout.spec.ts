/**
 * Regression probe for #1489 ("source control bug") — the COMMITS list rendering
 * with its text sliced in half.
 *
 * Root cause the screenshot showed: Source Control rows live inside `<fl-list>`,
 * a virtualized list that absolutely positions every row at `index * rowHeight`
 * and hard-caps it at `height: rowHeight` with `overflow: hidden`
 * (components/fl-list.ts). `.gp-row` nonetheless carried `flex-wrap: wrap`
 * (added by #1137 to keep narrow-panel conflict buttons reachable), so a commit
 * whose subject is wider than the panel pushed `.gp-meta` ("<author> · <age>")
 * onto a SECOND line. Two lines inside a 28px clipped box = both lines cut
 * through the middle — exactly what the issue reported.
 *
 * A second line can never be visible inside a fixed-`rowHeight` virtual row, so
 * the assertions here are about the invariant, not about pixels: subject and
 * meta must share one baseline, and both must lie inside the row's own box.
 *
 * Non-vacuous by construction: the seeded subject is far wider than any panel
 * width, so it MUST be ellipsized on line 1. Under the pre-fix CSS the meta sits
 * ~17px lower and outside the clipped row; a fix that merely hid the overflow
 * would fail `sameLine`, and a fix that only widened the row would fail
 * `metaWithinRow` against the list's own rowHeight.
 *
 * Test 2 covers the other defect visible in the same screenshot: the "Load older
 * commits" control (#1335) shipped with NO stylesheet rule at all, so it rendered
 * as a raw UA button — a light-grey shrink-to-fit pill in a dark panel.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, gitRetry } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { LOG_PAGE_SIZE } from '../../src/renderer/git/commit-log-window'

/** The app's own status refreshes take .git/index.lock — retry through it. */
function git(dir: string, ...args: string[]): string {
  return gitRetry(dir, ...args)
}

function configure(dir: string): void {
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
}

/** Wider than any realistic panel — guarantees the ellipsis path is exercised. */
const LONG_SUBJECT =
  'test(phase-4.task-1): cover en-US baseline floor + language-only SDK locale coercion across every translated surface'

async function openGitPanel(window: Page): Promise<void> {
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
}

test.afterAll(() => cleanupSeeds())

test.describe('git commit row layout (#1489)', () => {
  test('a long commit subject keeps its meta on the same line, inside the virtual row', async ({
    window,
  }) => {
    const dir = await seedProject(window, 'flow-git-rowlayout-')
    configure(dir)

    writeFileSync(join(dir, 'alpha.txt'), 'seed\n')
    git(dir, 'add', 'alpha.txt')
    git(dir, 'commit', '-q', '-m', LONG_SUBJECT)

    await activateProject(window, dir)
    await openGitPanel(window)

    const subject = window.locator('.gp-subject', { hasText: 'cover en-US baseline floor' })
    await expect(subject).toBeVisible()

    const geometry = await subject.evaluate((el) => {
      const content = el.closest('.gp-row') as HTMLElement
      const virtualRow = el.closest('.row') as HTMLElement
      const meta = content.querySelector('.gp-meta') as HTMLElement
      const s = el.getBoundingClientRect()
      const m = meta.getBoundingClientRect()
      const row = virtualRow.getBoundingClientRect()
      return {
        // Same line ⇒ tops agree (they differ by a full line-height when wrapped).
        lineDelta: Math.abs(s.top - m.top),
        contentHeight: content.getBoundingClientRect().height,
        rowHeight: row.height,
        metaWithinRow: m.top >= row.top - 1 && m.bottom <= row.bottom + 1,
        subjectWithinRow: s.top >= row.top - 1 && s.bottom <= row.bottom + 1,
        // Proof the subject really did overflow: it must be ellipsized.
        ellipsized: el.scrollWidth > el.clientWidth,
      }
    })

    expect(geometry.ellipsized).toBe(true)
    expect(geometry.lineDelta).toBeLessThan(4)
    expect(geometry.contentHeight).toBeLessThanOrEqual(geometry.rowHeight)
    expect(geometry.subjectWithinRow).toBe(true)
    expect(geometry.metaWithinRow).toBe(true)
  })

  test('the "Load older commits" control is a themed panel control, not a raw UA button', async ({
    window,
  }) => {
    // Every commit exists BEFORE the root is attached. Seeding afterwards lets a
    // refresh land mid-seed and read a PARTIAL history, and since #1438 a short
    // read is a fact the panel remembers ("git has nothing older") — it would
    // then correctly retire the affordance this test is about.
    const dir = await seedProject(window, 'flow-git-loadolder-', (repo) => {
      configure(repo)
      // Exactly one full page ⇒ commitLogWindow reports canLoadOlder (#1335).
      writeFileSync(join(repo, 'alpha.txt'), 'seed\n')
      git(repo, 'add', 'alpha.txt')
      git(repo, 'commit', '-q', '-m', 'chore: seed')
      for (let i = 1; i < LOG_PAGE_SIZE; i += 1) {
        git(repo, 'commit', '-q', '--allow-empty', '-m', `chore: filler ${i}`)
      }
    })

    await activateProject(window, dir)
    await openGitPanel(window)

    const older = window.locator('.gp-load-older')
    await expect(older).toBeVisible()
    await expect(older).toHaveText('Load older commits')

    const style = await older.evaluate((el) => {
      const computed = getComputedStyle(el)
      const panel = document.querySelector('.gp-root') as HTMLElement
      return {
        // A UA-default button is shrink-to-fit (~140px); a panel control spans it.
        widthRatio: el.getBoundingClientRect().width / panel.getBoundingClientRect().width,
        // A UA-default button ignores the inherited UI font entirely.
        fontFamily: computed.fontFamily,
        panelFontFamily: getComputedStyle(panel).fontFamily,
        borderStyle: computed.borderTopStyle,
      }
    })

    expect(style.widthRatio).toBeGreaterThan(0.8)
    expect(style.fontFamily).toBe(style.panelFontFamily)
    // The UA default is an `outset` bevel — a themed control never is.
    expect(style.borderStyle).not.toBe('outset')
  })

  /**
   * The guarantee #1137 bought with `flex-wrap: wrap`, kept without it.
   *
   * Its complaint was real: on a narrow panel the merge-section buttons
   * ("Accept <branch>", "Resolve") were pushed past the panel edge and became
   * unreachable. Wrapping them onto a second line only looked like a fix,
   * because the row is height-clipped — it traded an off-screen button for a
   * sliced one (#1489). The actual fix is that the PATH yields first, so this
   * asserts both halves at once: nothing overflows, and nothing wraps.
   *
   * The panel is constrained inline rather than by dragging the splitter — the
   * behaviour under test is purely a function of the panel's width.
   */
  test('on a narrow panel a long conflicted path yields so the actions stay on the row', async ({
    window,
  }) => {
    const conflicted = 'src/app/(protected)/settings/integrations/connection-notes.txt'
    const dir = await seedProject(window, 'flow-git-narrowrow-', (repo) => {
      const body = (v: string): string => ['intro', v, 'outro', ''].join('\n')
      configure(repo)
      mkdirSync(dirname(join(repo, conflicted)), { recursive: true })
      writeFileSync(join(repo, conflicted), body('base'))
      git(repo, 'add', conflicted)
      git(repo, 'commit', '-q', '-m', 'base')
      const main = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
      git(repo, 'checkout', '-q', '-b', 'topic-blue')
      writeFileSync(join(repo, conflicted), body('blue'))
      git(repo, 'commit', '-q', '-am', 'blue')
      git(repo, 'checkout', '-q', main)
      writeFileSync(join(repo, conflicted), body('trunk'))
      git(repo, 'commit', '-q', '-am', 'trunk')
      try {
        git(repo, 'merge', 'topic-blue')
      } catch {
        /* the conflict is the point */
      }
    })

    await activateProject(window, dir)
    await openGitPanel(window)

    const row = window.locator('.gp-row', { hasText: 'connection-notes.txt' }).first()
    await expect(row).toBeVisible()

    // Squeeze the panel well below the width #1137 was reported at.
    await window.locator('.gp-root').evaluate((el) => {
      ;(el as HTMLElement).style.width = '300px'
    })

    const layout = await row.evaluate((content) => {
      const virtualRow = content.closest('.row') as HTMLElement
      const bounds = virtualRow.getBoundingClientRect()
      const buttons = [...content.querySelectorAll('.gp-row-actions button')] as HTMLElement[]
      return {
        buttonCount: buttons.length,
        contentHeight: content.getBoundingClientRect().height,
        rowHeight: bounds.height,
        // Reachable = drawn inside the row's own box, horizontally and vertically.
        allInside: buttons.every((b) => {
          const r = b.getBoundingClientRect()
          return (
            r.left >= bounds.left - 1 &&
            r.right <= bounds.right + 1 &&
            r.top >= bounds.top - 1 &&
            r.bottom <= bounds.bottom + 1
          )
        }),
        // The path is what gave way — proof the space came from somewhere real.
        pathEllipsized: [...content.querySelectorAll('.gp-dir, .gp-name')].some(
          (el) => el.scrollWidth > el.clientWidth,
        ),
      }
    })

    expect(layout.buttonCount).toBeGreaterThan(0)
    expect(layout.allInside).toBe(true)
    expect(layout.contentHeight).toBeLessThanOrEqual(layout.rowHeight)
    expect(layout.pathEllipsized).toBe(true)
  })
})
