/**
 * THE RUN CHANNELS — every request is checked and rebuilt in main. Fakes only:
 * no supervisor process work, no fs.
 */
const mockHandlers = new Map<string, (event: unknown, request: unknown) => unknown>()
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, request: unknown) => unknown): void => {
      mockHandlers.set(channel, handler)
    },
    removeHandler: (channel: string): void => {
      mockHandlers.delete(channel)
    },
  },
}))

import { IPC_INVOKE_CHANNELS } from '../../shared/ipc-contract'
import { runScopeKey, type RunGroupState, type RunResolution, type RunSaveChange, type RunScope } from '../../shared/run-setup'
import { registerRunChannels, type RunChannelDependencies } from './ipc'
import { RunSetupError } from './run-setup-store'

const ROOT = '/projects/shop'
const CHECKOUT = '/projects/.shop-threads/blue'

function harness(options: { trusted?: boolean; saveError?: Error } = {}) {
  const calls: unknown[] = []
  let updated: ((state: RunGroupState) => void) | null = null
  const broadcasts: RunGroupState[] = []
  const resolution = (scope: RunScope): RunResolution => ({
    scope,
    scopeKey: runScopeKey(scope),
    project: { root: ROOT, name: 'shop', cwd: ROOT, setup: null, personal: {}, conversation: {}, hasSharedSetup: false, problems: [] },
    places: [],
    steps: [
      {
        key: `${ROOT}::web`,
        projectRoot: ROOT,
        projectName: 'shop',
        cwd: ROOT,
        id: 'web',
        name: 'Web',
        command: 'npm run dev',
        start: 'now',
        readyTimeoutMs: 60_000,
        from: { command: 'shared', ready: 'shared' },
      },
    ],
  })
  const empty = (scope: RunScope): RunGroupState => ({ scopeKey: runScopeKey(scope), active: false, steps: [] })
  const deps: RunChannelDependencies = {
    supervisor: {
      start: async (scope) => {
        calls.push({ start: scope })
        return empty(scope)
      },
      startDocker: async (scope) => {
        calls.push({ startDocker: scope })
        return empty(scope)
      },
      reload: async (scope, stepKey, force) => {
        calls.push({ reload: [scope, stepKey, force] })
        return empty(scope)
      },
      stop: async (scope, stepKey) => {
        calls.push(stepKey === undefined ? { stop: scope } : { stop: [scope, stepKey] })
        return empty(scope)
      },
      apply: async (scope) => {
        calls.push({ apply: scope })
        return empty(scope)
      },
      runOnce: async (scope, stepKey) => {
        calls.push({ once: [scope, stepKey] })
        return empty(scope)
      },
      state: (scope) => empty(scope),
      states: () => [],
      onUpdated: (listener) => {
        updated = listener
        return () => {
          updated = null
        }
      },
    },
    setups: {
      resolve: async (scope) => resolution(scope),
      save: async (scope: RunScope, change: RunSaveChange) => {
        calls.push({ save: [scope, change] })
        if (options.saveError) throw options.saveError
      },
    },
    suggest: async () => [],
    resolveRoot: (path) => (path === ROOT || path === CHECKOUT ? ROOT : null),
    isTrustedSender: () => options.trusted ?? true,
    broadcastUpdated: (state) => broadcasts.push(state),
    threadDocker: {
      read: async (threadId) => {
        calls.push({ dataRead: threadId })
        return null
      },
      elsewhere: async (scope) => {
        calls.push({ elsewhere: scope })
        return { threadId: 'other', title: 'Invoice export' }
      },
      restart: async (threadId) => {
        calls.push({ restart: threadId })
        return { ok: true }
      },
      reset: async (threadId, request) => {
        calls.push({ reset: [threadId, request.confirmed] })
        return request.confirmed === true ? { ok: true } : { ok: false, detail: 'needs confirmation' }
      },
      liveThreads: async () => {
        calls.push('liveThreads')
        return ['t1']
      },
    },
    keptData: {
      read: async () => {
        calls.push('keptRead')
        return { dockerAvailable: true, items: [] }
      },
      delete: async (request) => {
        calls.push({ keptDelete: [request.threadId, request.projectRoot, request.confirmed] })
        return request.confirmed === true ? { ok: true } : { ok: false, detail: 'needs confirmation' }
      },
    },
    threadVolumes: {
      read: async (threadId) => {
        calls.push({ volumesRead: threadId })
        return { count: 1, totalBytes: 10 }
      },
      release: async (threadId, request) => {
        calls.push({ volumesRelease: [threadId, request.confirmed] })
        return request.confirmed === true ? { ok: true } : { ok: false, detail: 'needs confirmation' }
      },
    },
    openDocker: async () => {
      calls.push('openDocker')
      return { ok: true, detail: '' }
    },
  }
  const dispose = registerRunChannels(deps)
  const call = (channel: string, request: unknown): Promise<unknown> =>
    Promise.resolve(mockHandlers.get(channel)!({}, request))
  return { calls, call, dispose, broadcasts, emit: (state: RunGroupState) => updated?.(state), isSubscribed: () => updated !== null }
}

afterEach(() => mockHandlers.clear())

