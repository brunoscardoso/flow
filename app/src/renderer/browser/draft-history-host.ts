/**
 * THE HOST SIDE OF UNDO AND VERSIONS — DOM-free, so it is tested apart from the
 * webview. The canvas page asks (`DraftHistoryRequest`); this runs the matching
 * drafts verb for the project and canvas the PAGE ADDRESS names, and answers
 * with what the page should show and which files it must reload (Flow's own
 * writes are not broadcast as `drafts:changed`).
 *
 * Failures never reach the page as a path or an exception: each is a short
 * sentence.
 */
import type { DraftHistoryRequest, DraftHistoryState } from '../../shared/draft-history-messages'
import type { FlowDraftsApi } from '../../shared/ipc-contract'

export type DraftHistoryApi = Pick<
  FlowDraftsApi,
  'undoCanvas' | 'undoCount' | 'saveVersion' | 'listVersions' | 'restoreVersion'
>

export interface DraftHistoryTarget {
  rootPath: string
  canvas: string
}

export interface DraftHistoryOutcome {
  /** What the page should show next. */
  state: DraftHistoryState
  /** Canvas files that changed on disk and must be reloaded in the page. */
  files: string[]
}

export const UNDO_FAILED = 'The change could not be undone.'
export const SAVE_FAILED = 'The version could not be saved.'
export const RESTORE_FAILED = 'This version could not be restored.'

async function undoCountOf(api: DraftHistoryApi, target: DraftHistoryTarget): Promise<number | undefined> {
  try {
    return (await api.undoCount(target)).count
  } catch (error) {
    console.warn('flow: draft undo count failed', error)
    return undefined
  }
}

/** The count the page needs after a load or a change. */
export async function readDraftHistoryState(api: DraftHistoryApi, target: DraftHistoryTarget): Promise<DraftHistoryState> {
  const undoCount = await undoCountOf(api, target)
  return undoCount === undefined ? {} : { undoCount }
}

async function withCount(api: DraftHistoryApi, target: DraftHistoryTarget, state: DraftHistoryState): Promise<DraftHistoryState> {
  const undoCount = await undoCountOf(api, target)
  return undoCount === undefined ? state : { ...state, undoCount }
}

/**
 * Run one request. `panelOpen` says whether the side edit panel shows an
 * element: after an undo or a restore the page then re-reads that element.
 */
export async function runDraftHistory(
  api: DraftHistoryApi,
  target: DraftHistoryTarget,
  request: DraftHistoryRequest,
  options: { panelOpen: boolean },
): Promise<DraftHistoryOutcome> {
  try {
    switch (request.op) {
      case 'list': {
        const { versions } = await api.listVersions(target)
        return { state: await withCount(api, target, { versions }), files: [] }
      }
      case 'undo': {
        const answer = await api.undoCanvas(target)
        if (!answer.ok) return { state: await withCount(api, target, { error: answer.reason }), files: [] }
        return {
          state: await withCount(api, target, { done: 'undo', ...(options.panelOpen ? { refresh: true } : {}) }),
          files: answer.files,
        }
      }
      case 'save': {
        const answer = await api.saveVersion({ ...target, name: request.name })
        if (!answer.ok) return { state: { error: answer.reason }, files: [] }
        const { versions } = await api.listVersions(target)
        return { state: { done: 'save', versions }, files: [] }
      }
      case 'restore': {
        const answer = await api.restoreVersion({ ...target, version: request.version })
        if (!answer.ok) return { state: { error: answer.reason }, files: [] }
        return {
          state: await withCount(api, target, { done: 'restore', ...(options.panelOpen ? { refresh: true } : {}) }),
          files: answer.files,
        }
      }
    }
  } catch (error) {
    console.warn('flow: draft history failed', { op: request.op, error })
    const reason = request.op === 'undo' ? UNDO_FAILED : request.op === 'save' ? SAVE_FAILED : RESTORE_FAILED
    return { state: { error: reason }, files: [] }
  }
}

/** The script the browser runs in the canvas page: the page's own door, with the state as data. */
export function draftHistoryScript(state: DraftHistoryState): string {
  return `window.flowCanvas && window.flowCanvas.history ? window.flowCanvas.history(${JSON.stringify(state)}) : null`
}

/**
 * Runs history requests one after another: a second press of Undo waits for
 * the first, so each step is one change.
 */
export function createHistoryQueue(): (task: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}
