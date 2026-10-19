import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { diveIntoCell } from './fixtures/territory'

/**
 * THE PALETTE, MEASURED ON GLASS.
 *
 * Nothing in this file asserts a colour value — the numbers were settled by the
 * validator before a line of CSS moved, and re-asserting them here would only
 * copy them into a second place to drift. What a live window can say that a
 * validator cannot is whether the marks are still TELLABLE APART when the hue
 * is taken away, which is the claim the whole design rests on: form first,
 * colour second.
 *
 * So this probe does two things and writes the evidence to /tmp:
 *   1. the real board, per theme — sheet, cells, title strip, control
 *   2. the four understanding states plus the two in-flight marks, drawn with
 *      the REAL classes against the REAL stylesheet, shot in colour and again
 *      with saturation removed
 *
 * The swatch is built from the same class names `#buildTerritoryCell` puts on a
 * cell, so it inherits whatever the board's tokens currently resolve to. If
 * someone repaints a state, this picture changes with it.
 */

test.afterAll(() => cleanupSeeds())

const SHOT = '/tmp'
const boardRoot = '.flow-board-root'

function writeFeature(dir: string, slug: string, name: string, extra: readonly string[] = []): void {
  const featureDir = join(dir, 'flow', 'brain', 'features')
  mkdirSync(featureDir, { recursive: true })
  writeFileSync(
    join(featureDir, `${slug}.md`),
    [
      '---',
      `id: feature:${slug}`,
      `name: ${name}`,
      'kind: core',
      'anchors: [src/index.ts]',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${name}`,
      '',
      'Seeded by the palette probe.',
      '',
      ...extra,
    ].join('\n'),
    'utf8',
  )
}

/** Force the app's theme the way the user's toggle does, then let the board
 *  restyle. `data-theme` beats prefers-color-scheme in both directions. */
async function useTheme(window: Page, theme: 'light' | 'dark'): Promise<void> {
  await window.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t)
  }, theme)
  await window.waitForTimeout(400)
}

/**
 * The four states + both in-flight rings, drawn INTO the live board so the
 * board's own tokens paint them. Returns the swatch's selector.
 *
 * Deliberately built from markup rather than from data: seeding a real project
 * into all four understandings (and a pass in flight) takes a fixture per state
 * and still would not put them side by side, which is the one arrangement that
 * answers "are these tellable apart".
 */
async function mountStateSwatch(window: Page): Promise<void> {
  await window.evaluate(() => {
    document.querySelector('#palette-swatch')?.remove()
    const host = document.createElement('div')
    host.id = 'palette-swatch'
    host.style.cssText =
      'position:fixed;left:0;top:0;z-index:99999;padding:14px;display:flex;gap:10px;' +
      'background:var(--fb-paper);'

    const states = [
      ['none', 'fb-learn-none', ''],
      ['learning', 'fb-learn-learning', ''],
      ['learned', 'fb-learn-learned', ''],
      ['stale', 'fb-learn-stale', ''],
      ['in-flight self', 'fb-learn-learning', 'fb-terr-inflight'],
      ['in-flight within', 'fb-learn-none', 'fb-terr-inflight-within'],
    ] as const

    for (const [label, dotClass, flightClass] of states) {
      // A REAL CELL, not a mock of one: the same classes `#buildTerritoryCell`
      // writes, so the swatch inherits the sheet's own paint.
      const cell = document.createElement('div')
      cell.className = ['fb-terr-cell', 'fb-terr-cell-feature', 'fb-terr-roomy', flightClass]
        .filter((name) => name.length > 0)
        .join(' ')
      // The swatch is not on a laid-out sheet, so the rectangle the layout would
      // have placed is given here — nothing else about the cell is synthesised.
      cell.style.cssText = 'position:relative;width:84px;height:64px;'

      const kicker = document.createElement('div')
      kicker.className = 'fb-terr-cell-kicker'
      const dot = document.createElement('span')
      dot.className = `fb-learn-dot ${dotClass}`
      kicker.appendChild(dot)
      cell.appendChild(kicker)

      const name = document.createElement('div')
      name.className = 'fb-terr-cell-name'
      name.textContent = label
      cell.appendChild(name)

      host.appendChild(cell)
    }
    document.querySelector('.flow-board-root')?.appendChild(host)
  })
  await window.waitForTimeout(250)
}

