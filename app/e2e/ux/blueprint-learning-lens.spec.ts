import { test, expect } from '../fixtures/electron'
import type { Page } from '@playwright/test'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { waitForLinkedStructure } from './fixtures/linked-structure'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE LEARNING LENS, AND THE PERCENTAGE THAT CAME BACK
 * (plan_blueprint_territory_v1, Phase 8).
 *
 * Two claims live on this sheet and they are NOT the same claim, which is the
 * whole reason this probe exists:
 *
 *  1. UNDERSTANDING — does anyone know what this feature IS. That is the dot,
 *     and it is `understandingOf`'s answer. Untouched here.
 *  2. GROUND — of the MODULES this feature's files live in, how many has the
 *     learner read. That is the lens: a 3px line at the cell's foot, drawn only
 *     while the Learning panel is open, and NEVER a fill. A filled cell would
 *     read as (1) and the two would collapse into one wrong sentence.
 *
 * And a third, borrowed back from the ring: the PERCENTAGE a running pass has.
 * `origin/main` shipped it as an SVG collar around a disc (f96283a6 / 739048ff
 * / 381b0409); Territory has rectangles, so the same sixty ticks are worn small
 * on a cell's kicker row. Its decisions are asserted here because they are the
 * ones a re-host quietly loses: the figure is the TRUE ratio (not the tick
 * count), an absent fraction MARCHES rather than printing a number nothing
 * computed, and the strip's own figure counts what the sheet holds.
 *
 * WHAT IS REAL AND WHAT IS DRIVEN
 * ===============================
 * REAL: the repo, its features, the CLI's own derive, the module learning-state
 * the lens measures against, every press. The coverage lines come from a live
 * `blueprint:featureMap` spawn — nothing stubs the ground.
 * DRIVEN: the pass's PROGRESS. `learn:featureParts` lands on its own clock
 * (minutes, and only with an account bound), so it is injected from MAIN on the
 * same channel main raises it on. The renderer cannot tell the difference.
 */

const CLI = join(__dirname, '../../resources/cli/planflow-ai.mjs')
const boardRoot = '.flow-board-root'

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

function featureFile(dir: string, slug: string, name: string, anchor: string, learned = false): void {
  writeFileSync(
    join(dir, 'flow', 'brain', 'features', `${slug}.md`),
    [
      '---',
      `id: feat_${slug}`,
      `name: ${name}`,
      'kind: core',
      `anchors: [${anchor}]`,
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `${name} — seeded by the learning-lens probe.`,
      '',
      // UNDERSTOOD is the feature's own claim (its `## Learned`), never its
      // modules' — d5ae3b83 — so the one understood feature says so here.
      ...(learned ? ['## Learned', '', `- ${name} charges once per event <!-- learned: code 2026-08-27 -->`, ''] : []),
    ].join('\n'),
  )
}

/**
 * Two features over two modules, and exactly ONE of the modules learned.
 *
 * One learned and one not is the minimum that can tell a working lens from a
 * lens stuck on empty or stuck on full — a repo where every module reads the
 * same way would pass with the line hard-coded either way.
 */
function prepareRepo(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bp-lens', version: '1.0.0' }))
  for (const slug of ['billing', 'shipping']) {
    mkdirSync(join(dir, 'src', slug), { recursive: true })
    writeFileSync(join(dir, 'src', slug, 'index.ts'), `export const ${slug} = 1\n`)
  }
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=me@example.com', '-c', 'user.name=Me', 'commit', '-qm', 'init'])

  mkdirSync(join(dir, 'flow', 'brain', 'features'), { recursive: true })
  mkdirSync(join(dir, 'flow', 'brain', '.structure'), { recursive: true })
  featureFile(dir, 'billing', 'Billing', 'module:src/billing', true)
  featureFile(dir, 'shipping', 'Shipping', 'module:src/shipping')
  // `derive` refuses without flow/; the IDE provisioner normally creates it.
  execFileSync(process.execPath, [CLI, 'blueprint', 'derive'], { cwd: dir, stdio: 'ignore' })
}

/**
 * src/billing LEARNED — written once the project sits in its Workspace: the
 * migration and the provisioner's first pass replace `.structure` on the way
 * in, so a learning state seeded before the add does not survive it.
 */
