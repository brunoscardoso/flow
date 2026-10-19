/**
 * THE CODE STORY IN ANY LANGUAGE (plan story-any-language) — a Python part, a
 * part mixing Python with TypeScript, and a file in a language with no reader,
 * each opened on the Blueprint board.
 *
 * Real everywhere it can be: a seeded git repo holding a small Python package
 * (a class whose methods call each other through `self`, docstrings, a
 * relative import), a TypeScript client, and an Elixir file; a feature whose
 * parts name them; the board asking the bundled CLI — whose tree-sitter engine
 * main points it at (`FLOW_TREESITTER_PATH`) — through main. Screens of both
 * themes land in FLOW_E2E_SCREENS (or `__screens`) for a person to look at.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'
import { callBoard } from '../board-hook'

const SCREENS = process.env['FLOW_E2E_SCREENS'] ?? resolve(__dirname, '__screens')
const FEATURE = 'Shop'
const CART = 'shop/cart.py'
const PRICING = 'shop/pricing.py'
const CLIENT = 'web/client.ts'
const ELIXIR = 'lib/tool.ex'
/** A part of ONE Python file: its press reads cart.py alone. */
const PY_PART = 'Cart model'
/** A part naming Python and TypeScript files together. */
const MIXED_PART = 'Totals'
/** A part that is only the Elixir file — the board's door to a file with no reader. */
const NO_READER_PART = 'Tooling'

test.afterAll(() => cleanupSeeds())

const CART_PY = [
  'from .pricing import apply_discount',
  '',
  '',
  'class Cart:',
  '    """A shopping cart that totals its items."""',
  '',
  '    def __init__(self, owner: str) -> None:',
  '        self.owner = owner',
  '        self.items: list[int] = []',
  '        self.add(0)',
  '        self.opening = self.total()',
  '',
  '    def add(self, price: int) -> None:',
  '        """Put one item in the cart."""',
  '        self.items.append(price)',
  '        self._touch()',
  '',
  '    def total(self) -> int:',
  '        """Sum every item, discounted."""',
  '        return apply_discount(self._subtotal())',
  '',
  '    def _subtotal(self) -> int:',
  '        return sum(self.items)',
  '',
  '    def _touch(self) -> None:',
  '        pass',
  '',
  '',
  'def open_cart(owner: str) -> Cart:',
  '    """Start a cart for one owner."""',
  '    return Cart(owner)',
  '',
].join('\n')

function seed(dir: string): void {
  const files: Record<string, string> = {
    'shop/__init__.py': '',
    [CART]: CART_PY,
    [PRICING]: ['def apply_discount(amount: int) -> int:', '    """Take ten percent off."""', '    return amount - amount // 10', ''].join('\n'),
    'shop/checkout.py': ['from .cart import open_cart', '', '', 'def checkout(owner: str) -> int:', '    return open_cart(owner).total()', ''].join('\n'),
    [CLIENT]: ['/** Ask the shop for a total. */', 'export function fetchTotal(): number {', '  return 1', '}', ''].join('\n'),
    [ELIXIR]: 'defmodule Tool do\n  def hello, do: 1\nend\n',
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
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
    join(features, 'shop.md'),
    [
      '---',
      'id: feature:shop',
      `name: ${FEATURE}`,
      'kind: core',
      'anchors: [module:shop]',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${FEATURE}`,
      '',
      'Carts, prices and the client that asks for a total.',
      '',
      '## Parts',
      '',
      `### ${PY_PART}`,
      'The cart and what it holds.',
      `anchors: ${CART}`,
      '',
      `### ${MIXED_PART}`,
      'How a cart reaches its total, from the web client to the discount.',
      `anchors: ${CART}, ${PRICING}, ${CLIENT}`,
      '',
      `### ${NO_READER_PART}`,
      'The Elixir helper.',
      `anchors: ${ELIXIR}`,
      '',
    ].join('\n'),
  )
  const structure = join(dir, 'flow', 'brain', '.structure')
  mkdirSync(structure, { recursive: true })
  writeFileSync(
    join(structure, 'graph.json'),
    JSON.stringify({
      version: 1,
      derivedAt: '2026-10-07T00:00:00.000Z',
      coverage: { filesScanned: 6, filesTotal: 6, extractorsRun: ['modules'], graphifyEnriched: false },
      nodes: [{ id: 'module:shop', kind: 'module', label: 'shop', sourceFile: 'shop', meta: { depth: 1, fileCount: 4 } }],
      edges: [],
      mustReview: [],
    }),
  )
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true })
  await page.screenshot({ path: join(SCREENS, `story-any-language-${name}.png`) })
}

