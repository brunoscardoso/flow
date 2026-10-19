import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { openFeatureViewByName } from './fixtures/territory'
import { MIN_STAGE_PX } from '../../src/renderer/blueprint/peek-model'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * MEASUREMENT probe for the dead band between the brief's stage and the drawer
 * below it — a black strip the width of the board that belongs to nothing.
 *
 * `.fb-stage` is `flex: 1 1 auto; min-height: 0`, so it is not the obvious
 * culprit; this measures the real boxes rather than guessing which ancestor
 * stops short. It asserts the invariant afterwards, so it doubles as the
 * regression guard: no vertical gap between the stage and the drawer.
 */

test.afterAll(() => cleanupSeeds())

function writeFeature(root: string, slug: string, name: string): void {
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${slug}.md`),
    [
      '---',
      `id: feature:${slug}`,
      `name: ${name}`,
      'kind: core',
      'anchors: [module:src]',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${name}`,
      '',
      'Seeded by the brief-layout probe.',
      // A PART, so the feature has a level whose title strip carries the
      // feature-view door (a part-less one reads as its code story).
      '',
      '## Parts',
      '',
      '### Index',
      'The entry point.',
      '',
    ].join('\n'),
  )
}

test('no dead band between the brief stage and the drawer', async ({ window }) => {
  test.setTimeout(180_000)

  const root = await seedProject(window, 'flow-ux-brief-layout-', (dir) => {
    writeFeature(dir, 'layout-probe', 'Layout Probe')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1\n')
  })
  await activateProject(window, root)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()

  const card = window.locator('.fb-terr-cell', { hasText: 'Layout Probe' }).first()
  await expect(card).toBeVisible({ timeout: 120_000 })
  // THE BRIEF OPENS FROM ITS LEVEL'S DOOR: dive into the feature, then the
  // title strip's "Open … feature view" control (cells have no door of their
  // own any more, plan cell-hover-diagram FR-5).
  await openFeatureViewByName(window, 'Layout Probe')

  // The feature view opens on its derived level; pressing a component opens
  // the drawer below the stage — the pair whose seam this measures. (The old
  // brief bar auto-opened the drawer for an unlearned feature; the derived
  // level waits for the reader's press.)
  const component = window.locator('.flow-board-root .fb-curated-card').first()
  await expect(component).toBeVisible({ timeout: 60_000 })
  await component.click()
  await expect(window.locator('.fb-brief-drawer')).toBeVisible({ timeout: 60_000 })

  const boxes = await window.evaluate(() => {
    const rect = (sel: string): { top: number; bottom: number; h: number } | null => {
      const el = document.querySelector(sel)
      if (el === null) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
    }
    const stage = document.querySelector('.fb-stage')
    // What fills the pane above the drawer: the stage AND, under it, the
    // level's foot row (its slot chips — "Verification", …). That row is
    // content; the band this guards against is space that belongs to nothing.
    const main = stage?.parentElement
    const filledTo = main
      ? Math.max(...[...main.children].map((c) => Math.round(c.getBoundingClientRect().bottom)))
      : null
    return {
      filledTo,
      root: rect('.flow-board-root'),
      stage: rect('.fb-stage'),
      drawer: rect('.fb-brief-drawer'),
      stageParent: (() => {
        const p = stage?.parentElement
        if (!p) return null
        const r = p.getBoundingClientRect()
        return {
          cls: p.className,
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          h: Math.round(r.height),
        }
      })(),
    }
  })
  console.log('BRIEF_LAYOUT:' + JSON.stringify(boxes))

  // THE INVARIANT: the drawer starts where the pane's content ends (the stage,
  // then the level's foot row). A gap here is the black band — nothing renders
  // in it, and it is the width of the board.
  expect(boxes.stage, 'no stage').not.toBeNull()
  expect(boxes.drawer, 'no drawer').not.toBeNull()
  const gap = (boxes.drawer?.top ?? 0) - (boxes.filledTo ?? boxes.stage?.bottom ?? 0)
  expect(gap, `dead band of ${gap}px between the stage and the drawer`).toBeLessThanOrEqual(2)

  // ── THE STAGE KEEPS A FLOOR (2026-08-28). With the brief bar AND its
  // auto-opened drawer sharing a short pane, the stage measured 0px on the
  // real repo — the bar alone was 279px of a 317px pane — and the level's
  // cards were drawn with nowhere to be. Two rules, both measured here: the
  // bar takes at most its share of pane 1 (`#capBriefBar`), and the split's
  // fractions are re-clamped on every resize so the stage keeps at least the
  // split's own pane minimum (`sizesKeepingStage`, MIN_STAGE_PX when the pane
  // can afford it). ──
  const floor = await window.evaluate(() => {
    const h = (sel: string): number =>
      Math.round(document.querySelector(sel)?.getBoundingClientRect().height ?? 0)
    return { stage: h('.fb-stage'), bar: h('.fb-brief-bar'), main: h('.fb-main') }
  })
  console.log('BRIEF_FLOOR:' + JSON.stringify(floor))
  expect(floor.bar, 'the brief bar took more than its share of the pane').toBeLessThanOrEqual(
    Math.max(96, floor.main * 0.4) + 2,
  )
  expect(floor.stage, `the stage was squeezed to ${String(floor.stage)}px`).toBeGreaterThanOrEqual(
    Math.min(MIN_STAGE_PX, 120),
  )
})
