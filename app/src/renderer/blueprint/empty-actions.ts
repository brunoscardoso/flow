/**
 * WHAT AN EMPTY BOARD OFFERS TO DO ABOUT ITSELF — PURE, no DOM, no IPC.
 *
 * THE BOARD USED TO SEND YOU SOMEWHERE ELSE
 * =========================================
 * An empty feature board said "run a basic discovery from Settings". Every
 * word of that was true and none of it was useful: the reader is looking at
 * the surface the gesture repairs, and they were handed a route to a different
 * window instead of the gesture. So the sentence names what is missing and
 * the BUTTON is the instruction — the same shape `feature-view-request.ts`
 * settled on for "Understand this feature", and this module deliberately
 * speaks its vocabulary rather than inventing a second one.
 *
 * TWO WAYS A BUTTON CAN LIE, BOTH FIXED HERE
 * ==========================================
 * 1. **It can be offered against a project that is not empty.** The feature
 *    fetch fails soft — a missing bundled CLI, a 30-second timeout, a refusal
 *    line and unparseable output all resolve to "no features". Pressing
 *    discovery there would spend minutes mining a repo whose features were
 *    merely unreadable at that instant. `fetchFailed` therefore suppresses the
 *    action outright: the empty state that could not measure anything gets
 *    words, never a gesture.
 * 2. **It can be pressed and do nothing.** `enqueueBasicDiscovery` returns
 *    early when the root is not ready (`provisioningState !== 'ready'`), with
 *    no error, no toast and no event — on a freshly added project the gesture
 *    is a silent no-op. So readiness is read HERE and an unready root gets a
 *    disabled control that says which state it is in and what it is waiting
 *    for. A control that looks pressable and quietly no-ops is the bug this
 *    whole module exists to remove.
 *
 * A DOMAIN GETS NOTHING, ON PURPOSE
 * =================================
 * `domain:` is a human-owned frontmatter key that no machine write may touch.
 * There is no gesture that fills an empty domain, so this returns null for one
 * and the board shows guidance alone. Faking an action there would be worse
 * than the detour to Settings ever was.
 */

import type { ProvisioningState } from '../../shared/ipc-contract'

/** Which empty place is asking. Mirrors `EmptyLevelKind`'s actionable subset. */
export type EmptyPlace = 'root' | 'feature' | 'part' | 'domain'

/**
 * One control, rendered verbatim. Shared with `understand-action.ts` — the
 * board renders every offer it makes on an absence through one builder, which
 * is what makes "the same family" a fact about the code rather than a wish
 * about the wording. There were two near-identical copies of this shape once;
 * that duplication is how the Learn/Draw pair grew apart in the first place.
 */
export interface BoardAction {
  label: string
  /** Tooltip AND accessible description — says what pressing it costs. */
  title: string
  running: boolean
  disabled: boolean
  /** A failure line to keep beside the action, or null. */
  error: string | null
}

