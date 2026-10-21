import { contextBridge, ipcRenderer, webFrame, webUtils, type IpcRendererEvent } from 'electron'
import {
  IPC_EVENT_CHANNELS,
  IPC_INVOKE_CHANNELS,
  type FlowApi,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcInvokeChannel,
  type IpcRequest,
  type IpcResponse,
  type Unsubscribe,
} from '../shared/ipc-contract'

/**
 * Flow preload bridge.
 *
 * Security contract: the renderer gets access ONLY to what is exposed here
 * via contextBridge — no Node APIs, no Electron internals, no secrets.
 * Every call is funneled through `invoke`/`subscribe`, which refuse any
 * channel not allowlisted in `src/shared/ipc-contract.ts`, so a compromised
 * renderer cannot reach arbitrary IPC surface.
 */

const invokeChannels: ReadonlySet<string> = new Set(IPC_INVOKE_CHANNELS)
const eventChannels: ReadonlySet<string> = new Set(IPC_EVENT_CHANNELS)

/**
 * A call slower than this says so in the console, with its channel and time.
 *
 * WHY THIS EXISTS AT ALL. "The cursor spins for five seconds" is a report
 * nobody can act on: the renderer awaits ~170 channels and any of them could be
 * the one. Every performance fix in this file's history started with somebody
 * building a synthetic probe to guess which — this turns the next report into a
 * fact the person seeing it can read off their own screen.
 *
 * A quarter second is the threshold because it is roughly where a press stops
 * feeling instant. Below it, this costs two `Date.now()` calls and nothing else;
 * above it, one line. Never a toast, never UI — it is for whoever opens the
 * console, and a slow read is not a thing to interrupt a reader about.
 */
const SLOW_IPC_MS = 250

function invoke<C extends IpcInvokeChannel>(
  channel: C,
  request: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  if (!invokeChannels.has(channel)) {
    return Promise.reject(new Error(`flow: unknown IPC invoke channel "${channel}"`))
  }
  const startedAt = Date.now()
  callSeq += 1
  countCall(channel)
  const token = `${channel}#${String(callSeq)}`
  inFlight.set(token, { channel, startedAt })
  const settle = (): void => {
    inFlight.delete(token)
  }
  const call = ipcRenderer.invoke(channel, request) as Promise<IpcResponse<C>>
  // TIMED ON BOTH EXITS. A channel that takes four seconds and then throws is
  // exactly as slow as one that takes four seconds and answers, and the failing
  // case is the one somebody is more likely to be staring at.
  return call.then(
    (result) => {
      settle()
      reportSlowInvoke(channel, startedAt)
      return result
    },
    (error: unknown) => {
      settle()
      reportSlowInvoke(channel, startedAt)
      throw error
    },
  )
}

/**
 * Round trips still waiting for an answer, and since when.
 *
 * The renderer's own stall detector asks this when it notices a blocked frame:
 * a freeze WHILE waiting for a channel and a freeze while computing are
 * different problems, and the symptom is identical. Keyed by a token, never by
 * channel, so two concurrent calls on one channel both count.
 */
const inFlight = new Map<string, { channel: string; startedAt: number }>()
let callSeq = 0

function inFlightChannels(): string[] {
  const now = Date.now()
  return [...inFlight.values()]
    .map((call) => ({ channel: call.channel, waited: now - call.startedAt }))
    .sort((a, b) => b.waited - a.waited)
    .slice(0, 5)
    .map((call) => `${call.channel} ${String(call.waited)}ms`)
}

/**
 * Lines waiting to be written, and the timer that will write them.
 *
 * BATCHED, because the instrument must not become the problem: one round trip
 * per observation would add an IPC call to exactly the moments that are already
 * struggling. A second's worth of lines goes over in one call.
 */
const pending: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_DELAY_MS = 1_000
const MAX_PENDING = 200

function record(line: string): void {
  pending.push(line)
  // A recorder that grows without bound during a long stall is a leak wearing a
  // diagnostic's clothes. Keep the NEWEST lines: they are nearest the symptom.
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    const lines = pending.splice(0, pending.length)
    if (lines.length === 0) return
    // Never through `invoke` — it would time itself and record its own latency.
    void ipcRenderer.invoke('diagnostics:record', { lines }).catch(() => {
      // A log that cannot be written must never break the app it measures.
    })
  }, FLUSH_DELAY_MS)
  flushTimer.unref?.()
}

