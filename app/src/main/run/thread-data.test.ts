// A conversation's Docker data as the screens see it — Docker faked as an
// argv-keyed table that THROWS on anything absent (allowed-pattern #24), so a
// refusal test proves both the reason and that no removal was asked.

import type { RunGroupState, RunScope } from '../../shared/run-setup'
import { describeCompose } from './compose-describe'
import { LABEL_PROJECT, LABEL_THREAD, LABEL_VOLUME, threadComposeOverride } from './compose-thread'
import type { DockerRunner, DockerRunResult } from './docker-runner'
import {
  createLiveThreads,
  folderName,
  LIVE_THREADS_TTL_MS,
  emptyThreadDataOf,
  readDockerElsewhere,
  readThreadData,
  restartThreadDocker,
  THREAD_DATA_SENTENCE,
  type ThreadDataDeps,
} from './thread-data'
import type { DockerGroupPlan } from './thread-docker'

const THREAD = '3f2a9c1e-77b0-4d2e-9a10-5b6c7d8e9f00'
const OTHER = 'aaaaaaaa-1111-2222-3333-444444444444'
const ROOT = '/repos/shop'
const CHECKOUT = '/repos/.shop-threads/blue'

const COMPOSE = [
  'services:',
  '  db:',
  '    image: postgres:16',
  '    volumes:',
  '      - pgdata:/var/lib/postgresql/data',
  '      - /srv/shared/uploads:/uploads',
  '  redis:',
  '    image: redis:7',
  '    volumes:',
  '      - cache:/data',
  'volumes:',
  '  pgdata:',
  '  cache:',
].join('\n')

function groupPlan(): DockerGroupPlan {
  const plan = threadComposeOverride({ project: describeCompose(COMPOSE), projectSlug: 'shop', threadId: THREAD, checkout: CHECKOUT })
  return {
    group: {
      projectRoot: ROOT,
      projectName: 'shop',
      threadId: THREAD,
      checkout: CHECKOUT,
      services: [...plan.readableServices],
      dataServices: [...plan.dataServices],
      volumes: plan.volumes.map((v) => v.name),
      unreadable: [],
      folded: [],
      notes: [],
    },
    plan,
    target: { projectName: 'shop', checkout: CHECKOUT, composeFile: `${CHECKOUT}/compose.yaml`, projectOverride: null, overridePath: '/o.yml' },
  }
}

type Answer = Partial<DockerRunResult>

function fakeDocker(table: Record<string, Answer>): { runner: DockerRunner; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    runner: {
      run: async (args) => {
        const key = args.join(' ')
        calls.push(key)
        const answer = table[key]
        if (answer === undefined) throw new Error(`unexpected docker call: ${key}`)
        return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false, ...answer }
      },
    },
  }
}

const f = (key: string, value: string): string => `--filter label=${key}=${value}`
const liveKey = `ps ${f(LABEL_PROJECT, 'shop')} --format {{.Label "${LABEL_THREAD}"}}`
const containersKey = `ps --all ${f(LABEL_PROJECT, 'shop')} ${f(LABEL_THREAD, THREAD)} --format {{.ID}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}`
const volumesKey = `volume ls ${f(LABEL_PROJECT, 'shop')} ${f(LABEL_THREAD, THREAD)} --format {{.Name}}\t{{.Label "${LABEL_VOLUME}"}}\t{{.Label "${LABEL_THREAD}"}}`
const sizesKey = 'system df -v --format json'

function deps(table: Record<string, Answer>, over: Partial<ThreadDataDeps> = {}) {
  const docker = fakeDocker(table)
  const stopped: string[] = []
  const d: ThreadDataDeps = {
    runner: docker.runner,
    groupsOf: async (id) => (id === THREAD ? [groupPlan()] : null),
    stopThreadDocker: async (id) => {
      stopped.push(id)
      return true
    },
    slugOf: () => 'shop',
    ...over,
  }
  return { deps: d, calls: docker.calls, stopped }
}