describe('registerRunChannels', () => {
  it('registers every run:* invoke channel of the contract', () => {
    harness()
    const runChannels = IPC_INVOKE_CHANNELS.filter(
      (channel) => channel.startsWith('run:') || channel === 'threads:dataVolumes' || channel === 'threads:releaseDataVolumes',
    )
    expect([...mockHandlers.keys()].sort()).toEqual([...runChannels].sort())
  })

  it('refuses a caller outside the app window, and a root the renderer may not address', async () => {
    const outside = harness({ trusted: false })
    await expect(outside.call('run:start', { scope: { rootPath: ROOT, threadId: null } })).rejects.toThrow('not available here')
    expect(outside.calls).toEqual([])
    mockHandlers.clear()
    const h = harness()
    await expect(h.call('run:start', { scope: { rootPath: '/etc', threadId: null } })).rejects.toThrow('unknown scope.rootPath')
    expect(h.calls).toEqual([])
  })

  it("answers a thread's checkout as its project, and passes only the scope's two fields", async () => {
    const h = harness()
    await h.call('run:start', { scope: { rootPath: CHECKOUT, threadId: 't1', extra: 'x' } })
    expect(h.calls).toEqual([{ start: { rootPath: ROOT, threadId: 't1' } }])
  })

  it('run:once passes only the scope and the action key — never a command — and refuses a missing key', async () => {
    const h = harness()
    await h.call('run:once', { scope: { rootPath: CHECKOUT, threadId: 't1' }, stepKey: `${ROOT}::migrate`, command: 'rm -rf /' })
    expect(h.calls).toEqual([{ once: [{ rootPath: ROOT, threadId: 't1' }, `${ROOT}::migrate`] }])
    await expect(h.call('run:once', { scope: { rootPath: ROOT, threadId: null } })).rejects.toThrow('stepKey must be a non-empty string')
    expect(h.calls).toHaveLength(1)
  })

  it('run:get answers an unknown scope with its steps, all idle', async () => {
    const h = harness()
    const view = (await h.call('run:get', { scope: { rootPath: ROOT, threadId: null } })) as { state: RunGroupState }
    expect(view.state.steps).toEqual([
      { key: `${ROOT}::web`, name: 'Web', projectRoot: ROOT, status: 'idle', terminalId: null, exitCode: null, detail: null },
    ])
  })

  it('run:save rebuilds the combined list, keeps each id as sent, saves, then applies it to the Run', async () => {
    const h = harness()
    const answer = await h.call('run:save', {
      scope: { rootPath: ROOT, threadId: null },
      change: {
        layer: 'shared',
        steps: [
          { id: `${ROOT}::web`, name: 'Web', command: 'npm run dev', start: 'now', evil: true },
          { name: 'Worker', command: 'npm run worker', start: 'after-previous', runsIn: 'api' },
          { name: '' },
        ],
      },
    })
    expect(answer).toMatchObject({ ok: true })
    expect(h.calls).toEqual([
      {
        save: [
          { rootPath: ROOT, threadId: null },
          {
            layer: 'shared',
            steps: [
              { id: `${ROOT}::web`, name: 'Web', command: 'npm run dev', start: 'now' },
              { id: 'worker', name: 'Worker', command: 'npm run worker', start: 'after-previous', runsIn: 'api' },
            ],
          },
        ],
      },
      { apply: { rootPath: ROOT, threadId: null } },
    ])
  })

  it('run:save refuses a retired layer and a change with no list', async () => {
    const h = harness()
    await expect(
      h.call('run:save', { scope: { rootPath: ROOT, threadId: 't1' }, change: { layer: 'conversation', tweaks: {} } }),
    ).rejects.toThrow('change.layer')
    await expect(
      h.call('run:save', { scope: { rootPath: ROOT, threadId: null }, change: { layer: 'shared', steps: 'all' } }),
    ).rejects.toThrow('change.steps')
    expect(h.calls).toEqual([])
  })

  it('a refused save answers its sentence and applies nothing', async () => {
    const h = harness({ saveError: new RunSetupError('That project is not part of this Run, so nothing was saved.') })
    const answer = await h.call('run:save', {
      scope: { rootPath: ROOT, threadId: null },
      change: { layer: 'shared', steps: [] },
    })
    expect(answer).toEqual({ ok: false, reason: 'That project is not part of this Run, so nothing was saved.' })
    expect(h.calls.some((c) => typeof c === 'object' && c !== null && 'apply' in c)).toBe(false)
  })

  it('run:reload passes the step and force only as an explicit true', async () => {
    const h = harness()
    await h.call('run:reload', { scope: { rootPath: ROOT, threadId: null }, stepKey: `${ROOT}::web`, force: 'yes' })
    await h.call('run:reload', { scope: { rootPath: ROOT, threadId: null }, force: true })
    expect(h.calls).toEqual([
      { reload: [{ rootPath: ROOT, threadId: null }, `${ROOT}::web`, false] },
      { reload: [{ rootPath: ROOT, threadId: null }, undefined, true] },
    ])
  })

  it('run:stop stops one step when a step is named, and every step when none is', async () => {
    const h = harness()
    await h.call('run:stop', { scope: { rootPath: ROOT, threadId: null }, stepKey: `${ROOT}::web` })
    await h.call('run:stop', { scope: { rootPath: ROOT, threadId: null } })
    expect(h.calls).toEqual([
      { stop: [{ rootPath: ROOT, threadId: null }, `${ROOT}::web`] },
      { stop: { rootPath: ROOT, threadId: null } },
    ])
    await expect(h.call('run:stop', { scope: { rootPath: ROOT, threadId: null }, stepKey: '' })).rejects.toThrow(
      'stepKey must be a non-empty string',
    )
  })

  it('broadcasts the supervisor updates, and dispose removes handlers and the subscription', () => {
    const h = harness()
    const state: RunGroupState = { scopeKey: 'k', active: true, steps: [] }
    h.emit(state)
    expect(h.broadcasts).toEqual([state])
    h.dispose()
    expect(mockHandlers.size).toBe(0)
    expect(h.isSubscribed()).toBe(false)
  })
})

