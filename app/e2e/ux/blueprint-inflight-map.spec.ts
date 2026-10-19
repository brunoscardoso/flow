import { test, expect } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FEATURE_VIEW_DONE_TITLE,
  FEATURE_VIEW_FAILED_TITLE,
} from '../../src/shared/feature-view-notice'

/**
 * A RUNNING UNDERSTAND PASS, VISIBLE ON THE MAP.
 *
 * The complaint: press "Understand this feature", go back to do something else,
 * and the fact that a ten-minute pass is running disappears completely. The
 * board already knew (`#featureViewRunning` is what enforces one pass at a
 * time); the dot vocabulary already had an in-progress state. Nothing joined
 * them, so the running state lived only on the button of the level you started
 * from.
 *
 * WHAT IS REAL HERE AND WHAT IS DRIVEN
 * ====================================
 * REAL: the press. `.fb-brief-draw` is clicked exactly as a user clicks it, so
 * the in-flight state is entered through the board's own one-and-only code path
 * (`#understandFeature`) — nothing reaches in and sets a flag.
 *
 * DRIVEN: the pass's ENDING. A real pass lands on its own clock — measured on
 * this machine, an ambient CLI login carried one all the way to a written view
 * in ~35 seconds, and a machine with no login refuses on a different clock
 * again. Neither is a schedule a probe can assert against. So the two terminal
 * signals are injected from MAIN, on the same channels main itself raises them
 * on and with main's own title constants — `learn:featureViewed` for success
 * and a `FEATURE_VIEW_FAILED_TITLE` notification for failure. The renderer
 * cannot tell the difference: it is the same IPC event, byte for byte.
 *
 * THE PRESS DOES DISPATCH REAL WORK. Main starts an actual pass; the injected
 * ending stops the BOARD watching it, some seconds before the real one would
 * have landed. That is deliberate — it is the shortest honest way to observe
 * both exits, and it exercises the same `settle` path either outcome takes.
 */

test.afterAll(() => cleanupSeeds())

const SHOT = '/tmp'

