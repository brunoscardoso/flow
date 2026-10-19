/**
 * THE CODE STORYLINE (code-storyline) — a file read as a story on the
 * Blueprint board.
 *
 * Real everywhere it can be: a seeded git repo holding a copy of this app's
 * own `learn-orchestrator.ts` and `learn-log.ts` (the file the approved mockup
 * was drawn from), the board asking the bundled CLI through main, and every
 * claim made about rendered boxes and measured wires. Screens of both themes
 * land in FLOW_E2E_SCREENS (or `__screens`) for a person to look at.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'
import { callBoard } from '../board-hook'

const SCREENS = process.env['FLOW_E2E_SCREENS'] ?? resolve(__dirname, '__screens')
const SOURCE = resolve(__dirname, '../../src/main/project')
const FILE = 'src/project/learn-orchestrator.ts'
const LOG = 'src/project/learn-log.ts'
const PART = 'Learn queue'
/** A TypeScript file that does not parse — its own part, so its press is the refusal's door. */
const DRAFT = 'src/project/draft.ts'
const DRAFT_PART = 'Drafts'

test.afterAll(() => cleanupSeeds())

/**
 * A feature with three parts. The first names ONLY the story's file, so
 * pressing it reads that file — and its import of the log, which the part does
 * not name, is the chip into the sibling's own story.
 */
function seed(dir: string): void {
  mkdirSync(join(dir, 'src', 'project'), { recursive: true })
  copyFileSync(join(SOURCE, 'learn-orchestrator.ts'), join(dir, FILE))
  copyFileSync(join(SOURCE, 'learn-log.ts'), join(dir, LOG))
  writeFileSync(join(dir, DRAFT), 'export function draft( {\n  return 1\n')
  const features = join(dir, 'flow', 'brain', 'features')
  mkdirSync(features, { recursive: true })
  for (const [slug, name] of [['agents', 'Agents'], ['connectors', 'Connectors']]) {
    mkdirSync(join(dir, 'src', slug), { recursive: true })
    writeFileSync(join(dir, 'src', slug, 'index.ts'), `export const ${slug} = 1\n`)
    writeFileSync(
      join(features, `${slug}.md`),
      ['---', `id: feature:${slug}`, `name: ${name}`, 'kind: core', `anchors: [module:src/${slug}]`, 'relates: []', 'lastFullRead: null', 'patchCount: 0', '---', '', `# ${name}`, '', 'A sibling.', ''].join('\n'),
    )
  }
  writeFileSync(
    join(features, 'learning.md'),
    [
      '---',
      'id: feature:learning',
      'name: Learning',
      'kind: core',
      'anchors: [module:src/project]',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      '# Learning',
      '',
      'Reads modules and records what they do.',
      '',
      '## Parts',
      '',
      `### ${PART}`,
      'The serial queue that runs learn passes.',
      `anchors: ${FILE}`,
      '',
      '### Activity log',
      'What the queue did, newest first.',
      `anchors: ${LOG}`,
      '',
      `### ${DRAFT_PART}`,
      'A half-written pass.',
      `anchors: ${DRAFT}`,
      '',
    ].join('\n'),
  )
  const structure = join(dir, 'flow', 'brain', '.structure')
  mkdirSync(structure, { recursive: true })
  writeFileSync(
    join(structure, 'graph.json'),
    JSON.stringify({
      version: 1,
      derivedAt: '2026-10-06T00:00:00.000Z',
      coverage: { filesScanned: 4, filesTotal: 4, extractorsRun: ['modules'], graphifyEnriched: false },
      nodes: [
        { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
        { id: 'module:src/project', kind: 'module', label: 'project', sourceFile: 'src/project', meta: { depth: 2, fileCount: 2 } },
      ],
      edges: [{ source: 'module:src', target: 'module:src/project', relation: 'contains' }],
      mustReview: [],
    }),
  )
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true })
  await page.screenshot({ path: join(SCREENS, `storyline-${name}.png`) })
}

/**
 * Wait until the seeded project's own feature board is drawn — the 'Learning'
 * cell on the sheet. Two things can stand in its way, and both were seen
 * live (~1 run in 7): the Workspace map (a country per project) when the board
 * opens a level up, and the board's first paint landing before the project's
 * knowledge was linked in — the sheet then shows the code folders ('Project',
 * 'Agents', …) and nothing tells it to look again. The first is pressed into,
 * the way a person would; the second is re-read through the board's E2E hook.
 */
