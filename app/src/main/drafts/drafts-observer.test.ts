// DraftsObserver.processChange — a canvas file's change run NOW, through the
// same per-file chain and `processDraftChange` the watcher's settled events
// take: the agent's previous version becomes an undo step, the screen is
// stamped, the canvas is broadcast once; a path outside a canvas does nothing.
// The observer is never started here, so no file watcher runs in this suite.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import type { DraftsChangedEvent } from '../../shared/ui-drafts'
import type { RootsProvider } from '../flow/flow-observer'
import { countDraftUndo, undoDraft } from './draft-store'
import { DraftsObserver } from './drafts-observer'
import { tempProject, testStore, type TempProject } from './draft-test-helpers'

const LAYOUT = JSON.stringify({ name: 'Checkout', tokenSources: [], screens: [{ id: 'cart', title: 'Cart' }] })
const FIRST = '<main data-flow-id="m1"><h1 data-flow-id="t1">First</h1></main>\n'
const SECOND = '<main data-flow-id="m1"><h1 data-flow-id="t1">Second</h1><p>new</p></main>\n'

let project: TempProject
let store: ReturnType<typeof testStore>
let observer: DraftsObserver

const roots = (root: string): RootsProvider =>
  ({ getRoots: () => [{ rootPath: root }], onRootsChanged: () => () => undefined }) as unknown as RootsProvider

beforeEach(() => {
  project = tempProject()
  store = testStore()
  project.write('flow/drafts/checkout/layout.json', LAYOUT)
  observer = new DraftsObserver(roots(project.root), store)
})
afterEach(async () => {
  await observer.dispose()
  project.cleanup()
})

const cart = (): string => join(project.root, 'flow/drafts/checkout/cart.html')

function nextBroadcast(): Promise<DraftsChangedEvent> {
  return new Promise((settle) => {
    const off = observer.on((event) => {
      off()
      settle(event)
    })
  })
}

describe('DraftsObserver.processChange', () => {
  it('runs an agent’s rewrite through the watcher’s processing: snapshot, stamp, broadcast', async () => {
    project.write('flow/drafts/checkout/cart.html', FIRST)
    const first = nextBroadcast()
    expect(await observer.processChange(project.root, cart())).toBe(true)
    expect(await first).toEqual({ rootPath: project.root, canvas: 'checkout', files: ['cart.html'] })
    // A first sight has no previous version: nothing to undo yet.
    expect(await countDraftUndo(store, project.root, 'checkout')).toBe(0)

    project.write('flow/drafts/checkout/cart.html', SECOND)
    expect(await observer.processChange(project.root, cart())).toBe(true)
    const stamped = readFileSync(cart(), 'utf8')
    // The new <p> got an id; every other byte is the agent's.
    expect(stamped).toMatch(/^<main data-flow-id="m1"><h1 data-flow-id="t1">Second<\/h1><p data-flow-id="[a-z0-9]{6}">new<\/p><\/main>\n$/)
    // The previous version is one undo step, and undo restores it exactly.
    expect(await countDraftUndo(store, project.root, 'checkout')).toBe(1)
    await undoDraft(store, { root: project.root, canvas: 'checkout', file: 'cart.html' })
    expect(readFileSync(cart(), 'utf8')).toBe(FIRST)
  })

  it('is a no-op the second time for the same content — what a late watcher event meets', async () => {
    project.write('flow/drafts/checkout/cart.html', FIRST)
    expect(await observer.processChange(project.root, cart())).toBe(true)
    expect(await observer.processChange(project.root, cart())).toBe(false)
    expect(await countDraftUndo(store, project.root, 'checkout')).toBe(0)
  })

  it('does nothing for a path that is not a canvas file', async () => {
    const outside = project.write('flow/drafts/checkout/.history/x.html', FIRST)
    let broadcasts = 0
    observer.on(() => {
      broadcasts += 1
    })
    // The positive first: a canvas file IS processed by the same call.
    project.write('flow/drafts/checkout/cart.html', FIRST)
    expect(await observer.processChange(project.root, cart())).toBe(true)
    expect(await observer.processChange(project.root, outside)).toBe(false)
    expect(await observer.processChange(project.root, join(project.root, 'src/app.html'))).toBe(false)
    expect(existsSync(join(project.root, 'flow/drafts/checkout/.history/x.html'))).toBe(true)
    await new Promise((settle) => setTimeout(settle, 300))
    expect(broadcasts).toBe(1)
  })
})
