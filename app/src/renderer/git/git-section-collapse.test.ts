import {
  dropLegacySectionKeys,
  parseCollapsedSections,
  sectionCollapseKey,
  serializeCollapsedSections,
  toggleSection,
} from './git-section-collapse'
import { groupCollapseKey } from './git-groups'

describe('sectionCollapseKey (#1143)', () => {
  it('gives two repos independent folds for the same section', () => {
    const a = sectionCollapseKey('/repos/alpha', 'changes')
    const b = sectionCollapseKey('/repos/beta', 'changes')
    expect(a).not.toBe(b)
    // Folding A leaves B's key absent — the panel renders B expanded.
    const folded = toggleSection(new Set<string>(), a)
    expect(folded.has(a)).toBe(true)
    expect(folded.has(b)).toBe(false)
  })

  it('keeps each section of one repo independent', () => {
    const changes = sectionCollapseKey('/repos/alpha', 'changes')
    const commits = sectionCollapseKey('/repos/alpha', 'commits')
    expect(changes).not.toBe(commits)
  })

  it('can never collide with a repo-GROUP fold key', () => {
    // git-groups.ts namespaces group folds as `root:<path>`; the section keys
    // must live in their own namespace (this is the invariant that was missing).
    expect(sectionCollapseKey('/repos/alpha', 'changes')).not.toBe(
      groupCollapseKey('/repos/alpha'),
    )
    expect(sectionCollapseKey('/repos/alpha', 'changes').startsWith('root:')).toBe(false)
  })
})

describe('dropLegacySectionKeys (#1143)', () => {
  it('drops pre-namespace bare section keys', () => {
    expect(dropLegacySectionKeys(new Set(['changes', 'commits']))).toEqual(new Set())
  })

  it('keeps repo-group folds and namespaced section folds', () => {
    const kept = new Set([
      'changes', // legacy — dropped
      groupCollapseKey('/repos/alpha'),
      sectionCollapseKey('/repos/alpha', 'changes'),
    ])
    expect(dropLegacySectionKeys(kept)).toEqual(
      new Set([groupCollapseKey('/repos/alpha'), sectionCollapseKey('/repos/alpha', 'changes')]),
    )
  })

  it('does not mutate the input set', () => {
    const sections = new Set(['changes'])
    dropLegacySectionKeys(sections)
    expect(sections.has('changes')).toBe(true)
  })
})

describe('git-section-collapse', () => {
  it('parses a persisted list into a set', () => {
    expect(parseCollapsedSections('["staged","commits"]')).toEqual(new Set(['staged', 'commits']))
  })

  it('returns an empty set for missing/empty/corrupt values (never throws)', () => {
    expect(parseCollapsedSections(null)).toEqual(new Set())
    expect(parseCollapsedSections('')).toEqual(new Set())
    expect(parseCollapsedSections('not json')).toEqual(new Set())
    expect(parseCollapsedSections('{"staged":true}')).toEqual(new Set()) // not an array
    expect(parseCollapsedSections('[1,2,null]')).toEqual(new Set()) // no strings survive
  })

  it('round-trips through serialize → parse', () => {
    const set = new Set(['changes', 'merge'])
    expect(parseCollapsedSections(serializeCollapsedSections(set))).toEqual(set)
  })

  it('toggle adds when absent and removes when present, immutably', () => {
    const start = new Set<string>(['staged'])
    const added = toggleSection(start, 'commits')
    expect(added).toEqual(new Set(['staged', 'commits']))
    expect(start).toEqual(new Set(['staged'])) // original untouched

    const removed = toggleSection(added, 'staged')
    expect(removed).toEqual(new Set(['commits']))
  })
})
