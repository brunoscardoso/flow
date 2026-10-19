import { app, BrowserWindow, dialog, nativeImage, safeStorage, shell } from 'electron'
import { realpath as realpathAsync } from 'fs/promises'
import { readLearnLog, recordLearnEvent } from './project/learn-log'
import { basename, dirname, join, resolve } from 'path'
import { release } from 'os'
import { randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, statSync, readdirSync as nodeReaddirSync } from 'fs'
import { promises as fsPromises } from 'fs'

// Product name — in DEV the app menu / dock otherwise read "Electron" (the
// bundle name only applies once packaged). Set it before app is ready so the
// default macOS menu ("About Flow", "Hide Flow", "Quit Flow") picks it up.
app.setName('Flow')

// Dev-only: run a SECOND Flow beside a packaged one. Both default to the same
// userData (~/Library/Application Support/Flow), so the single-instance lock
// (see requestSingleInstanceLock below) makes `npm run dev` quit instantly when
// the shipped app is already open — no window, no error. Point dev at its own
// profile to coexist: `FLOW_USER_DATA_DIR=/tmp/flow-dev npm run dev`. Must run
// before requestSingleInstanceLock, and never in the packaged app.
const devUserDataDir = process.env['FLOW_USER_DATA_DIR']
if (devUserDataDir && devUserDataDir.trim() !== '' && !app.isPackaged) {
  app.setPath('userData', devUserDataDir.trim())
}

// Last-resort backstop: a fire-and-forget path (e.g. background task-brief
// generation) that leaks a rejection must NOT take the main process down (#114).
// Log and stay up — individual paths still handle their own errors; this only
// catches ones that slip past. Installed before any async work runs.
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled promise rejection (contained):', reason)
})
process.on('uncaughtException', (error) => {
  console.error('[main] Uncaught exception (contained):', error)
})

// Dev-only: attach a remote debugging port when FLOW_REMOTE_DEBUG is set, so
// the running dev app can be inspected (must run before app is ready).
const remoteDebugPort = process.env['FLOW_REMOTE_DEBUG']
if (remoteDebugPort && !app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebugPort)
}

import { registerAccountChannels } from './accounts/ipc'
import { AgentManager } from './agent/agent-manager'
import { makeBoardToolsProvider } from './agent/board-tools/board-tools-provider'
import { readProjectProvider } from './agent/runtime/project-provider'
import { AccountResolver } from './agent/account-resolver'
import { configureAgentBinary, ensureAgentBinary } from './agent/agent-binary'
import { ensureCliShim } from './agent/cli-shim'
import { repairStaleUserCliShim } from './project/user-cli-shim'
import { registerAgentChannels } from './agent/ipc'
import { shouldAutoChain } from './drive/auto-chain'
import { BrainUsageTracker, readBrainUsageStore, readBrainUsageTotals } from './agent/brain-usage'
import { estimateThreadSavings } from './agent/brain-savings'
import { LoginOrchestrator } from './agent/login-orchestrator'
import { makeSubagentSeedProvider } from './agent/subagent-seed'
import { makeSubagentBackfill } from './agent/subagent-backfill'
import { PermissionBroker } from './agent/permissions'
import { AccountStore } from './store/account-store'
import {
  BLUEPRINT_CHANGED_EVENT,
  BlueprintObserver,
  makeBundledDriftCheck,
  registerBlueprintChannels,
} from './blueprint/blueprint-observer'
import { deriveBasicGraph } from './blueprint/basic-derive'
import { registerBrainChannels } from './brain/ipc'
import { registerLoopsChannels } from './loops/loops-handler'
import { makeBrainCaptureOnTurnComplete, threadWorkingSet } from './brain/capture'
import { resolveChatLearnAsk } from './learn/chat-learn-trigger'
import { sweepBrainRoots } from './brain/compaction'
import { AppSettingsStore } from './store/app-settings-store'
import {
  createTelemetryService,
  readMachineFacts,
  type TelemetryService,
} from './telemetry/telemetry-service'
import {
  createTelemetryDelivery,
  type TelemetryDelivery,
} from './telemetry/telemetry-delivery'
import { createMachineIdentityStore } from './auth/identity-file'
import { createAuthSession } from './auth/auth-session'
import { signInToFlow } from './auth/sign-in'
import { configuredProvider } from './auth/flow-provider'
import { configuredShareEndpoint } from './share/share-endpoint'
import { createShareClient } from './share/share-client'
import { isAppMainFrame, registerShareChannels } from './share/share-ipc'
import {
  commitLabelFor,
  createKnowledgeRouter,
  createWorkspaceRoute,
  createWorkspaceSync,
  projectRootOfThread,
  type KnowledgeRouter,
} from './knowledge-sync'
import { registerWorkspaceChannels } from './workspaces/ipc'
import { createWorkspaceRegistry, type WorkspaceRegistry } from './workspaces/workspace-registry'
import { createHostToolSpawner, createHostTools, type HostToolSpawner } from './workspaces/host-tools'
import { createWorkspaceRemoteSetup } from './workspaces/workspace-remote'
import { createWorkspacePlacement, type WorkspacePlacement } from './workspaces/workspace-placement'
import { announceFlowLinksChanged } from './project/flow-link-events'
import { realPathThroughLinksSync } from './project/paths'
import { createContextGate, gateWorkspaceFromMembership } from './agent/context-gate'
import { automaticBasicDiscovery, automaticConnectionsLearning, e2eRendererArguments, e2eSeams } from './e2e-seams'
import { createConnectionsLearner, type ConnectionsLearner } from './workspaces/connections-learner'
import { createImportIndexWarmer, runImportIndexWarm, type ImportIndexWarmer } from './blueprint/import-index-warmer'
import type { BasicDiscoveryStatus } from '../shared/basic-discovery'
import {
  createBasicDiscovery,
  ensureBasicDiscoveryRecord,
  recordBasicDiscovery,
  shouldAskBasicDiscovery,
  type BasicDiscovery,
} from './learn/basic-discovery'
import { createWorkspacePauseNotifier } from './knowledge-sync/pause-notice'
import { appEntryFor, isAppEntryUrl, opensExternally, shouldBlockNavigation, type AppEntry } from './share/app-entry'
import { createProjectIds } from './share/share-project-id'
import { createFileShareRecords } from './share/share-records'
import { useDayKey } from '../shared/consent-prompt'
import { AttachmentStore } from './store/attachment-store'
import { registerSettingsChannels } from './settings/ipc'
import { userPathEnv, warmUserPath } from './agent/runtime/tool-path'
import { recordSlow, setSlowLogDirectory, watchEventLoopLag } from './ipc/slow-handler'
import { configureCliHost } from './cli-host/client'
import { CredentialsManager } from './credentials'
import { FlowObserver, registerFlowChannels, rootsProviderFrom } from './flow/flow-observer'
import { registerArtifactChannels } from './flow/artifact-observer'
import { handleWalkthroughPages, registerWalkthroughPageScheme } from './flow/walkthrough-page'
import { GitManager, gitRootsProviderFrom, registerGitChannels } from './git'
import { GitPublishService } from './git/publish'
import { GIT_CHANGED_EVENT, type GitChangedEvent } from './git/git-manager'
import { createInvariantService, type InvariantService } from './review/invariant-service'
import { loadFeatureRoster, runBundledCliCapturing, runFeatureLearnPass } from './agent/learn-session'
import {
  derivePartsFromView,
  resolvePartFiles,
  runFeatureViewPass,
} from './agent/feature-view-session'
import { runVerifyDoc } from './agent/verify-doc-session'
import { registerReviewChannels } from './review/ipc'
import { generateCommitMessage } from './review/commit-message'
import { ReviewService } from './review/review-service'
import { registerIpcHandlers } from './ipc'
import { UpdaterManager } from './updater/updater-manager'
import { flushEditorContext } from './project/editor-context-flush'
import { ProjectContextManager } from './project/project-context'
import { resolveActiveRoot } from '../shared/root-selection'
import { ThreadScopeManager } from './project/thread-scope-manager'
import { startAutoOpenOnActivation } from './project/auto-open'
import { createDefaultLspManager, registerLspChannels } from './lsp'
import { openDatabase, type FlowDatabase } from './store/db'
import { TaskStore } from './store/task-store'
import { IntegrationsManager } from './integrations/integrations-manager'
import {
  makeSeedProvider,
  makeOnTurnStart,
  makeOnTurnComplete,
  ensureTaskThread,
  syncTaskTitleFromThread,
  generateTaskBrief,
  taskHasBriefContent,
} from './tasks/task-service'
import { briefOnActivation } from './tasks/brief-on-activation'
import { BoardLoop } from './tasks/board-loop'
import { ThreadClaims } from './drive/turn-driver'
import { AutopilotChain } from './drive/autopilot-chain'
import { tailConfigFrom } from './drive/chain-tail'
import { makeRiskCheck, makeStageCheck } from './drive/chain-gates'
import { watchDeletedThreads } from './drive/thread-gone'
import { releaseCheckoutOnThreadDeleted } from './worktree/checkout-on-thread-deleted'
import { LEGACY_AUTOPILOT_FILE, autopilotEnabledIn } from './flow/autopilot'
import { makeTodoMirror } from './tasks/todo-mirror'
import { onThreadStatus as syncCardLane } from './tasks/task-lane-sync'
import { TerminalManager, registerTerminalChannels } from './terminal'
import { wireShellPersistence } from './terminal/shell-persistence'
import { registerFileChannels } from './project/files'
import {
  createAddressableRoots,
  type ThreadWorktree,
} from './project/addressable-roots'
import {
  applyCheckoutRenames,
  describeCheckoutRenames,
  planCheckoutRenames,
} from './worktree/checkout-rename'
import { ThreadWorktreeService, checkoutNameArgs } from './worktree/thread-worktree'
import { ThreadBindingService } from './worktree/thread-binding'
import { readWorktreeInventory } from './worktree/worktree-inventory'
import {
  runDuCapturing,
  runGhCapturing,
  runGitCapturing,
  runSetupCapturing,
} from './worktree/thread-worktree-runners'
import { ThreadLandingService } from './git/thread-merge'
import {
  checkoutOwnersFor,
  collectWorktreeCandidates,
  enforceWorktreeCap,
  listThreadCheckouts,
  worktreeUsage,
} from './worktree/worktree-cap'
import { isWorktreeInUse } from './worktree/worktree-in-use'
import { readThreadWorktreesEnabled } from './flow/thread-worktree-config'
import { readWorktreeSettings } from './flow/worktree-settings'
import { ProjectRegistry } from './project/project-registry'
import { Provisioner, runBundledCli } from './project/provisioner'
import { awaitProvisioningSettled } from './worktree/provision-gate'
import {
  defaultEnumerateModuleEntries,
  LearnOrchestrator,
  selectAllModulePaths,
  type LearnProjectState,
} from './project/learn-orchestrator'
import { buildAccountEnv } from './agent/account-env'
import { LearnEventEmitter } from './learn/learn-events'
import {
  LearnTriggers,
  makeBundledStaleCheck,
  makeBundledGitDiff,
  isMeaningfulDiff,
  isPreviouslyLearned,
  shouldAutoRelearn,
} from './learn/learn-triggers'
import { LearnRunTriggers } from './learn/learn-run-triggers'
import {
  PROJECT_LIST_CHANGED_EVENT,
  PROJECT_FILES_CHANGED_EVENT,
  type ProjectFilesChangedEvent,
} from './project/project-registry'
import { parseFlowconfigText } from './flow/flow-observer'
import { writeFlowconfig } from './flow/flowconfig-writer'
import { parseLearnIgnore } from '../shared/learn-ignore'
import {
  FEATURE_VIEW_DONE_TITLE,
  FEATURE_VIEW_FAILED_TITLE,
  FEATURE_VIEW_NOTE_TITLE,
} from '../shared/feature-view-notice'
import type {
  BasicDiscoveryAnswer,
  BlueprintLearningStatus,
  FlowNotification,
  IpcEventChannel,
  IpcEventPayload,
  LearnForgetTally,
} from '../shared/ipc-contract'
import {
  THREAD_ROOTS_CHANGED_EVENT,
  THREAD_STORE_CHANGE_EVENT,
  ThreadStore,
  type ThreadRootsChangedEvent,
  type ThreadChangeEvent,
} from './store/thread-store'
import { installApplicationMenu } from './menu'
import { windowChromeOptions } from './window-chrome'
import {
  restoreWindowMode,
  secondaryDisplayOverrides,
  trackWindowState,
  windowStateOverrides,
} from './window-state'
import { describeBootstrapError } from './bootstrap-error'

// A discovery's user walkthrough page is served on its own privileged scheme
// (see flow/walkthrough-page.ts). Electron accepts the declaration only BEFORE
// the app is ready, so it runs here, at module load.
registerWalkthroughPageScheme()

const WINDOW_DEFAULT_WIDTH = 1440
const WINDOW_DEFAULT_HEIGHT = 900
const WINDOW_MIN_WIDTH = 960
const WINDOW_MIN_HEIGHT = 600
/** Neutral dark background (matches --fl-color-surface) — avoids a flash
 *  before the renderer paints. */
const WINDOW_BACKGROUND_COLOR = '#1f1f1f'

/** The Flow app icon (black squircle + white />>), rendered at build time to
 *  build/icon.png. In a packaged mac app the dock icon comes from the bundled
 *  .icns (electron-builder mac.icon); this path is for the window icon on
 *  Windows/Linux and the DEV dock icon (packaged mac ignores dock.setIcon). */
function appIconPath(): string {
  return join(app.getAppPath(), 'build', 'icon.png')
}

/**
 * The app-embedded planflow-ai CLI (built by scripts/build-cli-bundle.mjs). It
 * ships under Contents/Resources/cli when packaged and app/resources/cli in dev.
 * Spawned via the Electron binary as Node, so the blueprint derives out of the
 * box with no npm / PATH / system-node dependency. The derive runner verifies
 * the file exists before using it, so returning the path unconditionally is safe.
 */
/**
 * Plan + discovery documents that describe a feature, newest first.
 *
 * A change record and its plan are the same work under two spellings
 * (`chat-session-cache-rework` / `chat_session_cache_rework`), and the discovery docs
 * that produced the plan sit beside it under the same stem. These carry the
 * problem, the constraints and the known failure modes — the material the
 * curated feature view is built from, and which no source file states.
 */
function findFeatureDocs(rootPath: string, featureRef: string): string[] {
  const stem = featureRef.replace(/^feature:/, '').replace(/-/g, '_').toLowerCase()
  const out: string[] = []
  for (const [dir, prefix] of [
    ['plans', 'plan_'],
    ['discovery', 'discovery_'],
  ] as const) {
    const abs = join(rootPath, 'flow', dir)
    let names: string[] = []
    try {
      names = nodeReaddirSync(abs)
    } catch {
      continue // the directory need not exist
    }
    for (const name of names.sort().reverse()) {
      if (!name.startsWith(prefix) || !name.endsWith('.md')) continue
      // `plan_chat_session_cache_rework_v1.md` → `chat_session_cache_rework`
      const middle = name.slice(prefix.length).replace(/_v\d+\.md$/, '').replace(/\.md$/, '')
      if (middle.toLowerCase() === stem) out.push(`flow/${dir}/${name}`)
    }
  }
  return out
}

function resolveBundledCli(): { execPath: string; cliPath: string } {
  // Candidates because getAppPath() differs by launch mode: packaged →
  // Resources/cli; electron-vite dev → app/resources/cli; a direct
  // `electron out/main/index.js` launch (the e2e harness — live bug
  // 2026-07-27: narrate failed with MODULE_NOT_FOUND under out/main/) →
  // app/ is two levels up from the entry dir.
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'cli')]
    : [
        join(app.getAppPath(), 'resources', 'cli'),
        join(app.getAppPath(), '..', '..', 'resources', 'cli'),
      ]
  const base = candidates.find((dir) => existsSync(join(dir, 'planflow-ai.mjs'))) ?? candidates[0]
  return { execPath: process.execPath, cliPath: join(base, 'planflow-ai.mjs') }
}

