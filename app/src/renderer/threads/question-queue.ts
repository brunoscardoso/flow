// Routing state for "agent is waiting on you" cards (AskUserQuestion cards and
// permission asks, #949) in the single, thread-switching conversation pane.
// DOM-free so the never-drop invariant is unit-tested.
//
// Invariant: a request is NEVER dropped. It renders immediately when its thread
// is active and loaded; otherwise it buffers (keyed by thread) and surfaces when
// that thread is shown + loaded. A rendered-but-unanswered card that gets wiped
// by a thread switch is re-buffered so it re-renders on return — never leaving
// the agent parked on a card that no longer exists on screen.

import type { UserQuestionRequest } from '../../shared/ipc-contract'

export interface RouteContext {
  activeThreadId: string | null
  /** True while the active thread's history is loading (the feed will be reset,
   *  so rendering now would wipe the card). */
  loading: boolean
}

/** The minimum a routed request must carry: identity + owning thread. */
export interface RoutedRequest {
  requestId: string
  threadId: string
}

/**
 * Generic never-drop routing queue. One instance per card kind — questions and
 * permission asks share the mechanism (#949: the permission path previously had
 * no queue, so a thread switch destroyed a pending ask and left the tool call
 * parked forever with no affordance to answer it).
 */
export class PendingCardQueue<T extends RoutedRequest> {
  /** threadId → buffered requests awaiting their thread to be active + loaded. */
  private readonly pending = new Map<string, T[]>()
  /** requestId → request currently rendered (unanswered). */
  private readonly rendered = new Map<string, T>()

  /**
   * Handle an incoming request. Returns the request to render right now, or
   * null if it was buffered / is a duplicate. Never drops.
   */
  incoming(request: T, ctx: RouteContext): T | null {
    if (this.rendered.has(request.requestId) || this.isBuffered(request)) return null
    if (request.threadId !== ctx.activeThreadId || ctx.loading) {
      this.buffer(request)
      return null
    }
    this.rendered.set(request.requestId, request)
    return request
  }

  /** Mark a request answered/removed so it is not re-buffered or re-rendered. */
  resolve(requestId: string): void {
    this.rendered.delete(requestId)
    for (const [threadId, list] of this.pending) {
      const next = list.filter((r) => r.requestId !== requestId)
      if (next.length === 0) this.pending.delete(threadId)
      else if (next.length !== list.length) this.pending.set(threadId, next)
    }
  }

  /**
   * A thread became active + loaded — return its buffered requests to render
   * (marking them rendered). Empty when nothing was waiting.
   */
  flush(threadId: string): T[] {
    const list = this.pending.get(threadId)
    if (!list) return []
    this.pending.delete(threadId)
    const toRender = list.filter((r) => !this.rendered.has(r.requestId))
    for (const request of toRender) this.rendered.set(request.requestId, request)
    return toRender
  }

  /**
   * The feed is being wiped (thread switch). Re-buffer every unanswered rendered
   * request under its own thread so it re-renders when shown again.
   */
  clearRendered(): void {
    for (const request of this.rendered.values()) this.buffer(request)
    this.rendered.clear()
  }

  private buffer(request: T): void {
    const list = this.pending.get(request.threadId) ?? []
    if (!list.some((r) => r.requestId === request.requestId)) list.push(request)
    this.pending.set(request.threadId, list)
  }

  private isBuffered(request: T): boolean {
    return this.pending.get(request.threadId)?.some((r) => r.requestId === request.requestId) ?? false
  }
}

/** AskUserQuestion routing — the original consumer; name kept for call sites. */
export class QuestionQueue extends PendingCardQueue<UserQuestionRequest> {}
