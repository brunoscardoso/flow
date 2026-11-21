// The drafts path rule, the page address and edit validation — pure, no fs.

import {
  decodeDraftRoot,
  draftPageUrl,
  draftScreenAtPath,
  draftVersionSlug,
  encodeDraftRoot,
  isDraftColour,
  isDraftSpacing,
  parseDraftLayout,
  parseDraftPageUrl,
  resolveDraftPath,
  validateDraftEdit,
  type DraftPageRequest,
} from './ui-drafts'

const ROOT = '/Users/me/projects/my shop'

describe('resolveDraftPath', () => {
  it('accepts the three known kinds directly inside one canvas folder', () => {
    expect(resolveDraftPath(ROOT, 'checkout', 'layout.json')).toEqual({
      ok: true,
      relPath: 'flow/drafts/checkout/layout.json',
      kind: 'layout',
    })
    expect(resolveDraftPath(ROOT, 'checkout', 'tokens.css')).toEqual({
      ok: true,
      relPath: 'flow/drafts/checkout/tokens.css',
      kind: 'tokens',
    })
    expect(resolveDraftPath(ROOT, 'checkout', 'cart-2.html')).toEqual({
      ok: true,
      relPath: 'flow/drafts/checkout/cart-2.html',
      kind: 'screen',
      screen: 'cart-2',
    })
  })

  it('refuses traversal in the canvas or the file', () => {
    for (const [canvas, file] of [
      ['..', 'layout.json'],
      ['../x', 'layout.json'],
      ['checkout', '../layout.json'],
      ['checkout', '..html'],
      ['checkout', '../../etc/passwd.html'],
      ['checkout', '..\\x.html'],
      ['/abs', 'layout.json'],
    ]) {
      expect(resolveDraftPath(ROOT, canvas, file).ok).toBe(false)
    }
  })

  it('refuses nesting', () => {
    expect(resolveDraftPath(ROOT, 'checkout', 'versions/v1/cart.html').ok).toBe(false)
    expect(resolveDraftPath(ROOT, 'checkout', '.history/cart/1.html').ok).toBe(false)
    expect(resolveDraftPath(ROOT, 'checkout/sub', 'cart.html').ok).toBe(false)
  })

  it('refuses other kinds, dotfiles, uppercase and an empty root', () => {
    for (const file of ['cart.htm', 'script.js', 'notes.md', '.view-state.json', 'Cart.html', '-a.html', '.html', 'tokens.CSS']) {
      expect(resolveDraftPath(ROOT, 'checkout', file).ok).toBe(false)
    }
    expect(resolveDraftPath(ROOT, 'Checkout', 'cart.html').ok).toBe(false)
    expect(resolveDraftPath('', 'checkout', 'cart.html').ok).toBe(false)
  })
})

describe('draftPageUrl / parseDraftPageUrl', () => {
  const requests: DraftPageRequest[] = [
    { kind: 'canvas', root: ROOT, canvas: 'checkout' },
    { kind: 'screen', root: ROOT, canvas: 'checkout', screen: 'cart', mode: 'framed' },
    { kind: 'screen', root: ROOT, canvas: 'checkout', screen: 'cart', mode: 'single' },
    { kind: 'asset', root: ROOT, canvas: 'checkout', file: 'tokens.css' },
    { kind: 'asset', root: ROOT, canvas: 'checkout', file: 'layout.json' },
    { kind: 'canvas', root: '/Users/zoë/プロジェクト', canvas: 'a' },
  ]

  it('round-trips every kind, with and without a cache-buster', () => {
    for (const request of requests) {
      expect(parseDraftPageUrl(draftPageUrl(request))).toEqual(request)
      expect(parseDraftPageUrl(draftPageUrl(request, 42))).toEqual(request)
    }
  })

  it('keeps the root in the path, so a relative link stays inside its canvas', () => {
    const screen = draftPageUrl({ kind: 'screen', root: ROOT, canvas: 'checkout', screen: 'cart', mode: 'framed' })
    expect(parseDraftPageUrl(new URL('tokens.css', screen).href)).toEqual({
      kind: 'asset',
      root: ROOT,
      canvas: 'checkout',
      file: 'tokens.css',
    })
    const canvas = draftPageUrl({ kind: 'canvas', root: ROOT, canvas: 'checkout' })
    expect(parseDraftPageUrl(new URL('home.html', canvas).href)).toMatchObject({ kind: 'screen', screen: 'home' })
    // A relative climb out of the canvas lands on something that is not a draft.
    expect(parseDraftPageUrl(new URL('../other/x.html', screen).href)).toMatchObject({ canvas: 'other' })
    expect(parseDraftPageUrl(new URL('../../x.html', screen).href)).toBeNull()
  })

  it('round-trips roots through the path segment', () => {
    for (const root of [ROOT, '/a', '/ab', '/abc', 'C:\\Users\\me\\x', '/emoji/😀']) {
      expect(decodeDraftRoot(encodeDraftRoot(root))).toBe(root)
      expect(encodeDraftRoot(root)).toMatch(/^[A-Za-z0-9_-]+$/)
    }
    expect(decodeDraftRoot('')).toBeNull()
    expect(decodeDraftRoot('a')).toBeNull()
    expect(decodeDraftRoot('a+b/')).toBeNull()
  })

  it('refuses another scheme, another host, a bad root, nesting and wrong kinds', () => {
    const root = encodeDraftRoot(ROOT)
    expect(parseDraftPageUrl(`https://drafts/${root}/checkout/`)).toBeNull()
    expect(parseDraftPageUrl(`flow-page://walkthrough/${root}/checkout/`)).toBeNull()
    expect(parseDraftPageUrl(`flow-page://drafts/!!/checkout/`)).toBeNull()
    expect(parseDraftPageUrl(`flow-page://drafts/${root}/checkout/versions/v1.html`)).toBeNull()
    expect(parseDraftPageUrl(`flow-page://drafts/${root}/checkout/.history`)).toBeNull()
    expect(parseDraftPageUrl(`flow-page://drafts/${root}/checkout/app.js`)).toBeNull()
    expect(parseDraftPageUrl(`flow-page://drafts/${root}/checkout`)).toBeNull()
    expect(parseDraftPageUrl(`flow-page://drafts/${root}/%2e%2e/layout.json`)).toBeNull()
    expect(parseDraftPageUrl('not a url')).toBeNull()
  })
})