function createWindow(): BrowserWindow {
  // Restore the last saved size/position (falling back to defaults, and
  // ignoring a position that is no longer on any connected display).
  const savedBounds = windowStateOverrides(WINDOW_DEFAULT_WIDTH, WINDOW_DEFAULT_HEIGHT)
  // E2E runs must never open over the user's working screen: pin the window to
  // a non-primary display when one is connected (null → single display, e.g.
  // CI, and placement stays untouched).
  const e2eBounds = process.env['FLOW_E2E']
    ? secondaryDisplayOverrides(savedBounds.width, savedBounds.height)
    : null
  const window = new BrowserWindow({
    ...savedBounds,
    ...e2eBounds,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    show: false,
    title: 'Flow',
    icon: appIconPath(),
    // Platform window chrome: macOS inset traffic lights, Windows Control
    // Overlay, standard frame elsewhere. See `window-chrome.ts` — `hiddenInset`
    // is macOS-only and left Windows with NO caption buttons at all.
    ...windowChromeOptions(process.platform),
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Where the embedded browser's guest preload lives, handed to the preload
      // on its argv: a SANDBOXED preload has no `__dirname` to work it out from
      // (see GUEST_PRELOAD_ARG in preload/index.ts).
      // The e2e flag rides the same way (`e2eRendererArguments`): main reads
      // its real environment and hands the renderer nothing in a packaged app.
      additionalArguments: [
        `--flow-guest-preload=${join(__dirname, '../preload/browser-guest.js')}`,
        ...e2eRendererArguments(process.env, app.isPackaged),
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Enables the embedded browser tab's sandboxed <webview> (guest stays
      // node-integration-off + sandboxed via its own webpreferences).
      webviewTag: true,
    },
  })

  // Re-apply maximized / fullscreen, then persist future size/position changes.
  restoreWindowMode(window)
  trackWindowState(window)

  window.once('ready-to-show', () => {
    /**
     * FLOW_E2E_BACKGROUND=1 keeps the test window OFF SCREEN.
     *
     * FLOW_E2E already pins e2e runs to a second display, but that is null on a
     * single-display machine — which is most of them — so every spec run threw
     * a window over whatever the person was doing.
     *
     * Opt-in rather than default: a person debugging a spec wants to SEE it.
     */
    if (process.env['FLOW_E2E_BACKGROUND'] === '1') {
      // NEVER SHOWN, not moved off-screen: macOS clamps a window back into the
      // visible work area, so negative bounds left it sitting at x=0 over the
      // person's desk anyway (measured — screenX came back 0).
      //
      // Playwright drives the renderer over CDP, which forces its own frame, so
      // clicks, layout measurements and screenshots all still work against a
      // window that was never shown. Verified: a 400x200 capture came back with
      // 413 distinct colours, i.e. real painted content rather than a blank.
      return
    }
    window.show()
    // The half of startup main owns, on the record. The renderer writes its own
    // three marks; together they say whether a slow open was the process coming
    // up or the surfaces coming up — which nothing could tell us before.
    recordSlow(
      `[main] window shown ${String(Math.round(performance.now()))}ms after launch`,
    )
  })

  // External links open in the default browser, never in-app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // THE MAIN WINDOW SHOWS THE APP AND NOTHING ELSE (review R2-M8). A navigated
  // main window would keep its preload — `window.flow`, sharing included — so
  // its top frame may only ever be the app's own entry. This also stops a file
  // or link dropped on the window from replacing the app (Chromium navigates
  // to a drop). Reloading the entry is allowed, so dev hot reload still works;
  // subframes (the feature view's sandboxed page) are not this guard's concern.
  const entry = rendererEntry()
  const refuseNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (!shouldBlockNavigation(url, entry)) return
    event.preventDefault()
    if (opensExternally(url)) void shell.openExternal(url)
    else console.warn('[Window] refused a navigation away from the app', { scheme: url.split(':')[0] })
  }
  // `will-frame-navigate` fires first, for the top frame and every subframe;
  // it is the one that refuses (and hands a web link to the browser).
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) refuseNavigation(event, event.url)
  })
  // `will-navigate` is the top frame again — refused, never opened twice.
  window.webContents.on('will-navigate', (event) => {
    if (shouldBlockNavigation(event.url, entry)) event.preventDefault()
  })

  const devRendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (devRendererUrl) {
    void window.loadURL(devRendererUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/** The page the main window loads — the built renderer, or the dev server. */
function rendererEntry(): AppEntry {
  return appEntryFor(process.env['ELECTRON_RENDERER_URL'], join(__dirname, '../renderer/index.html'))
}

/** App database lives in Electron's per-user data directory. */
const DATABASE_FILE_NAME = 'flow.db'

/**
 * Turns the invariant checker's model call is allowed. Three, not one: the
 * prompt names file paths, the model reaches for them, the reach is refused
 * (`allowedTools: []`), and the answer lands on the turn after. Small on
 * purpose — this bounds a confused model, it does not license a loop.
 */
const INVARIANT_MODEL_MAX_TURNS = 3

/**
 * Whether guarded auto re-learn is enabled for a root — the per-project
 * `learn_auto` key in `flow/.flowconfig`. DEFAULT ON: absent (or anything but
 * the literal `false`) counts as enabled, so a fresh project auto-relearns
 * meaningful drift out of the box. Fail-soft: an unreadable config → enabled.
 */
async function readLearnAutoEnabled(rootPath: string): Promise<boolean> {
  try {
    const raw = await fsPromises.readFile(join(rootPath, 'flow', '.flowconfig'), 'utf-8')
    return parseFlowconfigText(raw)['learn_auto'] !== 'false'
  } catch {
    // Sanctioned fail-soft: no/unreadable config — treat as the default (on).
    return true
  }
}

/**
 * The learning ignore-list extras for a root — the `learn_ignore` key in
 * `flow/.flowconfig` (comma-separated module patterns), layered on top of the
 * built-in DEFAULT_LEARN_IGNORE_SEGMENTS (see shared/learn-ignore). Gates only
 * the AUTOMATIC paths (basic discovery + the staleness watcher); a manual
 * per-module Learn stays allowed. Fail-soft: no/unreadable config → [] (the
 * built-in defaults still apply in the matcher).
 */
async function readLearnIgnoreExtras(rootPath: string): Promise<string[]> {
  try {
    const raw = await fsPromises.readFile(join(rootPath, 'flow', '.flowconfig'), 'utf-8')
    return parseLearnIgnore(parseFlowconfigText(raw)['learn_ignore'])
  } catch {
    return []
  }
}

let db: FlowDatabase | null = null
let projectRegistry: ProjectRegistry | null = null
let threadScopeManager: ThreadScopeManager | null = null
let disposeAutoOpen: (() => void) | null = null
let agentManager: AgentManager | null = null
let terminalManager: TerminalManager | null = null
let learnOrchestrator: LearnOrchestrator | null = null
/**
 * Basic discovery for every Workspace project (learn/basic-discovery.ts) —
 * built once the learn orchestrator exists; every earlier caller reaches it
 * through this slot and does nothing until it is set.
 */
let basicDiscovery: BasicDiscovery | null = null
/**
 * Connections learning (workspaces/connections-learner.ts) — built beside
 * basic discovery, whose finishing a project is what starts it.
 */
let connectionsLearner: ConnectionsLearner | null = null
let learnTriggers: LearnTriggers | null = null
let learnRunTriggers: LearnRunTriggers | null = null
let disposeIpc: (() => void) | null = null
let disposeAgentIpc: (() => void) | null = null
let disposeAccountsIpc: (() => void) | null = null
let disposeFileIpc: (() => void) | null = null
let disposeFlowIpc: (() => Promise<void>) | null = null
let disposeArtifactIpc: (() => void) | null = null
let disposeWalkthroughPages: (() => void) | null = null
let disposeBlueprintIpc: (() => void) | null = null
let disposeBrainIpc: (() => void) | null = null
let disposeShareIpc: (() => void) | null = null
let disposeWorkspacesIpc: (() => void) | null = null
/** Which Workspace's sync carries a project's knowledge. Quit runs the engine's bounded last commit through it. */
let knowledgeRouter: KnowledgeRouter | null = null
let disposeLoopsIpc: (() => void) | null = null
let disposeSettingsIpc: (() => void) | null = null
let disposeTerminalIpc: (() => void) | null = null
let disposeLspIpc: (() => Promise<void>) | null = null
let disposeGitIpc: (() => void) | null = null
let disposeReviewIpc: (() => void) | null = null
let invariantService: InvariantService | null = null
/**
 * Install facts and the session boundary (client-identity Phase 2).
 *
 * Created at bootstrap and closed in disposal, so a session's length is the
 * app's actual run. It sends nothing unless the person said yes, and — until
 * Phase 4 supplies a host — nothing anywhere at all; see telemetry-service.ts.
 */
let telemetryService: TelemetryService | null = null
/** Batching, the bounded queue and the POST. Null until bootstrap. */
let telemetryDelivery: TelemetryDelivery | null = null
/**
 * The signed-in person, when there is one.
 *
 * Nothing signs in yet — the sign-in surface waits on a provider — so this is
 * always empty today. It is wired now because the JOIN is the point: the
 * moment somebody signs in, the events their installation already sent become
 * theirs, with no second identifier and nothing re-sent.
 */
let identityStore: ReturnType<typeof createMachineIdentityStore> | null = null

function bootstrapMainProcess(): void {
  // WHERE STARTUP GOES. "I click the input when the app opens and the cursor
  // spins" is a report about this function, and until now it produced one
  // number (window shown at Nms) with no way to see inside it. Each milestone
  // is stamped; the line is written once, at the end, and only names the
  // stretches that actually cost something.
  const bootStartedAt = performance.now()
  const milestones: Array<[string, number]> = []
  const mark = (name: string): void => {
    milestones.push([name, performance.now()])
  }
  db = openDatabase(join(app.getPath('userData'), DATABASE_FILE_NAME))
  mark('database')
  // Claude's native engine: a build that shipped without it (v0.1.10 Windows
  // did) downloads the matching one into userData, in the background, so the
  // first chat does not have to wait for it. A no-op when it is bundled; a
  // failure here is retried by the first session, which reports it.
  configureAgentBinary(app.getPath('userData'))
  void ensureAgentBinary().then(
    (binary) => {
      if (binary.source !== 'bundled') console.log(`[agent-binary] using ${binary.source} engine: ${binary.path}`)
    },
    (error: unknown) => console.warn(`[agent-binary] ${error instanceof Error ? error.message : String(error)}`),
  )
  // The app-embedded CLI (see resolveBundledCli above) plus an on-PATH shim
  // wrapping it, so IDE-launched agent sessions can shell out to
  // `planflow-ai` even in projects with no local install. Fail-soft: a null
  // shimDir (e.g. read-only userData) just means sessions don't get the
  // extra PATH entry — everything else keeps working.
  const bundledCli = resolveBundledCli()
  mark('bundled cli')
  const cliShimDir = ensureCliShim(
    app.getPath('userData'),
    dirname(bundledCli.cliPath),
    bundledCli.execPath,
    app.getVersion(),
  )
  // The OTHER shim — the one `init`'s PATH rails put in ~/.local/bin for the
  // user's own terminals. An app update (or a deleted checkout) leaves it
  // naming an entry that no longer exists; the CLI rewrites it, and only a
  // shim plan-flow wrote. Off the window's path, fire-and-forget. Never in a
  // hidden e2e run: that run shares the developer's real home directory.
  if (process.env['FLOW_E2E'] !== '1') {
    void repairStaleUserCliShim({
      homeDir: app.getPath('home'),
      runCli: (args) => runBundledCli(bundledCli, app.getPath('home'), args),
    })
  }
  // App-wide settings (onboarding + autonomy default). New threads inherit the
  // autonomy default when not given an explicit permission mode (#48).
  mark('cli shim')
  const appSettings = new AppSettingsStore(db)
  // NOTHING HERE MAY THROW OR BLOCK: it runs inside bootstrap, where a failure
  // is a window that never opens. The service swallows its own errors; this
  // catch covers the construction itself.
  // ONE DAY OF USE, counted once however many times the app starts today. This
  // is what the telemetry question waits for — the third day somebody actually
  // uses Flow, rather than the third day after they installed it.
  try {
    appSettings.countUseDayNow(useDayKey(new Date()))
  } catch (error) {
    console.warn('[Main] could not count a day of use:', error)
  }
  try {
    identityStore = createMachineIdentityStore(app.getPath('userData'), safeStorage)
  } catch (error) {
    console.warn('[Main] identity store unavailable:', error)
  }
  try {
    telemetryDelivery = createTelemetryDelivery({
      // ONCE, THEN SILENCE — a line per failed batch is log spam on a laptop
      // that is simply offline.
      onUnreachable: () => console.warn('[Main] telemetry endpoint unreachable; events are dropped'),
    })
    // THE ONE LINE THAT SAYS WHAT THIS BUILD DECIDED. A refusal is loud on
    // purpose: shipping is the irreversible act, and a key that can read must
    // never reach a client.
    if (telemetryDelivery.state === 'refused') {
      console.error(`[Main] telemetry disabled — ${telemetryDelivery.reason ?? 'refused'}`)
    }
    telemetryService = createTelemetryService({
      transport: telemetryDelivery.transport,
      rootInstallId: () => appSettings.getLoopOwnerId(),
      firstRunAt: () => appSettings.getFirstRunAt(),
      consent: () => appSettings.getTelemetryConsent(),
      facts: () =>
        readMachineFacts({
          appVersion: app.getVersion(),
          platform: process.platform,
          osVersion: release(),
          arch: process.arch,
          locale: app.getLocale(),
        }),
      // READ AT SEND TIME, so signing in or out takes effect on the next
      // report rather than the next restart.
      identityId: () => identityStore?.load()?.subject ?? null,
      newSessionId: () => randomUUID(),
    })
    telemetryService.start()
  } catch (error) {
    console.warn('[Main] telemetry did not start:', error)
  }
  const threadStore = new ThreadStore(
    db,
    () => appSettings.getAutonomyBypassDefault(),
    // PER RUNTIME (see modelKeyFor): a new thread inherits the preference of
    // the runtime it will actually run under, not the last one picked anywhere.
    () => appSettings.getDefaultModelSelection(appSettings.getDefaultProvider() ?? 'claude'),
  )
  // Sessions don't survive a restart — clear any thread stuck 'working' and
  // any tool call stuck 'running' from a previous run (they'd spin forever).
  threadStore.reconcileInterruptedWork()
  mark('thread store')
  const credentials = new CredentialsManager()
  // Task list: a task owns one thread; IntegrationsManager reads Jira/GitHub
  // issues (read-only via a stored PAT).
  const taskStore = new TaskStore(db)
  // Brief generation doesn't survive a restart either — sweep any task left
  // 'pending' by an interrupted run back to 'idle' so its detail modal offers
  // Generate instead of claiming work is in flight forever (#1026).
  taskStore.reconcileInterruptedBriefs()
  // A card an agent parked in Blocked (its thread went 'needs-decision') never
  // got answered back out if the app quit first — restore it to the lane it came
  // from. The lane half of reconcileInterruptedWork's thread sweep above.
  taskStore.reconcileAgentBlocks()
  // Heal the backlog of "Untitled task" cards whose chat was auto-named before
  // the per-turn title mirror existed — a one-time copy of the thread's title
  // onto its owning card, so they don't wait for another turn to catch up.
  taskStore.reconcileUntitledTaskCards()
  mark('task store')
  const integrations = new IntegrationsManager(credentials)
  projectRegistry = new ProjectRegistry(db)
  const projectContext = new ProjectContextManager(db)
  mark('project registry')
  // #1080: per-project state (tabs, terminals, active thread) may only be
  // persisted for a path that is STILL a project root. Without this, removing
  // the active project let the renderer's outgoing-tab persist re-INSERT the
  // removed project's workspace_state row right after `forget()` deleted it,
  // making a non-root the newest `last_active_at` row forever — and every later
  // boot then resolved `lastActiveProject()` to it and activated nothing.
  {
    const manager = projectRegistry
    projectContext.setKnownRootCheck((rootPath) =>
      manager.getRoots().some((root) => root.rootPath === rootPath),
    )
  }
  // THE ADDRESS GATE (Phase 3.5). One predicate answers "may the renderer
  // address this root?" for the project file channels, the file tree and the
  // git write channels: a registered project root, OR a checkout some thread
  // owns. A thread's worktree is deliberately never registered as a project —
  // putting checkouts in the user's project list would be worse than the bug —
  // so without this every path inside a thread's own worktree is refused, and
  // the editor throws the moment a thread gets one.
  const registry = projectRegistry
  const threadWorktrees = (): ThreadWorktree[] => threadStore.listThreadWorktrees()
  const addressableRoots = createAddressableRoots({
    registeredRoots: () => registry.getRoots(),
    threadWorktrees,
  })
  registry.setThreadWorktrees(threadWorktrees)
  // …AND THE SAME GATE DECIDES WHICH PERSISTED TABS COME BACK. A checkout that
  // was renamed or pruned leaves its tabs in `workspace_state`, and restoring
  // one throws `Unknown root` — once per tab, on every activation of that
  // project, for the life of the row. One predicate, both questions
  // (allowed-pattern #14): if the renderer may not address it, it is not handed
  // a tab in it.
  projectContext.setAddressableCheck((rootPath) => addressableRoots.isAddressable(rootPath))
  // A deleted conversation's tab set is dropped with it (thread-store); a late
  // persist from the renderer's switch-away must not write it straight back.
  projectContext.setKnownThreadCheck((threadId) => threadStore.getThread(threadId) !== null)

  // THE CHECKOUTS NOBODY NAMED, reported before any window exists.
  //
  // Every checkout cut before 2026-09-17 lives in `.{repo}-threads/<thread-id>`
  // and reads as a uuid in a person's shell prompt. Renaming them is what the
  // upgrade is for — and renaming a directory a terminal or an agent is
  // standing in is how a migration becomes an incident, so it runs HERE, before
  // any of those exist, and it runs as a REPORT unless somebody has asked for
  // the move.
  //
  // OFF BY DEFAULT, DELIBERATELY. A rename of every checkout on a machine is
  // not something to meet by surprise on a launch you expected to be ordinary
  // (forbidden-pattern #15): the dry run says exactly what it would do, and the
  // move happens when a person has read that.
  void (async () => {
    try {
      const plan = planCheckoutRenames(threadStore.listCheckoutsForRename())
      if (plan.length === 0) return
      const asked = process.env['FLOW_RENAME_CHECKOUTS'] === '1'
      const results = await applyCheckoutRenames(
        {
          // The system git, directly and async — this runs once, at startup,
          // and must never block the process every window waits on
          // (allowed-pattern #19).
          runGit: (cwd: string, args: readonly string[]) =>
            new Promise((resolve) => {
              execFile('git', [...args], { cwd }, (error, _stdout, stderr) => {
                resolve(
                  error === null
                    ? { ok: true }
                    : { ok: false, stderr: String(stderr || error.message) },
                )
              })
            }),
          exists: (path) => existsSync(path),
          // `git worktree move` will not create the folder it moves into, and
          // `.{repo}-threads/worktree/` is new the first time.
          ensureParent: (path) => {
            mkdirSync(path, { recursive: true })
          },
          repoint: (from, to) => threadStore.repointCheckout(from, to),
        },
        plan,
        { dryRun: !asked },
      )
      console.log(
        asked
          ? `[Checkouts] ${describeCheckoutRenames(results)}`
          : `[Checkouts] ${plan.length} checkout(s) are named after a thread id and would be renamed:\n` +
              plan.map((entry) => `  ${entry.from} → ${entry.name}`).join('\n'),
      )
    } catch (error) {
      // A migration that cannot run leaves everything exactly as it was, which
      // is a working app with uglier folder names.
      console.warn('[Checkouts] could not plan the rename', error)
    }
  })()
  // Thread scope (multi-project threads): derives the active thread's ordered
  // root set from projectContext + threadStore + the project root list, and
  // re-derives on every input seam. start() subscribes BEFORE the restore
  // below so the boot-time setActiveProject already lands in the scope.
  threadScopeManager = new ThreadScopeManager({
    projectContext,
    threadStore,
    projectRegistry,
  })
  threadScopeManager.start()
  // Auto-open on thread activation (phase 6): activating a thread opens its
  // attached roots that exist on disk but aren't project roots yet; missing
  // roots stay unavailable scope entries (handled by the scope model).
  disposeAutoOpen = startAutoOpenOnActivation({
    projectContext,
    threadStore,
    projectRegistry,
  })
  // Auto-provisioning (ide-auto-provisioning): keep every project root
  // scaffolded for the app-embedded CLI's version with no terminal. Failures
  // surface as a single flow:notification toast, broadcast to every window.
  // Broadcast a flow:notification toast to every open window (shared by the
  // provisioner's failure toast AND the session-start gate's warn toasts).
  const broadcastNotification = (notification: FlowNotification): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('flow:notification', notification)
      }
    }
  }
  /**
   * Toast something decided during bootstrap — which runs BEFORE `createWindow()`,
   * so `broadcastNotification` would fan out to zero windows. Delivers to the
   * first window once its renderer has finished loading (#975).
   */
  const notifyOnFirstWindow = (notification: FlowNotification): void => {
    const live = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
    if (live.length > 0) {
      broadcastNotification(notification)
      return
    }
    app.once('browser-window-created', (_event, window) => {
      window.webContents.once('did-finish-load', () => {
        if (!window.isDestroyed()) window.webContents.send('flow:notification', notification)
      })
    })
  }
  /** Boot found the project we should open, but its folder isn't there and no
   *  sibling could take over — name the problem instead of opening an empty
   *  window that reads as "Flow is broken" (#975). */
  const notifyUnreachableProject = (rootPath: string): void => {
    notifyOnFirstWindow({
      kind: 'state-change',
      rootId: rootPath,
      title: 'Project folder not found',
      body: `${rootPath} isn't where it used to be — it may have been moved, renamed, or its drive isn't mounted. Open another folder, or remove the project from the sidebar.`,
      timestamp: new Date().toISOString(),
      level: 'warn',
    })
  }
  // Typed sibling of broadcastNotification: push any main → renderer event to
  // every live window. The channel/payload pair is contract-checked.
  const broadcast = <C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload)
      }
    }
  }
  // WORKSPACES (plan_workspaces-knowledge-hub; always on since the hard
  // migration, 2026-10-06). Every answer comes from the bundled CLI's
  // `workspace` verbs — the source of truth — through one registry; membership
  // is derived, never stored, so the profile's schema does not move (the
  // installed build and the dev build share it). Built before provisioning is
  // wired, because every open of a project ends with its Workspace's sync.
  /**
   * Every open project in a Workspace that lacks its basic discovery gets its
   * sweep queued — the launch re-check, and after every Workspace change.
   * Fire-and-forget; the coordinator reads asynchronously and runs one sweep
   * at a time (allowed-pattern #19).
   */
  const reconcileBasicDiscovery = (): void => {
    const roots = (projectRegistry?.getRoots() ?? []).filter((root) => root.available !== false).map((root) => root.rootPath)
    void basicDiscovery?.reconcile(roots).catch((error: unknown) => {
      console.warn('[BasicDiscovery] re-check failed', error)
    })
  }
  const workspaces = createWorkspaceRegistry({
    runCli: (cwd, args, options) => runBundledCliCapturing(bundledCli, cwd, args, options),
    settings: appSettings,
    homeDir: app.getPath('home'),
    onChanged: (event) => {
      broadcast('workspaces:changed', event)
      // These rewrite projects' `flow` links: the watchers follow the new targets.
      if (['linked', 'joined', 'migrated', 'moved', 'deleted'].includes(event.cause)) {
        announceFlowLinksChanged()
        // A project joined (or moved between) Workspaces: one without its
        // basic discovery gets it now, without being asked.
        reconcileBasicDiscovery()
      }
    },
  })
  // WORKSPACE SYNC (Phase 8): one record per Workspace, each step one call to
  // the CLI's `workspace sync`. A pause (a decision, a merged version) or an
  // error raises ONE notification on the transition; retries raise nothing.
  const workspacePauseNotifier = createWorkspacePauseNotifier()
  const workspaceSync = createWorkspaceSync({
    runCli: (cwd, args, options) => runBundledCliCapturing(bundledCli, cwd, args, options),
    cwd: app.getPath('home'),
    lastSynced: {
      get: (slug) => appSettings.getKnowledgeLastSyncedAt('workspace', slug),
      set: (slug, at) => appSettings.setKnowledgeLastSyncedAt('workspace', slug, at),
    },
    nameOf: async (slug) => {
      const listed = await workspaces.list()
      if (!listed.ok) return null
      return listed.workspaces.find((workspace) => workspace.slug === slug)?.name ?? null
    },
    onStatus: (slug, name, status) => {
      broadcast('workspaces:syncChanged', { slug, status })
      const notice = workspacePauseNotifier.observe(slug, status, new Date().toISOString(), name)
      if (notice !== null) broadcastNotification(notice)
    },
  })
  const knowledgeRoutes = createKnowledgeRouter({
    workspaces: workspaceSync,
    route: createWorkspaceRoute({
      registry: workspaces,
      log: (message, detail) => console.warn(`[KnowledgeSync] ${message}`, detail ?? {}),
    }),
  })
  knowledgeRouter = knowledgeRoutes
  /** Sync the project's Workspace once provisioning for the root has settled. Fire-and-forget; failures are status. */
  const openKnowledge = (rootPath: string): void => {
    void knowledgeRoutes.open(rootPath).catch((error: unknown) => {
      console.warn('[KnowledgeSync] open failed', { rootPath, error: String(error) })
    })
  }
  // EVERY PROJECT LIVES IN A WORKSPACE. The launch's migration moves every
  // project outside one into the Default Workspace once provisioning has
  // settled (the startup sweep below starts it); a project added later joins
  // the Workspace it was added to, right after it is provisioned. Never on a
  // path a person waits on (allowed-pattern #19).
  // A hidden end-to-end run with no Flow folder of its own would move its
  // throwaway projects into the developer's real one — so it places nothing
  // (forbidden-pattern #15). The e2e fixture always gives it one.
  const e2eWithoutFlowFolder = process.env['FLOW_E2E'] === '1' && (process.env['PLAN_FLOW_HOME'] ?? '') === ''
  /** Set once the blueprint observer exists (below) — placement can re-aim it. */
  let rewatchBlueprints: () => void = () => undefined
  let importIndexWarmer: ImportIndexWarmer | null = null
  const placement: WorkspacePlacement = createWorkspacePlacement({
    registry: workspaces,
    roots: () =>
      (projectRegistry?.getRoots() ?? []).filter((root) => root.available !== false).map((root) => root.rootPath),
    notify: (notification) => notifyOnFirstWindow(notification),
    onChanged: () => {
      broadcast('workspaces:changed', { cause: 'placement' })
      reconcileBasicDiscovery()
      // A project that just joined a Workspace had its `flow/` replaced by a
      // link under the running watchers — re-aim them, or the board stops
      // hearing that project's derives until the next launch.
      rewatchBlueprints()
    },
  })
  const provisioner = new Provisioner({
    bundledCli,
    stampProvisioned: (rootId, version, at) =>
      projectRegistry?.stampProvisioned(rootId, version, at),
    notify: broadcastNotification,
  })
  // Progressive-learning (#513 phase 2): the decoupled main-side emitter that
  // carries a basic-discovery request from the onboarding ask / Settings action
  // to Phase 6's orchestrator (which subscribes later). Defined + wired now.
  const learnEvents = new LearnEventEmitter()
  // Roots already offered the basic-discovery ask THIS session — dedupes the
  // repeated 'ready' transitions a root emits (startup sweep, re-provisions),
  // so the ask surfaces at most once per session. Persistence (the answer
  // column) makes it never re-ask across sessions once answered.
  const basicDiscoveryAsked = new Set<string>()
  /** Prompt the renderer's one-time basic-discovery ask for a root that just
   *  became ready and was never answered. rootId here is the uuid; the ask
   *  event addresses the root by path (project addressing convention). */
  const maybeAskBasicDiscovery = async (rootId: string): Promise<void> => {
    const root = projectRegistry?.getRoots().find((candidate) => candidate.id === rootId)
    if (!root || root.available === false) return
    if (root.basicDiscoveryAnswer !== undefined) return // already answered — never re-ask
    if (basicDiscoveryAsked.has(rootId)) return // asked already this session
    // A WORKSPACE PROJECT IS NEVER ASKED: it gets its basic discovery on its
    // own (learn/basic-discovery.ts). Only a project outside every Workspace —
    // one whose placement failed — still sees the one-time ask.
    const automatic = automaticBasicDiscovery()
    const inWorkspace = automatic && (await workspaces.workspaceOfRoot(root.rootPath).catch(() => null)) !== null
    const ask = shouldAskBasicDiscovery({
      answered: root.basicDiscoveryAnswer !== undefined,
      // Re-read: another 'ready' may have asked while the membership was read.
      askedThisSession: basicDiscoveryAsked.has(rootId),
      automatic,
      inWorkspace,
    })
    if (!ask) return
    basicDiscoveryAsked.add(rootId)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('learn:basicDiscoveryAsk', { rootId: root.rootPath })
      }
    }
  }
  // Mirror every readiness transition onto the in-memory root + rootsChanged
  // (#513, progressive-learning phase 1) — the ONE bridge from Provisioner's
  // state machine to the sidebar/renderer; Phase 2 gating subscribes to the
  // Provisioner directly (main-side, no need to round-trip through here).
  /** Roots that turned ready and may be asked once they are placed. */
  const readyForAsk = new Set<string>()
  provisioner.onStateChange((rootId, state) => {
    projectRegistry?.setProvisioningState(rootId, state)
    // First transition to ready for a never-answered root → the one-time ask —
    // but only once the project has been PLACED: a project that is about to
    // join a Workspace is never asked (it is swept on its own), and asking on
    // the ready edge itself raced the placement that follows it. The ask is
    // made after `placement.place` (maybeProvision) or the launch migration.
    if (state === 'ready') readyForAsk.add(rootId)
    // Provisioning may have linked `flow/` (into the vault) under a running
    // watcher — re-aim any that moved.
    if (state === 'ready') rewatchBlueprints()
    // …and a Workspace project waiting on setup may now get its discovery.
    if (state === 'ready') {
      const ready = projectRegistry?.getRoots().find((candidate) => candidate.id === rootId)
      if (ready !== undefined) {
        basicDiscovery?.rootReady(ready.rootPath)
        void basicDiscovery?.reconcile([ready.rootPath]).catch(() => undefined)
      }
    }
    // AND PICK UP WHAT WAS LEFT QUEUED. resumeInterrupted gives up when a root
    // is not ready yet, on the promise that "roots-changed fires again when
    // provisioning finishes" — which is a promise about an event that may
    // already have fired. Readiness itself is the event: three modules sat
    // 'queued' in a real project for fifteen hours while the panel insisted it
    // was learning.
    // `rootId` here is the project's uuid; the orchestrator addresses a root by
    // its PATH (a uuid resolved as `<uuid>/flow/brain/.structure` against cwd).
    if (state === 'ready') {
      const readyRoot = projectRegistry?.getRoots().find((candidate) => candidate.id === rootId)
      if (readyRoot !== undefined) void learnOrchestrator?.resumeInterrupted(readyRoot.rootPath)
    }
  })
  // Record + act on the user's answer to the basic-discovery ask (also the
  // Settings "Run basic discovery" re-fire, which always sends 'yes').
  const answerBasicDiscovery = (rootPath: string, answer: BasicDiscoveryAnswer): void => {
    const root = projectRegistry?.getRoots().find((candidate) => candidate.rootPath === rootPath)
    if (!root) return
    projectRegistry?.recordBasicDiscoveryAnswer(root.id, answer)
    // Mark asked so a concurrent 'ready' can't re-surface the prompt this session.
    basicDiscoveryAsked.add(root.id)
    if (answer === 'yes') {
      // Phase 6's orchestrator listens on this emitter; for now it simply
      // records the intent (no discovery runs yet).
      learnEvents.emitBasicDiscoveryRequested(rootPath)
    }
  }
  // Look up the full root (id/stamp) for a path, then fire the decide→act
  // pipeline fire-and-forget. Unknown paths (never added) simply no-op.
  const askAfterPlacement = (rootId: string): void => {
    if (!readyForAsk.delete(rootId)) return
    void maybeAskBasicDiscovery(rootId)
  }
  const maybeProvision = (rootPath: string, options: { workspace?: string } = {}): void => {
    const root = projectRegistry?.getRoots().find((candidate) => candidate.rootPath === rootPath)
    // …then the project joins its Workspace (when it is in none yet) and the
    // Workspace syncs — both AFTER provisioning settles, so neither races
    // `planflow-ai init` for the same folder.
    if (root) {
      void provisioner
        .maybeProvision(root)
        .then(() => (e2eWithoutFlowFolder ? undefined : placement.place(root.rootPath, options.workspace)))
        .then(() => {
          askAfterPlacement(root.id)
          openKnowledge(root.rootPath)
        })
    }
  }
  // Manual re-provision (Flow settings "Re-provision now"): force the
  // provision flow regardless of the root's current stamp — re-running init
  // is idempotent (#14 single init-spawn path via runBundledCli).
  const provisionRoot = (rootPath: string): Promise<void> => {
    const root = projectRegistry?.getRoots().find((candidate) => candidate.rootPath === rootPath)
    return root ? provisioner.provisionRoot(root, 'provision') : Promise.resolve()
  }
  // Session-start provisioning gate (#513 phase 2): an agent session against a
  // root still being provisioned waits (bounded 120s) for it to settle before
  // spawning. `ready`/`idle`/unknown proceed instantly; a `failed` root proceeds
  // with a one-line toast pointing at Settings → Re-provision; a timeout proceeds
  // with a "still setting up" notice. NEVER hard-blocks — the AgentManager only
  // awaits this resolving.
  const awaitProvisioning = (rootPath: string): Promise<void> => {
    const root = projectRegistry?.getRoots().find((candidate) => candidate.rootPath === rootPath)
    if (!root) return Promise.resolve()
    const rootId = root.id
    return awaitProvisioningSettled({
      initialState: root.provisioningState,
      subscribe: (onState) =>
        provisioner.onStateChange((id, state) => {
          if (id === rootId) onState(state)
        }),
    }).then((outcome) => {
      if (outcome === 'failed') {
        broadcastNotification({
          kind: 'state-change',
          rootId: rootPath,
          title: 'Plan-flow setup incomplete',
          body: 'Setting up plan-flow for this project failed — Re-provision it in Settings, then retry.',
          timestamp: new Date().toISOString(),
          level: 'warn',
        })
      } else if (outcome === 'timeout') {
        broadcastNotification({
          kind: 'state-change',
          rootId: rootPath,
          title: 'Still setting up plan-flow',
          body: 'Provisioning is taking longer than expected — starting the agent anyway.',
          timestamp: new Date().toISOString(),
          level: 'warn',
        })
      }
    })
  }
  const permissions = new PermissionBroker(db)
  // Per-project Anthropic accounts: the resolver picks each project's account
  // (override ?? default ?? legacy) and the AgentManager injects its isolated
  // CLAUDE_CONFIG_DIR at session start (fail-closed when unavailable).
  const accountStore = new AccountStore(db)
  const accountResolver = new AccountResolver(accountStore)
  const loginOrchestrator = new LoginOrchestrator()
  // Task-list hooks (decoupled): seed the agent's first turn with the issue
  // context, and drive Kanban lane automation on turn start / clean finish.
  const onTaskTurnComplete = makeOnTurnComplete(taskStore)
  // THE BOARD'S OWN LOOP. Built here because it needs the AgentManager to start
  // a turn, and held in main because a run outlives the Tasks tab: closing the
  // view must not abandon an agent mid-task.
  // WHO IS DRIVING WHICH CONVERSATION — one registry, shared by every driver.
  // The board's loop and the autopilot chain are the same machine with
  // different questions, and two of them advancing one thread would answer a
  // single finished turn twice. A claim is taken at dispatch and released when
  // that turn ends, so "is anything already working this conversation" has one
  // answer rather than a convention.
  const threadClaims = new ThreadClaims()
  // A chain runs the flow's steps in one conversation. Built after the landing
  // service (it publishes through the same path the landing panel uses), so the
  // handle is declared here and filled in below — the aggregator that routes
  // turn completions is further down still.
  /** threadId → the id of the last message a chain sent into it. */
  const chainFirstMessageId = new Map<string, string>()
  let autopilotChain: AutopilotChain | null = null
  const boardLoop = new BoardLoop({
    claims: threadClaims,
    taskStore,
    threadStore,
    ensureThread: (taskId) => ensureTaskThread({ taskStore, threadStore }, taskId),
    sendMessage: async (threadId, content) => agentManager!.sendMessage(threadId, content),
    // A CARD'S THREAD IS CHAINED, whatever the project's autopilot key says.
    // `autonomous` is not a bypass of that consent, it is the other one: a
    // conversation the loop opened exists because somebody pressed play on
    // cards they ticked, and gating it on a PROJECT-WIDE key would mean either
    // that loop runs silently stopped chaining or that pressing play changed
    // how the person's own conversations behave. `BoardLoopDeps.beginChain`
    // carries the full argument; the chain refuses for its other reasons (the
    // thread is gone, something else is driving it) and the loop then works the
    // card as a single turn.
    beginChain: async (threadId, brief) => {
      if (autopilotChain === null) return false
      const status = await autopilotChain.begin(threadId, { aim: brief, autonomous: true })
      return status.running
    },
    onChange: (rootPath, status) => {
      broadcast('tasks:boardLoopChanged', { projectRoot: rootPath, ...status })
    },
    // A clean loop turn opens a pull request for its card and moves it to
    // Review. `threadLanding` is constructed further down; this closure only
    // runs at turn-complete, long after it exists. `canOpenPullRequest` is the
    // same gate the landing panel uses (a bound thread, a `gh`, a base on the
    // remote, a real branch) — false there means null here, and the card stays
    // put with its "Done?" suggestion.
    openPullRequestForReview: async (threadId) => {
      // A CHAINED CARD'S PULL REQUEST IS ALREADY OPEN. The chain's own tail
      // publishes after the review, so asking for a second one here would send
      // `gh` to open a pull request that exists, fail, and leave the card in
      // Doing with its work published — the wrong lane for the right outcome.
      // The chain keeps the URL after it ends, precisely so this can read it.
      const chained = autopilotChain?.status(threadId).prUrl ?? null
      if (chained !== null) return { url: chained }
      const preview = await threadLanding.preview(threadId)
      if (!preview.canOpenPullRequest) return null
      const result = await threadLanding.land(threadId, {
        mode: 'pull-request',
        confirmed: true,
        message: preview.message,
      })
      const opened = result.rows.find(
        (row) => row.outcome === 'opened' && typeof row.url === 'string' && row.url !== '',
      )
      return opened !== undefined && typeof opened.url === 'string' ? { url: opened.url } : null
    },
  })
  // The capture → compaction work of the turn that just ended, handed over
  // synchronously by the capture's seam so the knowledge commit can follow it
  // (compaction writes brain/features/*.md, which is synced knowledge).
  let lastBrainWork: Promise<unknown> | null = null
  const onBrainTurnComplete = makeBrainCaptureOnTurnComplete(threadStore, undefined, undefined, (work) => {
    lastBrainWork = work
  })
  /**
   * Commit what a finished turn wrote to its PROJECT's knowledge repo — a
   * thread's checkout links `flow/` to the project's, so the project root is
   * where the commit belongs. The label names the skill (or "turn") and the
   * project's folder, never the thread title. Best-effort: never blocks or
   * fails the turn; a project without sync costs one file read.
   */
  const commitKnowledgeAfterTurn = (threadId: string, work: Promise<unknown> | null): void => {
    const thread = threadStore.getThread(threadId)
    const projectRoot = projectRootOfThread(thread)
    if (projectRoot === null) return
    const lastUser = threadStore
      .listMessages(threadId, { limit: 20 })
      .filter((message) => message.role === 'user')
      .pop()
    const lastUserText = lastUser?.content ?? null
    // The thread's attached projects too: one sync per Workspace among them
    // (a project's own knowledge repo stays the primary's only, as before).
    const attached = threadStore.getThreadRoots(threadId)
    void (work ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => knowledgeRoutes.commitAfterTurn(projectRoot, attached, (root) => commitLabelFor(root, lastUserText)))
      .catch((error: unknown) => {
        console.warn('[KnowledgeSync] commit after turn failed', { error: String(error) })
      })
  }
  // Chat-learn ask: threads already prompted (one ask per thread, ever) and the
  // module each pending ask refers to, so the renderer's answer cannot name a
  // module the user was never shown.
  const chatLearnAsked = new Set<string>()
  /**
   * Offer to learn the area a conversation just worked in.
   *
   * Everything here is best-effort and silent on failure: this rides on the end
   * of a turn the user asked for, and must never cost them anything. The
   * decision itself is pure (`resolveChatLearnAsk`) — this only gathers inputs.
   *
   * KNOWN GAP: `cores` is empty, so the prompt cannot yet NAME the feature the
   * work will hang under (`features graph --json` exposes anchorCount, not
   * anchors). Attachment still happens — `features reclass` re-levels the store
   * after the learn — the dialog just doesn't preview the parent's name.
   */
  const maybeAskChatLearn = async (threadId: string): Promise<void> => {
    try {
      if (chatLearnAsked.has(threadId)) return
      const thread = threadStore.getThread(threadId)
      if (!thread?.projectRoot) return
      // Learn state, the graph and the board live on the PROJECT root; the
      // files the run wrote are measured against the thread's work root.
      const { projectRoot } = thread
      // The PATHS, not the inputs: a Write's input is the whole file it wrote,
      // and a working set needs one field out of it (measured: 1.69 MB per
      // read on a 600-call thread).
      const files = threadWorkingSet(thread, threadStore.listToolCallPaths(threadId))
      if (files.length === 0) return
      const state = await readLearnProjectState(projectRoot)
      const statusByModule = new Map<string, BlueprintLearningStatus>()
      for (const entry of state.learning ?? []) statusByModule.set(entry.module, entry.status)
      const ask = resolveChatLearnAsk({
        files,
        modulePaths: selectAllModulePaths(state.graph),
        statusByModule,
        cores: [],
        askedThreads: chatLearnAsked,
        threadId,
      })
      if (ask === null) return
      chatLearnAsked.add(threadId)
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('learn:chatLearnAsk', {
            rootId: projectRoot,
            threadId,
            modulePath: ask.modulePath,
            fileCount: ask.fileCount,
            parentName: ask.parentName,
          })
        }
      }
    } catch {
      // Best-effort: a turn must never fail because we tried to learn from it.
    }
  }
  /**
   * The user's answer. 'yes' enqueues a DELIBERATE learn pass (they asked for
   * it, so the session budget must not drop it) and then re-levels the store so
   * the result hangs under the feature that owns it — `features reclass` is the
   * existing one-writer path for that, not a new verb.
   */
  const answerChatLearn = (
    rootPath: string,
    modulePath: string,
    answer: BasicDiscoveryAnswer,
  ): void => {
    if (answer !== 'yes') return
    learnOrchestrator?.enqueueModule(rootPath, modulePath, {
      reason: 'basic-discovery',
      deliberate: true,
    })
    void runBundledCliCapturing(bundledCli, rootPath, ['blueprint', 'features', 'reclass']).catch(
      () => undefined,
    )
  }
  // Brain-usage counters (brain-first-retrieval Phase 4): per-thread tally of
  // brain searches / hit freshness / grep-fallback misses, folded per turn into
  // the root's brain-usage.json + a brain_usage rounds entry. Best-effort.
  // Positive per-turn savings estimates ride the threads:stream channel as
  // `brain-savings` events (the stats line's "~Nk saved" segment).
  const brainUsageTracker = new BrainUsageTracker(
    threadStore,
    undefined,
    undefined,
    (threadId, savedTokens, provenance) => {
      const event = {
        kind: 'brain-savings' as const,
        threadId,
        savedTokens,
        calibrated: provenance.calibrated,
        hits: provenance.hits,
      }
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('threads:stream', event)
        }
      }
    },
  )
  // Image attachments (#456): bytes on disk under userData, metadata in the DB.
  const attachmentsRoot = join(app.getPath('userData'), 'attachments')
  const attachmentStore = new AttachmentStore(db, attachmentsRoot)
  /** Threads with a turn in flight — learning stands aside while any exists. */
  const liveTurns = new Set<string>()
  // The thread's own checkout (thread-worktrees Phase 5). Constructed here and
  // reached from exactly two places: the send path below (create, before the
  // session spawns) and the agent IPC layer (a person asking for one by name).
  // It creates nothing on its own — a chat-only thread never calls into it.
  const threadWorktree = new ThreadWorktreeService({
    threadStore,
    runCli: (cwd, args) => runBundledCliCapturing(bundledCli, cwd, args),
    runGit: runGitCapturing,
    // Both of these resolve through worktree-settings: the project's own file
    // first, then the person's app-wide defaults, then the built-in behaviour.
    // The defaults are handed in rather than reached for, so nothing below main
    // holds the settings store (allowed-pattern #14).
    isEnabled: (rootPath) =>
      readThreadWorktreesEnabled(rootPath, {
        globalDefaults: () => appSettings.getWorktreeDefaults(),
      }),
    // EVERYTHING ELSE THE WORKTREE MACHINERY IS ALLOWED TO KNOW, in one
    // resolution: where a cut begins when nobody said, whether its base is
    // refreshed first and for how long, and which remote that refresh reads.
    // One read per cut, and the precedence lives in the resolver rather than in
    // four questions asked separately (allowed-pattern #14).
    settingsFor: (rootPath) =>
      readWorktreeSettings(rootPath, { globalDefaults: () => appSettings.getWorktreeDefaults() }),
    // Only a REQUESTED move reaches this, and only for an idle thread: a
    // session's root is fixed at spawn, so the one honest way to move an
    // existing thread is to let its next turn start fresh.
    disposeSession: (threadId) => agentManager?.disposeThread(threadId),
    // A project just gained a copy of itself — ask whether it is now holding
    // more than it should (Phase 7). Fire-and-forget: the message that caused
    // this is already on screen and must not wait behind a disk sweep.
    onCreated: (rootPath) => {
      void sweepThreadWorktrees(rootPath)
      // A PROJECT GAINED A CHECKOUT. Recorded here rather than inside the
      // worktree machinery, so that module keeps knowing nothing about
      // telemetry and the event is named where it is decided. The path is not
      // passed on — the event has nowhere to put it, which is the point.
      telemetryService?.record('worktree.created', { at: Date.now() })
    },
    // A PROJECT'S OWN COMMAND, RUN THROUGH A SHELL, on the first message of a
    // new thread. Handed over explicitly rather than reached for, because this
    // is the one dep in this list that executes a string from a repository.
    runSetup: runSetupCapturing,
    // One answer to "break the link", shared with the dependency promotion —
    // reached through the CLI because the app spawns that binary rather than
    // importing it, and a second implementation on this side would be the
    // second copy of the rule the shared helper exists to prevent.
    detachModules: async (threadId, root, worktreePath) => {
      await runBundledCliCapturing(bundledCli, root, [
        'worktree',
        'detach',
        '--thread',
        threadId,
        ...checkoutNameArgs(threadId, worktreePath),
        '--json',
        '--target',
        root,
      ])
    },
    // THE CUT FINALLY SAYS SOMETHING. Sent straight to every window, the way
    // the brain-savings emitter above already does — the setup runs BEFORE any
    // session exists, so there is no agent bridge to route it through.
    onSetupProgress: (threadId, event) => {
      const payload = {
        kind: 'worktree-setup' as const,
        threadId,
        state: event.state,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      }
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('threads:stream', payload)
      }
    },
  })
  // The end of a thread (thread-worktrees Phase 7). Constructed here, reached
  // only through the thread IPC layer and the disk sweep below. Nothing it does
  // is irreversible without a caller having said so on purpose.
  //
  // The message suggestion is deferred: the git manager it reads diffs through
  // does not exist yet at this point in the boot, and a landing whose draft
  // message is the thread's own title is a perfectly good landing.
  let suggestLandingMessage:
    | ((rootPath: string, filePaths: string[]) => Promise<string | null>)
    | null = null
  const threadLanding = new ThreadLandingService({
    threadStore,
    runGit: runGitCapturing,
    runCli: (cwd, args) => runBundledCliCapturing(bundledCli, cwd, args),
    runGh: runGhCapturing,
    suggestMessage: (rootPath, filePaths) =>
      suggestLandingMessage?.(rootPath, filePaths) ?? Promise.resolve(null),
    // What an unbound push should OFFER. The verb reads the project's own file;
    // only this process can see a default the person set app-wide, so the
    // resolved values travel with the call (allowed-pattern #14). They suggest;
    // nothing here binds.
    settingsFor: (rootPath) =>
      readWorktreeSettings(rootPath, { globalDefaults: () => appSettings.getWorktreeDefaults() }),
    // THE PRESS IS NOT THE SWEEP, and the two want different answers to the same
    // facts. `isWorktreeInUse` refuses on ANY live session, which is right for a
    // sweep nobody asked for — a session that merely exists is reason enough to
    // leave a directory alone. A person pressing Release has asked, and every
    // thread they have ever messaged has a session for as long as the app is
    // open; refusing those would mean no worktree could ever be freed by hand.
    //
    // So the line is drawn at the turn, not at the session: a thread that is
    // WORKING is refused, because pulling the floor out from under a turn in
    // flight is not what "free the disk" means. An idle one is stood down first,
    // which is also the only thing that lets it cut a fresh copy afterwards.
    standDownAgent: (threadId, force) => {
      const status = threadStore.getThread(threadId)?.status ?? null
      const resting = status === null || status === 'idle' || status === 'done'
      if (force !== true && !resting) {
        return {
          ok: false,
          detail:
            'This thread is working right now. Stop it, and its files can go.',
        }
      }
      agentManager?.disposeThread(threadId)
      return { ok: true }
    },
  })
  // The Review card's Merge button (tasks:mergePr). Here rather than in the IPC
  // registry because it needs BOTH stores at once: the TaskStore to resolve the
  // card's thread + PR and to advance it to Done, and the ThreadLandingService
  // to run the merge. On success the card moves to Done; a failure leaves it in
  // Review with the sentence the merge returned.
  const mergeTaskPr = async (taskId: string) => {
    const task = taskStore.getTask(taskId)
    if (task === null || task.threadId === null) {
      return { ok: false, detail: 'This task has no thread to merge.' }
    }
    const result = await threadLanding.mergePullRequest(task.threadId, {
      prUrl: task.prUrl,
      confirmed: true,
    })
    if (result.ok) {
      // Not activity — the app moved the card, not the user (#1192).
      try {
        taskStore.updateTask(taskId, { lane: 'done' }, { activity: false })
      } catch (error) {
        console.warn('[merge] could not move merged card to Done', { taskId, error })
      }
    }
    return result
  }
  // THE AUTOPILOT CHAIN. Autopilot used to be a config key plus an instruction
  // block asking a model to run the flow's steps in order; this runs them. It
  // shares `TurnDriver` and the claims registry with the board's loop, so there
  // is one advance mechanism with two triggers — and it publishes through
  // `ThreadLandingService`, the same path the landing panel and the loop's
  // Review move already take, which refuses an unbound branch rather than
  // guessing where the work should go.
  const chainGateDeps = {
    getThread: (threadId: string) => threadStore.getThread(threadId),
    runCli: (cwd: string, args: readonly string[]) => runBundledCliCapturing(bundledCli, cwd, args),
  }
  autopilotChain = new AutopilotChain({
    threadStore,
    claims: threadClaims,
    sendMessage: async (threadId, content) => {
      const sent = await agentManager!.sendMessage(threadId, content)
      // The chain's own first message, remembered just long enough for the send
      // handler that triggered it to answer with a REAL id rather than a
      // placeholder. Overwritten by every later rung and cleared when the run
      // ends; nothing reads it after the turn that set it.
      chainFirstMessageId.set(threadId, sent.messageId)
      return sent
    },
    // ASYNC, because this is main: a synchronous read of a project's config on
    // the process that answers every IPC call is a stall every window waits
    // behind (allowed-pattern #19). Fail-soft — a project with no config file
    // has expressed no opinion, and no opinion means autopilot is off.
    readProjectSettings: async (rootPath) => {
      const flowDir = join(rootPath, 'flow')
      const text = await fsPromises.readFile(join(flowDir, '.flowconfig'), 'utf8').catch(() => null)
      const config = text === null ? {} : parseFlowconfigText(text)
      const legacy = await fsPromises
        .access(join(flowDir, LEGACY_AUTOPILOT_FILE))
        .then(() => true)
        .catch(() => false)
      return { autopilot: autopilotEnabledIn(config, legacy), tail: tailConfigFrom(config) }
    },
    // THE STAGE GATE, BEFORE THE NEXT RUNG IS ISSUED — the seam #1915 shipped
    // without (review C2). The ladder, the gate and its 122 tests existed and
    // nothing that runs on its own ever called them, so a stage whose turn
    // ended cleanly having written NO discovery document, or a plan that does
    // not parse, carried the chain onward regardless. One code path with the
    // person's own manual call (allowed-pattern #14): the same verb, spawned
    // async and timeout-bounded exactly as the publish gate above is, never
    // synchronously on the process every window waits behind
    // (allowed-pattern #19).
    // THE STAGE GATE — see drive/chain-gates.ts, which also says why it must
    // look in the thread's own worktree rather than the project root.
    checkStage: makeStageCheck(chainGateDeps),
    tail: {
      // THE PUBLISH GATE, BEFORE ANYTHING IS PUBLISHED. One code path with the
      // `/execute-plan` skill (allowed-pattern #14): both call the same CLI
      // verb, which reads the risk assessment the run recorded and never judges
      // risk itself. The chain drives a thread rather than a plan slug, so it
      // scopes the read by the instant it began — an older run's rating can
      // neither gate nor clear this one — and it passes the chain id, which the
      // verb uses as the run's identity: only an assessment recorded under this
      // chain can clear this publish (#1915 C1).
      // THE PUBLISH GATE — drive/chain-gates.ts, same worktree rule.
      checkRisk: makeRiskCheck(chainGateDeps),
      // Publish, and nothing more — for a project that pushes but does not open
      // pull requests. The verb is the one that owns the write; an unbound
      // branch comes back refused and stays refused.
      push: async (threadId) => {
        const thread = threadStore.getThread(threadId)
        if (thread === null) return { ok: false, detail: 'This conversation is no longer here.' }
        const result = await runBundledCliCapturing(bundledCli, thread.projectRoot, [
          'worktree',
          'push',
          '--target',
          thread.projectRoot,
          '--thread',
          thread.id,
          ...checkoutNameArgs(thread.id, thread.worktreePath),
          '--thread-title',
          thread.title,
          '--json',
        ])
        return result.ok
          ? { ok: true, detail: 'The work is published.' }
          : {
              ok: false,
              // THE REASON, NOT THE REMEDY (forbidden-pattern #12): the CLI
              // writes its refusals for a terminal and some end in an
              // invocation, which has no business in something a person reads
              // here.
              detail: 'Nobody has said where this work should be published, so it was left alone.',
            }
      },
      // Commit, publish and open the pull request — one call, through the path
      // that already does all three.
      openPullRequest: async (threadId) => {
        const preview = await threadLanding.preview(threadId)
        if (!preview.canOpenPullRequest) {
          return { ok: false, detail: 'There is nothing here that a pull request could be opened from.' }
        }
        const landed = await threadLanding.land(threadId, {
          mode: 'pull-request',
          confirmed: true,
          message: preview.message,
        })
        const opened = landed.rows.find((row) => row.outcome === 'opened')
        if (opened === undefined) {
          const refused = landed.rows.find((row) => row.outcome !== 'landed')
          return { ok: false, detail: refused?.detail ?? 'The work could not be published.' }
        }
        return { ok: true, detail: opened.detail, ...(opened.url === undefined ? {} : { url: opened.url }) }
      },
    },
    onChange: (status) => broadcast('flow:chainChanged', status),
    // A CARD IS NOT FINISHED WHEN ONE STEP ENDS, it is finished when the chain
    // is. The loop learns that here rather than by reaching into the chain.
    onChainEnd: (threadId, success) => boardLoop.onTurnComplete(threadId, success),
  })
  // A DELETED CONVERSATION ENDS WHATEVER WAS DRIVING IT. Every door that removes
  // a thread — the sidebar's delete, a card's delete, removing a project — ends
  // at the store's one deletion event, so the drivers subscribe to that rather
  // than to any one handler; a chain held on a question is otherwise never asked
  // again, and the board loop that handed it the card waits for an ending that
  // can no longer come. The module carries the full argument.
  watchDeletedThreads(threadStore, { autopilotChain, boardLoop })
  // …and the disk's half of the same boundary. `threads:delete` deliberately
  // leaves the release to the sidebar's own flow, which is where the sentence a
  // person reads gets written — but four other doors delete threads and release
  // nothing, leaving checkouts nobody will mention again. This asks the same
  // `prune` the sidebar asks, with the same guards: no `allowUnlanded`, ever, so
  // a checkout still holding work is refused and kept rather than discarded
  // while nobody is watching.
  releaseCheckoutOnThreadDeleted(threadStore, {
    release: (threadId, options) => threadLanding.prune(threadId, options),
  })
  // Where a thread publishes (thread_remote_binding Phase 5). It reads the
  // store's mirror, reconciles it against git when the two disagree, and calls
  // the ONE verb that writes an upstream. It decides nothing on its own: an
  // unbound thread stays unbound until a person answers.
  const threadBinding = new ThreadBindingService({
    threadStore,
    runCli: (cwd, args) => runBundledCliCapturing(bundledCli, cwd, args),
  })

  /**
   * Bring one project back under the checkout ceiling (Phase 7, task 7.5).
   *
   * TWO INDEPENDENT GUARDS, on purpose. The plan only ever offers checkouts
   * whose work has landed; the release then RE-READS each one and refuses
   * anything holding uncommitted work or commits its base has not got. The
   * second check is not redundant — the first ran against a listing taken
   * moments earlier, and an agent can write into a checkout at any time.
   */
  /**
   * How long ago a checkout appeared on disk, in ms — null when unreadable.
   *
   * The `.git` FILE is the stamp, not the directory: a worktree's directory can
   * be recreated by anything that writes into it (which is precisely the
   * accident this guards), while `.git` is written once, by the cut. Null when
   * it cannot be read at all, which `isWorktreeInUse` treats as protective.
   */
  function checkoutAgeMs(path: string): number | null {
    try {
      return Date.now() - statSync(join(path, '.git')).birthtimeMs
    } catch {
      return null
    }
  }

  /**
   * How many copies this project may keep — the person's answer, not the app's.
   *
   * ASKED AT BOTH MOMENTS, from the one resolver (allowed-pattern #14). The
   * number was hardcoded at ten for the whole life of the feature, so the sweep
   * and the total it prints on the management list were the same constant twice
   * rather than one setting read twice; the difference only shows once somebody
   * changes it, which is exactly when a disagreement would be worst.
   */
  async function worktreeCapFor(rootPath: string): Promise<number> {
    const resolved = await readWorktreeSettings(rootPath, {
      globalDefaults: () => appSettings.getWorktreeDefaults(),
    })
    return resolved.settings.worktreeCap.value
  }

  async function sweepThreadWorktrees(rootPath: string): Promise<void> {
    // NEVER THE ONE SOMEBODY IS IN. This sweep is kicked off BY a cut and runs
    // unawaited, so without this it raced the session that cut was for: a fresh
    // checkout is spotlessly "landed", ranked oldest by its base commit's date,
    // and was force-removed while the agent spawning into it still held the
    // path as its cwd. See worktree-in-use.ts.
    //
    // ONE PREDICATE, ASKED TWICE. Collecting and deleting are seconds apart —
    // a CLI and two git processes per checkout — and in those seconds a person
    // can open a thread and an agent can spawn into the very checkout the plan
    // marked free. So the same question is put again immediately before the
    // `--force`, from the same function (allowed-pattern #14): two copies of
    // this rule would be two rules, and the second one would be the stale one.
    const busy = ({ thread, path }: { thread: string; path: string }): boolean =>
      isWorktreeInUse({
        hasLiveSession: agentManager?.hasActiveSession(thread) ?? false,
        status: threadStore.getThread(thread)?.status ?? null,
        ageMs: checkoutAgeMs(path),
      })
    try {
      const candidates = await collectWorktreeCandidates({
        rootPath,
        runCli: (cwd, args) => runBundledCliCapturing(bundledCli, cwd, args),
        runGit: runGitCapturing,
        baseFor: (thread) => threadStore.getThread(thread)?.worktreeBase ?? null,
        inUseFor: busy,
        // Attached projects' checkouts too — see `checkoutOwnersFor`.
        owners: checkoutOwnersFor(threadStore, rootPath),
      })
      const swept = await enforceWorktreeCap({
        candidates,
        cap: await worktreeCapFor(rootPath),
        stillEligible: (candidate) => !busy({ thread: candidate.thread, path: candidate.path }),
        release: async (candidate) =>
          (await threadLanding.prune(candidate.thread, { confirmed: true })).status === 'pruned',
      })
      if (swept.skipped.length > 0) {
        // Not a failure — the guard doing its job. Logged because a checkout
        // that keeps being skipped is over the cap for a reason worth seeing.
        console.info('flow: kept thread worktrees that became busy mid-sweep', {
          rootPath,
          threads: swept.skipped,
        })
      }
    } catch (error) {
      // A disk sweep that fails costs disk. A disk sweep that throws into the
      // send path costs the user their message.
      console.warn('flow: could not sweep thread worktrees', { rootPath, error })
    }
  }
  // THE CONTEXT GATE (Workspaces Phase 7): a Workspace thread's first message
  // picks the other projects it needs (attached before its session starts);
  // later messages may OFFER one more. The registry is wired further down, so
  // the gate reaches it through this late-bound slot; until it is set, every
  // thread simply runs in its own project.
  let contextGateRegistry: WorkspaceRegistry | null = null
  const contextGate = createContextGate({
    workspaceOf: async (projectRoot) =>
      contextGateRegistry === null
        ? null
        : gateWorkspaceFromMembership(await contextGateRegistry.statusFor(projectRoot)),
    // The fast model (haiku), through the same one-shot path thread titles use.
    // A hidden end-to-end run answers it deterministically instead (e2e-seams.ts).
    askModel: (input) => {
      const standIn = e2eSeams()?.askFastModel
      if (standIn !== undefined) return standIn(input)
      return agentManager?.askFastModel(input) ?? Promise.resolve(null)
    },
    attachedRoots: (threadId) => threadStore.getThreadRoots(threadId),
    // A task whose projects a person ticked (the remote ticket's picker) starts
    // with exactly those — even when that is one project and nothing is attached.
    projectsChosen: (threadId) => {
      const task = taskStore.getTaskByThreadId(threadId)
      return task !== null && appSettings.isTaskProjectsChosen(task.id)
    },
    // The existing attach seam — the same rows a manual or automatic attach
    // writes, so the thread's checkouts are cut for them as for any attach.
    attach: (threadId, roots) => {
      for (const root of roots) threadStore.addThreadRoot(threadId, root)
    },
    recordNote: (threadId, text) => {
      threadStore.appendMessage(threadId, 'system', text)
    },
    announceChosen: (event) => broadcast('threads:contextChosen', event),
    announceOffer: (event) => broadcast('threads:contextOffer', event),
    // A Workspace project the thread may carry is one Flow has OPEN — the same
    // gate `threads:setRoots` applies (attach-roots.ts) — under the app's own
    // spelling of its folder, matched real to real (the CLI may name the same
    // checkout `/private/var/…` where Flow has `/var/…`).
    openRoot: async (localPath) => {
      const real = await realpathAsync(localPath).catch(() => resolve(localPath))
      for (const entry of registry.getRoots()) {
        if (resolve(entry.rootPath) === resolve(localPath)) return entry.rootPath
        const entryReal = await realpathAsync(entry.rootPath).catch(() => null)
        if (entryReal === real) return entry.rootPath
      }
      return null
    },
    // Generated descriptions stay on this computer — never pushed to the
    // Workspace (only a person's description belongs in the shared file).
    localDescriptions: {
      get: (workspace, project) => appSettings.getGeneratedProjectDescription(workspace, project),
      set: (workspace, project, text) => appSettings.setGeneratedProjectDescription(workspace, project, text),
    },
  })
  agentManager = new AgentManager(
    threadStore,
    credentials,
    permissions,
    {
      contextGate,
      // A thread starts only on projects Flow has learned: its first message
      // waits for its project's basic discovery, and an attached project still
      // being learned joins on the next send after it (learn/basic-discovery.ts).
      basicDiscovery: {
        require: (roots, options) => basicDiscovery?.require(roots, options) ?? Promise.resolve({ learning: [] }),
        whenSettled: (root) => basicDiscovery?.whenSettled(root) ?? Promise.resolve({ ok: true as const }),
        isDeferred: (root) => basicDiscovery?.isDeferred(root) ?? false,
      },
      // What a native-containment runtime may write among a thread's attached
      // roots: the address gate's answer (a registered project or a thread's
      // checkout), never a bare row in the thread store.
      isAttachableRoot: (root) => addressableRoots.isAddressable(root),
      accountResolver,
      getModelRouting: () => appSettings.getModelRouting(),
      // The picker's evidence: what each runtime reported running (see
      // AppSettingsStore.rememberSeenRuntimeModel).
      rememberRuntimeModel: (provider, model) =>
        appSettings.rememberSeenRuntimeModel(provider, model),
      saveDefaultModelSelection: (selection) =>
        appSettings.setDefaultModelSelection(
          selection.model,
          selection.effort ?? null,
          appSettings.getDefaultProvider() ?? 'claude',
        ),
      // Compose (#1931): the task seed (issue context) wins; a promoted
      // sub-agent child thread falls back to the continuation seed. Both are
      // first-turn only and return null when they don't apply.
      seedProvider: (threadId) =>
        makeSeedProvider(taskStore)(threadId) ??
        makeSubagentSeedProvider(threadStore)(threadId),
      onTurnStart: (threadId) => {
        // LEARNING STANDS ASIDE FOR THE PERSON. A learn run is hundreds of
        // agent sessions; one of them competing with the turn somebody is
        // watching is the difference between "thinking" and "slow". The
        // in-flight pass finishes; nothing new starts until the user's turn is
        // done. Their own Pause is untouched by this (setYielding is separate).
        liveTurns.add(threadId)
        learnOrchestrator?.setYielding(true)
        // The card just entered Doing for its first turn — give it a technical
        // brief if it has none yet, so it's ready before the agent works. This
        // is the board loop's only Todo → Doing hook (it never hits tasks:update),
        // and the reaction is idempotent: a card that already has a brief, or a
        // bare one with nothing to summarize, generates nothing.
        makeOnTurnStart(taskStore, (prev, next) => {
          void briefOnActivation(prev, next, {
            hasContent: taskHasBriefContent,
            generate: (taskId) =>
              generateTaskBrief(
                { taskStore, briefGenerator: (input) => agentManager!.generateBrief(input) },
                taskId,
              ),
          })
        })(threadId)
      },
      // Mirror an assistant's task list onto this project's board — either
      // protocol it uses, one hook for both. Reads the tool call the bridge
      // announced — no capture of its own — and defers every board write off
      // the turn's stack.
      onToolCallRecorded: makeTodoMirror({ taskStore, threadStore }),
      // The owning card follows its agent's status: a thread going
      // `needs-decision` (a permission gate or an AskUserQuestion) moves its card
      // to Blocked and back on answer. Decoupled — the manager never knows tasks
      // exist; the store write it makes broadcasts tasks:updated and the board
      // repaints itself.
      onThreadStatus: (threadId, status) => {
        // A TURN THAT ENDED WITHOUT SAYING SO still releases learning. A
        // session that crashes, is interrupted by a thrown abort, or a runtime
        // turn that is stopped sets the thread idle/failed WITHOUT calling
        // onTurnComplete — and a turn left in liveTurns kept learning standing
        // aside for the rest of the session, every basic discovery with it.
        if ((status === 'idle' || status === 'failed' || status === 'done') && liveTurns.delete(threadId) && liveTurns.size === 0) {
          learnOrchestrator?.setYielding(false)
        }
        syncCardLane(threadId, status, taskStore)
        // A CHAIN HOLDS WHEN A PERSON IS BEING ASKED SOMETHING, and issues
        // nothing until they answer. Not a hot broadcast — this fires when an
        // agent's status actually changes, and costs a map lookup for every
        // thread no chain is driving (allowed-pattern #17).
        autopilotChain?.onThreadStatus(threadId, status)
      },
      onTurnComplete: (threadId, success) => {
        // AFTER A TURN, NEVER DURING — `promoteDependencies`' own rule, and the
        // first time anything in the app has obeyed it, because until now
        // nothing called that function at all. If this turn changed a lockfile,
        // the worktree stops sharing the main checkout's installed packages
        // before the next turn runs an install into them.
        threadWorktree.promoteAfterTurn(threadId)
        // …and picks up again when the last live turn ends.
        liveTurns.delete(threadId)
        if (liveTurns.size === 0) learnOrchestrator?.setYielding(false)
        onTaskTurnComplete(threadId, success)
        // THE CHAIN GETS FIRST REFUSAL, and the two can never both act: the
        // shared claims registry says which driver is waiting on this thread,
        // and the other one returns without doing anything. A card whose
        // conversation is being chained advances when the CHAIN ends, not when
        // one of its steps does (`onChainEnd`, above).
        autopilotChain?.onTurnComplete(threadId, success)
        // …and the board's loop takes its next card. Success and failure both
        // advance: a card whose turn failed was still worked, and one bad card
        // must not silently end the night's work. Success also opens the card's
        // pull request and moves it to Review.
        boardLoop.onTurnComplete(threadId, success)
        // Capture the thread's working set into flow/brain/.raw/ (best-effort).
        lastBrainWork = null
        onBrainTurnComplete(threadId, success)
        // …then commit the knowledge it produced, after that capture settles.
        commitKnowledgeAfterTurn(threadId, lastBrainWork)
        // Keep learning consistent with the work: if this turn concentrated on
        // an area the blueprint does not understand, offer to learn it.
        if (success) void maybeAskChatLearn(threadId)
        // Count the turn's brain-search usage (success or not — the tool
        // calls happened either way). Best-effort, never blocks the turn.
        brainUsageTracker.onTurnComplete(threadId)
        // THE REVIEW RE-READS GIT, BECAUSE THE AGENT MAY HAVE COMMITTED.
        //
        // A thread's checkout has three ways to learn that git moved, and an
        // agent committing through a shell trips none of them: it is not one of
        // Flow's own git channels (`git:commit` / `git:publish` announce, a
        // `git commit` in a terminal does not), it edits no file so the
        // EditTracker stays quiet, and a thread's checkout is not a registered
        // root so the `.git` watcher never sees it. The card went on listing
        // work that was committed and pushed until something poked it by hand —
        // ticking a checkbox re-read git as a side effect, and the list vanished
        // (user, 2026-09-16).
        //
        // The end of a turn is the one moment the agent's work is finished and
        // knowable, and it is already a hook: one broadcast per turn, gated on
        // the thread the card is actually showing.
        broadcast('threads:changeReviewUpdated', { threadId })
      },
      cliShimDir,
      // Gate a session start behind an in-flight provision (#513 phase 2).
      awaitProvisioning,
      // multi_runtime_support: a project's flow/.flowconfig `provider` selects
      // its agent runtime, else the app-wide default from Model settings, else
      // Claude. Read lazily so a settings change applies to new threads.
      resolveProviderFor: (projectRoot) => readProjectProvider(projectRoot),
      globalProviderDefault: () => appSettings.getDefaultProvider(),
      // Cut the thread's checkout before its session spawns, and brand it once
      // the first successful turn has named the thread (thread-worktrees Phase 5).
      ensureThreadWorktree: (threadId, context) =>
        threadWorktree.ensureBeforeSession(threadId, context),
      settleThreadDependencies: (threadId) => threadWorktree.settleDependencies(threadId),
      // WHAT THE PERSON HANDED THIS THREAD. Files attached in the composer live
      // under the attachments root, one directory per thread; a session may READ
      // that directory and nothing more (see `readRoots`). It is not a widening
      // of what an agent can reach on its own — nothing arrives there except by
      // somebody picking a file.
      attachmentRoot: (threadId) => join(attachmentsRoot, threadId),
      onThreadTitleSettled: (threadId) => {
        // The auto-titler wrote the thread store directly, so the owning task —
        // a "from scratch" card, created titleless and named from its opening
        // message — never saw the new name and kept reading "Untitled task".
        // Mirror it through the one shared path the manual rename uses.
        const thread = threadStore.getThread(threadId)
        if (thread) syncTaskTitleFromThread({ taskStore }, threadId, thread.title)
        void threadWorktree.nameAfterTitle(threadId).catch((error: unknown) => {
          console.warn('flow: could not name the thread worktree', error)
        })
      },
      // Auto-attach (phase 6): a write into one of these known,
      // currently-available project roots attaches it to the thread
      // instead of being blocked.
      knownProjectRoots: () =>
        projectRegistry
          ?.getRoots()
          .filter((root) => root.available !== false)
          .map((root) => root.rootPath) ?? [],
    },
    attachmentStore,
  )

  // Board tools — the in-process `flow` server for user-chat Claude sessions.
  // Decoupled like the seed/hooks providers: the provider owns both gates (the
  // project setting and "is this a plain user chat") and binds every operation to
  // the project, so a card moved from the chat agent runs exactly the code a card
  // dragged in the UI does. The close-remote reaction is wired to the same
  // AppSettingsStore / IntegrationsManager / flow:notification the board's own
  // tasks:update handler uses.
  agentManager.setBoardToolsProvider(
    makeBoardToolsProvider({
      taskStore,
      threadStore,
      boardLoop,
      briefGenerator: (input) => agentManager!.generateBrief(input),
      closeRemote: {
        isEnabled: () => appSettings.getCloseRemoteOnDone(),
        closeIssue: (ref, opts) => integrations.closeIssue(ref, opts),
        notify: ({ rootId, title, body, level }) =>
          broadcast('flow:notification', {
            kind: 'state-change',
            rootId,
            title,
            body,
            level,
            timestamp: new Date().toISOString(),
          }),
      },
    }),
  )

  // In-app auto-update (#auto-update): pushes lifecycle status to every window.
  const updater = new UpdaterManager(
    (status) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('updater:status', status)
        }
      }
    },
    // UPDATES ARE FAILING — a rate, in the app's own vocabulary. Windows ships
    // unsigned with no update feed, so this is the one area where a silent
    // failure can strand somebody on a bad build indefinitely; knowing it is
    // happening at all is the difference between finding out and not.
    () => telemetryService?.record('app.failed', { at: Date.now(), errorKind: 'update' }),
  )

  // Progressive-learning (#513 phase 6): the ONE orchestrator every learn
  // trigger funnels through. A single shared BlueprintObserver backs both the
  // blueprint channels (below) and the orchestrator's graph/learning/notes
  // read — the graph falls back to an in-memory basic derive so a fresh project
  // (no CLI derive yet) can still learn its depth-1 modules on onboarding.
  const blueprintObserver = new BlueprintObserver(rootsProviderFrom(projectRegistry))
  rewatchBlueprints = () => blueprintObserver.rewatchMovedRoots()
  // PERF cache for LearnTriggers.readModules (see below): rootPath → module
  // paths, invalidated whenever the blueprint structure changes.
  const learnModulePathsCache = new Map<string, string[]>()
  blueprintObserver.on(BLUEPRINT_CHANGED_EVENT, (event: { rootId: string }) => {
    learnModulePathsCache.delete(event.rootId)
  })
  const readLearnProjectState = async (rootPath: string): Promise<LearnProjectState> => {
    const snapshot = await blueprintObserver.read(rootPath)
    const graph = snapshot.graph ?? (await deriveBasicGraph(rootPath).catch(() => null))
    return {
      graph,
      // The fallback above is enough to pick modules, not to learn them: a
      // learn pass's note is refused until a graph is derived on disk.
      graphDerived: snapshot.graph !== null,
      learning: snapshot.learning,
      investigations: snapshot.investigations,
      // Carry the cap flag: `reconcileNoteless` must not read absence from a
      // truncated slice (it flipped 24 learned modules to stale every launch).
      investigationsTruncated: snapshot.investigationsTruncated === true,
    }
  }
  // Auth env for the caged learn session — the project's bound account (isolated
  // CLAUDE_CONFIG_DIR, tokens stripped) else the stored API key else ambient.
  // Fail-soft: an unresolvable account falls through rather than throwing.
  const resolveLearnAuthEnv = async (rootPath: string): Promise<NodeJS.ProcessEnv | undefined> => {
    try {
      const resolution = await accountResolver.resolveForSession(rootPath)
      if (resolution.status === 'ready') return buildAccountEnv(resolution.account.configDirPath)
    } catch {
      // Fall through to legacy auth below.
    }
    const apiKey = credentials.get('anthropic')?.['apiKey']
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      return { ...process.env, ANTHROPIC_API_KEY: apiKey }
    }
    return undefined
  }
  // Live learn-progress: the caged learner fires onRead for every file it opens.
  // Reads burst (a module has many files), so coalesce per (rootId+module) on a
  // trailing-edge ~200ms timer and push only the latest file to the renderer.
  const LEARN_PROGRESS_THROTTLE_MS = 200
  /** A first derive before a basic discovery — a big repo takes a while. */
  const LEARN_DERIVE_TIMEOUT_MS = 3 * 60_000
  const learnProgressTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const learnProgressLatest = new Map<string, { rootId: string; module: string; file: string }>()
  const emitLearnProgress = (rootPath: string, modulePath: string, file: string): void => {
    const key = `${rootPath}\x00${modulePath}`
    // The panel's activity log reads the same stream (consecutive reads of one
    // module collapse in the ring, so this is one line that keeps updating).
    recordLearnEvent({ at: Date.now(), kind: 'read', module: modulePath, detail: file })
    learnProgressLatest.set(key, { rootId: rootPath, module: modulePath, file })
    if (learnProgressTimers.has(key)) return
    const timer = setTimeout(() => {
      learnProgressTimers.delete(key)
      const latest = learnProgressLatest.get(key)
      learnProgressLatest.delete(key)
      if (latest) broadcast('learn:progress', latest)
    }, LEARN_PROGRESS_THROTTLE_MS)
    learnProgressTimers.set(key, timer)
  }
  learnOrchestrator = new LearnOrchestrator({
    readProjectState: readLearnProjectState,
    isRootReady: (rootPath) =>
      projectRegistry?.getRoots().find((root) => root.rootPath === rootPath)?.provisioningState ===
      'ready',
    bundledCli,
    notify: broadcastNotification,
    resolveAuthEnv: resolveLearnAuthEnv,
    onLearnRead: emitLearnProgress,
    readLearnIgnore: readLearnIgnoreExtras,
    // Basic discovery derives a project's graph first when it has none on disk
    // (the derived graph does not travel with a move into a Workspace folder).
    deriveGraph: async (rootPath) => {
      const result = await runBundledCliCapturing(bundledCli, rootPath, ['blueprint', 'derive'], {
        timeoutMs: LEARN_DERIVE_TIMEOUT_MS,
      })
      if (!result.ok) console.warn(`[BasicDiscovery] derive failed for ${basename(rootPath)}: ${result.error ?? result.stderr ?? 'unknown'}`)
      return (await readLearnProjectState(rootPath)).graphDerived === true
    },
    // The blueprint board's "Run basic discovery" runs a spinner until it hears
    // this. Raised on every exit of the feature-generation step — including the
    // ones that toast nothing (unready root, a repo that names no capability).
    onFeaturesDiscovered: ({ rootPath, added, reason }) => {
      broadcast('learn:featuresDiscovered', { rootId: rootPath, added, reason })
    },
  })
  const orchestrator = learnOrchestrator
  const structureOf = (rootPath: string): string => join(rootPath, 'flow', 'brain', '.structure')
  // BASIC DISCOVERY FOR EVERY WORKSPACE PROJECT (learn/basic-discovery.ts):
  // one rule for "has it", one sweep at a time, and the door every caller
  // uses — the launch re-check, a Workspace change, a thread's send, an attach.
  // CONNECTIONS LEARNING: once a project has its basic discovery, every pair
  // of projects it makes in its Workspace can be checked. The CLI plans and
  // writes; this asks the fast model about the pairs that show a sign.
  connectionsLearner = createConnectionsLearner({
    runCli: (cwd, args, options) => runBundledCliCapturing(bundledCli, cwd, args, options),
    askModel: (input) => {
      const standIn = e2eSeams()?.askFastModel
      if (standIn !== undefined) return standIn(input)
      return agentManager?.askFastModel(input) ?? Promise.resolve(null)
    },
    workspaceOfRoot: (root) => workspaces.workspaceOfRoot(root),
    automatic: () => automaticConnectionsLearning(),
    onStatus: (status) => broadcast('workspaces:connectionsLearning', status),
    log: (message, details) => console.warn(`[Connections] ${message}`, details),
  })
  // Once after launch, after the launch's own learning has had its turn.
  const connectionsAtLaunch = setTimeout(() => {
    for (const root of projectRegistry?.getRoots() ?? []) {
      if (root.provisioningState === 'ready') void connectionsLearner?.learn(root.rootPath, 'automatic')
    }
  }, CONNECTIONS_LAUNCH_DELAY_MS)
  connectionsAtLaunch.unref?.()
  basicDiscovery = createBasicDiscovery({
    // The one rule — and a project discovered before its record existed (or
    // whose sweep learned everything but never got to say so) gets the record
    // written now, so a stuck sweep heals on the next check.
    hasRecord: (rootPath) => ensureBasicDiscoveryRecord(structureOf(rootPath)),
    record: (rootPath, outcome) =>
      recordBasicDiscovery(structureOf(rootPath), {
        completedAt: new Date().toISOString(),
        learned: outcome.learned,
        failed: outcome.failed,
      }),
    // A hidden end-to-end run stands in for the sweep (e2e-seams.ts).
    run: (rootPath, options) => {
      const standIn = e2eSeams()?.basicDiscovery
      return standIn !== undefined ? standIn(rootPath) : orchestrator.runBasicDiscovery(rootPath, { ...options, announce: false })
    },
    isReady: (rootPath) =>
      projectRegistry?.getRoots().find((root) => root.rootPath === rootPath)?.provisioningState === 'ready',
    inWorkspace: async (rootPath) => (await workspaces.workspaceOfRoot(rootPath)) !== null,
    automatic: () => automaticBasicDiscovery(),
    onChange: (rootPath, status) => {
      broadcast('learn:basicDiscoveryChanged', { rootId: rootPath, status })
      if (status === 'done') void connectionsLearner?.learn(rootPath, 'automatic')
    },
  })
  // A project attached to a thread (by the first-message gate, a chip, an
  // auto-attach) starts its sweep the moment it is attached — the chip shows
  // "Learning…" and the session leaves it out until it is learned.
  threadStore.on(THREAD_ROOTS_CHANGED_EVENT, (event: ThreadRootsChangedEvent) => {
    if (event.threadId === null) return
    void basicDiscovery?.require(threadStore.getThreadRoots(event.threadId)).catch(() => undefined)
  })
  // Onboarding "yes" / Settings "Run basic discovery" → basic-discovery sync.
  // A person asked for it, so it runs whatever the record says — and a run
  // that ends well is recorded like any other.
  learnEvents.onBasicDiscoveryRequested(({ rootId }) => {
    void orchestrator.runBasicDiscovery(rootId, { resume: true }).then(async (outcome) => {
      if (outcome.kind !== 'done') return
      await recordBasicDiscovery(structureOf(rootId), {
        completedAt: new Date().toISOString(),
        learned: outcome.learned,
        failed: outcome.failed,
      }).catch((error: unknown) => console.warn('[BasicDiscovery] could not record a completed discovery', error))
    })
  })
  // Abort a root's in-flight + queued learning when its project is removed.
  let knownRootPaths = new Set(projectRegistry.getRoots().map((root) => root.rootPath))
  // Startup: RESUME the learning a prior session left unfinished (#1132) —
  // 'learning' entries fall back to 'queued' (nothing is running in a fresh
  // process, #learn-stuck) and every queued module is re-admitted with its
  // original reason. Closing the app mid-"Learn all" no longer throws the
  // queue away.
  for (const rootPath of knownRootPaths) void orchestrator.resumeInterrupted(rootPath)
  const onRootsChangedForLearn = (): void => {
    const current = new Set(projectRegistry?.getRoots().map((root) => root.rootPath) ?? [])
    for (const rootPath of knownRootPaths) {
      if (!current.has(rootPath)) {
        orchestrator.abortRoot(rootPath)
        basicDiscovery?.forget(rootPath)
      }
    }
    // A newly-added (re-opened) root may carry interrupted state from a past
    // session — resume it the same way. EVERY current root is re-attempted, not
    // just new ones: provisioning finishes asynchronously, so the startup pass
    // often runs while the root is still 'provisioning' and can only leave the
    // queue on disk. This event fires again once it is ready, and the queue's
    // dedupe keys make the retry a no-op for anything already admitted (#1132).
    for (const rootPath of current) void orchestrator.resumeInterrupted(rootPath)
    knownRootPaths = current
  }
  projectRegistry.on(PROJECT_LIST_CHANGED_EVENT, onRootsChangedForLearn)

  // The storyline import index, warmed once per ready project per session in
  // the background (blueprint/import-index-warmer.ts) — the board's folder
  // rows and the first plan-review story read it. A feature-graph read that
  // came back partial asks for it at once, and the board re-reads when it lands.
  importIndexWarmer = createImportIndexWarmer({
    run: (rootPath) => runImportIndexWarm(bundledCli, rootPath),
    onIndexReady: (rootPath) => blueprintObserver.announceChanged(rootPath),
  })
  // The launch warm-up never runs in a hidden e2e run (its temp projects come and go).
  if (process.env['FLOW_E2E'] !== '1') {
    const warmer = importIndexWarmer
    const warmReadyRoots = (): void =>
      warmer.request(
        (projectRegistry?.getRoots() ?? []).filter((root) => root.provisioningState === 'ready').map((root) => root.rootPath),
      )
    warmReadyRoots()
    projectRegistry.on(PROJECT_LIST_CHANGED_EVENT, warmReadyRoots)
  }

  // Progressive-learning (#513 phase 8): the ALWAYS-ON staleness watcher. Taps
  // the project file watcher's debounced file-change batch, maps each touched
  // SOURCE file to its depth-1 module, and after a 12-min idle re-runs the
  // read-only `blueprint stale-check` — a note whose stamped files drifted
  // flips the module's board dot (a 'stale' learning-state entry). Free and
  // always on (no budget, no toggle). The GUARDED auto re-learn hangs off
  // `onModuleStale` below.
  const isRootReadyForLearn = (rootPath: string): boolean =>
    projectRegistry?.getRoots().find((root) => root.rootPath === rootPath)?.provisioningState ===
    'ready'
  const gitDiff = makeBundledGitDiff()
  learnTriggers = new LearnTriggers({
    onFilesChanged: (listener) => {
      const handler = (event: ProjectFilesChangedEvent): void => listener(event)
      projectRegistry?.on(PROJECT_FILES_CHANGED_EVENT, handler)
      return () => {
        projectRegistry?.off(PROJECT_FILES_CHANGED_EVENT, handler)
      }
    },
    // ALL module paths (any depth): mapFileToModule is longest-prefix, so a
    // file under src/app attributes to the src/app module onboarding learns —
    // depth-1-only here left depth-2 learns invisible to staleness (#learn-ignore).
    // PERF: the module-path list is cached per root — reading the full
    // blueprint snapshot (graph parse + drift assembly) on EVERY files-changed
    // batch was the cost. blueprint:changed (graph.json rewritten by a derive)
    // invalidates, so structural changes land on the next batch.
    readModules: async (rootPath) => {
      const cached = learnModulePathsCache.get(rootPath)
      if (cached !== undefined) return cached
      const modules = selectAllModulePaths((await readLearnProjectState(rootPath)).graph)
      learnModulePathsCache.set(rootPath, modules)
      return modules
    },
    isRootReady: isRootReadyForLearn,
    runStaleCheck: makeBundledStaleCheck(bundledCli),
    readIgnoreExtras: readLearnIgnoreExtras,
    // Guarded auto re-learn (#513 phase 8 task 2): a drifted, previously-learned
    // module with a MEANINGFUL diff re-learns automatically when the per-root
    // `learn_auto` toggle is on. The orchestrator enforces the session budget for
    // auto (non-deliberate) items — a spent budget silently drops the enqueue.
    onModuleStale: async ({ rootPath, modulePath, report, priorStatus }) => {
      // Pause-during-runs rule (#513 phase 9): a module currently in play for an
      // active execute-plan run must never be auto re-learned out from under it —
      // its release entry (module_completed / archive_sweep) will trigger the
      // re-learn once the run frees it.
      if (learnRunTriggers?.isModuleInPlay(rootPath, modulePath)) return
      const previouslyLearned = isPreviouslyLearned(priorStatus)
      if (!previouslyLearned) return
      if (!(await readLearnAutoEnabled(rootPath))) return
      const changedFiles = report.stale.flatMap((note) => note.changedFiles)
      if (changedFiles.length === 0) return
      const diff = await gitDiff(rootPath, changedFiles)
      if (diff === null) return
      const meaningful = isMeaningfulDiff(diff.numstat, diff.unified)
      if (shouldAutoRelearn({ meaningful, previouslyLearned, autoEnabled: true })) {
        orchestrator.enqueueModule(rootPath, modulePath, { reason: 'stale', deliberate: false })
      }
    },
  })
  learnTriggers.start()

  // Progressive-learning (#513 phase 9): the run-aware learn triggers. Tails each
  // root's flow/.rounds.jsonl on every flow state-change, folding the run-release
  // entries (module_completed / archive_sweep) into re-learn enqueues and tracking
  // which modules an active run holds in play (consulted by onModuleStale above to
  // honor the pause-during-runs rule). It attaches to the SHARED FlowObserver —
  // constructed here so both the flow IPC channels and these triggers observe one
  // instance (the observer watches .rounds.jsonl, see flow-observer's WATCHED_BASENAMES).
  // attach() only subscribes; registerFlowChannels below calls observer.start().
  const flowObserver = new FlowObserver(rootsProviderFrom(projectRegistry))
  learnRunTriggers = new LearnRunTriggers({
    enqueueModule: (rootPath, modulePath, options) =>
      orchestrator.enqueueModule(rootPath, modulePath, options),
  })
  learnRunTriggers.attach(flowObserver)

  // threads:brainSavings memo (see brainThreadSavings below): per-thread
  // {estimate, tool-call count at compute time}. Bounded by thread count.
  const threadSavingsCache = new Map<
    string,
    { savedTokens: number; atCallCount: number; calibrated: boolean; hits: number }
  >()

  /**
   * Draw a feature's curated view AND write what the same read learned.
   *
   * ONE PASS, BOTH ARTIFACTS. There used to be two buttons here — "Learn this
   * feature" and "Draw this feature" — running two independent caged sessions
   * over the SAME ranked files, writing two different stores. A user was being
   * asked to choose which internal store got written, and the board then
   * reported a feature that had been drawn (the richest artifact the system can
   * produce) as unexamined. `runFeatureViewPass` now produces both halves from
   * one read; this reports which of them landed.
   *
   * It lives in MAIN rather than in the renderer because this is queued work
   * that outlives whatever the user is looking at. Chaining it off a renderer
   * event meant navigating away mid-pass silently skipped it, and the feature
   * kept falling back to its anchor subgraph — isolated cards named after
   * directories with nothing in them, which is the thing this replaces.
   *
   * EVERY EXIT TOASTS. This is reachable from a BUTTON, not only from queued
   * work nobody is watching — and a button whose only failure mode is "nothing
   * happens" is worse than no button. The board shows a running state until it
   * hears one of exactly two things: the `learn:featureViewed` broadcast, or a
   * toast titled with `FEATURE_VIEW_FAILED_TITLE`. A branch that returns
   * without raising either leaves that indicator spinning forever, so there is
   * no such branch.
   */
  const drawFeatureView = async (request: {
    rootId: string
    featureRef: string
    featureName: string
    modulePaths: readonly string[]
    // Resolves TRUE when the curated view was validated and persisted — the
    // signal `understandFeature` gates the parts step on, since that step reads
    // the stored view to find them.
  }): Promise<boolean> => {
      // DECLARED BEFORE THE FIRST GUARD, deliberately. It used to sit below the
      // `bundled === null` return, which made the single most likely failure —
      // no bundled CLI — the one failure nobody could see.
      const toast = (title: string, body: string, level: 'info' | 'warn'): void => {
        broadcastNotification({
          kind: 'state-change',
          rootId: request.rootId,
          title,
          body,
          timestamp: new Date().toISOString(),
          level,
        })
      }
      // ONE CALL, TWO AUDIENCES. The ring is what the Activity panel shows a
      // user; the console line is what a developer running `npm run dev` reads.
      // Both from one place, so a step can never be in one and missing from the
      // other — which is how "nothing is happening" stayed unanswerable for an
      // afternoon: the pass was silent in every channel at once.
      const started = Date.now()
      const elapsed = (): string => ((Date.now() - started) / 1000).toFixed(1)
      const logLine = (
        kind: 'start' | 'read' | 'learned' | 'failed' | 'stopped',
        detail?: string,
      ): void => {
        recordLearnEvent({
          at: Date.now(),
          kind,
          module: request.featureName,
          ...(detail === undefined ? {} : { detail }),
        })
        // Elapsed on every line: "which step" is only half the question when a
        // pass takes minutes — "how long has it been on it" is the other half,
        // and it is the one that separates slow from dead.
        console.log(
          `[learn:feature] +${elapsed()}s ${kind} ${request.featureName}${detail === undefined ? '' : ` — ${detail}`}`,
        )
      }
      /**
       * A console-only marker for the steps BEFORE the pass starts.
       *
       * `logLine('start')` fires after four awaits — ranking the files,
       * resolving credentials, reading the roster, finding plan docs — so a
       * hang in any of them produced no line anywhere, which is precisely the
       * "ten minutes, nothing happened" case. These are not in the ring because
       * a user has nothing to do with them; they are in the console because
       * whoever is debugging needs to know which await never returned.
       */
      const phase = (name: string): void => {
        console.log(`[learn:feature] +${elapsed()}s phase ${name}`)
      }

      const bundled = resolveBundledCli()
      if (bundled === null) {
        logLine('failed', 'the bundled CLI is unavailable')
        toast(
          FEATURE_VIEW_FAILED_TITLE,
          `${request.featureName}: the bundled CLI is unavailable, so the view could not be written.`,
          'warn',
        )
        return false
      }
      try {
        phase(`ranking files in ${String(request.modulePaths.length)} module path(s)`)
        const entries = await Promise.all(
          request.modulePaths.map((modulePath: string) =>
            defaultEnumerateModuleEntries(request.rootId, modulePath),
          ),
        )
        const files = entries.flatMap((entry) => entry.files)
        phase(`${String(files.length)} file(s) ranked · finding plan docs`)
        const planDocs = findFeatureDocs(request.rootId, request.featureRef)
        phase(`${String(planDocs.length)} plan doc(s) · resolving credentials`)
        const authEnv = await resolveLearnAuthEnv(request.rootId)
        phase(authEnv === undefined ? 'no bound credentials — ambient login' : 'credentials resolved')
        // SAY SO WHEN THERE ARE NO CREDENTIALS TO RESOLVE. `resolveLearnAuthEnv`
        // is fail-soft by design — no bound account and no stored `anthropic`
        // key falls through to the ambient CLI login rather than throwing — and
        // that softness is exactly what made a credential-less press look like
        // a dead button: the pass starts, the session cannot authenticate, and
        // the only evidence is minutes of nothing. Told up front, and still
        // ATTEMPTED, because an ambient login is a real and common way this
        // succeeds; the outcome toast below reports what actually happened.
        if (authEnv === undefined) {
          // A NOTE, not an outcome — its own title, so it cannot be mistaken by
          // the board for the pass finishing (see feature-view-notice.ts).
          toast(
            FEATURE_VIEW_NOTE_TITLE,
            `${request.featureName}: no Claude account is bound to this project and no anthropic API key is stored — ` +
              'trying the ambient CLI login. Bind an account in Settings if this fails to authenticate.',
            'warn',
          )
        }
        // THE ROSTER — the names this pass may relate the feature TO. Loaded
        // here rather than inside the pass so the fetch is visible at the call
        // site and costs one CLI read per press, not one per retry.
        phase('reading the feature roster (CLI)')
        const roster = await loadFeatureRoster(bundled, request.rootId)
        phase(`roster: ${String(roster.length)} feature(s) · starting the session`)
        // A PASS THAT CANNOT END IS THE BUG THIS CLOSES.
        //
        // The MODULE pass has had both of these since it was written: a
        // ten-minute deadline and a three-minute silence watchdog, so a session
        // that hangs is stopped, marked stale and reported. The FEATURE pass had
        // neither — no timeout, no watchdog, no abort — so a session that never
        // answered never ended. `settle` was not called, the running state
        // stayed set, and the board showed a pass in flight until the app was
        // quit. Reported as "we are seems still stucked", and it was: not the
        // indicator, the pass behind it.
        //
        // SILENCE IS THE FASTER SIGNAL. A pass reports each file it reads; three
        // minutes without one is not slow work, it is a session that is gone,
        // and waiting out the full deadline to say so wastes seven minutes of
        // somebody's afternoon. Same two numbers as the module pass, because
        // this is the same kind of work and two different answers would be a
        // second rule to keep in step.
        // THE ACTIVITY PANEL IS THE LOG, and until now a feature pass wrote
        // nothing to it: "Nothing yet this session." sat under a headline
        // saying a pass was running, and there was no way — from the app — to
        // tell a pass that was working from one that had died. Reported as ten
        // minutes with nothing happening, and the honest answer was that
        // nothing in the product could have said either way.
        //
        // The ring is the orchestrator's, and that is the point: one place the
        // reader already looks, one format, both pipelines. `module` carries
        // the feature's name because that is what this pass is about.
        logLine('start', `${String(files.length)} file(s) ranked`)

        const readSoFar = new Set<string>()
        const guard = new AbortController()
        let stopped: 'deadline' | 'silence' | null = null
        const deadline = setTimeout(() => {
          stopped = 'deadline'
          guard.abort()
        }, FEATURE_PASS_DEADLINE_MS)
        let silence: NodeJS.Timeout | null = null
        const heardSomething = (): void => {
          if (silence !== null) clearTimeout(silence)
          silence = setTimeout(() => {
            stopped = 'silence'
            guard.abort()
          }, FEATURE_PASS_SILENCE_MS)
        }
        heardSomething()
        let result
        try {
          result = await runFeatureViewPass({
            rootPath: request.rootId,
            featureRef: request.featureRef,
            featureName: request.featureName,
            files,
            ...(roster.length > 0 ? { roster } : {}),
            ...(planDocs.length > 0
              ? { planDocs, provenance: `plan:${planDocs[0].replace(/^.*\/plan_|\.md$/g, '')}` }
              : {}),
            bundledCli: bundled,
            abortSignal: guard.signal,
            onRead: (filePath: string) => {
              heardSomething()
              logLine('read', filePath)
              // THE FRACTION THE PASS HAS FROM ITS FIRST SECOND. Parts are
              // named late and a feature with none never names any, so the
              // level page of the feature being read had nothing to fill its
              // collar for the whole pass. Files ranked is known before the
              // session starts; files read arrives one at a time.
              //
              // A FILE READ TWICE IS NOT TWO FILES — a real run re-read two of
              // its forty-three — so the count is of DISTINCT paths and cannot
              // walk past its own total.
              readSoFar.add(filePath)
              broadcast('learn:featureReadProgress', {
                rootId: request.rootId,
                featureRef: request.featureRef,
                read: Math.min(readSoFar.size, files.length),
                total: files.length,
              })
            },
            // THE WATCHDOG HAS TO WATCH THE WHOLE PASS, not the short half of
            // it. Reading takes the first minute; composing the drawing and the
            // learnings takes several more and opens no file at all. Watching
            // `onRead` alone made that silence, and the guard added an hour ago
            // killed a healthy pass at three minutes — measured on a real run:
            // eighteen files read by +59s, then nothing until the stop at
            // +240s. The module pass has always wired both.
            //
            // Console only, and not into the Activity ring: 'thinking' arrives
            // many times a minute and would push the files a reader wants out
            // of a two-hundred-line buffer.
            onActivity: (kind: string, detail?: string) => {
              // EVERY signal resets the watchdog — that is the whole point of
              // it, and 'stream' is the only one that exists while the model
              // composes.
              heardSomething()
              // …but a per-chunk heartbeat is not news. Printing it would bury
              // the file reads a reader is actually following under thousands
              // of identical lines.
              if (kind === 'stream') return
              // Same rule for the SDK's own housekeeping: `status` and
              // `thinking_tokens` arrive every second or two and say only that
              // the session is alive, which is the watchdog's business and not
              // the reader's. `init` is the one that is actually news.
              if (kind === 'session' && detail !== 'init') return
              phase(detail === undefined ? kind : `${kind} — ${detail}`)
            },
            ...(authEnv !== undefined ? { authEnv } : {}),
          })
        } finally {
          clearTimeout(deadline)
          if (silence !== null) clearTimeout(silence)
        }
        if (stopped !== null) {
          // IT SAYS WHICH, because the two mean different things to whoever has
          // to act: quiet means the session died, long means the work is real
          // and the cap is wrong.
          toast(
            // FAILED, not the note title: only the failed/success titles end
            // the board's running state (feature-view-notice.ts says so). A
            // timeout that toasted a mere note would stop the pass and leave
            // the indicator turning — the stuck screen, one layer deeper.
            FEATURE_VIEW_FAILED_TITLE,
            `${request.featureName}: ` +
              (stopped === 'silence'
                ? 'the session went quiet and was stopped. Nothing was written.'
                : 'the pass ran past its time limit and was stopped. Nothing was written.'),
            'warn',
          )
          logLine(
            'stopped',
            stopped === 'silence'
              ? 'went quiet for three minutes and was stopped'
              : 'ran past ten minutes and was stopped',
          )
          return false
        }
        if (result.ok) {
          broadcast('learn:featureViewed', {
            rootId: request.rootId,
            featureRef: request.featureRef,
            components: result.components ?? 0,
          })
        }
        // THE PROSE HALF ANNOUNCES ITSELF SEPARATELY, whichever way the picture
        // went. A brief that is open on this feature repaints on this event, and
        // the learnings can land even when the validator refused the drawing.
        if ((result.learnings ?? 0) > 0) {
          broadcast('learn:featureLearned', {
            rootId: request.rootId,
            featureRef: request.featureRef,
            learnings: result.learnings ?? 0,
          })
        }
        // WHICH HALF LANDED, in the body. `result.reason` already names a
        // refused half verbatim (see `runFeatureViewPass`); the counts say what
        // was produced, so "0 learning(s)" and "the learnings were refused" are
        // never confusable.
        toast(
          result.ok ? FEATURE_VIEW_DONE_TITLE : FEATURE_VIEW_FAILED_TITLE,
          result.ok
            ? `${request.featureName}: ${String(result.components ?? 0)} component(s) · ` +
                `${String(result.learnings ?? 0)} learning(s)` +
                (result.reason !== undefined ? ` · ${result.reason}` : '')
            : `${request.featureName}: ${result.reason ?? 'unknown'}`,
          result.ok && result.learningsFailed !== true ? 'info' : 'warn',
        )
        // THE LOG ENDS THE STORY IT STARTED. A ring that records a start and
        // every file and then stops is the same silence in a longer form: the
        // reader still cannot tell a finished pass from an abandoned one.
        logLine(
          result.ok ? 'learned' : 'failed',
          result.ok
            ? `${String(result.components ?? 0)} component(s) · ${String(result.learnings ?? 0)} learning(s)`
            : (result.reason ?? 'unknown'),
        )
        return result.ok
      } catch (error) {
        // A THROW IS AN ENDING TOO, and the one most likely to be invisible:
        // the toast below has always been here, and toasts are gone in seconds.
        logLine('failed', error instanceof Error ? error.message : String(error))
        toast(
          FEATURE_VIEW_FAILED_TITLE,
          `${request.featureName}: ${error instanceof Error ? error.message : String(error)}`,
          'warn',
        )
        return false
      }
  }

  /**
   * Learn a feature's PARTS: its children, each in its own right.
   *
   * You cannot learn chat without learning the SSE stream. The parent pass
   * reads five directories and records six facts about the whole thing — real
   * facts, but nobody investigated the streaming channel, the SDK client or the
   * renderers, so the diagram's components were names with inferred prose
   * behind them rather than pieces of the system anyone understands.
   *
   * So the drawing NAMES the parts (it already decomposes the code to draw
   * them) and this learns each one against the files that component actually
   * cited. Each part keeps its own anchors and its own learnings inside the
   * parent's file — one file holds everything known about a feature, and a part
   * cannot drift away from what it belongs to.
   *
   * Sequential, not parallel: these are caged model sessions against one repo,
   * and the drain that owns learning has always run one at a time.
   */
  const learnFeatureParts = async (request: {
    rootId: string
    featureRef: string
    featureName: string
  }): Promise<void> => {
    const notify = (title: string, body: string, level: 'info' | 'warn'): void => {
      broadcastNotification({
        kind: 'state-change',
        rootId: request.rootId,
        title,
        body,
        timestamp: new Date().toISOString(),
        level,
      })
    }
    /**
     * NOTHING IN THIS PASS FAILS QUIETLY.
     *
     * Every give-up here was once a bare `return`, and three separate bugs took
     * that shape: a hand-built path that resolved nowhere, a ref that was an id
     * where a slug was expected, and file anchors handed to a directory walker.
     * Each time the steps BEFORE it succeeded, so the pipeline looked healthy
     * while the step the user asked for never ran — once for twenty-five
     * minutes. A pass that produces nothing must say why it produced nothing.
     */
    const bail = (reason: string): void => {
      notify('Learning parts', `${request.featureName}: ${reason}`, 'warn')
    }

    const bundled = resolveBundledCli()
    if (bundled === null) return bail('the bundled CLI is unavailable')
    try {
      // ASK THE CLI FOR THE VIEW, never build its path by hand.
      //
      // `featureRef` is whatever the board had — usually the feature's ID. The
      // artifact is named after its SLUG, and the CLI is the thing that
      // resolves one to the other. Composing the filename here looked
      // equivalent and silently found nothing: the parts step returned at its
      // first line for twenty-five minutes while everything upstream of it
      // worked, which is the worst shape a failure can take.
      const read = await runBundledCliCapturing(bundled, request.rootId, [
        'blueprint',
        'features',
        'view',
        '--feature',
        request.featureRef,
        '--json',
      ])
      if (!read.ok || read.stdout.trim().length === 0) {
        return bail(`could not read the drawing — ${read.error ?? 'it produced nothing'}`)
      }
      let drawn: unknown
      try {
        drawn = JSON.parse(read.stdout)
      } catch {
        return bail('the drawing is not readable JSON')
      }
      const parts = derivePartsFromView(drawn)
      if (parts.length === 0) {
        return bail('the drawing cited no code, so there is nothing to learn parts from')
      }

      // Write them NAMED first. A pass that dies halfway then leaves the parts
      // visible and unlearned, which is honest and resumable; holding
      // everything until the end would lose the decomposition too.
      const writeAll = async (
        entries: ReadonlyArray<{ name: string; summary: string; anchors: string[]; learnings?: unknown[] }>,
      ): Promise<boolean> => {
        const written = await runBundledCliCapturing(bundled, request.rootId, [
          'blueprint',
          'features',
          'parts',
          '--feature',
          request.featureRef,
          '--write',
          JSON.stringify(entries),
        ])
        // The writer's refusals ARE the contract — a part with no anchors, a
        // part with no name. Discarding its verdict throws away the only thing
        // standing between a bad decomposition and the reader.
        if (!written.ok) bail(`parts refused — ${written.error ?? 'unknown'}`)
        return written.ok
      }
      if (!(await writeAll(parts))) return
      broadcast('learn:featureParts', {
        rootId: request.rootId,
        featureRef: request.featureRef,
        parts: parts.length,
        learned: 0,
      })

      const authEnv = await resolveLearnAuthEnv(request.rootId)
      // Read ONCE for the whole loop — the store does not change while it runs,
      // and a per-part CLI read would pay for the same answer N times.
      const partsRoster = await loadFeatureRoster(bundled, request.rootId)
      const learned: Array<{ name: string; summary: string; anchors: string[]; learnings: unknown[] }> = []
      /** Parts whose anchors resolved to nothing readable — named at the end. */
      const unreadable: string[] = []
      for (const part of parts) {
        // File-vs-directory resolution lives in `resolvePartFiles`, with tests.
        // It was inline here when it silently produced ten empty file lists.
        const { files } = await resolvePartFiles(request.rootId, part.anchors, {
          stat: (abs) => {
            try {
              const info = statSync(abs)
              return { isFile: info.isFile(), size: info.size }
            } catch {
              return null
            }
          },
          enumerate: async (root, dir) => defaultEnumerateModuleEntries(root, dir),
        })
        if (files.length === 0) {
          unreadable.push(part.name)
          learned.push({ ...part, learnings: [] })
          continue
        }
        const result = await runFeatureLearnPass({
          rootPath: request.rootId,
          featureRef: request.featureRef,
          ...(partsRoster.length > 0 ? { roster: partsRoster } : {}),
          // The PART is what is being learned, so the prompt must say its name.
          featureName: `${request.featureName} — ${part.name}`,
          files,
          bundledCli: bundled,
          // Its findings belong to the part, not pooled into the parent's list.
          collectOnly: true,
          ...(authEnv !== undefined ? { authEnv } : {}),
        })
        const today = new Date().toISOString().slice(0, 10)
        learned.push({
          ...part,
          learnings: (result.learnings ?? []).map((text) => ({ text, provenance: 'code', date: today })),
        })
        await writeAll([...learned, ...parts.slice(learned.length)])
        broadcast('learn:featureParts', {
          rootId: request.rootId,
          featureRef: request.featureRef,
          parts: parts.length,
          learned: learned.length,
        })
      }
      const facts = learned.reduce((sum, part) => sum + part.learnings.length, 0)
      notify(
        'Learning',
        `${request.featureName}: ${String(parts.length)} part(s), ${String(facts)} learning(s) about them.` +
          (unreadable.length > 0
            ? ` ${String(unreadable.length)} part(s) had nothing readable: ${unreadable.join(', ')}.`
            : ''),
        facts === 0 ? 'warn' : 'info',
      )
    } catch (error) {
      notify(
        'Learning parts failed',
        `${request.featureName}: ${error instanceof Error ? error.message : String(error)}`,
        'warn',
      )
    }
  }

  /**
   * UNDERSTAND A FEATURE — the one act behind the one button.
   *
   * "Why do we have a button to learn and another to draw?" was the right
   * question and it had no answer. The two gestures read the same ranked files
   * (`feature-view-session` imports `rankModuleFiles` straight from the learn
   * session), ran in the same cage, and differed only in which store they
   * wrote — an implementation detail nobody outside this file should have been
   * choosing between. Worse, the drawing did not count as understanding at all,
   * so the richest artifact the system can produce left a feature's dot dark.
   *
   * One act now, in the order the artifacts depend on each other:
   *   1. the caged pass — the picture AND the prose, from one read
   *   2. the parts the picture named, each learned in its own right
   *
   * Step 2 runs ONLY when step 1 drew something, because it reads the stored
   * view to find the parts. Skipping it silently would be the old bug (a step
   * that never ran while everything upstream looked healthy), so the reason is
   * a toast: `learnFeatureParts` bails out loud on every give-up, and here the
   * refusal already reached the user as the drawing's own failure toast.
   *
   * BOTH `learn:*` CHANNELS LAND HERE. Leaving `learn:learnFeature` pointed at
   * a second, different behaviour is exactly how the pair grew in the first
   * place; one entry point is what makes "one button" a fact about the code.
   */
  /**
 * How long one feature-understand pass may run, and how long it may say
 * nothing. Deliberately the SAME numbers the module pass uses — it is the same
 * kind of work, and two different answers would be a second rule to keep in
 * step with the first.
 */
