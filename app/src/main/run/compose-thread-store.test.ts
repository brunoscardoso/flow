// A thread's Docker data — Docker is a table of expected argv that THROWS on
// anything else (allowed-pattern #24); override files go to a temp folder.

import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describeCompose } from './compose-describe'
import { LABEL_PROJECT, LABEL_THREAD, LABEL_VOLUME, serializeComposeOverride, threadComposeOverride } from './compose-thread'
import {
  createOverrideFiles,
  listProjectVolumes,
  listThreadContainers,
  listThreadVolumes,
  liveThread,
  parseDockerSize,
  parseVolumeSizes,
  removeThreadVolumes,
  emptyThreadData,
} from './compose-thread-store'
import type { DockerRunResult, DockerRunner } from './docker-runner'

const THREAD = '3f2a9c1e-77b0-4d2e-9a10-5b6c7d8e9f00'
const OTHER = 'aa11bb22-cc33-dd44-ee55-ff6677889900'

type Answer = Partial<DockerRunResult>

/** Docker as a table keyed by the whole argv; an argv not in the table throws. */
function dockerTable(answers: Array<[string[], Answer]>): DockerRunner & { calls: string[][] } {
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

const VOLUME_FORMAT = `{{.Name}}\t{{.Label "${LABEL_VOLUME}"}}\t{{.Label "${LABEL_THREAD}"}}`
const CONTAINER_FORMAT = '{{.ID}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}'
const projectFilter = ['--filter', `label=${LABEL_PROJECT}=shop`]
const threadFilter = ['--filter', `label=${LABEL_THREAD}=${THREAD}`]

const volumeLs = (filters: string[]): string[] => ['volume', 'ls', ...filters, '--format', VOLUME_FORMAT]
const threadVolumeLs = volumeLs([...projectFilter, ...threadFilter])
const containerPs = ['ps', '--all', ...projectFilter, ...threadFilter, '--format', CONTAINER_FORMAT]
const systemDf = ['system', 'df', '-v', '--format', 'json']

const VOLUMES_OUT = [
  `flow-shop-3f2a9c1e77b0-pgdata\tpgdata\t${THREAD}`,
  `flow-shop-3f2a9c1e77b0-redisdata\tredisdata\t${THREAD}`,
  '',
].join('\n')

describe('sizes', () => {
  it('reads Docker’s human sizes', () => {
    expect(parseDockerSize('0B')).toBe(0)
    expect(parseDockerSize('12.5kB')).toBe(12500)
    expect(parseDockerSize('1.5GB')).toBe(1_500_000_000)
    expect(parseDockerSize('2MiB')).toBe(2 * 1024 * 1024)
    expect(parseDockerSize('N/A')).toBeNull()
    expect(parseDockerSize(undefined)).toBeNull()
  })

  it('reads every shape of the df listing and skips junk', () => {
    const single = JSON.stringify({ Volumes: [{ Name: 'a', Size: '1kB' }, { Name: 'b', Size: 'N/A' }] })
    expect([...parseVolumeSizes(single)]).toEqual([['a', 1000], ['b', null]])
    const lines = `${JSON.stringify({ Name: 'a', Size: '2kB' })}\nnot json\n${JSON.stringify({ Name: 'c', Size: '0B' })}`
    expect([...parseVolumeSizes(lines)]).toEqual([['a', 2000], ['c', 0]])
    const array = JSON.stringify([{ Name: 'z', UsageData: { Size: 42 } }])
    expect([...parseVolumeSizes(array)]).toEqual([['z', 42]])
    expect(parseVolumeSizes('').size).toBe(0)
  })
})

describe('listing', () => {
  it('lists a thread’s volumes with sizes, a missing size as null', async () => {
    const runner = dockerTable([
      [threadVolumeLs, { stdout: VOLUMES_OUT }],
      [systemDf, { stdout: JSON.stringify({ Volumes: [{ Name: 'flow-shop-3f2a9c1e77b0-pgdata', Size: '3MB' }] }) }],
    ])
    const result = await listThreadVolumes(runner, 'Shop', THREAD)
    expect(result).toEqual({
      ok: true,
      items: [
        { name: 'flow-shop-3f2a9c1e77b0-pgdata', volume: 'pgdata', threadId: THREAD, sizeBytes: 3_000_000 },
        { name: 'flow-shop-3f2a9c1e77b0-redisdata', volume: 'redisdata', threadId: THREAD, sizeBytes: null },
      ],
    })
  })

  it('keeps the list when sizes cannot be read', async () => {
    const runner = dockerTable([
      [threadVolumeLs, { stdout: VOLUMES_OUT }],
      [systemDf, { ok: false, code: null, timedOut: true }],
    ])
    const result = await listThreadVolumes(runner, 'shop', THREAD)
    expect(result.ok && result.items.map((item) => item.sizeBytes)).toEqual([null, null])
  })

  it('skips the size call when asked, or when there is nothing to size', async () => {
    const runner = dockerTable([[threadVolumeLs, { stdout: '' }]])
    expect(await listThreadVolumes(runner, 'shop', THREAD)).toEqual({ ok: true, items: [] })
    const quick = dockerTable([[threadVolumeLs, { stdout: VOLUMES_OUT }]])
    const result = await listThreadVolumes(quick, 'shop', THREAD, { sizes: false })
    expect(result.ok && result.items).toHaveLength(2)
    expect(quick.calls).toEqual([threadVolumeLs])
  })

  it('lists every thread’s volumes for a project', async () => {
    const runner = dockerTable([
      [volumeLs(projectFilter), { stdout: `${VOLUMES_OUT}flow-shop-aa11bb22cc33-pgdata\tpgdata\t${OTHER}\n` }],
      [systemDf, { stdout: '' }],
    ])
    const result = await listProjectVolumes(runner, 'shop')
    expect(result.ok && result.items.map((item) => item.threadId)).toEqual([THREAD, THREAD, OTHER])
  })

  it('says Docker did not answer, in the reader’s terms', async () => {
    const runner = dockerTable([[threadVolumeLs, { ok: false, code: 1 }]])
    const result = await listThreadVolumes(runner, 'shop', THREAD)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).not.toMatch(/`|\/|--/)
  })

  it('lists a thread’s containers with their service and state', async () => {
    const runner = dockerTable([[containerPs, { stdout: 'c1\tdb\trunning\nc2\t\texited\n' }]])
    expect(await listThreadContainers(runner, 'shop', THREAD)).toEqual({
      ok: true,
      items: [
        { id: 'c1', service: 'db', state: 'running' },
        { id: 'c2', service: null, state: 'exited' },
      ],
    })
  })
})

describe('liveThread', () => {
  const ps = ['ps', ...projectFilter, '--format', `{{.Label "${LABEL_THREAD}"}}`]

  it('answers the thread on the running containers', async () => {
    const runner = dockerTable([[ps, { stdout: `${THREAD}\n${THREAD}\n` }]])
    expect(await liveThread(runner, 'shop')).toEqual({ ok: true, threadId: THREAD })
  })

  it('answers null when nothing runs, or only a run outside any thread (no label)', async () => {
    expect(await liveThread(dockerTable([[ps, { stdout: '' }]]), 'shop')).toEqual({ ok: true, threadId: null })
    expect(await liveThread(dockerTable([[ps, { stdout: '\n\n' }]]), 'shop')).toEqual({ ok: true, threadId: null })
  })

  it('a half-finished switch answers the thread most containers carry', async () => {
    const runner = dockerTable([[ps, { stdout: `${OTHER}\n${THREAD}\n${THREAD}\n` }]])
    expect(await liveThread(runner, 'shop')).toEqual({ ok: true, threadId: THREAD })
  })

  it('a failed read is not "nobody"', async () => {
    const runner = dockerTable([[ps, { ok: false, code: 1 }]])
    expect((await liveThread(runner, 'shop')).ok).toBe(false)
  })
})

describe('removing a thread’s data', () => {
  const volumeRm = ['volume', 'rm', 'flow-shop-3f2a9c1e77b0-pgdata', 'flow-shop-3f2a9c1e77b0-redisdata']

  for (const [name, remove] of [
    ['removeThreadVolumes', removeThreadVolumes],
    ['emptyThreadData', emptyThreadData],
  ] as const) {
    describe(name, () => {
      it('with no confirmation, refuses and runs NOTHING', async () => {
        for (const confirmation of [undefined, {}, { confirmed: 'yes' }, { confirmed: 1 }, { confirmed: false }]) {
          const runner = dockerTable([])
          const result = await remove(runner, 'shop', THREAD, confirmation as { confirmed?: unknown } | undefined)
          expect(result.ok).toBe(false)
          if (!result.ok) expect(result.detail).toMatch(/needs an explicit confirmation\.$/)
          expect(runner.calls).toEqual([])
        }
      })

      it('confirmed: removes stopped containers, then the thread’s volumes', async () => {
        const runner = dockerTable([
          [containerPs, { stdout: 'c1\tdb\texited\n' }],
          [threadVolumeLs, { stdout: VOLUMES_OUT }],
          [['rm', 'c1'], {}],
          [volumeRm, {}],
        ])
        const result = await remove(runner, 'shop', THREAD, { confirmed: true })
        expect(result).toEqual({ ok: true, removed: volumeRm.slice(2) })
        expect(runner.calls).toEqual([containerPs, threadVolumeLs, ['rm', 'c1'], volumeRm])
      })

      it('confirmed but running: refuses, and removes nothing', async () => {
        const runner = dockerTable([[containerPs, { stdout: 'c1\tdb\trunning\nc2\tweb\texited\n' }]])
        const result = await remove(runner, 'shop', THREAD, { confirmed: true })
        // Positive first: the containers WERE read, so the refusal is the running check.
        expect(runner.calls).toEqual([containerPs])
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.detail).toMatch(/running/)
        expect(runner.calls.filter(([verb, sub]) => verb === 'rm' || sub === 'rm')).toEqual([])
      })

      it('keeps the volumes when Docker refuses to remove the containers', async () => {
        const runner = dockerTable([
          [containerPs, { stdout: 'c1\tdb\texited\n' }],
          [threadVolumeLs, { stdout: VOLUMES_OUT }],
          [['rm', 'c1'], { ok: false, code: 1 }],
        ])
        const result = await remove(runner, 'shop', THREAD, { confirmed: true })
        expect(runner.calls).toContainEqual(['rm', 'c1'])
        expect(result.ok).toBe(false)
        expect(runner.calls.filter(([verb, sub]) => verb === 'volume' && sub === 'rm')).toEqual([])
      })

      it('nothing to remove is fine', async () => {
        const runner = dockerTable([
          [containerPs, { stdout: '' }],
          [threadVolumeLs, { stdout: '' }],
        ])
        expect(await remove(runner, 'shop', THREAD, { confirmed: true })).toEqual({ ok: true, removed: [] })
      })
    })
  }
})

describe('override files', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-compose-overrides-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const plan = () =>
    threadComposeOverride({
      project: describeCompose('services:\n  db:\n    image: postgres\n    volumes:\n      - pgdata:/var/lib/postgresql/data\n'),
      projectSlug: 'Shop',
      threadId: THREAD,
      checkout: '/checkouts/shop-blue',
    })

  it('writes the thread’s override under the folder, per project, privately', async () => {
    const files = createOverrideFiles({ dir })
    const path = await files.write(plan())
    expect(path).toBe(join(dir, 'shop', '3f2a9c1e77b0.yml'))
    expect(files.pathFor('Shop', THREAD)).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe(serializeComposeOverride(plan().override))
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('removes a thread’s override, and a missing one is not an error', async () => {
    const files = createOverrideFiles({ dir })
    const path = await files.write(plan())
    await files.remove('shop', THREAD)
    expect(existsSync(path)).toBe(false)
    await expect(files.remove('shop', THREAD)).resolves.toBeUndefined()
  })
})
