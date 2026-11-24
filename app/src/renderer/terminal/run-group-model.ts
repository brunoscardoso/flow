/**
 * THE LAUNCHPAD'S FACE — what the pill in the terminal tab bar says, what its
 * menu offers, what each step's (and each one-time action's) tab says, the
 * order the tabs stand in, and the ask before a one-time action runs. DOM-free so every sentence is testable (forbidden-pattern #12: no
 * command line, path or setting name in any of it — the commands a person
 * typed into a step are data, shown as data, never as advice).
 *
 * Main owns the Run (allowed-pattern #14); this only draws the state it reports.
 */
import {
  scriptLineCount,
  type ResolvedRunStep,
  type RunGroupState,
  type RunOnceState,
  type RunStepState,
  type RunStepStatus,
  type RunSuggestion,
  type RunView,
} from '../../shared/run-setup'

// ─── strings ─────────────────────────────────────────────────────────────────

/** Every fixed sentence the Launchpad shows — scanned by the test for #12. */
export const RUN_STRINGS = {
  setUp: 'Set up run steps',
  setUpTitle: 'Choose the commands that start this project, and the ones you run now and then',
  launchpad: 'Run',
  launchpadTitle: 'Open a terminal, run a one-time action, or start every running step',
  run: 'Run',
  runTitle: 'Start every step, in order',
  runAll: 'Run all running steps',
  runAllGoing: 'Every running step has started',
  runAllNone: 'No running steps yet',
  menuOnce: 'Run once',
  noOnce: 'No one-time actions yet',
  addOnce: 'Add one',
  editLaunchpad: 'Edit run steps',
  asksFirst: 'asks first',
  onceRunningTitle: 'Running now. Press to show it.',
  onceRunTitle: 'Run this once, in its own tab',
  confirmCancel: 'Cancel',
  confirmRun: 'Run',
  confirmRunScript: 'Run script',
  bodyCommand: 'command',
  reloadAll: 'Reload all',
  reloadAllTitle: 'Restart every step, in order',
  stopAll: 'Stop all',
  stopAllTitle: 'End every step and free its ports',
  setup: 'Setup',
  setupTitle: 'Edit the run steps',
  reloadStep: 'Reload step',
  reloadStepTitle: 'Restart only this step',
  startStepTitle: 'Not started. Click to start this step.',
  startRunTitle: 'Not started. Click to start every running step.',
  stopped: 'Stopped',
  loading: 'Reading the run steps…',
  failedToRead: 'The run steps could not be read.',
  failedToAct: 'Flow could not reach the run steps. Nothing was changed.',
  failedToRunOnce: 'Flow could not run this action. Nothing was started.',
} as const

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** "four", "12" — small counts read as words in a sentence. */
export function countWord(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n)
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

/** "12 lines", "1 line". */
export function linesLabel(count: number): string {
  return `${count} ${plural(count, 'line', 'lines')}`
}

/** What a one-time action holds, as the Launchpad menu says it: "command", or "script · 12 lines". */
export function onceBodyLabel(step: Pick<ResolvedRunStep, 'body' | 'command'>): string {
  return step.body === 'script' ? `script · ${linesLabel(scriptLineCount(step.command))}` : RUN_STRINGS.bodyCommand
}

// ─── the pill ────────────────────────────────────────────────────────────────

export type RunPillMode = 'hidden' | 'set-up' | 'ready' | 'going' | 'stopped'

export interface RunPillFace {
  mode: RunPillMode
  /** The pill's short count — "4 running", "3 steps", "Stopped" — or null. */
  summary: string | null
  /** Hover sentence for the summary (what is waiting or failed). */
  summaryTitle: string
  /** The Run button is offered (nothing is going). */
  canRun: boolean
  /** Reload all / Stop all are offered (something has started). */
  canReload: boolean
  canStop: boolean
}

const GOING: ReadonlySet<RunStepStatus> = new Set(['starting', 'running', 'ready'])
const FAILED: ReadonlySet<RunStepStatus> = new Set(['blocked', 'timed-out'])

function isFailed(step: RunStepState): boolean {
  return FAILED.has(step.status) || (step.status === 'exited' && step.exitCode !== 0)
}