async function seedLearned(window: Page, root: string): Promise<void> {
  const structure = await waitForLinkedStructure(window, root)
  writeFileSync(
    join(structure, 'learning-state.jsonl'),
    '{"module":"src/billing","status":"learned","notedAt":"2026-08-27T00:00:00Z"}\n',
  )
}

async function openBoard(window: Page): Promise<void> {
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator(boardRoot)).toBeVisible()
  await window.locator('.fb-terr-cell').first().waitFor({ state: 'visible', timeout: 60_000 })
}

/**
 * Open (or close) the Learning panel the way a reader does — the header's
 * permanent `Learn` button.
 *
 * NOT the learn CHIP. The chip is the progress readout beside it and it is
 * `hidden` until a pass has something to report — "the chip hides itself when
 * there is nothing learned yet, which is exactly when a user wants to check
 * whether learning is running", which is the sentence the permanent button was
 * added for (blueprint-board.ts, `#learningButton`). On this fixture the chip
 * stays hidden, so the old helper pressed a hidden element until it timed out
 * and reported it as a failure of the lens. The button opens the same panel
 * through the same `#toggleLearnPanel`.
 */
async function toggleLearnPanel(window: Page): Promise<void> {
  const entry = window.locator(`${boardRoot} fl-button[title="Show learning progress"]`)
  await expect(entry).toBeVisible({ timeout: 60_000 })
  await entry.click()
}

/**
 * The coverage line on each named cell, as the DOM actually reports it.
 *
 * Measured from the computed style, not from the class: a line that is present
 * in the markup and `display: none` is not a line the reader has. `(none)`
 * means no line element at all, which is the third and different answer for a
 * cell standing on nothing countable.
 */
async function coverageLines(window: Page): Promise<Record<string, string>> {
  return window.evaluate(() => {
    const out: Record<string, string> = {}
    for (const cell of document.querySelectorAll('.fb-terr-cell')) {
      const name = cell.querySelector('.fb-terr-cell-name')?.textContent ?? ''
      if (name.length === 0) continue
      const line = cell.querySelector<HTMLElement>('.fb-terr-cov')
      if (line === null) {
        out[name] = '(none)'
        continue
      }
      const fill = line.querySelector<HTMLElement>('.fb-terr-cov-fill')
      out[name] =
        getComputedStyle(line).display === 'none'
          ? '(hidden)'
          : `${fill?.style.width ?? '?'} · ${line.getAttribute('title') ?? ''}`
    }
    return out
  })
}

/** Which cells are lit and which are dimmed right now, by name. */
async function decoration(window: Page): Promise<{ lit: string[]; dim: string[] }> {
  return window.evaluate(() => {
    const lit: string[] = []
    const dim: string[] = []
    for (const cell of document.querySelectorAll('.fb-terr-cell')) {
      const name = cell.querySelector('.fb-terr-cell-name')?.textContent ?? ''
      if (name.length === 0) continue
      // The board's ONE lit/dim vocabulary (`LIT_CLASS` / `DIM_CLASS` in
      // brain-query-model.ts) — the lens borrows it rather than inventing a
      // fifth meaning for "dim", so this reads the same classes every other
      // overlay writes.
      if (cell.classList.contains('fb-terr-lit')) lit.push(name)
      if (cell.classList.contains('fb-terr-dim')) dim.push(name)
    }
    return { lit, dim }
  })
}

/** The module paths the panel is currently listing — a learned module's own
 *  row or a not-learned folder's row (`.fb-lp-path` in both), folded groups
 *  opened the way a reader opens them. */
async function moduleRows(window: Page): Promise<string[]> {
  for (let i = 0; i < 5; i += 1) {
    const folded = window.locator('.fb-learn-rows .fb-lp-ghead[aria-expanded="false"]')
    if ((await folded.count()) === 0) break
    await folded.first().click()
    await window.waitForTimeout(150)
  }
  return window.evaluate(() =>
    [...document.querySelectorAll('.fb-learn-rows .fb-lp-items .fb-lp-path')].map(
      (el) => el.textContent ?? '',
    ),
  )
}

