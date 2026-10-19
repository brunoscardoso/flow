/**
 * Resolve-with-AI orchestration (#66; conflict-UX v2, Phase 4) — the stateful core
 * loop of the feature. It listens for the decoupled `flow:resolve-conflict` event
 * (fired by the CodeLens / git panel), gathers the conflicted files across all
 * project roots, sends a STRUCTURED resolution prompt to the ACTIVE thread (no
 * session picker), and when that turn completes, parses the agent's fenced
 * proposals and — v2 reversal — renders them into a HUMAN-IN-THE-LOOP review card
 * (via the decoupled `flow:conflict-review` event) instead of auto-applying.
 * NOTHING is written to disk until the user Accepts a row; an accept splices that
 * one hunk through the SAME per-hunk path a human click uses (resolveHunkAndRecord,
 * inspectable — never `auto:true`). A reject leaves the hunk untouched.
 *
 * Fail-safe throughout: any failure surfaces a `flow:notify` toast and applies
 * NOTHING — a parse miss, no proposals, or a git error all resolve toward "shown
 * for review" / "nothing to resolve", never a silent bad merge. The thread /
 * composer / card are reached through events + the preload bridge, so this file
 * owns no DOM of its own.
 */
import type { FlowNotification, MergeSummaryConflict } from '../../shared/ipc-contract'
import { RESOLVE_CONFLICT_EVENT } from './conflict-codelens'
import {
  CONFLICT_RESOLVE_STATE_EVENT,
  CONFLICT_RESOLVE_STOP_EVENT,
  type ConflictResolveStateDetail,
} from './conflict-resolve-state'
import {
  recordMergeResolutionConflicts,
  recordMergeResolutionVerify,
} from './merge-resolution-record'
import { parseConflicts } from './conflict-parser'
import { forceRisky, type FinalVerdict } from '../../shared/conflict-triage'
import { buildConflictResolutionPrompt, type ConflictBlockInfo, type ConflictFile } from './conflict-prompt'
import { parseProposals, type ConflictProposal } from './conflict-proposal'
import { resolveHunkAndRecord } from './conflict-hunk-actions'
import {
  buildConflictReviewItems,
  type ConflictFileReview,
  type ConflictReviewItem,
} from './conflict-review-inputs'
import type { SideIdentity } from '../../shared/side-identity'
import type { ConflictReviewDecision } from '../threads/conflict-review-card-model'
import {
  CONFLICT_REVIEW_EVENT,
  type ConflictReviewEventDetail,
} from '../threads/conflict-review-event'

/** A conflicted file with its markers + parsed blocks, retained across the turn
 *  so the completion handler can classify + apply without re-reading git. */
interface EnrichedConflict {
  rootPath: string
  filePath: string
  /** The working-tree text still carrying conflict markers. */
  markered: string
  blocks: ConflictBlockInfo[]
  /** Concrete identity of the ours side (stage 2), when the git bridge resolved
   *  it — labels the review row truthfully; absent falls back to the marker label. */
  oursIdentity?: SideIdentity
  /** Concrete identity of the theirs side (stage 3), when known. */
  theirsIdentity?: SideIdentity
}

/** The resolution turn we are waiting on: its thread + the files it covers. */
interface PendingResolution {
  threadId: string
  files: EnrichedConflict[]
  /** The user message id returned by sendMessage — set once the prompt is
   *  accepted. Our assistant reply is the message that comes AFTER it, so a
   *  `done` from a prior/interrupted turn (whose reply predates it) is ignored (#573). */
  userMessageId: string | null
}

/** A resolution that was actually applied to disk — the input to verify. */
interface AppliedTarget {
  rootPath: string
  filePath: string
}

/** One user-accepted resolution: its target file + the proposal behind it, kept
 *  so the merge-completion summary can be parked from the ACCEPTED set only. */
interface AcceptedResolution {
  rootId: string
  filePath: string
  proposal: ConflictProposal
}

/** The `git:verifyMerge` result shape (mirrors the IPC contract response). */
interface MergeVerifyResult {
  ok: boolean
  ran: string[]
  firstFailure?: { name: string; output: string }
  culprit?: string | null
}

/** Trailing characters of a failing step's output embedded in the repair prompt. */
const REPAIR_OUTPUT_LIMIT = 1500

/**
 * Upper bound on how long we wait for a repair turn's stream `done` before
 * giving up (M2). A repair turn can legitimately take a while (the agent reads,
 * edits, and may run tools), so this is deliberately generous — but finite, so a
 * stuck/never-completing turn can never hang verify/apply or leak the stream
 * subscription. On timeout we treat the turn as NOT completed (not-repaired
 * handling → escalation), never fabricating success.
 */