async function openProjectBoard(page: Page, root: string): Promise<void> {
  const learning = page.locator('.fb-terr-cell', { hasText: 'Learning' }).first()
  const folder = basename(root)
  await expect(async () => {
    if (await learning.isVisible().catch(() => false)) return
    const countries = page.locator('.fb-ws-country')
    if ((await countries.count()) > 0) {
      const ours = countries.filter({ hasText: folder })
      const country = (await ours.count()) > 0 ? ours.first() : countries.first()
      await country.locator('.fb-ws-name').click({ timeout: 2_000 })
    } else {
      await callBoard(page, 'refresh', [], { wait: false })
    }
    await expect(learning).toBeVisible({ timeout: 10_000 })
  }).toPass({ timeout: 150_000, intervals: [1_000, 2_000, 5_000] })
}

/**
 * Every call wire of an unfolded box starts on its box's right edge, at the
 * height of one of the box's call lines. `only` narrows the check to one piece.
 */
async function wireLanding(page: Page, only: string | null = null): Promise<{ checked: number; misses: string[] }> {
  return page.evaluate((onlyPiece) => {
    const stage = document.querySelector('.fb-story-stage') as HTMLElement
    const k = Number(/scale\(([\d.]+)\)/.exec(stage.style.transform)?.[1] ?? '1')
    const base = stage.getBoundingClientRect()
    const misses: string[] = []
    let checked = 0
    for (const wire of stage.querySelectorAll<SVGPathElement>('.fb-story-wire:not(.fb-story-wire-type)')) {
      const from = wire.dataset['from'] ?? ''
      if (onlyPiece !== null && from !== onlyPiece) continue
      const box = [...stage.querySelectorAll<HTMLElement>('.fb-story-box')].find((el) => el.dataset['piece'] === from)
      // A folded long piece does not print every call line; its wires leave its header.
      if (box === undefined || box.querySelector('.fb-story-bfoot') !== null) continue
      const [x, y] = (wire.getAttribute('d') ?? '').slice(1).split(' ').map(Number)
      const right = (box.getBoundingClientRect().right - base.left) / k
      const onLine = [...box.querySelectorAll<HTMLElement>('.fb-story-callsite')].some((line) => {
        const rect = line.getBoundingClientRect()
        if (rect.height === 0) return false
        const top = (rect.top - base.top) / k
        return Math.abs(top + rect.height / k / 2 - (y ?? 0)) < 2
      })
      checked += 1
      if (Math.abs(right - (x ?? 0)) > 2 || !onLine) misses.push(from)
    }
    return { checked, misses }
  }, only)
}

async function theme(page: Page, value: 'light' | 'dark'): Promise<void> {
  await page.evaluate((next) => document.documentElement.setAttribute('data-theme', next), value)
  await page.waitForTimeout(200)
}