describe('parseDraftLayout', () => {
  it('reads screens in order and fills a missing frame in a row', () => {
    const parsed = parseDraftLayout(
      {
        name: 'Checkout',
        tokenSources: ['src/theme.ts', 3],
        screens: [
          { id: 'pay', title: 'Pay', order: 2, frame: { x: 10, y: 20, w: 300, h: 600 } },
          { file: 'cart.html', order: 1 },
        ],
      },
      'checkout',
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.layout.name).toBe('Checkout')
    expect(parsed.layout.tokenSources).toEqual(['src/theme.ts'])
    expect(parsed.layout.screens.map((screen) => screen.id)).toEqual(['cart', 'pay'])
    expect(parsed.layout.screens[0]).toMatchObject({ file: 'cart.html', title: 'cart', frame: { w: 390, h: 844 } })
    expect(parsed.layout.screens[1].frame).toEqual({ x: 10, y: 20, w: 300, h: 600 })
  })

  it('refuses a screen name outside the rule, a mismatched file and a duplicate', () => {
    expect(parseDraftLayout({ screens: [{ id: '../x' }] }, 'c').ok).toBe(false)
    expect(parseDraftLayout({ screens: [{ id: 'a', file: 'b.html' }] }, 'c').ok).toBe(false)
    expect(parseDraftLayout({ screens: [{ id: 'a' }, { id: 'a' }] }, 'c').ok).toBe(false)
    expect(parseDraftLayout({}, 'c').ok).toBe(false)
    expect(parseDraftLayout([], 'c').ok).toBe(false)
  })
})

describe('validateDraftEdit', () => {
  it('accepts text, colour and spacing edits', () => {
    expect(validateDraftEdit({ id: 'a1', kind: 'text', text: 'Pay now' }).ok).toBe(true)
    for (const value of ['#fff', '#FFAA00', '#ffaa0080', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'rebeccapurple', 'Transparent']) {
      expect(validateDraftEdit({ id: 'a1', kind: 'colour', property: 'color', value }).ok).toBe(true)
    }
    for (const value of ['0', '12px', '1.5rem', '0.25rem']) {
      expect(validateDraftEdit({ id: 'a1', kind: 'spacing', property: 'padding-left', value }).ok).toBe(true)
    }
  })

  it('refuses any value that is not strictly a colour or a spacing', () => {
    for (const value of ['red; background: url(x)', 'expression(alert(1))', '#ggg', 'rgb(1,2)', 'notacolour', '" onclick="x', 'var(--x)']) {
      expect(isDraftColour(value)).toBe(false)
      expect(validateDraftEdit({ id: 'a1', kind: 'colour', property: 'color', value }).ok).toBe(false)
    }
    for (const value of ['12', '12em', '-4px', '1px 2px', '12px;color:red', 'calc(1px)', '']) {
      expect(isDraftSpacing(value)).toBe(false)
      expect(validateDraftEdit({ id: 'a1', kind: 'spacing', property: 'gap', value }).ok).toBe(false)
    }
  })

  it('refuses an unknown property, kind or id', () => {
    expect(validateDraftEdit({ id: 'a1', kind: 'colour', property: 'outline-color', value: 'red' }).ok).toBe(false)
    expect(validateDraftEdit({ id: 'a1', kind: 'spacing', property: 'width', value: '1px' }).ok).toBe(false)
    expect(validateDraftEdit({ id: 'a1', kind: 'html', text: '<b>' }).ok).toBe(false)
    expect(validateDraftEdit({ id: 'a"b', kind: 'text', text: 'x' }).ok).toBe(false)
    expect(validateDraftEdit({ kind: 'text', text: 'x' }).ok).toBe(false)
    expect(validateDraftEdit(null).ok).toBe(false)
  })
})

describe('draftVersionSlug', () => {
  it('derives a folder name, or null when nothing usable is left', () => {
    expect(draftVersionSlug('First pass — Café')).toBe('first-pass-cafe')
    expect(draftVersionSlug('  !!  ')).toBeNull()
    expect(draftVersionSlug('../etc')).toBe('etc')
  })
})

describe('draftScreenAtPath', () => {
  it('names the screen of a file in a canvas folder', () => {
    expect(draftScreenAtPath('/p/app/flow/drafts/desks-icons/compare-all.html')).toEqual({
      root: '/p/app',
      canvas: 'desks-icons',
      screen: 'compare-all',
    })
  })

  it('is null for the layout, the tokens, a nested file or a file outside the drafts', () => {
    expect(draftScreenAtPath('/p/flow/drafts/pay/layout.json')).toBeNull()
    expect(draftScreenAtPath('/p/flow/drafts/pay/tokens.css')).toBeNull()
    expect(draftScreenAtPath('/p/flow/drafts/pay/old/home.html')).toBeNull()
    expect(draftScreenAtPath('/p/docs/home.html')).toBeNull()
  })
})
