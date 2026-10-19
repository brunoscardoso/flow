import { joinPath, pathDelimiter, pathEnvKey } from './env'

describe('pathDelimiter', () => {
  it('is ; on win32 and : elsewhere', () => {
    expect(pathDelimiter('win32')).toBe(';')
    expect(pathDelimiter('darwin')).toBe(':')
    expect(pathDelimiter('linux')).toBe(':')
  })
})

describe('pathEnvKey', () => {
  it('is exactly PATH on POSIX, regardless of what else the env holds', () => {
    expect(pathEnvKey({ PATH: '/usr/bin' }, 'darwin')).toBe('PATH')
    // POSIX env keys ARE case-sensitive: a `Path` there is a different
    // variable, not the PATH, and must not be adopted.
    expect(pathEnvKey({ Path: '/usr/bin' }, 'darwin')).toBe('PATH')
    expect(pathEnvKey({}, 'darwin')).toBe('PATH')
  })

  it('reuses the existing key case-insensitively on win32', () => {
    // The bug this prevents: `{ ...env, PATH: x }` on an env that already has
    // `Path` produces BOTH keys, and which one the spawned process reads is
    // then up to the spawn implementation.
    expect(pathEnvKey({ Path: 'C:\\Windows' }, 'win32')).toBe('Path')
    expect(pathEnvKey({ PATH: 'C:\\Windows' }, 'win32')).toBe('PATH')
    expect(pathEnvKey({ path: 'C:\\Windows' }, 'win32')).toBe('path')
    expect(pathEnvKey({ PaTh: 'C:\\Windows' }, 'win32')).toBe('PaTh')
  })

  it('defaults to Windows’ own casing when the env has no PATH at all', () => {
    expect(pathEnvKey({}, 'win32')).toBe('Path')
    expect(pathEnvKey({ PATHEXT: '.COM;.EXE' }, 'win32')).toBe('Path')
  })
})

describe('joinPath', () => {
  it('joins with the platform delimiter', () => {
    expect(joinPath('darwin', '/a', '/b')).toBe('/a:/b')
    expect(joinPath('win32', 'C:\\a', 'C:\\b')).toBe('C:\\a;C:\\b')
  })

  it('drops absent and empty parts instead of emitting a bare separator', () => {
    // A leading/trailing separator is read by POSIX shells as "the current
    // directory" — a real security wart, not just untidiness.
    expect(joinPath('darwin', '/shim', undefined)).toBe('/shim')
    expect(joinPath('darwin', '/shim', '')).toBe('/shim')
    expect(joinPath('win32', 'C:\\shim', null)).toBe('C:\\shim')
    expect(joinPath('darwin', undefined, '/rest')).toBe('/rest')
    expect(joinPath('darwin')).toBe('')
  })

  it('reproduces withShimPath’s PRE-PORT darwin join (NFR1)', () => {
    // Until Phase 2 this compared against withShimPath itself — which Phase 2
    // rewrote to call joinPath, making the comparison a tautology. The property
    // is re-expressed as a PIN of what the old `:` join produced (captured from
    // `git show <pre-port>:app/src/main/agent/cli-shim.ts`):
    //   const path = existingPath ? `${shimDir}:${existingPath}` : shimDir
    const shimDir = '/Users/me/Library/Application Support/Flow/bin'
    const existing = '/usr/local/bin:/usr/bin:/bin'
    expect(joinPath('darwin', shimDir, existing)).toBe(`${shimDir}:${existing}`)
    // …including the empty-PATH degradation.
    expect(joinPath('darwin', shimDir, undefined)).toBe(shimDir)
    expect(joinPath('darwin', shimDir, '')).toBe(shimDir)
  })

  it('would have produced the unusable single entry the `:` join makes on Windows', () => {
    // Documents the defect B1 fixes: one `:`-joined blob, so the agent session
    // loses git, node — everything — while the env still LOOKS populated.
    const shimDir = 'C:\\Users\\me\\AppData\\Roaming\\Flow\\bin'
    const existing = 'C:\\Windows\\system32;C:\\Program Files\\nodejs'
    expect(joinPath('win32', shimDir, existing).split(';')).toHaveLength(3)
    expect(`${shimDir}:${existing}`.split(';')[0]).toContain(':')
  })
})
