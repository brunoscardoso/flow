// The artifact's draft screens: a step's slot becomes a framed live preview,
// badged when the screen moved on after the plan; a missing one is a quiet box.

import { serveWalkthroughPage, WALKTHROUGH_PAGE_CSP } from '../flow/walkthrough-page'
import { draftPageUrl } from '../../shared/ui-drafts'
import { hashDraftScreen, renderDraftScreensBlock } from './draft-screens'
import {
  DRAFT_SCREEN_CHANGED_TEXT,
  DRAFT_SCREEN_MISSING_TEXT,
  resolveArtifactDraftSlots,
  withoutDraftSlots,
} from './artifact-slots'

const ROOT = '/Users/me/projects/shop'
const PAGE_PATH = 'flow/discovery/discovery_shop_v1.walkthrough.html'
const CART = '<div data-flow-id="a"><h1>Cart</h1></div>'
const LAYOUT = JSON.stringify({
  name: 'Shop',
  screens: [{ id: 'cart', title: 'Cart <b>', frame: { x: 0, y: 0, w: 320, h: 640 } }],
})

function fakeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}) {
  const reads: string[] = []
  return {
    reads,
    readFile: async (absPath: string): Promise<string> => {
      reads.push(absPath)
      const hit = files[absPath]
      if (hit === undefined) throw new Error('ENOENT')
      return hit
    },
    readDir: async (absPath: string): Promise<string[]> => {
      const hit = dirs[absPath]
      if (hit === undefined) throw new Error('ENOENT')
      return hit
    },
  }
}

const page = (...slots: string[]): string => `<html><body>${slots.map((s) => `<div data-flow-draft="${s}"></div>`).join('')}</body></html>`
const planWith = (html: string): string =>
  `# Plan\n\n## Intent\n\ngoal\n\n${renderDraftScreensBlock([{ canvas: 'shop', screen: 'cart', hash: hashDraftScreen(html) }])}\n---\n`

const base = {
  [`${ROOT}/flow/drafts/shop/layout.json`]: LAYOUT,
  [`${ROOT}/flow/drafts/shop/cart.html`]: CART,
}

describe('resolveArtifactDraftSlots', () => {
  it('leaves a page with no slot untouched, without reading anything', async () => {
    const fs = fakeFs({})
    expect(await resolveArtifactDraftSlots('<p>hi</p>', ROOT, PAGE_PATH, fs)).toBe('<p>hi</p>')
    expect(fs.reads).toEqual([])
  })

  it('frames the screen from the drafts host, sandboxed, sized from its frame, titled and escaped', async () => {
    const fs = fakeFs(base)
    const out = await resolveArtifactDraftSlots(page('shop/cart'), ROOT, PAGE_PATH, fs)
    expect(out).toContain(`src="${draftPageUrl({ kind: 'screen', root: ROOT, canvas: 'shop', screen: 'cart', mode: 'framed' })}"`)
    expect(out).toContain('sandbox="allow-scripts"')
    expect(out).not.toContain('allow-same-origin')
    expect(out).toContain('width:320px')
    expect(out).toContain('aspect-ratio:320 / 640')
    expect(out).toContain('Cart &lt;b&gt;')
    expect(out).not.toContain('data-flow-draft=')
    expect(out).not.toContain(DRAFT_SCREEN_CHANGED_TEXT)
  })

  it('says "not drawn yet" for a missing screen, a missing canvas and a bad address', async () => {
    const fs = fakeFs(base)
    const out = await resolveArtifactDraftSlots(page('shop/nope', 'ghost/cart', '../x/y'), ROOT, PAGE_PATH, fs)
    expect(out.match(new RegExp(DRAFT_SCREEN_MISSING_TEXT, 'g'))).toHaveLength(3)
    expect(out).not.toContain('<iframe')
  })

  it('badges a screen that differs from the plan, and only that one', async () => {
    const dir = `${ROOT}/flow/plans`
    const unchanged = fakeFs(
      { ...base, [`${dir}/plan_shop_v1.md`]: planWith(CART) },
      { [dir]: ['plan_shop_v1.md'] },
    )
    expect(await resolveArtifactDraftSlots(page('shop/cart'), ROOT, PAGE_PATH, unchanged)).not.toContain(
      DRAFT_SCREEN_CHANGED_TEXT,
    )
    const changed = fakeFs(
      { ...base, [`${dir}/plan_shop_v1.md`]: planWith('<h1>Old cart</h1>') },
      { [dir]: ['plan_shop_v1.md'] },
    )
    expect(await resolveArtifactDraftSlots(page('shop/cart'), ROOT, PAGE_PATH, changed)).toContain(
      DRAFT_SCREEN_CHANGED_TEXT,
    )
    // No plan, no badge: nothing was recorded to differ from.
    const noPlan = fakeFs(base, { [dir]: [] })
    expect(await resolveArtifactDraftSlots(page('shop/cart'), ROOT, PAGE_PATH, noPlan)).not.toContain(
      DRAFT_SCREEN_CHANGED_TEXT,
    )
  })

  it('looks for the plan in the archive when the artifact is archived', async () => {
    const dir = `${ROOT}/flow/archive`
    const fs = fakeFs(
      { ...base, [`${dir}/plan_shop_v1.md`]: planWith('<h1>Old</h1>') },
      { [dir]: ['plan_shop_v1.md'] },
    )
    const out = await resolveArtifactDraftSlots(page('shop/cart'), ROOT, 'flow/archive/discovery_shop_v1.walkthrough.html', fs)
    expect(out).toContain(DRAFT_SCREEN_CHANGED_TEXT)
  })
})

describe('the walkthrough host', () => {
  it('serves the resolved page and lets it frame the drafts host only', async () => {
    const fs = fakeFs({ ...base, [`${ROOT}/${PAGE_PATH}`]: page('shop/cart') }, { [`${ROOT}/flow/plans`]: [] })
    const response = await serveWalkthroughPage(
      `flow-page://walkthrough/?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent(PAGE_PATH)}`,
      { isKnownRoot: (root) => root === ROOT, readFile: fs.readFile, readDir: fs.readDir },
    )
    expect(await response.text()).toContain('<iframe')
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toBe(WALKTHROUGH_PAGE_CSP)
    expect(csp).toContain('frame-src flow-page://drafts')
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toMatch(/frame-src[^;]*(\*|https?:)/)
  })
})

describe('withoutDraftSlots (the shared copy)', () => {
  it('removes every slot — valid, missing or malformed — and keeps every other byte', () => {
    const html = `<p>a</p>${page('shop/cart')}<p>b</p><div data-flow-draft="nope"></div><div class="keep">c</div>`
    expect(html).toContain('data-flow-draft')
    expect(withoutDraftSlots(html)).toBe('<p>a</p><html><body></body></html><p>b</p><div class="keep">c</div>')
  })

  it('returns a page with no slot as the same string', () => {
    const html = '<p>hi</p>'
    expect(withoutDraftSlots(html)).toBe(html)
  })
})