test('a file reads as a story: entry at the left, real code in every box, wires on call lines, Back returns', async ({ window: page }) => {
  test.setTimeout(240_000)
  const root = await seedProject(page, 'flow-ux-story-', seed)
  await activateProject(page, root)
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  for (let i = 0; i < 4; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click()
  }
  // More of the window for the sheet, as a person reading code would give it.
  const sidebar = page.locator('button[title^="Toggle sidebar"]').first()
  if (await sidebar.isVisible().catch(() => false)) await sidebar.click()
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()

  // THE DOOR A PERSON USES (plan cell-hover-diagram, FR-6): the feature, then
  // its part — double-clicking the part opens the part's story; there is no part page
  // of file boxes in between any more. The sheet re-packs as the feature graph
  // lands, so each double-click is retried until what it opens is on screen.
  await openProjectBoard(page, root)
  await expect(async () => {
    await page.locator('.fb-terr-cell', { hasText: 'Learning' }).first().dblclick({ timeout: 2_000 })
    await expect(page.locator('.fb-terr-cell', { hasText: PART }).first()).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 90_000 })
  await expect(async () => {
    await page.locator('.fb-terr-cell', { hasText: PART }).first().dblclick({ timeout: 2_000 })
    await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 3_000 })
  }).toPass({ timeout: 60_000 })

  // ── THE STORY: the entry box, real code, the class frame, the rail. ──
  const entry = page.locator('.fb-story-box.fb-story-entry')
  await expect(entry).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator('.fb-story-refusal')).toHaveCount(0)
  await expect(page.locator('.fb-story-frame-name').first()).toHaveText('class LearnOrchestrator')

  // ── ONLY THE CODE SELECTS (user, 2026-10-07). (1) A drag on a box's header
  // pans the sheet and selects nothing — positive first: the transform moved.
  // (2) A drag inside a box's code lines does NOT pan, and selects only that
  // box's code. (3) Copying it gives code, no chip or button labels.
  {
    const stage = page.locator('.fb-story-stage')
    const transform = (): Promise<string> => stage.evaluate((el) => (el as HTMLElement).style.transform)
    const head = await entry.locator('.fb-story-bhead').boundingBox()
    if (head === null) throw new Error('no box header to drag')
    const panBefore = await transform()
    await page.mouse.move(head.x + 30, head.y + head.height / 2)
    await page.mouse.down()
    await page.mouse.move(head.x + 170, head.y + head.height / 2 + 90, { steps: 8 })
    await page.mouse.up()
    expect(await transform()).not.toBe(panBefore)
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')

    const lines = entry.locator('.fb-story-ln')
    const first = await lines.nth(1).boundingBox()
    const last = await lines.nth(3).boundingBox()
    if (first === null || last === null) throw new Error('no code lines to select')
    const selectBefore = await transform()
    await page.mouse.move(first.x + 14, first.y + first.height / 2)
    await page.mouse.down()
    // Past the box's own edge and well beyond: the selection must not spill.
    await page.mouse.move(last.x + last.width + 400, last.y + last.height / 2 + 260, { steps: 10 })
    await page.mouse.up()
    expect(await transform()).toBe(selectBefore)
    const picked = await page.evaluate(() => {
      const selection = window.getSelection()
      const text = selection?.toString() ?? ''
      const entryBox = document.querySelector('.fb-story-box.fb-story-entry')
      const code = entryBox?.querySelector('pre.fb-story-code')?.textContent ?? ''
      const headers = [...document.querySelectorAll('.fb-story-bhead, .fb-story-frame-label, .fb-story-band')].map((el) => el.textContent ?? '')
      const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
      const inside = range === null ? false : entryBox?.querySelector('pre.fb-story-code')?.contains(range.commonAncestorContainer) ?? false
      return { text, code, headers, inside }
    })
    expect(picked.text.trim().length).toBeGreaterThan(0)
    expect(picked.inside).toBe(true)
    const flat = (value: string): string => value.replace(/\s+/g, '')
    expect(flat(picked.code)).toContain(flat(picked.text))
    for (const header of picked.headers) if (header.trim().length > 12) expect(picked.text).not.toContain(header.trim())

    // Copy: the handler's text is code only — no chip (↗ file) or fold label.
    const copied = await page.evaluate(() => {
      const data = new DataTransfer()
      const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })
      document.querySelector('.fb-story-box.fb-story-entry pre.fb-story-code')?.dispatchEvent(event)
      return data.getData('text/plain')
    })
    expect(copied.trim().length).toBeGreaterThan(0)
    expect(copied).not.toContain('↗')
    expect(copied).not.toMatch(/comment lines|not on this path|Open in the editor/)
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
  }
  await expect(page.locator('.fb-story-entry-tag')).toHaveText('Entry point')
  const boxes = await page.locator('.fb-story-box').count()
  expect(boxes).toBeGreaterThan(3)
  await expect(page.locator('.fb-story-step').first()).toHaveClass(/fb-story-step-entry/)
  await expect(page.locator('.fb-story-head .fb-story-crumb.on')).toHaveText(PART)
  await expect(page.locator('.fb-story-select')).toBeVisible()

  // THE STORY REPLACED THE CODE MAP. The board's header IS up with its own
  // controls (Back, the story's strip) — and among them there is no Code map
  // entry any more. Positive first, so the absence below is evidence.
  const header = page.locator('.flow-board-root .fb-header')
  await expect(header).toBeVisible()
  await expect(header.locator('.fb-nav-btn').first()).toBeVisible()
  await expect(header.locator('.fb-story-head')).toBeVisible()
  await expect(page.getByRole('button', { name: /code map/i })).toHaveCount(0)
  await expect(page.locator('.flow-board-root fl-button, .flow-board-root button', { hasText: /code map/i })).toHaveCount(0)

  // Wires are drawn from measured boxes: every call wire of an unfolded box starts on a call line.
  await page.waitForTimeout(800) // Monaco's colours land late and re-measure
  const wiresLand = await wireLanding(page)
  expect(wiresLand.checked).toBeGreaterThan(0)
  expect(wiresLand.misses).toEqual([])

  // Boxes never overlap one another.
  const overlaps = await page.evaluate(() => {
    const rects = [...document.querySelectorAll('.fb-story-box')].map((el) => el.getBoundingClientRect())
    let count = 0
    rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => {
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) count += 1
    }))
    return count
  })
  expect(overlaps).toBe(0)

  // The first-run offer to read the project is not this spec's subject.
  const notNow = page.getByRole('button', { name: 'Not now' }).first()
  if (await notNow.isVisible().catch(() => false)) await notNow.click()
  await page.mouse.move(2, 400)
  await page.waitForTimeout(200)
  await theme(page, 'dark')
  await screenshot(page, 'dark')
  await theme(page, 'light')
  await screenshot(page, 'light')

  // Hover focus: the box lights, the rest dims.
  await page.locator('.fb-story-step').nth(1).hover()
  await expect(page.locator('.fb-story-stage.fb-story-focus')).toHaveCount(1)
  await screenshot(page, 'hover-light')
  await page.mouse.move(5, 5)

  // Follow a call: the camera moves to the callee and flashes it.
  const call = page.locator('.fb-story-entry .fb-story-call').first()
  const target = await call.getAttribute('data-to')
  await call.click()
  await expect(page.locator(`.fb-story-box[data-piece="${target ?? ''}"]`)).toHaveClass(/fb-story-flash/)
  await page.waitForTimeout(500)
  await theme(page, 'dark')
  await screenshot(page, 'follow-dark')

  // ── TYPES: the dashed "uses type" wires are drawn, and hidden until asked. ──
  await page.mouse.move(5, 5)
  await expect(page.locator('.fb-story-stage.fb-story-focus')).toHaveCount(0)
  const typeOpacities = (): Promise<number[]> =>
    page.evaluate(() =>
      [...document.querySelectorAll('.fb-story-wire.fb-story-wire-type')].map((el) => Number(getComputedStyle(el).opacity)),
    )
  const typesButton = page.locator('.fb-story-head fl-button[aria-label="Types"]')
  await expect(typesButton).toHaveAttribute('aria-pressed', 'false')
  // Polled: wires fade (a short opacity transition) as hover focus leaves.
  await expect.poll(async () => (await typeOpacities()).filter((value) => value > 0)).toEqual([])
  const typesOff = await typeOpacities()
  expect(typesOff.length).toBeGreaterThan(0)
  await typesButton.click()
  await expect(page.locator('.fb-story-head fl-button[aria-label="Types"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.fb-story-stage.fb-story-types')).toHaveCount(1)
  await expect.poll(async () => (await typeOpacities()).filter((value) => value > 0).length).toBeGreaterThan(0)
  const dashed = await page.evaluate(() => getComputedStyle(document.querySelector('.fb-story-wire.fb-story-wire-type') as Element).strokeDasharray)
  expect(dashed).not.toBe('none')
  await screenshot(page, 'types-dark')
  // …and off again: the same wires, all hidden (they were visible a moment ago).
  await page.locator('.fb-story-head fl-button[aria-label="Types"]').click()
  await expect(page.locator('.fb-story-head fl-button[aria-label="Types"]')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.fb-story-stage.fb-story-types')).toHaveCount(0)
  await expect.poll(async () => (await typeOpacities()).filter((value) => value > 0).length).toBe(0)
  expect((await typeOpacities()).length).toBe(typesOff.length)

  // ── A COMMENT FOLD opens, and the wires below it move with the code. ──
  // The fold chosen sits in an unfolded box ABOVE one of that box's wired call
  // lines, so opening it must push that line (and its wire) down.
  const chosen = await page.evaluate(() => {
    const stage = document.querySelector('.fb-story-stage') as HTMLElement
    const wired = new Set([...stage.querySelectorAll<SVGPathElement>('.fb-story-wire:not(.fb-story-wire-type)')].map((wire) => wire.dataset['from'] ?? ''))
    for (const box of stage.querySelectorAll<HTMLElement>('.fb-story-box')) {
      const piece = box.dataset['piece'] ?? ''
      if (!wired.has(piece) || box.querySelector('.fb-story-bfoot') !== null) continue
      const calls = [...box.querySelectorAll<HTMLElement>('.fb-story-callsite')]
      for (const fold of box.querySelectorAll<HTMLElement>('.fb-story-fold')) {
        if (!calls.some((line) => (fold.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)) continue
        fold.setAttribute('data-e2e-fold', '1')
        const wire = [...stage.querySelectorAll<SVGPathElement>('.fb-story-wire:not(.fb-story-wire-type)')].find((el) => el.dataset['from'] === piece)
        return { piece, hidden: fold.nextElementSibling?.querySelectorAll('.fb-story-ln').length ?? 0, d: wire?.getAttribute('d') ?? '' }
      }
    }
    return null
  })
  expect(chosen, 'no comment fold sits above a wired call line in this story').not.toBeNull()
  const fold = page.locator('.fb-story-fold[data-e2e-fold="1"]')
  await expect(fold).toHaveText(/^\s*\/\/ \d+ comment lines$/)
  await expect(fold).not.toHaveClass(/\bopen\b/)
  await page.locator(`.fb-story-step[data-piece="${chosen?.piece ?? ''}"]`).click().catch(() => undefined)
  await page.waitForTimeout(400)
  await fold.click()
  await expect(fold).toHaveClass(/\bopen\b/)
  const shown = await fold.evaluate((el) => {
    const group = el.nextElementSibling as HTMLElement | null
    return { hidden: group?.hidden ?? true, lines: group?.querySelectorAll('.fb-story-ln').length ?? 0 }
  })
  expect(shown.hidden).toBe(false)
  expect(shown.lines).toBe(chosen?.hidden)
  expect(shown.lines).toBeGreaterThanOrEqual(3)
  // The wires re-measured: the box's wire moved, and it still starts on a call line.
  await expect
    .poll(() => page.evaluate((piece) => [...document.querySelectorAll<SVGPathElement>('.fb-story-wire:not(.fb-story-wire-type)')].find((el) => el.dataset['from'] === piece)?.getAttribute('d') ?? '', chosen?.piece ?? ''))
    .not.toBe(chosen?.d)
  const afterFold = await wireLanding(page, chosen?.piece ?? '')
  expect(afterFold.checked).toBeGreaterThan(0)
  expect(afterFold.misses).toEqual([])
  expect((await wireLanding(page)).misses).toEqual([])
  await screenshot(page, 'fold-open-dark')

  // ── STARTS AT: another way in redraws the story from there. ──
  const select = page.locator('.fb-story-select')
  const before = await select.inputValue()
  const options = await select.locator('option').evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value))
  const other = options.find((value) => value !== before)
  expect(other, 'the story offers only one way in').toBeDefined()
  await expect(page.locator('.fb-story-box.fb-story-entry')).toHaveAttribute('data-piece', before)
  await select.selectOption(other ?? '')
  await expect(page.locator('.fb-story-box.fb-story-entry')).toHaveAttribute('data-piece', other ?? '')
  await expect(page.locator('.fb-story-box.fb-story-entry')).toHaveCount(1)
  await expect(page.locator('.fb-story-step').first()).toHaveAttribute('data-piece', other ?? '')
  await expect(page.locator('.fb-story-step').first()).toHaveClass(/fb-story-step-entry/)
  await expect(page.locator('.fb-story-select')).toHaveValue(other ?? '')
  // ONE rail and one foot — a re-entry once appended a second set behind the first.
  await expect(page.locator('.fb-story-rail-label')).toHaveCount(1)
  await expect(page.locator('.fb-story-summary')).toHaveCount(1)
  await screenshot(page, 'starts-at-dark')

  // ── A CHIP into the sibling file opens ITS story; Back comes home. ──
  const chip = page.locator('.fb-story-chip:not(.fb-story-chip-dim)', { hasText: '↗ learn-log.ts' }).first()
  await expect(chip).toHaveCount(1)
  await chip.click()
  await expect(page.locator('.fb-story-head .fb-story-crumb.on')).toHaveText('learn-log.ts', { timeout: 60_000 })
  await expect(page.locator('.fb-story-head button.fb-story-crumb', { hasText: PART })).toHaveCount(1)
  await expect(page.locator('.fb-story-box').first()).toBeVisible()
  await expect(page.locator('.fb-story-box[data-piece^="src/project/learn-log.ts#"]').first()).toBeVisible()
  await screenshot(page, 'chip-dark')
  await page.locator('.fb-nav-btn[aria-label^="Back"]').click()
  await expect(page.locator('.fb-story-head .fb-story-crumb.on')).toHaveText(PART)
  await expect(page.locator('.fb-story')).toHaveCount(1)
  await expect(page.locator('.fb-story-frame-name').first()).toHaveText('class LearnOrchestrator')

  // Fit, then Back leaves for the board it was opened from.
  await page.locator('.fb-story-head fl-button', { hasText: 'Fit' }).click()
  await page.waitForTimeout(200)
  await screenshot(page, 'fit-dark')
  await page.locator('.fb-nav-btn[aria-label^="Back"]').click()
  await expect(page.locator('.fb-story')).toHaveCount(0)
  // …to the feature's level it was opened from: its parts, and no part page.
  await expect(page.locator('.fb-terr-cell', { hasText: PART }).first()).toBeVisible()
  await expect(page.locator('.fb-terr-cell', { hasText: DRAFT_PART }).first()).toBeVisible()

  // ── A PART WHOSE FILE DOES NOT PARSE: a sentence naming the file and why. ──
  await expect(async () => {
    await page.locator('.fb-terr-cell', { hasText: DRAFT_PART }).first().dblclick({ timeout: 2_000 })
    await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  const refusal = page.locator('.fb-story-refusal')
  await expect(refusal).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.fb-story-refusal-sentence')).toContainText("draft.ts can't be read as a story yet: line")
  await expect(page.locator('.fb-story-refusal-sentence')).toContainText("doesn't parse")
  await expect(page.locator('.fb-story-head .fb-story-crumb.on')).toHaveText(DRAFT_PART)
  // Positive first: the refusal IS on screen, so no boxes is evidence.
  await expect(page.locator('.fb-story-box')).toHaveCount(0)
  await screenshot(page, 'refusal-dark')
  // A part's refusal has no text of its own, so it opens the file in the peek.
  const peek = page.locator('.fb-peek-drawer')
  await expect(peek).toBeVisible({ timeout: 10_000 })
  await expect(peek.locator('.fb-peek-title')).toHaveText(DRAFT)
  // ESCAPE TAKES THE PEEK FIRST — the thing on top — and leaves the story…
  await page.keyboard.press('Escape')
  await expect(peek).toHaveCount(0)
  await expect(page.locator('.fb-story')).toHaveCount(1)
  await expect(refusal).toBeVisible()
  // …and the next Escape closes the story, with no drawer left behind.
  await page.keyboard.press('Escape')
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await expect(peek).toHaveCount(0)
})

