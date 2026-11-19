/**
 * The drafts IPC channels: list canvases, read a layout, apply an edit, undo,
 * and save / list / restore named versions — plus the `drafts:changed`
 * broadcast from the drafts observer.
 *
 * Every input is validated at this boundary: the root must be one the renderer
 * may address (the readFile gate), canvas / screen / version names must be
 * slugs, files must pass the path rule, and an edit must pass
 * `validateDraftEdit`. A refusal is a sentence for a person, never a command.
 *
 * Writes to one canvas are serialized: two edits pressed in quick succession
 * each snapshot the file the other left, so undo walks back one at a time.
 */
import { timed } from '../ipc/slow-handler'
import type {
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '../../shared/ipc-contract'
import { isDraftSlug, resolveDraftPath, validateDraftEdit } from '../../shared/ui-drafts'
import type { RootsProvider } from '../flow/flow-observer'
import { applyDraftEdit } from './draft-edit'
import {
  listDraftCanvases,
  listDraftVersions,
  countDraftUndo,
  readDraftLayout,
  restoreDraftVersion,
  saveDraftVersion,
  undoDraft,
  undoDraftCanvas,
  type DraftStoreDeps,
} from './draft-store'
import { exposeE2EHandle } from '../e2e-seams'
import { DraftsObserver } from './drafts-observer'

export const PROJECT_NOT_OPEN = "That project isn't open."
export const NOT_A_CANVAS = 'That is not a canvas.'

export interface DraftChannelDeps {
  /** Roots the observer watches (adapter over the project registry). */
  roots: RootsProvider
  /** Whether the renderer may address this root — the same gate as readFile. */
  isKnownRoot: (rootPath: string) => boolean
  /** The store's filesystem, ledger and clock — passed explicitly (forbidden-pattern #15). */
  store: DraftStoreDeps
  /** Optional pre-built observer (tests). */
  observer?: DraftsObserver
}

/** Run writes for one key one after another; reads are never queued. */
export function serializeByKey(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.catch(() => undefined)
    tails.set(key, tail)
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key)
    })
    return run
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function registerDraftChannels(deps: DraftChannelDeps): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app, ipcMain, BrowserWindow } = require('electron') as typeof import('electron')

  const observer = deps.observer ?? new DraftsObserver(deps.roots, deps.store)
  observer.start()
  // A hidden end-to-end run drives an agent's rewrite through the observer's
  // own processing instead of waiting on the watcher (e2e-seams.ts).
  exposeE2EHandle('draftsObserver', observer, process.env, app.isPackaged)
  const registered: IpcInvokeChannel[] = []
  const serialized = serializeByKey()

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  function broadcast<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }

  /** The root and canvas of a request, or the sentence that refuses it. */
  function gate(request: { rootPath?: unknown; canvas?: unknown }): { ok: true; root: string; canvas: string } | { ok: false; reason: string } {
    if (!isText(request.rootPath) || !deps.isKnownRoot(request.rootPath)) return { ok: false, reason: PROJECT_NOT_OPEN }
    if (!isDraftSlug(request.canvas)) return { ok: false, reason: NOT_A_CANVAS }
    return { ok: true, root: request.rootPath, canvas: request.canvas }
  }

  handle('drafts:list', async (request) => {
    if (!isText(request?.rootPath) || !deps.isKnownRoot(request.rootPath)) return { canvases: [] }
    return { canvases: await listDraftCanvases(deps.store.fs, request.rootPath) }
  })

  handle('drafts:readLayout', async (request) => {
    const gated = gate(request ?? {})
    if (!gated.ok) return gated
    return readDraftLayout(deps.store.fs.readFile, gated.root, gated.canvas)
  })

  handle('drafts:applyEdit', async (request) => {
    const gated = gate(request ?? {})
    if (!gated.ok) return gated
    if (!isDraftSlug(request.screen)) return { ok: false, reason: 'That is not a screen of this canvas.' }
    const valid = validateDraftEdit(request.edit)
    if (!valid.ok) return valid
    const screen = request.screen
    return serialized(`${gated.root}\n${gated.canvas}`, () =>
      applyDraftEdit(
        { ...deps.store, isKnownRoot: deps.isKnownRoot },
        { root: gated.root, canvas: gated.canvas, screen, edit: valid.edit },
      ),
    )
  })

  handle('drafts:undo', async (request) => {
    const gated = gate(request ?? {})
    if (!gated.ok) return gated
    if (typeof request.file !== 'string' || !resolveDraftPath(gated.root, gated.canvas, request.file).ok) {
      return { ok: false, reason: 'That is not a file of this canvas.' }
    }
    const file = request.file
    return serialized(`${gated.root}\n${gated.canvas}`, () =>
      undoDraft(deps.store, { root: gated.root, canvas: gated.canvas, file }).catch((error) => {
        console.warn('[Drafts] undo failed', { canvas: gated.canvas, file, error })
        return { ok: false as const, reason: 'The change could not be undone.' }
      }),
    )
  })

  handle('drafts:undoCanvas', async (request) => {
    const gated = gate(request ?? {})
    if (!gated.ok) return gated
    return serialized(`${gated.root}\n${gated.canvas}`, () =>
      undoDraftCanvas(deps.store, { root: gated.root, canvas: gated.canvas }).catch((error) => {
        console.warn('[Drafts] canvas undo failed', { canvas: gated.canvas, error })
        return { ok: false as const, reason: 'The change could not be undone.' }
      }),
    )
  })

  handle('drafts:undoCount', async (request) => {
    const gated = gate(request ?? {})
    if (!gated.ok) return { count: 0 }
    return { count: await countDraftUndo(deps.store, gated.root, gated.canvas) }
  })

  handle('drafts:saveVersion', async (request) => {
    const gated = gate(request ?? {})
    if (!gated.ok) return gated
    if (typeof request.name !== 'string' || request.name.trim().length === 0 || request.name.length > 200) {
      return { ok: false, reason: 'A version needs a name.' }
    }
    const name = request.name
    return serialized(`${gated.root}\n${gated.canvas}`, () =>
      saveDraftVersion(deps.store, { root: gated.root, canvas: gated.canvas, name }),
    )
  })

  handle('drafts:listVersions', async (request) => {
    const gated = gate(request ?? {})
    if (!gated.ok) return { versions: [] }
    return { versions: await listDraftVersions(deps.store.fs, gated.root, gated.canvas) }
  })

  handle('drafts:restoreVersion', async (request) => {
    const gated = gate(request ?? {})
    if (!gated.ok) return gated
    if (!isDraftSlug(request.version)) return { ok: false, reason: 'That version does not exist.' }
    const version = request.version
    return serialized(`${gated.root}\n${gated.canvas}`, () =>
      restoreDraftVersion(deps.store, { root: gated.root, canvas: gated.canvas, version }).catch((error) => {
        console.warn('[Drafts] restore failed', { canvas: gated.canvas, version, error })
        return { ok: false as const, reason: 'This version could not be restored.' }
      }),
    )
  })

  const unsubscribe = observer.on((event) => broadcast('drafts:changed', event))

  return function disposeDraftChannels(): void {
    for (const channel of registered) ipcMain.removeHandler(channel)
    registered.length = 0
    unsubscribe()
    observer.dispose().catch((error) => console.error('[DraftsObserver] Dispose failed:', error))
  }
}