/**
 * How many calls each channel made, per window of time.
 *
 * A LOUD app and a SLOW app look identical from the inside: no single call is
 * slow, and the machine has no capacity left. This repo has fixed the same
 * shape four times (a hot broadcast answered with a full refresh), and each
 * time it was found by somebody profiling, not by the app saying so. Now it
 * says so: a window with an unreasonable call count names its top channels.
 */
const callCounts = new Map<string, number>()
let windowStartedAt = Date.now()

/** Two calls a second, sustained, is chatter — nobody clicks that fast. */
const CHATTY_WINDOW_MS = 30_000
const CHATTY_CALL_COUNT = 60

function countCall(channel: string): void {
  callCounts.set(channel, (callCounts.get(channel) ?? 0) + 1)
  const elapsed = Date.now() - windowStartedAt
  if (elapsed < CHATTY_WINDOW_MS) return
  let total = 0
  for (const count of callCounts.values()) total += count
  if (total >= CHATTY_CALL_COUNT) {
    const top = [...callCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, count]) => `${name} ×${String(count)}`)
      .join(', ')
    record(
      `[renderer] ${String(total)} IPC calls in ${String(Math.round(elapsed / 1000))}s — ${top}`,
    )
  }
  callCounts.clear()
  windowStartedAt = Date.now()
}

function reportSlowInvoke(channel: string, startedAt: number): void {
  const elapsed = Date.now() - startedAt
  if (elapsed < SLOW_IPC_MS) return
  console.warn(`flow: slow IPC — ${channel} took ${String(elapsed)}ms`)
  // …and to the file, because the console is a place nobody was asked to look.
  record(`[renderer] waited ${String(elapsed)}ms for ${channel}`)
}

