// In-place edits: one element patched by its stamped id, the rest of the file
// byte for byte, an undo snapshot first, and nothing written on a refusal.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import {
  applyDraftEdit,
  ELEMENT_GONE,
  patchDraftHtml,
  setStyleProperty,
  TEXT_NOT_PATCHABLE,
  type DraftEditDeps,
} from './draft-edit'
import { tempProject, testStore, type TempProject } from './draft-test-helpers'

const SCREEN = `<main data-flow-id="m1">
  <h1 data-flow-id="t1" class="title">
    Your cart
  </h1>
  <p data-flow-id="p1">Total <strong data-flow-id="s1">€ 12</strong></p>
  <p data-flow-id="p2"><span data-flow-id="a">x</span> and <span data-flow-id="b">y</span> or z</p>
  <div data-flow-id="d1"><span data-flow-id="d2">only child text</span></div>
  <button data-flow-id="b1" style="color: red;padding:4px" type=submit>Pay</button>
  <a data-flow-id="l1" style=color:blue href="#">Back</a>
  <img data-flow-id="i1" src="data:,">
</main>
`

describe('patchDraftHtml', () => {
  it('replaces only the direct text of an element, keeping its whitespace', () => {
    const result = patchDraftHtml(SCREEN, { id: 't1', kind: 'text', text: 'Your bag' })
    expect(result).toEqual({ ok: true, html: SCREEN.replace('Your cart', 'Your bag') })
  })

  it('escapes the new text so it can never become markup', () => {
    const result = patchDraftHtml(SCREEN, { id: 's1', kind: 'text', text: '<b>&</b>' })
    expect(result.ok && result.html).toBe(SCREEN.replace('€ 12', '&lt;b&gt;&amp;&lt;/b&gt;'))
  })

  it('patches the one text run beside child elements', () => {
    const result = patchDraftHtml(SCREEN, { id: 'p1', kind: 'text', text: 'Sum' })
    expect(result.ok && result.html).toBe(SCREEN.replace('Total <strong', 'Sum <strong'))
  })

  it('refuses text that lives in the children or in several runs', () => {
    expect(patchDraftHtml(SCREEN, { id: 'd1', kind: 'text', text: 'x' })).toEqual({ ok: false, reason: TEXT_NOT_PATCHABLE })
    expect(patchDraftHtml(SCREEN, { id: 'p2', kind: 'text', text: 'x' })).toEqual({ ok: false, reason: TEXT_NOT_PATCHABLE })
  })

  it('refuses a void element', () => {
    expect(patchDraftHtml(SCREEN, { id: 'i1', kind: 'text', text: 'x' }).ok).toBe(false)
  })

  it('sets one style property: replaced in place, appended, or a new style attribute', () => {
    const replaced = patchDraftHtml(SCREEN, { id: 'b1', kind: 'colour', property: 'color', value: '#00ff00' })
    expect(replaced.ok && replaced.html).toBe(SCREEN.replace('style="color: red;padding:4px"', 'style="color: #00ff00;padding:4px"'))
    const appended = patchDraftHtml(SCREEN, { id: 'b1', kind: 'spacing', property: 'margin-top', value: '8px' })
    expect(appended.ok && appended.html).toBe(
      SCREEN.replace('style="color: red;padding:4px"', 'style="color: red;padding:4px; margin-top: 8px"'),
    )
    const fresh = patchDraftHtml(SCREEN, { id: 'p1', kind: 'colour', property: 'background-color', value: 'white' })
    expect(fresh.ok && fresh.html).toBe(SCREEN.replace('<p data-flow-id="p1">', '<p data-flow-id="p1" style="background-color: white">'))
    const unquoted = patchDraftHtml(SCREEN, { id: 'l1', kind: 'spacing', property: 'padding', value: '0' })
    expect(unquoted.ok && unquoted.html).toBe(SCREEN.replace('style=color:blue', 'style="color:blue; padding: 0"'))
  })

  it('refuses a missing id with the sentence', () => {
    expect(patchDraftHtml(SCREEN, { id: 'gone', kind: 'text', text: 'x' })).toEqual({ ok: false, reason: ELEMENT_GONE })
    expect(ELEMENT_GONE).toBe('This element is no longer on the screen, so the change was not saved.')
  })
})