const HIGHLIGHT_SCREENS =
  process.env['FLOW_E2E_HIGHLIGHT_SCREENS'] ?? join(SCREENS, 'highlight')
/** Mirrors RANGE_HIGHLIGHT_HOLD_MS + RANGE_HIGHLIGHT_FADE_MS (range-highlight.ts), with slack. */
const HIGHLIGHT_LIFETIME_MS = 4_400
const HIGHLIGHT_CLEAR_TIMEOUT_MS = HIGHLIGHT_LIFETIME_MS + 3_000

/** The board, the feature, its part — the story of FILE on screen. */
async function openPartStory(page: Page, root: string): Promise<void> {
  await activateProject(page, root)
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  for (let i = 0; i < 4; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click()
  }
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()
  await openProjectBoard(page, root)
  await expect(async () => {
    await page.locator('.fb-terr-cell', { hasText: 'Learning' }).first().dblclick({ timeout: 2_000 })
    await expect(page.locator('.fb-terr-cell', { hasText: PART }).first()).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 90_000 })
  await expect(async () => {
    await page.locator('.fb-terr-cell', { hasText: PART }).first().dblclick({ timeout: 2_000 })
    await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
  await expect(page.locator('.fb-story-box.fb-story-entry')).toHaveCount(1, { timeout: 60_000 })
}

/** What the editor shows of the highlight: the mirrored range, and the decorated
 *  line + gutter elements with whether each sits inside the editor's viewport. */
async function highlightState(page: Page): Promise<{ attr: string | null; lines: number; gutters: number; outside: number }> {
  return page.evaluate(() => {
    const editor = [...document.querySelectorAll<HTMLElement>('.monaco-editor')].find(
      (el) => el.getAttribute('data-flow-range-highlight') !== null,
    ) ?? null
    if (editor === null) return { attr: null, lines: 0, gutters: 0, outside: 0 }
    const view = (editor.querySelector('.overflow-guard') ?? editor).getBoundingClientRect()
    const lines = [...editor.querySelectorAll<HTMLElement>('.view-overlays .fl-range-highlight-line')]
    const gutters = [...editor.querySelectorAll<HTMLElement>('.margin-view-overlays .fl-range-highlight-gutter')]
    const outside = [...lines, ...gutters].filter((el) => {
      const rect = el.parentElement?.getBoundingClientRect() ?? el.getBoundingClientRect()
      return rect.height === 0 || rect.top < view.top - 1 || rect.bottom > view.bottom + 1
    }).length
    return { attr: editor.getAttribute('data-flow-range-highlight'), lines: lines.length, gutters: gutters.length, outside }
  })
}

test("a box's ↗ opens the file with exactly that piece's lines revealed and highlighted, and the mark clears calmly", async ({ window: page }) => {
  test.setTimeout(240_000)
  const root = await seedProject(page, 'flow-ux-story-hl-', seed)
  await openPartStory(page, root)

  // A box whose piece fits on one editor screen, away from the top of the file
  // (so "revealed" is a scroll, not a coincidence). Its range is read off its
  // own header: `L<start> · <n> lines`.
  const chosen = await page.evaluate(() => {
    for (const box of document.querySelectorAll<HTMLElement>('.fb-story-box')) {
      const match = /^L(\d+) · (\d+) lines?$/.exec(box.querySelector('.fb-story-bwhere')?.textContent?.trim() ?? '')
      if (match === null) continue
      const start = Number(match[1])
      const count = Number(match[2])
      if (start > 60 && count >= 3 && count <= 20) {
        box.setAttribute('data-e2e-open', '1')
        return { start, end: start + count - 1, count, piece: box.dataset['piece'] ?? '' }
      }
    }
    return null
  })
  expect(chosen, 'no box of 3–20 lines below line 60 in this story').not.toBeNull()
  const { start, end, count } = chosen ?? { start: 0, end: 0, count: 0 }

  const box = page.locator('.fb-story-box[data-e2e-open="1"]')
  await box.hover()
  await box.locator('.fb-story-open').click()

  // The editor tab for that file is the active one…
  const active = page.locator('.fl-editor-tabs .tab.active')
  await expect(active).toContainText('learn-orchestrator.ts', { timeout: 15_000 })
  // …the range is mirrored, decorated line for line, and on screen.
  await expect.poll(() => highlightState(page), { timeout: 10_000 }).toEqual({
    attr: `${String(start)}-${String(end)}`,
    lines: count,
    gutters: count,
    outside: 0,
  })
  await page.waitForTimeout(150)
  mkdirSync(HIGHLIGHT_SCREENS, { recursive: true })
  await theme(page, 'dark')
  await page.screenshot({ path: join(HIGHLIGHT_SCREENS, 'highlight-dark.png') })
  await theme(page, 'light')
  await page.screenshot({ path: join(HIGHLIGHT_SCREENS, 'highlight-light.png') })

  // CLEARS WHEN THE CURSOR LEAVES THE RANGE. Positive first (above), then the
  // move: Cmd/Ctrl+Home goes to line 1, which is outside (start > 60).
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home')
  await expect.poll(() => highlightState(page), { timeout: 5_000 }).toEqual({ attr: null, lines: 0, gutters: 0, outside: 0 })

  // …AND ON ITS OWN: the same file, already open in its tab, is revealed and
  // highlighted again; left alone, the mark fades and goes.
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.fb-story')).toHaveCount(1)
  const again = page.locator(`.fb-story-box[data-piece="${chosen?.piece ?? ''}"]`)
  await again.hover()
  await again.locator('.fb-story-open').click()
  await expect(page.locator('.fl-editor-tabs .tab', { hasText: 'learn-orchestrator.ts' })).toHaveCount(1)
  await expect.poll(() => highlightState(page), { timeout: 10_000 }).toMatchObject({ attr: `${String(start)}-${String(end)}`, lines: count })
  await expect.poll(() => highlightState(page), { timeout: HIGHLIGHT_CLEAR_TIMEOUT_MS }).toEqual({ attr: null, lines: 0, gutters: 0, outside: 0 })
})
