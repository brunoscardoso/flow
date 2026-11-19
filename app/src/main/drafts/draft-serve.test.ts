// The page scheme's dispatch: the walkthrough host is unchanged, the drafts
// host serves through its own path rule with its own policies.

import { serveWalkthroughPage, WALKTHROUGH_PAGE_CSP } from '../flow/walkthrough-page'
import { draftPageUrl, encodeDraftRoot } from '../../shared/ui-drafts'
import { DRAFT_CANVAS_CSP, DRAFT_DATA_CSP, draftScreenCsp, resolveDraftRequest } from './draft-serve'
import { canvasMetaText, canvasPageHtml, screenProblemSentence } from './canvas-page'

const ROOT = '/Users/me/projects/shop'
const knownRoot = (rootPath: string): boolean => rootPath === ROOT
const LAYOUT = JSON.stringify({ name: 'Checkout </script><b>', screens: [{ id: 'cart', title: 'Cart' }] })

function files(map: Record<string, string>): { readFile: (absPath: string) => Promise<string>; reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    readFile: async (absPath) => {
      reads.push(absPath)
      const hit = map[absPath]
      if (hit === undefined) throw new Error('ENOENT')
      return hit
    },
  }
}

const disk = {
  [`${ROOT}/flow/drafts/checkout/layout.json`]: LAYOUT,
  [`${ROOT}/flow/drafts/checkout/tokens.css`]: ':root{}',
  [`${ROOT}/flow/drafts/checkout/cart.html`]: '<h1>Cart</h1>',
  [`${ROOT}/flow/discovery/discovery_shop_v1.walkthrough.html`]: '<html><body>walk</body></html>',
}

let warn: jest.SpyInstance
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => warn.mockRestore())

