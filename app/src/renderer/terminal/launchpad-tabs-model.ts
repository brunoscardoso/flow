/**
 * THE GROUPED LAUNCHPAD TAB — DOM-free.
 *
 * Every step that starts with Run used to get its own tab beside the shells.
 * They play as one group, so they now share ONE tab: "Launchpad", a count and
 * one dot per step. Inside it a sub-bar picks All (side by side, or one log
 * with every line labelled) or a single step's own terminal.
 *
 * This module decides what the strip, the sub-bar, the caret menu and each
 * pane header say, and remembers which view each group was left on. It never
 * touches a terminal: the panel moves the real xterm hosts (forbidden-pattern
 * #12: no command, path or setting name in any sentence here).
 */
import type { RunGroupState, RunStepState } from '../../shared/run-setup'
import { orderRunTabs, stepTabFace, type OrderedRunTab, type RunDotTone } from './run-group-model'

// ─── strings ─────────────────────────────────────────────────────────────────

/** Every fixed sentence of the grouped tab — scanned by the test for #12. */
export const LAUNCHPAD_TAB_STRINGS = {
  label: 'Launchpad',
  starting: 'Starting',
  stopped: 'Stopped',
  all: 'All',
  allSteps: 'All steps',
  sideBySide: 'Side by side',
  oneLog: 'One log',
  layoutGroup: 'How to show every step',
  wholeGroup: 'Every step',
  restartAll: 'Restart all',
  restartAllTitle: 'Restart every step, in order',
  stopAll: 'Stop all',
  stopAllTitle: 'End every step and free its ports',
  open: 'Open',
  openTitle: 'Show only this step, where you can type',
  restart: 'Restart',
  restartTitle: 'Restart only this step',
  start: 'Start',
  startTitle: 'Start only this step',
  stop: 'Stop',
  stopTitle: 'End only this step',
  stopIdleTitle: 'This step is not running',
  separate: 'Show as separate tabs',
  group: 'Group Launchpad tabs',
  caretTitle: 'Jump to a step',
  stepMenuTitle: 'Launchpad options',
  notStarted: 'Not started yet.',
  logEmpty: 'Nothing printed yet.',
} as const

// ─── tab ids ─────────────────────────────────────────────────────────────────

export const GROUP_TAB_PREFIX = 'launchpad-group:'

/** The group tab's id — one per Run scope. */
export function groupTabId(scopeKey: string): string {
  return `${GROUP_TAB_PREFIX}${scopeKey}`
}

export function isGroupTabId(id: string | null): boolean {
  return id !== null && id.startsWith(GROUP_TAB_PREFIX)
}

// ─── a step's state, in words ────────────────────────────────────────────────

/** The dot: ok = running/ready, busy = starting/waiting, bad = failed, off = stopped/idle. */
export function stepTone(step: RunStepState): RunDotTone {
  return stepTabFace(step).tone
}

/** A step's state in one or two words: "ready", "running", "exited 1". */
export function stepStateText(step: RunStepState): string {
  switch (step.status) {
    case 'ready':
      return 'ready'
    case 'running':
      return 'running'
    case 'starting':
      return 'starting'
    case 'waiting':
      return 'waiting'
    case 'blocked':
      return step.notHere === true ? "can't start" : 'port busy'
    case 'timed-out':
      return 'not ready'
    case 'exited':
      if (step.exitCode === 0) return 'finished'
      return step.exitCode === null ? 'exited' : `exited ${step.exitCode}`
    case 'stopped':
      return 'stopped'
    case 'idle':
    default:
      return 'not started'
  }
}

/** A process is going (or on its way): its primary action is Restart, and Stop is live. */
export function stepIsGoing(step: RunStepState): boolean {
  return step.status === 'running' || step.status === 'ready' || step.status === 'starting' || step.status === 'waiting'
}

// ─── the strip ───────────────────────────────────────────────────────────────

export interface GroupTabEntry {
  kind: 'group'
  id: string
  scopeKey: string
  /** The steps the tab holds, in step order. */
  steps: RunStepState[]
}

export type StripEntry<T> = OrderedRunTab<T> | GroupTabEntry

/**
 * The tab strip's entries. Separate (`grouped: false`) is exactly today's
 * order. Grouped folds every step tab (and every step still waiting for its
 * terminal) into one group entry, standing where the first step stood; the
 * one-time actions and plain shells keep their own tabs, unchanged.
 */