const REPAIR_TURN_TIMEOUT_MS = 120000

/** Max concurrent conflicted-file enrichments during the initial gather (M5). */
const GATHER_READ_CONCURRENCY = 6

/**
 * Map `items` through `fn` with at most `limit` promises in flight at once,
 * preserving result-by-index ordering. A small fixed-size worker pool drains a
 * shared cursor, so a large conflict set fans out at a bounded, predictable width
 * instead of all-at-once (or one-at-a-time). `fn` owns its own failure handling
 * (here readEnriched already resolves to null on error, so this never rejects).
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  }
  const workers: Promise<void>[] = []
  for (let w = 0; w < width; w += 1) workers.push(worker())
  await Promise.all(workers)
  return results
}

/** Announce where the resolve run is, so the git panel's control can follow
 *  it (#1134). The phase→control mapping lives in conflict-resolve-state. */
function emitConflictResolveState(detail: ConflictResolveStateDetail): void {
  document.dispatchEvent(
    new CustomEvent<ConflictResolveStateDetail>(CONFLICT_RESOLVE_STATE_EVENT, { detail }),
  )
}

export function initConflictResolve(): void {
  const api = window.flow
  if (!api) return

  // Track the active thread so we resolve into it directly (no picker).
  let activeThreadId: string | null = null
  document.addEventListener('flow:active-thread', (event) => {
    activeThreadId = (event as CustomEvent<{ threadId: string | null }>).detail?.threadId ?? null
  })

  // The single in-flight resolution, awaiting its turn's `done`. Latest wins.
  let pending: PendingResolution | null = null

  // One persistent stream subscription drives the assistant-complete → apply
  // step. A `done` for the pending thread is only OURS when it belongs to the
  // reply to our resolution prompt — a turn already running (or interrupted by
  // our send, #555) also emits `done` for this thread, and acting on it would
  // parse the wrong message and silently no-op (#573). We correlate by ordering:
  // our reply is the assistant message AFTER our user message.
  api.threads.onStream((event) => {
    if (event.kind !== 'done' || !pending || event.threadId !== pending.threadId) return
    const resolution = pending
    // Prompt not yet accepted → this `done` is necessarily a prior turn's.
    if (resolution.userMessageId === null) return
    const userMessageId = resolution.userMessageId
    const doneMessageId = event.messageId
    void isReplyToPrompt(resolution.threadId, userMessageId, doneMessageId).then((mine) => {
      // Re-check identity: a later resolution may have replaced `pending`.
      if (!mine || pending !== resolution) return
      pending = null
      // The turn is over — the review card takes it from here (#1134).
      emitConflictResolveState({ phase: 'idle' })
      void applyAgentProposals(resolution).catch((error: unknown) => {
        console.error('flow: applying conflict proposals failed', error)
        notify('error', 'Resolve with AI failed', 'Could not apply the resolution. Nothing was changed.')
      })
    })
  })

  document.addEventListener(RESOLVE_CONFLICT_EVENT, () => {
    void handleResolve()
      .catch((error: unknown) => {
        console.error('flow: resolve-conflict failed', error)
        notify('error', 'Resolve with AI failed', 'Could not start conflict resolution.')
      })
      // #1134: every failure path lands back on idle. A button stuck on
      // "Resolving…" after a crash is a worse lie than no indicator at all.
      .finally(() => {
        if (pending === null) emitConflictResolveState({ phase: 'idle' })
      })
  })

  // #1134: Stop, from the same place the run was started. The interrupt is the
  // composer's own verb; disarming `pending` first means a `done` arriving from
  // the interrupted turn is ignored rather than parsed as a resolution.
  document.addEventListener(CONFLICT_RESOLVE_STOP_EVENT, () => {
    const resolution = pending
    pending = null
    emitConflictResolveState({ phase: 'idle' })
    if (resolution === null) return
    void api.threads.interrupt({ threadId: resolution.threadId }).catch((error: unknown) => {
      console.error('flow: interrupting conflict resolution failed', error)
    })
  })

  /**
   * Ensure a chat session exists to resolve into. If one is already active, return
   * it. Otherwise CREATE one for the conflicted projects and open it, resolving
   * with its id once the resulting `flow:active-thread` signal lands (or after 8s
   * with the id anyway — the prompt is addressed by id, not by what is on screen).
   *
   * NOT `flow:new-thread`. That is the person's "+" — since the new-thread page
   * replaced the dialog (2026-09-04) it opens a page and waits for them to write
   * a first message and press Create. Fired from here it put an empty page in
   * front of the user and, eight seconds later, failed the resolve with "Could
   * not open a session" — the request this function exists to answer had
   * already said what the thread is for.
   */
  async function ensureResolveSession(roots: readonly string[]): Promise<string | null> {
    if (activeThreadId) return activeThreadId
    const [primary, ...additional] = roots
    if (primary === undefined) return null
    let created: { id: string }
    try {
      created = await api.threads.create({
        projectRoot: primary,
        title: 'Resolve merge conflicts',
        ...(additional.length > 0 ? { additionalRoots: additional } : {}),
      })
    } catch (error) {
      console.error('flow: could not create a thread to resolve in', error)
      return null
    }
    return new Promise((resolvePromise) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        document.removeEventListener('flow:active-thread', onActive)
        clearTimeout(timer)
        resolvePromise(created.id)
      }
      const onActive = (event: Event): void => {
        const id = (event as CustomEvent<{ threadId: string | null }>).detail?.threadId ?? null
        if (id === created.id) finish()
      }
      const timer = setTimeout(finish, 8000)
      document.addEventListener('flow:active-thread', onActive)
      document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: created.id } }))
    })
  }

  async function handleResolve(): Promise<void> {
    // #1134: the gather reads every conflicted file across every root — long
    // enough that an unchanged button reads as "the click didn't register".
    emitConflictResolveState({ phase: 'gathering' })
    const { files, projectCount } = await gatherConflictedFiles()
    if (files.length === 0) {
      notify('info', 'No merge conflicts', 'No conflicted files were found.')
      return
    }

    // No chat session open? Create one automatically (the sidebar's new-thread
    // flow, which reveals + selects it) and resolve into it — the user shouldn't
    // have to hand-open a session first.
    let threadId = activeThreadId
    if (!threadId) {
      threadId = await ensureResolveSession([...new Set(files.map((file) => file.rootPath))])
      if (!threadId) {
        notify('error', 'Resolve with AI', 'Could not open a session to resolve in.')
        return
      }
    }

    const promptFiles: ConflictFile[] = files.map((file) => ({
      rootPath: file.rootPath,
      filePath: file.filePath,
      blocks: file.blocks,
    }))
    const prompt = buildConflictResolutionPrompt(promptFiles, {
      multiRoot: projectCount > 1,
    })
    if (!prompt) {
      notify('info', 'No merge conflicts', 'No conflicted files were found.')
      return
    }

    // Arm the completion handler BEFORE sending, so the turn's `done` is caught.
    // userMessageId is filled once send resolves; until then the handler ignores
    // any `done` (it can only belong to a prior turn) — see the onStream comment.
    const resolution: PendingResolution = { threadId, files, userMessageId: null }
    pending = resolution
    emitConflictResolveState({ phase: 'resolving', threadId })
    try {
      const { messageId } = await api.threads.sendMessage({ threadId, content: prompt })
      // Only stamp if we're still the active resolution (not superseded).
      if (pending === resolution) resolution.userMessageId = messageId
    } catch (error) {
      if (pending === resolution) {
        pending = null // never landed — disarm
        emitConflictResolveState({ phase: 'idle' })
      }
      console.error('flow: failed to send resolution prompt', error)
      notify('error', 'Resolve with AI failed', 'Could not send the resolution prompt to the session.')
    }
  }

  /**
   * Whether `assistantMessageId` (a completed turn's reply) is the reply to OUR
   * resolution prompt — i.e. it comes strictly AFTER `userMessageId` in the
   * thread. A prior/interrupted turn's reply predates our user message, so this
   * returns false for it (#573). Fail-safe: an unreadable thread → false (ignore).
   */
  async function isReplyToPrompt(
    threadId: string,
    userMessageId: string,
    assistantMessageId: string,
  ): Promise<boolean> {
    try {
      const messages = await api.messages.list({ threadId })
      const userIndex = messages.findIndex((message) => message.id === userMessageId)
      const assistantIndex = messages.findIndex((message) => message.id === assistantMessageId)
      return userIndex !== -1 && assistantIndex > userIndex
    } catch (error) {
      console.error('flow: failed to correlate resolution reply', { threadId, error })
      return false
    }
  }

  /**
   * The completion step (v2 reversal): parse the assistant's proposals and RENDER
   * them into the in-thread review card — applying NOTHING. Each row's Accept
   * splices exactly that hunk via the shared per-hunk path (inspectable, never
   * auto); Reject leaves it untouched. A verify pass runs ONCE, after the review
   * is fully decided, over only the ACCEPTED files. Fail-safe — an empty/malformed
   * reply shows nothing and changes nothing.
   */
  async function applyAgentProposals(resolution: PendingResolution): Promise<void> {
    const { threadId, files } = resolution

    const output = await latestAssistantText(threadId)
    const proposals = output ? parseProposals(output) : []
    if (proposals.length === 0) {
      // Fail-safe: no usable proposals → nothing to review, nothing applied.
      await postNote(
        threadId,
        'Resolve with AI: no resolvable proposals — nothing to resolve. Re-run ✨ Resolve with AI to try again.',
      )
      notify(
        'warn',
        'Resolve with AI',
        'No resolvable proposals — nothing to resolve. Re-run “Resolve with AI” to try again.',
      )
      return
    }

    const reviewFiles = buildReviewFiles(files, proposals)
    const items = buildConflictReviewItems(reviewFiles)
    if (items.length === 0) {
      await postNote(
        threadId,
        'Resolve with AI: no resolvable proposals — nothing to resolve. Re-run ✨ Resolve with AI to try again.',
      )
      notify(
        'warn',
        'Resolve with AI',
        'No resolvable proposals — nothing to resolve. Re-run “Resolve with AI” to try again.',
      )
      return
    }

    // Hand the review to the card. Every apply happens through the callbacks
    // below — the card owns the DOM, this owns the git-bridge writes + verify.
    const itemByRow = new Map<string, ConflictReviewItem>()
    for (const item of items) itemByRow.set(item.rowId, item)

    // Review-completion bookkeeping. `decided` is the set of rowIds resolved so
    // far (accept OR reject); the review finalizes — a SINGLE end-of-review verify
    // over the accepted files — the instant every row is decided, whether the user
    // clicked rows individually or used Accept all / Reject all.
    const decided = new Set<string>()
    const accepted: AcceptedResolution[] = []
    let finalized = false

    const applyRow = async (item: ConflictReviewItem): Promise<void> => {
      if (!item.apply) return // synthesized / unresolvable block → accept is a no-op
      const target = item.apply
      const outcome = await resolveHunkAndRecord({
        rootId: target.rootId,
        filePath: target.filePath,
        hunkId: target.hunkId,
        choice: target.choice,
        ...(target.order ? { order: target.order } : {}),
        ...(target.originalBlock !== undefined ? { originalBlock: target.originalBlock } : {}),
        // NO `auto:true` — this is a user-accepted apply, inspectable as such.
      })
      if (!outcome.matched) {
        // A no-match is a real failure (stale hunk id) — throw so the card
        // re-enables the row; never fabricate a success (forbidden-pattern #7).
        throw new Error(`Resolve with AI: no matching hunk for ${target.filePath} (${target.hunkId})`)
      }
      accepted.push({ rootId: target.rootId, filePath: target.filePath, proposal: item.input.proposal })
    }

    const finalizeIfDone = async (): Promise<void> => {
      if (finalized || decided.size < items.length) return
      finalized = true
      await postReviewSummary(threadId, accepted, items.length)
      // Park only the ACCEPTED resolutions for the merge-completion summary
      // (Phase 8) — rejected proposals were never applied.
      parkAcceptedResolutions(accepted)
      const targets = distinctAppliedTargets(accepted)
      if (targets.length === 0) return
      try {
        await verifyAndMaybeRepair(threadId, targets)
      } catch (error) {
        console.error('flow: post-merge verification failed to run', error)
        notify(
          'warn',
          'Verification skipped',
          'Post-merge verification could not run. The accepted resolutions were applied.',
        )
      }
    }

    const onDecision = async (rowId: string, decision: ConflictReviewDecision): Promise<void> => {
      if (decided.has(rowId)) return // idempotent — a re-decide never re-applies
      const item = itemByRow.get(rowId)
      if (item && decision === 'accept') await applyRow(item) // throws → row NOT decided, retryable
      decided.add(rowId)
      await finalizeIfDone()
    }

    const onDecisionAll = async (decision: ConflictReviewDecision): Promise<string[]> => {
      // Track the rows THIS invocation decides so a mid-loop failure can hand them
      // back to the card — those rows are already spliced+recorded, so the card
      // must collapse them, never re-enable them (state divergence otherwise).
      const decidedNow: string[] = []
      try {
        for (const item of items) {
          if (decided.has(item.rowId)) continue
          if (decision === 'accept') await applyRow(item) // throws → prior rows decided, rest stay pending
          decided.add(item.rowId)
          decidedNow.push(item.rowId)
        }
      } catch (error) {
        // Attach the already-decided rowIds so the card reconciles the partial
        // progress before re-enabling only the truly-still-pending rows.
        if (error && typeof error === 'object') {
          ;(error as { decidedRowIds?: string[] }).decidedRowIds = decidedNow
        }
        throw error
      }
      await finalizeIfDone()
      return decidedNow
    }

    const detail: ConflictReviewEventDetail = {
      inputs: items.map((item) => item.input),
      onDecision,
      onDecisionAll,
    }
    document.dispatchEvent(new CustomEvent<ConflictReviewEventDetail>(CONFLICT_REVIEW_EVENT, { detail }))

    await postNote(
      threadId,
      `Resolve with AI: ${items.length} ${plural(items.length, 'proposal')} shown for review — nothing applied yet.`,
    )
    notify(
      'info',
      'Resolve with AI',
      `${items.length} ${plural(items.length, 'proposal')} shown for review. Accept to apply.`,
    )
  }

  /**
   * Group the parsed proposals under their conflicted file, attaching each file's
   * concrete per-side identities. A filePath shared across roots is AMBIGUOUS — a
   * bare `proposal.file` can't say which tree — so it is skipped entirely (never
   * mis-targeted). Files with no proposals are dropped.
   */
  function buildReviewFiles(
    files: readonly EnrichedConflict[],
    proposals: readonly ConflictProposal[],
  ): ConflictFileReview[] {
    const pathCounts = new Map<string, number>()
    for (const file of files) pathCounts.set(file.filePath, (pathCounts.get(file.filePath) ?? 0) + 1)

    const proposalsByFile = new Map<string, ConflictProposal[]>()
    for (const proposal of proposals) {
      const list = proposalsByFile.get(proposal.file)
      if (list) list.push(proposal)
      else proposalsByFile.set(proposal.file, [proposal])
    }

    const reviewFiles: ConflictFileReview[] = []
    const seen = new Set<string>()
    for (const file of files) {
      if ((pathCounts.get(file.filePath) ?? 0) > 1 || seen.has(file.filePath)) continue
      const fileProposals = proposalsByFile.get(file.filePath)
      if (!fileProposals || fileProposals.length === 0) continue
      seen.add(file.filePath)
      reviewFiles.push({
        rootPath: file.rootPath,
        filePath: file.filePath,
        markered: file.markered,
        proposals: fileProposals,
        ...(file.oursIdentity ? { oursIdentity: file.oursIdentity } : {}),
        ...(file.theirsIdentity ? { theirsIdentity: file.theirsIdentity } : {}),
      })
    }
    return reviewFiles
  }

  /**
   * After safe resolutions are applied, run the project's verification. On
   * failure: escalate the implicated resolutions to risky, run EXACTLY ONE AI
   * repair pass in the active thread, re-verify ONCE, and — if still failing —
   * post an escalation record and STOP. The loop is bounded to a single repair.
   */
  async function verifyAndMaybeRepair(
    threadId: string,
    targets: AppliedTarget[],
  ): Promise<void> {
    const roots = distinctRoots(targets)
    const changedFiles = targets.map((target) => target.filePath)

    const first = await verifyAcrossRoots(roots, changedFiles)
    if (!first) {
      // No verify commands configured anywhere — skip with a one-line notice,
      // never block completion (fail-soft).
      notify(
        'info',
        'Verification skipped',
        'No verify commands configured (flowconfig commands.* or package.json scripts).',
      )
      return
    }
    recordMergeResolutionVerify(first.rootId, toSummaryVerify(first.result))
    if (first.result.ok) {
      notify('info', 'Verification passed', `Ran ${describeRan(first.result.ran)} — resolutions verified.`)
      return
    }

    // Failure. Escalate the implicated resolutions to risky (Phase 2 forceRisky)
    // and record the culprit the verify step pinned.
    const failure = first.result.firstFailure
    const culprit = first.result.culprit ?? null
    const escalation = forceRisky(appliedVerdict(), `post-merge verification failed (${failure?.name ?? 'unknown'})`)

    // Exactly ONE AI repair pass in the active thread.
    const repaired = await runOneRepairTurn(threadId, buildRepairPrompt(failure, culprit))
    if (!repaired) {
      await postEscalation(threadId, failure, culprit, escalation)
      return
    }

    // Re-verify ONCE. Still failing → escalate to the user and STOP.
    const second = await verifyAcrossRoots(roots, changedFiles)
    if (second) recordMergeResolutionVerify(second.rootId, toSummaryVerify(second.result))
    if (second && !second.result.ok) {
      await postEscalation(threadId, second.result.firstFailure, second.result.culprit ?? null, escalation)
      return
    }
    notify('info', 'Verification passed', 'Repaired the resolution and re-verified successfully.')
    await api.messages
      .append({ threadId, role: 'system', content: 'Resolve with AI: verification passed after one repair pass.' })
      .catch((error: unknown) => console.warn('flow: failed to post repair record', { threadId, error }))
  }

  /**
   * Verify each distinct root (via the main-side runner). The FIRST failing root
   * wins (returned immediately); otherwise the last root that actually ran a
   * check is returned. Null means NO root had any verify command configured.
   */
  async function verifyAcrossRoots(
    roots: string[],
    changedFiles: string[],
  ): Promise<{ rootId: string; result: MergeVerifyResult } | null> {
    let lastRan: { rootId: string; result: MergeVerifyResult } | null = null
    for (const rootId of roots) {
      const result = await api.git.verifyMerge({ rootId, changedFiles })
      if (!result.ok) return { rootId, result }
      if (result.ran.length > 0) lastRan = { rootId, result }
    }
    return lastRan
  }

  /**
   * Send one repair turn and await its completion `done`. false on send failure OR
   * when the turn times out (M2) — both feed the not-repaired handling upstream, so
   * a stuck turn escalates rather than fabricating a repaired-then-verified path.
   */
  async function runOneRepairTurn(threadId: string, prompt: string): Promise<boolean> {
    const turn = awaitTurnDone(threadId)
    try {
      await api.threads.sendMessage({ threadId, content: prompt })
    } catch (error) {
      turn.cancel()
      console.error('flow: failed to send repair prompt', { threadId, error })
      return false
    }
    const completed = await turn.promise
    if (!completed) {
      console.warn('flow: repair turn timed out — treating as not repaired', { threadId })
    }
    return completed
  }

  /**
   * Resolve on the next stream `done` for the thread, OR after
   * REPAIR_TURN_TIMEOUT_MS (M2) — mirroring ensureResolveSession's settle+latch so
   * the await can never hang and the subscription can never leak. Resolves `true`
   * on a real `done`, `false` on timeout; either way the stream is unsubscribed and
   * the timer cleared exactly once. cancel() tears down without resolving.
   */
  function awaitTurnDone(threadId: string): { promise: Promise<boolean>; cancel: () => void } {
    let unsubscribe = (): void => {}
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const promise = new Promise<boolean>((resolvePromise) => {
      const settle = (completed: boolean): void => {
        if (settled) return
        settled = true
        unsubscribe()
        if (timer) clearTimeout(timer)
        resolvePromise(completed)
      }
      unsubscribe = api.threads.onStream((event) => {
        if (event.kind === 'done' && event.threadId === threadId) settle(true)
      })
      timer = setTimeout(() => settle(false), REPAIR_TURN_TIMEOUT_MS)
    })
    return {
      promise,
      cancel: () => {
        settled = true
        if (timer) clearTimeout(timer)
        unsubscribe()
      },
    }
  }

  /** Post the user-facing escalation record + toast after a failed re-verify. */
  async function postEscalation(
    threadId: string,
    failure: { name: string; output: string } | undefined,
    culprit: string | null,
    escalation: FinalVerdict,
  ): Promise<void> {
    const culpritText = culprit ? ` · likely culprit: ${culprit}` : ''
    const body =
      `Resolve with AI: verification still failing after one repair pass ` +
      `(${failure?.name ?? 'unknown'})${culpritText}. Held for your review — ${escalation.reason}`
    try {
      await api.messages.append({ threadId, role: 'system', content: body })
    } catch (error) {
      console.warn('flow: failed to post verification escalation', { threadId, error })
    }
    notify('warn', 'Verification failed', body)
  }

  /** Read the newest assistant message's text for the thread, or null. */
  async function latestAssistantText(threadId: string): Promise<string | null> {
    try {
      const messages = await api.messages.list({ threadId })
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'assistant') return messages[i].content
      }
    } catch (error) {
      console.error('flow: failed to read assistant reply', { threadId, error })
    }
    return null
  }

  /** Post a persisted system note into the thread (best-effort — a failure to
   *  append is logged, never thrown, so it can't mask the review/apply itself). */
  async function postNote(threadId: string, content: string): Promise<void> {
    try {
      await api.messages.append({ threadId, role: 'system', content })
    } catch (error) {
      console.warn('flow: failed to post resolution note', { threadId, error })
    }
  }

  /**
   * Post the end-of-review record + a toast, once the user has decided every
   * row. The note says WHAT was applied and WHY (#1919): the headline counts
   * proposals, then one readable line per accepted file (choice + rationale).
   * The toast keeps just the headline (a toast is not the place for a list).
   */
  async function postReviewSummary(
    threadId: string,
    accepted: readonly AcceptedResolution[],
    total: number,
  ): Promise<void> {
    const rejected = total - accepted.length
    const headline = `Resolve with AI: applied ${accepted.length} of ${total} ${plural(total, 'proposal')} · ${rejected} rejected`
    const lines = describeAccepted(accepted)
    const body = lines.length > 0 ? `${headline}\n${lines.join('\n')}` : headline
    await postNote(threadId, body)
    notify(accepted.length > 0 ? 'info' : 'warn', 'Resolve with AI', headline)
  }

  /**
   * Collect conflicted files across every project root (a file is uniquely
   * (root, path)), reading each one's markers so its blocks can be listed in the
   * prompt and classified on completion. Also reports the PROJECT root count so
   * the prompt qualifies files by root in any multi-project window (#295, #337).
   */
  async function gatherConflictedFiles(): Promise<{
    files: EnrichedConflict[]
    projectCount: number
  }> {
    const roots = await api.project.list()
    // Collect every conflicted (root, path) pair first (per-root status is cheap),
    // THEN enrich them in parallel with a concurrency cap. Each readEnriched fans
    // out ~8-12 git spawns, so the old serial nested loop made resolve slow to
    // start on merges with many conflicts. Order is irrelevant to the prompt/review.
    const pairs: { rootPath: string; filePath: string }[] = []
    for (const root of roots) {
      const status = await api.git.status({ rootId: root.rootPath }).catch(() => null)
      if (!status) continue
      for (const change of status.changes) {
        if (change.state !== 'conflicted') continue
        pairs.push({ rootPath: root.rootPath, filePath: change.filePath })
      }
    }
    const enriched = await mapWithConcurrency(pairs, GATHER_READ_CONCURRENCY, (pair) =>
      readEnriched(pair.rootPath, pair.filePath),
    )
    // Fail-soft preserved: a failed read yields null and is filtered out here.
    const files = enriched.filter((entry): entry is EnrichedConflict => entry !== null)
    return { files, projectCount: roots.length }
  }

  /** Read one conflicted file's markers + parse its blocks; null on failure or
   *  an oversize file (which is held — never auto-resolved). */
  async function readEnriched(
    rootPath: string,
    filePath: string,
  ): Promise<EnrichedConflict | null> {
    try {
      const result = await api.git.readConflicted({ rootId: rootPath, filePath })
      if ('oversize' in result) return null
      const blocks: ConflictBlockInfo[] = parseConflicts(result.markered).map((block, index) => ({
        blockId: index,
        startLine: block.startLine,
        endLine: block.endLine,
      }))
      return {
        rootPath,
        filePath,
        markered: result.markered,
        blocks,
        ...(result.oursIdentity ? { oursIdentity: result.oursIdentity } : {}),
        ...(result.theirsIdentity ? { theirsIdentity: result.theirsIdentity } : {}),
      }
    } catch (error) {
      console.warn('flow: failed to read conflicted file', { rootPath, filePath, error })
      return null
    }
  }

  function notify(level: FlowNotification['level'], title: string, body: string): void {
    document.dispatchEvent(
      new CustomEvent<FlowNotification>('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '',
          title,
          body,
          timestamp: new Date().toISOString(),
          level,
        },
      }),
    )
  }
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}

