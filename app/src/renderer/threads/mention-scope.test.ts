// Cross-root @-mention scope model tests (multi-project threads, phase 6):
// which roots the search iterates, how results merge/rank across roots, and
// what an accepted mention inserts. Single-root scope must behave exactly as
// today (byte-identical composer behavior).

import type { DirectoryEntry, ThreadScope } from '../../shared/ipc-contract'
import {
  mentionInsertionPath,
  mentionListRequests,
  mentionRoots,
  mergeMentionMatches,
  rootRelative,
  type MentionRoot,
} from './mention-scope'

const PRIMARY: MentionRoot = { rootPath: '/work/app', name: 'app', primary: true }
const SECONDARY: MentionRoot = { rootPath: '/work/lib', name: 'lib', primary: false }

function scope(threadId: string, roots: Partial<ThreadScope['roots'][number]>[]): ThreadScope {
  return {
    threadId,
    roots: roots.map((root, index) => ({
      rootId: `r${index}`,
      rootPath: '/work/app',
      name: 'app',
      primary: index === 0,
      available: true,
      ...root,
    })),
  }
}

function entry(name: string, type: 'file' | 'directory', root: MentionRoot): DirectoryEntry {
  return { name, type, path: `${root.rootPath}/${name}` }
}

describe('mentionRoots', () => {
  it('degrades to the thread primary when the scope is null (fail-soft)', () => {
    expect(mentionRoots(null, 't1', '/work/app')).toEqual([
      { rootPath: '/work/app', name: '', primary: true },
    ])
  })

  it('degrades to the thread primary when the scope describes another thread', () => {
    const other = scope('t2', [{ rootPath: '/work/app' }])
    expect(mentionRoots(other, 't1', '/work/app')).toEqual([
      { rootPath: '/work/app', name: '', primary: true },
    ])
  })

  it('returns the scope roots for the matching thread, skipping unavailable ones', () => {
    const threadScope = scope('t1', [
      { rootPath: '/work/app', name: 'app' },
      { rootPath: '/work/lib', name: 'lib', primary: false },
      { rootPath: '/gone', name: 'gone', primary: false, available: false },
    ])
    expect(mentionRoots(threadScope, 't1', '/work/app')).toEqual([
      { rootPath: '/work/app', name: 'app', primary: true },
      { rootPath: '/work/lib', name: 'lib', primary: false },
    ])
  })

  it('degrades to the thread primary when every scope root is unavailable', () => {
    const threadScope = scope('t1', [{ rootPath: '/gone', name: 'gone', available: false }])
    expect(mentionRoots(threadScope, 't1', '/work/app')).toEqual([
      { rootPath: '/work/app', name: '', primary: true },
    ])
  })
})

describe('mentionListRequests', () => {
  it('single root + relative dirPath → exactly today’s one request', () => {
    expect(mentionListRequests('src', [PRIMARY])).toEqual([{ root: PRIMARY, dirPath: 'src' }])
    expect(mentionListRequests('', [PRIMARY])).toEqual([{ root: PRIMARY, dirPath: '' }])
  })

  it('multi-root + relative dirPath → one request per root', () => {
    expect(mentionListRequests('src', [PRIMARY, SECONDARY])).toEqual([
      { root: PRIMARY, dirPath: 'src' },
      { root: SECONDARY, dirPath: 'src' },
    ])
  })

  it('absolute dirPath resolves into the owning root (cross-root descent)', () => {
    expect(mentionListRequests('/work/lib/src', [PRIMARY, SECONDARY])).toEqual([
      { root: SECONDARY, dirPath: 'src' },
    ])
    // The root itself → list its top level.
    expect(mentionListRequests('/work/lib', [PRIMARY, SECONDARY])).toEqual([
      { root: SECONDARY, dirPath: '' },
    ])
  })

  it('absolute dirPath outside every root → no requests (popup closes)', () => {
    expect(mentionListRequests('/elsewhere/src', [PRIMARY, SECONDARY])).toEqual([])
  })

  it('a prefix-sibling path does not match a root (lexical boundary)', () => {
    expect(mentionListRequests('/work/lib-evil', [PRIMARY, SECONDARY])).toEqual([])
  })
})

describe('mergeMentionMatches', () => {
  it('single root ranks exactly as today: prefix, directories, then name', () => {
    const entries = [
      entry('zeta.ts', 'file', PRIMARY),
      entry('src', 'directory', PRIMARY),
      entry('setup.ts', 'file', PRIMARY),
      entry('assets', 'directory', PRIMARY),
    ]
    const merged = mergeMentionMatches([{ root: PRIMARY, entries }], 's', 10)
    expect(merged.map((item) => item.entry.name)).toEqual([
      'src', // prefix + directory
      'setup.ts', // prefix + file
      'assets', // non-prefix directory
      'zeta.ts', // non-prefix file
    ])
  })

  it('merges across roots and tie-breaks equal names by scope order (primary first)', () => {
    const merged = mergeMentionMatches(
      [
        { root: PRIMARY, entries: [entry('index.ts', 'file', PRIMARY)] },
        { root: SECONDARY, entries: [entry('index.ts', 'file', SECONDARY)] },
      ],
      'i',
      10,
    )
    expect(merged.map((item) => item.root.rootPath)).toEqual([
      PRIMARY.rootPath,
      SECONDARY.rootPath,
    ])
  })

  it('filters by needle and caps the result count', () => {
    const entries = ['aa.ts', 'ab.ts', 'ac.ts', 'zz.ts'].map((name) =>
      entry(name, 'file' as const, PRIMARY),
    )
    const merged = mergeMentionMatches([{ root: PRIMARY, entries }], 'a', 2)
    expect(merged.map((item) => item.entry.name)).toEqual(['aa.ts', 'ab.ts'])
  })
})

describe('mentionInsertionPath', () => {
  it('primary-root entries keep today’s root-relative form', () => {
    const item = { entry: entry('src/index.ts', 'file' as const, PRIMARY), root: PRIMARY }
    expect(mentionInsertionPath(item, PRIMARY.rootPath)).toBe('src/index.ts')
  })

  it('cross-root entries insert the absolute path', () => {
    const item = { entry: entry('src/index.ts', 'file' as const, SECONDARY), root: SECONDARY }
    expect(mentionInsertionPath(item, PRIMARY.rootPath)).toBe('/work/lib/src/index.ts')
  })
})

describe('rootRelative', () => {
  it('strips the root prefix for nested paths, leaves others unchanged', () => {
    expect(rootRelative('/work/app', '/work/app/src/x.ts')).toBe('src/x.ts')
    expect(rootRelative('/work/app/', '/work/app/src/x.ts')).toBe('src/x.ts')
    expect(rootRelative('/work/app', '/work/lib/x.ts')).toBe('/work/lib/x.ts')
  })
})
