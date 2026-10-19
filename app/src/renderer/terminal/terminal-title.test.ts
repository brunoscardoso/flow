import { osc7FolderName } from './terminal-title'

describe('osc7FolderName', () => {
  it('returns the folder basename for a normal cwd payload', () => {
    expect(osc7FolderName('file://host/Users/me/projects/orbit-core')).toBe('orbit-core')
    expect(osc7FolderName('file:///Users/me/orbit-app')).toBe('orbit-app')
  })

  it('decodes percent-encoded path segments', () => {
    expect(osc7FolderName('file://host/Users/me/My%20Project')).toBe('My Project')
  })

  it('ignores a trailing slash', () => {
    expect(osc7FolderName('file://host/Users/me/src/')).toBe('src')
  })

  it('maps the filesystem root to "/"', () => {
    expect(osc7FolderName('file://host/')).toBe('/')
  })

  it('returns null for a non file:// payload or malformed encoding', () => {
    expect(osc7FolderName('7;not-a-uri')).toBeNull()
    expect(osc7FolderName('https://example.com/x')).toBeNull()
    expect(osc7FolderName('file://host/bad%ZZ')).toBeNull()
  })
})