/** What one cell's progress mark says: its state, its figure, its filled ticks. */
async function progressMark(
  window: Page,
  name: string,
): Promise<{ state: string; figure: string; filled: number; hint: string | null } | null> {
  return window.evaluate((wanted: string) => {
    const cell = [...document.querySelectorAll('.fb-terr-cell')].find(
      (el) => el.querySelector('.fb-terr-cell-name')?.textContent === wanted,
    )
    const mark = cell?.querySelector<HTMLElement>('.fb-terr-progress')
    if (mark === undefined || mark === null) return null
    const figure = mark.querySelector<HTMLElement>('.fb-terr-progress-figure')
    return {
      state: mark.classList.contains('is-indeterminate')
        ? 'marching'
        : mark.classList.contains('has-fraction')
          ? 'fraction'
          : 'neither',
      figure: figure?.textContent ?? '',
      filled: mark.querySelectorAll('.fb-terr-progress-seg.is-filled').length,
      hint: figure?.getAttribute('title') ?? null,
    }
  }, name)
}

/** Inject a pass's own progress on the SAME channel main raises it on. */
async function reportParts(
  app: import('@playwright/test').ElectronApplication,
  root: string,
  featureRef: string,
  parts: number,
  learned: number,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send('learn:featureParts', {
      rootId: payload.root,
      featureRef: payload.featureRef,
      parts: payload.parts,
      learned: payload.learned,
    })
  }, { root, featureRef, parts, learned })
  await new Promise((resolve) => setTimeout(resolve, 600))
}