describe('setStyleProperty', () => {
  it('keeps other declarations, including ones with semicolons inside quotes or parentheses', () => {
    expect(setStyleProperty('background: url("a;b"); color: red', 'color', 'blue')).toBe('background: url("a;b"); color: blue')
    expect(setStyleProperty('color:red;color:green', 'color', 'blue')).toBe('color:blue')
    expect(setStyleProperty('', 'gap', '4px')).toBe('gap: 4px')
    expect(setStyleProperty('gap: 2px;', 'padding', '0')).toBe('gap: 2px; padding: 0')
  })
})

describe('applyDraftEdit', () => {
  let project: TempProject
  let screenPath: string
  let deps: DraftEditDeps & { clock: { at: number } }

  beforeEach(() => {
    project = tempProject()
    screenPath = project.write('flow/drafts/checkout/cart.html', SCREEN)
    deps = { ...testStore(), isKnownRoot: (root) => root === project.root }
  })
  afterEach(() => project.cleanup())

  const historyDir = (): string => join(project.root, 'flow/drafts/checkout/.history/cart')

  it('writes the patch, snapshots the previous file and records the write as Flow’s own', async () => {
    const answer = await applyDraftEdit(deps, {
      root: project.root,
      canvas: 'checkout',
      screen: 'cart',
      edit: { id: 't1', kind: 'text', text: 'Your bag' },
    })
    expect(answer).toEqual({ ok: true })
    const written = readFileSync(screenPath, 'utf8')
    expect(written).toBe(SCREEN.replace('Your cart', 'Your bag'))
    const snapshots = readdirSync(historyDir())
    expect(snapshots).toHaveLength(1)
    expect(readFileSync(join(historyDir(), snapshots[0]), 'utf8')).toBe(SCREEN)
    // No temp file left behind.
    expect(readdirSync(join(project.root, 'flow/drafts/checkout')).filter((name) => name.endsWith('.tmp'))).toEqual([])
    // The observer would recognise it as ours, once.
    expect(deps.ledger.claim(screenPath, written)).toBe(true)
    expect(deps.ledger.claim(screenPath, written)).toBe(false)
  })

  it('refuses a missing id and writes nothing — not the screen, not a snapshot', async () => {
    const answer = await applyDraftEdit(deps, {
      root: project.root,
      canvas: 'checkout',
      screen: 'cart',
      edit: { id: 'gone', kind: 'colour', property: 'color', value: 'red' },
    })
    expect(answer).toEqual({ ok: false, reason: ELEMENT_GONE })
    expect(readFileSync(screenPath, 'utf8')).toBe(SCREEN)
    expect(existsSync(historyDir())).toBe(false)
  })

  it('refuses an invalid value, an unknown root, a bad screen name and a missing screen, writing nothing', async () => {
    const base = { root: project.root, canvas: 'checkout', screen: 'cart' }
    const bad = { id: 'b1', kind: 'colour', property: 'color', value: 'red;x:y' } as never
    expect((await applyDraftEdit(deps, { ...base, edit: bad })).ok).toBe(false)
    expect((await applyDraftEdit(deps, { ...base, root: '/elsewhere', edit: { id: 't1', kind: 'text', text: 'x' } })).ok).toBe(false)
    expect((await applyDraftEdit(deps, { ...base, screen: '../cart', edit: { id: 't1', kind: 'text', text: 'x' } })).ok).toBe(false)
    expect((await applyDraftEdit(deps, { ...base, screen: 'nope', edit: { id: 't1', kind: 'text', text: 'x' } })).ok).toBe(false)
    expect(readFileSync(screenPath, 'utf8')).toBe(SCREEN)
    expect(existsSync(historyDir())).toBe(false)
  })
})
