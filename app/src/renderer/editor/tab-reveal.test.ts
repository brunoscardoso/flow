import { splitProjectPath } from './tab-reveal'

const roots = (...paths: string[]): { rootPath: string }[] => paths.map((rootPath) => ({ rootPath }))

describe('splitProjectPath', () => {
  it('splits an absolute path against its owning root', () => {
    expect(splitProjectPath('/repo/src/app.ts', roots('/repo'))).toEqual({
      rootPath: '/repo',
      relPath: 'src/app.ts',
    })
  })

  it('returns relPath "" for the root itself', () => {
    expect(splitProjectPath('/repo', roots('/repo'))).toEqual({ rootPath: '/repo', relPath: '' })
  })

  it('returns null when the path is outside every root', () => {
    expect(splitProjectPath('/elsewhere/file.ts', roots('/repo'))).toBeNull()
  })

  it('does not match a sibling whose name merely prefixes the root', () => {
    // '/repo-two/...' shares the text 'repo' with root '/repo' but is NOT inside
    // it — matching requires a '/' boundary, so this is null.
    expect(splitProjectPath('/repo-two/x.ts', roots('/repo'))).toBeNull()
    expect(splitProjectPath('/repotwo/x.ts', roots('/repo'))).toBeNull()
    // …but when '/repo-two' is itself a root, it matches its own files.
    expect(splitProjectPath('/repo-two/x.ts', roots('/repo', '/repo-two'))).toEqual({
      rootPath: '/repo-two',
      relPath: 'x.ts',
    })
  })

  it('prefers the innermost (longest) root when roots nest', () => {
    expect(splitProjectPath('/repo/pkg/src/a.ts', roots('/repo', '/repo/pkg'))).toEqual({
      rootPath: '/repo/pkg',
      relPath: 'src/a.ts',
    })
  })

  it('normalizes Windows separators', () => {
    expect(splitProjectPath('C:\\repo\\src\\a.ts', roots('C:\\repo'))).toEqual({
      rootPath: 'C:\\repo',
      relPath: 'src/a.ts',
    })
  })

  it('tolerates a trailing slash on the root', () => {
    expect(splitProjectPath('/repo/a.ts', roots('/repo/'))).toEqual({
      rootPath: '/repo/',
      relPath: 'a.ts',
    })
  })
})

describe('a file in a thread\'s own checkout (the reveal bug)', () => {
  const PROJECT = '/Users/me/Projects/app'
  // Threads work in a checkout BESIDE the project, never inside it — confirmed
  // on a real machine: /Users/.../.plan-flow-threads/<thread-id>.
  const WORKTREE = '/Users/me/Projects/.plan-flow-threads/abc123'
  const FILE = `${WORKTREE}/src/app/globals.css`

  it('maps to no root when given the PROJECT list — this is the bug', () => {
    expect(splitProjectPath(FILE, [{ rootPath: PROJECT }])).toBeNull()
  })

  it('maps correctly when given the roots main actually accepts', () => {
    expect(splitProjectPath(FILE, [{ rootPath: PROJECT }, { rootPath: WORKTREE }])).toEqual({
      rootPath: WORKTREE,
      relPath: 'src/app/globals.css',
    })
  })
})