describe('readThreadData', () => {
  it('services with their state, volumes with sizes, the live mark and the shared folder by name only', async () => {
    const plan = groupPlan().plan
    const pg = plan.volumes.find((v) => v.original === 'pgdata')!.name
    const cache = plan.volumes.find((v) => v.original === 'cache')!.name
    const h = deps({
      [liveKey]: { stdout: `${THREAD}\n${THREAD}\n` },
      [containersKey]: { stdout: `c1\tdb\trunning\nc2\tredis\texited\n` },
      [volumesKey]: { stdout: `${pg}\tpgdata\t${THREAD}\n${cache}\tcache\t${THREAD}\n` },
      [sizesKey]: { stdout: JSON.stringify({ Volumes: [{ Name: pg, Size: '1GB' }, { Name: cache, Size: '84MB' }] }) },
    })
    const data = await readThreadData(h.deps, THREAD)
    expect(data).toMatchObject({
      threadId: THREAD,
      live: true,
      services: [
        { projectName: 'shop', service: 'db', state: 'running' },
        { projectName: 'shop', service: 'redis', state: 'exited' },
      ],
      volumes: [
        { volume: 'pgdata', service: 'db', sizeBytes: 1e9 },
        { volume: 'cache', service: 'redis', sizeBytes: 84e6 },
      ],
      totalBytes: 1e9 + 84e6,
      sharedFolders: ['uploads'],
      problem: null,
    })
    expect(JSON.stringify(data)).not.toContain('/srv/shared')
  })

  it('another thread live, no volumes yet: not live, nothing kept', async () => {
    const h = deps({ [liveKey]: { stdout: `${OTHER}\n` }, [containersKey]: { stdout: '' }, [volumesKey]: { stdout: '' } })
    const data = await readThreadData(h.deps, THREAD)
    expect(data).toMatchObject({ live: false, volumes: [], totalBytes: 0 })
    expect(data?.services.map((s) => s.state)).toEqual([null, null])
  })

  it('Docker not answering is a sentence, not a crash', async () => {
    const h = deps({ [liveKey]: { ok: false, code: 1 }, [containersKey]: { ok: false, code: 1 }, [volumesKey]: { ok: false, code: 1 } })
    const data = await readThreadData(h.deps, THREAD)
    expect(data?.problem).toBe(THREAD_DATA_SENTENCE.noAnswer)
    expect(data?.totalBytes).toBeNull()
  })

  it('a thread without Docker data reads as null and asks Docker nothing', async () => {
    // Positive first: the same harness does ask Docker for a thread with data.
    const control = deps({ [liveKey]: { ok: false, code: 1 }, [containersKey]: { ok: false, code: 1 }, [volumesKey]: { ok: false, code: 1 } })
    expect(await readThreadData(control.deps, THREAD)).not.toBeNull()
    expect(control.calls.length).toBeGreaterThan(0)
    const h = deps({})
    expect(await readThreadData(h.deps, OTHER)).toBeNull()
    expect(await readThreadData({ ...h.deps, groupsOf: async () => [] }, THREAD)).toBeNull()
    expect(h.calls).toEqual([])
  })
})

describe('emptyThreadDataOf', () => {
  it('refuses without an explicit confirmation — and asks Docker nothing, stops nothing', async () => {
    const h = deps({})
    for (const request of [{}, { confirmed: 'yes' }, { confirmed: 1 }, undefined]) {
      await expect(emptyThreadDataOf(h.deps, THREAD, request)).resolves.toEqual({ ok: false, detail: THREAD_DATA_SENTENCE.unconfirmed })
    }
    expect(h.calls).toEqual([])
    expect(h.stopped).toEqual([])
  })

  it('confirmed: stops the services first, then removes its containers and volumes', async () => {
    const plan = groupPlan().plan
    const pg = plan.volumes.find((v) => v.original === 'pgdata')!.name
    const h = deps({
      [containersKey]: { stdout: `c1\tdb\texited\n` },
      [volumesKey]: { stdout: `${pg}\tpgdata\t${THREAD}\n` },
      'rm c1': {},
      [`volume rm ${pg}`]: {},
    })
    await expect(emptyThreadDataOf(h.deps, THREAD, { confirmed: true })).resolves.toEqual({ ok: true })
    expect(h.stopped).toEqual([THREAD])
    expect(h.calls).toContain(`volume rm ${pg}`)
  })

  it('an unknown thread is refused with a sentence', async () => {
    const h = deps({})
    await expect(emptyThreadDataOf(h.deps, OTHER, { confirmed: true })).resolves.toEqual({ ok: false, detail: THREAD_DATA_SENTENCE.unknownThread })
    expect(h.stopped).toEqual([])
  })
})