/** The choice → human phrase used in the review summary's per-file lines. */
const CHOICE_SUMMARY: Record<ConflictProposal['choice'], string> = {
  ours: 'kept ours',
  theirs: 'kept theirs',
  both: 'combined both sides',
  synthesized: 'applied new code',
}

/** Max rationale length carried into a summary line before it is elided. */
const WHY_SUMMARY_LIMIT = 140

/** Collapse a proposal's `why` to a single trimmed, length-capped line. */
function summarizeWhy(why: string): string {
  const trimmed = why.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= WHY_SUMMARY_LIMIT) return trimmed
  return `${trimmed.slice(0, WHY_SUMMARY_LIMIT - 1)}…`
}

/**
 * One readable "· <file> — <choice>: <why>" line per accepted FILE (first accept
 * wins for a file resolved across several hunks), so the end-of-review summary
 * says what was applied and why (#1919).
 */
function describeAccepted(accepted: readonly AcceptedResolution[]): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const entry of accepted) {
    const key = `${entry.rootId} ${entry.filePath}`
    if (seen.has(key)) continue
    seen.add(key)
    const choice = CHOICE_SUMMARY[entry.proposal.choice]
    const why = summarizeWhy(entry.proposal.why)
    lines.push(why ? `· ${entry.filePath} — ${choice}: ${why}` : `· ${entry.filePath} — ${choice}`)
  }
  return lines
}