function subscribe<C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventPayload<C>) => void,
): Unsubscribe {
  if (!eventChannels.has(channel)) {
    throw new Error(`flow: unknown IPC event channel "${channel}"`)
  }
  const wrapped = (_event: IpcRendererEvent, payload: IpcEventPayload<C>): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const flowApi: FlowApi = {
  threads: {
    list: (request) => invoke('threads:list', request),
    children: (request) => invoke('threads:children', request),
    openSubagent: (request) => invoke('threads:openSubagent', request),
    get: (request) => invoke('threads:get', request),
    backgroundTasks: (request) => invoke('threads:backgroundTasks', request),
    create: (request) => invoke('threads:create', request),
    branchAvailable: (request) => invoke('threads:branchAvailable', request),
    update: (request) => invoke('threads:update', request),
    setRoots: (request) => invoke('threads:setRoots', request),
    learningFirst: (request) => invoke('threads:learningFirst', request),
    retryLearningFirst: (request) => invoke('threads:retryLearningFirst', request),
    prepareWorktree: (request) => invoke('threads:prepareWorktree', request),
    worktreeBranches: (request) => invoke('threads:worktreeBranches', request),
    retargetWorktree: (request) => invoke('threads:retargetWorktree', request),
    landingPreview: (request) => invoke('threads:landingPreview', request),
    landWorktree: (request) => invoke('threads:landWorktree', request),
    releaseWorktree: (request) => invoke('threads:releaseWorktree', request),
    worktreeUsage: (request) => invoke('threads:worktreeUsage', request),
    worktreeInventory: (request) => invoke('threads:worktreeInventory', request),
    renameWorktreeBranch: (request) => invoke('threads:renameWorktreeBranch', request),
    forgetWorktree: (request) => invoke('threads:forgetWorktree', request),
    worktreeBinding: (request) => invoke('threads:worktreeBinding', request),
    bindWorktree: (request) => invoke('threads:bindWorktree', request),
    delete: (request) => invoke('threads:delete', request),
    search: (request) => invoke('threads:search', request),
    sendMessage: (request) => invoke('threads:sendMessage', request),
    interrupt: (request) => invoke('threads:interrupt', request),
    setModel: (request) => invoke('threads:setModel', request),
    contextUsage: (request) => invoke('threads:contextUsage', request),
    respondPermission: (request) => invoke('threads:respondPermission', request),
    pendingPermissions: (request) => invoke('threads:pendingPermissions', request),
    pendingDialogs: (request) => invoke('threads:pendingDialogs', request),
    respondDialog: (request) => invoke('threads:respondDialog', request),
    importClaude: (request) => invoke('threads:importClaude', request),
    brainSavings: (request) => invoke('threads:brainSavings', request),
    subagentTranscript: (request) => invoke('threads:subagentTranscript', request),
    onStream: (listener) => subscribe('threads:stream', listener),
    onPermissionRequest: (listener) => subscribe('threads:permissionRequest', listener),
    onDialogRequest: (listener) => subscribe('threads:dialogRequest', listener),
    onDialogCancel: (listener) => subscribe('threads:dialogCancel', listener),
    onUpdated: (listener) => subscribe('threads:updated', listener),
    onContextChosen: (listener) => subscribe('threads:contextChosen', listener),
    onContextOffer: (listener) => subscribe('threads:contextOffer', listener),
  },
  tasks: {
    list: (request) => invoke('tasks:list', request),
    create: (request) => invoke('tasks:create', request),
    importIssue: (request) => invoke('tasks:importIssue', request),
    createFromQueueItem: (request) => invoke('tasks:createFromQueueItem', request),
    setProjects: (request) => invoke('tasks:setProjects', request),
    update: (request) => invoke('tasks:update', request),
    mergePr: (request) => invoke('tasks:mergePr', request),
    delete: (request) => invoke('tasks:delete', request),
    generateBrief: (request) => invoke('tasks:generateBrief', request),
    ensureThread: (request) => invoke('tasks:ensureThread', request),
    boardLoop: (request) => invoke('tasks:boardLoop', request),
    onUpdated: (listener) => subscribe('tasks:updated', listener),
    onBoardLoopChanged: (listener) => subscribe('tasks:boardLoopChanged', listener),
  },
  integrations: {
    setToken: (request) => invoke('integrations:setToken', request),
    status: (request) => invoke('integrations:status', request),
    clearToken: (request) => invoke('integrations:clearToken', request),
    assigned: (request) => invoke('integrations:assigned', request),
    getListConfig: (request) => invoke('integrations:getListConfig', request),
    setListConfig: (request) => invoke('integrations:setListConfig', request),
    getCloseOnDone: (request) => invoke('integrations:getCloseOnDone', request),
    setCloseOnDone: (request) => invoke('integrations:setCloseOnDone', request),
    previewList: (request) => invoke('integrations:previewList', request),
    imageData: (request) => invoke('integrations:imageData', request),
  },
  messages: {
    list: (request) => invoke('messages:list', request),
    append: (request) => invoke('messages:append', request),
  },
  toolCalls: {
    list: (request) => invoke('toolCalls:list', request),
    get: (request) => invoke('toolCalls:get', request),
  },
  editor: {
    hover: (request) => invoke('editor:hover', request),
    definition: (request) => invoke('editor:definition', request),
    completions: (request) => invoke('editor:completions', request),
    didOpen: (request) => invoke('editor:didOpen', request),
    didChange: (request) => invoke('editor:didChange', request),
    didClose: (request) => invoke('editor:didClose', request),
    pendingChanges: (request) => invoke('editor:pendingChanges', request),
    resolveHunk: (request) => invoke('editor:resolveHunk', request),
    onDiagnostics: (listener) => subscribe('editor:diagnostics', listener),
    onPendingChangesUpdated: (listener) =>
      subscribe('editor:pendingChangesUpdated', listener),
    onCloseActiveTab: (listener) => subscribe('editor:closeActiveTab', listener),
    onEditAction: (listener) => subscribe('editor:editAction', listener),
    onOpenSettings: (listener) => subscribe('settings:open', listener),
  },
  terminal: {
    list: () => invoke('terminal:list', {}),
    create: (request) => invoke('terminal:create', request),
    write: (request) => invoke('terminal:write', request),
    resize: (request) => invoke('terminal:resize', request),
    dispose: (request) => invoke('terminal:dispose', request),
    claim: (request) => invoke('terminal:claim', request),
    rename: (request) => invoke('terminal:rename', request),
    onData: (listener) => subscribe('terminal:data', listener),
    onExit: (listener) => subscribe('terminal:exit', listener),
    onRemoved: (listener) => subscribe('terminal:removed', listener),
    onCreated: (listener) => subscribe('terminal:created', listener),
  },
  // #1352: the renderer's current zoom factor. View ▸ Zoom In/Out changes how
  // many device pixels a CSS px is, and the macOS traffic lights do NOT scale
  // with it — so any clearance expressed as a fixed CSS length drifts.
  zoomFactor: () => {
    try {
      return webFrame.getZoomFactor()
    } catch {
      return 1
    }
  },
  attachments: {
    read: (request) => invoke('attachments:read', request),
    revealPath: (request) => invoke('attachments:revealPath', request),
    captureScreen: (request) => invoke('attachments:captureScreen', request),
    // #1339: the absolute path of a File from an OS drag. `File.path` was
    // removed in Electron 32; `webUtils.getPathForFile` is the replacement,
    // and it must be called in the PRELOAD — the renderer has no access to it.
    pathFor: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return '' // not an OS file (a synthetic drag) — nothing to open
      }
    },
  },
  git: {
    status: (request) => invoke('git:status', request),
    renameBranch: (request) => invoke('git:renameBranch', request),
    log: (request) => invoke('git:log', request),
    diff: (request) => invoke('git:diff', request),
    listUntrackedDir: (request) => invoke('git:listUntrackedDir', request),
    commit: (request) => invoke('git:commit', request),
    stage: (request) => invoke('git:stage', request),
    unstage: (request) => invoke('git:unstage', request),
    discardFile: (request) => invoke('git:discardFile', request),
    commitIndex: (request) => invoke('git:commitIndex', request),
    publish: (request) => invoke('git:publish', request),
    mergeState: (request) => invoke('git:mergeState', request),
    readConflicted: (request) => invoke('git:readConflicted', request),
    resolveConflict: (request) => invoke('git:resolveConflict', request),
    resolveConflictHunk: (request) => invoke('git:resolveConflictHunk', request),
    completeMerge: (request) => invoke('git:completeMerge', request),
    abortMerge: (request) => invoke('git:abortMerge', request),
    continueRebase: (request) => invoke('git:continueRebase', request),
    abortRebase: (request) => invoke('git:abortRebase', request),
    verifyMerge: (request) => invoke('git:verifyMerge', request),
    writeMergeSummary: (request) => invoke('git:writeMergeSummary', request),
    listBranches: (request) => invoke('git:listBranches', request),
    mergeBranch: (request) => invoke('git:mergeBranch', request),
    pull: (request) => invoke('git:pull', request),
    listAgentClashes: (request) => invoke('git:listAgentClashes', request),
    readAgentClash: (request) => invoke('git:readAgentClash', request),
    reconcileAgentClash: (request) => invoke('git:reconcileAgentClash', request),
    onChanged: (listener) => subscribe('git:changed', listener),
    changeReview: (request) => invoke('threads:changeReview', request),
    onChangeReviewUpdated: (listener) => subscribe('threads:changeReviewUpdated', listener),
  },
  review: {
    list: (request) => invoke('review:list', request),
    reject: (request) => invoke('review:reject', request),
    generateCommitMessage: (request) => invoke('review:generateCommitMessage', request),
  },
  flow: {
    state: (request) => invoke('flow:state', request),
    respondPrompt: (request) => invoke('flow:respondPrompt', request),
    setConfig: (request) => invoke('flow:setConfig', request),
    worktreeSettings: (request) => invoke('flow:worktreeSettings', request),
    recordVerdict: (request) => invoke('flow:recordVerdict', request),
    onNotification: (listener) => subscribe('flow:notification', listener),
    onStateChanged: (listener) => subscribe('flow:stateChanged', listener),
    onArtifactChanged: (listener) => subscribe('flow:artifactChanged', listener),
    listArtifacts: (request) => invoke('flow:listArtifacts', request),
    chain: (request) => invoke('flow:chain', request),
    onChainChanged: (listener) => subscribe('flow:chainChanged', listener),
  },
  settings: {
    getOnboarding: () => invoke('settings:getOnboarding', {}),
    setOnboarding: (request) => invoke('settings:setOnboarding', request),
    getTelemetryConsent: () => invoke('settings:getTelemetryConsent', {}),
    whoAmI: () => invoke('auth:whoAmI', {}),
    authAvailable: () => invoke('auth:available', {}),
    signIn: () => invoke('auth:signIn', {}),
    signOut: () => invoke('auth:signOut', {}),
    onAuthChanged: (listener) => subscribe('auth:changed', listener),
    shouldAskTelemetry: () => invoke('settings:shouldAskTelemetry', {}),
    recordTelemetryAsk: () => invoke('settings:recordTelemetryAsk', {}),
    setTelemetryConsent: (request) => invoke('settings:setTelemetryConsent', request),
    getModelRouting: () => invoke('settings:getModelRouting', {}),
    setModelRouting: (request) => invoke('settings:setModelRouting', request),
    checkRuntimeAuth: (request) => invoke('settings:checkRuntimeAuth', request),
    installRuntime: (request) => invoke('settings:installRuntime', request),
    startRuntimeLogin: (request) => invoke('settings:startRuntimeLogin', request),
    cancelRuntimeLogin: () => invoke('settings:cancelRuntimeLogin', {}),
    signOutRuntime: (request) => invoke('settings:signOutRuntime', request),
    getRuntimeModels: (request) => invoke('settings:getRuntimeModels', request),
    setRuntimeModels: (request) => invoke('settings:setRuntimeModels', request),
    setModelContext: (request) => invoke('settings:setModelContext', request),
    onRuntimeLoginEvent: (listener) => subscribe('settings:runtimeLoginEvent', listener),
    getDefaultProvider: () => invoke('settings:getDefaultProvider', {}),
    setDefaultProvider: (request) => invoke('settings:setDefaultProvider', request),
    getProjectProvider: (request) => invoke('settings:getProjectProvider', request),
    getWorktreeDefaults: () => invoke('settings:getWorktreeDefaults', {}),
    setWorktreeDefaults: (request) => invoke('settings:setWorktreeDefaults', request),
  },
  blueprint: {
    read: (request) => invoke('blueprint:read', request),
    derive: (request) => invoke('blueprint:derive', request),
    reconcile: (request) => invoke('blueprint:reconcile', request),
    brief: (request) => invoke('blueprint:brief', request),
    featureGraph: (request) => invoke('blueprint:featureGraph', request),
    workspaceGraph: (request) => invoke('blueprint:workspaceGraph', request),
    featureRelations: (request) => invoke('blueprint:featureRelations', request),
    featureMap: (request) => invoke('blueprint:featureMap', request),
    corpusIndex: (request) => invoke('blueprint:corpusIndex', request),
    discoverFeatures: (request) => invoke('blueprint:discoverFeatures', request),
    setFeatureHome: (request) => invoke('blueprint:setFeatureHome', request),
    readBasic: (request) => invoke('blueprint:readBasic', request),
    readLearning: (request) => invoke('blueprint:readLearning', request),
    readStory: (request) => invoke('blueprint:readStory', request),
    storyline: (request) => invoke('blueprint:storyline', request),
    featurePorts: (request) => invoke('blueprint:featurePorts', request),
    features: (request) => invoke('blueprint:features', request),
    ackDrift: (request) => invoke('blueprint:ackDrift', request),
    driftReset: (request) => invoke('blueprint:driftReset', request),
    crossLinkDecide: (request) => invoke('blueprint:crossLinkDecide', request),
    refreshSibling: (request) => invoke('blueprint:refreshSibling', request),
    adjudicateDoc: (request) => invoke('blueprint:adjudicateDoc', request),
    verifyDoc: (request) => invoke('blueprint:verifyDoc', request),
    ackMustReview: (request) => invoke('blueprint:ackMustReview', request),
    reviewSummary: (request) => invoke('blueprint:reviewSummary', request),
    listInvariantVerdicts: (request) => invoke('blueprint:listInvariantVerdicts', request),
    onChanged: (listener) => subscribe('blueprint:changed', listener),
    onInvariantVerdicts: (listener) => subscribe('blueprint:invariantVerdicts', listener),
  },
  loops: {
    read: (request) => invoke('loops:read', request),
    activity: (request) => invoke('loops:activity', request),
    setPaused: (request) => invoke('loops:setPaused', request),
    setDirectivePaused: (request) => invoke('loops:setDirectivePaused', request),
    setDirectiveQueue: (request) => invoke('loops:setDirectiveQueue', request),
    setDirectiveDescription: (request) => invoke('loops:setDirectiveDescription', request),
    describe: (request) => invoke('loops:describe', request),
    approve: (request) => invoke('loops:approve', request),
    queue: (request) => invoke('loops:queue', request),
    claim: (request) => invoke('loops:claim', request),
    unclaim: (request) => invoke('loops:unclaim', request),
    file: (request) => invoke('loops:file', request),
    close: (request) => invoke('loops:close', request),
    finishHunt: (request) => invoke('loops:finishHunt', request),
    forget: (request) => invoke('loops:forget', request),
    owner: (request) => invoke('loops:owner', request),
  },
  brain: {
    query: (request) => invoke('brain:query', request),
  },
  // Feature view sharing: share STATE only. The session token that authorises
  // these calls is read in main and has no route through here.
  share: {
    get: (request) => invoke('share:get', request),
    check: (request) => invoke('share:check', request),
    publish: (request) => invoke('share:publish', request),
    update: (request) => invoke('share:update', request),
    revoke: (request) => invoke('share:revoke', request),
    views: (request) => invoke('share:views', request),
  },
  workspaces: {
    list: () => invoke('workspaces:list', {}),
    status: (request) => invoke('workspaces:status', request),
    membership: (request) => invoke('workspaces:membership', request),
    create: (request) => invoke('workspaces:create', request),
    link: (request) => invoke('workspaces:link', request),
    join: (request) => invoke('workspaces:join', request),
    rename: (request) => invoke('workspaces:rename', request),
    moveProject: (request) => invoke('workspaces:moveProject', request),
    delete: (request) => invoke('workspaces:delete', request),
    placement: () => invoke('workspaces:placement', {}),
    moveIn: (request) => invoke('workspaces:moveIn', request),
    retryPlacement: (request) => invoke('workspaces:retryPlacement', request),
    current: () => invoke('workspaces:current', {}),
    setCurrent: (request) => invoke('workspaces:setCurrent', request),
    suggest: (request) => invoke('workspaces:suggest', request),
    taskProjects: (request) => invoke('workspaces:taskProjects', request),
    taskProjectsMany: (request) => invoke('workspaces:taskProjectsMany', request),
    setTaskProjects: (request) => invoke('workspaces:setTaskProjects', request),
    onChanged: (listener) => subscribe('workspaces:changed', listener),
    syncStatus: (request) => invoke('workspaces:syncStatus', request),
    syncNow: (request) => invoke('workspaces:syncNow', request),
    resolve: (request) => invoke('workspaces:resolve', request),
    hostTools: () => invoke('workspaces:hostTools', {}),
    createRemote: (request) => invoke('workspaces:createRemote', request),
    setRemote: (request) => invoke('workspaces:setRemote', request),
    unsetRemote: (request) => invoke('workspaces:unsetRemote', request),
    onSyncChanged: (listener) => subscribe('workspaces:syncChanged', listener),
    learnConnections: (request) => invoke('workspaces:learnConnections', request),
    connectionsLearningStatus: (request) => invoke('workspaces:connectionsLearningStatus', request),
    onConnectionsLearning: (listener) => subscribe('workspaces:connectionsLearning', listener),
  },
  // A plan's change notes: read, and one note's status or verdict written —
  // both through the CLI's one reader and one writer, in main.
  plans: {
    notes: (request) => invoke('plan:notes', request),
    setNote: (request) => invoke('plan:setNote', request),
  },
  project: {
    list: () => invoke('project:list', {}),
    addressableRoots: () => invoke('project:addressableRoots', {}),
    add: (request) => invoke('project:add', request),
    open: (request) => invoke('project:open', request ?? {}),
    pickFolder: () => invoke('project:pickFolder', {}),
    remove: (request) => invoke('project:remove', request),
    reorderRoots: (request) => invoke('project:reorderRoots', request),
    listDir: (request) => invoke('project:listDir', request),
    listAllFiles: (request) => invoke('project:listAllFiles', request),
    listCommands: (request) => invoke('project:listCommands', request),
    searchContent: (request) => invoke('project:searchContent', request),
    readFile: (request) => invoke('project:readFile', request),
    writeFile: (request) => invoke('project:writeFile', request),
    resolveFileRef: (request) => invoke('project:resolveFileRef', request),
    renamePath: (request) => invoke('project:renamePath', request),
    deletePath: (request) => invoke('project:deletePath', request),
    createPath: (request) => invoke('project:createPath', request),
    revealPath: (request) => invoke('project:revealPath', request),
    active: () => invoke('project:active', {}),
    setActive: (request) => invoke('project:setActive', request),
    saveOpenFiles: (request) => invoke('project:saveOpenFiles', request),
    loadTabSet: (request) => invoke('project:loadTabSet', request),
    saveTabSet: (request) => invoke('project:saveTabSet', request),
    loadScopeTerminals: (request) => invoke('project:loadScopeTerminals', request),
    editorContextFlushed: () => invoke('project:editorContextFlushed', {}),
    onFlushEditorContext: (listener) => subscribe('project:flushEditorContext', listener),
    setActiveThread: (request) => invoke('project:setActiveThread', request),
    getThreadScope: () => invoke('project:getThreadScope', {}),
    setRootAccent: (request) => invoke('project:setRootAccent', request),
    provisionRoot: (request) => invoke('project:provisionRoot', request),
    onFileChanged: (listener) => subscribe('project:fileChanged', listener),
    onListChanged: (listener) => subscribe('project:listChanged', listener),
    onActiveChanged: (listener) => subscribe('project:activeChanged', listener),
    onThreadScopeChanged: (listener) => subscribe('project:threadScopeChanged', listener),
  },
  accounts: {
    list: () => invoke('accounts:list', {}),
    add: (request) => invoke('accounts:add', request),
    remove: (request) => invoke('accounts:remove', request),
    status: (request) => invoke('accounts:status', request),
    relogin: (request) => invoke('accounts:relogin', request),
    submitLoginCode: (request) => invoke('accounts:submitLoginCode', request),
    cancelLogin: () => invoke('accounts:cancelLogin', {}),
    setDefault: (request) => invoke('accounts:setDefault', request),
    assignProject: (request) => invoke('accounts:assignProject', request),
    activeForProject: (request) => invoke('accounts:activeForProject', request),
    onChanged: (listener) => subscribe('accounts:changed', listener),
    onLoginEvent: (listener) => subscribe('accounts:loginEvent', listener),
  },
  diagnostics: {
    // Fire-and-forget from the caller's point of view: an observation that
    // fails to be written changes nothing about the app being measured.
    record: (request) => invoke('diagnostics:record', request),
    report: () => invoke('diagnostics:report', {}),
    inFlight: () => inFlightChannels(),
  },
  updater: {
    check: () => invoke('updater:check', {}),
    whatsNew: () => invoke('updater:whatsNew', {}),
    releaseNotes: (request) => invoke('updater:releaseNotes', request),
    download: () => invoke('updater:download', {}),
    install: () => invoke('updater:install', {}),
    onStatus: (listener) => subscribe('updater:status', listener),
  },
  learn: {
    answerBasicDiscovery: (request) => invoke('learn:answerBasicDiscovery', request),
    answerChatLearn: (request) => invoke('learn:answerChatLearn', request),
    learnModule: (request) => invoke('learn:learnModule', request),
    learnFeature: (request) => invoke('learn:learnFeature', request),
    generateFeatureView: (request) => invoke('learn:generateFeatureView', request),
    status: () => invoke('learn:status', {}),
    log: () => invoke('learn:log', {}),
    pause: (request) => invoke('learn:pause', request),
    pauseRoot: (request) => invoke('learn:pauseRoot', request),
    cancel: (request) => invoke('learn:cancel', request),
    reset: (request) => invoke('learn:reset', request),
    narrate: (request) => invoke('learn:narrate', request),
    brainUsage: (request) => invoke('learn:brainUsage', request),
    onBasicDiscoveryAsk: (listener) => subscribe('learn:basicDiscoveryAsk', listener),
    onChatLearnAsk: (listener) => subscribe('learn:chatLearnAsk', listener),
    onProgress: (listener) => subscribe('learn:progress', listener),
    onPausedChanged: (listener) => subscribe('learn:pausedChanged', listener),
    onFeatureLearned: (listener) => subscribe('learn:featureLearned', listener),
    onFeatureViewed: (listener) => subscribe('learn:featureViewed', listener),
    onFeatureParts: (listener) => subscribe('learn:featureParts', listener),
    onFeatureReadProgress: (listener) => subscribe('learn:featureReadProgress', listener),
    onFeaturesDiscovered: (listener) => subscribe('learn:featuresDiscovered', listener),
    basicDiscoveryState: (request) => invoke('learn:basicDiscoveryState', request),
    onBasicDiscoveryChanged: (listener) => subscribe('learn:basicDiscoveryChanged', listener),
  },
  browser: {
    navigate: (request) => invoke('browser:navigate', request),
    back: (request) => invoke('browser:back', request),
    forward: (request) => invoke('browser:forward', request),
    reload: (request) => invoke('browser:reload', request),
    setInspect: (request) => invoke('browser:setInspect', request),
    capabilities: (request) => invoke('browser:capabilities', request),
    captureScreenshot: (request) => invoke('browser:captureScreenshot', request),
    tagRecent: (request) => invoke('browser:tagRecent', request),
    tagEntry: (request) => invoke('browser:tagEntry', request),
    bufferSlice: (request) => invoke('browser:bufferSlice', request),
    clearCaptures: (request) => invoke('browser:clearCaptures', request),
    onBufferUpdated: (listener) => subscribe('browser:bufferUpdated', listener),
    onTagPosted: (listener) => subscribe('browser:tagPosted', listener),
  },
  debug: {
    start: (request) => invoke('debug:start', request),
    stop: (request) => invoke('debug:stop', request),
    status: (request) => invoke('debug:status', request),
    interaction: (request) => invoke('debug:interaction', request),
  },
}

