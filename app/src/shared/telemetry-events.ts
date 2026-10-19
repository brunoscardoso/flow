/**
 * THE EVENTS, AS A CLOSED LIST WITH TYPED SHAPES.
 *
 * `telemetry-allowlist.ts` says which FIELDS may leave and which NAMES an event
 * may have. This module says, for each of those names, exactly which of those
 * fields it carries — so the two questions an instrumented call site can get
 * wrong are both answered before it runs:
 *
 *   1. "is this field allowed at all?"    → the allowlist, at runtime, one door
 *   2. "does THIS event carry that field?" → here, at compile time
 *
 * The second is what stops the helpful extra field. A call site that adds
 * `projectName` to a thread event does not fail a review or a test — it fails
 * `tsc`, at the moment it is typed, which is the only feedback fast enough to
 * matter.
 *
 * ADDING AN EVENT IS AN EDIT TO TWO LISTS, both in this folder and both short:
 * the name in `EVENT_NAMES`, the shape here. That is deliberate friction. A
 * free-form event name is how an allowlist stops being one, and it is also how
 * analytics becomes unqueryable after a month — nobody can answer "how many
 * sessions" against a column holding four spellings of the same idea.
 *
 * Pure and DOM-free, like the contract it extends.
 */

import type { EventName } from './telemetry-allowlist'

/**
 * WHICH AREA BROKE — the app's own word for it, never the error's.
 *
 * A message and a stack are ruled out (they carry paths, names and sometimes
 * the content of a file), so a crash is a RATE here rather than a diagnosis.
 * This vocabulary is what keeps that rate useful: "the database writes are
 * failing on Windows" is a different alarm from "the agent will not start", and
 * neither needs a single character of the underlying error to be actionable.
 */
export const ERROR_KINDS = [
  'db-write',
  'agent-spawn',
  'git',
  'network',
  'update',
  'renderer',
  'unknown',
] as const

export type ErrorKind = (typeof ERROR_KINDS)[number]

/**
 * What each event carries.
 *
 * Every property is a field on the allowlist — the test beside this walks the
 * whole map and proves it rather than trusting the reading. Nothing here can
 * hold a name: not a file, not a project, not a branch, not a repository.
 */
export interface EventShapes {
  /** A run of the app began. */
  'session.started': { at: number; sessionId: string }
  /** A run of the app ended, and how long it lasted. */
  'session.ended': { at: number; durationMs: number; sessionId: string }
  /**
   * A conversation was started.
   *
   * `provider` and `model` are the two facts that make this worth counting —
   * which runtimes people actually use — and `threadCount` is the coarse scale
   * that says whether this is somebody's first thread or their four hundredth.
   */
  'thread.created': {
    at: number
    provider?: string
    model?: string
    threadCount?: number
  }
  /** A debug session was finished, and how big the recording was. */
  'debug.session.finished': { at: number; durationMs?: number; count?: number }
  /** A worktree was cut for a thread. */
  'worktree.created': { at: number; projectCount?: number }
  /**
   * Something failed, said in the app's own vocabulary.
   *
   * `errorKind` is the ONLY thing that crosses. There is no message, no stack
   * and no breadcrumb, because those were ruled out by the person shipping this
   * — see the allowlist's header.
   */
  'app.failed': { at: number; errorKind: ErrorKind; count?: number }
}

/**
 * The payload as the boundary will see it.
 *
 * `event` is added here rather than by the caller, so a call site cannot name
 * an event one thing and shape it as another.
 */
export type UsageEvent<K extends EventName> = EventShapes[K] & { event: K }

/**
 * Build a usage event.
 *
 * The signature is the whole point: `props` is `EventShapes[K]`, so an extra
 * property is a compile error at the call site and a missing required one is
 * too. There is no runtime check here on purpose — the door does that, and a
 * second validator would be a second place for the rule to drift
 * (allowed-pattern #14).
 */
export function usageEvent<K extends EventName>(
  name: K,
  props: EventShapes[K],
): UsageEvent<K> {
  return { ...props, event: name }
}
