import { anchorPaths, driftFilesByModule, makeDriftReasons, makeProjectStaleCheck } from './drift-reasons'
import type { StaleCheckReport } from './learn-triggers'

const REPORT: StaleCheckReport = {
  checked: 4,
  fresh: 1,
  stale: [
    { fingerprint: 'a', anchors: [{ kind: 'module', ref: 'src/components/chat' }], changedFiles: ['src/components/chat/a.ts', 'src/components/chat/b.ts'], missingFiles: [] },
    { fingerprint: 'b', anchors: [{ kind: 'symbol', ref: 'Thing', file: 'src/components/chat/c.ts' }], changedFiles: ['src/components/chat/a.ts'], missingFiles: ['src/components/chat/gone.ts'] },
    { fingerprint: 'c', anchors: [{ kind: 'file', ref: 'src/lib/x.ts' }], changedFiles: ['src/lib/x.ts'], missingFiles: [] },
  ],
}

describe('anchorPaths', () => {
  it('reads file, module and symbol anchors and skips the rest', () => {
    expect(anchorPaths([{ kind: 'file', ref: 'a.ts' }, { kind: 'module', ref: 'src' }, { kind: 'symbol', ref: 'S', file: 'b.ts' }])).toEqual(['a.ts', 'src', 'b.ts'])
    expect(anchorPaths([{ kind: 'endpoint', ref: 'GET /x' }, null, 'junk'])).toEqual([])
  })
})

describe('driftFilesByModule', () => {
  it('counts each module’s distinct changed and missing files by containment', () => {
    const files = driftFilesByModule(REPORT, ['src/components/chat', 'src/lib', 'src/components'])
    expect(files['src/components/chat']).toEqual(['src/components/chat/a.ts', 'src/components/chat/b.ts', 'src/components/chat/gone.ts'])
    expect(files['src/lib']).toEqual(['src/lib/x.ts'])
    // The parent folder contains the child's notes, as `--module` would.
    expect(files['src/components']).toHaveLength(3)
  })

  it('leaves out a module no stale note resolves under — no reason, never a guess', () => {
    const files = driftFilesByModule(REPORT, ['src/lib', 'src/app'])
    expect(files['src/lib']).toEqual(['src/lib/x.ts'])
    expect('src/app' in files).toBe(false)
  })

  it('does not match a sibling that only shares a prefix', () => {
    const files = driftFilesByModule(REPORT, ['src/li', 'src/components/cha'])
    expect(Object.keys(files)).toEqual([])
  })
})

describe('makeProjectStaleCheck', () => {
  it('runs the whole-project check once and parses it', async () => {
    const calls: string[][] = []
    const check = makeProjectStaleCheck(async (_cwd, args) => {
      calls.push([...args])
      return { ok: true, stdout: JSON.stringify(REPORT) }
    })
    const report = await check('/repo')
    expect(report?.stale).toHaveLength(3)
    expect(calls).toEqual([['blueprint', 'stale-check', '--json']])
  })

  it('answers null when the CLI fails or throws', async () => {
    expect(await makeProjectStaleCheck(async () => ({ ok: false, stdout: '' }))('/repo')).toBeNull()
    expect(await makeProjectStaleCheck(async () => { throw new Error('boom') })('/repo')).toBeNull()
  })
})

describe('makeDriftReasons', () => {
  it('reuses one check within the TTL and runs again after it', async () => {
    let clock = 0
    let runs = 0
    const reasons = makeDriftReasons(async () => {
      runs += 1
      return REPORT
    }, () => clock, 1000)
    expect((await reasons('/repo', ['src/lib']))?.['src/lib']).toEqual(['src/lib/x.ts'])
    await reasons('/repo', ['src/components/chat'])
    expect(runs).toBe(1)
    clock = 2000
    await reasons('/repo', ['src/lib'])
    expect(runs).toBe(2)
  })

  it('does not cache a failed check', async () => {
    let runs = 0
    const reasons = makeDriftReasons(async () => {
      runs += 1
      return runs === 1 ? null : REPORT
    }, () => 0, 1000)
    expect(await reasons('/repo', ['src/lib'])).toBeNull()
    expect((await reasons('/repo', ['src/lib']))?.['src/lib']).toEqual(['src/lib/x.ts'])
    expect(runs).toBe(2)
  })
})