export function planStrip<T>(
  visible: readonly T[],
  idOf: (item: T) => string,
  state: RunGroupState | null,
  grouped: boolean,
): Array<StripEntry<T>> {
  const ordered = orderRunTabs(visible, idOf, state)
  if (!grouped || state === null) return ordered
  const steps: RunStepState[] = []
  let at = -1
  const out: Array<StripEntry<T>> = []
  for (const entry of ordered) {
    if (entry.kind === 'step' || entry.kind === 'pending') {
      if (at === -1) at = out.length
      steps.push(entry.step)
      continue
    }
    out.push(entry)
  }
  if (steps.length === 0) return out
  out.splice(at, 0, { kind: 'group', id: groupTabId(state.scopeKey), scopeKey: state.scopeKey, steps })
  return out
}

export interface GroupTabFace {
  /** The state, not the name: "3 of 4 running" (the header button already says Launchpad). */
  label: string
  tones: RunDotTone[]
  tooltip: string
}

/**
 * What the group tab shows: one dot per step and what is running — "4 running",
 * "3 of 4 running", "Starting", "Stopped". No count: the dots already count the
 * steps, and the name lives on the Launchpad button beside the tabs
 * (user decision 2026-11-18).
 */
export function groupTabFace(steps: readonly RunStepState[]): GroupTabFace {
  const tones = steps.map(stepTone)
  const parts: string[] = []
  const going = tones.filter((tone) => tone === 'ok').length
  const busy = tones.filter((tone) => tone === 'busy').length
  const bad = tones.filter((tone) => tone === 'bad').length
  if (going > 0) parts.push(`${going} running`)
  if (busy > 0) parts.push(`${busy} starting`)
  if (bad > 0) parts.push(`${bad} not running as expected`)
  const stoppedCount = steps.length - going - busy - bad
  if (stoppedCount > 0) parts.push(`${stoppedCount} stopped`)
  return {
    label: groupTabLabel(steps.length, going, busy),
    tones,
    tooltip: `${LAUNCHPAD_TAB_STRINGS.label}: ${parts.join(', ')}`,
  }
}

function groupTabLabel(total: number, going: number, busy: number): string {
  if (total > 0 && going === total) return `${total} running`
  if (going > 0) return `${going} of ${total} running`
  return busy > 0 ? LAUNCHPAD_TAB_STRINGS.starting : LAUNCHPAD_TAB_STRINGS.stopped
}

// ─── projects ────────────────────────────────────────────────────────────────

/** True when the group's steps run in more than one project — then each step names its project. */
export function spansProjects(steps: readonly RunStepState[]): boolean {
  return new Set(steps.map((step) => step.projectRoot)).size > 1
}

// ─── the sub-bar ─────────────────────────────────────────────────────────────

export type GroupSelection = 'all' | { step: string }

export type GroupLayout = 'tiles' | 'log'

export interface SubBarItem {
  /** 'all', or the step's key. */
  key: string
  label: string
  tone: RunDotTone | null
  /**
   * The project name, only when the group spans projects — shown as the
   * button's tooltip, never as text: each pane's header already names its
   * project (user decision 2026-11-18).
   */
  project: string | null
  pressed: boolean
}

export interface SubBar {
  items: SubBarItem[]
  /** The Side by side | One log switch — only while All is selected. */
  showLayout: boolean
  layout: GroupLayout
}

export function subBar(
  steps: readonly RunStepState[],
  view: { selection: GroupSelection; layout: GroupLayout },
  projectNameOf: (projectRoot: string) => string,
): SubBar {
  const multi = spansProjects(steps)
  const selectedKey = view.selection === 'all' ? 'all' : view.selection.step
  return {
    items: [
      { key: 'all', label: LAUNCHPAD_TAB_STRINGS.all, tone: null, project: null, pressed: selectedKey === 'all' },
      ...steps.map((step) => ({
        key: step.key,
        label: step.name,
        tone: stepTone(step),
        project: multi ? projectNameOf(step.projectRoot) : null,
        pressed: selectedKey === step.key,
      })),
    ],
    showLayout: selectedKey === 'all',
    layout: view.layout,
  }
}

// ─── a pane's header ─────────────────────────────────────────────────────────

export interface PaneFace {
  key: string
  name: string
  tone: RunDotTone
  /** The project name — always shown in a pane header. */
  project: string
  state: string
  tooltip: string
  /** 'Restart' while it is going, 'Start' when it is not. */
  primary: string
  primaryTitle: string
  canStop: boolean
  stopTitle: string
  /** No terminal yet (never started, or its tab was closed). */
  hasTerminal: boolean
}

