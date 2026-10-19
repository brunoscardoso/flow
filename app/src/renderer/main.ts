/**
 * Flow renderer entry point — loads the Stark design tokens, mounts the
 * dock-layout shell, then wires every surface into it in dependency order:
 * editor first (its EditorApi feeds LSP, diff review, and git), threads,
 * LSP bindings, diff review, terminals, git, and the flow UI.
 */
import './theme/tokens.css'
import { useEditorForCodeHighlighting } from './threads/code-highlight-view'
import { initTheme } from './theme/theme-controller'
import { mountShell } from './shell'
import { planDrop } from './editor/dropped-files'
import { initEditor } from './editor'
import { initThreads } from './threads'
import { startProjectAccentSlots } from './project-accent-workspaces'
import { initSettings } from './settings/settings-view'
import { initWorkspaceDialogs } from './settings/workspace-dialogs-view'
import { initCollisionCard } from './threads/collision-card'
import { initWorkspaceSettingsLink } from './settings/workspace-settings-link'
import { initLsp } from './editor/lsp-bindings'
import { initConflictCodeLens } from './editor/conflict-codelens'
import { initConflictResolve } from './editor/conflict-resolve-index'
import { initDiffReview } from './editor/diff-review-index'
import { initTerminals } from './terminal'
import { initGit } from './git'
import { initWorktrees } from './worktrees'
import { initReview } from './review'
import { initBlueprint } from './blueprint'
import { initBrowserTab } from './browser/browser-tab'
import { initBrowserCaptureChip } from './browser/browser-capture-chip'
import { initTaskBoard } from './tasks/kanban-board'
import { initChangeReview } from './threads/change-review-view'
import { initFeatureViewHost } from './threads/feature-view-host'
import { initBackgroundActivity } from './threads/background-activity-view'
import { initSubagentProgress } from './threads/subagent-progress-view'
import { initIntegrationsSettings } from './settings/integrations-settings-view'
import { initFlowUi } from './flow'
import { initProjectContext } from './project-context'
import { maybeStartOnboarding } from './onboarding'
import { maybeAskAboutTelemetry } from './onboarding/consent-prompt'
import { installOverlayFocusTrap } from './settings/overlay-focus-trap'
import { initUpdateBanner } from './update/update-banner'
import { initLearn } from './learn'
import { initCommandPalette } from './palette/command-palette'
import { isModalOverlayOpen } from './modal-overlay'
import { recordStartup, startPerformanceLog } from './diagnostics/perf-log'

// When this file started running — the baseline every startup mark is measured
// from. Read before anything else so it measures the app, not this module.
const scriptStart = performance.now()

// Watch for blocked frames and slow presses from the very first one: startup is
// exactly when the app is reported as slowest, and an observer installed after
// the surfaces are up would miss the stretch that owns the complaint.
const perfLog = startPerformanceLog(window.flow)

// Stamp the effective theme on <html> BEFORE the shell mounts, so the first paint
// is already in the user's theme (no flash) and Monaco/xterm observers see it (#399).
initTheme()