test.describe('the board palette, on glass', () => {
  test.slow()

  test('three surfaces, four states, and the states survive greyscale', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    // Written BEFORE the project is added: adding it moves its knowledge into
    // the Workspace, and a file written mid-move lands in the backup.
    const root = await seedProject(window, 'flow-ux-palette-', (dir) => {
      writeFeature(dir, 'ingest', 'Ingest')
      writeFeature(dir, 'playbooks', 'Playbooks')
      writeFeature(dir, 'chats', 'Chats')
    })
    await activateProject(window, root)

    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator(boardRoot)).toBeVisible({ timeout: 45_000 })
    // WAIT FOR THE PICTURE, not for the pane. The first cut shot at a fixed
    // 2.5s and caught "Deriving blueprint…" — a screenshot of the loader,
    // which says nothing about the palette.
    await expect(window.locator('.fb-terr-cell').first()).toBeAttached({ timeout: 45_000 })
    await expect(window.locator('.fb-terr-title')).toBeAttached({ timeout: 45_000 })
    await window.waitForTimeout(1200)

    for (const theme of ['dark', 'light'] as const) {
      await useTheme(window, theme)
      const name = theme === 'light' ? 'vellum' : 'dark'
      await window.locator(boardRoot).screenshot({ path: `${SHOT}/palette-${name}.png` })

      // What the tokens actually resolved to on this surface — reported, never
      // asserted; the validator owns the numbers.
      const tokens = await window.evaluate(() => {
        const el = document.querySelector('.flow-board-root')!
        const s = getComputedStyle(el)
        return {
          paper: s.getPropertyValue('--fb-paper').trim(),
          card: s.getPropertyValue('--fb-card').trim(),
          accent: s.getPropertyValue('--fb-accent').trim(),
          known: s.getPropertyValue('--fb-learn-known').trim(),
          stale: s.getPropertyValue('--fb-learn-stale').trim(),
        }
      })
      console.log(`[measured] ${name} tokens:`, JSON.stringify(tokens))
      expect(tokens.known).not.toBe('')
      // THE POINT OF THE WHOLE EXERCISE: `learned` is no longer the sheet.
      expect(tokens.known).not.toBe(tokens.accent)
    }

    // ── The four states, side by side, in colour and then without it ──────
    await useTheme(window, 'dark')
    await mountStateSwatch(window)
    await window.locator('#palette-swatch').screenshot({ path: `${SHOT}/palette-states-dark.png` })
    await window.evaluate(() => {
      ;(document.querySelector('#palette-swatch') as HTMLElement).style.filter = 'grayscale(1)'
    })
    await window.waitForTimeout(200)
    await window
      .locator('#palette-swatch')
      .screenshot({ path: `${SHOT}/palette-states-greyscale.png` })

    // The greyscale claim, as a number rather than as a look: sample the two
    // FILLED states and confirm they are still different lightnesses once the
    // hue is gone. Form separates the other two (ring vs broken ring), which a
    // pixel sample cannot see and a human reading the crop can.
    const grey = await window.evaluate(() => {
      const lum = (hex: string): number => {
        const m = /rgba?\((\d+), ?(\d+), ?(\d+)/.exec(hex)
        if (!m) return -1
        const [r, g, b] = [1, 2, 3].map((i) => {
          const c = Number(m[i]) / 255
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
      const fill = (cls: string): string => {
        const el = document.querySelector(`#palette-swatch .fb-learn-dot.${cls}`)!
        return getComputedStyle(el).backgroundColor
      }
      const a = lum(fill('fb-learn-learned'))
      const b = lum(fill('fb-learn-learning'))
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    })
    console.log(`[measured] greyscale separation learned↔learning: ${grey.toFixed(2)}:1`)
    // 1.3 is the point where two flat fills stop reading as one fill. Measured
    // at 1.54 on this surface; the floor is here to catch a repaint that
    // collapses them, not to pin the exact value.
    expect(grey).toBeGreaterThan(1.3)

    await window.evaluate(() => document.querySelector('#palette-swatch')?.remove())
    expect(errors).toEqual([])
  })

  test('the level control: a diagram, at the size it is actually drawn', async ({ window }) => {
    const root = await seedProject(window, 'flow-ux-glyph-')
    // Ingest has a PART, so it can be dived into: the level control rides the
    // dived level's title strip now (a cell has no door of its own — plan
    // cell-hover-diagram, FR-5).
    writeFeature(root, 'ingest', 'Ingest', ['## Parts', '', '### Reader', 'Reads the input.', 'anchors: src/index.ts', ''])
    writeFeature(root, 'playbooks', 'Playbooks')
    await activateProject(window, root)

    await window.locator(statusButtonByText('Blueprint')).click()
    await expect(window.locator(boardRoot)).toBeVisible({ timeout: 45_000 })
    await expect(window.locator('.fb-terr-cell').first()).toBeAttached({ timeout: 45_000 })
    await diveIntoCell(window, 'Ingest')
    await window.mouse.move(0, 0)
    await window.waitForTimeout(1200)

    const control = window.locator('.fb-terr-control[data-control-glyph="diagram"]').first()
    await expect(control).toBeAttached({ timeout: 30_000 })

    // The single-source property, held at both ends: the sheet stamps the same
    // name the empty-level sentence interpolates.
    const stamped = await control.evaluate((el) => (el as HTMLElement).dataset['controlGlyph'])
    console.log(`[measured] control glyph name: ${stamped}`)
    expect(stamped).toBe('diagram')

    // It is DRAWN, not typed — two cards, one edge, no text node.
    const drawn = await control.evaluate((el) => ({
      nodes: el.querySelectorAll('.fb-terr-control-node').length,
      edges: el.querySelectorAll('.fb-terr-control-edge').length,
      text: el.querySelectorAll('text').length,
      label: el.getAttribute('aria-label'),
      tip: el.getAttribute('title') ?? '',
    }))
    console.log(`[measured] control mark:`, JSON.stringify(drawn))
    expect(drawn).toMatchObject({ nodes: 2, edges: 1, text: 0 })
    // The accessible name and tooltip are what they always were.
    expect(drawn.label).toContain('feature view')
    expect(drawn.tip).toContain('feature view')

    // TRUE SIZE, both themes, and next to the cell it belongs to — the mark and
    // the understanding dot share that cell's rectangle, so they get looked at
    // together or not at all.
    for (const theme of ['dark', 'light'] as const) {
      await useTheme(window, theme)
      const box = await control.boundingBox()
      if (box === null) throw new Error('control has no box')
      await window.screenshot({
        path: `${SHOT}/palette-control-${theme === 'light' ? 'vellum' : 'dark'}.png`,
        clip: {
          x: Math.max(0, box.x - 96),
          y: Math.max(0, box.y - 58),
          width: 190,
          height: 130,
        },
      })
      // …and a TIGHT 1:1 crop of the mark alone. Same rendering, less around
      // it: this is the frame the first design failed in (it read as ">"), so
      // it is the frame every future one has to be judged in.
      await window.screenshot({
        path: `${SHOT}/palette-control-tight-${theme === 'light' ? 'vellum' : 'dark'}.png`,
        clip: {
          x: Math.max(0, box.x - 10),
          y: Math.max(0, box.y - 10),
          width: 40,
          height: 40,
        },
      })
      console.log(
        `[measured] ${theme} control box: ${box.width.toFixed(1)}×${box.height.toFixed(1)} at (${box.x.toFixed(0)},${box.y.toFixed(0)})`,
      )
    }

    // Keyboard reach is unchanged by moving it: a tab stop with a button role.
    // It is a real <button> now (`#buildTerritoryControl`), so both come from
    // the element rather than from attributes stamped on an SVG group.
    const reach = await control.evaluate((el) => ({ tag: el.tagName, tabIndex: (el as HTMLElement).tabIndex }))
    expect(reach).toEqual({ tag: 'BUTTON', tabIndex: 0 })
    await expect(control).toHaveRole('button')
  })
})