/** True once any step of the group has been started (or tried to). */
export function groupHasRun(state: RunGroupState | null): boolean {
  return state !== null && state.steps.some((step) => step.status !== 'idle' || step.terminalId !== null)
}

/**
 * The pill: `null` view (no Run for this panel — no project, older preload,
 * not read yet) hides it; a scope with no steps offers "Set up Launchpad".
 */
export function pillFace(view: RunView | null): RunPillFace {
  const hidden: RunPillFace = {
    mode: 'hidden',
    summary: null,
    summaryTitle: '',
    canRun: false,
    canReload: false,
    canStop: false,
  }
  if (view === null) return hidden
  const steps = view.state.steps.length > 0 ? view.state.steps : null
  const setupCount = view.resolution.steps.length
  // Every step turned off is still a setup — the pill offers Setup, not "Set up Run".
  const hasShared = (view.resolution.project.setup?.steps.length ?? 0) > 0
  if (steps === null && setupCount === 0 && !hasShared) {
    return { ...hidden, mode: 'set-up' }
  }
  const all = steps ?? []
  const going = all.filter((step) => GOING.has(step.status)).length
  const waiting = all.filter((step) => step.status === 'waiting').length
  const failed = all.filter(isFailed).length
  const details: string[] = []
  if (waiting > 0) details.push(`${countWord(waiting)} ${plural(waiting, 'step is', 'steps are')} waiting`)
  if (failed > 0) details.push(`${countWord(failed)} ${plural(failed, 'step has', 'steps have')} stopped with a problem`)
  const summaryTitle = details.length === 0 ? '' : `${capitalize(details.join(', '))}.`

  if (view.state.active) {
    const parts = [`${going} running`]
    if (waiting > 0) parts.push(`${waiting} waiting`)
    if (failed > 0) parts.push(`${failed} failed`)
    return { mode: 'going', summary: parts.join(' · '), summaryTitle, canRun: false, canReload: true, canStop: true }
  }
  if (groupHasRun(view.state)) {
    const summary = failed > 0 ? `${RUN_STRINGS.stopped} · ${failed} failed` : RUN_STRINGS.stopped
    return { mode: 'stopped', summary, summaryTitle, canRun: true, canReload: true, canStop: false }
  }
  const count = Math.max(setupCount, all.length)
  return {
    mode: 'ready',
    summary: `${count} ${plural(count, 'step', 'steps')}`,
    summaryTitle: '',
    canRun: count > 0,
    canReload: false,
    canStop: false,
  }
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1)
}

// ─── a step's tab ────────────────────────────────────────────────────────────

/** The dot's meaning; the view maps each to a colour token. */
export type RunDotTone = 'ok' | 'busy' | 'bad' | 'off'

export interface RunStepTabFace {
  label: string
  tone: RunDotTone
  /** Set up but not started: dashed and italic. */
  pending: boolean
  tooltip: string
}

/** What one step's tab says. `name` is the step's own name (data). */
export function stepTabFace(step: RunStepState): RunStepTabFace {
  const name = step.name
  const face = (suffix: string | null, tone: RunDotTone, fallback: string, pending = false): RunStepTabFace => ({
    label: suffix === null ? name : `${name} · ${suffix}`,
    tone,
    pending,
    tooltip: step.detail ?? fallback,
  })
  switch (step.status) {
    case 'running':
      return face(null, 'ok', `“${name}” is running.`)
    case 'ready':
      return face(null, 'ok', `“${name}” is running and ready.`)
    case 'starting':
      return face('starting', 'busy', `“${name}” is starting.`)
    case 'waiting':
      return face('waiting', 'busy', `“${name}” is waiting.`)
    case 'blocked':
      if (step.notHere === true) return face("can't start", 'bad', `“${name}” can't start on this computer.`)
      return face('port busy', 'bad', `“${name}” was not started because its port is in use.`)
    case 'timed-out':
      return face('not ready', 'bad', `“${name}” did not become ready in time.`)
    case 'exited':
      return step.exitCode === 0
        ? face('finished', 'off', `“${name}” finished.`)
        : face(step.exitCode === null ? 'ended' : `ended (${step.exitCode})`, 'bad', `“${name}” ended.`)
    case 'stopped':
      return face('stopped', 'off', `“${name}” was stopped.`)
    case 'idle':
    default:
      return face('not started', 'off', `“${name}” has not started.`, true)
  }
}