const appRoot = document.getElementById('app')
if (appRoot) {
  // Keyboard modality for every `.fl-settings-overlay` modal (#1006) — installed
  // before any surface can open one (incl. the first-run onboarding wizard).
  installOverlayFocusTrap()
  const surfaces = mountShell(appRoot)
  recordStartup(perfLog, scriptStart, performance.now())
  const editorApi = initEditor(surfaces)
  // App-menu Close Tab (⌘W / Ctrl+W, #673) — FOCUS-AWARE: when the terminal is
  // focused, close the active TERMINAL tab (its own tab strip, separate from the
  // editor); otherwise close the active editor-area tab. Previously ⌘W always
  // went to the editor, so ⌘W in a focused terminal did nothing.
  // #1339: files dragged in from the OS. The renderer registered exactly two
  // drop targets (the composer, the tasks board), so a drop anywhere else did
  // nothing — and over an open buffer Monaco's own provider pasted the path
  // plus a literal `$0` INTO the source file.
  //
  // A window-level handler always preventDefault()s, so no drop can navigate
  // the shell away (the browser default, and a data-loss trap of its own with
  // unsaved buffers). Surfaces that own a drop — the composer's attachments,
  // the board's cards — stop propagation first and are unaffected.
  const isFileDrag = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files')
  window.addEventListener('dragover', (event) => {
    if (isFileDrag(event)) event.preventDefault()
  })
  window.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    const paths = Array.from(event.dataTransfer?.files ?? [])
      .map((file) => window.flow.attachments?.pathFor?.(file) ?? '')
      .filter((path) => path !== '')
    if (paths.length === 0) return
    void window.flow.project
      .list()
      .then((roots) => {
        const plan = planDrop(
          paths,
          roots.map((root) => root.rootPath),
        )
        for (const file of plan.open) {
          void editorApi.openFile(file.rootPath, file.relPath)
        }
        if (plan.notice !== null) {
          document.dispatchEvent(
            new CustomEvent('flow:notify', {
              detail: {
                kind: 'state-change',
                rootId: '',
                title: plan.open.length > 0 ? 'Some files were not opened' : 'Nothing to open',
                body: plan.notice,
                timestamp: new Date().toISOString(),
                level: 'info',
              },
            }),
          )
        }
      })
      .catch(() => undefined) // a failed roots read is not worth a toast here
  })

  // #1338: Edit ▸ Undo / Redo / Select All. Monaco 0.55 focuses an EditContext
  // div rather than a textarea, so Blink's own edit commands no-op there —
  // route to Monaco when it holds focus, and use the native command for Flow's
  // own plain inputs (where those commands have always worked).
  window.flow.editor.onEditAction?.((action) => {
    const active = document.activeElement
    if (active?.closest('.monaco-editor') != null) {
      document.dispatchEvent(new CustomEvent('flow:editor-edit-action', { detail: { action } }))
      return
    }
    // #1388: the half #1338 didn't reach. xterm takes input through a HIDDEN,
    // EMPTY `.xterm-helper-textarea`, so `execCommand('selectAll')` selected
    // that empty node and Edit ▸ Select All was a dead key in the shell —
    // while the terminal's own right-click Select All, two pixels away on the
    // same pixels, selected the whole buffer. The capability was present,
    // wired, and reachable by mouse only.
    if (active?.closest('.fl-term-root') != null) {
      document.dispatchEvent(new CustomEvent('flow:terminal-edit-action', { detail: { action } }))
      return
    }
    const command = action === 'selectAll' ? 'selectAll' : action
    try {
      document.execCommand(command)
    } catch {
      // A surface that can't run it is not an error worth a toast — the menu
      // item simply has nothing to act on there.
    }
  })

  window.flow.editor.onCloseActiveTab(() => {
    // #1198: JOIN the modal guard. A native menu accelerator never produces a
    // renderer keydown — it fires in main and sends this event — so
    // isModalOverlayOpen() (which gates every other global shortcut from the
    // shell's keydown listener) could not see ⌘W at all. With a dialog open it
    // closed a tab behind the backdrop with no toast and no trace; on a DIRTY
    // tab it raised "Discard unsaved changes in <file>?" over the dialog, about
    // a file hidden behind it, whose default button destroys the edit — so the
    // Return that naturally follows "make this go away" lost the user's work.
    //
    // modal-overlay.ts states the invariant this restores: "while it is open,
    // global panel shortcuts are inert… the invariant lives in one code path".
    // The app menu was the one caller that never joined it.
    if (isModalOverlayOpen()) return
    if (document.activeElement?.closest('.fl-term-root')) {
      document.dispatchEvent(new CustomEvent('flow:close-active-terminal'))
    } else {
      editorApi.closeActiveTab()
    }
  })
  // App-menu Settings… (⌘, / Ctrl+, — #1159). Routed through the SAME
  // `flow:open-settings` event the titlebar accounts control and the palette
  // dispatch, so there is one open path and the overlay's own guards apply.
  window.flow.editor.onOpenSettings(() => {
    document.dispatchEvent(new CustomEvent('flow:open-settings'))
  })
  // Collapse the empty editor (#675): tell the shell whether the editor holds
  // any tab so its stack drops from the root split when empty + no terminal,
  // leaving no phantom divider. Sync once for the boot state, then on changes.
  surfaces.layoutApi.setEditorHasTabs(editorApi.hasOpenTabs())
  editorApi.onTabsChanged(() => surfaces.layoutApi.setEditorHasTabs(editorApi.hasOpenTabs()))
  initThreads(surfaces)
  // One colour per project, everywhere — its Workspace slot unless picked.
  startProjectAccentSlots()
  void initLsp(editorApi).catch((error) => {
    console.error('flow: failed to initialize LSP bindings', error)
  })
  // Merge-conflict "Resolve with AI" (#66): CodeLens over conflict blocks +
  // the picker/prefill glue. Fail-soft — a registration error never blocks boot.
  void initConflictCodeLens(editorApi).catch((error) => {
    console.error('flow: failed to initialize conflict CodeLens', error)
  })
  initConflictResolve()
  initDiffReview(editorApi, surfaces)
  const terminals = initTerminals(surfaces)
  // Lend the chat's code blocks the editor's tokenizer, so a fenced snippet is
  // coloured by the same grammar and the same theme as the file it came from.
  useEditorForCodeHighlighting(editorApi)
  initGit(surfaces, editorApi) // after initEditor — needs its EditorApi
  initWorktrees()
  initReview(surfaces, editorApi) // phase-grouped review & commit side tab
  initBlueprint(editorApi)
  // Embedded browser tab (#embedded-browser) — same shape as the blueprint: one
  // <webview> element for the life of the window, opened as an editor-area tab on
  // `flow:open-browser` (dispatched by the activity bar's Browser action).
  initBrowserTab(editorApi)
  // Bridge embedded-browser captures (element/console/network) into the composer
  // as [browser: …] chips (+ source file & screenshot for elements). Guarded on
  // the preload bridge, same as initBrowserTab — an older preload has no browser API.
  if (window.flow?.browser) initBrowserCaptureChip(window.flow.browser)
  // LOOPS HAVE NO SCREEN AND NO SIDEBAR ITEM. They had a screen — a control
  // centre for configuring, aiming and starting them — and it is gone, because
  // everything on it moved to where the decision actually happens: a hunt is
  // configured on the work that prompts it (loops/hunt-config.ts, on New task
  // and New thread), and the one standing loop is started and stopped from the
  // board's own toolbar. What is left is a directive file per loop, which is
  // where a mission belongs and always was: a committed file the whole team
  // reads, steered by a commit rather than by a form.
  initTaskBoard(editorApi)
  // The agent's changes, in the editor area beside the board and the blueprint
  // (#1906). Same shape as those: one element, opened as a tab on demand — it
  // never takes the editor by itself. What says a thread HAS changes is the
  // strip above the composer (`changes-strip.ts`); this is what it opens.
  initChangeReview(editorApi)
  // A discovery's user walkthrough page — what people will see — framed as a
  // tab beside the blueprint's picture of what the code will become. Opened
  // only from a discovery card whose page exists (`flow:open-feature-view`).
  initFeatureViewHost(editorApi)
  // Background runs (sub-agents, terminal commands), each as its own tab beside
  // Changes (#1931). Opened from the footer popover; same one-element-per-tab
  // shape — it never takes the editor by itself.
  initBackgroundActivity(editorApi)
  // Live sub-agent progress (#1931): clicking a running agent in the left
  // sidebar opens its progress (tools + elapsed) on the right, from the live
  // background-tasks stream — works for backgrounded sub-agents.
  initSubagentProgress(editorApi)
  // SETTINGS, AS A TAB. Same shape as the board and the blueprint above it: one
  // element for the life of the window, opened on `flow:open-settings`, which
  // the titlebar gear, ⌘, and the palette all already dispatch.
  initSettings(editorApi)
  // Workspaces: the switcher's New / Join dialogs, the join suggestion for a
  // newly opened project, and the paused-sync collision card.
  initWorkspaceDialogs()
  initCollisionCard()
  // A Workspace's no-access / error toast opens Settings → Workspaces.
  initWorkspaceSettingsLink(document)
  initIntegrationsSettings() // Jira / GitHub / Azure token management overlay
  initFlowUi(surfaces)
  // ADR-002: bind editor/file-tree/terminals to the active project + restore.
  initProjectContext({ editorApi, terminals })
  // First-run onboarding (#48) — opens only when an account/project is missing.
  void maybeStartOnboarding()
  // The telemetry question, on the third day somebody actually uses Flow. Main
  // decides whether to raise it; this only draws it. It runs AFTER onboarding
  // is offered so a first-run user never meets both at once — on day three the
  // wizard is long gone anyway.
  void maybeAskAboutTelemetry()
  // Auto-update banner (#auto-update) — driven by the main process's status push.
  initUpdateBanner()
  // Progressive-learning (#513 phase 2): the one-time basic-discovery ask card.
  initLearn()
  // ⌘P command palette — quick-open blending files/threads/commands. After
  // initEditor: it reads snapshotTabs() for the empty-state recents.
  initCommandPalette(editorApi)
}
