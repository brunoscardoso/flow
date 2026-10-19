import { baseName, projectLabel } from './project-label'

describe('baseName', () => {
  it('takes the last path segment, trimming a trailing slash', () => {
    expect(baseName('/tmp/X/my-app')).toBe('my-app')
    expect(baseName('/tmp/X/my-app/')).toBe('my-app')
    expect(baseName('solo')).toBe('solo')
  })

  it('honors backslash separators in Windows roots (#1688)', () => {
    expect(baseName('C:\\Users\\devuser\\my-project')).toBe('my-project')
    expect(baseName('C:\\Users\\devuser\\my-project\\')).toBe('my-project')
  })
})

describe('projectLabel (#426)', () => {
  it('uses the bare basename when it is unique', () => {
    const roots = ['/tmp/X/my-app', '/tmp/Y/other']
    expect(projectLabel('/tmp/X/my-app', roots)).toBe('my-app')
  })

  it('appends the parent segment when two roots share a basename', () => {
    const roots = ['/tmp/X/my-app', '/tmp/Y/my-app']
    expect(projectLabel('/tmp/X/my-app', roots)).toBe('my-app — X')
    expect(projectLabel('/tmp/Y/my-app', roots)).toBe('my-app — Y')
  })

  it('falls back to the basename when a collision has no parent segment', () => {
    // Two top-level roots with the same name (no meaningful parent).
    expect(projectLabel('/app', ['/app', 'app'])).toBe('app')
  })

  it('does not treat a root as colliding with itself', () => {
    expect(projectLabel('/only/app', ['/only/app'])).toBe('app')
  })

  it('disambiguates Windows roots by their parent segment (#1688)', () => {
    const roots = ['C:\\work\\app', 'C:\\oss\\app']
    expect(projectLabel('C:\\work\\app', roots)).toBe('app — work')
    expect(projectLabel('C:\\oss\\app', roots)).toBe('app — oss')
  })
})

// One basename, one code path (#1728 — allowed-pattern #14). Two renderer
// surfaces re-implemented the last-segment split on '/' only, so a Windows
// root (`C:\Users\…`, the shape #1688 documents) rendered the ENTIRE path as
// the Tasks board subtitle and fed it to runKeyPrefix, which took `C` from
// `C:` and minted every project's run keys as TCL-… . The helper above already
// honors both separators; this scan keeps the call sites on it.
describe('basename call sites use the shared helper (#1728)', () => {
  const read = (rel: string) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('fs').readFileSync(require('path').join(__dirname, rel), 'utf8') as string

  // THE RULE IS "NO SECOND COPY", NOT "MUST IMPORT". Requiring the import made
  // the guard fail the day `loops-screen.ts` stopped needing a project's base
  // name at all — the run-key minting it used it for moved into `start-hunt.ts`
  // (which imports the shared helper) so all three surfaces that start a run
  // share one path. A file that does not take a basename is not a violation of
  // a rule about how basenames are taken, so the import is asserted only where
  // the file actually asks for one.
  it.each([
    ['tasks/kanban-board.ts', 'projectName('],
    ['loops/start-hunt.ts', 'projectNameOf('],
  ])('%s carries no local duplicate of the basename logic', (rel, duplicate) => {
    expect(read(rel)).not.toContain(duplicate)
  })

  it.each([['tasks/kanban-board.ts'], ['loops/start-hunt.ts']])(
    '%s takes its basename from the shared helper',
    (rel) => {
      expect(read(rel)).toContain("import { baseName } from '../project-label'")
    },
  )
})