// ─── a one-time action's tab ─────────────────────────────────────────────────

/** "2.4 s", "12 s", "3 min 5 s" — how long a one-time action ran. */
export function durationLabel(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (safe < 10_000) return `${(Math.round(safe / 100) / 10).toFixed(1)} s`
  const total = Math.round(safe / 1000)
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`
}

export interface RunOnceTabFace {
  label: string
  tone: RunDotTone
  /** Finished cleanly: the tab shows a check. */
  finished: boolean
  tooltip: string
}

/** What a one-time action's tab says: running, finished (with how long), or ended with its code. */
export function onceTabFace(once: RunOnceState): RunOnceTabFace {
  const name = once.name
  const took = once.durationMs === null ? '' : ` in ${durationLabel(once.durationMs)}`
  if (once.status === 'running') {
    return { label: `${name} · running`, tone: 'busy', finished: false, tooltip: `“${name}” is running in ${once.projectName}.` }
  }
  if (once.status === 'stopped') {
    return { label: `${name} · stopped`, tone: 'off', finished: false, tooltip: `“${name}” was stopped.` }
  }
  if (once.exitCode === 0) {
    return { label: `${name} · finished`, tone: 'ok', finished: true, tooltip: `Finished${took}.` }
  }
  const code = once.exitCode === null ? '' : ` (${once.exitCode})`
  const after = once.durationMs === null ? '' : ` after ${durationLabel(once.durationMs)}`
  return {
    label: `${name} · ended${code}`,
    tone: 'bad',
    finished: false,
    tooltip: once.exitCode === null ? `Ended${after}.` : `Ended with code ${once.exitCode}${after}.`,
  }
}

/** The one-time action a terminal runs in this group, or null. */
export function onceOfTerminal(state: RunGroupState | null, terminalId: string | null): RunOnceState | null {
  if (state === null || terminalId === null) return null
  return (state.once ?? []).find((once) => once.terminalId === terminalId) ?? null
}

/** What clicking a step's tab that has no terminal does. */
export type PendingTabAction = 'start-run' | 'reload-step' | 'none'

export function pendingTabAction(step: RunStepState, state: RunGroupState): PendingTabAction {
  if (step.status === 'waiting' || step.status === 'starting') return 'none'
  // Its project is not on this computer: clicking can start nothing.
  if (step.notHere === true && groupHasRun(state)) return 'none'
  if (!groupHasRun(state)) return 'start-run'
  return 'reload-step'
}

export function pendingTabTooltip(step: RunStepState, state: RunGroupState): string {
  const action = pendingTabAction(step, state)
  if (step.notHere === true && step.detail !== null) return step.detail
  if (step.status === 'idle') {
    if (action === 'start-run') return RUN_STRINGS.startRunTitle
    if (action === 'reload-step') return RUN_STRINGS.startStepTitle
  }
  return stepTabFace(step).tooltip
}

// ─── tab order (note 9) ──────────────────────────────────────────────────────

/** Tab ids for a step that has no terminal yet. */
export const PENDING_TAB_PREFIX = 'run-step:'

export function pendingTabId(stepKey: string): string {
  return `${PENDING_TAB_PREFIX}${stepKey}`
}

export function stepKeyOfPendingTab(id: string): string | null {
  return id.startsWith(PENDING_TAB_PREFIX) ? id.slice(PENDING_TAB_PREFIX.length) : null
}

export type OrderedRunTab<T> =
  | { kind: 'step'; item: T; step: RunStepState }
  | { kind: 'pending'; step: RunStepState }
  | { kind: 'once'; item: T; once: RunOnceState }
  | { kind: 'plain'; item: T }

/**
 * Order the visible tabs: this scope's Run steps first, in step order (a step
 * with no terminal stands in as a pending tab), then its one-time actions'
 * tabs in the order they were first pressed (never pending: an action has a
 * tab only once it ran), then every other tab exactly as it was. A step whose
 * terminal exists but is not visible is left out.
 */
export function orderRunTabs<T>(
  visible: readonly T[],
  idOf: (item: T) => string,
  state: RunGroupState | null,
): Array<OrderedRunTab<T>> {
  if (state === null || (state.steps.length === 0 && (state.once ?? []).length === 0)) {
    return visible.map((item) => ({ kind: 'plain', item }))
  }
  const byId = new Map(visible.map((item) => [idOf(item), item]))
  const used = new Set<string>()
  const out: Array<OrderedRunTab<T>> = []
  for (const step of state.steps) {
    if (step.terminalId === null) {
      // A tab the person closed is gone, not a placeholder reading "stopped".
      if (step.status === 'stopped') continue
      out.push({ kind: 'pending', step })
      continue
    }
    const item = byId.get(step.terminalId)
    if (item === undefined) continue
    used.add(step.terminalId)
    out.push({ kind: 'step', item, step })
  }
  for (const once of state.once ?? []) {
    if (once.terminalId === null) continue
    const item = byId.get(once.terminalId)
    if (item === undefined || used.has(once.terminalId)) continue
    used.add(once.terminalId)
    out.push({ kind: 'once', item, once })
  }
  for (const item of visible) {
    if (!used.has(idOf(item))) out.push({ kind: 'plain', item })
  }
  return out
}

/** The step a terminal runs in this group, or null. */
export function stepOfTerminal(state: RunGroupState | null, terminalId: string | null): RunStepState | null {
  if (state === null || terminalId === null) return null
  return state.steps.find((step) => step.terminalId === terminalId) ?? null
}

// ─── the Launchpad menu ──────────────────────────────────────────────────────

export interface LaunchpadMenuItem {
  key: string
  name: string
  /** The person's own command or script — data. */
  command: string
  /** The small text under its name: "command", or "script · 12 lines". */
  detail: string
  /** It holds a script (run as one file). */
  script: boolean
  /** "asks first" is shown beside it. */
  asksFirst: boolean
  /** A run of it is going: pressing it shows its tab. */
  running: boolean
  /** Its project is not on this computer: it can't run. */
  disabled: boolean
  title: string
}

export interface LaunchpadMenuGroup {
  projectName: string
  items: LaunchpadMenuItem[]
}

export interface LaunchpadMenu {
  groups: LaunchpadMenuGroup[]
  /** No one-time action is turned on: the menu says so and offers to add one. */
  empty: boolean
  /** "Run all running steps": shown when there are running steps; disabled while they run. */
  runAll: { shown: boolean; disabled: boolean; title: string }
  /** "Reload all": shown once the running steps have been started (moved here from the pill). */
  reloadAll: boolean
  /** "Stop all": shown while the running steps run (moved here from the pill). */
  stopAll: boolean
}

/**
 * What the Launchpad menu offers: the conversation's one-time actions that
 * are turned on, grouped by the project they run in (first-seen order), then
 * "Run all running steps" and "Edit Launchpad".
 */
export function launchpadMenu(view: RunView | null): LaunchpadMenu {
  const once: readonly ResolvedRunStep[] = view?.resolution.once ?? []
  const states = new Map((view?.state.once ?? []).map((entry) => [entry.key, entry]))
  const groups: LaunchpadMenuGroup[] = []
  for (const step of once) {
    const running = states.get(step.key)?.status === 'running'
    const disabled = step.unavailable !== undefined
    const item: LaunchpadMenuItem = {
      key: step.key,
      name: step.name,
      command: step.command,
      detail: onceBodyLabel(step),
      script: step.body === 'script',
      asksFirst: step.confirm === true,
      running,
      disabled,
      title: disabled ? (step.unavailable ?? '') : running ? RUN_STRINGS.onceRunningTitle : RUN_STRINGS.onceRunTitle,
    }
    const group = groups.find((candidate) => candidate.projectName.toLowerCase() === step.projectName.toLowerCase())
    if (group !== undefined) group.items.push(item)
    else groups.push({ projectName: step.projectName, items: [item] })
  }
  const services = view?.resolution.steps.length ?? 0
  const active = view?.state.active ?? false
  const face = pillFace(view)
  return {
    groups,
    empty: groups.length === 0,
    runAll: {
      shown: services > 0,
      disabled: services === 0 || active,
      title: services === 0 ? RUN_STRINGS.runAllNone : active ? RUN_STRINGS.runAllGoing : RUN_STRINGS.runTitle,
    },
    reloadAll: face.canReload,
    stopAll: face.canStop,
  }
}

/** The menu's items in keyboard order (arrow keys move through them). */
export type LaunchpadMenuEntry =
  | { kind: 'once'; key: string }
  | { kind: 'add' }
  | { kind: 'run-all' }
  | { kind: 'reload-all' }
  | { kind: 'stop-all' }
  | { kind: 'edit' }

export function launchpadMenuEntries(menu: LaunchpadMenu): LaunchpadMenuEntry[] {
  const out: LaunchpadMenuEntry[] = []
  for (const group of menu.groups) for (const item of group.items) if (!item.disabled) out.push({ kind: 'once', key: item.key })
  if (menu.empty) out.push({ kind: 'add' })
  if (menu.runAll.shown && !menu.runAll.disabled) out.push({ kind: 'run-all' })
  if (menu.reloadAll) out.push({ kind: 'reload-all' })
  if (menu.stopAll) out.push({ kind: 'stop-all' })
  out.push({ kind: 'edit' })
  return out
}

/** The next focus index for an arrow key, wrapping. */
export function moveMenuFocus(current: number, count: number, key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): number {
  if (count <= 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (current < 0) return key === 'ArrowDown' ? 0 : count - 1
  return key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count
}

export interface RunOnceAsk {
  title: string
  where: string
  /** The command, or the WHOLE script — shown in full before anything runs. */
  command: string
  /** It is a script: shown in a scrolling block, and the button says "Run script". */
  script: boolean
  /** The button that runs it. */
  run: string
}

/**
 * The ask before a one-time action runs: its name, where it runs — the
 * conversation's checkout of its project, or the project's folder when it has
 * none — and the command itself, or the whole script.
 */
export function onceAsk(
  step: Pick<ResolvedRunStep, 'name' | 'projectName' | 'projectRoot' | 'cwd' | 'command' | 'body'>,
): RunOnceAsk {
  const checkout = step.cwd !== step.projectRoot
  const script = step.body === 'script'
  const what = script ? 'This script runs' : 'This runs'
  return {
    title: `Run “${step.name}”?`,
    where: checkout
      ? `${what} in ${step.projectName}, in this conversation's checkout:`
      : `${what} in ${step.projectName}, in its folder:`,
    command: step.command,
    script,
    run: script ? RUN_STRINGS.confirmRunScript : RUN_STRINGS.confirmRun,
  }
}

// ─── asking the agent ────────────────────────────────────────────────────────

/**
 * The message "Ask the agent to set it up" sends — a message in the person's
 * own conversation (not UI copy). The agent proposes; the person saves.
 */
export function askAgentPrompt(
  scopeName: string,
  found: readonly RunSuggestion[],
  projectNames: readonly string[] = [],
): string {
  const others = projectNames.filter((name) => name !== scopeName)
  const lines = [
    `Help me set up the Launchpad for ${scopeName}: the processes I start every working session, each in its own terminal, in one order.`,
    'Look at how this project is started locally and propose the steps. For each step give a name, the command, the project it runs in, and when it starts: right away, or after the step above — and whether that step counts as ready when a port answers or when a line appears in its output.',
    'Do not start anything; I will add the steps in the Launchpad myself.',
  ]
  if (others.length > 0) lines.splice(2, 0, `A step can also run in ${others.join(', ')}.`)
  if (found.length > 0) {
    lines.push('', 'Flow already found these commands:')
    for (const suggestion of found) lines.push(`- ${suggestion.command} (${suggestion.projectName}, ${suggestion.source})`)
  }
  return lines.join('\n')
}

// ─── the sidebar's running mark ──────────────────────────────────────────────

