// Review IPC — the review:* channels for the phase-grouped review panel.

import { ipcMain } from 'electron'
import { timed } from '../ipc/slow-handler'

import type {
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '../../shared/ipc-contract'
import type { ReviewService } from './review-service'

export interface ReviewIpcDependencies {
  reviewService: ReviewService
  /** Manual commit mode (#67): AI-generate a message for the approved files. */
  generateCommitMessage: (rootPath: string, filePaths: string[]) => Promise<string | null>
}

export function registerReviewChannels(deps: ReviewIpcDependencies): () => void {
  const { reviewService, generateCommitMessage } = deps
  const registered: IpcInvokeChannel[] = []

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  handle('review:list', ({ rootPath }) => reviewService.list(rootPath))
  handle('review:reject', ({ rootPath, filePath }) => reviewService.reject(rootPath, filePath))
  handle('review:generateCommitMessage', async ({ rootPath, filePaths }) => ({
    message: await generateCommitMessage(rootPath, filePaths),
  }))

  return function disposeReviewChannels(): void {
    for (const channel of registered) {
      ipcMain.removeHandler(channel)
    }
    registered.length = 0
  }
}
