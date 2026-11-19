import { draftPageUrl } from '../../shared/ui-drafts'
import { canvasChangedScript, draftChangeTiming, draftReloadAction, mergeDraftChange } from './drafts-reload'

const ROOT = '/Users/me/shop'
const canvasUrl = `${draftPageUrl({ kind: 'canvas', root: ROOT, canvas: 'demo' })}#view=0.8,10,20`
const event = (files: string[], canvas = 'demo', rootPath = ROOT) => ({ rootPath, canvas, files })

describe('draftReloadAction', () => {
  it('hands the changed files to the canvas page that shows that canvas', () => {
    expect(draftReloadAction(canvasUrl, event(['home.html']))).toEqual({ kind: 'canvas', files: ['home.html'] })
    expect(draftReloadAction(canvasUrl, event(['layout.json', 'tokens.css']))).toEqual({
      kind: 'canvas',
      files: ['layout.json', 'tokens.css'],
    })
  })

  it('does nothing for another canvas, another project, or a page that is not a draft', () => {
    expect(draftReloadAction(canvasUrl, event(['home.html'], 'other'))).toEqual({ kind: 'none' })
    expect(draftReloadAction(canvasUrl, event(['home.html'], 'demo', '/elsewhere'))).toEqual({ kind: 'none' })
    expect(draftReloadAction('http://localhost:3000/', event(['home.html']))).toEqual({ kind: 'none' })
    expect(draftReloadAction(null, event(['home.html']))).toEqual({ kind: 'none' })
    expect(draftReloadAction(canvasUrl, event([]))).toEqual({ kind: 'none' })
  })

  it('reloads a screen open alone only when that screen or its tokens changed', () => {
    const single = draftPageUrl({ kind: 'screen', root: ROOT, canvas: 'demo', screen: 'home', mode: 'single' })
    expect(draftReloadAction(single, event(['home.html']))).toEqual({ kind: 'page' })
    expect(draftReloadAction(single, event(['tokens.css']))).toEqual({ kind: 'page' })
    expect(draftReloadAction(single, event(['cart.html', 'layout.json']))).toEqual({ kind: 'none' })
  })

  it('reloads the tokens or layout file when it is the page shown', () => {
    const tokens = draftPageUrl({ kind: 'asset', root: ROOT, canvas: 'demo', file: 'tokens.css' })
    expect(draftReloadAction(tokens, event(['tokens.css']))).toEqual({ kind: 'page' })
    expect(draftReloadAction(tokens, event(['home.html']))).toEqual({ kind: 'none' })
  })
})

describe('mergeDraftChange', () => {
  it('keeps one entry per canvas with every file named once', () => {
    let pending = mergeDraftChange([], event(['home.html']))
    pending = mergeDraftChange(pending, event(['cart.html', 'home.html']))
    pending = mergeDraftChange(pending, event(['a.html'], 'other'))
    expect(pending).toEqual([event(['home.html', 'cart.html']), event(['a.html'], 'other')])
  })
})

describe('canvasChangedScript', () => {
  it('passes the file names as JSON data, never as code', () => {
    expect(canvasChangedScript(['home.html', '"); alert(1); ("'])).toBe(
      'window.flowCanvas ? window.flowCanvas.changed(["home.html","\\"); alert(1); (\\""]) : null',
    )
  })
})

describe('draftChangeTiming', () => {
  it('applies a change at once only on screen with no navigation in flight', () => {
    expect(draftChangeTiming({ onScreen: true, loading: false })).toBe('now')
  })

  it('holds it off screen, and while the guest is loading — a reload would cancel the navigation', () => {
    expect(draftChangeTiming({ onScreen: true, loading: true })).toBe('hold')
    expect(draftChangeTiming({ onScreen: false, loading: false })).toBe('hold')
    expect(draftChangeTiming({ onScreen: false, loading: true })).toBe('hold')
  })
})
