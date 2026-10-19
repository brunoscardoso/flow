// The pure model behind "keep looking" — the loop option that now sits beside
// the work that prompted it, on New task and on New thread.
//
// WHY A HUNT MOVED HERE FROM THE LOOPS SCREEN, in the user's own words: "the
// finding will not be more like 'run the finding' or 'play' or 'pause'. The
// finding will be when we are pressing New Task or when we are pressing a new
// thread". A standing producer with a play button was a thing you switched on
// and then had to remember to switch off — the loops screen could start one and
// nothing on it ever ended one. So a hunt is no longer a switch on a control
// centre. It is an OPTION ON A PIECE OF WORK, created with that work, and it
// carries the rule that ends it from the moment it exists.
//
// THE RULE IS THE POINT. A hunt has always had two ways to finish that nobody
// chooses — a backstop nobody picked and running out of things to find — and
// neither is an answer to "how long do you want this going for". The three
// kinds here are the three shapes of that answer, and they are the user's own:
// a number of findings, a stretch of time, or a sentence.
//
// DOM-FREE AND IPC-FREE, like every model in this folder: given what a person
// has set, it produces every word the control shows, the one refusal that can
// stop a create, and the exact request the CLI is asked to perform. What draws
// it lives in hunt-config-view.ts; what performs it lives in the two surfaces
// that own a create.

import { DEFAULT_HUNT_CAP, HUNT_STOP_HOURS, MAX_HUNT_RULE_LENGTH } from './hunt-limits'
import type { LoopsSnapshot, LoopStopChoice } from '../../shared/ipc-contract'

/** Which of the three rules ends this hunt. */
export type HuntStopKind = 'findings' | 'duration' | 'custom'

/** Everything a person can set about a hunt, before it exists. */
export interface HuntConfig {
  /** Whether this piece of work starts a hunt at all. */
  on: boolean
  kind: HuntStopKind
  /** `findings`: how many it may file before it stops. */
  findings: number
  /** `duration`: how many hours it runs for. */
  hours: number
  /** `custom`: the sentence the agent judges. */
  rule: string
}

/**
 * How many findings a hunt stops at when nobody moves the number.
 *
 * FIVE, NOT THE CLI'S TWENTY. The backstop and the chosen rule are different
 * decisions: `DEFAULT_HUNT_CAP` is what the system falls back to when NOBODY
 * chose, and this is what a person is offered when they are choosing. Twenty
 * findings is most of a day's reading; the user's own example was "after 5
 * finds, stop".
 */
export const DEFAULT_HUNT_FINDINGS = 5

/** The number of hours pre-selected when a person picks the time rule. */
export const DEFAULT_HUNT_HOURS = 2

/** The largest number of findings the control will offer or accept. */
export const MAX_HUNT_FINDINGS = DEFAULT_HUNT_CAP * 5

/** A hunt nobody has switched on. */
export function emptyHuntConfig(): HuntConfig {
  return {
    on: false,
    kind: 'findings',
    findings: DEFAULT_HUNT_FINDINGS,
    hours: DEFAULT_HUNT_HOURS,
    rule: '',
  }
}

/**
 * Why this configuration cannot start, or null.
 *
 * ONLY ONE THING CAN BE WRONG, and it is the one the user named: "If the user
 * toggles the loop, the user needs to configure the loop." A custom rule with
 * no sentence in it is a hunt with no way to end — the exact thing this whole
 * change exists to prevent — so it is refused rather than quietly downgraded to
 * the backstop. The number and the hours cannot be wrong: both are picked from
 * what the control offers.
 *
 * A HUNT THAT IS OFF IS NEVER A REFUSAL. Not asking for a loop is the normal
 * case and must never block a create.
 */
export function huntConfigRefusal(config: HuntConfig): string | null {
  if (!config.on) return null
  if (config.kind === 'custom') {
    const rule = config.rule.trim()
    if (rule.length === 0) return 'Say what should make it stop, or pick findings or time instead.'
    if (rule.length > MAX_HUNT_RULE_LENGTH) {
      return `That rule is too long — keep it under ${String(MAX_HUNT_RULE_LENGTH)} characters.`
    }
  }
  if (config.kind === 'findings' && (!Number.isInteger(config.findings) || config.findings < 1)) {
    return 'A hunt has to be allowed at least one finding.'
  }
  if (config.kind === 'duration' && !HUNT_STOP_HOURS.includes(config.hours as 1)) {
    return 'Pick how long it should run for.'
  }
  return null
}

