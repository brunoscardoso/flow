// Undo, history pruning, named versions, the canvas list and the observer's
// processing step — on a temp project, never a real one.
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import { DRAFT_HISTORY_LIMIT } from '../../shared/ui-drafts'
import { applyDraftEdit } from './draft-edit'
import {
  listDraftCanvases,
  listDraftVersions,
  NOTHING_TO_UNDO,
  readDraftLayout,
  restoreDraftVersion,
  saveDraftVersion,
  snapshotDraft,
  undoDraft,
  undoDraftCanvas,
  countDraftUndo,
  NOTHING_TO_UNDO_CANVAS,
} from './draft-store'
import { draftFileOf, isOutsideDrafts, processDraftChange, type DraftContentCache } from './drafts-observer'
import { tempProject, testStore, type TempProject } from './draft-test-helpers'

const LAYOUT = JSON.stringify({ name: 'Checkout', tokenSources: ['src/theme.css'], screens: [{ id: 'cart', title: 'Cart' }] })
const CART = '<main data-flow-id="m1"><h1 data-flow-id="t1">Cart</h1></main>\n'
const TOKENS = ':root { --brand: #333; }\n'

let project: TempProject
let store: ReturnType<typeof testStore>

beforeEach(() => {
  project = tempProject()
  store = testStore()
  project.write('flow/drafts/checkout/layout.json', LAYOUT)
  project.write('flow/drafts/checkout/tokens.css', TOKENS)
  project.write('flow/drafts/checkout/cart.html', CART)
})
afterEach(() => project.cleanup())

const read = (rel: string): string => readFileSync(join(project.root, rel), 'utf8')
const edit = (text: string): Promise<unknown> =>
  applyDraftEdit(
    { ...store, isKnownRoot: () => true },
    { root: project.root, canvas: 'checkout', screen: 'cart', edit: { id: 't1', kind: 'text', text } },
  )

describe('undo', () => {
  it('walks back one edit at a time, removing each snapshot it restores', async () => {
    await edit('One')
    await edit('Two')
    expect(read('flow/drafts/checkout/cart.html')).toContain('>Two<')
    expect(await undoDraft(store, { root: project.root, canvas: 'checkout', file: 'cart.html' })).toEqual({ ok: true })
    expect(read('flow/drafts/checkout/cart.html')).toContain('>One<')
    expect(await undoDraft(store, { root: project.root, canvas: 'checkout', file: 'cart.html' })).toEqual({ ok: true })
    expect(read('flow/drafts/checkout/cart.html')).toBe(CART)
    expect(await undoDraft(store, { root: project.root, canvas: 'checkout', file: 'cart.html' })).toEqual({
      ok: false,
      reason: NOTHING_TO_UNDO,
    })
  })

  it('refuses a file outside the path rule', async () => {
    expect((await undoDraft(store, { root: project.root, canvas: 'checkout', file: '../x.html' })).ok).toBe(false)
  })
})

describe('undo for the whole canvas', () => {
  const canvasUndo = (): ReturnType<typeof undoDraftCanvas> => undoDraftCanvas(store, { root: project.root, canvas: 'checkout' })
  const count = (): Promise<number> => countDraftUndo(store, project.root, 'checkout')
  const agentRewrites = async (file: string, previous: string, next: string): Promise<void> => {
    // What the observer does when the agent rewrites a file: the previous version becomes a step.
    await snapshotDraft(store, { root: project.root, canvas: 'checkout', file, previous })
    project.write(`flow/drafts/checkout/${file}`, next)
  }

  it('steps back the newest change across screens, layout and tokens, the agent’s or the person’s', async () => {
    expect(await count()).toBe(0)
    expect(await canvasUndo()).toEqual({ ok: false, reason: NOTHING_TO_UNDO_CANVAS })
    await agentRewrites('tokens.css', TOKENS, ':root { --brand: red; }\n')
    await edit('Mine')
    expect(await count()).toBe(2)
    // The newest step first: the person's edit, then the agent's tokens.
    expect(await canvasUndo()).toEqual({ ok: true, files: ['cart.html'] })
    expect(read('flow/drafts/checkout/cart.html')).toBe(CART)
    expect(read('flow/drafts/checkout/tokens.css')).toContain('red')
    expect(await count()).toBe(1)
    expect(await canvasUndo()).toEqual({ ok: true, files: ['tokens.css'] })
    expect(read('flow/drafts/checkout/tokens.css')).toBe(TOKENS)
    expect(await count()).toBe(0)
  })

  it('puts a whole version restore back in one step', async () => {
    await saveDraftVersion(store, { root: project.root, canvas: 'checkout', name: 'v1' })
    await edit('Changed')
    project.write('flow/drafts/checkout/tokens.css', ':root { --brand: red; }\n')
    await restoreDraftVersion(store, { root: project.root, canvas: 'checkout', version: 'v1' })
    const before = await count()
    expect(await canvasUndo()).toEqual({ ok: true, files: ['cart.html', 'tokens.css'] })
    expect(read('flow/drafts/checkout/cart.html')).toContain('>Changed<')
    expect(read('flow/drafts/checkout/tokens.css')).toContain('red')
    expect(await count()).toBe(before - 1)
  })

  it('reports no files for a restore that changes nothing', async () => {
    await saveDraftVersion(store, { root: project.root, canvas: 'checkout', name: 'v1' })
    expect(await restoreDraftVersion(store, { root: project.root, canvas: 'checkout', version: 'v1' })).toEqual({ ok: true, files: [] })
  })

  it('refuses a canvas that is not there', async () => {
    expect((await undoDraftCanvas(store, { root: project.root, canvas: 'nope' })).ok).toBe(false)
    expect(await countDraftUndo(store, project.root, 'nope')).toBe(0)
  })
})

