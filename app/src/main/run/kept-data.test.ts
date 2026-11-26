// Docker is a table of expected argv that THROWS on anything else (allowed-pattern #24).

import { LABEL_PROJECT, LABEL_THREAD, LABEL_VOLUME } from './compose-thread'
import type { FlowVolume } from './compose-thread-store'
import type { DockerRunResult, DockerRunner } from './docker-runner'
import { KEPT_DATA_SENTENCE, deleteKeptData, groupKeptVolumes, readKeptData, type KeptDataDeps } from './kept-data'

const GONE = '3f2a9c1e-77b0-4d2e-9a10-5b6c7d8e9f00'
const LIVE = '9a8b7c6d-1111-4222-8333-444455556666'

function dockerTable(answers: Array<[string[], Partial<DockerRunResult>]>): DockerRunner & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    run: async (args) => {
      calls.push(args)
      const hit = answers.find(([argv]) => argv.length === args.length && argv.every((word, i) => word === args[i]))
      if (hit === undefined) throw new Error(`unexpected docker call: ${JSON.stringify(args)}`)
      return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false, ...hit[1] }
    },
  }
}

const FORMAT = `{{.Name}}\t{{.Label "${LABEL_VOLUME}"}}\t{{.Label "${LABEL_THREAD}"}}`
const CONTAINER_FORMAT = '{{.ID}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}'
const project = ['--filter', `label=${LABEL_PROJECT}=shop`]
const thread = [...project, '--filter', `label=${LABEL_THREAD}=${GONE}`]
const version = ['version', '--format', '{{.Server.Version}}']
const compose = ['compose', 'version', '--short']
const listProject = ['volume', 'ls', ...project, '--format', FORMAT]
const listThread = ['volume', 'ls', ...thread, '--format', FORMAT]
const psThread = ['ps', '--all', ...thread, '--format', CONTAINER_FORMAT]
const df = ['system', 'df', '-v', '--format', 'json']
const runningIds = ['ps', '-q', ...thread]
const VOLUMES =
  `flow-shop-a-pg\tpg\t${GONE}\n` + `flow-shop-a-redis\tredis\t${GONE}\n` + `flow-shop-b-pg\tpg\t${LIVE}\n` + 'loose\tloose\t\n'
const SIZES = JSON.stringify({
  Volumes: [
    { Name: 'flow-shop-a-pg', Size: '1GB' },
    { Name: 'flow-shop-a-redis', Size: '500MB' },
    { Name: 'flow-shop-b-pg', Size: '2GB' },
  ],
})

const up: Array<[string[], Partial<DockerRunResult>]> = [
  [version, { stdout: '27.0.1\n' }],
  [compose, { stdout: '2.29.0\n' }],
]

function deps(runner: DockerRunner, over: Partial<KeptDataDeps> = {}): KeptDataDeps {
  return {
    runner,
    projects: async () => [{ root: '/repos/shop', name: 'shop' }],
    lookupThread: (id) => (id === LIVE ? { title: 'Still here' } : null),
    slugOf: () => 'shop',
    ...over,
  }
}

const volume = (over: Partial<FlowVolume>): FlowVolume => ({ name: 'n', volume: 'pg', threadId: GONE, sizeBytes: 10, ...over })

describe('groupKeptVolumes', () => {
  const lookup = (id: string) => (id === LIVE ? { title: 'Still here' } : null)
  const shop = { root: '/repos/shop', name: 'shop' }

  it('keeps a thread the store has no record of, and not one it has (positive control first)', () => {
    const items = groupKeptVolumes(shop, [volume({ threadId: GONE }), volume({ threadId: LIVE })], lookup)
    expect(items.map((item) => item.threadId)).toEqual([GONE])
    expect(groupKeptVolumes(shop, [volume({ threadId: LIVE })], lookup)).toEqual([])
  })

  it('adds a thread’s volumes, null when any size is unknown, and leaves unlabelled volumes out', () => {
    const [item] = groupKeptVolumes(
      shop,
      [volume({ volume: 'pg', sizeBytes: 5 }), volume({ volume: 'redis', sizeBytes: 7 }), volume({ threadId: null })],
      lookup,
    )
    expect(item?.totalBytes).toBe(12)
    expect(item?.volumes.map((entry) => entry.volume)).toEqual(['pg', 'redis'])
    const [unknown] = groupKeptVolumes(shop, [volume({ sizeBytes: 5 }), volume({ sizeBytes: null })], lookup)
    expect(unknown?.totalBytes).toBeNull()
  })

  it('lists the biggest first', () => {
    const items = groupKeptVolumes(shop, [volume({ threadId: 'small', sizeBytes: 1 }), volume({ threadId: 'big', sizeBytes: 9 })], lookup)
    expect(items.map((item) => item.threadId)).toEqual(['big', 'small'])
  })
})

