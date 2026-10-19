import { archivedSectionExpanded, partitionByArchived } from './thread-archived'

const t = (id: string, archivedAt: string | null) => ({ id, archivedAt })

describe('partitionByArchived (#482)', () => {
  it('splits active from archived, preserving order', () => {
    const { active, archived } = partitionByArchived([
      t('a', null),
      t('b', '2026-01-01'),
      t('c', null),
      t('d', '2026-02-02'),
    ])
    expect(active.map((x) => x.id)).toEqual(['a', 'c'])
    expect(archived.map((x) => x.id)).toEqual(['b', 'd'])
  })
  it('handles all-active and all-archived and empty', () => {
    expect(partitionByArchived([t('a', null)])).toEqual({ active: [t('a', null)], archived: [] })
    expect(partitionByArchived([t('a', 'x')])).toEqual({ active: [], archived: [t('a', 'x')] })
    expect(partitionByArchived([])).toEqual({ active: [], archived: [] })
  })
})

describe('archivedSectionExpanded', () => {
  it('is forced expanded during search so archived matches are visible', () => {
    expect(archivedSectionExpanded(true, false)).toBe(true)
    expect(archivedSectionExpanded(true, true)).toBe(true)
  })
  it('honors the user toggle when not searching', () => {
    expect(archivedSectionExpanded(false, true)).toBe(true)
    expect(archivedSectionExpanded(false, false)).toBe(false)
  })
})
