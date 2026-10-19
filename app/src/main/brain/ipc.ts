// Brain IPC channels — the single interface the renderer/agent uses to read the
// knowledge store (#52): `brain:query` (retrieval).
//
// Writes are a MAIN-PROCESS concern and never had a renderer route: capture
// runs on turn-complete (makeBrainCaptureOnTurnComplete in ./capture) and
// compaction promotes survivors — neither goes through IPC.

import { ipcMain } from 'electron'
import { timed } from '../ipc/slow-handler'

import type {
  BrainQueryResult,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '../../shared/ipc-contract'
import type { RootsProvider } from '../flow/flow-observer'
import { searchBrain } from './query'

export interface BrainChannelDependencies {
  roots: RootsProvider
}

/** True when `rootId` is a known project root (rootId === absolute rootPath). */
function isKnownRoot(roots: RootsProvider, rootId: string): boolean {
  return roots.getRoots().some((root) => root.rootPath === rootId)
}

/**
 * Register the brain read invoke handlers. Returns a dispose function
 * that unregisters them (mirrors the other domain registrars).
 */
export function registerBrainChannels(deps: BrainChannelDependencies): () => void {
  const { roots } = deps
  const registered: IpcInvokeChannel[] = []

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  handle('brain:query', async ({ rootId, query, limit }): Promise<BrainQueryResult> => {
    if (!isKnownRoot(roots, rootId)) {
      throw new Error(`[Brain] Unknown root: ${rootId}`)
    }
    return searchBrain(rootId, query, limit)
  })

  return function disposeBrainChannels(): void {
    for (const channel of registered) {
      ipcMain.removeHandler(channel)
    }
    registered.length = 0
  }
}
