/**
 * Project-context coordinator (ADR-002) — binds the editor + file tree +
 * terminals to the active project, and the editor's tabs to the active
 * CONVERSATION.
 *
 * Each thread separates the work: files, unsaved buffers, scratch notes and the
 * views that belong to a set (feature views, the blueprint, the browser, the
 * Changes tab) opened while a conversation is selected are that conversation's
 * tab set, persisted in main per (project, thread) and restored when it is
 * selected again — across restarts too. With no conversation selected the
 * project shows its own, project-level set.
 *
 * Two signals move the set on screen:
 *   - `project:activeChanged` — a project switch (thread select in
 *     another project, the titlebar switcher, boot restore), carrying the
 *     project's last-active conversation;
 *   - `flow:active-thread` — a conversation selected or cleared in this project.
 * On either, the outgoing set (snapshot still reflects it) is saved, the editor
 * closes it silently, and the incoming set is loaded and rebuilt. The decisions
 * live in `tab-scope-model.ts`; switches are serialized here.
 *
 * Ongoing tab opens/closes are persisted via `editorApi.onTabsChanged`. A
 * `switching` guard prevents the rebuild's own tab churn from persisting.
 *
 * Thread ↔ project coordination (selecting a thread switches its project, and
 * a project switch re-selects that project's last thread) lives in
 * threads/index.ts.
 */
import type { ProjectContext, TabSet } from '../shared/ipc-contract'
import type { EditorApi } from './editor'
import type { TerminalPanelController } from './terminal/terminal-panel'
import {
  TAB_SCOPE_EVENT,
  planTabSwitch,
  sameScope,
  scopeForProject,
  scopeForThreadSignal,
  type TabScopeKey,
} from './tab-scope-model'
import { tabScopeGate } from './tab-scope-gate'

/** How long a press may wait for another project's activation to arrive
 *  after one of its conversations was selected. */
const ACTIVATION_WAIT_MS = 3000

export interface ProjectContextDeps {
  editorApi: EditorApi
  terminals: TerminalPanelController
}

