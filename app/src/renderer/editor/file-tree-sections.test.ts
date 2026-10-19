// Unit tests for the multi-root file-tree section model (multi-project
// threads Phase 3). The single-root cases pin NFR1 — a one-root scope must
// produce NO section chrome, so the sidebar renders exactly today's tree.
import type { ThreadScope, ThreadScopeEntry } from '../../shared/ipc-contract'
import {
  emptyFoldMemory,
  foldMemoryFor,
  sectionsForScope,
  setRootExpanded,
} from './file-tree-sections'

function entry(overrides: Partial<ThreadScopeEntry> & { rootPath: string }): ThreadScopeEntry {
  const name = overrides.rootPath.slice(overrides.rootPath.lastIndexOf('/') + 1)
  return {
    rootId: `id-${name}`,
    name,
    primary: false,
    available: true,
    ...overrides,
  }
}

function scope(roots: ThreadScopeEntry[], threadId: string | null = 'thread-1'): ThreadScope {
  return { threadId, roots }
}

const NONE: ReadonlySet<string> = new Set()

describe('sectionsForScope', () => {
  it('returns no sections for a null scope', () => {
    expect(sectionsForScope(null, NONE)).toEqual([])
  })

  it('returns no sections for an empty scope (empty-hint state)', () => {
    expect(sectionsForScope(scope([], null), NONE)).toEqual([])
  })

  it('single-root scope renders WITHOUT header chrome — the NFR1 regression guard', () => {
    const sections = sectionsForScope(
      scope([entry({ rootPath: '/work/app', primary: true })], null),
      NONE,
    )
    expect(sections).toHaveLength(1)
    expect(sections[0].header).toBe(false)
    expect(sections[0].collapsed).toBe(false)
  })

  it('single-root scope is never folded, whatever the memory says (no chrome → no folding)', () => {
    const sections = sectionsForScope(
      scope([entry({ rootPath: '/work/app', primary: true })]),
      NONE,
    )
    expect(sections[0].header).toBe(false)
    expect(sections[0].collapsed).toBe(false)
  })

  it('single UNAVAILABLE root still renders today’s chrome-free tree', () => {
    const sections = sectionsForScope(
      scope([entry({ rootPath: '/work/app', primary: true, available: false })]),
      NONE,
    )
    expect(sections[0].header).toBe(false)
    expect(sections[0].collapsed).toBe(false)
    expect(sections[0].available).toBe(false)
  })

  it('multi-root scope gives every section a header, in scope order', () => {
    const sections = sectionsForScope(
      scope([
        entry({ rootPath: '/work/app', primary: true }),
        entry({ rootPath: '/work/core' }),
        entry({ rootPath: '/oss/lib' }),
      ]),
      NONE,
    )
    expect(sections.map((s) => s.rootPath)).toEqual(['/work/app', '/work/core', '/oss/lib'])
    expect(sections.every((s) => s.header)).toBe(true)
    expect(sections.map((s) => s.primary)).toEqual([true, false, false])
  })

  it('multi-root scope starts with EVERY project folded, the primary included', () => {
    const sections = sectionsForScope(
      scope([entry({ rootPath: '/work/app', primary: true }), entry({ rootPath: '/work/core' })]),
      NONE,
    )
    expect(sections.map((s) => s.collapsed)).toEqual([true, true])
  })

  it('carries rootId and name through from the scope entries', () => {
    const sections = sectionsForScope(
      scope([
        entry({ rootPath: '/work/app', primary: true, rootId: 'uuid-1' }),
        entry({ rootPath: '/work/core', rootId: '' }),
      ]),
      NONE,
    )
    expect(sections[0]).toMatchObject({ rootId: 'uuid-1', name: 'app' })
    expect(sections[1]).toMatchObject({ rootId: '', name: 'core' })
  })

  it('unfolds exactly the roots the person unfolded in multi-root scopes', () => {
    const sections = sectionsForScope(
      scope([
        entry({ rootPath: '/work/app', primary: true }),
        entry({ rootPath: '/work/core' }),
      ]),
      new Set(['/work/core']),
    )
    expect(sections.map((s) => s.collapsed)).toEqual([true, false])
  })

  it('forces unavailable roots collapsed in multi-root scopes (inert section)', () => {
    const sections = sectionsForScope(
      scope([
        entry({ rootPath: '/work/app', primary: true }),
        entry({ rootPath: '/mnt/gone', available: false }),
      ]),
      new Set(['/work/app', '/mnt/gone']), // even when the person unfolded it
    )
    expect(sections[0].collapsed).toBe(false)
    expect(sections[1].collapsed).toBe(true)
    expect(sections[1].available).toBe(false)
  })
})

