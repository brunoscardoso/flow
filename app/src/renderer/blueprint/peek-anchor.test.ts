// Anchor → peek-file resolution — pure logic, no DOM (node env).

import type { BlueprintAnchor } from '../../shared/ipc-contract'
import { anchorPeekPath, firstAnchorPeekPath } from './peek-anchor'

describe('anchorPeekPath', () => {
  it('resolves a file-kind anchor to its ref', () => {
    expect(anchorPeekPath({ kind: 'file', ref: 'app/src/main/index.ts' })).toBe('app/src/main/index.ts')
  })

  it('resolves a symbol-kind anchor with a file scope to that file', () => {
    const anchor: BlueprintAnchor = { kind: 'symbol', ref: 'RunManager', file: 'app/src/main/agents/run-manager.ts' }
    expect(anchorPeekPath(anchor)).toBe('app/src/main/agents/run-manager.ts')
  })

  it('returns null for a symbol-kind anchor with no file scope', () => {
    expect(anchorPeekPath({ kind: 'symbol', ref: 'RunManager' })).toBeNull()
  })

  it('returns null for table/endpoint/module anchor kinds', () => {
    expect(anchorPeekPath({ kind: 'table', ref: 'users' })).toBeNull()
    expect(anchorPeekPath({ kind: 'endpoint', ref: 'derive' })).toBeNull()
    expect(anchorPeekPath({ kind: 'module', ref: 'app/src/main' })).toBeNull()
  })
})

describe('firstAnchorPeekPath', () => {
  it('returns null for an empty anchor list', () => {
    expect(firstAnchorPeekPath([])).toBeNull()
  })

  it('skips non-peekable anchors and returns the first peekable one', () => {
    const anchors: BlueprintAnchor[] = [
      { kind: 'module', ref: 'app/src/main' },
      { kind: 'symbol', ref: 'foo' },
      { kind: 'file', ref: 'app/src/main/a.ts' },
      { kind: 'file', ref: 'app/src/main/b.ts' },
    ]
    expect(firstAnchorPeekPath(anchors)).toBe('app/src/main/a.ts')
  })

  it('returns null when nothing in the list is peekable', () => {
    const anchors: BlueprintAnchor[] = [{ kind: 'module', ref: 'x' }, { kind: 'table', ref: 'y' }]
    expect(firstAnchorPeekPath(anchors)).toBeNull()
  })
})
