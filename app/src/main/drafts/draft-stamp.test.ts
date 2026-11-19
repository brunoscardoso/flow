// Stamping ids on a draft screen: added once, never twice, and no other byte moves.

import { draftIdsIn, stampDraftIds } from './draft-stamp'
import { matchingEndIndex, scanHtml } from './html-scan'

function counter(): () => string {
  let next = 0
  return () => `id${(next += 1)}`
}

const SCREEN = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Cart <b>not a tag</b></title>
  <link rel="stylesheet" href="tokens.css">
  <style>.a > .b { color: red } /* <div> */</style>
</head>
<body class='page'>
  <!-- <section> in a comment -->
  <main data-flow-id="keep1">
    <h1 title="a > b">Cart</h1>
    <p>Total<br>€ 12</p>
    <img src="data:image/png;base64,AA==" alt=x>
    <input disabled/>
  </main>
  <script>if (a < b && c > d) { document.body.innerHTML = '<div></div>' }</script>
</body>
</html>
`

/** Remove every attribute the stamp added, to compare the rest byte for byte. */
function unstamp(html: string): string {
  return html.replace(/ data-flow-id="id\d+"/g, '')
}

describe('stampDraftIds', () => {
  it('adds an id to every element tag that has none, and skips plumbing tags', () => {
    const { html, added } = stampDraftIds(SCREEN, new Set(), counter())
    // body, h1, p, img, input — main already has one; br/html/head/meta/title/link/style/script are skipped.
    expect(added).toBe(5)
    expect(html).toContain('<body data-flow-id="id1" class=\'page\'>')
    expect(html).toContain('<h1 data-flow-id="id2" title="a > b">Cart</h1>')
    expect(html).toContain('<p data-flow-id="id3">Total<br>€ 12</p>')
    expect(html).toContain('<img data-flow-id="id4" src=')
    expect(html).toContain('<input data-flow-id="id5" disabled/>')
    expect(html).toContain('<main data-flow-id="keep1">')
    for (const tag of ['<html lang', '<head>', '<meta charset', '<title>', '<link rel', '<style>', '<script>', '<br>']) {
      expect(html).toContain(tag)
    }
  })

  it('leaves every other byte untouched — script, style, title and comments included', () => {
    const { html } = stampDraftIds(SCREEN, new Set(), counter())
    expect(unstamp(html)).toBe(SCREEN)
    expect(html).toContain("<script>if (a < b && c > d) { document.body.innerHTML = '<div></div>' }</script>")
    expect(html).toContain('<style>.a > .b { color: red } /* <div> */</style>')
    expect(html).toContain('<title>Cart <b>not a tag</b></title>')
    expect(html).toContain('<!-- <section> in a comment -->')
  })

  it('is idempotent: a stamped screen gains nothing on a second pass', () => {
    const once = stampDraftIds(SCREEN, new Set(), counter())
    const twice = stampDraftIds(once.html, new Set(), counter())
    expect(twice).toEqual({ html: once.html, added: 0 })
  })

  it('mints ids unique per screen, avoiding ids already present and ids it was told are taken', () => {
    const mint = (() => {
      const queue = ['keep1', 'taken', 'fresh1', 'fresh1', 'fresh2']
      return () => queue.shift() as string
    })()
    const { html } = stampDraftIds('<main data-flow-id="keep1"><a>x</a><b>y</b></main>', new Set(['taken']), mint)
    expect(html).toBe('<main data-flow-id="keep1"><a data-flow-id="fresh1">x</a><b data-flow-id="fresh2">y</b></main>')
    expect([...draftIdsIn(html)].sort()).toEqual(['fresh1', 'fresh2', 'keep1'])
  })

  it('uses short random ids by default', () => {
    const { html } = stampDraftIds('<div><span>a</span></div>', new Set())
    expect(html).toMatch(/^<div data-flow-id="[a-z][a-z0-9]{5}"><span data-flow-id="[a-z][a-z0-9]{5}">a<\/span><\/div>$/)
  })
})

describe('scanHtml', () => {
  it('tiles the input exactly', () => {
    const tokens = scanHtml(SCREEN)
    expect(tokens[0].start).toBe(0)
    for (let index = 1; index < tokens.length; index += 1) expect(tokens[index].start).toBe(tokens[index - 1].end)
    expect(tokens[tokens.length - 1].end).toBe(SCREEN.length)
  })

  it('bounds an element by its own closing tag, and refuses one it cannot bound', () => {
    const html = '<div><div>a</div><br><p>b</p></div><span>'
    const tokens = scanHtml(html)
    expect(tokens[matchingEndIndex(tokens, 0) as number]).toMatchObject({ type: 'end', name: 'div', start: 29 })
    const spanIndex = tokens.findIndex((token) => token.type === 'start' && token.name === 'span')
    expect(matchingEndIndex(tokens, spanIndex)).toBeNull()
  })
})