contextBridge.exposeInMainWorld('flow', flowApi)

// Authoritative OS platform (#1063) — preload runs in the Node context, so
// `process.platform` here is the real OS value. Surfaced so renderer reveal
// labels ("Reveal in Finder"/"Explorer") don't have to UA-sniff navigator.
contextBridge.exposeInMainWorld('flowPlatform', process.platform)

// The embedded browser's <webview> needs its guest preload as a file:// URL, and
// the renderer (served over http in dev) cannot compute it. MAIN knows the path
// in both dev and packaged builds and passes it on this preload's argv.
//
// NOT `__dirname`: this preload is SANDBOXED, and a sandboxed preload has no
// `__dirname` — reading it threw "ReferenceError: __dirname is not defined" on
// every load, which aborted the rest of this file. The guest URL was never
// exposed, so the embedded browser's inspect bridge had no preload, and nothing
// below this point ran either. Built manually (a sandboxed preload cannot
// `require('node:path'/'node:url')`): a leading slash + forward slashes make a
// valid file URL on Windows and POSIX.
const GUEST_PRELOAD_ARG = '--flow-guest-preload='
const guestPreloadFsPath = process.argv
  .find((arg) => arg.startsWith(GUEST_PRELOAD_ARG))
  ?.slice(GUEST_PRELOAD_ARG.length)
if (guestPreloadFsPath !== undefined && guestPreloadFsPath !== '') {
  const guestPreloadUrl = `file://${guestPreloadFsPath.startsWith('/') ? '' : '/'}${guestPreloadFsPath.replace(/\\/g, '/')}`
  contextBridge.exposeInMainWorld('flowBrowserGuestPreloadUrl', guestPreloadUrl)
}

// E2E-only: the Playwright fixture launches with FLOW_E2E=1, and main hands
// that to this preload as `--flow-e2e` on its argv (`e2eRendererArguments` in
// main/e2e-seams.ts — never in a packaged app). Read the argv, not
// `process.env`: a sandboxed preload's `process` is a polyfill, and the env is
// not this app's to rely on there. Surfaced at startup so test hooks (e.g. the
// board's __flowBoard handle) exist before app init runs. Inert for real users.
// (Literal kept in step with E2E_RENDERER_ARG — a sandboxed preload cannot
// import main's modules at runtime.)
const E2E_ARG = '--flow-e2e'
if (process.argv.includes(E2E_ARG)) {
  contextBridge.exposeInMainWorld('__FLOW_E2E__', true)
}
