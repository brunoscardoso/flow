// Agent IPC channels — registers the agent-facing invoke handlers and event
// broadcasts declared in the shared contract but left unregistered by the
// core IPC registry (src/main/ipc/index.ts).
//
// The coordinator wires this from bootstrapMainProcess():
//
//   const permissions = new PermissionBroker(db)
//   const agentManager = new AgentManager(threadStore, credentials, permissions)
//   const disposeAgentIpc = registerAgentChannels({ agentManager })
//
// threads:setModel is registered HERE (not in the core registry) so model
// changes persist via ThreadStore AND reach the live SDK session.

import { ipcMain, BrowserWindow } from 'electron'
import { timed } from '../ipc/slow-handler'

import type {
  CarryChoice,
  ThreadBindingRequest,
  ThreadBindingState,
  ThreadLandingPreview,
  ThreadLandingResult,
  ThreadWorktreeForgetResult,
  ThreadWorktreeInventory,
  ThreadWorktreeRenameResult,
  ThreadWorktreeReleaseResult,
  ThreadWorktreeResult,
  WorktreeBranchChoices,
  WorktreeRetargetResult,
  WorktreeStart,
  WorktreeUsage,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  PermissionRequest,
} from '../../shared/ipc-contract'
import {
  AgentManager,
  AGENT_STREAM_EVENT,
  PERMISSION_REQUEST_EVENT,
  DIALOG_REQUEST_EVENT,
  DIALOG_CANCEL_EVENT,
} from './agent-manager'
import { EditTracker, registerEditReviewChannels } from './edit-tracker'

export interface AgentIpcDependencies {
  agentManager: AgentManager
  /**
   * Offer the opening message of a conversation to autopilot.
   *
   * Returns the id of the message the CHAIN sent when it took over — the
   * person's raw text is then not sent on its own, because the chain's first
   * rung (`/discovery-plan <aim>`) carries it, and sending both would give the
   * thread two opening turns saying the same thing. `null` means autopilot did
   * not take it and the message should be sent the ordinary way.
   *
   * Optional, and absent means today's behaviour exactly: every message is sent
   * as an ordinary turn. This module knows nothing about chains — whether one
   * may start is `begin()`'s question, and it refuses with its own reasons.
   */
  maybeAutoChain?: (
    threadId: string,
    content: string,
    attachmentCount: number,
  ) => Promise<string | null>
  /**
   * Sign in to Flow. Present only when the build has a provider; the channels
   * that use it arrive with the surfaces (client-sign-in Phase 3).
   */
  signIn?: () => Promise<
    { ok: true; subject: string; displayName: string | null } | { ok: false; reason: string }
  >
  /** Whether this build can offer sign-in at all. */
  signInAvailable?: () => boolean
  /**
   * The thread-worktree service (thread-worktrees Phase 5). Absent → the
   * `threads:prepareWorktree` channel answers `disabled` for every thread,
   * which is the app exactly as it was before checkouts existed.
   */
  threadWorktree?: {
    prepare(
      threadId: string,
      options: {
        ask?: boolean
        carry?: CarryChoice
        requested?: boolean
        start?: WorktreeStart
      },
    ): Promise<ThreadWorktreeResult>
    branches(rootPath: string): Promise<WorktreeBranchChoices>
    retarget(threadId: string, start: WorktreeStart): Promise<WorktreeRetargetResult>
    renameBranch(
      threadId: string,
      name: string,
      options: { confirmed?: boolean },
    ): Promise<ThreadWorktreeRenameResult>
    branchAvailable(
      rootPath: string,
      branch: string,
    ): Promise<{ ok: boolean; detail: string | null }>
    reconcileBranch(threadId: string): Promise<string | null>
  }
  /**
   * The landing service (thread-worktrees Phase 7). Absent → the landing
   * channels answer "nothing to land", which is the app exactly as it was
   * before a thread could own a checkout.
   */
  threadLanding?: {
    preview(threadId: string): Promise<ThreadLandingPreview>
    land(
      threadId: string,
      request: {
        mode: 'merge' | 'pull-request'
        message?: string
        confirmed?: boolean
        pruneAfter?: boolean
      },
    ): Promise<ThreadLandingResult>
    prune(
      threadId: string,
      options: {
        confirmed?: boolean
        allowUnlanded?: boolean
        abandoned?: {
          projectRoot: string
          worktreePath: string
          branch: string | null
          base?: string | null
        }
      },
    ): Promise<ThreadWorktreeReleaseResult>
    forget(
      threadId: string,
      options: { confirmed?: boolean },
    ): Promise<ThreadWorktreeForgetResult>
  }
  /**
   * Where a thread publishes (thread_remote_binding Phase 5). Absent → both
   * binding channels answer "nobody has decided", which is the app exactly as
   * it was before a thread could be bound to anything.
   */
  threadBinding?: {
    read(threadId: string): Promise<ThreadBindingState>
    bind(
      request: ThreadBindingRequest,
    ): Promise<{ ok: true; state: ThreadBindingState } | { ok: false; detail: string }>
  }
  /** How much disk one project's thread checkouts are holding (Phase 7). */
  worktreeUsage?: (rootPath: string) => Promise<WorktreeUsage>
  /**
   * Every thread worktree one project is holding — the management list.
   * Absent → the list answers "none", which is the app before it existed.
   */
  worktreeInventory?: (rootPath: string) => Promise<ThreadWorktreeInventory>
  /**
   * Where a copy that no thread claims actually sits, or null.
   *
   * MAIN-SIDE ONLY. The path it returns never crosses IPC — it goes straight
   * into the one thing that removes a directory. Absent → releasing an
   * abandoned copy is simply not offered, which is the app before the
   * management list existed.
   */
  abandonedCheckoutFor?: (
    rootPath: string,
    threadId: string,
  ) => Promise<{ worktreePath: string; branch: string | null } | null>
}

