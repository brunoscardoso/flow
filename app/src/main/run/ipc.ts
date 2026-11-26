// Run IPC channels — the renderer's whole route to a project's Run.
//
// Every request is checked HERE and rebuilt field by field before it reaches
// the supervisor or the setup store: only the app window may call, a scope's
// root must be one the renderer may address (a thread's checkout is answered
// as its project), and a saved step list is re-parsed so nothing the
// renderer invented is written. The supervisor is the one owner of every Run
// (allowed-pattern #14); these handlers only translate.

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { IpcInvokeChannel, IpcRequest, IpcResponse, ThreadDataVolumesSummary } from '../../shared/ipc-contract'
import {
  parseRunSaveSteps,
  type RunDockerElsewhere,
  type RunGroupState,
  type RunKeptData,
  type RunOpenDockerAnswer,
  type RunResolution,
  type RunSaveChange,
  type RunScope,
  type RunSuggestion,
  type RunThreadData,
  type RunThreadDataAnswer,
  type RunView,
} from '../../shared/run-setup'
import { timed } from '../ipc/slow-handler'
import { RunSetupError } from './run-setup-store'
import { idleGroupState, type RunSupervisor } from './run-supervisor'

export interface RunChannelDependencies {
  supervisor: Pick<RunSupervisor, 'start' | 'startDocker' | 'reload' | 'stop' | 'apply' | 'state' | 'states' | 'onUpdated' | 'runOnce'>
  setups: {
    resolve(scope: RunScope): Promise<RunResolution>
    save(scope: RunScope, change: RunSaveChange): Promise<void>
  }
  suggest(scope: RunScope): Promise<RunSuggestion[]>
  /**
   * REQUIRED (allowed-pattern #26): the PROJECT root for a path the renderer
   * may address, or null when it may not address it at all.
   */
  resolveRoot: (rootPath: string) => string | null
  /** REQUIRED: only the app window's own top frame may drive a Run. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
  broadcastUpdated: (state: RunGroupState) => void
  /**
   * The Manage containers panel, the thread list's live mark and the Run
   * menu's Docker section: read while on screen, Restart, and Reset (which
   * runs nothing unless confirmed).
   */
  threadDocker: {
    read(threadId: string): Promise<RunThreadData | null>
    /** Whose data runs instead of this conversation's — asked when the Run menu opens. */
    elsewhere(scope: RunScope): Promise<RunDockerElsewhere | null>
    restart(threadId: string): Promise<RunThreadDataAnswer>
    reset(threadId: string, request: { confirmed?: unknown }): Promise<RunThreadDataAnswer>
    liveThreads(): Promise<string[]>
  }
  /**
   * A conversation's Docker data at delete time: read when the delete confirm
   * opens; release stops its services if live, then removes its volumes.
   */
  threadVolumes: {
    read(threadId: string): Promise<ThreadDataVolumesSummary | null>
    release(threadId: string, request: { confirmed?: unknown }): Promise<{ ok: boolean; detail?: string }>
  }
  /**
   * Docker data kept from deleted threads, for the Storage page: read while the
   * page is open; delete runs nothing unless confirmed and refuses a thread
   * that still exists.
   */
  keptData: {
    read(): Promise<RunKeptData>
    delete(request: { threadId: string; projectRoot: string; confirmed?: unknown }): Promise<RunThreadDataAnswer>
  }
  /** Open Docker, when the Docker group could not start because it is not running. */
  openDocker: () => Promise<RunOpenDockerAnswer>
}

/** A refused request — the renderer sent something main will not act on. */
export class RunRequestError extends Error {
  constructor(channel: string, what: string) {
    super(`${channel}: ${what}`)
    this.name = 'RunRequestError'
  }
}

const MAX_FIELD_LENGTH = 4096
/** A setup far larger than any real one, well inside one IPC message. */
const MAX_SETUP_JSON = 256 * 1024

