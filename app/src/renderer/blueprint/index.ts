/**
 * Blueprint wiring — opens the FLOW-FIRST BlueprintBoard (blueprint-v2) as an
 * EDITOR-AREA tab (id 'flow://blueprint', icon 'map'). One blueprint tab per
 * window: reopening focuses the existing tab (EditorApi.openView is idempotent
 * per id), and the board element survives tab closes so its state is preserved.
 *
 * Open trigger: the 'map' action button in the EDITOR tab strip's actions slot
 * (renderer/editor/index.ts) dispatches `flow:open-blueprint` on document —
 * handled here (same decoupling pattern as the shell's terminal events).
 *
 * Data flow (rootId === absolute rootPath, active-project scoped like git):
 *   first open → read + render (lazy); a missing graph auto-triggers
 *                blueprint:derive in main; a failed derive falls back to the
 *                in-memory basic graph so the tab never dead-ends
 *   blueprint:changed → re-read
 *   project:activeChanged → rebind to the new project
 *   the auto-derive pane / Recheck (in the board) → re-derive under the hood
 *
 * The board owns its own data lifecycle + drafting-identity render; this module
 * only binds it to the editor + active project. (The chat story card's board
 * decoration and the documents' discovery view that used to be wired here were
 * retired on 2026-10-08.)
 *
 * PEEK ENTRY POINTS (Phase 5, #568): both the StoryCard's file anchors and the
 * board's own popover annotation entries dispatch `flow:peek-file` {relPath}
 * on document — this module is the ONE listener. `board.openPeek()` has no
 * dependency on the graph or on the tab being attached yet (the peek drawer's
 * DOM is built in the board's constructor and reads the file directly via
 * project:readFile), so opening the tab and the peek can run back-to-back,
 * no queuing needed — openBlueprintTab() is idempotent when the tab is
 * already open.
 */
import '../components'
import type { EditorApi } from '../editor'
import { BlueprintBoard } from './blueprint-board'
import { PeekViewer } from './peek-viewer'
import { decodeBoardNav, encodeBoardNav, sameBoardNav } from './board-nav-state'
import { runInWantedScope, tabScopeGate } from '../tab-scope-gate'
import { sameScope, type TabScopeKey } from '../tab-scope-model'

const BLUEPRINT_TAB_ID = 'flow://blueprint'
/** The persisted identity of the board in a conversation's tab set. */
const BLUEPRINT_VIEW_KIND = 'blueprint'

