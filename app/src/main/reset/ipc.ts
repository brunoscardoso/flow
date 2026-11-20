/**
 * reset:* — the three channels behind Settings › App › Reset Flow.
 *
 *   reset:inventory  what each item holds (read when the section opens)
 *   reset:schedule   record the reset and restart; the next launch deletes
 *   reset:outcome    the last reset's result, taken once
 *
 * `reset:schedule` refuses a request without `confirmed: true` or with an
 * unknown item, and deletes nothing itself.
 */
import { ipcMain } from 'electron'

import type { IpcInvokeChannel, IpcRequest, IpcResponse } from '../../shared/ipc-contract'
import { parseResetItems, type ResetInventory, type ResetItem, type ResetOutcome } from '../../shared/reset-items'
import { timed } from '../ipc/slow-handler'

export interface ResetIpcDependencies {
  inventory: () => Promise<ResetInventory>
  /** Write the pending reset and restart the app. */
  schedule: (items: ResetItem[]) => Promise<void>
  takeOutcome: () => ResetOutcome | null
}

export function registerResetChannels(deps: ResetIpcDependencies): () => void {
  const registered: IpcInvokeChannel[] = []
  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  handle('reset:inventory', () => deps.inventory())

  handle('reset:schedule', async (request) => {
    if ((request.confirmed as unknown) !== true) {
      return { ok: false as const, detail: 'A reset needs your confirmation.' }
    }
    const items = parseResetItems(request.items)
    if (items === null) return { ok: false as const, detail: 'Choose at least one kind of data to delete.' }
    try {
      await deps.schedule(items)
      return { ok: true as const }
    } catch (error) {
      return { ok: false as const, detail: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('reset:outcome', () => deps.takeOutcome())

  return function disposeResetChannels(): void {
    for (const channel of registered) ipcMain.removeHandler(channel)
    registered.length = 0
  }
}