function writeFeature(
  dir: string,
  slug: string,
  name: string,
  kind: 'core' | 'child',
  extra: string[],
): void {
  const featureDir = join(dir, 'flow', 'brain', 'features')
  mkdirSync(featureDir, { recursive: true })
  writeFileSync(
    join(featureDir, `${slug}.md`),
    [
      '---',
      `id: feature:${slug}`,
      `name: ${name}`,
      `kind: ${kind}`,
      ...extra,
      'anchors: [module:src/ingest]',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${name}`,
      '',
      'Seeded by the in-flight probe.',
      // Chats carries PARTS, so it has a level to dive into (a feature with
      // none reads as its code story instead — cell-hover-diagram FR-6).
      ...(slug === 'chats' ? ['', '## Parts', '', '### Composer', 'Where a turn is typed.', '', '### Transcript', 'Where a turn is read.', ''] : []),
    ].join('\n'),
  )
}

/**
 * Two domains, so there is an ancestor to roll up to AND a sibling domain that
 * must stay clean; a part under the running feature, so the deepest level is
 * reachable too.
 */
function seed(dir: string): void {
  mkdirSync(join(dir, 'src', 'ingest'), { recursive: true })
  writeFileSync(join(dir, 'src', 'ingest', 'reader.ts'), 'export const read = (): number => 1\n')

  writeFeature(dir, 'chats', 'Chats', 'core', ['domain: Conversation'])
  writeFeature(dir, 'threads', 'Threads', 'core', ['domain: Conversation'])
  writeFeature(dir, 'board', 'Board', 'core', ['domain: Map'])
  writeFeature(dir, 'chat-engine', 'Chat Engine', 'child', ['parent: feature:chats'])
}

/**
 * The in-flight marks currently on the sheet, by node id. Measured from the
 * CLASS **and** from the computed border, never from a screenshot impression.
 *
 * A country is a `.fb-terr-group` and a province is a `.fb-terr-cell`; both can
 * carry a mark, and on the territory they are often on screen TOGETHER — the
 * root draws domains as ground with their features standing inside — which is
 * exactly the sheet where the two claims must not be confusable.
 *
 * `(HIDDEN)` is appended when the class is on the element but nothing about the
 * element is actually drawn differently: `self` must breathe or ring, `within`
 * must go dashed. A mark that is only a class name is not an indicator.
 */
async function marksOn(
  win: import('@playwright/test').Page,
): Promise<Record<string, string>> {
  return win.evaluate(() => {
    const out: Record<string, string> = {}
    const read = (el: Element): void => {
      const id = (el as HTMLElement).dataset['featureId']
      if (id === undefined || id.length === 0) return
      const self = el.classList.contains('fb-terr-inflight')
      const within = el.classList.contains('fb-terr-inflight-within')
      if (!self && !within) return
      const style = getComputedStyle(el)
      const shown = self
        ? style.animationName !== 'none' || style.boxShadow !== 'none'
        : style.borderTopStyle === 'dashed'
      out[id] = `${self ? 'self' : 'within'}${shown ? '' : ' (HIDDEN)'}`
    }
    for (const el of document.querySelectorAll('.fb-terr-cell')) read(el)
    for (const el of document.querySelectorAll('.fb-terr-group')) read(el)
    return out
  })
}

/** The learn-dot class a cell currently reports, or null. */
async function dotOf(
  win: import('@playwright/test').Page,
  id: string,
): Promise<string | null> {
  return win.evaluate((nodeId: string) => {
    const cell = [...document.querySelectorAll('.fb-terr-cell')].find(
      (el) => (el as HTMLElement).dataset['featureId'] === nodeId,
    )
    const dot = cell?.querySelector('.fb-learn-dot')
    return dot === undefined || dot === null
      ? null
      : ([...dot.classList].find((c) => c.startsWith('fb-learn-') && c !== 'fb-learn-dot') ?? null)
  }, id)
}

/**
 * Escape, with the board actually focused.
 *
 * Pressing the understand button DISABLES it (one pass at a time), and a
 * focused element that becomes disabled drops focus to `<body>` — after which
 * the board's keydown handler ignores everything, because it only fires while
 * the board holds `document.activeElement` (#517). Measured live: without this,
 * Escape after the press does nothing at all.
 */
async function pressEscape(win: import('@playwright/test').Page): Promise<void> {
  await win.evaluate(() => {
    ;(document.querySelector('.flow-board-root') as HTMLElement | null)?.focus()
  })
  await win.keyboard.press('Escape')
}

/** Wait for the board to be showing a drawn territory at the root. */
async function atRoot(win: import('@playwright/test').Page): Promise<void> {
  await expect(win.locator('.fb-terr-cell').first()).toBeVisible({ timeout: 120_000 })
}

/**
 * Click a node's BODY (which dives) by feature id.
 *
 * A province is a `.fb-terr-cell` and its body dives. A COUNTRY takes no clicks
 * at all (`pointer-events: none` — ground must not steal a press aimed between
 * two provinces); its label button is the way in, which is why this looks the
 * id up in both places rather than assuming one.
 */
async function dive(win: import('@playwright/test').Page, id: string): Promise<void> {
  await win.evaluate((nodeId: string) => {
    const cell = [...document.querySelectorAll('.fb-terr-cell')].find(
      (el) => (el as HTMLElement).dataset['featureId'] === nodeId,
    )
    if (cell !== undefined) {
      // A DOUBLE-CLICK goes in; a single press only opens a cell in place
      // (5dd9bf03).
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return
    }
    const group = [...document.querySelectorAll('.fb-terr-group')].find(
      (el) => (el as HTMLElement).dataset['featureId'] === nodeId,
    )
    group?.querySelector('.fb-terr-group-label')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
  }, id)
  await win.waitForTimeout(900) // the zoom is 240ms + a 200ms fade; land it
}

/** Pop one level, the way the reader does — Escape, with the board focused. */
async function popOut(win: import('@playwright/test').Page): Promise<void> {
  // The pointer off the sheet first: a cell under a resting pointer shows its
  // details, and Escape closes the thing on top before it pops a level.
  await win.mouse.move(0, 0)
  await win.waitForTimeout(300)
  await pressEscape(win)
  await win.waitForTimeout(900)
}

/** Inject a terminal signal on the SAME channel main raises it on. */
async function endPass(
  app: import('@playwright/test').ElectronApplication,
  root: string,
  outcome: 'done' | 'failed',
  titles: { done: string; failed: string },
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (payload.outcome === 'done') {
        win.webContents.send('learn:featureViewed', {
          rootId: payload.root,
          featureRef: 'feature:chats',
          components: 4,
        })
        return
      }
      win.webContents.send('flow:notification', {
        kind: 'state-change',
        rootId: payload.root,
        title: payload.failedTitle,
        body: 'Chats: no Claude account is bound to this project.',
        timestamp: new Date().toISOString(),
        level: 'warn',
      })
    },
    { root, outcome, failedTitle: titles.failed, doneTitle: titles.done },
  )
  await new Promise((resolve) => setTimeout(resolve, 600))
}

/**
 * Start a real pass on Chats through the board's own button, then walk away.
 *
 * ON THE TERRITORY THE ROOT ALREADY DRAWS BOTH. A country is GROUND with its
 * provinces standing inside it, so Chats is a cell at the root and Conversation
 * is the rectangle around it — the two claims land on one sheet, which is the
 * hardest place for them to stay distinguishable and therefore the right place
 * to measure them. The rollup is no less necessary: dive one level and the
 * country becomes the title strip, with only its own features on the sheet.
 *
 * Chats has no parts, so it has no level of its own (its door reads it as a
 * code story — cell-hover-diagram FR-6): its offer is in the CELL. A press
 * opens the cell in place, and a cell nothing has learned yet offers "Learn
 * this feature" — the same understand pass the level's control used to start.
 */
async function startPass(win: import('@playwright/test').Page): Promise<void> {
  const cell = win.locator('.fb-terr-cell[data-feature-id="feature:chats"]').first()
  await cell.click({ timeout: 30_000 })
  const learn = cell.getByRole('button', { name: 'Learn this feature', exact: true })
  await expect(learn, 'the understand offer is not where the probe expects it').toBeVisible({
    timeout: 30_000,
  })
  await learn.click()
  await win.waitForTimeout(400)
  // Back to the map — this is the "go back to do another thing while the
  // understanding is running" the whole change is about.
  await pressEscape(win)
  await atRoot(win)
  await win.waitForTimeout(600)
}

test('a running understand pass is visible on the map, wherever you are', async ({
  app,
  window,
}) => {
  test.setTimeout(300_000)
  const root = await seedProject(window, 'flow-inflight-', seed)
  await activateProject(window, root)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  await atRoot(window)
  await window.waitForTimeout(1200)

  // Baseline: nothing is running, so nothing is marked.
  const before = await marksOn(window)
  console.log(`[measured] before any pass: ${JSON.stringify(before)}`)
  expect(before, 'the map claims work is running before anything was pressed').toEqual({})

  // ── START A REAL PASS, THEN WALK AWAY ────────────────────────────────────
  await startPass(window)

  // 1. THE ANCESTOR SHOWS IT AT THE ROOT — and so does the province itself,
  //    because the territory draws a country as GROUND with its features
  //    standing inside. Both claims, one sheet: the hardest place to keep them
  //    apart, and the only place a reader can confuse them.
  const atRootMarks = await marksOn(window)
  await window.screenshot({ path: `${SHOT}/inflight-root-ancestor.png` })
  console.log(`[measured] root while running: ${JSON.stringify(atRootMarks)}`)
  expect(
    atRootMarks['domain:Conversation'],
    'the domain holding the running feature says nothing',
  ).toBe('within')
  // …and it is NOT claiming to be the thing being drawn.
  expect(atRootMarks['domain:Conversation']).not.toBe('self')
  expect(
    atRootMarks['feature:chats'],
    'the running feature does not mark its own cell at the root',
  ).toBe('self')
  expect(atRootMarks['domain:Map'], 'an unrelated domain was marked').toBeUndefined()
  expect(atRootMarks['feature:threads'], 'a sibling was marked').toBeUndefined()

  // THE TWO CLAIMS READ DIFFERENTLY, in words as well as in stroke. The
  // sentence rides the country's LABEL, because the ground itself takes no
  // pointer events and a tooltip nobody can reach is not a channel.
  const sentence = await window.evaluate(() => {
    const el = [...document.querySelectorAll('.fb-terr-group')].find(
      (n) => (n as HTMLElement).dataset['featureId'] === 'domain:Conversation',
    )
    return el?.querySelector<HTMLElement>('.fb-terr-group-label')?.title ?? null
  })
  console.log(`[measured] ancestor sentence: ${String(sentence)}`)
  expect(sentence, 'the ancestor does not say what it is claiming').toContain('inside')
  expect(sentence).toContain('Chats')
  expect(sentence, 'the ancestor reads as the thing being drawn').not.toMatch(
    /^Understanding Conversation/,
  )

  // 2. ITS OWN CELL SHOWS IT ONE LEVEL IN, where the country has become the
  //    title strip and only its own features are on the sheet.
  await dive(window, 'domain:Conversation')
  const inDomain = await marksOn(window)
  const chatsDot = await dotOf(window, 'feature:chats')
  await window.screenshot({ path: `${SHOT}/inflight-own-glyph.png` })
  console.log(
    `[measured] inside Conversation: ${JSON.stringify(inDomain)} chats dot=${String(chatsDot)}`,
  )
  expect(inDomain['feature:chats'], 'the running feature does not mark itself').toBe('self')
  expect(inDomain['feature:threads'], 'a sibling was marked').toBeUndefined()
  // 4. TRUTHFULNESS: running is `learning`, never `learned`.
  expect(chatsDot, 'a running pass reads as finished knowledge').toBe('fb-learn-learning')

  // THE TWO MARKS ARE TOLD APART BY STROKE, not by motion — measured back at
  // the root, the one sheet showing BOTH at once (the province inside its
  // country), which is where the confusion could actually occur.
  await popOut(window)
  await atRoot(window)
  await window.waitForTimeout(400)
  const strokes = await window.evaluate(() => {
    const styleOf = (selector: string, id: string): CSSStyleDeclaration | null => {
      const el = [...document.querySelectorAll(selector)].find(
        (n) => (n as HTMLElement).dataset['featureId'] === id,
      )
      return el === undefined ? null : getComputedStyle(el)
    }
    const self = styleOf('.fb-terr-cell', 'feature:chats')
    const within = styleOf('.fb-terr-group', 'domain:Conversation')
    return {
      selfStyle: self?.borderTopStyle ?? null,
      withinStyle: within?.borderTopStyle ?? null,
      selfAnimation: self?.animationName ?? null,
      withinAnimation: within?.animationName ?? null,
    }
  })
  console.log(`[measured] strokes: ${JSON.stringify(strokes)}`)
  expect(strokes.selfStyle, 'the node being drawn is dashed like a container').toBe('solid')
  expect(strokes.withinStyle, 'a container is drawn identically to the running node').toBe(
    'dashed',
  )

  // 3. SURVIVES RE-RENDER: dive all the way in (the running feature becomes the
  //    title strip and its PARTS carry the mark in their own right) and come
  //    back. Each dive rebuilds every element the mark was hanging off, so the
  //    only way it can still be there is by being re-derived per render.
  await dive(window, 'domain:Conversation')
  await dive(window, 'feature:chats')
  const inChats = await marksOn(window)
  await window.screenshot({ path: `${SHOT}/inflight-inside.png` })
  console.log(`[measured] inside Chats: ${JSON.stringify(inChats)}`)
  expect(
    Object.values(inChats).every((mark) => mark === 'self'),
    'a level inside the running pass claims something is merely contained',
  ).toBe(true)

  await popOut(window)
  await popOut(window)
  await atRoot(window)
  const backAtRoot = await marksOn(window)
  console.log(`[measured] back at root: ${JSON.stringify(backAtRoot)}`)
  expect(backAtRoot['domain:Conversation'], 'the mark did not survive navigation').toBe('within')

  // ── REDUCED MOTION: STILL PERCEIVABLE ────────────────────────────────────
  //
  // The breath is killed; the BORDER must not be what goes with it. Both marks
  // are measured, because a reader who cannot see motion is the reader most
  // dependent on the two of them staying distinguishable.
  await window.emulateMedia({ reducedMotion: 'reduce' })
  await window.waitForTimeout(400)
  const reduced = await window.evaluate(() => {
    const styleOf = (selector: string, id: string): CSSStyleDeclaration | null => {
      const el = [...document.querySelectorAll(selector)].find(
        (n) => (n as HTMLElement).dataset['featureId'] === id,
      )
      return el === undefined ? null : getComputedStyle(el)
    }
    const self = styleOf('.fb-terr-cell', 'feature:chats')
    const within = styleOf('.fb-terr-group', 'domain:Conversation')
    if (self === null || within === null) return null
    return {
      selfAnimation: self.animationName,
      selfShadow: self.boxShadow,
      withinAnimation: within.animationName,
      withinStyle: within.borderTopStyle,
    }
  })
  await window.screenshot({ path: `${SHOT}/inflight-reduced-motion.png` })
  console.log(`[measured] reduced motion marks: ${JSON.stringify(reduced)}`)
  expect(reduced, 'neither mark is on the sheet under reduced motion').not.toBeNull()
  expect(
    reduced?.selfAnimation,
    'the breath still runs for a reduced-motion reader',
  ).toBe('none')
  expect(reduced?.selfShadow, 'self has nothing left once the breath is gone').not.toBe('none')
  // The dashed border is what tells `within` from `self` WITHOUT motion.
  expect(reduced?.withinStyle, 'within has no static way to be told from self').toBe('dashed')
  await window.emulateMedia({ reducedMotion: 'no-preference' })

  // ── FAILURE CLEARS IT, AND DOES NOT LEAVE `learned` BEHIND ───────────────
  await endPass(app, root, 'failed', {
    done: FEATURE_VIEW_DONE_TITLE,
    failed: FEATURE_VIEW_FAILED_TITLE,
  })
  await window.waitForTimeout(1200)
  const afterFail = await marksOn(window)
  await window.screenshot({ path: `${SHOT}/inflight-cleared-failure.png` })
  console.log(`[measured] after failure: ${JSON.stringify(afterFail)}`)
  expect(afterFail, 'a failed pass left a mark running forever').toEqual({})

  await dive(window, 'domain:Conversation')
  const failedDot = await dotOf(window, 'feature:chats')
  console.log(`[measured] chats dot after failure: ${String(failedDot)}`)
  expect(failedDot, 'a FAILED pass made the feature read as understood').not.toBe('fb-learn-learned')
  expect(failedDot, 'a failed pass left the node stuck on learning').not.toBe('fb-learn-learning')
  await popOut(window)
  await atRoot(window)

  // ── AND SUCCESS CLEARS IT TOO ────────────────────────────────────────────
  await startPass(window)
  const running2 = await marksOn(window)
  console.log(`[measured] second run at root: ${JSON.stringify(running2)}`)
  expect(running2['domain:Conversation'], 'the second pass was never marked').toBe('within')

  await endPass(app, root, 'done', {
    done: FEATURE_VIEW_DONE_TITLE,
    failed: FEATURE_VIEW_FAILED_TITLE,
  })
  await window.waitForTimeout(1500)
  // Success REOPENS the feature (existing behaviour), so come back to the map.
  await pressEscape(window)
  await atRoot(window)
  await window.waitForTimeout(800)
  const afterDone = await marksOn(window)
  await window.screenshot({ path: `${SHOT}/inflight-cleared-success.png` })
  console.log(`[measured] after success: ${JSON.stringify(afterDone)}`)
  expect(afterDone, 'a completed pass left a mark running forever').toEqual({})
})