describe('restartThreadDocker', () => {
  const scope: RunScope = { rootPath: ROOT, threadId: THREAD }
  const supervisor = (state: RunGroupState) => {
    const calls: unknown[] = []
    return {
      calls,
      port: {
        state: () => state,
        reload: async (_s: RunScope, key?: string, force?: boolean) => {
          calls.push({ reload: [key, force] })
          return state
        },
        startDocker: async (s: RunScope) => {
          calls.push({ startDocker: s })
          return state
        },
      },
    }
  }

  it('reloads each Docker step that started, and only those', async () => {
    const state: RunGroupState = {
      scopeKey: 'k',
      active: true,
      steps: [
        { key: `${ROOT}::docker:db`, name: 'db', projectRoot: ROOT, status: 'running', terminalId: 't1', exitCode: null, detail: null, docker: { projectRoot: ROOT, service: 'db' } },
        { key: `${ROOT}::web`, name: 'web', projectRoot: ROOT, status: 'running', terminalId: 't2', exitCode: null, detail: null },
      ],
    }
    const s = supervisor(state)
    await expect(restartThreadDocker(s.port, scope)).resolves.toEqual({ ok: true })
    expect(s.calls).toEqual([{ reload: [`${ROOT}::docker:db`, true] }])
  })

  it('nothing started yet: starts the thread’s Docker alone (starting is the switch)', async () => {
    const s = supervisor({ scopeKey: 'k', active: false, steps: [] })
    await restartThreadDocker(s.port, scope)
    expect(s.calls).toEqual([{ startDocker: scope }])
  })

  it('stopped steps (switched away, or emptied by Reset data) restart through the switch, so the data steps run again', async () => {
    const s = supervisor({
      scopeKey: 'k',
      active: false,
      steps: [
        { key: `${ROOT}::docker:db`, name: 'db', projectRoot: ROOT, status: 'stopped', terminalId: 't1', exitCode: null, detail: null, docker: { projectRoot: ROOT, service: 'db' } },
      ],
    })
    await restartThreadDocker(s.port, scope)
    expect(s.calls).toEqual([{ startDocker: scope }])
  })

  it('no thread: a sentence, nothing driven', async () => {
    const s = supervisor({ scopeKey: 'k', active: false, steps: [] })
    await expect(restartThreadDocker(s.port, null)).resolves.toMatchObject({ ok: false })
    expect(s.calls).toEqual([])
  })
})

describe('createLiveThreads', () => {
  it('asks only the projects with a Compose file, and reuses one answer for a few seconds', async () => {
    let clock = 0
    const h = fakeDocker({ [liveKey]: { stdout: `${THREAD}\n` } })
    const live = createLiveThreads({ runner: h.runner, composeRoots: async () => [ROOT], slugOf: () => 'shop', now: () => clock })
    await expect(live.read()).resolves.toEqual([THREAD])
    await expect(live.read()).resolves.toEqual([THREAD])
    expect(h.calls).toHaveLength(1)
    clock += LIVE_THREADS_TTL_MS
    await live.read()
    expect(h.calls).toHaveLength(2)
    live.forget()
    await live.read()
    expect(h.calls).toHaveLength(3)
  })

  it('no project with a Compose file: Docker is never asked', async () => {
    const h = fakeDocker({})
    const live = createLiveThreads({ runner: h.runner, composeRoots: async () => [] })
    await expect(live.read()).resolves.toEqual([])
    expect(h.calls).toEqual([])
  })
})

describe('readDockerElsewhere', () => {
  const elsewhereDeps = (runner: DockerRunner, over: Partial<Parameters<typeof readDockerElsewhere>[0]> = {}) => ({
    runner,
    rootsOf: () => [ROOT],
    hasCompose: async () => true,
    titleOf: (id: string) => (id === OTHER ? 'Invoice export' : null),
    slugOf: () => 'shop',
    ...over,
  })

  it('names the other thread whose data runs, by its title', async () => {
    const h = fakeDocker({ [liveKey]: { stdout: `${OTHER}\n` } })
    await expect(readDockerElsewhere(elsewhereDeps(h.runner), { rootPath: ROOT, threadId: THREAD })).resolves.toEqual({
      threadId: OTHER,
      title: 'Invoice export',
    })
  })

  it('an unknown thread has no title; this thread’s own data, none running or Docker silent are null', async () => {
    const unknown = fakeDocker({ [liveKey]: { stdout: 'gone-thread\n' } })
    await expect(readDockerElsewhere(elsewhereDeps(unknown.runner), { rootPath: ROOT, threadId: THREAD })).resolves.toEqual({
      threadId: 'gone-thread',
      title: null,
    })
    for (const answer of [{ stdout: `${THREAD}\n` }, { stdout: '' }, { ok: false, code: 1 }]) {
      const h = fakeDocker({ [liveKey]: answer })
      await expect(readDockerElsewhere(elsewhereDeps(h.runner), { rootPath: ROOT, threadId: THREAD })).resolves.toBeNull()
    }
  })

  it('never asks Docker for a project without a Compose file, nor for a scope with no thread', async () => {
    const asked = fakeDocker({ [liveKey]: { stdout: `${OTHER}\n` } })
    await readDockerElsewhere(elsewhereDeps(asked.runner), { rootPath: ROOT, threadId: THREAD })
    expect(asked.calls).toHaveLength(1)
    const h = fakeDocker({})
    await expect(readDockerElsewhere(elsewhereDeps(h.runner, { hasCompose: async () => false }), { rootPath: ROOT, threadId: THREAD })).resolves.toBeNull()
    await expect(readDockerElsewhere(elsewhereDeps(h.runner), { rootPath: ROOT, threadId: null })).resolves.toBeNull()
    expect(h.calls).toEqual([])
  })
})

describe('folderName', () => {
  it('is the last part of a path, never the path', () => {
    expect(folderName('/srv/shared/uploads')).toBe('uploads')
    expect(folderName('../media/')).toBe('media')
    expect(folderName('C:\\data\\files')).toBe('files')
  })
})
