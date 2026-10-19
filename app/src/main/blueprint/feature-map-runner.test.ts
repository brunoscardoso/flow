import { EventEmitter } from 'events'

import { runFeatureMap } from './feature-map-runner'
import type { BundledCli } from './derive-runner'

const cli: BundledCli = { execPath: '/bin/electron', cliPath: '/app/cli.js' } as BundledCli

function fakeSpawn(stdout: string): { spawnFn: any; args: string[][] } {
  const args: string[][] = []
  const spawnFn = (_exec: string, argv: string[]) => {
    args.push(argv)
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: () => void }
    child.stdout = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => {
      if (stdout.length > 0) child.stdout.emit('data', stdout)
      child.emit('close', 0)
    })
    return child
  }
  return { spawnFn, args }
}

const valid = JSON.stringify({
  feature: 'chats',
  files: [
    { path: 'src/a.ts', part: null, kind: 'file', badges: [] },
    { path: 'src/b.ts', part: 'Store', kind: 'file', badges: ['View'] },
    { path: 'src/lib', part: null, kind: 'folder', badges: [] },
  ],
  edges: [{ from: 'src/a.ts', to: 'src/b.ts' }],
  unresolved: [{ anchor: 'file:gone.ts', reason: 'no such file or directory' }],
})

describe('runFeatureMap', () => {
  it('parses a valid map and calls the right verb with the feature ref', async () => {
    const { spawnFn, args } = fakeSpawn(valid)
    const result = await runFeatureMap(cli, '/repo', 'chats', { spawnFn })
    expect(result.available).toBe(true)
    expect(result.feature).toBe('chats')
    expect(result.files).toHaveLength(3)
    expect(result.files[1].badges).toEqual(['View'])
    expect(result.edges).toEqual([{ from: 'src/a.ts', to: 'src/b.ts' }])
    expect(result.unresolved).toHaveLength(1)
    expect(args[0]).toEqual(['/app/cli.js', 'blueprint', 'feature-map', '--feature', 'chats', '--json'])
  })

  it('is unavailable on a refusal line, unparseable output, no CLI, or no feature', async () => {
    expect(
      (await runFeatureMap(cli, '/r', 'x', { spawnFn: fakeSpawn('feature-map refused: no feature\n').spawnFn }))
        .reason,
    ).toBe('feature-map refused: no feature')
    expect(
      (await runFeatureMap(cli, '/r', 'x', { spawnFn: fakeSpawn('{nope').spawnFn })).reason,
    ).toBe('unparseable feature-map output')
    expect((await runFeatureMap(null, '/r', 'x')).reason).toBe('bundled CLI unavailable')
    expect((await runFeatureMap(cli, '/r', '  ')).reason).toBe('no feature named')
  })

  it('drops malformed files and any edge whose endpoint dropped with them', async () => {
    const { spawnFn } = fakeSpawn(
      JSON.stringify({
        feature: 'chats',
        files: [
          { path: 'src/a.ts', part: null, kind: 'file', badges: [] },
          { path: 'src/bad.ts', part: null, kind: 'mystery', badges: [] },
          { path: '', part: null, kind: 'file', badges: [] },
        ],
        edges: [
          { from: 'src/a.ts', to: 'src/bad.ts' },
          { from: 'src/a.ts', to: 'src/a.ts' },
        ],
        unresolved: [],
      }),
    )
    const result = await runFeatureMap(cli, '/r', 'chats', { spawnFn })
    expect(result.files.map((f) => f.path)).toEqual(['src/a.ts'])
    expect(result.edges).toEqual([{ from: 'src/a.ts', to: 'src/a.ts' }])
  })

  it('a map naming no feature is unavailable, not an empty success', async () => {
    const { spawnFn } = fakeSpawn(JSON.stringify({ files: [], edges: [], unresolved: [] }))
    const result = await runFeatureMap(cli, '/r', 'chats', { spawnFn })
    expect(result.available).toBe(false)
    expect(result.reason).toBe('feature-map output names no feature')
  })
})