export function initProjectContext(deps: ProjectContextDeps): void {
  const api = window.flow
  if (!api?.project) {
    console.warn('flow: project bridge missing — project context disabled')
    return
  }
  const { editorApi, terminals } = deps

  /**
   * EACH CONVERSATION HAS ITS OWN TABS. `shown` is the set on screen; `wanted`
   * the set last asked for. Switches run one at a time on `chain`, and a switch
   * that finds `wanted` moved on while it was loading stops — the next queued
   * one finishes the job (the editor's own switch token guards the rest).
   */
  let shown: TabScopeKey | null = null
  let wanted: TabScopeKey | null = null
  let latestContext: ProjectContext | null = null
  let chain: Promise<void> = Promise.resolve()
  let switching = false
  /**
   * True only while the editor is REBUILDING the incoming set — its tabs are
   * then neither the outgoing set nor yet the incoming one, so nothing may be
   * captured from them. While a switch is merely waiting on `loadTabSet` the
   * editor still shows `shown` in full, and that is safe to capture.
   */
  let rebuilding = false
  /** The outgoing set's write, so a flush can wait for it (#1443). */
  let outgoingSave: Promise<void> = Promise.resolve()

  /** Save one set. Returns the write's promise so a caller that must not run
   *  ahead of it (the quit flush, #1443) can await. */
  function save(scope: TabScopeKey, set: TabSet): Promise<void> {
    return api.project
      .saveTabSet({ rootPath: scope.rootPath, threadId: scope.threadId, ...set })
      .catch((error: unknown) => console.warn('flow: failed to persist open tabs', error))
  }

  /** Save what is on screen now, under the set it belongs to. */
  function persistShown(): Promise<void> {
    // Unsaved buffer contents ride along (#955) so switching away never
    // destroys typed work — the set's restore rehydrates them on return.
    return shown === null ? Promise.resolve() : save(shown, editorApi.snapshotTabs())
  }

  function request(next: TabScopeKey | null): void {
    // Asked again for the set already asked for (a project activation and the
    // thread selection it causes both name it): nothing new to do.
    if (sameScope(wanted, next)) return
    wanted = next
    // A press made from now on belongs to `next`: the gate holds it until
    // `next` is on screen (opens during the switch window used to land in the
    // set being left).
    tabScopeGate.want(next)
    chain = chain
      .then(() => settle())
      .catch((error: unknown) => {
        console.error('flow: failed to switch editor tabs', error)
        // The switch never happened: what is on screen is what is wanted, so
        // presses held for the set that failed to load are dropped rather than
        // waiting forever.
        wanted = shown
        tabScopeGate.want(shown)
      })
      // AFTER `switching` is lifted, so the replayed opens are persisted into
      // the set they were pressed in by the ordinary tab-change path.
      .then(() => tabScopeGate.settled(shown))
  }

  async function settle(): Promise<void> {
    const target = wanted
    if (sameScope(shown, target)) return
    switching = true
    try {
      const set =
        target === null
          ? null
          : await api.project.loadTabSet({ rootPath: target.rootPath, threadId: target.threadId })
      if (wanted !== target) return // superseded mid-load — the queued switch takes over
      // The outgoing set is captured and saved only NOW, immediately before the
      // editor closes it — anything typed while the incoming set was loading is
      // in the snapshot, unsaved buffers included.
      const plan = planTabSwitch(shown, target, editorApi.snapshotTabs())
      if (plan.kind === 'none') return
      if (plan.save !== null) outgoingSave = save(plan.save.scope, plan.save.set)
      if (plan.load === null || set === null) {
        shown = null
        editorApi.clearActiveProject()
        terminals.setActiveProject(null)
        announce(null)
        return
      }
      const scope = plan.load
      shown = scope
      rebuilding = true
      if (plan.projectChanges) {
        const context: ProjectContext =
          latestContext !== null && latestContext.rootPath === scope.rootPath
            ? latestContext
            : {
                rootPath: scope.rootPath,
                openFiles: [],
                activeFile: null,
                activeThreadId: scope.threadId,
                dirtyBuffers: {},
              }
        try {
          await editorApi.setActiveProject(context, set, scope)
        } catch (error) {
          console.error('flow: failed to rebind editor to project', error)
        }
        terminals.setActiveProject(scope.rootPath)
      } else {
        try {
          await editorApi.switchTabSet(set, scope)
        } catch (error) {
          console.error('flow: failed to switch editor tabs to the conversation', error)
        }
      }
      announce(scope)
    } finally {
      switching = false
      rebuilding = false
    }
  }

  function announce(scope: TabScopeKey | null): void {
    document.dispatchEvent(new CustomEvent<TabScopeKey | null>(TAB_SCOPE_EVENT, { detail: scope }))
  }

  /**
   * A conversation in ANOTHER project was selected: its set is named by that
   * project's activation, which arrives as a separate broadcast after the
   * selection signal has resolved. Until it does, presses stay held — released
   * in the past they were filed into the project being left. Bounded, so a
   * lost activation cannot hold every press for ever.
   */
  let awaitingActivation: { rootPath: string; timer: ReturnType<typeof setTimeout> } | null = null
  function endAwaitingActivation(): void {
    if (awaitingActivation === null) return
    clearTimeout(awaitingActivation.timer)
    awaitingActivation = null
    tabScopeGate.releaseSignal()
  }

  api.project.onActiveChanged((context) => {
    latestContext = context
    request(scopeForProject(context))
    endAwaitingActivation()
  })

  // A conversation selected or cleared. A clear is read on a MICROTASK, not
  // inline: a project activation reaches the thread list in the same task as it
  // reaches this module, and the list's clear for a project with no
  // conversation must be judged against the project being ACTIVATED, not the
  // one being left. A selection is judged once its project is known — the
  // signal may say (`projectRoot`), otherwise main is asked — so a conversation
  // in another project is left to that project's activation, which names it.
  let signals: Promise<void> = Promise.resolve()
  document.addEventListener('flow:active-thread', (event) => {
    const detail = (event as CustomEvent<{ threadId: string | null; projectRoot?: string | null }>).detail
    if (detail === undefined || detail === null) return
    const threadId = detail.threadId ?? null
    const said = detail.projectRoot ?? null
    // Until this signal says which set it means, a press must not be filed into
    // the set on screen — it may be the one being left.
    tabScopeGate.holdSignal()
    // ONE AT A TIME, IN THE ORDER THEY HAPPENED: a select still asking main for
    // its project must not be overtaken by a clear that came after it. The
    // chain's callbacks run as microtasks, which is also what defers a clear
    // past the project activation dispatched in the same task.
    signals = signals
      .then(async () => {
        const projectRoot = threadId === null ? null : await threadProject(threadId, said)
        if (threadId !== null && projectRoot === null) return // deleted meanwhile
        const next = scopeForThreadSignal({ threadId, projectRoot }, wanted?.rootPath ?? null)
        if (next !== null) request(next)
        else if (projectRoot !== null && projectRoot !== (wanted?.rootPath ?? null)) {
          endAwaitingActivation()
          tabScopeGate.holdSignal()
          awaitingActivation = {
            rootPath: projectRoot,
            timer: setTimeout(endAwaitingActivation, ACTIVATION_WAIT_MS),
          }
        }
      })
      .catch((error: unknown) => console.warn('flow: could not place the conversation’s tabs', error))
      .finally(() => tabScopeGate.releaseSignal())
  })

  /** The project a conversation lives in — from the signal when it says, else main. */
  async function threadProject(threadId: string, said: string | null): Promise<string | null> {
    if (said !== null) return said
    const thread = await api.threads.get({ threadId })
    return thread?.projectRoot ?? null
  }

  editorApi.onTabsChanged(() => {
    if (switching || shown === null) {
      return
    }
    void persistShown()
  })

  // Hot exit (#1072): an in-place renderer reload (View ▸ Reload / ⌘R, or a
  // window close) tears the editor down WITHOUT a switch, and the
  // onTabsChanged persistence above fires on tab mutations — not keystrokes —
  // so the newest typed-but-unsaved content was silently destroyed, with the
  // restored tab looking clean. Snapshot the shown set + dirty buffers at
  // beforeunload: the invoke's IPC message is queued to the main process before
  // the frame goes away, and the boot restore below rehydrates the buffers
  // dirty via the #955 restoreDirtyContent path once the fresh renderer boots.
  //
  // DURING A SWITCH TOO. While the incoming set is still loading the editor
  // shows `shown` in full, so it is captured exactly as at rest — skipping it
  // lost everything typed since the last tab mutation. Only the rebuild itself
  // is skipped: its tabs belong to neither set, and the outgoing set was
  // captured and sent the moment the rebuild began. Synchronous: the invoke is
  // queued before the frame goes away, nothing is awaited.
  window.addEventListener('beforeunload', () => {
    if (!rebuilding) void persistShown()
  })

  // #1443: quit never reached the handler above. `before-quit` is intercepted and
  // the main process tears itself down FIRST, so the beforeunload write had no
  // receiver — the tab came back clean and everything typed since the last tab
  // mutation was gone. Teardown now asks first and waits for this ack, so the
  // snapshot is taken while saveTabSet and the DB are still alive. Acked
  // unconditionally: the handshake must complete even with nothing to persist,
  // or quit would stall on its deadline for every project-less window.
  //
  // A flush that lands mid-switch WAITS for the switch rather than skipping:
  // the chain settles (the outgoing set's write is sent as the rebuild starts),
  // and then the set on screen — the incoming one, with anything typed into it
  // since — is saved like any other.
  api.project.onFlushEditorContext(() => {
    void chain
      .then(() => outgoingSave)
      .then(() => persistShown())
      .then(() => api.project.editorContextFlushed())
      .catch((error: unknown) => console.warn('flow: editor-context flush failed', error))
  })

  // Boot restore: apply whatever project (and conversation) the main process
  // restored as active.
  void api.project
    .active()
    .then((context) => {
      if (context && wanted === null && shown === null) {
        latestContext = context
        request(scopeForProject(context))
      }
    })
    .catch(() => undefined)
}