describe('readKeptData', () => {
  it('lists the deleted thread’s volumes with sizes and nothing of a live thread', async () => {
    const runner = dockerTable([...up, [listProject, { stdout: VOLUMES }], [df, { stdout: SIZES }]])
    const answer = await readKeptData(deps(runner))
    expect(answer.dockerAvailable).toBe(true)
    expect(answer.items).toHaveLength(1)
    expect(answer.items[0]).toMatchObject({ threadId: GONE, projectRoot: '/repos/shop', projectName: 'shop', title: null, totalBytes: 1.5e9 })
    expect(answer.items[0]?.volumes.map((entry) => entry.volume)).toEqual(['pg', 'redis'])
  })

  it('sizes every project from ONE scan of the volumes, however many projects there are', async () => {
    const runner = dockerTable([...up, [listProject, { stdout: VOLUMES }], [df, { stdout: SIZES }]])
    const three = async () => [
      { root: '/repos/shop', name: 'shop' },
      { root: '/repos/shop-b', name: 'shop-b' },
      { root: '/repos/shop-c', name: 'shop-c' },
    ]
    const answer = await readKeptData(deps(runner, { projects: three }))
    expect(answer.items.length).toBeGreaterThan(0)
    expect(answer.items[0]?.totalBytes).toBe(1.5e9)
    expect(runner.calls.filter((argv) => argv[0] === 'volume' && argv[1] === 'ls')).toHaveLength(3)
    expect(runner.calls.filter((argv) => argv[0] === 'system')).toHaveLength(1)
  })

  it('Docker closed is a typed answer and lists nothing', async () => {
    const runner = dockerTable([[version, { ok: false, code: 1 }]])
    await expect(readKeptData(deps(runner))).resolves.toEqual({ dockerAvailable: false, items: [] })
  })

  it('asks Docker nothing at all when no project has a Compose file (the list above is the positive control)', async () => {
    const runner = dockerTable([])
    await expect(readKeptData(deps(runner, { projects: async () => [] }))).resolves.toEqual({ dockerAvailable: true, items: [] })
    expect(runner.calls).toEqual([])
  })
})

describe('deleteKeptData', () => {
  it('positive control: a confirmed delete of a gone thread removes its volumes', async () => {
    const runner = dockerTable([
      [runningIds, { stdout: '' }],
      [psThread, { stdout: '' }],
      [listThread, { stdout: `flow-shop-a-pg\tpg\t${GONE}\n` }],
      [['volume', 'rm', 'flow-shop-a-pg'], {}],
    ])
    await expect(deleteKeptData(deps(runner), { threadId: GONE, projectRoot: '/repos/shop', confirmed: true })).resolves.toEqual({ ok: true })
    expect(runner.calls.at(-1)).toEqual(['volume', 'rm', 'flow-shop-a-pg'])
  })

  it('without exactly true it records no Docker call at all', async () => {
    const runner = dockerTable([])
    for (const confirmed of [undefined, false, 1, 'true']) {
      const answer = await deleteKeptData(deps(runner), { threadId: GONE, projectRoot: '/repos/shop', confirmed })
      expect(answer).toEqual({ ok: false, detail: KEPT_DATA_SENTENCE.unconfirmed })
    }
    expect(runner.calls).toEqual([])
  })

  it('refuses a thread that still exists, with no Docker call', async () => {
    const runner = dockerTable([])
    const answer = await deleteKeptData(deps(runner), { threadId: LIVE, projectRoot: '/repos/shop', confirmed: true })
    expect(answer).toEqual({ ok: false, detail: KEPT_DATA_SENTENCE.stillExists })
    expect(runner.calls).toEqual([])
  })

  it('refuses a project that is not one of the Compose projects, with no Docker call', async () => {
    const runner = dockerTable([])
    const answer = await deleteKeptData(deps(runner), { threadId: GONE, projectRoot: '/repos/other', confirmed: true })
    expect(answer).toEqual({ ok: false, detail: KEPT_DATA_SENTENCE.unknownProject })
    expect(runner.calls).toEqual([])
  })

  it('stops a deleted thread’s leftover containers by its labels first, then removes its data', async () => {
    const runner = dockerTable([
      [runningIds, { stdout: 'abc\n' }],
      [['stop', 'abc'], {}],
      [psThread, { stdout: 'abc\tdb\texited\n' }],
      [listThread, { stdout: `flow-shop-a-pg\tpg\t${GONE}\n` }],
      [['rm', 'abc'], {}],
      [['volume', 'rm', 'flow-shop-a-pg'], {}],
    ])
    await expect(deleteKeptData(deps(runner), { threadId: GONE, projectRoot: '/repos/shop', confirmed: true })).resolves.toEqual({ ok: true })
    const stopAt = runner.calls.findIndex((argv) => argv[0] === 'stop')
    const removeAt = runner.calls.findIndex((argv) => argv[0] === 'volume' && argv[1] === 'rm')
    expect(stopAt).toBeGreaterThanOrEqual(0)
    expect(removeAt).toBeGreaterThan(stopAt)
  })

  it('refuses while a container still runs after the stop, and removes nothing', async () => {
    const runner = dockerTable([
      [runningIds, { stdout: 'abc\n' }],
      [['stop', 'abc'], { ok: false, code: 1 }],
      [psThread, { stdout: 'abc\tdb\trunning\n' }],
    ])
    const answer = await deleteKeptData(deps(runner), { threadId: GONE, projectRoot: '/repos/shop', confirmed: true })
    expect(runner.calls).toContainEqual(['stop', 'abc'])
    expect(answer.ok).toBe(false)
    expect(runner.calls.some((argv) => argv[0] === 'volume' && argv[1] === 'rm')).toBe(false)
  })
})