const FEATURE_PASS_DEADLINE_MS = 10 * 60 * 1000
const FEATURE_PASS_SILENCE_MS = 3 * 60 * 1000

const understandFeature = async (request: {
    rootId: string
    featureRef: string
    featureName: string
    modulePaths: readonly string[]
  }): Promise<void> => {
    const drawn = await drawFeatureView(request)
    if (!drawn) return
    await learnFeatureParts(request)
  }

  disposeIpc = registerIpcHandlers({
    threadStore,
    taskStore,
    // #1484: removing a project closes its shells too — otherwise the PTYs
    // outlive the project with no tab, no menu entry and no route back.
    disposeTerminalsForRoot: (rootPath) => {
      terminalManager?.disposeForRoot(rootPath)
    },
    forgetKnowledgeRoot: (rootPath) => placement.forget(rootPath),
    // LATE-BOUND: the manager is constructed further down, after handlers are
    // registered, so this is read at use rather than captured now.
    terminalManager: () => terminalManager,
    appSettings,
    telemetry: telemetryService ?? undefined,
    integrations,
    projectRegistry,
    projectContext,
    threadScope: threadScopeManager,
    briefGenerator: (input) => agentManager!.generateBrief(input),
    boardLoop,
    autopilotChain: autopilotChain ?? undefined,
    mergeTaskPr,
    attachmentStore,
    // Transcript backfill for promoted sub-agent children (#1931): a promotion
    // that found nothing to re-home reads the sub-agent's transcript out of SDK
    // session storage. The reader runs under the parent project's bound
    // account (its isolated CLAUDE_CONFIG_DIR) else the SDK's ~/.claude
    // default; resolution is fail-soft like resolveLearnAuthEnv above.
    backfillSubagentThread: makeSubagentBackfill({
      threadStore,
      resolveConfigDir: async (workspaceRoot) => {
        try {
          const resolution = await accountResolver.resolveForSession(workspaceRoot)
          return resolution.status === 'ready' ? resolution.account.configDirPath : null
        } catch {
          return null
        }
      },
    }),
    updater,
    maybeProvision,
    // A refused activation (unreachable root, #974/#1118) must say so — a
    // silent no-op on the main project-switching control is the bug, not the fix.
    notifyUnreachableRoot: (rootPath) => notifyUnreachableProject(rootPath),
    provisionRoot,
    answerBasicDiscovery,
    answerChatLearn,
    // Board "Learn" button (#513 phase 6/7) — a deliberate re-learn of one module.
    learnModule: (rootPath, modulePath) =>
      orchestrator.enqueueModule(rootPath, modulePath, { reason: 'manual', deliberate: true }),
    // UNDERSTAND A FEATURE — one act, both artifacts, ONE handler behind both
    // channels. See `understandFeature`: the picture and the prose come from a
    // single caged read, then the parts that read named are learned in their
    // own right. `learn:learnFeature` is kept as an alias rather than a second
    // behaviour — a channel that does something subtly different is how the
    // two-button split grew in the first place.
    generateFeatureView: (request) => {
      void understandFeature(request)
    },
    learnFeature: (request) => {
      void understandFeature(request)
    },
    // Learning-panel controls (#learn-controls): pause/resume the global drain
    // (echoed to every window so panel labels stay live), stop a root's queue
    // (entries flip stale immediately), or wipe its learning-state entirely
    // (docs + investigation notes untouched).
    // The live answer, straight from the orchestrator (learn:status).
    basicDiscoveryState: (roots) => {
      const answer: Record<string, BasicDiscoveryStatus> = {}
      for (const root of roots) {
        const status = basicDiscovery?.status(root) ?? null
        if (status !== null) answer[root] = status
      }
      return answer
    },
    learnStatus: () =>
      learnOrchestrator?.status() ?? {
        running: false,
        paused: false,
        activeModule: null,
        activeRoot: null,
        queued: 0,
        startedAt: null,
      },
    learnLog: () => readLearnLog(),
    learnPause: (paused) => {
      orchestrator.setPaused(paused)
      broadcast('learn:pausedChanged', { paused: orchestrator.isPaused(), pausedRoots: orchestrator.pausedRootPaths() })
    },
    learnPauseRoot: (rootPath, paused) => {
      orchestrator.setRootPaused(rootPath, paused)
      broadcast('learn:pausedChanged', { paused: orchestrator.isPaused(), pausedRoots: orchestrator.pausedRootPaths() })
    },
    learnCancel: (rootPath) => orchestrator.cancelRoot(rootPath),
    // RESET MEANS FORGET. It used to clear the status table alone, leaving
    // every artifact the learning produced — the module docs, the notes and
    // their heat, the generated views, each feature's learned sections — so the
    // map came back as informed as before. The CLI owns those stores, so the
    // CLI does the forgetting; this stops the run first, because a pass in
    // flight would write notes after the wipe.
    learnReset: async (rootPath, { dryRun }) => {
      if (!dryRun) await orchestrator.resetRoot(rootPath)
      const result = await runBundledCliCapturing(bundledCli, rootPath, [
        'blueprint',
        'forget',
        '--json',
        ...(dryRun ? ['--dry-run'] : []),
      ])
      if (!result.ok) {
        return { ok: false, reason: result.error ?? 'the forget could not run' }
      }
      try {
        const parsed = JSON.parse(result.stdout.trim()) as LearnForgetTally
        return { ok: true, tally: parsed }
      } catch {
        // The work happened; only the accounting is unreadable. Say so rather
        // than reporting a failure that would invite a second, pointless run.
        return { ok: true }
      }
    },
    // Learning-panel "Brain retrieval" line (brain-first-retrieval Phase 4).
    brainUsage: (rootPath) => readBrainUsageTotals(rootPath),
    // Conversation pane's cumulative savings chip — pure recompute over the
    // thread's persisted tool calls priced at the root's current baseline.
    // PERF: memoized per thread on the tool-call COUNT — the pane re-asks on
    // every thread switch/turn, and re-walking every output blob each time
    // was the cost. An unchanged count returns the cached estimate (a
    // baseline shifted by ANOTHER thread's turn is served one refresh late —
    // informational chrome, acceptable).
    brainThreadSavings: async (threadId) => {
      try {
        const thread = threadStore.getThread(threadId)
        if (!thread) return { savedTokens: 0, rootSavedTokens: 0, calibrated: false, hits: 0 }
        // The root's cumulative total rides along on EVERY answer (cached or
        // not) — it is the chip's keep-visible fallback and the store read is
        // one small JSON file.
        const store = await readBrainUsageStore(thread.projectRoot)
        const rootSavedTokens = store.totals.savedTokens
        const callCount = threadStore.countToolCalls(threadId)
        const cached = threadSavingsCache.get(threadId)
        if (cached !== undefined && cached.atCallCount === callCount) {
          return {
            savedTokens: cached.savedTokens,
            rootSavedTokens,
            calibrated: cached.calibrated,
            hits: cached.hits,
          }
        }
        // Turn boundaries = the thread's user-message times, so the recompute
        // prices searches with the SAME per-turn windows as the tracker — a
        // later turn's exploration must never flip an earlier turn's hit.
        // #1280: the figure travels WITH its provenance — an uncalibrated
        // baseline prices every hit at a flat 8k, which is a constant, not an
        // estimate. The surfaces show the hit count instead.
        const estimate = estimateThreadSavings(
          threadStore.listToolCallsSlim(threadId, 0),
          threadStore.listUserMessageTimes(threadId),
          store.burstSamples,
        )
        const { savedTokens, hits } = estimate
        const calibrated = estimate.baseline.measured
        threadSavingsCache.set(threadId, { savedTokens, atCallCount: callCount, calibrated, hits })
        return { savedTokens, rootSavedTokens, calibrated, hits }
      } catch {
        // Informational chrome — never an IPC error.
        return { savedTokens: 0, rootSavedTokens: 0, calibrated: false, hits: 0 }
      }
    },
  })

  // Auto-update only runs in a packaged build — dev has no update feed, and
  // macOS applies updates only for a signed + notarized app. Check on launch,
  // every 6h, AND on window focus (throttled): launch + 6h alone meant a
  // release published right after launch went unnoticed for hours — the user
  // sat on the old version with no banner (observed live, v0.1.2 → v0.1.3).
  // The timer is unref'd so it never keeps the app alive.
  if (app.isPackaged) {
    void updater.check()
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000
    setInterval(() => void updater.check(), SIX_HOURS_MS).unref()
    // Focus-triggered check, at most once per 15 minutes — returning to the
    // app shortly after a release ships finds the update within seconds.
    const FOCUS_CHECK_MIN_INTERVAL_MS = 15 * 60 * 1000
    let lastFocusCheck = Date.now()
    app.on('browser-window-focus', () => {
      const now = Date.now()
      if (now - lastFocusCheck < FOCUS_CHECK_MIN_INTERVAL_MS) return
      lastFocusCheck = now
      void updater.check()
    })
  }
  /**
   * THE TRIGGER AUTOPILOT NEVER HAD.
   *
   * `flow:chain` has accepted `run: true` since it shipped and nothing ever
   * sent it, so the project key gated a request nobody made and turning
   * autopilot on chained nothing. This offers the opening message of every
   * conversation to the chain; `begin()` refuses — with its own reasons — when
   * autopilot is off for the project, when something else is already driving
   * the thread, or when the thread is gone.
   */
  /**
   * SIGN IN TO FLOW — composed here because this is the only place that holds
   * both the identity store and a way to open a browser.
   *
   * Returns a sentence either way. Every failure a person can meet leaves them
   * signed out with the app working, so none of them is an error worth throwing.
   */
  /**
   * ONE SIGN-IN STATE. Every change to who is signed in — a sign-in, a
   * sign-out, a session the share host refused — goes through this and is
   * broadcast as `auth:changed`, so Settings and the feature view's Share
   * button re-read the same answer and never disagree (auth-session.ts).
   */
  const authSession =
    identityStore === null
      ? null
      : createAuthSession({
          store: identityStore,
          broadcast: (change) => broadcast('auth:changed', change),
        })

  const signIn = async (): Promise<
    { ok: true; subject: string; displayName: string | null } | { ok: false; reason: string }
  > => {
    if (identityStore === null) {
      return { ok: false, reason: 'Sign-in is not available on this computer.' }
    }
    const outcome = await signInToFlow({
      store: identityStore,
      openExternal: (url) => shell.openExternal(url),
    })
    if (outcome.ok) authSession?.signedIn()
    return outcome
  }

  /** Whether this build can offer sign-in at all — a surface asks before drawing. */
  /**
   * Whether this build can offer sign-in — asked before a surface draws.
   *
   * DELIBERATELY DOES NOT PROBE THE KEYCHAIN. It used to, and that turned
   * "opened Settings" into a macOS password prompt for people who had never
   * signed in. Whether a keychain exists is checked at the moment somebody
   * presses Sign in (`signInToFlow`), BEFORE the browser opens — which is a
   * moment an OS prompt is expected and explicable, and which still refuses
   * with a sentence rather than failing afterwards.
   */
  const signInAvailable = (): boolean => configuredProvider() !== null

  const maybeAutoChain = async (
    threadId: string,
    content: string,
    attachmentCount: number,
  ): Promise<string | null> => {
    if (autopilotChain === null) return null
    if (
      !shouldAutoChain({
        messageCount: threadStore.listMessages(threadId).length,
        content,
        attachmentCount,
      })
    ) {
      return null
    }
    chainFirstMessageId.delete(threadId)
    const status = await autopilotChain.begin(threadId, { aim: content.trim() })
    if (!status.running) return null
    // A chain that started but somehow sent nothing must not swallow the
    // person's message — falling through sends it the ordinary way.
    return chainFirstMessageId.get(threadId) ?? null
  }

  disposeAgentIpc = registerAgentChannels({
    maybeAutoChain,
    signIn,
    signInAvailable,
    agentManager,
    threadWorktree,
    threadLanding,
    threadBinding,
    // The visible total — silent disk growth is the failure mode the user named.
    worktreeUsage: async (rootPath) =>
      worktreeUsage(
        await collectWorktreeCandidates({
          rootPath,
          runCli: (cwd, args) => runBundledCliCapturing(bundledCli, cwd, args),
          runGit: runGitCapturing,
          baseFor: (thread) => threadStore.getThread(thread)?.worktreeBase ?? null,
          owners: threadStore.listThreads(rootPath, { includeArchived: true }),
          // This one only COUNTS — nothing is released from here — but the
          // total it prints is "how many, of how many", and a checkout held
          // back for being in use is still a checkout on disk.
          inUseFor: ({ thread, path }) =>
            isWorktreeInUse({
              hasLiveSession: agentManager?.hasActiveSession(thread) ?? false,
              status: threadStore.getThread(thread)?.status ?? null,
              ageMs: checkoutAgeMs(path),
            }),
        }),
        await worktreeCapFor(rootPath),
      ),
    // The whole list, for the surface that manages them. Archived threads are
    // INCLUDED on purpose: archiving a thread does not remove its copy of the
    // project, so a list that hid them would hide disk that is really there.
    worktreeInventory: (rootPath) =>
      readWorktreeInventory(rootPath, {
        threadsFor: (root) =>
          threadStore.listThreads(root, { includeArchived: true }).map((thread) => ({
            id: thread.id,
            title: thread.title,
            status: thread.status,
            worktreePath: thread.worktreePath,
            worktreeBranch: thread.worktreeBranch,
            worktreeBase: thread.worktreeBase,
            remote: thread.remote,
            remoteBranch: thread.remoteBranch,
            prBase: thread.prBase,
            previouslyPushedAs: thread.previouslyPushedAs,
            baseMayBeBehind: thread.baseMayBeBehind,
            archived: thread.archivedAt !== null,
          })),
        attachedCheckoutsFor: (root) => threadStore.listAttachedCheckouts(root),
        runCli: (cwd, args) => runBundledCliCapturing(bundledCli, cwd, args),
        runGit: runGitCapturing,
        // `du` is async and scoped to one directory (allowed-pattern #19), and
        // it runs only for a list somebody opened (allowed-pattern #17).
        runDu: runDuCapturing,
      }),
    // Where a copy no thread claims actually is. Read from the same listing the
    // inventory is built from; the path never crosses IPC.
    abandonedCheckoutFor: async (rootPath, threadId) => {
      const listed = await listThreadCheckouts({
        rootPath,
        runCli: (cwd, args) => runBundledCliCapturing(bundledCli, cwd, args),
        // The same owners as the inventory, so the id it handed out matches.
        owners: checkoutOwnersFor(threadStore, rootPath),
      })
      // An attached project's checkout belongs to a live thread — never
      // "abandoned", whatever id it is asked about by.
      const found = listed.find((entry) => entry.thread === threadId && !entry.attached)
      return found === undefined ? null : { worktreePath: found.path, branch: found.branch }
    },
  })
  disposeAccountsIpc = registerAccountChannels({
    accountStore,
    accountResolver,
    loginOrchestrator,
  })
  disposeFileIpc = registerFileChannels({ roots: addressableRoots })
  disposeFlowIpc = registerFlowChannels({
    roots: rootsProviderFrom(projectRegistry),
    observer: flowObserver,
    // The layer a project inherits until it sets a value of its own — read per
    // request, so a default changed in the settings panel is already in effect
    // the next time a panel asks (no cache, nothing to invalidate).
    worktreeDefaults: () => appSettings.getWorktreeDefaults(),
  })
  // Walkthrough pages: the feature view frames `flow-page://walkthrough/…`,
  // served only for a root the renderer may already address (the same gate
  // readFile uses) and only for a walkthrough path inside the flow doc dirs.
  disposeWalkthroughPages = handleWalkthroughPages({
    isKnownRoot: (rootPath) => addressableRoots.isAddressable(rootPath),
  })
  // Artifact watcher (blueprint-interaction #563+#568): discovery/plan/brainstorm
  // doc adds/changes push flow:artifactChanged; learn:narrate spawns the bundled
  // CLI's `blueprint narrate` for the board's "Narrate" action.
  disposeArtifactIpc = registerArtifactChannels({
    roots: rootsProviderFrom(projectRegistry),
    bundledCli,
    // #1056: a doc observed while a thread is active leaves a durable marker
    // row at that transcript position, so its card renders INLINE (not in a
    // bottom pile) when the thread is reopened.
    markers: {
      activeThreadFor: (rootPath) => {
        const project = projectContext.getActiveProject()
        return project !== null && project.rootPath === rootPath ? project.activeThreadId : null
      },
      // #1717: the doc's WRITER thread outranks whatever happens to be on
      // screen — during long runs the user reads elsewhere, and a marker
      // attributed by focus was a marker that usually never got written.
      // An ATTACHED project's doc is matched only by absolute path — through
      // the project and, since `flow/` is a link, its physical form too.
      owningThreadFor: (rootPath, path) =>
        threadStore.latestWriterThreadFor(rootPath, path, [realPathThroughLinksSync(join(rootPath, path))]),
      // A doc in a project attached to the thread names its root in the marker.
      primaryRootOf: (threadId) => threadStore.getThread(threadId)?.projectRoot ?? null,
      hasMarker: (threadId, content) => threadStore.hasSystemMessage(threadId, content),
      append: (threadId, content) => {
        threadStore.appendMessage(threadId, 'system', content)
      },
    },
  })
  // Blueprint data (flow/.blueprint/) read + watch + main-side derive. The
  // thread store backs the feature trace's best-effort prompt matching.
  disposeBlueprintIpc = registerBlueprintChannels({
    roots: rootsProviderFrom(projectRegistry),
    observer: blueprintObserver,
    bundledCli,
    ...(importIndexWarmer === null ? {} : { importIndexWarmer }),
  })
  // Brain: the single knowledge store's read/write interface (#52).
  disposeBrainIpc = registerBrainChannels({
    roots: rootsProviderFrom(projectRegistry),
  })
  // Feature view sharing (feature-view-sharing Phase 5). The client reads the
  // signed-in person's session token HERE, in main, at the moment of each
  // request — the renderer gets share state and never the token. Identity
  // gates only this: publishing needs an owner; signed out, the feature view
  // and everything else work as before (identity-is-not-a-gate.test.ts).
  disposeShareIpc = registerShareChannels({
    client: createShareClient({
      endpoint: () => configuredShareEndpoint(),
      identity: { load: () => identityStore?.load() ?? null },
      fetch: (url, init) => fetch(url, init),
      // The same gate readFile and the flow-page scheme use.
      isKnownRoot: (rootPath) => addressableRoots.isAddressable(rootPath),
      // A thread's checkout shares as its project, so the link is the same
      // whichever checkout the discovery is opened from — for the label, and
      // for the project's sharing id kept in the owner checkout's settings.
      projectLabelFor: (rootPath) => basename(addressableRoots.ownerCheckoutFor(rootPath) ?? rootPath),
      projectIds: createProjectIds({
        ownerCheckoutFor: (rootPath) => addressableRoots.ownerCheckoutFor(rootPath),
        readConfig: async (flowDir) => {
          try {
            return parseFlowconfigText(await fsPromises.readFile(join(flowDir, '.flowconfig'), 'utf-8'))
          } catch (error) {
            if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return {}
            throw error
          }
        },
        writeConfig: (flowDir, updates) => writeFlowconfig(flowDir, updates),
      }),
      // Which discoveries THIS account shared, remembered on this machine, so
      // opening a never-shared view asks planflow.sh nothing (review R2-M7).
      records: createFileShareRecords(join(app.getPath('userData'), 'share-records.json')),
      // A session the host refused (or that ran out) is cleared through the
      // auth module and broadcast — the client itself never writes identity.
      onSessionRejected: (rejected) => {
        authSession?.sessionRejected(rejected)
      },
    }),
    // Only the app window's own top frame, showing the app's own page, may
    // share — never a subframe, a <webview> guest, a frame that has gone, or a
    // window navigated elsewhere (defense in depth, review R2-M8).
    isTrustedSender: (event) =>
      isAppMainFrame(
        event,
        (sender) => sender.getType() === 'window' && BrowserWindow.fromWebContents(sender) !== null,
        (url) => isAppEntryUrl(url, rendererEntry()),
      ),
  })
  // WORKSPACES: the registry built before provisioning above.
  contextGateRegistry = workspaces
  disposeWorkspacesIpc = registerWorkspaceChannels({
    registry: workspaces,
    taskProjects: {
      get: (taskId) => appSettings.getTaskExtraProjects(taskId),
      set: (taskId, roots) => appSettings.setTaskExtraProjects(taskId, roots),
      chosen: (taskId) => appSettings.isTaskProjectsChosen(taskId),
    },
    taskExists: (taskId) => taskStore.getTask(taskId) !== null,
    resolveRoot: (rootPath) =>
      addressableRoots.isAddressable(rootPath) ? (addressableRoots.ownerCheckoutFor(rootPath) ?? rootPath) : null,
    isTrustedSender: (event) =>
      isAppMainFrame(
        event,
        (sender) => sender.getType() === 'window' && BrowserWindow.fromWebContents(sender) !== null,
        (url) => isAppEntryUrl(url, rendererEntry()),
      ),
    broadcastChanged: (event) => broadcast('workspaces:changed', event),
    sync: workspaceSync,
    // Connecting a Workspace to a shared repository: the person's own signed-in
    // `gh` / `az` (never a credential of Flow's), then the CLI's set-remote,
    // then one sync. A hidden end-to-end run never reaches a real host tool:
    // under FLOW_E2E every tool answers "not installed".
    remote: createWorkspaceRemoteSetup({
      registry: workspaces,
      hostTools: createHostTools({
        spawn:
          process.env['FLOW_E2E'] === '1'
            ? ((async () => ({ ok: false, stdout: '', stderr: '', missing: true })) satisfies HostToolSpawner)
            : createHostToolSpawner(async () => (await userPathEnv()) ?? process.env),
        now: () => Date.now(),
        log: (message, detail) => console.warn(`[Workspaces] ${message}`, detail ?? {}),
      }),
      sync: workspaceSync,
      log: (message, detail) => console.warn(`[Workspaces] ${message}`, detail ?? {}),
    }),
    placement,
    openRoots: () => (projectRegistry?.getRoots() ?? []).map((root) => root.rootPath),
    connections: {
      learn: async (root) => (await connectionsLearner?.learn(root, 'person')) ?? null,
      status: async (root) => {
        const workspace = await workspaces.workspaceOfRoot(root)
        return workspace === null ? null : (connectionsLearner?.status(workspace) ?? null)
      },
    },
  })
  // Agent loops (agent-loops, Phase 7): the panel's read + its two controls,
  // all three of them the bundled CLI's `loop` verbs. The panel is a VIEW —
  // a pause set here is the same state.json write a headless beat reads.
  disposeLoopsIpc = registerLoopsChannels({
    roots: rootsProviderFrom(projectRegistry),
    bundledCli,
    // The word this installation claims queue items under, minted on first use
    // and kept forever (review finding H1). Passed as a getter, not a value: the
    // store mints lazily, and reading it here would put a write into startup for
    // a project that may never claim anything.
    ownerId: () => appSettings.getLoopOwnerId(),
    // ONE PLACE GRANTS GITHUB ACCESS. The queue is read by the CLI shelling out
    // to `gh`, which knows only its own login — so a PAT pasted into the
    // integrations dialog used to leave the board still reporting it could not
    // read the list. `gh` honours GH_TOKEN; this hands it the same token the
    // importer uses.
    githubToken: () => integrations.githubTokenForCli(),
  })
  // App-wide settings channels (onboarding + autonomy default) — #48.
  disposeSettingsIpc = registerSettingsChannels({
    appSettings,
    // Claude's sign-in is Flow's OWN account store — no subprocess is spawned
    // to answer a question the app already holds the answer to.
    claudeAccountCount: () => accountStore.listAccounts().length,
    // The Flow account (client-sign-in). Absent from a build with no provider,
    // which reads as signed out — a complete state.
    ...(identityStore === null
      ? {}
      : {
          identity: {
            load: () => {
              const held = identityStore?.load() ?? null
              // REBUILT, NOT PASSED THROUGH. The stored record carries a live
              // token, and the only thing that keeps it out of the renderer is
              // that nobody hands it over — so nobody does.
              return held === null
                ? null
                : { subject: held.subject, displayName: held.displayName }
            },
            signOut: () =>
              authSession?.signOut() ?? {
                removed: false,
                detail: 'You were already signed out on this computer.',
              },
          },
        }),
    signIn,
    signInAvailable,
    broadcast,
  })
  // Session-start sweep: promote any raw captures left over from a prior run.
  // The user's PATH, resolved once, in the background: a GUI-launched app
  // cannot spawn a Homebrew or npm-global runtime otherwise, and the first
  // agent turn must not pay for a shell (tool-path.ts).
  warmUserPath()
  // Evidence for the next "it feels slow": slow handlers and main-process
  // stalls land in a file the user's machine keeps, because console output
  // from a packaged app goes nowhere anybody can read.
  setSlowLogDirectory(app.getPath('userData'))
  // Child processes are spawned by the CLI host, not from here — spawning is
  // where main was measured burning most of its CPU during a stall.
  configureCliHost(__dirname)
  watchEventLoopLag()

  void sweepBrainRoots(projectRegistry.getRoots().map((root) => root.rootPath))

  // Terminals: rootIds ARE absolute rootPaths in this app, so the default
  // resolveCwd (identity) is correct.
  mark('ipc handlers')
  terminalManager = new TerminalManager()
  {
    const manager = terminalManager
    const disposeChannels = registerTerminalChannels({ terminalManager: manager })
    // Each scope's shells are saved as they open, close and exit, so they can
    // be re-spawned in their conversation after a restart.
    const disposePersistence = wireShellPersistence(manager, projectContext)
    // A deleted conversation's shells are unreachable by design (hidden in
    // every other scope) — close them with it, on every delete path.
    const onThreadChange = (event: ThreadChangeEvent): void => {
      if (event.entity === 'thread' && event.action === 'deleted') {
        manager.disposeForOwnerThread(event.threadId)
      }
    }
    threadStore.on(THREAD_STORE_CHANGE_EVENT, onThreadChange)
    disposeTerminalIpc = () => {
      threadStore.off(THREAD_STORE_CHANGE_EVENT, onThreadChange)
      disposePersistence()
      disposeChannels()
    }
  }

  // LSP (typescript server registry) over the editor:* contract channels.
  mark('terminals')
  const lspManager = createDefaultLspManager()
  disposeLspIpc = registerLspChannels({ lspManager, projectRegistry })

  // Git status/log/diff per project root (.git watchers start inside).
  const gitManager = new GitManager(gitRootsProviderFrom(projectRegistry))
  disposeGitIpc = registerGitChannels({
    gitManager,
    addressableRoots,
    // Cursor-style change review (#1906): the thread surface the read model
    // reads, and the reverse root→threads map that fans a git:changed broadcast
    // out to the review card(s) watching that worktree.
    changeReview: {
      threads: {
        // A thread's OWN copy when it has one; otherwise the project it belongs
        // to. The fallback is the whole point: after the worktree gate (loops
        // only) most threads have no copy, and returning null for them left the
        // review reporting nothing to review while Source Control listed the
        // same files two columns away.
        reviewRootFor: (threadId) => {
          const thread = threadStore.getThread(threadId)
          if (thread === undefined || thread === null) return null
          if (thread.worktreePath !== null && thread.worktreePath !== '') {
            return { rootPath: thread.worktreePath, ownWorktree: true }
          }
          if (thread.projectRoot === '') return null
          return { rootPath: thread.projectRoot, ownWorktree: false }
        },
        listToolCallPaths: (threadId) => threadStore.listToolCallPaths(threadId),
      },
      // Every thread whose review READS this repo — its owner, and the ones that
      // work in it directly. Keyed on the worktree alone, a commit in a project
      // reached no thread at all and the open Changes tab went on listing files
      // that were no longer uncommitted.
      threadsForRoot: (rootId) => threadStore.threadIdsReviewing(rootId),
    },
    // Publishing a branch from the review (#1906 follow-on). The service takes
    // the SAME injected CLI spawner `ThreadLandingService` gets — one way this
    // app runs `planflow-ai`, and one place it is bound to the bundle.
    publish: new GitPublishService({
      runCli: (cwd, args) => runBundledCliCapturing(bundledCli, cwd, args),
      status: (rootPath) => gitManager.status(rootPath),
      upstreamOf: (rootPath) => gitManager.upstreamOf(rootPath),
      // The thread that OWNS this checkout — never one that merely works in the
      // project. It decides `--thread` versus `--here` and nothing else: a
      // project root is a plain checkout to the verb, with no thread store to
      // read a binding from.
      threadFor: (rootId) => {
        const [threadId] = threadStore.threadIdsForWorktree(rootId)
        if (threadId === undefined) return null
        // The project the worktree belongs to — what `--target` must name when
        // `--thread` says which worktree. A thread with no project root left
        // is not addressable as a thread at all, so it falls back to being a
        // plain checkout rather than naming a target that resolves nowhere.
        const projectRoot = threadStore.getThread(threadId)?.projectRoot ?? ''
        return projectRoot === '' ? null : { threadId, projectRoot }
      },
      // The SAME instance the `threads:bindWorktree` channel calls, so a
      // binding written from the review toolbar and one written from the
      // worktree panel are one write with one set of invariants
      // (allowed-pattern #14) — the mirror, the rename record and the
      // reconcile against git all happen either way.
      bindThread: (request) => threadBinding.bind(request),
    }),
  })
  // Merge guard (#1135): while a merge/rebase/cherry-pick is in progress, the
  // permission broker never auto-allows the commands that accept or complete
  // the resolution — the engineer decides what gets staged and committed.
  permissions.setMergeStateProbe(async (rootPath) => {
    const state = await gitManager.getMergeState(rootPath)
    return state.op !== 'none' || state.unmergedPaths.length > 0
  })
  // Drift (Phase 4): late-bind the shared blueprint observer's drift assembly to
  // its effects — the bundled CLI (`blueprint drift-check`), git authorship /
  // dirtiness / identity, and the run's in-play set. Every seam is fail-soft, so
  // a stale CLI or non-repo simply leaves `snapshot.drift` undefined.
  blueprintObserver.setDriftDeps({
    runDriftCheck: makeBundledDriftCheck(bundledCli),
    fileAuthors: async (rootPath, paths) => {
      const authors = await gitManager.fileAuthors(rootPath, paths)
      const out = new Map<string, { email?: string; author?: string; hash?: string; date?: string }>()
      for (const [path, info] of authors) {
        out.set(path, { email: info.email, author: info.author, hash: info.hash, date: info.date })
      }
      return out
    },
    dirtyPaths: async (rootPath) => {
      const status = await gitManager.status(rootPath)
      return new Set((status?.changes ?? []).map((change) => change.filePath))
    },
    currentUserEmail: async (rootPath) => (await gitManager.currentUser(rootPath)).email,
    // A module node's `sourceFile` is its dir path — the same key isModuleInPlay
    // (and the learn triggers) use for the depth-1 module spine.
    isNodeInPlay: (rootPath, node) =>
      learnRunTriggers?.isModuleInPlay(rootPath, node.sourceFile) ?? false,
  })
  // Phase-grouped review & commit: lists working-tree changes grouped by the
  // plan phase that produced them (via flow/.wave-context.jsonl records).
  const reviewService = new ReviewService(gitManager)
  // The landing's draft message, once there is a git manager to read diffs
  // through — the SAME generator the commit box's wand uses. The working-tree
  // diff is the right one here: a landing commits everything the agent wrote.
  suggestLandingMessage = (rootPath, filePaths) =>
    generateCommitMessage(
      {
        getDiff: (root, filePath) => gitManager.diff(root, filePath),
        generate: (projectRoot, prompt) =>
          agentManager?.generateBrief({ projectRoot, prompt }) ?? Promise.resolve(null),
      },
      rootPath,
      filePaths,
    )
  disposeReviewIpc = registerReviewChannels({
    reviewService,
    // Manual commit mode (#67): the ✨ wand generates a message from the
    // approved files' diffs via the agent's one-shot generate. The diff MUST be
    // the STAGED (index-vs-HEAD) change so the suggestion describes exactly what
    // the commit will contain — not the working tree, which for partially-staged
    // or staged-then-re-edited files includes edits that won't be committed (#694).
    generateCommitMessage: (rootPath, filePaths) =>
      generateCommitMessage(
        {
          getDiff: (root, filePath) => gitManager.stagedDiff(root, filePath),
          generate: (projectRoot, prompt) =>
            agentManager?.generateBrief({ projectRoot, prompt }) ?? Promise.resolve(null),
        },
        rootPath,
        filePaths,
      ),
  })


  // Invariant checker (#898 Phase B): a background haiku-tier pass reads each
  // touched module's learned `## Invariants` against its changed hunks and
  // pushes ADVISORY verdicts to the board — never gating, hash-cached (zero
  // tokens on unchanged input), debounced on git changes.
  const { ipcMain } = require('electron') as typeof import('electron')
  mark('git + watchers')
  invariantService = createInvariantService({
    getChangedFiles: async (rootPath) => {
      const status = await gitManager.status(rootPath)
      return (status?.changes ?? []).map((change) => change.filePath)
    },
    // Working-tree hunks as before/after content (git-manager returns contents,
    // not patches) — enough signal for the judge, and one code path with the
    // diff overlay's source.
    diffFor: async (rootPath, filePath) => {
      const diff = await gitManager.diff(rootPath, filePath)
      const before = diff.beforeContent ?? ''
      const after = diff.afterContent ?? ''
      if (before === after) return ''
      return `--- before\n${before.slice(0, 12_000)}\n+++ after\n${after.slice(0, 12_000)}`
    },
    // MORE THAN ONE TURN, DELIBERATELY. This prompt is not a summarization: it
    // embeds `### <filePath>` headings and asks for a JSON judgment, so the
    // model reaches for those paths and the attempt consumes a turn. At the
    // shared default of 1 every call died with "Reached maximum number of turns
    // (1)", which the checker swallowed as non-fatal and reported as
    // `not-checked (model unavailable)` for every module — the advisory verdicts
    // never appeared and nothing upstream looked broken.
    //
    // `generateBrief` pins `allowedTools: []`, so the extra turns can only ever
    // buy more text: the reach for a file cannot succeed, and the turn after it
    // is where the answer lands.
    runModel: (rootPath, prompt) =>
      agentManager?.generateBrief({
        projectRoot: rootPath,
        prompt,
        maxTurns: INVARIANT_MODEL_MAX_TURNS,
      }) ?? Promise.resolve(null),
    broadcast: (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('blueprint:invariantVerdicts', event)
      }
    },
  })
  const invariantServiceRef = invariantService
  gitManager.on(GIT_CHANGED_EVENT, (event) => {
    const rootId = (event as GitChangedEvent).rootId
    // Drift cache (PERF): commits/index moves change authorship + dirtiness —
    // drop the root's cached drift assembly so the next board read re-runs it.
    blueprintObserver.invalidateDriftCache(rootId)
    invariantServiceRef.trigger(rootId)
    // Pending-hunks ⇄ source-control sync (#893): a commit or full staging in
    // source control settles the strip's review — reconcile on git changes.
    const tracker = agentManager?.getEditTracker() ?? null
    if (tracker !== null) {
      void gitManager
        .status(rootId)
        .then((status) => tracker.reconcileWithGit(rootId, status?.changes ?? []))
        .catch(() => undefined)
    }
  })
  ipcMain.handle('blueprint:listInvariantVerdicts', (_event, request: { rootId: string }) =>
    invariantServiceRef.snapshot(request.rootId),
  )
  // Agent doc verification (doc-verification Phase 3): one caged session per
  // doc, recorded via the bundled CLI (one write path), promoted to the brain.
  ipcMain.handle(
    'blueprint:verifyDoc',
    async (
      _event,
      request: { rootId: string; path: string },
    ): Promise<{
      ok: boolean
      reason?: string
      verdict?: 'corroborated' | 'contradicted' | 'unverifiable'
      promoted?: number
      observations?: number
      claims?: { corroborated: number; contradicted: number; unverifiable: number }
    }> => {
      if (!bundledCli) return { ok: false, reason: 'verification unavailable — no bundled CLI configured' }
      const authEnv = await resolveLearnAuthEnv?.(request.rootId)
      const result = await runVerifyDoc(request.rootId, request.path, {
        bundledCli,
        ...(authEnv ? { authEnv } : {}),
      })
      const counts =
        result.claims !== undefined
          ? {
              corroborated: result.claims.filter((claim) => claim.outcome === 'corroborated').length,
              contradicted: result.claims.filter((claim) => claim.outcome === 'contradicted').length,
              unverifiable: result.claims.filter((claim) => claim.outcome === 'unverifiable').length,
            }
          : undefined
      return {
        ok: result.ok,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.verdict !== undefined ? { verdict: result.verdict } : {}),
        ...(result.promoted !== undefined ? { promoted: result.promoted } : {}),
        ...(result.observations !== undefined ? { observations: result.observations } : {}),
        ...(counts !== undefined ? { claims: counts } : {}),
      }
    },
  )

  // Cross-link decisions (federation): ✓/✕ route through the CLI link/unlink
  // verbs — the store's ONE writer (#14).
  ipcMain.handle(
    'blueprint:crossLinkDecide',
    async (
      _event,
      request: { rootId: string; provider: string; endpoint: string; decide: 'confirm' | 'reject' },
    ): Promise<{ ok: boolean; reason?: string }> => {
      const verb = request.decide === 'confirm' ? 'link' : 'unlink'
      const result = await runBundledCliCapturing(bundledCli, request.rootId, [
        'blueprint',
        verb,
        '--project',
        request.provider,
        '--endpoint',
        request.endpoint,
      ])
      return result.ok ? { ok: true } : { ok: false, reason: result.error ?? `${verb} failed` }
    },
  )
  // Sibling refresh (federation): background derive of the linked repo via
  // its surface-recorded path — explicit user action only, never automatic.
  ipcMain.handle(
    'blueprint:refreshSibling',
    async (
      _event,
      request: { rootId: string; siblingRepoPath: string },
    ): Promise<{ ok: boolean; reason?: string }> => {
      const { existsSync: existsCheck } = require('node:fs') as typeof import('node:fs')
      if (!existsCheck(request.siblingRepoPath)) {
        return { ok: false, reason: `sibling repo not found at ${request.siblingRepoPath}` }
      }
      const result = await runBundledCliCapturing(bundledCli, request.siblingRepoPath, [
        'blueprint',
        'derive',
      ])
      return result.ok ? { ok: true } : { ok: false, reason: result.error ?? 'sibling derive failed' }
    },
  )
  // Manual doc adjudication (Docs tab): the SAME CLI verb the learn pass uses
  // (#14) — user-driven trust/distrust with explicit evidence provenance.
  ipcMain.handle(
    'blueprint:adjudicateDoc',
    async (
      _event,
      request: { rootId: string; path: string; verdict: 'corroborated' | 'contradicted' },
    ): Promise<{ ok: boolean; reason?: string }> => {
      if (request.verdict !== 'corroborated' && request.verdict !== 'contradicted') {
        return { ok: false, reason: 'invalid verdict' }
      }
      const args = [
        'blueprint',
        'adjudicate',
        '--path',
        request.path,
        '--verdict',
        request.verdict,
        '--evidence',
        'manually adjudicated by the user from the Docs panel',
      ]
      const result = await runBundledCliCapturing(bundledCli, request.rootId, args)
      return result.ok ? { ok: true } : { ok: false, reason: result.error ?? 'adjudicate failed' }
    },
  )
  // Durable must-review acks (#910 follow-up): append-only titles store the
  // CLI's derive filters against — acknowledgment survives every rotation.
  ipcMain.handle(
    'blueprint:ackMustReview',
    async (_event, request: { rootId: string; titles: string[] }): Promise<{ ok: boolean; reason?: string }> => {
      try {
        const { appendFileSync, mkdirSync: mkdirAck } = require('node:fs') as typeof import('node:fs')
        const dir = join(request.rootId, 'flow', 'brain', '.structure')
        mkdirAck(dir, { recursive: true })
        const now = new Date().toISOString()
        const lines = request.titles
          .filter((title) => typeof title === 'string' && title.length > 0)
          .map((title) => `${JSON.stringify({ ts: now, title })}\n`)
          .join('')
        appendFileSync(join(dir, 'mustreview-acks.jsonl'), lines)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  )
  // Must-review summaries (#must-review substance): a CRIT one-liner is not a
  // review. Gather real context (source excerpt + repo references), ask the
  // one-shot model for a markdown summary, persist it under flow/brain/reviews/
  // (brain-indexed → the agent learns it too), and return the path for a peek.
  ipcMain.handle(
    'blueprint:reviewSummary',
    async (
      _event,
      request: {
        rootId: string
        nodeId: string
        label: string
        sourceFile: string
        items: Array<{ severity: string; title: string; detail: string }>
      },
    ): Promise<{ ok: boolean; path?: string; reason?: string }> => {
      try {
        const { readFileSync: readSync, mkdirSync: mkdir, writeFileSync: writeSync } =
          require('node:fs') as typeof import('node:fs')
        const { execFile } = require('node:child_process') as typeof import('node:child_process')
        const sourceAbs = join(request.rootId, request.sourceFile)
        let sourceExcerpt = ''
        try {
          sourceExcerpt = readSync(sourceAbs, 'utf8').slice(0, 4_000)
        } catch {
          sourceExcerpt = '(source file unreadable)'
        }
        // Repo references: where does this thing appear? Cheap + bounded.
        const needle = request.label.replace(/[^\w@/.-]+/g, ' ').trim().split(/\s+/)[0] ?? request.label
        let references = ''
        try {
          // Async execFile (PERF): the sync variant froze the main process for
          // up to the 5s timeout on large repos. Same timeout + failure shape.
          const grepOutput = await new Promise<string>((resolveExec, rejectExec) => {
            execFile(
              'git',
              ['grep', '-l', '-i', needle, '--', '.'],
              { cwd: request.rootId, timeout: 5_000 },
              (error, stdout) => (error ? rejectExec(error) : resolveExec(stdout)),
            )
          })
          references = grepOutput.split('\n').filter(Boolean).slice(0, 20).join('\n')
        } catch {
          references = '(no references found)'
        }
        const itemLines = request.items
          .map((item) => `- [${item.severity}] ${item.title}${item.detail ? ` — ${item.detail}` : ''}`)
          .join('\n')
        const prompt = [
          `Write a concise markdown REVIEW SUMMARY for a code-review item on the project's system map.`,
          '',
          `Node: ${request.label} (${request.nodeId})`,
          `Anchored at: ${request.sourceFile}`,
          `Must-review items:`,
          itemLines,
          '',
          `Source excerpt (${request.sourceFile}):`,
          '```',
          sourceExcerpt,
          '```',
          '',
          'Files referencing it:',
          references,
          '',
          'Structure the summary as: ## What changed · ## Where it lives (the referencing files, what role each plays) · ## What to check (3-5 concrete review questions) · ## Verdict guidance. Max ~40 lines. Reply with ONLY the markdown.',
        ].join('\n')
        const notes = await (agentManager?.generateBrief({ projectRoot: request.rootId, prompt }) ??
          Promise.resolve(null))
        if (notes === null) return { ok: false, reason: 'model unavailable' }
        const slug = request.nodeId.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
        const dir = join(request.rootId, 'flow', 'brain', 'reviews')
        mkdir(dir, { recursive: true })
        const relPath = join('flow', 'brain', 'reviews', `${slug}.md`)
        writeSync(join(request.rootId, relPath), `# Review: ${request.label}\n\n${notes}\n`)
        return { ok: true, path: relPath }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  // NOTE: agent Bash calls are intentionally NOT mirrored into the terminal.
  // The terminal panel is for the user's own interactive shells; the agent's
  // command + output already surface as a Bash tool card in the conversation.
  // The mirror (createBashMirrorHooks) and live PTY route (createBashPtyExecutor)
  // in ./terminal/bash-bridge remain available for a future opt-in
  // "stream this command to the terminal" action on the Bash card.

  // Restore persisted project roots (starts file watchers per root).
  const roots = projectRegistry.restore()

  // ADR-002: restore the last-active project so the renderer can rebind its
  // context on boot — through the shared availability seam, which guarantees
  // the two things boot used to get wrong:
  //   #975 — it activated a persisted root whose folder was GONE (titlebar
  //          naming it while the sidebar tagged it `unavailable`, every surface
  //          empty). An unreachable request now degrades to a surviving root.
  //   #1080 — when the pointer named a non-root it activated NOTHING, booting to
  //          "No project" with healthy projects in the sidebar. There is now
  //          always a fallback whenever any root is reachable.
  // The chosen root is persisted by setActiveProject (it stamps last_active_at),
  // so a fallback also HEALS the stale pointer instead of re-deciding forever.
  const bootActivation = resolveActiveRoot(roots, projectContext.lastActiveProject())
  if (bootActivation.rootPath !== null) {
    if (bootActivation.reason === 'fallback') {
      console.warn(
        `[Project] Last-active project unavailable (${bootActivation.rejected ?? 'none recorded'}) — opening ${bootActivation.rootPath}`,
      )
    }
    projectContext.setActiveProject(bootActivation.rootPath)
  } else if (bootActivation.rejected !== null) {
    // Nothing reachable to fall back to (the single-project case): say so
    // instead of opening an empty window that looks like "Flow is broken".
    notifyUnreachableProject(bootActivation.rejected)
  }

  // Seed each restored root's readiness snapshot (#513 phase 1) BEFORE the
  // sweep below fires any run — `provisioningState` is in-memory only (no
  // persisted column), so it's recomputed from scratch every launch: a root
  // already stamped at the current bundle version starts 'ready', everything
  // else starts 'idle' and the sweep drives it forward.
  for (const root of roots) {
    projectRegistry.setProvisioningState(
      root.id,
      provisioner.initialStateFor({ available: root.available !== false, provisionedVersion: root.provisionedVersion }),
    )
  }

  // Startup provisioning sweep (ide-auto-provisioning): heal every restored
  // project so existing stale installs update to the bundled CLI's version on
  // launch.
  //
  // DEFERRED, AND ONE AT A TIME. "Fire-and-forget" meant every root at once, at
  // the instant the window appears: on a version drift — which is exactly what
  // an update is — that spawned a full `planflow-ai init` per project,
  // concurrently, each of which derives a blueprint of its own. Four projects
  // made four CLI processes racing the first paint, and the app spent the first
  // seconds of every post-update launch with a spinner over a thread list that
  // was itself ready in one millisecond. Reported twice as "a big loading on
  // the thread list after reinstall".
  //
  // Nothing here is urgent: a root provisions before its first agent turn
  // (awaitProvisioning gates that), so the sweep can wait for the window to
  // settle and then walk the roots in order.
  void (async () => {
    await new Promise((resolve) => setTimeout(resolve, PROVISION_SWEEP_DELAY_MS))
    for (const root of roots) await provisioner.maybeProvision(root)
    // EVERY ROOT HAS SETTLED: the launch's migration moves whatever is outside
    // a Workspace in (once; nothing to do on a launch with nothing outside),
    // and only then does each Workspace sync.
    if (!e2eWithoutFlowFolder) await placement.start()
    for (const root of roots) {
      askAfterPlacement(root.id)
      openKnowledge(root.rootPath)
    }
    // THE RESTART RE-CHECK: every project in a Workspace that still lacks its
    // basic discovery (a sweep the last session never finished, a project that
    // joined while the app was closed) is queued again.
    reconcileBasicDiscovery()
  })()

  // THE BOOT, ITEMISED. One line, with the stretches that cost something —
  // written always (not only when slow), because startup is the one moment
  // every user pays for and a baseline nobody recorded is a baseline nobody
  // can regress against.
  mark('ready')
  const boot = milestones.map(([name, at], index) => {
    const previous = index === 0 ? bootStartedAt : (milestones[index - 1]?.[1] ?? bootStartedAt)
    return `${name} ${String(Math.round(at - previous))}ms`
  })
  recordSlow(
    `[main] bootstrap ${String(Math.round(performance.now() - bootStartedAt))}ms — ${boot.join(', ')}`,
  )
}

/** How long the startup provisioning sweep waits for the window to settle. */
const PROVISION_SWEEP_DELAY_MS = 3_000
/** Connections learning waits this long after launch, so the launch's own learning goes first. */
const CONNECTIONS_LAUNCH_DELAY_MS = 90_000

// Single-instance lock (#544): a second launch shares the same userData/flow.db;
// its bootstrap would fail on the locked DB and render a handler-less zombie
// window full of "No handler registered" errors. Hold one lock — the second
// instance focuses the existing window and exits.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })
}

void app.whenReady().then(() => {
  // The second instance is already quitting — never bootstrap against the
  // locked DB (that's the zombie-window bug, #544).
  if (!hasSingleInstanceLock) return
  try {
    bootstrapMainProcess()
  } catch (error) {
    // The app cannot function without its store — bail out early rather than
    // presenting a window with no working backend. But surface WHY first: a
    // silent quit reads as "the app is broken" with no recovery hint (#163).
    console.error('[Main] Fatal: failed to bootstrap main process:', error)
    const { title, message } = describeBootstrapError(error)
    try {
      dialog.showErrorBox(title, message)
    } catch {
      // No display (headless/cron) — the console line above is the fallback.
    }
    app.quit()
    return
  }

  // Dev dock icon on macOS (packaged builds get their icon from the .icns).
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    try {
      const icon = nativeImage.createFromPath(appIconPath())
      if (!icon.isEmpty()) app.dock.setIcon(icon)
    } catch (error) {
      console.warn('[Main] Could not set dev dock icon:', error)
    }
  }

  installApplicationMenu()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/**
 * Reverse construction order: git → LSP → terminal → blueprint → flow →
 * files → agent IPC → core IPC, then the managers underneath them. (The git and
 * LSP dispose functions also dispose their managers.) Async disposals are
 * AWAITED — the quit lifecycle below holds the app open until this resolves,
 * so LSP children get their full SIGTERM/SIGKILL sequence before exit.
 */
async function disposeMainProcess(): Promise<void> {
  // #1443: FIRST, before any of the machinery the renderer's own hot-exit write
  // depends on comes down. Quit is intercepted, so this used to run to
  // completion — disposeIpc(), then db.close() — before the window unloaded,
  // and the `beforeunload` persist had no receiver: every edit typed since the
  // last tab mutation was destroyed and the tab was restored CLEAN.
  // The session closes FIRST, while the store it reads is still open — after
  // db.close() the consent check below it has nothing to read.
  telemetryService?.end()
  telemetryService = null
  // A LAST DRAIN, BOUNDED BY THE QUIT DEADLINE that already wraps this whole
  // function. It never rejects, and nothing waits on its result beyond that —
  // a usage count must not be able to hold a quit open.
  const delivery = telemetryDelivery
  telemetryDelivery = null
  if (delivery !== null) {
    await delivery.flush().catch(() => undefined)
    delivery.stop()
  }
  await flushEditorContext(BrowserWindow.getAllWindows())
  // KNOWLEDGE: one bounded commit per Workspace with work waiting. Its own
  // bound sits well inside the quit deadline, and it never rejects —
  // knowledge that misses it goes on the next open.
  const routesOnQuit = knowledgeRouter
  knowledgeRouter = null
  if (routesOnQuit !== null) await routesOnQuit.quit().catch(() => undefined)
  disposeWorkspacesIpc?.()
  disposeWorkspacesIpc = null
  disposeReviewIpc?.()
  disposeReviewIpc = null
  invariantService?.dispose()
  invariantService = null
  disposeGitIpc?.()
  disposeGitIpc = null
  if (disposeLspIpc) {
    const disposeLsp = disposeLspIpc
    disposeLspIpc = null
    try {
      await disposeLsp()
    } catch (error) {
      console.error('[Main] Failed to dispose LSP:', error)
    }
  }
  disposeTerminalIpc?.()
  disposeTerminalIpc = null
  if (terminalManager) {
    try {
      terminalManager.disposeAll()
    } catch (error) {
      console.error('[Main] Failed to dispose terminal manager:', error)
    }
    terminalManager = null
  }
  // Progressive-learning: the run-aware triggers only subscribe to the shared
  // FlowObserver — disposeFlowIpc below disposes that observer (removeAllListeners),
  // dropping this subscription; there is nothing else to tear down, so just drop
  // the reference.
  learnRunTriggers = null
  // Progressive-learning: stop the staleness watcher (cancel idle timers, drop
  // the file-change subscription) before the orchestrator it feeds.
  if (learnTriggers) {
    try {
      learnTriggers.dispose()
    } catch (error) {
      console.error('[Main] Failed to dispose learn triggers:', error)
    }
    learnTriggers = null
  }
  // Progressive-learning: tear down the orchestrator (abort the in-flight
  // caged session, drop the queue) before the blueprint observer it reads from.
  if (learnOrchestrator) {
    try {
      learnOrchestrator.dispose()
    } catch (error) {
      console.error('[Main] Failed to dispose learn orchestrator:', error)
    }
    learnOrchestrator = null
  }
  disposeBlueprintIpc?.()
  disposeBlueprintIpc = null
  disposeBrainIpc?.()
  disposeBrainIpc = null
  disposeShareIpc?.()
  disposeShareIpc = null
  disposeLoopsIpc?.()
  disposeLoopsIpc = null
  disposeSettingsIpc?.()
  disposeSettingsIpc = null
  // #1284: awaited — this closes the FlowObserver's watchers, and a quit that
  // races them leaves a persistent watcher holding the process open.
  if (disposeFlowIpc) {
    const disposeFlow = disposeFlowIpc
    disposeFlowIpc = null
    try {
      await disposeFlow()
    } catch (error) {
      console.error('[Main] Failed to dispose flow observer:', error)
    }
  }
  disposeArtifactIpc?.()
  disposeArtifactIpc = null
  disposeWalkthroughPages?.()
  disposeWalkthroughPages = null
  disposeFileIpc?.()
  disposeFileIpc = null
  disposeAccountsIpc?.()
  disposeAccountsIpc = null
  disposeAgentIpc?.()
  disposeAgentIpc = null
  disposeIpc?.()
  disposeIpc = null
  threadScopeManager?.dispose()
  threadScopeManager = null
  disposeAutoOpen?.()
  disposeAutoOpen = null
  if (agentManager) {
    try {
      agentManager.dispose()
    } catch (error) {
      console.error('[Main] Failed to dispose agent manager:', error)
    }
    agentManager = null
  }
  if (projectRegistry) {
    try {
      await projectRegistry.dispose()
    } catch (error) {
      console.error('[Main] Failed to dispose project registry:', error)
    }
    projectRegistry = null
  }
  if (db) {
    try {
      db.close()
    } catch (error) {
      console.error('[Main] Failed to close database:', error)
    }
    db = null
  }
}

// Quit lifecycle: `will-quit` is synchronous, so async disposals fired from
// it are orphaned when the process exits (leaked tsserver children across
// restarts). Instead, intercept `before-quit`, run the full async disposal,
// then re-issue quit — the re-entrancy flag lets the second quit() pass
// through untouched.
let quitDisposalComplete = false
let quitDisposalInFlight: Promise<void> | null = null

/**
 * #1284: the disposal gets a deadline. Quit is intercepted so the async
 * teardown can run, which means ANY step that never settles takes quit with
 * it — and one did: a leaked chokidar watcher (fixed at its source in
 * flow-observer.ts) kept the process alive after its window was gone.
 *
 * Fixing that cause is necessary but not sufficient. A user pressing ⌘Q must
 * get a quit; a slow or wedged teardown may cost cleanliness, never the exit.
 * So disposal is bounded, quit is re-issued either way, and if the process is
 * somehow STILL here after the grace period we exit hard rather than linger
 * invisibly (a "closed" app that still holds the DB makes the next launch a
 * second instance).
 */
const QUIT_DISPOSAL_TIMEOUT_MS = 5_000
const QUIT_HARD_EXIT_GRACE_MS = 2_000

function withDeadline(work: Promise<void>, ms: number, label: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.error(`[Main] ${label} did not settle within ${ms}ms — quitting anyway`)
      resolve()
    }, ms)
    void work.finally(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

app.on('before-quit', (event) => {
  if (quitDisposalComplete) {
    return
  }
  event.preventDefault()
  if (quitDisposalInFlight) {
    return
  }
  quitDisposalInFlight = withDeadline(
    disposeMainProcess().catch((error) => {
      console.error('[Main] Failed to dispose main process on quit:', error)
    }),
    QUIT_DISPOSAL_TIMEOUT_MS,
    'main-process disposal',
  ).then(() => {
    quitDisposalComplete = true
    app.quit()
    // Last resort: something outside our teardown (a leaked handle, a native
    // module) can still hold the loop. Better a hard exit than an invisible
    // process the user has to Force Quit.
    const reaper = setTimeout(() => {
      console.error('[Main] Still running after quit — exiting hard')
      app.exit(0)
    }, QUIT_HARD_EXIT_GRACE_MS)
    reaper.unref()
  })
})