describe('history pruning', () => {
  it(`keeps the newest ${DRAFT_HISTORY_LIMIT} snapshots per screen`, async () => {
    for (let index = 0; index < DRAFT_HISTORY_LIMIT + 5; index += 1) {
      await snapshotDraft(store, { root: project.root, canvas: 'checkout', file: 'cart.html', previous: `v${index}` })
    }
    const dir = join(project.root, 'flow/drafts/checkout/.history/cart')
    const names = readdirSync(dir).sort()
    expect(names).toHaveLength(DRAFT_HISTORY_LIMIT)
    expect(readFileSync(join(dir, names[0]), 'utf8')).toBe('v5')
    expect(readFileSync(join(dir, names[names.length - 1]), 'utf8')).toBe(`v${DRAFT_HISTORY_LIMIT + 4}`)
  })

  it('keeps two snapshots taken in the same millisecond apart and in order', async () => {
    const frozen = { ...store, now: () => 1 }
    await snapshotDraft(frozen, { root: project.root, canvas: 'checkout', file: 'cart.html', previous: 'a' })
    await snapshotDraft(frozen, { root: project.root, canvas: 'checkout', file: 'cart.html', previous: 'b' })
    const dir = join(project.root, 'flow/drafts/checkout/.history/cart')
    const names = readdirSync(dir).sort()
    expect(names.map((name) => readFileSync(join(dir, name), 'utf8'))).toEqual(['a', 'b'])
  })
})

describe('named versions', () => {
  it('saves a copy of the canvas with its own version.json, and lists it', async () => {
    const saved = await saveDraftVersion(store, { root: project.root, canvas: 'checkout', name: 'First pass' })
    expect(saved).toMatchObject({ ok: true, version: { version: 'first-pass', name: 'First pass' } })
    const dir = 'flow/drafts/checkout/versions/first-pass'
    expect(read(`${dir}/cart.html`)).toBe(CART)
    expect(read(`${dir}/tokens.css`)).toBe(TOKENS)
    expect(read(`${dir}/layout.json`)).toBe(LAYOUT)
    expect(JSON.parse(read(`${dir}/version.json`))).toMatchObject({ name: 'First pass', files: ['cart.html', 'layout.json', 'tokens.css'] })
    expect(readdirSync(join(project.root, 'flow/drafts/checkout/versions'))).toEqual(['first-pass'])
    expect(await listDraftVersions(store.fs, project.root, 'checkout')).toEqual([
      expect.objectContaining({ version: 'first-pass', name: 'First pass' }),
    ])
  })

  it('refuses a duplicate name and a name with nothing usable in it', async () => {
    await saveDraftVersion(store, { root: project.root, canvas: 'checkout', name: 'v1' })
    expect((await saveDraftVersion(store, { root: project.root, canvas: 'checkout', name: 'V1' })).ok).toBe(false)
    expect((await saveDraftVersion(store, { root: project.root, canvas: 'checkout', name: '!!!' })).ok).toBe(false)
    expect((await saveDraftVersion(store, { root: project.root, canvas: 'nope', name: 'x' })).ok).toBe(false)
  })

  it('restores a version over the canvas, and each restored file can be undone', async () => {
    await saveDraftVersion(store, { root: project.root, canvas: 'checkout', name: 'v1' })
    await edit('Changed')
    project.write('flow/drafts/checkout/tokens.css', ':root { --brand: red; }\n')
    expect(await restoreDraftVersion(store, { root: project.root, canvas: 'checkout', version: 'v1' })).toEqual({ ok: true, files: ['cart.html', 'tokens.css'] })
    expect(read('flow/drafts/checkout/cart.html')).toBe(CART)
    expect(read('flow/drafts/checkout/tokens.css')).toBe(TOKENS)
    // The restore snapshotted what it replaced.
    await undoDraft(store, { root: project.root, canvas: 'checkout', file: 'cart.html' })
    expect(read('flow/drafts/checkout/cart.html')).toContain('>Changed<')
    await undoDraft(store, { root: project.root, canvas: 'checkout', file: 'tokens.css' })
    expect(read('flow/drafts/checkout/tokens.css')).toContain('red')
  })

  it('refuses a version that does not exist or is not a slug', async () => {
    expect((await restoreDraftVersion(store, { root: project.root, canvas: 'checkout', version: 'nope' })).ok).toBe(false)
    expect((await restoreDraftVersion(store, { root: project.root, canvas: 'checkout', version: '../x' })).ok).toBe(false)
  })
})