/** Map a MergeVerifyResult to the summary's condensed verify shape (name only). */
function toSummaryVerify(result: MergeVerifyResult): {
  ok: boolean
  ran: string[]
  firstFailure?: string
} {
  return {
    ok: result.ok,
    ran: result.ran,
    ...(result.firstFailure ? { firstFailure: result.firstFailure.name } : {}),
  }
}

/**
 * Park the ACCEPTED resolutions (per root) for the merge-completion path (Phase
 * 8). One MergeSummaryConflict per accepted file (first accept wins on a file
 * with several): `choice`/`confidence`/`why`/`how` + `finalRisk` from the
 * proposal the user accepted; the intent fields have no source here, so they
 * degrade to ''. Rejected proposals were never applied and are never parked.
 */
function parkAcceptedResolutions(accepted: readonly AcceptedResolution[]): void {
  const byRoot = new Map<string, MergeSummaryConflict[]>()
  const seen = new Set<string>()
  for (const entry of accepted) {
    const key = `${entry.rootId} ${entry.filePath}`
    if (seen.has(key)) continue
    seen.add(key)
    const conflict: MergeSummaryConflict = {
      file: entry.filePath,
      oursIntent: '',
      theirsIntent: '',
      choice: entry.proposal.choice,
      finalRisk: entry.proposal.risk,
      confidence: entry.proposal.confidence,
      why: entry.proposal.why,
      how: entry.proposal.how,
    }
    const list = byRoot.get(entry.rootId)
    if (list) list.push(conflict)
    else byRoot.set(entry.rootId, [conflict])
  }

  if (byRoot.size > 0) recordMergeResolutionConflicts(byRoot)
}

