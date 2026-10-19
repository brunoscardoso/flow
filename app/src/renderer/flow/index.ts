/**
 * Flow UI entry point — `initFlowUi(surfaces)` is wired by the coordinator
 * in main.ts. Owns the per-root FlowState map and connects the two views:
 *
 *   flow:stateChanged / flow:state → status line (aggregate across roots)
 *   flow:notification              → notification center (toasts + inbox)
 *
 * Blocked prompts arrive on BOTH channels (a notification push and a
 * pendingPrompt on the state) — `shownPromptIds` dedupes so each prompt id
 * toasts once, whichever channel lands first. rootId === absolute rootPath
 * everywhere, same convention as git/blueprint.
 */
import type { FlowNotification, FlowState, RegisteredProject } from '../../shared/ipc-contract'
import type { ShellSurfaces } from '../shell'
import { blockedPromptGate, createShownPromptRegistry } from './notification-dedupe'
import { createNotificationCenter } from './notification-center'
import { createStatusLine } from './status-line'

export function initFlowUi(surfaces: ShellSurfaces): void {
  const api = window.flow
  if (!api?.flow || !api?.project) {
    console.warn('flow: preload bridge missing — flow UI disabled')
    return
  }

  const center = createNotificationCenter((rootId, promptId, response) =>
    api.flow.respondPrompt({ rootId, promptId, response }),
  )
  const statusLine = createStatusLine(surfaces.statusBar)
  statusLine.onInboxToggle(() => center.toggleInbox())

  const states = new Map<string, FlowState>()
  // Root-aware (#970): prompt ids are mtime-derived and stable, so a dropped
  // root's ids must be pruned or its still-pending prompt is deduped away on
  // re-add and the reply card is never rebuilt.
  const shownPrompts = createShownPromptRegistry()

  // The badge is unified on the notification center's counter (#232): in-session
  // toasts AND live heartbeat pushes (flow:notification) bump it and land in the
  // inbox; opening the inbox clears it. It deliberately does NOT count the
  // pre-session heartbeat backlog — those events never enter the inbox, so seeding
  // the badge from them made it advertise notifications the inbox couldn't show and
  // silently marked them read on open (#376). `centerUnread` is the single source
  // of truth, and it only ever counts what the inbox actually contains.
  let centerUnread = 0
  center.onUnreadChanged((n) => {
    centerUnread = n
    renderStatus()
  })

  /** The project the user is IN (#1204) — null before the first answer. */
  let activeRoot: string | null = null

  /** Display name for a root: its path's last segment. */
  function projectName(rootPath: string): string {
    const trimmed = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
    const slash = trimmed.lastIndexOf('/')
    return slash === -1 ? trimmed : trimmed.slice(slash + 1)
  }

  function renderStatus(): void {
    let blockedCount = 0
    // #1354: collect WHICH roots are blocked, not just how many. Only roots
    // other than the active one are named — naming the project you are in
    // would be noise, and the rest of this line follows the same rule (#1204).
    const blockedElsewhere: string[] = []
    for (const state of states.values()) {
      if (!state.pendingPrompt) continue
      blockedCount += 1
      if (activeRoot === null || state.rootId !== activeRoot) {
        blockedElsewhere.push(projectName(state.rootId))
      }
    }
    statusLine.update({
      unread: centerUnread,
      blocked: blockedCount > 0,
      blockedCount,
      blockedProjects: blockedElsewhere,
    })
    announceAutopilot()
  }

  /**
   * Tell whoever draws the autopilot control what each root's flag is.
   *
   * The flag used to be a readout on the status line, which could be showing a
   * BACKGROUND project — hence #1204's `otherProject` prefix, so "autopilot on"
   * could never be read as an answer about the project you were looking at.
   * The control now lives in the composer, which belongs to a thread, which
   * belongs to exactly one project: so this broadcasts PER ROOT and the
   * listener takes the one matching its own thread. There is nothing left to
   * disambiguate.
   */
  function announceAutopilot(): void {
    for (const state of states.values()) {
      document.dispatchEvent(
        new CustomEvent('flow:autopilot', {
          detail: { rootId: state.rootId, autopilot: state.autopilot },
        }),
      )
    }
  }

  /** The task each root's live prompt asks about (#1165) — kept so a prompt
   *  that vanishes out-of-band can be announced by NAME rather than as an
   *  anonymous "a question closed". */
  const lastPromptTask = new Map<string, string>()

  function applyState(state: FlowState): void {
    states.set(state.rootId, state)
    const prompt = state.pendingPrompt
    if (prompt) lastPromptTask.set(state.rootId, prompt.task)
    if (prompt && !shownPrompts.has(prompt.promptId)) {
      shownPrompts.record(prompt.promptId, state.rootId)
      center.notify({
        kind: 'blocked-prompt',
        rootId: state.rootId,
        title: `Task blocked: ${prompt.task}`,
        body: prompt.markdown,
        timestamp: new Date().toISOString(),
        promptId: prompt.promptId,
        level: 'error',
      })
    }
    if (!prompt) {
      // #1165: name the question that vanished, so the announcement (and the
      // inbox record correcting the stale "Task blocked: …") is specific.
      center.dismissPrompt(state.rootId, { task: lastPromptTask.get(state.rootId) })
      lastPromptTask.delete(state.rootId)
    }
    renderStatus()
  }

  api.flow.onNotification((notification) => {
    // Honor the SAME dedup as applyState: if the state channel already showed
    // this prompt, dropping the push preserves the live card and the reply the
    // user is typing into it (#231).
    const gate = blockedPromptGate(notification, (id) => shownPrompts.has(id))
    if (gate.recordPromptId) shownPrompts.record(gate.recordPromptId, notification.rootId)
    // Live heartbeat events DO reach the inbox (they arrive as flow:notification),
    // so the center counts them and the badge and inbox stay in agreement (#376).
    if (gate.forward) center.notify(notification)
  })

  // Renderer-side toast bridge (#73): components dispatch a `flow:notify`
  // CustomEvent (a FlowNotification detail) to raise a toast without importing
  // the center. Nothing consumed it before, so those toasts were silently
  // dropped — this wires them through. Used by the Review panel, kanban,
  // thread sidebar, and editor.
  document.addEventListener('flow:notify', (event) => {
    const detail = (event as CustomEvent<FlowNotification>).detail
    if (detail && typeof detail.title === 'string') center.notify(detail)
  })
  api.flow.onStateChanged((state) => {
    applyState(state)
  })

  /** `known` is the roots the caller already has (the broadcast carries them);
   *  omit it only on the initial bind, which has nothing to be told. */
  async function refreshRoots(known?: readonly RegisteredProject[]): Promise<void> {
    try {
      // Unavailable roots (unmounted drives, #263) have no reachable flow/ dir —
      // skip them so we don't churn on a nonexistent path.
      const roots = (known ?? (await api.project.list())).filter(
        (root) => root.available !== false,
      )
      const alive = new Set(roots.map((root) => root.rootPath))
      for (const rootId of [...states.keys()]) {
        if (!alive.has(rootId)) {
          states.delete(rootId)
          // The root is gone, not answered — remove the card silently (#1165).
          center.dismissPrompt(rootId, { announce: false })
          lastPromptTask.delete(rootId)
          // Forget the dropped root's shown prompt ids (#970): prompt ids are
          // mtime-derived, so an untouched prompt re-delivers the SAME id when
          // the root is re-added — without pruning it is deduped away and the
          // still-blocked task's reply card is never rebuilt.
          shownPrompts.pruneRoot(rootId)
        }
      }
      // ONLY A ROOT NOT YET KNOWN IS READ. A list change (a provisioning state,
      // a stamp, an accent) does not change any root's flow state, and every
      // change that does arrives on flow:stateChanged — re-reading all of them
      // per list change was 82 flow:state calls in 25 s for five projects
      // (allowed-pattern #17).
      await Promise.all(
        roots.filter((root) => !states.has(root.rootPath)).map(async (root) => {
          try {
            const state = await api.flow.state({ rootId: root.rootPath })
            applyState(state)
          } catch (error) {
            console.warn(`flow: failed to load flow state for ${root.rootPath}`, error)
          }
        }),
      )
      // The pre-session heartbeat backlog is deliberately NOT folded into the badge:
      // those events never enter the inbox, so counting them made the badge advertise
      // notifications the inbox couldn't show, then silently marked them read on open
      // (#376). The backlog is surfaced by the CLI/agent session summary instead.
      renderStatus()
    } catch (error) {
      console.warn('flow: failed to refresh project roots', error)
    }
  }

  // #1204: the status line has to know which project the user is actually IN —
  // it never consulted it, so it could describe a background root while the
  // titlebar named a different one.
  void api.project
    .active()
    .then((context) => {
      activeRoot = context?.rootPath ?? null
      renderStatus()
    })
    .catch(() => undefined)
  api.project.onActiveChanged((context) => {
    activeRoot = context?.rootPath ?? null
    renderStatus()
  })

  void refreshRoots()
  api.project.onListChanged((roots) => {
    void refreshRoots(roots)
  })
  renderStatus()
}

