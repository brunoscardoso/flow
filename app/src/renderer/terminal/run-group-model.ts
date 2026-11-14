/**
 * THE RUN GROUP'S FACE — what the pill in the terminal tab bar says, what each
 * step's tab says, the order the tabs stand in, and the first-time picker's
 * rows. DOM-free so every sentence is testable (forbidden-pattern #12: no
 * command line, path or setting name in any of it — the commands a person
 * typed into a step are data, shown as data, never as advice).
 *
 * Main owns the Run (allowed-pattern #14); this only draws the state it reports.
 */
import type {
  RunGroupState,
  RunScopeSummary,
  RunStepState,
  RunStepStatus,
  RunSuggestion,
  RunView,
} from '../../shared/run-setup'

// ─── strings ─────────────────────────────────────────────────────────────────

/** Every fixed sentence the Run group shows — scanned by the test for #12. */
export const RUN_STRINGS = {
  setUp: 'Set up Run',
  setUpTitle: 'Choose the commands that start this project, and start them with one button',
  run: 'Run',
  runTitle: 'Start every step, in order',
  reloadAll: 'Reload all',
  reloadAllTitle: 'Restart every step, in order',
  stopAll: 'Stop all',
  stopAllTitle: 'End every step and free its ports',
  setup: 'Setup',
  setupTitle: 'Edit the Run setup',
  reloadStep: 'Reload step',
  reloadStepTitle: 'Restart only this step',
  startStepTitle: 'Not started. Click to start this step.',
  startRunTitle: 'Not started. Click to start the Run.',
  pickerAsk: 'Ask the agent to set it up',
  pickerAskTitle: 'Send a message asking the agent to propose the steps',
  pickerAskNoConversation: 'Open a conversation to ask the agent',
  pickerEmpty: 'Start empty',
  pickerContinue: 'Continue to setup',
  pickerClose: 'Close',
  stopped: 'Stopped',
  loading: 'Reading the setup…',
  failedToRead: 'The Run setup could not be read.',
  failedToAct: 'Flow could not reach the Run. Nothing was changed.',
} as const

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** "four", "12" — small counts read as words in a sentence. */
export function countWord(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n)
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
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
 * not read yet) hides it; a scope with no steps offers "Set up Run".
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
  // Every step skipped in a tweak layer is still a setup — the pill offers Setup, not "Set up Run".
  const hasShared = view.resolution.projects.some((project) => (project.setup?.steps.length ?? 0) > 0)
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

/** What clicking a step's tab that has no terminal does. */
export type PendingTabAction = 'start-run' | 'reload-step' | 'none'

export function pendingTabAction(step: RunStepState, state: RunGroupState): PendingTabAction {
  if (step.status === 'waiting' || step.status === 'starting') return 'none'
  if (!groupHasRun(state)) return 'start-run'
  return 'reload-step'
}

export function pendingTabTooltip(step: RunStepState, state: RunGroupState): string {
  const action = pendingTabAction(step, state)
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
  | { kind: 'plain'; item: T }

/**
 * Order the visible tabs: this scope's Run steps first, in step order (a step
 * with no terminal stands in as a pending tab), then every other tab exactly
 * as it was. A step whose terminal exists but is not visible is left out.
 */
export function orderRunTabs<T>(
  visible: readonly T[],
  idOf: (item: T) => string,
  state: RunGroupState | null,
): Array<OrderedRunTab<T>> {
  if (state === null || state.steps.length === 0) return visible.map((item) => ({ kind: 'plain', item }))
  const byId = new Map(visible.map((item) => [idOf(item), item]))
  const used = new Set<string>()
  const out: Array<OrderedRunTab<T>> = []
  for (const step of state.steps) {
    if (step.terminalId === null) {
      out.push({ kind: 'pending', step })
      continue
    }
    const item = byId.get(step.terminalId)
    if (item === undefined) continue
    used.add(step.terminalId)
    out.push({ kind: 'step', item, step })
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

// ─── the first-time picker ───────────────────────────────────────────────────

export interface RunPickerRow {
  /** Stable per row: project + command. */
  id: string
  command: string
  /** "jupiter-app · package.json" */
  meta: string
  suggestion: RunSuggestion
}

export function pickerRowId(suggestion: RunSuggestion): string {
  return `${suggestion.projectRoot}::${suggestion.command}`
}

/** One row per distinct command, in the order Flow found them. Nothing is ticked until the person ticks it. */
export function pickerRows(suggestions: readonly RunSuggestion[]): RunPickerRow[] {
  const seen = new Set<string>()
  const rows: RunPickerRow[] = []
  for (const suggestion of suggestions) {
    const id = pickerRowId(suggestion)
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({ id, command: suggestion.command, meta: `${suggestion.projectName} · ${suggestion.source}`, suggestion })
  }
  return rows
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export interface RunPickerText {
  title: string
  body: string
}

/** The picker's heading and its one sentence. */
export function pickerText(scopeName: string, projectNames: readonly string[], rowCount: number): RunPickerText {
  const where = listNames(projectNames.length > 0 ? projectNames : [scopeName])
  return {
    title: `Start ${scopeName} with one button`,
    body:
      rowCount > 0
        ? `Flow looked at ${where} and found these. Tick what you run, then put them in order.`
        : `Flow found nothing to start in ${where}. Start empty and add the steps you run, or ask the agent.`,
  }
}

/**
 * The message "Ask the agent to set it up" sends — a message in the person's
 * own conversation (not UI copy). The agent proposes; the person saves.
 */
export function askAgentPrompt(scopeName: string, found: readonly RunSuggestion[]): string {
  const lines = [
    `Help me set up Run for ${scopeName}: the processes I start every working session, each in its own terminal, in order.`,
    'Look at how this project is started locally and propose the steps. For each step give a name, the command, and when it starts: right away, or after the step above — and whether that step counts as ready when a port answers or when a line appears in its output.',
    'Do not start anything; I will add the steps in the Run setup myself.',
  ]
  if (found.length > 0) {
    lines.push('', 'Flow already found these commands:')
    for (const suggestion of found) lines.push(`- ${suggestion.command} (${suggestion.projectName}, ${suggestion.source})`)
  }
  return lines.join('\n')
}

// ─── the sidebar's running mark ──────────────────────────────────────────────

/** The conversation a Run's scope key belongs to, or null for a project view. */
export function threadIdOfScopeKey(scopeKey: string): string | null {
  const at = scopeKey.lastIndexOf('::')
  if (at < 0) return null
  const id = scopeKey.slice(at + 2)
  return id === '' ? null : id
}

/** Conversations with a Run going, from `run.states`. */
export function runningThreads(summaries: readonly RunScopeSummary[]): Set<string> {
  const out = new Set<string>()
  for (const summary of summaries) {
    if (summary.threadId !== null && summary.running > 0) out.add(summary.threadId)
  }
  return out
}

/**
 * Fold one `run:updated` into the running set. `changed` is false when the
 * update says nothing the sidebar draws — the caller then does nothing
 * (forbidden-pattern #14: no repaint per event).
 */
export function applyRunUpdate(
  running: ReadonlySet<string>,
  state: RunGroupState,
): { running: Set<string>; changed: boolean } {
  const threadId = threadIdOfScopeKey(state.scopeKey)
  const next = new Set(running)
  if (threadId === null) return { running: next, changed: false }
  const had = next.has(threadId)
  if (state.active) next.add(threadId)
  else next.delete(threadId)
  return { running: next, changed: had !== state.active }
}

export const RUN_MARK_TITLE = 'A Run is going in this conversation'