describe('serveWalkthroughPage dispatch', () => {
  it('keeps the walkthrough host exactly as it was', async () => {
    const fs = files(disk)
    const response = await serveWalkthroughPage(
      `flow-page://walkthrough/?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent('flow/discovery/discovery_shop_v1.walkthrough.html')}`,
      { isKnownRoot: knownRoot, readFile: fs.readFile },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(WALKTHROUGH_PAGE_CSP)
    expect(await response.text()).toContain('walk')
    // …and the walkthrough host still refuses a drafts path.
    const refused = await serveWalkthroughPage(
      `flow-page://walkthrough/?root=${encodeURIComponent(ROOT)}&path=${encodeURIComponent('flow/drafts/checkout/cart.html')}`,
      { isKnownRoot: knownRoot, readFile: fs.readFile },
    )
    expect(refused.status).toBe(404)
  })

  it('serves a screen sandboxed, with only inline code and its own tokens stylesheet', async () => {
    const fs = files(disk)
    for (const mode of ['framed', 'single'] as const) {
      const response = await serveWalkthroughPage(
        draftPageUrl({ kind: 'screen', root: ROOT, canvas: 'checkout', screen: 'cart', mode }),
        { isKnownRoot: knownRoot, readFile: fs.readFile },
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('<h1>Cart</h1>')
      const csp = response.headers.get('content-security-policy') ?? ''
      expect(csp).toBe(draftScreenCsp(ROOT, 'checkout'))
      expect(csp.startsWith('sandbox allow-scripts; ')).toBe(true)
      expect(csp).not.toContain('allow-same-origin')
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain(`style-src 'unsafe-inline' flow-page://drafts/${encodeDraftRoot(ROOT)}/checkout/tokens.css`)
      expect(csp).not.toMatch(/connect-src|frame-src|https?:/)
    }
  })

  it('lets a screen reach its own canvas only — never another canvas of the same project', async () => {
    const own = `flow-page://drafts/${encodeDraftRoot(ROOT)}/checkout/tokens.css`
    const other = `flow-page://drafts/${encodeDraftRoot(ROOT)}/onboarding/tokens.css`
    // The positive first: the screen's own stylesheet IS allowed.
    expect(draftScreenCsp(ROOT, 'checkout')).toContain(own)
    expect(draftScreenCsp(ROOT, 'checkout')).not.toContain(other)
    expect(draftScreenCsp(ROOT, 'checkout')).not.toContain('flow-page://drafts/ ')
    expect(draftScreenCsp(ROOT, 'checkout')).not.toMatch(/flow-page:(\s|;|$)/)
    // …and the other canvas's screen gets ITS stylesheet, not checkout's.
    expect(draftScreenCsp(ROOT, 'onboarding')).toContain(other)
    expect(draftScreenCsp(ROOT, 'onboarding')).not.toContain(own)
    // A path that climbs out of one canvas into another is refused, reading nothing.
    const fs = files({ ...disk, [`${ROOT}/flow/drafts/onboarding/tokens.css`]: ':root{}' })
    const root = encodeDraftRoot(ROOT)
    for (const url of [`flow-page://drafts/${root}/checkout/..%2Fonboarding%2Ftokens.css`, `flow-page://drafts/${root}/checkout/onboarding/tokens.css`]) {
      const response = await serveWalkthroughPage(url, { isKnownRoot: knownRoot, readFile: fs.readFile })
      expect([url, response.status]).toEqual([url, 404])
    }
    expect(fs.reads).toEqual([])
  })

  it('serves the Flow-owned canvas page with the layout embedded inertly and frames allowed', async () => {
    const fs = files(disk)
    const response = await serveWalkthroughPage(draftPageUrl({ kind: 'canvas', root: ROOT, canvas: 'checkout' }), {
      isKnownRoot: knownRoot,
      readFile: fs.readFile,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(DRAFT_CANVAS_CSP)
    expect(DRAFT_CANVAS_CSP).toContain('frame-src flow-page:')
    const html = await response.text()
    expect(html).toContain("iframe.setAttribute('sandbox', 'allow-scripts')")
    expect(html).not.toContain('allow-same-origin')
    // A name that tries to close the data block stays inert.
    expect(html).not.toContain('</script><b>')
    expect(html).toContain('Checkout \\u003c/script\\u003e\\u003cb\\u003e')
  })

  it('serves the canvas page with a sentence when the layout is missing', async () => {
    const fs = files({})
    const response = await serveWalkthroughPage(draftPageUrl({ kind: 'canvas', root: ROOT, canvas: 'checkout' }), {
      isKnownRoot: knownRoot,
      readFile: fs.readFile,
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('This canvas has no layout yet.')
  })

  it('embeds which screens cannot be read, so the canvas draws the reason in their place', async () => {
    const fs = files({
      [`${ROOT}/flow/drafts/checkout/layout.json`]: JSON.stringify({
        name: 'Checkout',
        screens: [{ id: 'cart' }, { id: 'pay' }, { id: 'done' }],
      }),
      [`${ROOT}/flow/drafts/checkout/cart.html`]: '<h1>Cart</h1>',
      [`${ROOT}/flow/drafts/checkout/pay.html`]: '  \n ',
    })
    const response = await serveWalkthroughPage(draftPageUrl({ kind: 'canvas', root: ROOT, canvas: 'checkout' }), {
      isKnownRoot: knownRoot,
      readFile: fs.readFile,
    })
    const html = await response.text()
    const data = JSON.parse(/<script type="application\/json" id="flow-canvas-data">(.*?)<\/script>/s.exec(html)?.[1] ?? '{}')
    expect(data.screenProblems).toEqual({
      pay: screenProblemSentence('empty'),
      done: screenProblemSentence('missing'),
    })
    expect(screenProblemSentence('empty')).toBe(
      'This screen could not be read. The file is empty. Ask the agent to draw it again.',
    )
  })

  it('serves an empty or missing screen as Flow\'s sentence, still sandboxed', async () => {
    const fs = files({ [`${ROOT}/flow/drafts/checkout/pay.html`]: '' })
    for (const [screen, why] of [
      ['pay', 'The file is empty.'],
      ['gone', 'The file is missing.'],
    ] as const) {
      const response = await serveWalkthroughPage(
        draftPageUrl({ kind: 'screen', root: ROOT, canvas: 'checkout', screen, mode: 'framed' }),
        { isKnownRoot: knownRoot, readFile: fs.readFile },
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toBe(draftScreenCsp(ROOT, 'checkout'))
      const body = await response.text()
      expect(body).toContain(why)
      expect(body).toContain('data-flow-unreadable')
    }
  })

  it('names the canvas in the toolbar with its screen count, and escapes agent-written text', () => {
    const layout = {
      name: '<img src=x onerror=alert(1)>',
      tokenSources: ['src/theme.ts'],
      screens: [{ id: 'cart', file: 'cart.html', title: '</script>', order: 0, frame: { x: 0, y: 0, w: 390, h: 844 } }],
    }
    expect(canvasMetaText(layout)).toBe("1 screen · colours from the app's theme")
    expect(canvasMetaText({ ...layout, tokenSources: [] })).toBe('1 screen')
    expect(canvasMetaText({ ...layout, screens: [layout.screens[0], { ...layout.screens[0], id: 'pay' }] })).toBe(
      "2 screens · colours from the app's theme",
    )
    const html = canvasPageHtml({ canvas: 'checkout', layout })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html.match(/<\/script>/g)?.length).toBe(2)
    expect(html).not.toContain('allow-same-origin')
    // The page's own script is valid JavaScript (it is only parsed here, not run).
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
    expect(scripts).toHaveLength(1)
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    expect(() => new Function(scripts[0])).not.toThrow()
  })

  it('serves tokens and layout as data with a closed policy', async () => {
    const fs = files(disk)
    const tokens = await serveWalkthroughPage(draftPageUrl({ kind: 'asset', root: ROOT, canvas: 'checkout', file: 'tokens.css' }), {
      isKnownRoot: knownRoot,
      readFile: fs.readFile,
    })
    expect(tokens.headers.get('content-type')).toContain('text/css')
    expect(tokens.headers.get('content-security-policy')).toBe(DRAFT_DATA_CSP)
    const layout = await serveWalkthroughPage(draftPageUrl({ kind: 'asset', root: ROOT, canvas: 'checkout', file: 'layout.json' }), {
      isKnownRoot: knownRoot,
      readFile: fs.readFile,
    })
    expect(layout.headers.get('content-type')).toContain('application/json')
  })

  it('refuses an unknown root, traversal and other kinds with a 404, reading nothing', async () => {
    const fs = files(disk)
    const root = encodeDraftRoot(ROOT)
    for (const url of [
      draftPageUrl({ kind: 'screen', root: '/elsewhere', canvas: 'checkout', screen: 'cart', mode: 'framed' }),
      `flow-page://drafts/${root}/checkout/../../etc/passwd.html`,
      `flow-page://drafts/${root}/checkout/.history/cart/1.html`,
      `flow-page://drafts/${root}/checkout/app.js`,
      `flow-page://drafts/${root}/Checkout/cart.html`,
    ]) {
      const response = await serveWalkthroughPage(url, { isKnownRoot: knownRoot, readFile: fs.readFile })
      expect([url, response.status]).toEqual([url, 404])
    }
    expect(fs.reads).toEqual([])
    expect(resolveDraftRequest(`flow-page://drafts/${root}/checkout/cart.html`, () => false)).toEqual({
      ok: false,
      reason: 'unknown project root',
    })
  })
})
