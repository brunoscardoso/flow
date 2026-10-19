// Share IPC channels — the renderer's whole route to feature view sharing.
//
// `share:get | check | publish | update | revoke | views`, each answering share STATE
// or a refusal with one plain sentence. The session token that authorises the
// requests lives inside the client in main; nothing registered here can return
// it, because nothing here ever holds it.

import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { IpcInvokeChannel, IpcRequest, IpcResponse, ShareRefusal } from '../../shared/ipc-contract'
import { timed } from '../ipc/slow-handler'
import { refusal, type ShareClient } from './share-client'
import { errorCode } from './share-file-guard'

export interface ShareChannelDependencies {
  client: ShareClient
  /**
   * REQUIRED (allowed-pattern #26): whether this invoke came from the app's own
   * top-level renderer frame. Nothing else can reach these channels today —
   * the walkthrough iframe has no preload — but a share call publishes files
   * and reads who opened them, so the check is cheap defense in depth.
   */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

/** The minimum of an invoke event the sender check reads. */
export interface ShareSenderEvent {
  senderFrame: unknown
  sender: { mainFrame: unknown }
}

/**
 * True only when the invoke was sent by the TOP frame of a window this app
 * owns, SHOWING THE APP'S OWN PAGE: `senderFrame` is that webContents'
 * `mainFrame` (never a subframe, never a frame already gone — a null
 * `senderFrame` means it navigated or was destroyed), `isAppWindow` recognises
 * the webContents, and the frame's URL is the app's own renderer entry
 * (`isAppUrl`, review R2-M8) — so a window that was somehow navigated elsewhere
 * keeps its preload but not its share access.
 */
export function isAppMainFrame<E extends ShareSenderEvent>(
  event: E,
  isAppWindow: (sender: E['sender']) => boolean,
  isAppUrl: (url: string) => boolean,
): boolean {
  const frame = event.senderFrame
  if (frame === null || frame === undefined) return false
  if (frame !== event.sender.mainFrame) return false
  const url = (frame as { url?: unknown }).url
  if (typeof url !== 'string' || !isAppUrl(url)) return false
  return isAppWindow(event.sender)
}

/**
 * Register the share invoke handlers. Returns a dispose function that
 * unregisters them (mirrors the other domain registrars).
 */
export function registerShareChannels(deps: ShareChannelDependencies): () => void {
  const { client, isTrustedSender } = deps
  const registered: IpcInvokeChannel[] = []

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (event, request: IpcRequest<C>) =>
      timed(channel, async (req: IpcRequest<C>) => {
        let trusted = false
        try {
          trusted = isTrustedSender(event)
        } catch (error) {
          console.warn('[Share] sender check failed; refusing', { channel, code: errorCode(error) })
        }
        if (!trusted) {
          // Refused before the client is touched: no file read, no request.
          console.warn('[Share] refused a share call from outside the app window', { channel })
          return refusal('unavailable') as unknown as IpcResponse<C>
        }
        try {
          return await handler(req ?? ({} as IpcRequest<C>))
        } catch (error) {
          // The client does not throw by design; if it ever does, the surface
          // gets a sentence and the log gets the cause — never a stack trace
          // across IPC, never silence.
          console.error('[Share] handler failed', { channel, code: errorCode(error) })
          // Every share channel's response union includes ShareRefusal.
          const failed: ShareRefusal = refusal('unavailable')
          return failed as unknown as IpcResponse<C>
        }
      })(request),
    )
  }

  handle('share:get', ({ rootPath, docPath }) => client.get(rootPath, docPath))
  handle('share:check', ({ rootPath, docPath }) => client.check(rootPath, docPath))
  handle('share:publish', (request) => client.publish(request))
  handle('share:update', (request) => client.updateAccess(request))
  handle('share:revoke', (request) => client.revoke(request))
  handle('share:views', ({ id }) => client.views(id))

  return function disposeShareChannels(): void {
    for (const channel of registered) {
      ipcMain.removeHandler(channel)
    }
    registered.length = 0
  }
}
