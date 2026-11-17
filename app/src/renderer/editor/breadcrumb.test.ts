import { breadcrumbParts } from './breadcrumb-model'

describe('breadcrumbParts', () => {
  it('splits a root-relative path into folders and the file name, with its mark', () => {
    expect(breadcrumbParts('src/components/CoworkerPanel.tsx')).toEqual({
      folders: ['src', 'components'],
      name: 'CoworkerPanel.tsx',
      badge: 'TS',
      color: '#519aba',
    })
  })

  it('has no folders for a file at the root, and no badge for a type without one', () => {
    const parts = breadcrumbParts('.gitignore')
    expect(parts?.folders).toEqual([])
    expect(parts?.name).toBe('.gitignore')
    expect(parts?.badge).toBeNull()
  })

  it('is null when there is no file', () => {
    expect(breadcrumbParts(null)).toBeNull()
    expect(breadcrumbParts('')).toBeNull()
  })
})