async function theme(page: Page, value: 'light' | 'dark'): Promise<void> {
  await page.evaluate((next) => document.documentElement.setAttribute('data-theme', next), value)
  await page.waitForTimeout(200)
}

/** Both themes, with the first-run offer and the pointer out of the way. */
async function screens(page: Page, name: string): Promise<void> {
  const notNow = page.getByRole('button', { name: 'Not now' }).first()
  if (await notNow.isVisible().catch(() => false)) await notNow.click()
  // The whole story in view, so the picture shows every box and wire.
  const fit = page.locator('.fb-story-head fl-button', { hasText: 'Fit' })
  if ((await page.locator('.fb-story-box').count()) > 0) await fit.click()
  await page.mouse.move(2, 400)
  await page.waitForTimeout(300)
  await theme(page, 'dark')
  await screenshot(page, `${name}-dark`)
  await theme(page, 'light')
  await screenshot(page, `${name}-light`)
}

/**
 * Wait until the seeded project's own feature board is drawn — the feature's
 * cell on the sheet — pressing into the Workspace map or re-reading the board
 * the way `code-storyline.spec.ts` does (both were seen live).
 */
async function openProjectBoard(page: Page, root: string): Promise<void> {
  const shop = page.locator('.fb-terr-cell', { hasText: FEATURE }).first()
  const folder = basename(root)
  await expect(async () => {
    if (await shop.isVisible().catch(() => false)) return
    const countries = page.locator('.fb-ws-country')
    if ((await countries.count()) > 0) {
      const ours = countries.filter({ hasText: folder })
      const country = (await ours.count()) > 0 ? ours.first() : countries.first()
      await country.locator('.fb-ws-name').click({ timeout: 2_000 })
    } else {
      await callBoard(page, 'refresh', [], { wait: false })
    }
    await expect(shop).toBeVisible({ timeout: 10_000 })
  }).toPass({ timeout: 150_000, intervals: [1_000, 2_000, 5_000] })
}

