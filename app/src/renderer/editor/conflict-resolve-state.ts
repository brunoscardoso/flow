/**
 * Resolve-with-AI progress signal (#1134).
 *
 * "Resolve all with AI" fired and then sat there, unchanged, for the whole
 * agent turn — the button looked idle while a turn was running, so the only
 * feedback was the chat scrolling somewhere else, and there was no way to
 * stop the turn from the place you started it.
 *
 * The orchestration (conflict-resolve-index) owns the lifecycle and announces
 * it on a decoupled event; the git panel listens and swaps the button. The
 * phase→control mapping lives here, pure and DOM-free, so it unit-tests and
 * both ends agree on the wording. Deliberately DOM-free (the repo's model-module
 * convention) so it unit-tests under the node jest env — the dispatch itself
 * lives in the orchestration, which owns a DOM anyway.
 */

/** Announced by the orchestration whenever the resolve lifecycle moves. */
export const CONFLICT_RESOLVE_STATE_EVENT = 'flow:conflict-resolve-state'

/** Asked by the panel's Stop button; the orchestration owns the interrupt. */
export const CONFLICT_RESOLVE_STOP_EVENT = 'flow:conflict-resolve-stop'

/**
 * Where the resolve run is:
 * - `idle` — nothing running (also the terminal state of every failure path).
 * - `gathering` — reading conflicted files; no turn exists yet, so nothing to stop.
 * - `resolving` — the prompt is with the agent; stoppable.
 */
export type ConflictResolvePhase = 'idle' | 'gathering' | 'resolving'

export interface ConflictResolveStateDetail {
  phase: ConflictResolvePhase
  /** The thread the turn runs in — present only while `resolving`. */
  threadId?: string
}

/** What the section-level control should render right now. */
export interface ResolveAllControl {
  label: string
  title: string
  /** Show the spinner (and suppress the plain action). */
  busy: boolean
  /** Offer the Stop button — only when there is a turn to interrupt. */
  canStop: boolean
}

const CONTROLS: Record<ConflictResolvePhase, ResolveAllControl> = {
  idle: {
    label: 'Resolve all with AI',
    title: 'Resolve all conflicts with AI',
    busy: false,
    canStop: false,
  },
  gathering: {
    label: 'Reading conflicts…',
    title: 'Reading the conflicted files',
    busy: true,
    // Nothing has been sent yet — a Stop here would have no turn to interrupt,
    // and offering one that does nothing is worse than not offering it.
    canStop: false,
  },
  resolving: {
    label: 'Resolving…',
    title: 'The agent is resolving the conflicts — Stop to interrupt it',
    busy: true,
    canStop: true,
  },
}

export function resolveAllControl(phase: ConflictResolvePhase): ResolveAllControl {
  return CONTROLS[phase]
}