export function initBlueprint(editorApi: EditorApi, container?: HTMLElement): () => void {
  const api = window.flow
  if (!api?.blueprint || !api?.project) {
    console.warn('flow: preload bridge missing — blueprint view disabled')
    return () => undefined
  }

  const board = new BlueprintBoard()

  // E2E-only hook: the preload sets `__FLOW_E2E__` from main's `--flow-e2e` argv, letting a
  // spec push a synthetic snapshot or force a refresh (setSnapshot /
  // handleChanged) without a real project on disk. Never set in production —
  // gated on the test flag, so it is inert for real users.
  if ((window as unknown as { __FLOW_E2E__?: boolean }).__FLOW_E2E__) {
    ;(window as unknown as { __flowBoard?: BlueprintBoard }).__flowBoard = board
  }

  // Live reload after each derive/annotation append (main debounces).
  api.blueprint.onChanged(({ rootId, learningOnly }) =>
    board.handleChanged(rootId, learningOnly === true),
  )

  // The active root path currently bound to the board — used to pick this
  // project's provisioning state out of a rootsChanged broadcast (#513 phase 2).
  let activeRootPath: string | null = null
  const bindRoot = (rootPath: string | null): void => {
    activeRootPath = rootPath
    board.setRoot(rootPath)
  }
  /** Push the active root's provisioning readiness into the board so a project
   *  still being set up shows the "Setting up plan-flow…" wait pane. */
  const applyProvisioningState = (roots: { rootPath: string; provisioningState?: import('../../shared/ipc-contract').ProvisioningState }[]): void => {
    if (activeRootPath === null) return
    const root = roots.find((candidate) => candidate.rootPath === activeRootPath)
    board.setProvisioningState(root?.provisioningState)
  }

  // Follow the active project (ADR-002) — same precedent as the git panel.
  api.project.onActiveChanged((context) => {
    bindRoot(context?.rootPath ?? null)
    // Seed the newly-active project's provisioning state immediately.
    void api.project.list().then(applyProvisioningState).catch(() => undefined)
  })
  // A root's provisioning transition (idle → provisioning → ready/failed) rides
  // the rootsChanged broadcast (mirrored there by main); re-apply for our root.
  api.project.onListChanged(applyProvisioningState)
  void api.project
    .active()
    .then((context) => {
      bindRoot(context ? context.rootPath : null)
      return api.project.list()
    })
    .then(applyProvisioningState)
    .catch(() => undefined)

  // Peek drawer → Monaco (Phase 4, #568). The board opens the drawer shell on a
  // file click and fires onPeekOpen/onPeekClose; the viewer fills it with a
  // read-only Monaco peek. rootId is a getter so it tracks the live active
  // project (activeRootPath is rebound above); the button promotes into the
  // full editor tab via the same openFile path the file tree uses.
  const peek = new PeekViewer({
    rootId: () => activeRootPath,
    openInEditor: (relPath) => {
      if (activeRootPath === null) return
      void editorApi.openFile(activeRootPath, relPath).catch((error) => {
        console.error('flow: failed to open peeked file in editor', error)
      })
    },
  })
  peek.attach(board)

  if (container) {
    container.appendChild(board.element)
    board.ensureLoaded()
  }

  /**
   * Hand the board the keyboard once it is actually on screen (#963). The board
   * gates its shortcuts on owning focus (#517) and nothing used to give it any,
   * so the keys its own tooltips advertise — `0` fit and `Esc` drill-up
   * — were dead on every arrival path until the user clicked the map. Deferred
   * one frame as well as claimed immediately: the tab reveal (`flow:show-editor`
   * → unhide) can land after this call, and `focus()` on a hidden element is a
   * silent no-op. `claimKeyboardFocus` yields to a focused input/terminal.
   */
  const claimBoardFocus = (): void => {
    board.claimKeyboardFocus()
    requestAnimationFrame(() => board.claimKeyboardFocus())
  }

  /**
   * The conversation whose place the board is showing. One board per window,
   * so when a conversation that never had it open opens it, the board starts
   * at its plain root — never on the drill or document the previous
   * conversation left it on.
   */
  let boardScope: TabScopeKey | null = null

  const openBlueprintTab = (options: { focus?: boolean; restore?: boolean } = {}): void => {
    if (!container && options.restore !== true && !editorApi.hasTab(BLUEPRINT_TAB_ID)) {
      // Not open in THIS set (a switch closes the outgoing set's board). Same
      // conversation reopening a board it closed keeps its place; any other
      // starts fresh.
      const scope = tabScopeGate.shown
      if (!sameScope(boardScope, scope)) {
        boardScope = scope
        board.resetToRoot()
      }
    }
    if (container) {
      if (!container.contains(board.element)) {
        container.appendChild(board.element)
      }
      board.ensureLoaded()
    } else {
      editorApi.openView({
        id: BLUEPRINT_TAB_ID,
        label: 'Blueprint',
        icon: 'map',
        element: board.element,
        // THE BOARD BELONGS TO A CONVERSATION'S TAB SET, with where the reader
        // stood on it — so a thread gets back its drill and feature brief, and
        // one that never opened the board gets the plain board.
        persist: {
          kind: BLUEPRINT_VIEW_KIND,
          state: () => encodeBoardNav(board.navigationState),
        },
      })
      board.ensureLoaded()
    }
    if (options.focus !== false) claimBoardFocus()
  }

  // A conversation's tab set coming back with the board in it. One board per
  // window, so what differs between sets is where the reader stood: the drill,
  // the code map, the feature brief. Restored from
  // the root, quietly — a restore never takes the composer's keyboard.
  editorApi.registerViewRestorer(BLUEPRINT_VIEW_KIND, (state, scope) => {
    if (container) return null
    const nav = decodeBoardNav(state)
    boardScope = scope
    openBlueprintTab({ focus: false, restore: true })
    if (!sameBoardNav(board.navigationState, nav)) void board.restoreNavigation(nav)
    return BLUEPRINT_TAB_ID
  })

  // Re-activation through the tab strip never goes through openBlueprintTab —
  // the editor just unhides the view — so follow tab changes and claim the keys
  // on the hidden→visible transition too. Only on the transition: re-claiming
  // while the board is already up would yank focus out of the popover.
  let boardOnScreen = board.element.offsetParent !== null
  editorApi.onTabsChanged(() => {
    const onScreen = board.element.offsetParent !== null
    if (onScreen && !boardOnScreen) claimBoardFocus()
    boardOnScreen = onScreen
  })
  // The reveal seam (#1666): settle the refresh a change deferred while the
  // board was hidden. NOT the tab strip — the board hides two ways (another
  // tab, or the editor host toggled away with ⌘⌥D), and onTabsChanged only
  // sees the first. IntersectionObserver fires on display flips of any
  // ancestor, which covers both; entering the viewport with nothing deferred
  // is a no-op inside handleRevealed.
  const revealObserver = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) board.handleRevealed()
  })
  revealObserver.observe(board.element)
  const onOpenBlueprint = (): void => {
    // Reveal the editor host first — the tab opens into it (⌘P works even when
    // the editor is hidden).
    document.dispatchEvent(new CustomEvent('flow:show-editor'))
    openBlueprintTab()
  }
  // EVERY DOOR WAITS FOR ITS CONVERSATION'S SET (`tab-scope-gate.ts`): a press
  // made while a switch is still loading opens into the conversation it was
  // made in, not the one being left.
  const gated =
    (handler: (event: Event) => void) =>
    (event: Event): void =>
      void runInWantedScope(() => handler(event))
  const onOpenBlueprintGated = gated(onOpenBlueprint)
  document.addEventListener('flow:open-blueprint', onOpenBlueprintGated)

  // Learning status panel (#582). The learner streams per-file progress on
  // learn:progress (throttled in main) — feed the file into the board's live
  // reading line. And the notification's "[Open blueprint]" button dispatches
  // flow:open-learning-panel (alongside flow:open-blueprint) to open the tab and
  // reveal the panel. The panel reads the board's #snapshot (may be null → the
  // model treats it as empty), so opening before the graph loads is safe.
  const unsubscribeLearnProgress = api.learn?.onProgress((event) => {
    board.setLearnProgress(event.file)
  })
  // Global pause-state flips (learn:pause → learn:pausedChanged) keep the
  // panel's Pause/Resume label live in every window (#learn-controls).
  const unsubscribeLearnPaused = api.learn?.onPausedChanged((event) => {
    board.setLearnPaused(event.paused, event.pausedRoots)
  })
  const onOpenLearningPanel = (): void => {
    openBlueprintTab()
    board.openLearnPanel()
  }
  const onOpenLearningPanelGated = gated(onOpenLearningPanel)
  document.addEventListener('flow:open-learning-panel', onOpenLearningPanelGated)

  // Palette commands for board actions whose on-board chrome is state-gated
  // (Fit shows only off-rest; the wires toggle only on the code-map stage).
  // Each opens the tab first — a command must act on a board you can see.
  document.addEventListener(
    'flow:blueprint-fit',
    gated(() => {
      openBlueprintTab()
      board.fitToView()
    }),
  )
  document.addEventListener(
    'flow:blueprint-toggle-wires',
    gated(() => {
      openBlueprintTab()
      board.toggleWires()
    }),
  )
  document.addEventListener(
    'flow:blueprint-drift',
    gated(() => {
      openBlueprintTab()
      board.openDriftPanel()
    }),
  )

  // "Reveal in Blueprint" (#UX): a file-tree row asks to show its place on the
  // map — open the board tab and drill focus to the module that owns the path.
  const onRevealInBlueprint = (event: Event): void => {
    const relPath = (event as CustomEvent<{ relPath: string }>).detail?.relPath
    if (relPath === undefined) return
    openBlueprintTab()
    board.revealForPath(relPath)
  }
  const onRevealInBlueprintGated = gated(onRevealInBlueprint)
  document.addEventListener('flow:reveal-in-blueprint', onRevealInBlueprintGated)

  // Peek entry points (#568, Phase 5): a story-anchor or popover-annotation
  // file reference asks to peek a file. Open the tab (idempotent) then peek —
  // openPeek needs neither the graph nor DOM attachment, so no queuing.
  const onPeekFile = (event: Event): void => {
    const relPath = (event as CustomEvent<{ relPath: string }>).detail?.relPath
    if (relPath === undefined) return
    openBlueprintTab()
    board.openPeek(relPath)
  }
  const onPeekFileGated = gated(onPeekFile)
  document.addEventListener('flow:peek-file', onPeekFileGated)

  // REVIEW THE CHANGE (plan `plan_change_review`): the PLAN card asks for its
  // plan's change notes in the code story — `flow:open-plan-review` on window,
  // { rootPath, plan (the slug), threadId }. Open the tab, then the review in
  // Proposal; Send review goes back to `threadId`'s conversation.
  const onOpenPlanReview = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail
    if (typeof detail !== 'object' || detail === null) return
    const { rootPath, plan, threadId } = detail as { rootPath?: unknown; plan?: unknown; threadId?: unknown }
    if (typeof rootPath !== 'string' || rootPath === '' || typeof plan !== 'string' || plan === '') return
    document.dispatchEvent(new CustomEvent('flow:show-editor'))
    openBlueprintTab()
    void board.openPlanReview({ rootPath, plan, threadId: typeof threadId === 'string' && threadId !== '' ? threadId : null })
  }
  const onOpenPlanReviewGated = gated(onOpenPlanReview)
  window.addEventListener('flow:open-plan-review', onOpenPlanReviewGated)
  // The plan under review was rewritten (a decision landed, or the agent
  // revised its notes): the board re-reads it, only while it is on screen.
  const unsubscribeFlowDocs = api.flow?.onArtifactChanged((event) => {
    if (event.kind === 'plan') board.handleFlowDocChanged(event.rootId, event.path)
  })

  return () => {
    peek.dispose()
    unsubscribeFlowDocs?.()
    window.removeEventListener('flow:open-plan-review', onOpenPlanReviewGated)
    unsubscribeLearnProgress?.()
    unsubscribeLearnPaused?.()
    document.removeEventListener('flow:open-learning-panel', onOpenLearningPanelGated)
    document.removeEventListener('flow:open-blueprint', onOpenBlueprintGated)
    document.removeEventListener('flow:reveal-in-blueprint', onRevealInBlueprintGated)
    document.removeEventListener('flow:peek-file', onPeekFileGated)
  }
}
