// Git IPC registration — implements the contract's declared-but-unregistered
// git channels over a GitManager:
//
//   git:status  { rootId }                     → GitStatus | null
//   git:log     { rootId, limit? }             → GitCommit[]
//   git:diff    { rootId, filePath, commit? }  → GitDiff
//   git:changed { rootId }                     ← broadcast on .git changes
//
// rootId === absolute rootPath, the same addressing convention the project
// and flow domains use. Wired by the coordinator after the wave:
//
//   const gitManager = new GitManager(gitRootsProviderFrom(projectRegistry))
//   const disposeGit = registerGitChannels({ gitManager })
//
// Electron is required lazily inside registerGitChannels (same pattern as
// src/main/flow/flow-observer.ts) so GitManager stays importable from plain
// Node harnesses.

import { timed } from '../ipc/slow-handler'

import type {
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '../../shared/ipc-contract'
import { GitManager, GIT_CHANGED_EVENT, type GitChangedEvent } from './git-manager'
import {
  resolveThreadChangeReview,
  type ChangeReviewThreads,
} from './change-review'
import { verifyMerge } from './merge-verify'
import { buildMergeSummary, writeMergeSummaryDoc } from './merge-summary'
import { detectAgentClashes, detectClashForPath } from './agent-clash'
import { createWaveSideIdentityProvider } from '../review/wave-side-identity'
import {
  createAddressableRoots,
  type AddressableRoots,
} from '../project/addressable-roots'
import type {
  AgentClashInfo,
  GitConflictedFile,
  GitPublishBinding,
  GitPublishResult,
} from '../../shared/ipc-contract'

export {
  GitManager,
  GIT_CHANGED_EVENT,
  gitRootsProviderFrom,
  parsePorcelainV2Status,
  parseLogOutput,
  DEFAULT_LOG_LIMIT,
  MAX_LOG_LIMIT,
  type GitChangedEvent,
  type GitRootsProvider,
  type GitLogOptions,
  type ParsedPorcelainStatus,
} from './git-manager'

export interface GitChannelDeps {
  gitManager: GitManager
  /**
   * The address gate (see project/addressable-roots.ts) — the ONE answer to
   * "may the renderer address this root?", shared with the project file
   * channels and the file tree. Omitting it falls back to the manager's own
   * known roots, which is exactly the behaviour before thread worktrees
   * existed: a conflict inside a thread's checkout would be refused.
   */
  addressableRoots?: AddressableRoots
  /**
   * The Cursor-style change-review surface (#1906). When provided, registers the
   * `threads:changeReview` invoke channel and fans a `git:changed` broadcast out
   * to `threads:changeReviewUpdated` for the thread(s) whose worktree changed.
   * Omitting it leaves the channel unregistered (the review card stays empty) —
   * every other git channel is unaffected.
   */
  changeReview?: {
    /** The thread surface the read model reads (worktree root + touched paths). */
    threads: ChangeReviewThreads
    /** The thread ids whose worktree is `rootId` — the git:changed fan-out. */
    threadsForRoot(rootId: string): string[]
  }
  /**
   * Publishing a branch from the change review. When provided, registers the
   * `git:publish` invoke channel; omitting it leaves the channel unregistered
   * (the Push control simply has nothing to call), exactly as `changeReview`
   * above works — every other git channel is unaffected.
   *
   * The service owns the whole distance between the press and the remote — the
   * divergence check, the spawn of `worktree push`, and the refusal relay. This
   * layer only guards the root and announces the write.
   */
  publish?: {
    publish(rootId: string, binding?: GitPublishBinding): Promise<GitPublishResult>
  }
}

/**
 * Allow-list a renderer-supplied `rootId` before a MUTATING conflict/clash op
 * trusts it as the git cwd. The write channels take `rootId` straight from the
 * renderer; validating it stops an arbitrary path being used as a working
 * directory for a resolve/reconcile write.
 *
 * `addressableRoots` is the shared gate, and passing it is what lets a merge
 * conflict inside a THREAD'S worktree open the resolver instead of throwing —
 * a worktree is a checkout of a project, never a registered project itself.
 * Without it the gate is the manager's own known roots (the pre-worktree rule).
 *
 * Throws a clear error for an unaddressable root. Fail-OPEN (logged warning, no
 * throw) when the roots list itself can't be read — a provider hiccup must never
 * block a legitimate resolve.
 */
export function assertKnownRoot(
  gitManager: GitManager,
  rootId: string,
  addressableRoots?: AddressableRoots,
): void {
  const gate =
    addressableRoots ??
    createAddressableRoots({
      registeredRoots: () => gitManager.knownRootPaths().map((rootPath) => ({ rootPath })),
    })
  let addressable: boolean
  try {
    addressable = gate.isAddressable(rootId)
  } catch (error) {
    console.warn('[Git] Root allow-list unavailable; proceeding', { rootId, error })
    return
  }
  if (!addressable) {
    throw new Error(`[Git] Unknown repository root: ${rootId}`)
  }
}

/**
 * Open one agent clash (conflict-UX Phase 6): reconstruct its sides from the
 * per-task commits, synthesize a 3-way conflict, and overlay the wave (phase/
 * task) side identities from {@link createWaveSideIdentityProvider} so the
 * renderer opens it in the SAME per-hunk resolver a git conflict uses. Exported
 * for direct testing (the IPC layer is Electron-bound). Fail-soft: a
 * non-reconstructable path or any failure yields `null`; an oversize side yields
 * `{ oversize: true }`.
 */
export async function openAgentClash(
  gitManager: GitManager,
  rootId: string,
  filePath: string,
  detect: (
    root: string,
    file: string,
  ) => Promise<AgentClashInfo | null> = detectClashForPath,
): Promise<{ file: GitConflictedFile; clash: AgentClashInfo } | { oversize: true } | null> {
  try {
    const clash = await detect(rootId, filePath)
    if (!clash) return null
    const synthesized = await gitManager.synthesizeClashConflict(rootId, {
      filePath: clash.filePath,
      baseCommit: clash.base,
      sideACommit: clash.sideA.commit,
      sideBCommit: clash.sideB.commit,
      // Marker labels carry the phase ids (side A = phase A, side B = phase B).
      sideALabel: `phase-${clash.sideA.phase}`,
      sideBLabel: `phase-${clash.sideB.phase}`,
    })
    if ('oversize' in synthesized) return { oversize: true }
    // Overlay the phase/task identities so the IdentityChip renders "Phase N ·
    // task-M" for each side — the wave counterpart to git's branch/author identity.
    const provider = createWaveSideIdentityProvider(clash)
    const ctx = {
      rootPath: rootId,
      mergeState: { op: 'none' as const, unmergedPaths: [] },
      filePath: clash.filePath,
    }
    const file: GitConflictedFile = {
      ...synthesized,
      oursIdentity: await provider.identify('ours', ctx),
      theirsIdentity: await provider.identify('theirs', ctx),
    }
    return { file, clash }
  } catch (error) {
    console.warn('[Git] readAgentClash failed', { rootId, filePath, error })
    return null
  }
}

/**
 * Register the contract's git invoke channels and forward the manager's
 * change events as `git:changed` broadcasts. Starts the manager's .git
 * watchers. Returns a dispose function that unregisters the handlers and
 * disposes the manager.
 */
export function registerGitChannels(deps: GitChannelDeps): () => void {
  // Lazy require keeps this module importable from plain Node (harnesses);
  // typing stays exact via `typeof import('electron')`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ipcMain, BrowserWindow } = require('electron') as typeof import('electron')

  const { gitManager, addressableRoots, changeReview, publish } = deps
  gitManager.start()

  const registeredChannels: IpcInvokeChannel[] = []

  /** Contract-typed ipcMain.handle (same pattern as src/main/ipc/index.ts). */
  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registeredChannels.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

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

  handle('git:status', ({ rootId }) => gitManager.status(rootId))
  // `confirmed` is relayed, never defaulted here — the flag is set in the click
  // handler of the control a person used (forbidden-pattern #15).
  handle('git:renameBranch', ({ rootId, name, confirmed }) =>
    gitManager.renameBranch(rootId, name, confirmed === true ? { confirmed: true } : {}),
  )
  // #1335: forward `before`. GitManager.log has always taken a cursor (and
  // validates it as a revision); this channel dropped it, so the panel could
  // only ever see the first page and printed its size as an exact count.
  handle('git:log', ({ rootId, limit, before }) =>
    gitManager.log(rootId, before === undefined ? { limit } : { limit, before }),
  )
  handle('git:diff', ({ rootId, filePath, commit, staged, against }) =>
    staged && !commit
      ? gitManager.stagedDiff(rootId, filePath)
      : gitManager.diff(rootId, filePath, commit, against),
  )
  if (changeReview) {
    // The change-review read model (#1906). GitManager is the ChangeReviewGit
    // structurally (status + changeCounts); the injected `threads` slice answers
    // worktree-root + touched-paths. Fail-soft — resolve returns null for a
    // thread with no worktree, never throws.
    handle('threads:changeReview', ({ threadId }) =>
      resolveThreadChangeReview(gitManager, changeReview.threads, threadId),
    )
  }
  handle('git:listUntrackedDir', async ({ rootId, dirPath }) => ({
    files: await gitManager.listUntrackedInDir(rootId, dirPath),
  }))
  /**
   * Announce a git write the APP itself just made.
   *
   * A commit changes `.git` and nothing in the working tree, so none of the
   * signals the change review listens to fire for it — not the pending-edits
   * broadcast, not the file watcher. And a thread's own checkout is unwatched
   * outright (see the note on GIT_CHANGED_EVENT below). The result was a
   * Changes tab still headed "Uncommitted", still listing the files, over work
   * that had just been committed from the panel two columns away.
   *
   * The same reason the panel refreshes explicitly after its own stage (#507):
   * a write this process performed is not something to wait for a watcher to
   * notice.
   *
   * A PUBLISH IS THE SAME KIND OF WRITE, which is why this is no longer named
   * after commits. `worktree push` moves the upstream ref and nothing else, so
   * the review's `↑N` would go on counting commits the remote already has until
   * somebody closed the tab and opened it again.
   */
  const announceReviewChanged = (rootId: string): void => {
    if (!changeReview) return
    for (const threadId of changeReview.threadsForRoot(rootId)) {
      broadcast('threads:changeReviewUpdated', { threadId })
    }
  }

  handle('git:commit', async ({ rootId, message, filePaths }) => {
    const hash = await gitManager.commit(rootId, message, filePaths)
    announceReviewChanged(rootId)
    return { hash }
  })
  handle('git:stage', ({ rootId, filePaths }) => gitManager.stage(rootId, filePaths))
  handle('git:unstage', ({ rootId, filePaths }) => gitManager.unstage(rootId, filePaths))
  handle('git:discardFile', ({ rootId, filePath }) => gitManager.discardWorktreeChanges(rootId, filePath))
  handle('git:commitIndex', async ({ rootId, message }) => {
    const hash = await gitManager.commitIndex(rootId, message)
    announceReviewChanged(rootId)
    return { hash }
  })
  if (publish) {
    // Publish the branch under review. `rootId` arrives from the renderer and
    // is about to be used as the working directory of a process that talks to a
    // remote, so it goes through the SAME address gate the mutating conflict
    // channels use — an unaddressable root is refused, never spawned in.
    // `binding` IS RELAYED, NEVER SYNTHESIZED — the same rule the landing
    // channel states (forbidden-pattern #15). This handler is reachable from a
    // renderer and sits in front of a write that decides where real work lands,
    // so the one thing it must not do is turn an unconfirmed answer into a
    // confirmed one, or invent an answer where none was given. Absent stays
    // absent; the service refuses on its own side too.
    handle('git:publish', async ({ rootId, binding }) => {
      assertKnownRoot(gitManager, rootId, addressableRoots)
      const result =
        binding === undefined
          ? await publish.publish(rootId)
          : await publish.publish(rootId, binding)
      // Only a real publish moved anything. A refusal — unbound, diverged,
      // nothing — left the repository exactly as it was, and announcing those
      // would send every review watching this root off to re-read git for news
      // that does not exist (allowed-pattern #17).
      if (result.status === 'published') announceReviewChanged(rootId)
      return result
    })
  }
  handle('git:mergeState', ({ rootId }) => gitManager.getMergeState(rootId))
  handle('git:readConflicted', ({ rootId, filePath }) =>
    gitManager.readConflicted(rootId, filePath),
  )
  handle('git:resolveConflict', ({ rootId, filePath, resolution }) => {
    assertKnownRoot(gitManager, rootId, addressableRoots)
    return gitManager.resolveConflict(rootId, filePath, resolution)
  })
  handle('git:resolveConflictHunk', ({ rootId, filePath, hunkId, choice, order, content }) => {
    assertKnownRoot(gitManager, rootId, addressableRoots)
    return gitManager.resolveConflictHunk(rootId, filePath, hunkId, choice, order, content)
  })
  handle('git:completeMerge', async ({ rootId, message }) => {
    assertKnownRoot(gitManager, rootId, addressableRoots)
    return { hash: await gitManager.completeMerge(rootId, message) }
  })
  handle('git:abortMerge', ({ rootId }) => gitManager.abortMerge(rootId))
  handle('git:continueRebase', ({ rootId }) => {
    assertKnownRoot(gitManager, rootId, addressableRoots)
    return gitManager.continueRebase(rootId)
  })
  handle('git:abortRebase', ({ rootId }) => gitManager.abortRebase(rootId))
  // Post-merge verification (#66; Phase 7). rootId is an absolute rootPath;
  // verifyMerge reads that root's flow/.flowconfig + package.json and runs the
  // resolved commands. Fail-soft — no configured commands → { ok: true, ran: [] }.
  handle('git:verifyMerge', ({ rootId, changedFiles }) => verifyMerge(rootId, changedFiles ?? []))
  // Render + write a merge-resolution summary (#66; Phase 8). rootId is an
  // absolute rootPath; the doc lands under that root's flow/merges/. buildMerge-
  // Summary is pure/deterministic; the caller-supplied `stamp` names the file.
  handle('git:writeMergeSummary', async ({ rootId, input, stamp }) => {
    const { doc, commitBody } = buildMergeSummary(input)
    const path = await writeMergeSummaryDoc(rootId, input.branch, stamp, doc)
    return { path, commitBody }
  })
  // In-app merge/pull actions (minimal; Phase 9). A conflict outcome is not an
  // error — it lands in the normal conflicted working-tree state for the
  // existing resolver (readConflicted/resolveConflict/completeMerge above).
  handle('git:listBranches', ({ rootId }) => gitManager.listBranches(rootId))
  handle('git:mergeBranch', ({ rootId, ref }) => gitManager.mergeBranch(rootId, ref))
  handle('git:pull', ({ rootId }) => gitManager.pull(rootId))
  // Agent clashes (conflict-UX Phase 6): plan-flow parallel-agent same-file
  // clashes routed through the SAME per-hunk resolver git conflicts use, labeled
  // by phase/task instead of branch/author. Fail-soft — detection degrades to
  // [] / null, never throws.
  handle('git:listAgentClashes', ({ rootId }) => detectAgentClashes(rootId))
  handle('git:readAgentClash', ({ rootId, filePath }) =>
    openAgentClash(gitManager, rootId, filePath),
  )
  handle('git:reconcileAgentClash', ({ rootId, filePath, content }) => {
    assertKnownRoot(gitManager, rootId, addressableRoots)
    return gitManager.reconcileClash(rootId, filePath, content)
  })

  const onGitChanged = (event: GitChangedEvent): void => {
    broadcast('git:changed', event)
    // Fan the worktree change out to the thread(s) whose review watches it
    // (#1906). The GitManager already debounces its .git watcher, so this is not
    // a hot per-keystroke path; the renderer card still visibility-gates before
    // it refetches (allowed-patterns #17/#19).
    if (changeReview) {
      for (const threadId of changeReview.threadsForRoot(event.rootId)) {
        broadcast('threads:changeReviewUpdated', { threadId })
      }
    }
  }
  gitManager.on(GIT_CHANGED_EVENT, onGitChanged)

  return function disposeGitChannels(): void {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel)
    }
    registeredChannels.length = 0
    gitManager.off(GIT_CHANGED_EVENT, onGitChanged)
    gitManager.dispose().catch((error) => {
      console.error('[Git] Dispose failed:', error)
    })
  }
}
