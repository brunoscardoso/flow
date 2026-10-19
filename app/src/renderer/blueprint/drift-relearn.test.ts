import { driftRelearnPath } from './drift-relearn'

// #1156: every drift row offered [re-learn], and every drift row is file-backed
// (integration / endpoint / datastore), so 100% of them forwarded a node id as
// a module PATH — spending a real agent pass on a directory that doesn't exist
// and writing a phantom module into the learning store.

const GRAPH = [
  { id: 'module:src', kind: 'module', sourceFile: 'src' },
  { id: 'module:src/api', kind: 'module', sourceFile: 'src/api' },
  { id: 'module:src/core', kind: 'module', sourceFile: 'src/core' },
  { id: 'integration:api.stripe.com', kind: 'integration', sourceFile: 'src/api/client.ts' },
]

describe('driftRelearnPath (#1156)', () => {
  it('re-learns the module that OWNS the changed file, not the node id', () => {
    // The reported case: this used to enqueue "integration:api.stripe.com".
    expect(driftRelearnPath('integration:api.stripe.com', ['src/api/client.ts'], GRAPH)).toBe(
      'src/api',
    )
  })

  it('picks the deepest owning module', () => {
    expect(driftRelearnPath('endpoint:GET /x', ['src/core/engine.ts'], GRAPH)).toBe('src/core')
  })

  it('leaves a module row targeting itself', () => {
    expect(driftRelearnPath('module:src/core', ['src/core/engine.ts'], GRAPH)).toBe('src/core')
  })

  it('withholds the action when no module owns the file', () => {
    // No honest target — better no button than a learn pass on a phantom.
    expect(driftRelearnPath('integration:cdn', ['vendor/thing.js'], GRAPH)).toBeNull()
  })

  it('withholds the action when the row names no file', () => {
    expect(driftRelearnPath('integration:cdn', [], GRAPH)).toBeNull()
  })

  it('never targets a ghost module', () => {
    const ghosts = [{ id: 'module:src', kind: 'module', sourceFile: 'src', ghost: true }]
    expect(driftRelearnPath('integration:x', ['src/a.ts'], ghosts)).toBeNull()
  })

  it('does not mistake a name-prefixed sibling for a container', () => {
    expect(driftRelearnPath('integration:x', ['src/core-utils/x.ts'], GRAPH)).toBe('src')
  })
})