describe('reading', () => {
  it('lists canvases with their layout name, and names a layout it cannot read', async () => {
    project.write('flow/drafts/broken/layout.json', '{nope')
    project.write('flow/drafts/Not-A-Slug/layout.json', LAYOUT)
    expect(await listDraftCanvases(store.fs, project.root)).toEqual([
      { canvas: 'broken', name: 'broken', screenCount: 0, problem: 'The layout is not valid JSON.' },
      { canvas: 'checkout', name: 'Checkout', screenCount: 1, screensWritten: 1, updatedAt: expect.any(Number) },
    ])
    expect(await listDraftCanvases(store.fs, join(project.root, 'missing'))).toEqual([])
  })

  it('reads a layout through the path rule', async () => {
    expect(await readDraftLayout(store.fs.readFile, project.root, 'checkout')).toMatchObject({ ok: true })
    expect((await readDraftLayout(store.fs.readFile, project.root, '..')).ok).toBe(false)
  })
})

describe('the observer’s processing step', () => {
  const cartPath = (): string => join(project.root, 'flow/drafts/checkout/cart.html')
  const change = () => ({ root: project.root, canvas: 'checkout', file: 'cart.html', absPath: cartPath() })

  it('stamps an agent’s new screen as Flow’s own write, then ignores that write', async () => {
    const cache: DraftContentCache = new Map()
    project.write('flow/drafts/checkout/cart.html', '<main><h1>New</h1></main>\n')
    expect(await processDraftChange({ ...store, cache }, change())).toBe(true)
    const stamped = read('flow/drafts/checkout/cart.html')
    expect(stamped).toMatch(/^<main data-flow-id="[a-z0-9]{6}"><h1 data-flow-id="[a-z0-9]{6}">New<\/h1><\/main>\n$/)
    // A new file had no previous version: no snapshot.
    expect(existsSync(join(project.root, 'flow/drafts/checkout/.history'))).toBe(false)
    // The watcher then reports the stamp write: Flow's own, not broadcast, not re-stamped.
    expect(await processDraftChange({ ...store, cache }, change())).toBe(false)
    expect(read('flow/drafts/checkout/cart.html')).toBe(stamped)
  })

  it('keeps the agent’s previous version as an undo step', async () => {
    const cache: DraftContentCache = new Map([[cartPath(), CART]])
    project.write('flow/drafts/checkout/cart.html', '<main data-flow-id="m1"><h1 data-flow-id="t1">Rewritten</h1></main>\n')
    expect(await processDraftChange({ ...store, cache }, change())).toBe(true)
    await undoDraft(store, { root: project.root, canvas: 'checkout', file: 'cart.html' })
    expect(read('flow/drafts/checkout/cart.html')).toBe(CART)
  })

  it('does not broadcast Flow’s own edit, nor content it has already seen', async () => {
    const cache: DraftContentCache = new Map([[cartPath(), CART]])
    await edit('Mine')
    expect(await processDraftChange({ ...store, cache }, change())).toBe(false)
    expect(await processDraftChange({ ...store, cache }, change())).toBe(false)
  })

  it('watches only known files directly inside a canvas folder', () => {
    const root = project.root
    expect(draftFileOf(root, join(root, 'flow/drafts/checkout/cart.html'))).toEqual({ canvas: 'checkout', file: 'cart.html' })
    expect(draftFileOf(root, join(root, 'flow/drafts/checkout/.history/cart/1.html'))).toBeNull()
    expect(draftFileOf(root, join(root, 'flow/drafts/checkout/cart.html.1.x.tmp'))).toBeNull()
    expect(isOutsideDrafts(root, join(root, 'flow'))).toBe(false)
    expect(isOutsideDrafts(root, join(root, 'flow/drafts/checkout'))).toBe(false)
    expect(isOutsideDrafts(root, join(root, 'flow/drafts/checkout/.history'))).toBe(true)
    expect(isOutsideDrafts(root, join(root, 'flow/drafts/checkout/versions'))).toBe(true)
    expect(isOutsideDrafts(root, join(root, 'flow/plans'))).toBe(true)
    expect(isOutsideDrafts(root, join(root, 'node_modules'))).toBe(true)
  })
})