describe('the conversation’s own data channels', () => {
  it('run:startDocker starts the Docker group of a scope, a checkout answered as its project', async () => {
    const h = harness()
    await h.call('run:startDocker', { scope: { rootPath: CHECKOUT, threadId: 't1' } })
    expect(h.calls).toEqual([{ startDocker: { rootPath: ROOT, threadId: 't1' } }])
    await expect(h.call('run:startDocker', { scope: { rootPath: '/etc', threadId: 't1' } })).rejects.toThrow('unknown scope.rootPath')
    expect(h.calls).toHaveLength(1)
  })

  it('run:dockerElsewhere reads for a conversation scope only', async () => {
    const h = harness()
    await expect(h.call('run:dockerElsewhere', { scope: { rootPath: ROOT, threadId: 't1' } })).resolves.toEqual({
      threadId: 'other',
      title: 'Invoice export',
    })
    expect(h.calls).toEqual([{ elsewhere: { rootPath: ROOT, threadId: 't1' } }])
    await expect(h.call('run:dockerElsewhere', { scope: { rootPath: ROOT, threadId: null } })).resolves.toBeNull()
    expect(h.calls).toHaveLength(1)
  })

  it('threads:dataVolumes reads one thread; threads:releaseDataVolumes relays confirmed only when it is exactly true', async () => {
    const h = harness()
    await expect(h.call('threads:dataVolumes', { threadId: 't1' })).resolves.toEqual({ count: 1, totalBytes: 10 })
    await h.call('threads:releaseDataVolumes', { threadId: 't1', confirmed: true })
    await h.call('threads:releaseDataVolumes', { threadId: 't1', confirmed: 'yes' })
    await h.call('threads:releaseDataVolumes', { threadId: 't1' })
    expect(h.calls).toEqual([
      { volumesRead: 't1' },
      { volumesRelease: ['t1', true] },
      { volumesRelease: ['t1', undefined] },
      { volumesRelease: ['t1', undefined] },
    ])
    await expect(h.call('threads:dataVolumes', {})).rejects.toThrow('threadId must be a non-empty string')
  })

  it('the panel channels read one thread, and reset relays confirmed only when it is exactly true', async () => {
    const h = harness()
    await expect(h.call('run:threadData', { threadId: 't1' })).resolves.toBeNull()
    await h.call('run:restartThreadDocker', { threadId: 't1' })
    await h.call('run:emptyThreadData', { threadId: 't1', confirmed: true })
    await h.call('run:emptyThreadData', { threadId: 't1', confirmed: 1 })
    await expect(h.call('run:liveThreads', {})).resolves.toEqual(['t1'])
    expect(h.calls).toEqual([{ dataRead: 't1' }, { restart: 't1' }, { reset: ['t1', true] }, { reset: ['t1', undefined] }, 'liveThreads'])
    await expect(h.call('run:emptyThreadData', {})).rejects.toThrow('threadId must be a non-empty string')
  })

  it('the kept data channels read, and delete relays confirmed only when exactly true, in a project the renderer may address', async () => {
    const h = harness()
    await expect(h.call('run:keptData', {})).resolves.toEqual({ dockerAvailable: true, items: [] })
    await h.call('run:deleteKeptData', { threadId: 'gone', projectRoot: CHECKOUT, confirmed: true })
    await h.call('run:deleteKeptData', { threadId: 'gone', projectRoot: ROOT, confirmed: 'yes' })
    expect(h.calls).toEqual(['keptRead', { keptDelete: ['gone', ROOT, true] }, { keptDelete: ['gone', ROOT, undefined] }])
    await expect(h.call('run:deleteKeptData', { projectRoot: ROOT })).rejects.toThrow('threadId must be a non-empty string')
    await expect(h.call('run:deleteKeptData', { threadId: 'gone' })).rejects.toThrow('projectRoot must be a non-empty string')
    expect(h.calls).toHaveLength(3)
  })

  it('run:openDocker opens Docker', async () => {
    const h = harness()
    await expect(h.call('run:openDocker', {})).resolves.toEqual({ ok: true, detail: '' })
    expect(h.calls).toEqual(['openDocker'])
  })
})