/**
 * Register agent invoke handlers and wire stream/permission broadcasts.
 * Also owns the inline-diff-review wiring (Phase 8): constructs the
 * EditTracker, attaches it to the AgentManager's interception path, and
 * registers the editor:pendingChanges / editor:resolveHunk channels.
 * Returns a dispose function that unregisters everything.
 */
export function registerAgentChannels(deps: AgentIpcDependencies): () => void {
  const {
    agentManager,
    maybeAutoChain,
    threadWorktree,
    threadLanding,
    threadBinding,
    worktreeUsage,
    worktreeInventory,
  } = deps

  const editTracker = new EditTracker()
  agentManager.attachEditTracker(editTracker)
  const disposeEditReview = registerEditReviewChannels({ tracker: editTracker })

  const registeredChannels: IpcInvokeChannel[] = []

  /** Contract-typed ipcMain.handle — same pattern as the core registry. */
  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registeredChannels.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  handle('threads:sendMessage', async ({ threadId, content, attachments, skipContextGate }) => {
    // AUTOPILOT GETS FIRST REFUSAL on the opening message. This is the trigger
    // the feature never had: the project key GATED starting a chain and nothing
    // ever asked to start one, so turning autopilot on granted permission for a
    // request nobody made.
    //
    // A refusal here is not an error and is not reported — autopilot off, a
    // thread already being driven, a message that is not an opening one. It
    // simply means the message is sent the ordinary way, which is what happened
    // before this existed.
    if (maybeAutoChain !== undefined) {
      try {
        const chained = await maybeAutoChain(threadId, content, attachments?.length ?? 0)
        // A REAL ID, of the message the chain actually sent into this thread —
        // not a placeholder. Nothing reads it today, and that is not a reason
        // to answer a question wrongly.
        if (chained !== null) return { messageId: chained }
      } catch (error) {
        // A chain that could not start must never cost somebody their message.
        console.warn('[agent] autopilot did not take the message', error)
      }
    }
    // Only an explicit `true` skips the gate: anything else is the default.
    return agentManager.sendMessage(threadId, content, attachments, {
      skipContextGate: skipContextGate === true,
    })
  })
  // A first message held for its project's basic discovery: what a pane that
  // opens mid-wait draws, and the failure card's Try again.
  handle('threads:learningFirst', ({ threadId }) => agentManager.learningFirstState(threadId))
  handle('threads:retryLearningFirst', async ({ threadId }) => {
    await agentManager.retryLearningFirst(threadId)
  })
  /**
   * Give a thread a worktree of its own (thread-worktrees Phase 5).
   *
   * TWO-STEP, and the renderer decides nothing: called without a `carry` this
   * answers `needs-choice` when the project has uncommitted work, so the one
   * surface that can put a question on screen asks it and calls back with the
   * answer. Every rule — the per-project switch, the refusals, what happens to
   * uncommitted work — stays on this side (allowed-pattern #14).
   */
  handle(
    'threads:prepareWorktree',
    async ({ threadId, carry, requested, start, branch, worktree, worktreeName }) => {
      if (threadWorktree === undefined) return { status: 'disabled' as const }
      return threadWorktree.prepare(threadId, {
        // THE WORKTREE HALF, relayed like every other answer. Absent means
        // `own`, which is what this channel meant for its whole life.
        ...(worktree === undefined ? {} : { worktree }),
        // A `carry` IS the answer to the question; without one, ask it.
        ask: carry === undefined,
        ...(carry === undefined ? {} : { carry }),
        ...(requested === true ? { requested: true } : {}),
        // ABSENT IS THE DEFAULT, and the default is the branch the project is on.
        // The send path sends nothing here on purpose: nobody is on screen to
        // choose, and the right answer without a chooser is where the person is.
        ...(start === undefined ? {} : { start }),
        // A NAME, NOT A STARTING POINT. Relayed, never invented: only the surface
        // that asked a person has one, and the absence of one is the path every
        // caller took before the Create-thread modal existed.
        ...(branch === undefined ? {} : { branch }),
        // THE FOLDER'S NAME, relayed like the branch's and never invented: only
        // a surface that asked a person has one.
        ...(worktreeName === undefined ? {} : { worktreeName }),
      })
    },
  )
  /**
   * The branches a worktree could start from — READ-ONLY (the base fix).
   *
   * The picker needs more than a list of names: it needs to know which branches
   * the project already has open, because those cannot be taken by a worktree,
   * only branched from. That fact comes from git's own worktree listing.
   */
  handle('threads:worktreeBranches', async ({ rootPath }) => {
    if (threadWorktree === undefined) return { current: null, branches: [] }
    return threadWorktree.branches(rootPath)
  })
  /**
   * Change where an existing worktree starts.
   *
   * NOTHING IS DISCARDED TO HONOUR A RE-PICK. A worktree holding work is never
   * moved — only the branch its work lands on changes, and the answer says so.
   * The judgement lives in the service, not here (allowed-pattern #14).
   */
  handle('threads:retargetWorktree', async ({ threadId, start }) => {
    if (threadWorktree === undefined) {
      return { status: 'unavailable' as const, detail: 'This thread has no branch of its own.' }
    }
    return threadWorktree.retarget(threadId, start)
  })
  /**
   * What landing this thread's work would involve — READ-ONLY (Phase 7).
   *
   * Opening the landing surface must never stage, commit or move anything, so
   * this reports and nothing else. It also carries the message a person is
   * about to be shown for editing: a silent commit was rejected by name.
   */
  handle('threads:landingPreview', async ({ threadId }) => {
    if (threadLanding === undefined) {
      return {
        threadId,
        message: '',
        repos: [],
        blockedReason:
          'This thread works in the project’s own files, so there is nothing separate to land.',
        canOpenPullRequest: false,
        binding: null,
      }
    }
    // THE RECORD FOLLOWS GIT, at the one moment something is about to read
    // this checkout anyway. Every surface downstream of the preview — the
    // branch line, the landing block, the titlebar's hover — reads the record,
    // so a checkout re-pointed by hand would otherwise be described by the name
    // it was cut as. One `git branch --show-current`; it moves nothing.
    await threadWorktree?.reconcileBranch(threadId)
    return threadLanding.preview(threadId)
  })
  /**
   * Where this thread publishes — READ-ONLY (thread_remote_binding Phase 5).
   *
   * It answers from the store's mirror and reconciles against git when the two
   * disagree, which is a write to the MIRROR and never to git. Reading binds
   * nothing: an unbound thread comes back unbound, and it comes back with no
   * proposal attached — the proposal costs a ladder of git reads and is built
   * at the moment a push refuses, not every time a panel opens.
   */
  handle('threads:worktreeBinding', async ({ threadId }) => {
    if (threadBinding === undefined) {
      return {
        bound: false,
        remote: null,
        remoteBranch: null,
        prBase: null,
        previouslyPushedAs: null,
        suggestion: null,
      }
    }
    return threadBinding.read(threadId)
  })
  /**
   * Decide where this thread publishes.
   *
   * THE RENDERER'S `confirmed` IS RELAYED, NEVER SYNTHESIZED — the same rule as
   * the landing and rename channels, for the same reason: this writes the
   * config that decides where real work lands, and a default that turned an
   * unconfirmed call into a confirmed one is the whole of forbidden-pattern
   * #15. The service refuses on its own side too.
   */
  handle('threads:bindWorktree', async (request) => {
    if (threadBinding === undefined) {
      return { ok: false as const, detail: 'This thread has no branch of its own.' }
    }
    return threadBinding.bind(request)
  })
  /**
   * Land the thread's work.
   *
   * THE RENDERER'S `confirmed` IS RELAYED, NEVER SYNTHESIZED. This is the
   * channel behind a merge, a push and a directory deletion, and the one thing
   * that must not happen here is a default that turns an unconfirmed call into
   * a confirmed one (forbidden-pattern #15). The service refuses on its own
   * side too — two gates, because this one is reachable from a renderer.
   */
  handle(
    'threads:landWorktree',
    async ({ threadId, mode, message, confirmed, pruneAfter, projectRoot }) => {
      if (threadLanding === undefined) return { threadId, rows: [], complete: false }
      return threadLanding.land(threadId, {
        mode,
        ...(message === undefined ? {} : { message }),
        ...(confirmed === true ? { confirmed: true } : {}),
        ...(pruneAfter === true ? { pruneAfter: true } : {}),
        // Relayed, never invented: it can only narrow what this lands, and a
        // renderer that names no repository still means "all of mine".
        ...(projectRoot === undefined ? {} : { projectRoot }),
      })
    },
  )
  /**
   * Release a thread's checkout, keeping its branch (Phase 7).
   *
   * `abandonedIn` is the management list's case: a copy on disk whose thread
   * was deleted. The details it needs come from the SAME inventory read the
   * list was built from, so this handler never re-derives where a checkout is
   * — and there is still exactly one thing that removes a directory.
   */
  handle(
    'threads:releaseWorktree',
    async ({ threadId, confirmed, allowUnlanded, abandonedIn }) => {
      if (threadLanding === undefined) {
        return { status: 'absent' as const, detail: 'This thread has no branch of its own.' }
      }
      const abandoned =
        abandonedIn === undefined ? undefined : await abandonedCheckout(abandonedIn, threadId)
      if (abandonedIn !== undefined && abandoned === undefined) {
        return {
          status: 'absent' as const,
          detail: 'Those conversation files are no longer here.',
        }
      }
      return threadLanding.prune(threadId, {
        ...(confirmed === true ? { confirmed: true } : {}),
        ...(allowUnlanded === true ? { allowUnlanded: true } : {}),
        ...(abandoned === undefined ? {} : { abandoned }),
      })
    },
  )
  /**
   * Stop a thread pointing at a copy that is no longer on disk.
   *
   * REFUSES WHEN THE COPY IS STILL THERE — the judgement is the service's, not
   * this handler's (allowed-pattern #14).
   */
  handle('threads:forgetWorktree', async ({ threadId, confirmed }) => {
    if (threadLanding === undefined) {
      return { status: 'absent' as const, detail: 'This thread has no branch of its own.' }
    }
    return threadLanding.forget(threadId, {
      ...(confirmed === true ? { confirmed: true } : {}),
    })
  })
  /**
   * Rename the branch a thread's worktree works on.
   *
   * THE RENDERER'S `confirmed` IS RELAYED, NEVER SYNTHESIZED — same rule as the
   * landing channel, for the same reason: this moves a ref, and a default that
   * turned an unconfirmed call into a confirmed one is the whole of
   * forbidden-pattern #15.
   */
  handle('threads:renameWorktreeBranch', async ({ threadId, name, confirmed }) => {
    if (threadWorktree === undefined) {
      return { status: 'refused' as const, detail: 'This thread has no branch of its own.' }
    }
    return threadWorktree.renameBranch(threadId, name, {
      ...(confirmed === true ? { confirmed: true } : {}),
    })
  })
  /**
   * Could a worktree here take this name? READ-ONLY, and creates nothing.
   *
   * THE REFUSAL HAS TO REACH THE FIELD, not the thread that would otherwise
   * already exist. The modal asks before it creates anything, so a name that
   * cannot be used costs a person a sentence rather than an orphan thread with
   * no worktree (allowed-pattern #21).
   *
   * It is not a reservation and does not pretend to be one: a name free now can
   * be taken a second later, and the cut refuses on its own side too.
   */
  handle('threads:branchAvailable', async ({ rootPath, branch }) => {
    if (threadWorktree === undefined) return { ok: true as const, detail: null }
    return threadWorktree.branchAvailable(rootPath, branch)
  })
  /** Every thread worktree one project is holding — READ-ONLY. */
  handle('threads:worktreeInventory', async ({ rootPath }) => {
    if (worktreeInventory === undefined) {
      return {
        rootPath,
        usage: { total: 0, cap: 0, unlanded: 0, atCap: false },
        entries: [],
        unreadable: false,
      }
    }
    return worktreeInventory(rootPath)
  })

  /**
   * The details a release needs for a copy no thread claims.
   *
   * Resolved from the SAME listing the inventory is built from, and resolved
   * HERE rather than sent by the renderer: a path is not something a surface
   * hands back to main, because a surface that can name a directory is a
   * surface that can be persuaded to name a different one.
   */
  async function abandonedCheckout(
    rootPath: string,
    threadId: string,
  ): Promise<
    { projectRoot: string; worktreePath: string; branch: string | null } | undefined
  > {
    if (deps.abandonedCheckoutFor === undefined) return undefined
    const found = await deps.abandonedCheckoutFor(rootPath, threadId)
    if (found === null) return undefined
    return { projectRoot: rootPath, worktreePath: found.worktreePath, branch: found.branch }
  }
  /** The visible disk total (Phase 7) — silent growth is the named failure mode. */
  handle('threads:worktreeUsage', async ({ rootPath }) => {
    if (worktreeUsage === undefined) {
      return { total: 0, cap: 0, unlanded: 0, atCap: false }
    }
    return worktreeUsage(rootPath)
  })
  handle('threads:interrupt', ({ threadId }) => agentManager.interrupt(threadId))
  // Live background work per thread, for a surface mounting mid-run. Served
  // from the manager's in-memory tracker: this is per-CLI-process state that is
  // deliberately never persisted, so there is nothing in the store to read, and
  // a surface that opened after the last membership change would otherwise sit
  // blank for the whole run.
  handle('threads:backgroundTasks', () => agentManager.listBackgroundTasks())
  handle('threads:respondPermission', ({ requestId, verdict }) => {
    agentManager.respondPermission(requestId, verdict)
  })
  // #949: the renderer re-syncs a thread's parked asks on thread load so a
  // pending permission card can be rebuilt (thread switch, background arrival,
  // renderer reload) — the broker keeps the promise parked either way.
  handle('threads:pendingPermissions', ({ threadId }) =>
    agentManager.pendingPermissions(threadId),
  )
  handle('threads:respondDialog', ({ requestId, answers }) => {
    // A miss means the dialog was disposed (session crashed/ended) before the
    // user submitted — throw so the renderer's respondDialog REJECTS and the
    // QuestionCard rolls back instead of falsely confirming "Answered" (#290).
    if (!agentManager.respondDialog(requestId, answers)) {
      throw new Error('the agent session is no longer active')
    }
  })

  handle('threads:setModel', ({ threadId, selection }) =>
    agentManager.setModel(threadId, selection),
  )

  handle('threads:contextUsage', ({ threadId }) => agentManager.contextUsage(threadId))

  const onStream = (event: IpcEventPayload<'threads:stream'>): void => {
    broadcast('threads:stream', event)
  }
  const onPermissionRequest = (request: PermissionRequest): void => {
    broadcast('threads:permissionRequest', request)
  }
  const onDialogRequest = (request: IpcEventPayload<'threads:dialogRequest'>): void => {
    broadcast('threads:dialogRequest', request)
  }
  const onDialogCancel = (cancel: IpcEventPayload<'threads:dialogCancel'>): void => {
    broadcast('threads:dialogCancel', cancel)
  }
  agentManager.on(AGENT_STREAM_EVENT, onStream)
  agentManager.on(PERMISSION_REQUEST_EVENT, onPermissionRequest)
  agentManager.on(DIALOG_REQUEST_EVENT, onDialogRequest)
  agentManager.on(DIALOG_CANCEL_EVENT, onDialogCancel)

  return function disposeAgentChannels(): void {
    disposeEditReview()
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel)
    }
    registeredChannels.length = 0
    agentManager.off(AGENT_STREAM_EVENT, onStream)
    agentManager.off(PERMISSION_REQUEST_EVENT, onPermissionRequest)
    agentManager.off(DIALOG_REQUEST_EVENT, onDialogRequest)
    agentManager.off(DIALOG_CANCEL_EVENT, onDialogCancel)
  }
}

/** Send a contract event to every open window (payload typed by channel). */
function broadcast<C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventPayload<C>,
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}