/** The feature, then its part — the part's story on screen. */
async function openPart(page: Page, part: string): Promise<void> {
  // From the root, the feature first; Back from a story lands on its parts already.
  await expect(async () => {
    const cell = page.locator('.fb-terr-cell', { hasText: part }).first()
    if (await cell.isVisible().catch(() => false)) return
    await page.locator('.fb-terr-cell', { hasText: FEATURE }).first().dblclick({ timeout: 2_000 })
    await expect(cell).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 90_000 })
  await expect(async () => {
    await page.locator('.fb-terr-cell', { hasText: part }).first().dblclick({ timeout: 2_000 })
    await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
  await expect(page.locator('.fb-story-head .fb-story-crumb.on')).toHaveText(part, { timeout: 60_000 })
}

/** Back out of the story to the feature's level it was opened from. */
async function closeStory(page: Page): Promise<void> {
  await page.locator('.fb-nav-btn[aria-label^="Back"]').click()
  await expect(page.locator('.fb-story')).toHaveCount(0)
}

/** Every call wire of an unfolded box starts on its box's right edge, at a call line. */
async function wireLanding(page: Page): Promise<{ checked: number; misses: string[] }> {
  return page.evaluate(() => {
    const stage = document.querySelector('.fb-story-stage') as HTMLElement
    const k = Number(/scale\(([\d.]+)\)/.exec(stage.style.transform)?.[1] ?? '1')
    const base = stage.getBoundingClientRect()
    const misses: string[] = []
    let checked = 0
    for (const wire of stage.querySelectorAll<SVGPathElement>('.fb-story-wire:not(.fb-story-wire-type)')) {
      const from = wire.dataset['from'] ?? ''
      const box = [...stage.querySelectorAll<HTMLElement>('.fb-story-box')].find((el) => el.dataset['piece'] === from)
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
  })
}

test('a Python part, a mixed part and a file with no reader each open honestly as a story', async ({ window: page }) => {
  test.setTimeout(300_000)
  const root = await seedProject(page, 'flow-ux-story-lang-', seed)
  await activateProject(page, root)
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  for (let i = 0; i < 4; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click()
  }
  const sidebar = page.locator('button[title^="Toggle sidebar"]').first()
  if (await sidebar.isVisible().catch(() => false)) await sidebar.click()
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()
  await openProjectBoard(page, root)

  // ── A PYTHON PART: the class frame, its methods, self-calls as wires, the
  // docstring as the box's doc line, and the header naming the language. ──
  await openPart(page, PY_PART)
  await expect(page.locator('.fb-story-box.fb-story-entry')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator('.fb-story-refusal')).toHaveCount(0)
  await expect(page.locator('.fb-story-language')).toHaveText('Python')
  await expect(page.locator('.fb-story-frame-name').first()).toHaveText('class Cart')
  // The way in is the function another file imports.
  await expect(page.locator('.fb-story-box.fb-story-entry')).toHaveAttribute('data-piece', `${CART}#open_cart`)
  const add = page.locator(`.fb-story-box[data-piece="${CART}#Cart.add"]`)
  await expect(add).toHaveCount(1)
  await expect(add.locator('.fb-story-bdoc')).toHaveText('Put one item in the cart.')
  await expect(page.locator(`.fb-story-box[data-piece="${CART}#Cart.total"] .fb-story-bdoc`)).toHaveText('Sum every item, discounted.')
  await expect(page.locator(`.fb-story-box[data-piece="${CART}#Cart._touch"]`)).toHaveCount(1)
  // The real Python text is in the box.
  await expect(add.locator('pre.fb-story-code')).toContainText('self._touch()')
  // Calls drawn: add → _touch through self, open_cart → the class's constructor.
  const wiresFrom = (piece: string): Promise<string[]> =>
    page.evaluate(
      (from) =>
        [...document.querySelectorAll<SVGPathElement>('.fb-story-wire:not(.fb-story-wire-type)')]
          .filter((wire) => wire.dataset['from'] === from)
          .map((wire) => wire.dataset['to'] ?? ''),
      piece,
    )
  await expect.poll(() => wiresFrom(`${CART}#Cart.add`)).toContain(`${CART}#Cart._touch`)
  await expect.poll(() => wiresFrom(`${CART}#open_cart`)).toContain(`${CART}#Cart.__init__`)
  // The call into pricing.py, which this part does not name, is a chip into its story.
  await expect(page.locator('.fb-story-chip', { hasText: '↗ pricing.py' }).first()).toBeVisible()
  await page.waitForTimeout(800) // Monaco's colours land late and re-measure
  const landed = await wireLanding(page)
  expect(landed.checked).toBeGreaterThan(0)
  expect(landed.misses).toEqual([])
  await screens(page, 'python')
  await closeStory(page)

  // ── A MIXED PART: one story over Python and TypeScript, badged as such. ──
  await openPart(page, MIXED_PART)
  await expect(page.locator('.fb-story-box').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.fb-story-refusal')).toHaveCount(0)
  await expect(page.locator('.fb-story-language')).toHaveText('Mixed languages')
  await expect(page.locator(`.fb-story-box[data-piece="${PRICING}#apply_discount"] .fb-story-bdoc`)).toHaveText('Take ten percent off.')
  // Inside the part the call into pricing.py is a wire, not a chip.
  await expect.poll(() => wiresFrom(`${CART}#Cart.total`)).toContain(`${PRICING}#apply_discount`)
  await expect(page.locator('.fb-story-chip:not(.fb-story-chip-dim)', { hasText: '↗ pricing.py' })).toHaveCount(0)
  await screens(page, 'mixed')
  // The TypeScript file is another way into the same story, read by its own reader.
  await page.locator('.fb-story-select').selectOption(`${CLIENT}#fetchTotal`)
  await expect(page.locator('.fb-story-box.fb-story-entry')).toHaveAttribute('data-piece', `${CLIENT}#fetchTotal`)
  await expect(page.locator(`.fb-story-box[data-piece="${CLIENT}#fetchTotal"] .fb-story-bdoc`)).toHaveText('Ask the shop for a total.')
  await expect(page.locator('.fb-story-language')).toHaveText('Mixed languages')
  await screens(page, 'mixed-typescript')
  await closeStory(page)

  // ── A FILE WITH NO READER: pressing the part that is only that file, the
  // sentence names the language and the code is shown plain. ──
  await openPart(page, NO_READER_PART)
  const refusal = page.locator('.fb-story-refusal')
  await expect(refusal).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.fb-story-refusal-sentence')).toHaveText("Flow can't read Elixir as a story yet.")
  await expect(page.locator('.fb-story-plain-row')).toHaveCount(4)
  await expect(page.locator('.fb-story-plain-row').first()).toContainText('defmodule Tool do')
  // Positive first: the refusal IS on screen, so no boxes and no badge is evidence.
  await expect(page.locator('.fb-story-box')).toHaveCount(0)
  await expect(page.locator('.fb-story-language')).toHaveCount(0)
  await screens(page, 'no-reader')
})
