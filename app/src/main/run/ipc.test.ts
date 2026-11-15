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
      reload: async (scope, stepKey, force) => {
        calls.push({ reload: [scope, stepKey, force] })
        return empty(scope)
      },
      stop: async (scope) => {
        calls.push({ stop: scope })
        return empty(scope)
      },
      apply: async (scope) => {
        calls.push({ apply: scope })
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
    const runChannels = IPC_INVOKE_CHANNELS.filter((channel) => channel.startsWith('run:'))
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