test.describe('blueprint learning lens (Phase 8)', () => {
  test.afterAll(() => cleanupSeeds())

  test('the panel puts the map in the lens: lines at the foot, a two-way hover, a clearable filter', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (event) => errors.push(`pageerror: ${event.message}`))

    const root = await seedProject(window, 'flow-ux-lens-', prepareRepo)
    await activateProject(window, root)
    await seedLearned(window, root)
    await openBoard(window)

    // AT REST, ONLY THE DOT. The line is not merely invisible — a sheet that
    // drew it and hid it would still be paying for it on every render.
    const closed = await coverageLines(window)
    for (const [name, state] of Object.entries(closed)) {
      expect(state, `${name} drew a coverage line with the panel closed`).toBe('(none)')
    }

    await toggleLearnPanel(window)
    await expect(window.locator('.fb-learn-panel')).toBeVisible({ timeout: 30_000 })

    // …AND WITH THE PANEL OPEN, ONE LINE PER CELL THAT STANDS ON GROUND. The
    // ground comes from a live `blueprint:featureMap` spawn, so this also
    // proves the fetch is wired rather than the class.
    await expect
      .poll(async () => (await coverageLines(window))['Billing'], { timeout: 60_000 })
      .toContain('%')
    const open = await coverageLines(window)
    // ONE learned module of one: Billing's ground is fully read and Shipping's
    // is not. A lens stuck on either answer fails one of these two.
    expect(open['Billing'], `Billing line: ${open['Billing']}`).toMatch(/^100(\.0)?% · 1 of 1/)
    expect(open['Shipping'], `Shipping line: ${open['Shipping']}`).toMatch(/^0(\.0)?% · 0 of 1/)

    // The strip says what the line MEANS. A mark nobody can name is decoration.
    await expect(window.locator('.fb-terr-title-kicker')).toContainText('learning lens')

    // THE LEVEL'S OWN FIGURE — the ring centre's number, counting what the
    // sheet holds (features), not what the panel counts (modules).
    const understood = window.locator('.fb-terr-title-understood')
    await expect(understood).toHaveText(/^1 of 2 features · /)
    await expect(understood).toHaveAttribute('title', /stale not counted/)

    // THE FEATURES COUNT — the second population, named, so it cannot be read
    // as the modules count disagreeing with itself. (A bar of its own until
    // the panel's redesign, 82538cd9; now the project row says both.)
    await expect(window.locator('.fb-learn-panel .fb-lp-counts').first()).toContainText(
      '1 of 2 features',
    )

    // HOVER A MODULE ROW → the provinces standing on it light, the rest recede.
    await moduleRows(window) // a learned module's row sits in the folded Learned group
    await window.locator('.fb-learn-row', { hasText: 'src/billing' }).first().hover()
    await expect
      .poll(async () => (await decoration(window)).lit, { timeout: 15_000 })
      .toEqual(['Billing'])
    expect((await decoration(window)).dim).toContain('Shipping')

    // LEAVING RESTORES THE SHEET — a hover must never be what erases the map.
    await window.locator('.fb-learn-panel-title').first().hover()
    await expect.poll(async () => (await decoration(window)).dim, { timeout: 15_000 }).toEqual([])

    // PRESS A PROVINCE → the rows narrow to that feature's ground, and a chip
    // says so. A pre-filtered list that does not say so reads as the whole
    // story.
    const before = await moduleRows(window)
    expect(before).toEqual(expect.arrayContaining(['src/billing', 'src/shipping']))
    await window.locator('.fb-terr-cell', { hasText: 'Billing' }).first().click()
    await expect(window.locator('.fb-lens-chip')).toContainText('Billing')
    await expect.poll(() => moduleRows(window), { timeout: 15_000 }).toEqual(['src/billing'])

    // ✕ CLEARS IT, and the whole list comes back.
    await window.locator('.fb-lens-chip .fb-corpus-chip-clear').click()
    await expect(window.locator('.fb-lens-chip')).toHaveCount(0)
    await expect
      .poll(() => moduleRows(window), { timeout: 15_000 })
      .toEqual(expect.arrayContaining(['src/billing', 'src/shipping']))

    // CLOSING TAKES THE LENS WITH IT.
    await toggleLearnPanel(window)
    await expect(window.locator('.fb-learn-panel')).toHaveCount(0)
    await expect
      .poll(async () => (await coverageLines(window))['Billing'], { timeout: 15_000 })
      // Back to the AT-REST answer above: no line element at all (it used to
      // stay in the markup, hidden — now the sheet stops drawing it).
      .toBe('(none)')
    await expect(window.locator('.fb-terr-title-kicker')).not.toContainText('learning lens')

    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
  })

  test('a running pass wears its percentage: marching with no fraction, sixty ticks with one', async ({
    app,
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (event) => errors.push(`pageerror: ${event.message}`))

    const root = await seedProject(window, 'flow-ux-lens-dial-', prepareRepo)
    await activateProject(window, root)
    await openBoard(window)

    // NOTHING IN FLIGHT, NO MARK. A dial left over from a finished pass would
    // keep claiming a state the node is no longer in, so its absence is the
    // baseline every assertion below is measured against.
    expect(await progressMark(window, 'Billing')).toBeNull()

    // Start a real pass through the board's own code path. A feature with no
    // parts has no level any more (its door reads it as a code story), so the
    // offer is in the CELL: a press opens it in place, and a cell nothing has
    // learned yet offers "Learn this feature" there.
    const cell = window.locator('.fb-terr-cell', { hasText: 'Billing' }).first()
    await cell.click()
    await cell.getByRole('button', { name: 'Learn this feature', exact: true }).click()
    await window.waitForTimeout(400)
    // Back to the map at rest, which is where the reader watches it from.
    await window.evaluate(() => {
      ;(document.querySelector('.flow-board-root') as HTMLElement | null)?.focus()
    })
    await window.keyboard.press('Escape')
    await window.mouse.move(0, 0)
    await window.locator('.fb-terr-cell').first().waitFor({ state: 'visible', timeout: 30_000 })

    // NO FRACTION YET → THE DIAL MARCHES AND THE FIGURE IS EMPTY. Inventing a
    // percentage here is the one number a reader would act on.
    await expect
      .poll(async () => (await progressMark(window, 'Billing'))?.state, { timeout: 30_000 })
      .toBe('marching')
    expect((await progressMark(window, 'Billing'))?.figure).toBe('')

    // THE PASS NAMES ITS PARTS → the dial stands still at that count.
    await reportParts(app, root, 'feat_billing', 8, 3)
    await expect
      .poll(async () => (await progressMark(window, 'Billing'))?.state, { timeout: 30_000 })
      .toBe('fraction')
    const mark = await progressMark(window, 'Billing')
    // THE FIGURE IS THE TRUE RATIO, NOT THE TICK COUNT: 3 of 8 is 38%, where
    // the 22 filled ticks of sixty would round to 37%. Reporting the drawing
    // instead of the work is precisely what this figure must not do.
    expect(mark?.figure).toBe('38%')
    expect(mark?.filled).toBe(Math.floor((3 / 8) * 60))
    // AND THE SENTENCE SAYS WHICH POPULATION, on the element a cursor can
    // reach — 3 of 8 parts is not 3 of 8 files and not 3 of 8 modules.
    expect(mark?.hint).toBe('3 of 8 parts learned')

    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
  })
})
