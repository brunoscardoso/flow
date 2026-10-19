import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The merge section survives a narrow panel — reported live, twice.
 *
 * The controls used to be labelled with the BRANCH NAME, so their width came
 * from the repository rather than from the design. With a real branch in it
 * ("ACME-2446-rework-the-session-cache-for-the-new-router") the Source
 * Control sidebar rendered a bulk button clipped to
 * "Keep all from both (ACME-2446-rework-the-session-cac…", a per-row control
 * reading "Jse ACME-2446-rework-the-session-cache-for-the-new-route"
 * and a risk badge reading "Separate ed" — three clipped words, none of which
 * is a word.
 *
 * This drives the real panel at three widths with that exact branch name and a
 * three-file conflict, and asserts the thing the unit tests cannot: that no
 * rendered control is wider than the box it is painted in. The legend is the
 * one element allowed to ellipsize — identity lives there precisely so that the
 * ACTIONS never have to.
 */
const LONG_BRANCH = 'ACME-2446-rework-the-session-cache-for-the-new-router'

/** Narrow / the width this was reported at / wide. */
const PANEL_WIDTHS = [320, 500, 900]

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/**
 * Resize the Source Control panel the way the splitter does.
 *
 * <fl-split> keeps its pane wrappers in its own SHADOW root and slots the light
 * children into them, so a pane child's `parentElement` is the <fl-split> host:
 * sizing that resizes the whole split, not the pane (measured — a 320px request
 * produced a 70px panel).
 */
function setPanelWidth(w: number): void {
  const bar = document.querySelector('.fl-activity-sidebar') as HTMLElement | null
  if (bar === null) throw new Error('no activity sidebar')
  const slot = bar.getAttribute('slot') ?? ''
  const split = document.getElementById('fl-split-root') as HTMLElement
  const shadow = split.shadowRoot
  if (shadow === null) throw new Error('fl-split has no shadow root')
  for (const pane of Array.from(shadow.querySelectorAll('.pane')) as HTMLElement[]) {
    const named = pane.querySelector('slot')?.getAttribute('name')
    pane.style.flex = named === slot ? `0 0 ${w}px` : '1 1 0px'
  }
}

/** Every leaf text node inside the merge section that is painted narrower than
 *  its own content — i.e. every clipped word on screen. Walks shadow roots,
 *  because the file rows live inside each <fl-list>'s. */
function clippedText(): { cls: string; text: string }[] {
  const root = document.querySelector('.gp-merge-section') as HTMLElement
  const clipped: { cls: string; text: string }[] = []
  const walk = (node: ParentNode): void => {
    for (const el of Array.from(node.querySelectorAll('*')) as HTMLElement[]) {
      if (el.shadowRoot) walk(el.shadowRoot)
      if (el.childElementCount > 0) continue
      const text = (el.textContent ?? '').trim()
      if (text === '' || el.offsetParent === null) continue
      if (el.scrollWidth > el.clientWidth + 1) {
        clipped.push({ cls: el.className || el.tagName, text })
      }
    }
  }
  walk(root)
  return clipped
}

function seedConflictRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-conflict-ui-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\n')
  const files = ['src/chat/persistence.ts', 'src/chat/engine.ts', 'src/chat/index.ts']
  mkdirSync(join(dir, 'src', 'chat'), { recursive: true })
  for (const file of files) writeFileSync(join(dir, file), 'export const mode = "base"\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'base')
  git(dir, 'checkout', '-q', '-b', LONG_BRANCH)
  for (const file of files) writeFileSync(join(dir, file), 'export const mode = "engine"\n')
  git(dir, 'commit', '-q', '-am', 'engine')
  git(dir, 'checkout', '-q', 'main')
  for (const file of files) writeFileSync(join(dir, file), 'export const mode = "nextjs"\n')
  git(dir, 'commit', '-q', '-am', 'nextjs')
  // HEAD = the long branch, merging main in — exactly the reported screen.
  git(dir, 'checkout', '-q', LONG_BRANCH)
  try {
    git(dir, 'merge', 'main')
  } catch {
    // Expected — the tree now carries markers.
  }
  return dir
}

test.afterAll(() => cleanupSeeds())

test('no conflict control clips at any panel width', async ({ window }) => {
  const dir = seedConflictRepo()
  await window.evaluate(async (path) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path })
  }, dir)
  await activateProject(window, dir)

  await window.locator('[data-rail-item="source-control"]').click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(window.locator('.gp-merge-section')).toBeVisible({ timeout: 20_000 })

  // Identity appears ONCE, as a legend, and it is the real branch name.
  await expect(window.locator('.gp-legend-branch').first()).toHaveText(LONG_BRANCH)
  await expect(window.locator('.gp-legend-branch')).toHaveCount(2)

  for (const width of PANEL_WIDTHS) {
    await window.evaluate(setPanelWidth, width)
    await expect(window.locator('.gp-risk-risky, .gp-risk-safe').first()).toBeVisible({
      timeout: 15_000,
    })
    await window.waitForTimeout(400)

    // 1. The section itself never scrolls sideways.
    const box = await window.evaluate(() => {
      const root = document.querySelector('.gp-merge-section') as HTMLElement
      return { scroll: root.scrollWidth, client: root.clientWidth }
    })
    expect(box.client).toBeLessThanOrEqual(width)
    expect(box.scroll).toBeLessThanOrEqual(box.client)

    // 2. Nothing inside it is painted narrower than its own text — except the
    //    legend's branch name, the one string designed to give way.
    const clipped = await window.evaluate(clippedText)
    expect(
      clipped.filter((entry) => !entry.cls.includes('gp-legend-branch')),
      `clipped at ${width}px: ${JSON.stringify(clipped)}`,
    ).toEqual([])

    // 3. The bulk choices are all three present and all three whole — the
    //    third one used to truncate mid-word.
    const bulk = window.locator('.gp-bulk-keepall .gp-bulk-label')
    await expect(bulk).toHaveText(['Use current', 'Use incoming', 'Keep both'])
  }
})