export function paneFace(step: RunStepState, projectNameOf: (projectRoot: string) => string): PaneFace {
  const going = stepIsGoing(step)
  const startable = !(step.notHere === true)
  return {
    key: step.key,
    name: step.name,
    tone: stepTone(step),
    project: projectNameOf(step.projectRoot),
    state: stepStateText(step),
    tooltip: stepTabFace(step).tooltip,
    primary: going || !startable ? LAUNCHPAD_TAB_STRINGS.restart : LAUNCHPAD_TAB_STRINGS.start,
    primaryTitle: going ? LAUNCHPAD_TAB_STRINGS.restartTitle : step.detail ?? LAUNCHPAD_TAB_STRINGS.startTitle,
    canStop: going,
    stopTitle: going ? LAUNCHPAD_TAB_STRINGS.stopTitle : LAUNCHPAD_TAB_STRINGS.stopIdleTitle,
    hasTerminal: step.terminalId !== null,
  }
}

// ─── the caret menus ─────────────────────────────────────────────────────────

export type GroupMenuEntry =
  | { kind: 'all'; label: string }
  | { kind: 'step'; key: string; label: string; tone: RunDotTone; state: string }
  | { kind: 'separator' }
  | { kind: 'separate'; label: string }

/** The group tab's caret: All steps, each step with its dot and state, then Show as separate tabs. */
export function groupMenu(steps: readonly RunStepState[]): GroupMenuEntry[] {
  return [
    { kind: 'all', label: LAUNCHPAD_TAB_STRINGS.allSteps },
    { kind: 'separator' },
    ...steps.map((step) => ({
      kind: 'step' as const,
      key: step.key,
      label: step.name,
      tone: stepTone(step),
      state: stepStateText(step),
    })),
    { kind: 'separator' },
    { kind: 'separate', label: LAUNCHPAD_TAB_STRINGS.separate },
  ]
}

/** A step tab's caret, in separate mode: the way back. */
export function separateStepMenu(): Array<{ kind: 'group'; label: string }> {
  return [{ kind: 'group', label: LAUNCHPAD_TAB_STRINGS.group }]
}

// ─── the preference ──────────────────────────────────────────────────────────

/** Where the panel keeps "group Launchpad tabs" (per app, this computer). */
export const LAUNCHPAD_GROUPED_KEY = 'flow.terminal.launchpadGrouped'

/** Grouped unless a person chose separate tabs. */
export function parseGrouped(raw: string | null): boolean {
  return raw !== 'false'
}

export function serializeGrouped(grouped: boolean): string {
  return grouped ? 'true' : 'false'
}

// ─── which view each group was left on ───────────────────────────────────────

export interface GroupView {
  selection: GroupSelection
  layout: GroupLayout
}

export const DEFAULT_GROUP_VIEW: GroupView = { selection: 'all', layout: 'tiles' }

/**
 * The view each group was left on, while the app runs: All or a step, and
 * Side by side or One log. A step that left the group falls back to All; the
 * layout is kept.
 */
export class GroupViewMemory {
  readonly #views = new Map<string, GroupView>()

  get(scopeKey: string, steps: readonly Pick<RunStepState, 'key'>[]): GroupView {
    const view = this.#views.get(scopeKey) ?? DEFAULT_GROUP_VIEW
    if (view.selection !== 'all') {
      const key = view.selection.step
      if (!steps.some((step) => step.key === key)) return { selection: 'all', layout: view.layout }
    }
    return view
  }

  select(scopeKey: string, selection: GroupSelection): void {
    const view = this.#views.get(scopeKey) ?? DEFAULT_GROUP_VIEW
    this.#views.set(scopeKey, { ...view, selection: selection === 'all' ? 'all' : { step: selection.step } })
  }

  setLayout(scopeKey: string, layout: GroupLayout): void {
    const view = this.#views.get(scopeKey) ?? DEFAULT_GROUP_VIEW
    this.#views.set(scopeKey, { ...view, layout })
  }
}

/** The step selected in a view, or null for All. */
export function selectedStep(view: GroupView): string | null {
  return view.selection === 'all' ? null : view.selection.step
}

// ─── which step a terminal belongs to ────────────────────────────────────────

/**
 * The step key a terminal's output belongs to: the group's own answer first,
 * then the terminal's run tag (its output can arrive before the state names
 * its terminal). Null for anything that is not a running step.
 */
export function stepKeyOfTerminal(
  state: RunGroupState | null,
  terminalId: string,
  run: { scopeKey: string; stepId: string; projectRoot: string } | undefined,
): string | null {
  const known = state?.steps.find((step) => step.terminalId === terminalId)
  if (known !== undefined) return known.key
  if (run === undefined) return null
  if (state !== null && run.scopeKey !== state.scopeKey) return null
  const key = `${run.projectRoot}::${run.stepId}`
  if (state !== null && !state.steps.some((step) => step.key === key)) return null
  return key
}