export interface DiscoveryActionInput {
  place: EmptyPlace
  /** The active root's PATH (every `learn:*` channel takes the path). */
  rootPath: string | null
  /** The root's live readiness. `undefined` = not observed yet. */
  provisioning: ProvisioningState | undefined
  /** The feature query FAILED — the store's emptiness is unknown. */
  fetchFailed: boolean
  /** A discovery for this root is already in flight. */
  running: boolean
  /** The last failure, kept on screen after the toast goes. */
  error?: string | null
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** THE LABEL. The same words the notifications use ("Basic discovery started",
 *  "Basic discovery finished"), so the toast that arrives next is recognisably
 *  the thing that was pressed. */
const DISCOVERY_LABEL = 'Run basic discovery'

/**
 * Why an unready root cannot run a model-backed pass — named per state, because
 * "not ready" on its own tells the reader nothing about whether to wait or act.
 *
 * Exported for `understand-action.ts`, which refuses for exactly the same
 * reasons and must say exactly the same words. Two copies of this wording would
 * be two explanations of one fact.
 */
export function notReadyReason(provisioning: ProvisioningState | undefined): string | null {
  if (provisioning === 'ready') return null
  if (provisioning === 'provisioning') {
    return 'Flow is still setting this project up. Discovery can run as soon as that finishes.'
  }
  if (provisioning === 'failed') {
    return 'Setting this project up failed, so discovery cannot run yet. Re-provision it in Settings, then try again.'
  }
  // 'idle' and undefined alike: the assets are not in place (or the app has not
  // seen this root settle yet). Both are honest as "not set up yet"; neither is
  // claimed to be an error.
  return 'This project is not set up for plan-flow yet, so discovery cannot run. It becomes available once setup finishes.'
}

/**
 * Should the empty board offer to go and find this project's features?
 *
 * Returns null wherever the action cannot help — a domain, a failed read, no
 * project. Null IS the hiding mechanism; there is no `visible` flag a caller
 * could ignore.
 */
export function decideDiscoveryAction(input: DiscoveryActionInput): BoardAction | null {
  // ONLY THE ROOT. A drilled level's emptiness is about ONE feature; running a
  // whole-project discovery from there would be answering a question nobody
  // asked (and `decideUnderstandAction` is the one that belongs there).
  if (input.place !== 'root') return null
  // NOTHING WAS MEASURED. See the header — no gesture on an unread store.
  if (input.fetchFailed) return null
  const rootPath = clean(input.rootPath)
  if (rootPath === null) return null

  if (input.running) {
    return {
      label: 'Finding features…',
      // SAY WHAT IS HAPPENING AND ROUGHLY HOW LONG. Discovery mines surfaces
      // and then reads modules; "working" without a duration reads as hung.
      title:
        'Reading this project’s routes, tests and modules to find what it does. This takes a few minutes; the board fills in by itself as features are found.',
      running: true,
      disabled: true,
      error: null,
    }
  }

  const blocked = notReadyReason(input.provisioning)
  if (blocked !== null) {
    // SHOWN, AND REFUSED OUT LOUD. Hiding it would leave the empty board with
    // no explanation at all on exactly the projects that most need one — a
    // freshly added repo is where this state is most likely to be seen.
    return {
      label: DISCOVERY_LABEL,
      title: blocked,
      running: false,
      disabled: true,
      error: clean(input.error),
    }
  }

  return {
    label: DISCOVERY_LABEL,
    title:
      'Read this project’s routes, tests and modules and name what it does — writes the features this board draws. Takes a few minutes.',
    running: false,
    disabled: false,
    error: clean(input.error),
  }
}

/**
 * WHAT A RUNNING DISCOVERY IS WAITING FOR.
 *
 * `learn:featuresDiscovered` is the terminal signal for the half of basic
 * discovery this board cares about (module learning continues afterwards, and
 * has its own panel). Every exit of the feature-generation step raises it —
 * success, refusal, unready root, thrown error — for the same reason
 * `drawFeatureView` toasts on every branch: an indicator with a branch that
 * raises nothing spins forever.
 *
 * This reads one such event as "the discovery I started has landed", or null
 * when it belongs to another project.
 */
export type DiscoveryOutcome =
  | { done: true; added: number }
  | { done: false; reason: string }

export function matchDiscoveryEvent(
  event: { rootId?: unknown; added?: unknown; reason?: unknown },
  rootPath: string | null,
): DiscoveryOutcome | null {
  const root = clean(rootPath)
  if (root === null) return null
  if (clean(event.rootId as string | null) !== root) return null
  const reason = clean(event.reason as string | null)
  if (reason !== null) return { done: false, reason }
  const added = typeof event.added === 'number' && Number.isFinite(event.added) ? event.added : 0
  return { done: true, added: Math.max(0, Math.trunc(added)) }
}

/**
 * What the board says once a discovery has landed and the store is STILL empty.
 *
 * A repo can genuinely name no capability — the CLI's own rule is that a name
 * counts only when it appears in two distinct surface kinds — and silence there
 * would read exactly like the button having failed.
 */
export function discoveryFoundNothingNotice(): string {
  return 'The discovery finished and found no capability this project names in more than one place. Features can also be written by hand in flow/brain/features/.'
}
