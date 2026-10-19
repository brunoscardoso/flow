import { repointedTabs } from './repoint-tabs'

const FROM = '/Users/me/.orbit-core-threads/e2265b48-03e9-43e3-8f76-ff887a48615e'
const TO = '/Users/me/.orbit-core-threads/worktree/data-contract-guard'

const tabs = (...refs: Array<Record<string, unknown>>): string => JSON.stringify(refs)

describe('repointedTabs — the tabs move with the directory', () => {
  it('rewrites a tab that lives in the checkout', () => {
    const moved = repointedTabs(
      tabs({ rootPath: FROM, relPath: 'src/a.ts', active: true }),
      '{}',
      FROM,
      TO,
    )
    expect(moved).not.toBeNull()
    expect(JSON.parse(moved!.openFiles)).toEqual([
      { rootPath: TO, relPath: 'src/a.ts', active: true },
    ])
  })

  it('leaves every other project’s tabs exactly as they were', () => {
    const other = { rootPath: '/Users/me/orbit-core', relPath: 'README.md' }
    const moved = repointedTabs(tabs(other, { rootPath: FROM, relPath: 'a.ts' }), '{}', FROM, TO)
    expect(JSON.parse(moved!.openFiles)[0]).toEqual(other)
  })

  it('carries the unsaved contents across, keyed by the new absolute path', () => {
    // #955: typed-but-unsaved work rides in this column. A rename that moved the
    // tab and not its buffer would restore the tab CLEAN — silently destroying
    // what was typed.
    const moved = repointedTabs(
      tabs({ rootPath: FROM, relPath: 'a.ts' }),
      JSON.stringify({ [`${FROM}/a.ts`]: 'half a sentence', '/elsewhere/b.ts': 'kept' }),
      FROM,
      TO,
    )
    expect(JSON.parse(moved!.dirtyBuffers)).toEqual({
      [`${TO}/a.ts`]: 'half a sentence',
      '/elsewhere/b.ts': 'kept',
    })
  })

  it('says null for a row that never mentioned the checkout', () => {
    // The caller leaves such a row COMPLETELY alone — rewriting it would touch
    // `last_active_at`, which decides which project boots (#1080).
    expect(
      repointedTabs(tabs({ rootPath: '/Users/me/orbit-core', relPath: 'a.ts' }), '{}', FROM, TO),
    ).toBeNull()
    expect(repointedTabs('[]', '{}', FROM, TO)).toBeNull()
  })

  it('does not move a path that merely starts with the same characters', () => {
    const near = `${FROM}-2`
    const moved = repointedTabs(
      tabs({ rootPath: near, relPath: 'a.ts' }),
      JSON.stringify({ [`${near}/a.ts`]: 'x' }),
      FROM,
      TO,
    )
    expect(moved).toBeNull()
  })

  it('leaves a column it cannot parse alone rather than destroying it', () => {
    expect(repointedTabs('not json', '{}', FROM, TO)).toBeNull()
    expect(repointedTabs(tabs({ rootPath: FROM, relPath: 'a.ts' }), 'not json', FROM, TO)).toBeNull()
  })

  it('refuses a move that is not one', () => {
    expect(repointedTabs(tabs({ rootPath: FROM, relPath: 'a.ts' }), '{}', FROM, FROM)).toBeNull()
    expect(repointedTabs(tabs({ rootPath: FROM, relPath: 'a.ts' }), '{}', '', TO)).toBeNull()
  })
})