/** What one create asks the CLI to start, or null when no hunt was asked for. */
export interface HuntRequest {
  /**
   * The backstop, when the person's own rule IS the backstop.
   *
   * OMITTED FOR TIME AND FOR A RULE, deliberately. A hunt bounded by hours
   * still has a backstop, but the person did not choose its number and the app
   * must not invent one — leaving `cap` off means the CLI's own default
   * applies, which is the one number in the system that nobody has to agree on.
   */
  cap?: number
  stop: LoopStopChoice
}

/** The request this configuration makes, or null when the loop is off. */
export function huntRequest(config: HuntConfig): HuntRequest | null {
  if (!config.on || huntConfigRefusal(config) !== null) return null
  if (config.kind === 'findings') {
    return { cap: config.findings, stop: { kind: 'findings' } }
  }
  if (config.kind === 'duration') {
    return { stop: { kind: 'duration', hours: config.hours } }
  }
  return { stop: { kind: 'custom', rule: config.rule.trim() } }
}

/**
 * One line saying what will actually happen — printed under the control.
 *
 * SAYS ONLY WHAT WAS CHOSEN. The time and rule forms mention the list filling
 * up as a second way it can end, because that is true and a person watching for
 * a two-hour hunt deserves to know it may finish sooner. Neither names a
 * number, because neither person picked one.
 */
export function describeHuntConfig(config: HuntConfig): string {
  if (!config.on) return ''
  if (config.kind === 'findings') {
    const unit = config.findings === 1 ? 'thing' : 'things'
    return `Keeps looking until it has filed ${String(config.findings)} ${unit}, then stops.`
  }
  if (config.kind === 'duration') {
    const unit = config.hours === 1 ? 'hour' : 'hours'
    return `Keeps looking for ${String(config.hours)} ${unit}, then stops — or sooner if the list fills up.`
  }
  const rule = config.rule.trim()
  if (rule.length === 0) return 'Say what should make it stop.'
  return `Keeps looking until this is true: ${rule}`
}

/**
 * The line under the controls — or null when the controls already say it.
 *
 * MOST OF THE TIME THEY DO. "Stop after [Findings] [5] findings" is the whole
 * sentence; printing "Keeps looking until it has filed 5 things, then stops."
 * under it is the same fact twice, on a form where every extra line pushes the
 * box a person came here to type in further down the screen. Same for a custom
 * rule, whose sentence is sitting in the field right above.
 *
 * TIME IS THE EXCEPTION, and it is why this is not simply deleted: "2 hours"
 * does not say that the hunt can also end early by filling the list, and
 * somebody who set it for the afternoon deserves to know that before they walk
 * away.
 */
export function huntConfigNote(config: HuntConfig): string | null {
  if (!config.on || config.kind !== 'duration') return null
  return describeHuntConfig(config)
}

/** The three rules, with the words the control puts on them. */
export const HUNT_STOP_CHOICES: readonly { kind: HuntStopKind; label: string }[] = [
  { kind: 'findings', label: 'Findings' },
  { kind: 'duration', label: 'Time' },
  { kind: 'custom', label: 'A rule' },
]

/**
 * WHICH LOOP A HUNT STARTED HERE WOULD RUN AS — or why none can.
 *
 * A hunt is a producer's work, and a project may have no producer, one, or
 * several. Only the middle case can be acted on without asking, so the other
 * two are named rather than guessed:
 *
 *  - NONE is not a broken state and must not read like one. A project whose
 *    loops are all consumers simply has nothing to hunt with, and the control
 *    says so instead of offering a switch that would fail on press.
 *  - SEVERAL is a real question with no default answer. Picking the first
 *    alphabetically would file findings against a mission nobody chose, and the
 *    person creating the task is the one who knows which.
 *
 * `null` for the snapshot means the loops have not been READ yet, which is a
 * third thing again: not "there are none", just "not known", and a control that
 * showed those alike would tell a person their project has no producer every
 * time the screen was slow.
 */
export type HuntTarget =
  | { ok: true; loop: string }
  | { ok: false; reason: string; loops?: readonly string[] }

export function huntTargetFor(loops: LoopsSnapshot | null): HuntTarget {
  if (loops === null) return { ok: false, reason: 'Still reading this project’s loops.' }
  const producers = loops.loops
    .filter((row) => row.engine === 'producer' && row.directiveError === undefined)
    .map((row) => row.loop)
    .sort((a, b) => a.localeCompare(b))
  if (producers.length === 1) return { ok: true, loop: producers[0] as string }
  if (producers.length === 0) {
    return { ok: false, reason: 'This project has no loop that looks for work.' }
  }
  return {
    ok: false,
    reason: 'This project has more than one loop that looks for work — pick which one.',
    loops: producers,
  }
}