describe('fold memory — kept while the thread stays open, forgotten on another', () => {
  const multi = scope([entry({ rootPath: '/work/app', primary: true }), entry({ rootPath: '/work/core' })], 't1')

  it('the person’s unfold survives a re-derive of the same thread', () => {
    let memory = foldMemoryFor(emptyFoldMemory(), 't1')
    memory = setRootExpanded(memory, '/work/core', true)
    memory = foldMemoryFor(memory, 't1') // a scope refresh of the same thread
    expect(sectionsForScope(multi, memory.expanded).map((s) => s.collapsed)).toEqual([true, false])
  })

  it('folding again is remembered too', () => {
    let memory = setRootExpanded(foldMemoryFor(emptyFoldMemory(), 't1'), '/work/core', true)
    memory = setRootExpanded(memory, '/work/core', false)
    expect(sectionsForScope(multi, memory.expanded).every((s) => s.collapsed)).toBe(true)
  })

  it('opening another thread starts folded, and so does coming back', () => {
    let memory = setRootExpanded(foldMemoryFor(emptyFoldMemory(), 't1'), '/work/app', true)
    expect(memory.expanded.has('/work/app')).toBe(true) // the positive first
    memory = foldMemoryFor(memory, 't2')
    expect(memory.expanded.size).toBe(0)
    memory = foldMemoryFor(memory, 't1')
    expect(sectionsForScope(multi, memory.expanded).every((s) => s.collapsed)).toBe(true)
  })

  it('setRootExpanded never mutates the memory it was given', () => {
    const initial = foldMemoryFor(emptyFoldMemory(), 't1')
    const next = setRootExpanded(initial, '/work/app', true)
    expect(initial.expanded.size).toBe(0)
    expect(next.expanded).toEqual(new Set(['/work/app']))
    expect(next.threadId).toBe('t1')
  })
})

describe('sectionsForScope — accent override pass-through', () => {
  it('carries a scope entry accent onto the section model', () => {
    const sections = sectionsForScope(
      scope([entry({ rootPath: '/w/a', primary: true, accent: '#df8c3a' }), entry({ rootPath: '/w/b' })]),
      NONE,
    )
    expect(sections[0].accent).toBe('#df8c3a')
  })

  it('omits the accent key entirely when the entry has no override', () => {
    const sections = sectionsForScope(
      scope([entry({ rootPath: '/w/a', primary: true }), entry({ rootPath: '/w/b' })]),
      NONE,
    )
    expect('accent' in sections[0]).toBe(false)
    expect('accent' in sections[1]).toBe(false)
  })
})

describe('a thread’s own checkout is marked, because its name cannot say so', () => {
  // WHY THIS EXISTS. A thread's checkout is displayed under the PROJECT's name
  // on purpose — its folder is named after the thread id, and a tree headed
  // `b3fe4467-2ffb…` names nothing. That left a reader inside a copy looking at
  // a tree identical to the project's own, and concluding the explorer was
  // showing the wrong files. The fact travels as a flag; the name still cannot.
  it('carries the flag through to the section', () => {
    const [section] = sectionsForScope(
      scope([entry({ rootPath: '/work/.app-threads/uuid', primary: true, threadCopy: true })]),
      NONE,
    )
    expect(section.threadCopy).toBe(true)
  })

  it('omits it entirely for an ordinary project root', () => {
    const [section] = sectionsForScope(
      scope([entry({ rootPath: '/work/app', primary: true })]),
      NONE,
    )
    // Omitted, not false — section models stay shape-stable for existing
    // consumers, exactly as the accent override does.
    expect(section).not.toHaveProperty('threadCopy')
  })

  it('marks only the root that is a copy when several roots are in scope', () => {
    const sections = sectionsForScope(
      scope([
        entry({ rootPath: '/work/.app-threads/uuid', primary: true, threadCopy: true }),
        entry({ rootPath: '/work/other' }),
      ]),
      NONE,
    )
    expect(sections.map((s) => s.threadCopy === true)).toEqual([true, false])
  })
})
