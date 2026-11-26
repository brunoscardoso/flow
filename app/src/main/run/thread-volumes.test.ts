// Docker is a table of expected argv that THROWS on anything else (allowed-pattern #24).

import { createComposePresence } from './compose-describe'
import { LABEL_PROJECT, LABEL_THREAD, LABEL_VOLUME } from './compose-thread'
import type { DockerRunResult, DockerRunner } from './docker-runner'
import { readThreadVolumes, releaseThreadVolumes, type ThreadVolumesDeps } from './thread-volumes'

const THREAD = '3f2a9c1e-77b0-4d2e-9a10-5b6c7d8e9f00'

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
const filters = ['--filter', `label=${LABEL_PROJECT}=shop`, '--filter', `label=${LABEL_THREAD}=${THREAD}`]
const volumeLs = ['volume', 'ls', ...filters, '--format', FORMAT]
const containerPs = ['ps', '--all', ...filters, '--format', CONTAINER_FORMAT]
const systemDf = ['system', 'df', '-v', '--format', 'json']
const ONE = `flow-shop-3f2a9c1e77b0-pg\tpg\t${THREAD}\n`
const TWO = `${ONE}flow-shop-3f2a9c1e77b0-redis\tredis\t${THREAD}\n`

function deps(runner: DockerRunner, over: Partial<ThreadVolumesDeps> = {}): ThreadVolumesDeps & { stops: string[] } {
  const stops: string[] = []
  return {
    stops,
    runner,
    rootsOf: () => ['/shop'],
    hasCompose: async () => true,
    stopThreadDocker: async (id) => {
      stops.push(id)
      return true
    },
    slugOf: () => 'shop',
    ...over,
  }
}

describe('readThreadVolumes', () => {
  it('counts the volumes and adds their sizes', async () => {
    const runner = dockerTable([
      [volumeLs, { stdout: TWO }],
      [systemDf, { stdout: JSON.stringify({ Volumes: [{ Name: 'flow-shop-3f2a9c1e77b0-pg', Size: '3MB' }, { Name: 'flow-shop-3f2a9c1e77b0-redis', Size: '1MB' }] }) }],
    ])
    expect(await readThreadVolumes(deps(runner), THREAD)).toEqual({ count: 2, totalBytes: 4_000_000 })
  })

  it('has no total when one size is unknown', async () => {
    const runner = dockerTable([
      [volumeLs, { stdout: TWO }],
      [systemDf, { stdout: JSON.stringify({ Volumes: [{ Name: 'flow-shop-3f2a9c1e77b0-pg', Size: '3MB' }] }) }],
    ])
    expect(await readThreadVolumes(deps(runner), THREAD)).toEqual({ count: 2, totalBytes: null })
  })

  it('answers null for no volumes, and for Docker not answering', async () => {
    expect(await readThreadVolumes(deps(dockerTable([[volumeLs, {}], [systemDf, {}]])), THREAD)).toBeNull()
    expect(await readThreadVolumes(deps(dockerTable([[volumeLs, { ok: false, code: 1 }]])), THREAD)).toBeNull()
  })

  it('never calls Docker for a project without a Compose file', async () => {
    const runner = dockerTable([])
    expect(await readThreadVolumes(deps(runner, { hasCompose: async () => false }), THREAD)).toBeNull()
    expect(runner.calls).toEqual([])
  })
})

describe('with the real Compose-file check', () => {
  const presence = (files: string[]) => createComposePresence({ exists: async (path) => files.includes(path) })

  it('asks Docker for a project with a Compose file, and never for one without', async () => {
    const withCompose = dockerTable([[volumeLs, { stdout: ONE }], [systemDf, { stdout: JSON.stringify({ Volumes: [] }) }]])
    expect(await readThreadVolumes(deps(withCompose, { hasCompose: presence(['/shop/compose.yaml']) }), THREAD)).toEqual({ count: 1, totalBytes: null })
    expect(withCompose.calls.length).toBeGreaterThan(0)
    const without = dockerTable([])
    const d = deps(without, { hasCompose: presence(['/shop/package.json']) })
    expect(await readThreadVolumes(d, THREAD)).toBeNull()
    expect(await releaseThreadVolumes(d, THREAD, { confirmed: true })).toEqual({ ok: true, removed: 0 })
    expect(without.calls).toEqual([])
    expect(d.stops).toEqual([])
  })
})

describe('releaseThreadVolumes', () => {
  it('without confirmed: true refuses and runs nothing', async () => {
    for (const request of [undefined, {}, { confirmed: 'yes' }, { confirmed: 1 }, { confirmed: false }]) {
      const runner = dockerTable([])
      const d = deps(runner)
      const result = await releaseThreadVolumes(d, THREAD, request as { confirmed?: unknown } | undefined)
      expect(result.ok).toBe(false)
      expect(runner.calls).toEqual([])
      expect(d.stops).toEqual([])
    }
  })

  it('confirmed: stops the group, then removes the volumes', async () => {
    const runner = dockerTable([
      [containerPs, {}],
      [volumeLs, { stdout: ONE }],
      [['volume', 'rm', 'flow-shop-3f2a9c1e77b0-pg'], {}],
    ])
    const d = deps(runner)
    expect(await releaseThreadVolumes(d, THREAD, { confirmed: true })).toEqual({ ok: true, removed: 1 })
    expect(d.stops).toEqual([THREAD])
    expect(runner.calls.at(-1)).toEqual(['volume', 'rm', 'flow-shop-3f2a9c1e77b0-pg'])
  })

  it('does nothing for a project without a Compose file, even when confirmed', async () => {
    const runner = dockerTable([])
    const d = deps(runner, { hasCompose: async () => false })
    expect(await releaseThreadVolumes(d, THREAD, { confirmed: true })).toEqual({ ok: true, removed: 0 })
    expect(runner.calls).toEqual([])
    expect(d.stops).toEqual([])
  })

  it('reports the removal’s refusal when a container still runs', async () => {
    const runner = dockerTable([[containerPs, { stdout: 'c1\tdb\trunning\n' }]])
    const result = await releaseThreadVolumes(deps(runner), THREAD, { confirmed: true })
    expect(result.ok).toBe(false)
    expect(runner.calls.some((argv) => argv[0] === 'volume' && argv[1] === 'rm')).toBe(false)
  })
})
