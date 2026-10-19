import { buildDriftOwnerIndex, driftOwnerNodeId } from './drift-owner'

// #1155: module nodes own a DIRECTORY, so exact-match attribution dropped
// ~99% of source drift silently. These pin the roll-up.

const NODES = [
  { id: 'module:src', sourceFile: 'src' },
  { id: 'module:src/api', sourceFile: 'src/api' },
  { id: 'module:src/core', sourceFile: 'src/core' },
  { id: 'integration:api.stripe.com', sourceFile: 'src/api/client.ts' },
]

describe('driftOwnerNodeId (#1155)', () => {
  const index = buildDriftOwnerIndex(NODES)

  it('attributes an ordinary module file to its owning module', () => {
    // The exact case from the issue: this produced NO nodeId at all before.
    expect(driftOwnerNodeId('src/core/engine.ts', index)).toBe('module:src/core')
  })

  it('picks the DEEPEST owning module, not the shallowest', () => {
    // src/api/handlers/webhook.ts belongs to src/api, never to src.
    expect(driftOwnerNodeId('src/api/handlers/webhook.ts', index)).toBe('module:src/api')
  })

  it('keeps the exact match winning, so node-owned files are unchanged', () => {
    // The control the issue measured as already working: an integration file
    // attributes to its own node, not to the module directory containing it.
    expect(driftOwnerNodeId('src/api/client.ts', index)).toBe('integration:api.stripe.com')
  })

  it('attributes a file directly under a module dir', () => {
    expect(driftOwnerNodeId('src/index.ts', index)).toBe('module:src')
  })

  it('returns undefined for a path no node owns', () => {
    expect(driftOwnerNodeId('docs/readme.md', index)).toBeUndefined()
  })

  it('does not treat a sibling with a shared prefix as contained', () => {
    // `src/core-utils/x.ts` must NOT roll up to `src/core` — only to `src`.
    expect(driftOwnerNodeId('src/core-utils/x.ts', index)).toBe('module:src')
  })

  it('is separator- and trailing-slash-insensitive', () => {
    const win = buildDriftOwnerIndex([{ id: 'module:src/core', sourceFile: 'src\\core\\' }])
    expect(driftOwnerNodeId('src\\core\\engine.ts', win)).toBe('module:src/core')
    expect(driftOwnerNodeId('src/core/engine.ts', win)).toBe('module:src/core')
  })

  it('ignores nodes with no sourceFile, and never lets an empty path own everything', () => {
    const sparse = buildDriftOwnerIndex([
      { id: 'concept:auth' },
      { id: 'module:root', sourceFile: '' },
      { id: 'module:src', sourceFile: 'src' },
    ])
    expect(driftOwnerNodeId('anything.ts', sparse)).toBeUndefined()
    expect(driftOwnerNodeId('src/a.ts', sparse)).toBe('module:src')
  })

  it('keeps first-in-graph-order wins for duplicate sourceFiles', () => {
    const dup = buildDriftOwnerIndex([
      { id: 'module:first', sourceFile: 'src' },
      { id: 'module:second', sourceFile: 'src' },
    ])
    expect(driftOwnerNodeId('src', dup)).toBe('module:first')
    expect(driftOwnerNodeId('src/a.ts', dup)).toBe('module:first')
  })
})