function record(value: unknown, channel: string, field = 'request'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RunRequestError(channel, `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, channel: string, field: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_FIELD_LENGTH) {
    throw new RunRequestError(channel, `${field} must be a non-empty string`)
  }
  return value
}

/** The view a panel draws: an unknown scope reads as its steps, all idle. */
export function viewOf(resolution: RunResolution, state: RunGroupState): RunView {
  return {
    resolution,
    state: state.steps.length === 0 && !state.active ? idleGroupState(resolution.scopeKey, resolution.steps) : state,
  }
}

export function registerRunChannels(deps: RunChannelDependencies): () => void {
  const { supervisor, setups } = deps
  const registered: IpcInvokeChannel[] = []

  function scopeOf(raw: unknown, channel: string): RunScope {
    const scope = record(raw, channel, 'scope')
    const asked = requiredString(scope['rootPath'], channel, 'scope.rootPath')
    const rootPath = deps.resolveRoot(asked)
    if (rootPath === null) throw new RunRequestError(channel, 'unknown scope.rootPath')
    const threadId = scope['threadId']
    if (threadId === null || threadId === undefined) return { rootPath, threadId: null }
    return { rootPath, threadId: requiredString(threadId, channel, 'scope.threadId') }
  }

  function changeOf(raw: unknown, channel: string): RunSaveChange {
    const change = record(raw, channel, 'change')
    if (change['layer'] !== 'shared') throw new RunRequestError(channel, 'change.layer must be shared')
    let text: string
    try {
      text = JSON.stringify(change['steps'] ?? null)
    } catch {
      throw new RunRequestError(channel, 'change.steps could not be read')
    }
    if (text.length > MAX_SETUP_JSON) throw new RunRequestError(channel, 'change.steps is too large')
    if (!Array.isArray(change['steps'])) throw new RunRequestError(channel, 'change.steps must be a list')
    return { layer: 'shared', steps: parseRunSaveSteps(JSON.parse(text) as unknown) }
  }

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: Record<string, unknown>) => Promise<IpcResponse<C>> | IpcResponse<C>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (event, request: IpcRequest<C>) =>
      timed(channel, async (req: unknown) => {
        let trusted = false
        try {
          trusted = deps.isTrustedSender(event)
        } catch {
          trusted = false
        }
        if (!trusted) {
          console.warn('[Run] refused a call from outside the app window', { channel })
          throw new RunRequestError(channel, 'not available here')
        }
        return handler(record(req ?? {}, channel))
      })(request),
    )
  }

  handle('run:get', async (request) => {
    const scope = scopeOf(request['scope'], 'run:get')
    const resolution = await setups.resolve(scope)
    return viewOf(resolution, supervisor.state(scope))
  })

  handle('run:save', async (request) => {
    const channel = 'run:save'
    const scope = scopeOf(request['scope'], channel)
    const change = changeOf(request['change'], channel)
    try {
      await setups.save(scope, change)
    } catch (error) {
      if (error instanceof RunSetupError) return { ok: false, reason: error.message }
      console.warn('[Run] saving a setup failed', error)
      return { ok: false, reason: 'The setup could not be saved. Nothing was changed.' }
    }
    const state = await supervisor.apply(scope)
    const resolution = await setups.resolve(scope)
    return { ok: true, view: viewOf(resolution, state) }
  })

  handle('run:suggest', (request) => deps.suggest(scopeOf(request['scope'], 'run:suggest')))

  handle('run:start', (request) => supervisor.start(scopeOf(request['scope'], 'run:start')))

  // Start Docker / Switch to this thread: the conversation's Docker group
  // alone, through the switch. Local steps are left as they are.
  handle('run:startDocker', (request) => supervisor.startDocker(scopeOf(request['scope'], 'run:startDocker')))

  handle('run:reload', (request) => {
    const channel = 'run:reload'
    const scope = scopeOf(request['scope'], channel)
    const stepKey = request['stepKey'] === undefined ? undefined : requiredString(request['stepKey'], channel, 'stepKey')
    const force = request['force'] === true
    return supervisor.reload(scope, stepKey, force)
  })

  handle('run:stop', (request) => {
    const channel = 'run:stop'
    const scope = scopeOf(request['scope'], channel)
    const stepKey = request['stepKey'] === undefined ? undefined : requiredString(request['stepKey'], channel, 'stepKey')
    return supervisor.stop(scope, stepKey)
  })

  // A person pressed a one-time action in the Launchpad menu. Only its key
  // crosses: the command is read from the person's own saved setup here, never
  // taken from the renderer.
  handle('run:once', (request) => {
    const channel = 'run:once'
    const scope = scopeOf(request['scope'], channel)
    return supervisor.runOnce(scope, requiredString(request['stepKey'], channel, 'stepKey'))
  })

  handle('run:states', () => supervisor.states())

  // THE CONVERSATION'S OWN DATA. A project root the renderer names is checked
  // here like a scope's.
  function projectRootOf(request: Record<string, unknown>, channel: string, field = 'rootPath'): string {
    const rootPath = deps.resolveRoot(requiredString(request[field], channel, field))
    if (rootPath === null) throw new RunRequestError(channel, `unknown ${field}`)
    return rootPath
  }

  handle('run:openDocker', () => deps.openDocker())

  // Read only, and only for a conversation scope: whose data a switch would stop.
  handle('run:dockerElsewhere', async (request) => {
    const scope = scopeOf(request['scope'], 'run:dockerElsewhere')
    return scope.threadId === null ? null : deps.threadDocker.elsewhere(scope)
  })

  // A CONVERSATION'S DATA AT DELETE TIME. `confirmed` must be the boolean
  // true; anything else reaches main's release as a refusal that runs nothing.
  function threadIdOf(request: Record<string, unknown>, channel: string): string {
    return requiredString(request['threadId'], channel, 'threadId')
  }

  handle('threads:dataVolumes', (request) => deps.threadVolumes.read(threadIdOf(request, 'threads:dataVolumes')))

  handle('threads:releaseDataVolumes', (request) =>
    deps.threadVolumes.release(threadIdOf(request, 'threads:releaseDataVolumes'), {
      confirmed: request['confirmed'] === true ? true : undefined,
    }),
  )

  // THE MANAGE CONTAINERS PANEL. `confirmed` must be the boolean true;
  // anything else reaches main's reset as a refusal that runs nothing.
  handle('run:threadData', (request) => deps.threadDocker.read(threadIdOf(request, 'run:threadData')))

  handle('run:restartThreadDocker', (request) =>
    deps.threadDocker.restart(threadIdOf(request, 'run:restartThreadDocker')),
  )

  handle('run:emptyThreadData', (request) =>
    deps.threadDocker.reset(threadIdOf(request, 'run:emptyThreadData'), {
      confirmed: request['confirmed'] === true ? true : undefined,
    }),
  )

  handle('run:keptData', () => deps.keptData.read())

  handle('run:deleteKeptData', (request) => {
    const channel = 'run:deleteKeptData'
    return deps.keptData.delete({
      threadId: threadIdOf(request, channel),
      projectRoot: projectRootOf(request, channel, 'projectRoot'),
      confirmed: request['confirmed'] === true ? true : undefined,
    })
  })

  handle('run:liveThreads', () => deps.threadDocker.liveThreads())

  const unsubscribe = supervisor.onUpdated((state) => deps.broadcastUpdated(state))

  return function disposeRunChannels(): void {
    unsubscribe()
    for (const channel of registered) ipcMain.removeHandler(channel)
    registered.length = 0
  }
}