/** The distinct (root, file) AppliedTargets among the accepted resolutions — the
 *  verify input; a file accepted via several hunks collapses to one target. */
function distinctAppliedTargets(accepted: readonly AcceptedResolution[]): AppliedTarget[] {
  const byKey = new Map<string, AppliedTarget>()
  for (const entry of accepted) {
    const key = `${entry.rootId} ${entry.filePath}`
    if (!byKey.has(key)) byKey.set(key, { rootPath: entry.rootId, filePath: entry.filePath })
  }
  return [...byKey.values()]
}

/** Distinct root paths among the applied targets (verify runs once per root). */
function distinctRoots(targets: AppliedTarget[]): string[] {
  return [...new Set(targets.map((target) => target.rootPath))]
}

/** Human-readable list of the verify steps that ran (e.g. "typecheck, test"). */
function describeRan(ran: string[]): string {
  return ran.length > 0 ? ran.join(', ') : 'no checks'
}

/**
 * The seed verdict for the user-accepted resolutions, used only so forceRisky
 * (Phase 2) can escalate it on verify failure — the one-way escalation that
 * records WHY these accepted resolutions now need another look.
 */
function appliedVerdict(): FinalVerdict {
  return { risk: 'safe', confidence: 1, reason: 'user-accepted resolution' }
}

/** The concise repair turn seeded after a failed verify — one pass only. */
function buildRepairPrompt(
  failure: { name: string; output: string } | undefined,
  culprit: string | null,
): string {
  const step = failure?.name ?? 'verification'
  const culpritLine = culprit ? `Likely culprit: ${culprit}\n` : ''
  const output = (failure?.output ?? '').slice(-REPAIR_OUTPUT_LIMIT)
  return (
    `Post-merge verification failed after applying the conflict resolution(s): the "${step}" check did not pass.\n` +
    culpritLine +
    `Fix the resolution so the project verifies. Failure output:\n\n${output}`
  )
}
