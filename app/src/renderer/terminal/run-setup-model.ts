/**
 * THE LAUNCHPAD PAGE'S DRAFT — editing the ONE combined list of entries
 * before Save: add, remove, move, change, and which of the conversation's
 * projects each step runs in; the sentences that say what is wrong; the one
 * sentence that says what Save will do to a Run that is going; and the short
 * "Suggested" list.
 *
 * The list is every step of every project of the conversation, in the one
 * order kept on this computer. Each step belongs to the project it runs in;
 * Save sends the whole list and main stores each step with its project.
 *
 * Two kinds of entry share that list: RUNNING steps (they start with Run, in
 * order, each in its own tab) and ONE-TIME actions (never started by Run; a
 * person presses one from the Launchpad menu). The page shows them as two
 * sections; moving an entry moves it among its own kind only.
 *
 * DOM-free. Every sentence is shown to a person (forbidden-pattern #12): it
 * names steps and states, never a file, a setting or a command line. Main
 * re-parses whatever is saved; this only composes the request.
 */
import {
  confirmByDefault,
  newStepId,
  type RunGroupState,
  type RunPlace,
  type RunProjectLayers,
  type RunReady,
  type RunSaveChange,
  type RunStep,
  type RunSuggestion,
} from '../../shared/run-setup'
import { countWord } from './run-group-model'

export type ReadyKind = 'none' | 'port' | 'line'

export interface DraftStep {
  /** Stable for the draft: a saved step's reference, or the id a new step will be given. */
  id: string
  isNew: boolean
  name: string
  command: string
  start: 'now' | 'after-previous'
  readyKind: ReadyKind
  /** The port or the text, as typed. */
  readyValue: string
  readyTimeoutMs?: number
  /** The step is turned off: kept for later, not started by Run. */
  skipped: boolean
  /** The NAME of the project it runs in; null = the conversation's main project. */
  runsIn: string | null
  /** Where a step added from a suggestion came from: "jupiter-app · package.json". */
  origin: string | null
  /** A running step (starts with Run) or a one-time action (pressed from the menu). */
  kind: 'service' | 'once'
  /** One-time actions: ask before running. */
  confirm: boolean
  /**
   * The person set "Ask before running" themselves (or the action was saved
   * already): the command no longer decides it.
   */
  confirmTouched: boolean
}

export interface RunSetupDraft {
  /** The conversation's main project. */
  projectRoot: string
  projectName: string
  steps: DraftStep[]
  /** Saved steps the person removed. */
  removed: string[]
  /** The steps as the draft started, to tell what changed. */
  original: DraftStep[]
}

/** Every fixed sentence the page shows — scanned by the test for #12. */
export const SETUP_STRINGS = {
  title: 'Launchpad',
  close: 'Close the Launchpad',
  keepsRunning: 'Keeps running',
  keepsRunningNote: 'Starts with Run, in this order. Each gets its own tab.',
  runsOnce: 'Runs once',
  runsOnceNote: 'Never starts with Run. Press it from the Launchpad menu when you need it.',
  suggested: 'Suggested',
  add: 'Add',
  addStep: '+ Add a running step',
  addOnce: '+ Add a one-time action',
  name: 'Name',
  command: 'Command',
  runsIn: 'Runs in',
  starts: 'Starts',
  readyWhen: 'Ready when',
  startsNow: 'Right away',
  readyNone: 'Nothing',
  readyPort: 'A port answers',
  readyLine: 'A line appears',
  portPlaceholder: 'Port',
  linePlaceholder: 'Text to wait for',
  namePlaceholder: 'Name',
  commandPlaceholder: 'Command to run',
  moveUp: 'Move up',
  moveDown: 'Move down',
  remove: 'Remove step',
  removeOnce: 'Remove action',
  skip: 'Turn this step off — it stays here for later',
  unskip: 'Turn this step on',
  skipOnce: 'Turn this action off — it stays here for later',
  unskipOnce: 'Turn this action on',
  skipped: 'Off',
  askFirst: 'Ask before running',
  askFirstTitle: 'Show the command and ask before it runs',
  cancel: 'Cancel',
  save: 'Save',
  saveAndRun: 'Save and run',
  saving: 'Saving…',
  askAgent: 'Ask the agent to set it up',
  askAgentTitle: 'Send a message asking the agent to propose the steps',
  askAgentNoConversation: 'Open a conversation to ask the agent',
  showLess: 'Show fewer',
  empty: 'Add the first process to start, or pick one below.',
  onceEmpty: 'No one-time actions yet.',
  dragHandle: 'Drag to reorder',
  notHere: 'not in this conversation',
} as const

/** The page's title: "Launchpad for jupiter-app, jupiter-core" — the conversation's projects. */
export function setupTitle(places: readonly Pick<RunPlace, 'name'>[], fallback = ''): string {
  const names: string[] = []
  for (const place of places) {
    if (place.name.trim() !== '' && !names.some((name) => sameProject(name, place.name))) names.push(place.name.trim())
  }
  if (names.length === 0 && fallback.trim() !== '') names.push(fallback.trim())
  return names.length === 0 ? SETUP_STRINGS.title : `${SETUP_STRINGS.title} for ${names.join(', ')}`
}

/** "Show all (12)". */
export function showAllLabel(count: number): string {
  return `Show all (${count})`
}

/** What a suggestion already in the draft says instead of its Add button. */
export function addedAsLabel(position: number): string {
  return `Added as step ${position}`
}

// ─── building a draft ────────────────────────────────────────────────────────

function readyFields(ready: RunReady | undefined): { readyKind: ReadyKind; readyValue: string } {
  if (ready === undefined) return { readyKind: 'none', readyValue: '' }
  return ready.kind === 'port'
    ? { readyKind: 'port', readyValue: String(ready.port) }
    : { readyKind: 'line', readyValue: ready.text }
}

function sameProject(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** A step's `runsIn` as the draft keeps it: null when it names the setup's own project. */
function ownProject(runsIn: string | null | undefined, projectName: string): string | null {
  if (runsIn === undefined || runsIn === null || runsIn.trim() === '' || sameProject(runsIn, projectName)) return null
  return runsIn.trim()
}

/** A draft of the combined list: the steps as they are saved now. */
export function startDraft(project: RunProjectLayers): RunSetupDraft {
  const steps: DraftStep[] = (project.setup?.steps ?? []).map((step) => ({
    id: step.id,
    isNew: false,
    name: step.name,
    command: step.command,
    start: step.start,
    ...readyFields(step.ready),
    ...(step.readyTimeoutMs !== undefined ? { readyTimeoutMs: step.readyTimeoutMs } : {}),
    skipped: step.disabled === true,
    runsIn: ownProject(step.runsIn, project.name),
    origin: null,
    kind: step.kind === 'once' ? 'once' : 'service',
    confirm: step.kind === 'once' && step.confirm === true,
    // A saved action keeps the choice it was saved with.
    confirmTouched: true,
  }))
  return {
    projectRoot: project.root,
    projectName: project.name,
    steps,
    removed: [],
    original: steps.map((step) => ({ ...step })),
  }
}

/** A draft starting from the suggestions the person ticked (added after any saved steps). */
export function draftFromSuggestions(project: RunProjectLayers, ticked: readonly RunSuggestion[]): RunSetupDraft {
  let draft = startDraft(project)
  for (const suggestion of ticked) draft = addSuggestion(draft, suggestion)
  return draft
}

/** "Set up Launchpad": the setup as it is, with one empty running step to fill in when it has none. */
export function draftToSetUp(project: RunProjectLayers): RunSetupDraft {
  const draft = startDraft(project)
  return draft.steps.length === 0 ? addStep(draft) : draft
}

// ─── editing ─────────────────────────────────────────────────────────────────

function takenIds(draft: RunSetupDraft): string[] {
  return [...draft.steps.map((step) => step.id), ...draft.removed]
}

export function addStep(
  draft: RunSetupDraft,
  fields: Partial<Pick<DraftStep, 'name' | 'command' | 'origin' | 'runsIn' | 'kind'>> = {},
): RunSetupDraft {
  const name = fields.name ?? ''
  const kind = fields.kind ?? 'service'
  const command = fields.command ?? ''
  const step: DraftStep = {
    id: newStepId(name || (kind === 'once' ? 'action' : 'step'), takenIds(draft)),
    isNew: true,
    name,
    command,
    start: 'now',
    readyKind: 'none',
    readyValue: '',
    skipped: false,
    runsIn: ownProject(fields.runsIn, draft.projectName),
    origin: fields.origin ?? null,
    kind,
    confirm: kind === 'once' && confirmByDefault(command),
    confirmTouched: false,
  }
  return { ...draft, steps: [...draft.steps, step] }
}

/** Add a one-time action (it asks first by default when its command changes data). */
export function addOnceAction(
  draft: RunSetupDraft,
  fields: Partial<Pick<DraftStep, 'name' | 'command' | 'origin' | 'runsIn'>> = {},
): RunSetupDraft {
  return addStep(draft, { ...fields, kind: 'once' })
}

/** The draft's entries of one kind, in order. */
export function stepsOfKind(draft: Pick<RunSetupDraft, 'steps'>, kind: DraftStep['kind']): DraftStep[] {
  return draft.steps.filter((step) => step.kind === kind)
}

/** A name no other step of the draft has: the suggestion's, else with its project, else numbered. */
function freeName(draft: RunSetupDraft, wanted: string, projectName: string): string {
  const taken = new Set(draft.steps.map((step) => step.name.trim().toLowerCase()))
  const base = wanted.trim() === '' ? 'step' : wanted.trim()
  if (!taken.has(base.toLowerCase())) return base
  const withProject = `${base} (${projectName})`
  if (!taken.has(withProject.toLowerCase())) return withProject
  let n = 2
  while (taken.has(`${base} ${n}`.toLowerCase())) n += 1
  return `${base} ${n}`
}

/** Add a suggestion as a step that runs in the suggestion's project, its command filled in. */
/** How many suggestions a step offers at once; anything else is typed. */
export const STEP_SUGGESTION_LIMIT = 5

/**
 * The suggestions ONE step offers: only for its kind (long-running commands
 * for a running step, one-shot jobs for a one-time action) and only for the
 * project its Runs in names (the main project when it names none), matching what is typed so far,
 * leaving out commands another step of that project already runs — at most
 * five, best first (the order main ranked them in).
 */
export function stepSuggestions(
  draft: RunSetupDraft,
  stepId: string,
  suggestions: readonly RunSuggestion[],
  limit = STEP_SUGGESTION_LIMIT,
): RunSuggestion[] {
  const step = draft.steps.find((candidate) => candidate.id === stepId)
  if (step === undefined) return []
  const project = step.runsIn ?? draft.projectName
  const projectOf = (other: DraftStep): string => other.runsIn ?? draft.projectName
  const taken = new Set(
    draft.steps
      .filter((other) => other.id !== stepId && other.kind === step.kind && sameProject(projectOf(other), project))
      .map((other) => other.command.trim().toLowerCase()),
  )
  const query = step.command.trim().toLowerCase()
  const out: RunSuggestion[] = []
  const use = step.kind === 'once' ? 'once' : undefined
  for (const suggestion of suggestions) {
    if (suggestion.use !== use) continue
    if (!sameProject(suggestion.projectName, project)) continue
    const command = suggestion.command.trim().toLowerCase()
    if (taken.has(command) || command === query) continue
    if (query !== '' && !command.includes(query) && !suggestion.name.toLowerCase().includes(query)) continue
    out.push(suggestion)
    if (out.length >= limit) break
  }
  return out
}

export function addSuggestion(draft: RunSetupDraft, suggestion: RunSuggestion): RunSetupDraft {
  return addStep(draft, {
    name: freeName(draft, suggestion.name, suggestion.projectName),
    command: suggestion.command,
    runsIn: suggestion.projectName,
    origin: `${suggestion.projectName} · ${suggestion.source}`,
  })
}

/** Remove a step from the list. */
export function removeStep(draft: RunSetupDraft, id: string): RunSetupDraft {
  const step = draft.steps.find((candidate) => candidate.id === id)
  if (step === undefined) return draft
  return {
    ...draft,
    steps: draft.steps.filter((candidate) => candidate.id !== id),
    removed: step.isNew ? draft.removed : [...draft.removed, id],
  }
}

/**
 * Move an entry to position `to` among the entries of ITS OWN kind (running
 * steps and one-time actions are ordered separately); the other kind keeps
 * every place it had.
 */
export function moveStep(draft: RunSetupDraft, id: string, to: number): RunSetupDraft {
  const moving = draft.steps.find((step) => step.id === id)
  if (moving === undefined) return draft
  const same = stepsOfKind(draft, moving.kind)
  const from = same.indexOf(moving)
  const target = Math.max(0, Math.min(same.length - 1, to))
  if (target === from) return draft
  const reordered = [...same]
  reordered.splice(from, 1)
  reordered.splice(target, 0, moving)
  let next = 0
  const steps = draft.steps.map((step) => (step.kind === moving.kind ? reordered[next++]! : step))
  return { ...draft, steps }
}

export type StepPatch = Partial<
  Pick<DraftStep, 'name' | 'command' | 'start' | 'readyKind' | 'readyValue' | 'skipped' | 'runsIn' | 'confirm'>
>

export function changeStep(draft: RunSetupDraft, id: string, patch: StepPatch): RunSetupDraft {
  const allowed: StepPatch = { ...patch }
  if (Object.keys(allowed).length === 0) return draft
  if ('runsIn' in allowed) allowed.runsIn = ownProject(allowed.runsIn, draft.projectName)
  return {
    ...draft,
    steps: draft.steps.map((step) => {
      if (step.id !== id) return step
      const next: DraftStep = { ...step, ...allowed }
      if (step.kind !== 'once') {
        next.confirm = false
        return next
      }
      // A one-time action has no start mode or ready check.
      next.start = 'now'
      next.readyKind = 'none'
      next.readyValue = ''
      if ('confirm' in allowed) next.confirmTouched = true
      else if ('command' in allowed && !step.confirmTouched) next.confirm = confirmByDefault(next.command)
      return next
    }),
  }
}

// ─── validation ──────────────────────────────────────────────────────────────

function parsePort(value: string): number | null {
  const text = value.trim()
  if (!/^\d+$/.test(text)) return null
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : null
}

function readyOf(step: DraftStep): RunReady | undefined | 'invalid' {
  if (step.readyKind === 'none') return undefined
  if (step.readyKind === 'port') {
    const port = parsePort(step.readyValue)
    return port === null ? 'invalid' : { kind: 'port', port }
  }
  return step.readyValue.trim() === '' ? 'invalid' : { kind: 'line', text: step.readyValue }
}

/** Plain sentences saying what keeps the draft from saving; empty when it can be saved. */
export function validateDraft(draft: RunSetupDraft): string[] {
  const problems: string[] = []
  const names = new Map<string, number>()
  draft.steps.forEach((step, index) => {
    // A row nobody has typed in is not a problem: Save leaves it out.
    if (isBlankStep(step)) return
    // An empty name is filled from the command on Save.
    const name = step.name.trim() === '' ? nameFromCommand(step.command) : step.name.trim()
    const label = name === '' ? `Step ${index + 1}` : `“${name}”`
    if (name !== '') names.set(name.toLowerCase(), (names.get(name.toLowerCase()) ?? 0) + 1)
    if (step.command.trim() === '') problems.push(`${label} needs a command to run.`)
    if (step.kind === 'service' && step.readyKind === 'port' && parsePort(step.readyValue) === null) {
      problems.push(
        step.readyValue.trim() === ''
          ? `${label} waits for a port, but no port is given.`
          : `${label} waits for a port, but “${step.readyValue.trim()}” is not a port number.`,
      )
    }
    if (step.kind === 'service' && step.readyKind === 'line' && step.readyValue.trim() === '') {
      problems.push(`${label} waits for a line, but the text to wait for is empty.`)
    }
    const serviceIndex = draft.steps.filter((other, at) => at < index && other.kind === 'service').length
    if (step.kind === 'service' && serviceIndex === 0 && step.start === 'after-previous' && !step.skipped) {
      problems.push(`${label} is the first step, so it has no step to wait for. Set it to start right away.`)
    }
  })
  for (const step of draft.steps) {
    const key = step.name.trim().toLowerCase()
    if (key !== '' && (names.get(key) ?? 0) > 1) {
      problems.push(`Two steps are called “${step.name.trim()}”. Give each its own name.`)
      names.set(key, 0)
    }
  }
  return problems
}

// ─── what changed ────────────────────────────────────────────────────────────

function sameRun(a: DraftStep, b: DraftStep): boolean {
  return (
    a.name.trim() === b.name.trim() &&
    a.command.trim() === b.command.trim() &&
    a.start === b.start &&
    (a.runsIn ?? '') === (b.runsIn ?? '') &&
    a.readyKind === b.readyKind &&
    (a.readyKind === 'none' || a.readyValue.trim() === b.readyValue.trim()) &&
    a.skipped === b.skipped &&
    a.kind === b.kind &&
    a.confirm === b.confirm
  )
}

export interface DraftDiff {
  added: DraftStep[]
  changed: DraftStep[]
  removed: DraftStep[]
  /** The order of the saved steps changed. */
  moved: boolean
  /** Steps newly turned off / on. */
  skipped: DraftStep[]
  unskipped: DraftStep[]
}

export function diffDraft(draft: RunSetupDraft): DraftDiff {
  const original = new Map(draft.original.map((step) => [step.id, step]))
  const added: DraftStep[] = []
  const changed: DraftStep[] = []
  const skipped: DraftStep[] = []
  const unskipped: DraftStep[] = []
  for (const step of draft.steps) {
    const before = original.get(step.id)
    if (before === undefined && isBlankStep(step)) continue
    if (before === undefined) {
      added.push(step)
      continue
    }
    if (step.skipped !== before.skipped) {
      ;(step.skipped ? skipped : unskipped).push(step)
      continue
    }
    if (!sameRun(step, before)) changed.push(step)
  }
  const removed = draft.removed.map((id) => original.get(id)).filter((step): step is DraftStep => step !== undefined)
  const keptOrder = draft.steps.filter((step) => original.has(step.id)).map((step) => step.id)
  const originalOrder = draft.original.filter((step) => keptOrder.includes(step.id)).map((step) => step.id)
  const moved = keptOrder.join('\n') !== originalOrder.join('\n')
  return { added, changed, removed, moved, skipped, unskipped }
}

export function isDirty(draft: RunSetupDraft): boolean {
  const diff = diffDraft(draft)
  return (
    diff.added.length + diff.changed.length + diff.removed.length + diff.skipped.length + diff.unskipped.length > 0 ||
    diff.moved
  )
}

// ─── the save request ────────────────────────────────────────────────────────

/** A row with neither a name nor a command — the empty step the panel opens with. */
export function isBlankStep(step: Pick<DraftStep, 'name' | 'command'>): boolean {
  return step.name.trim() === '' && step.command.trim() === ''
}

/** A short name for a command: `npm run dev` → "dev", `docker compose up kafka` → "kafka". */
export function nameFromCommand(command: string): string {
  const words = command.trim().split(/\s+/).filter((word) => word !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  if (words.length === 0) return ''
  const program = (words[0]!.split('/').pop() ?? words[0]!).toLowerCase()
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    if (words[1] === 'run' && words[2] !== undefined) return words[2]
    if (words[1] !== undefined) return words[1]
  }
  if ((program === 'docker' && words[1] === 'compose') || program === 'docker-compose') {
    const rest = words.slice(program === 'docker' ? 3 : 2).filter((word) => !word.startsWith('-'))
    return rest.length > 0 ? rest.join(' ') : 'compose'
  }
  if ((program === 'make' || program === 'just') && words[1] !== undefined) return words[1]
  if (program === 'uv' && words[1] === 'run' && words[2] !== undefined) {
    return words[2] === 'python' && words[3] === '-m' && words[4] !== undefined ? words[4] : words[2]
  }
  return words.slice(0, 2).join(' ')
}

/** The steps Save writes: blank rows left out, an empty name filled from the command (kept unique). */
function savedSteps(steps: readonly DraftStep[]): DraftStep[] {
  const taken = new Set(steps.map((step) => step.name.trim().toLowerCase()).filter((name) => name !== ''))
  return steps
    .filter((step) => !isBlankStep(step))
    .map((step) => {
      if (step.name.trim() !== '') return step
      const base = nameFromCommand(step.command) || 'step'
      let name = base
      for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} ${n}`
      taken.add(name.toLowerCase())
      return { ...step, name }
    })
}

function toRunStep(step: DraftStep): RunStep {
  if (step.kind === 'once') {
    const once: RunStep = { id: step.id, name: step.name.trim(), command: step.command.trim(), start: 'now', kind: 'once' }
    if (step.confirm) once.confirm = true
    if (step.runsIn !== null && step.runsIn.trim() !== '') once.runsIn = step.runsIn.trim()
    if (step.skipped) once.disabled = true
    return once
  }
  const out: RunStep = { id: step.id, name: step.name.trim(), command: step.command.trim(), start: step.start }
  const ready = readyOf(step)
  if (ready !== undefined && ready !== 'invalid') out.ready = ready
  if (step.readyTimeoutMs !== undefined) out.readyTimeoutMs = step.readyTimeoutMs
  if (step.runsIn !== null && step.runsIn.trim() !== '') out.runsIn = step.runsIn.trim()
  if (step.skipped) out.disabled = true
  return out
}

/**
 * The one change a Save sends: the whole combined list, in order. A saved
 * step keeps its id (main knows from it where the step is stored); its
 * `runsIn` names the project it runs in, absent for the main project.
 */
export function saveChange(draft: RunSetupDraft): RunSaveChange {
  return { layer: 'shared', steps: savedSteps(draft.steps).map(toRunStep) }
}

// ─── the sentence ────────────────────────────────────────────────────────────

const GOING = new Set(['waiting', 'starting', 'running', 'ready'])

function quoteList(steps: readonly DraftStep[], one: string, many: string): string {
  if (steps.length === 1) return `${one} “${steps[0].name.trim() || 'the new step'}”`
  return `${many.replace('#', countWord(steps.length))}`
}

/** Where a saved change reaches: this computer, and every conversation with these projects. */
const REACH = 'Kept on this computer, for every conversation with these projects.'

/**
 * What Save will do, in one or two sentences: which steps start, restart and
 * stop when a Run is going (the rest keep running), or that nothing starts
 * until Run when none is.
 */
export function saveSentence(draft: RunSetupDraft, state: RunGroupState | null): string {
  if (!isDirty(draft)) return 'Nothing has changed yet.'
  const diff = diffDraft(draft)
  const reach = REACH
  // A saved step's id in the draft IS its key in the Run.
  const going = (state?.active ?? false) ? state!.steps.filter((step) => GOING.has(step.status)) : []
  if (going.length === 0) {
    return `Saving keeps the new setup; nothing starts until you press Run. ${reach}`
  }
  const goingIds = new Set(going.map((step) => step.key))
  // A one-time action never starts, restarts or stops with a save.
  const service = (step: DraftStep): boolean => step.kind === 'service'
  const starts = [...diff.added, ...diff.unskipped].filter(service)
  const restarts = diff.changed.filter((step) => service(step) && goingIds.has(step.id))
  const stops = [...diff.removed, ...diff.skipped].filter((step) => service(step) && goingIds.has(step.id))
  const touched = new Set([...restarts, ...stops].map((step) => step.id))
  const keep = [...goingIds].filter((id) => !touched.has(id)).length

  const actions: string[] = []
  if (starts.length > 0) actions.push(starts.length === 1 ? 'starts the new step' : `starts ${countWord(starts.length)} new steps`)
  if (restarts.length > 0) actions.push(quoteList(restarts, 'restarts', 'restarts # changed steps'))
  if (stops.length > 0) actions.push(quoteList(stops, 'stops', 'stops # steps'))
  const parts: string[] = []
  if (actions.length > 0) {
    const last = actions.pop()!
    parts.push(`Saving ${actions.length > 0 ? `${actions.join(', ')} and ${last}` : last}.`)
  } else {
    parts.push('Saving changes no running step.')
  }
  if (keep > 0) {
    const others = touched.size > 0
    parts.push(
      keep === 1
        ? `The ${others ? 'other ' : ''}running one keeps running.`
        : `The ${countWord(keep)} ${others ? 'other ' : ''}running ones keep running.`,
    )
  }
  parts.push(reach)
  return parts.join(' ')
}

/** The step's name as other rows speak of it. */
function stepWord(step: DraftStep | undefined | null, fallback: string): string {
  const name = step?.name.trim() ?? ''
  return name === '' ? fallback : name
}

/**
 * The "Starts" choices for the step at `index`, named after the step above:
 * "After temporal" when it has no ready check, "When temporal is ready" when
 * it has one (the Run waits for exactly that). The first step can only start
 * right away — the option is offered (disabled) only if it already says so.
 */
export function startsOptions(
  steps: readonly DraftStep[],
  index: number,
): Array<{ value: 'now' | 'after-previous'; label: string; disabled: boolean }> {
  const previous = index > 0 ? steps[index - 1] : null
  const name = stepWord(previous, 'the step above')
  const after =
    previous === null
      ? 'After the step above'
      : previous.readyKind === 'none'
        ? `After ${name}`
        : `When ${name} is ready`
  return [
    { value: 'now', label: SETUP_STRINGS.startsNow, disabled: false },
    { value: 'after-previous', label: after, disabled: previous === null },
  ]
}

/** The short line for a step: when it starts and when it counts as ready. */
export function startsLabel(steps: readonly DraftStep[], index: number): string {
  const step = steps[index]
  const option = startsOptions(steps, index).find((candidate) => candidate.value === step.start)
  const when =
    step.start === 'after-previous' && index > 0 && option !== undefined
      ? option.label.charAt(0).toLowerCase() + option.label.slice(1)
      : 'right away'
  if (step.readyKind === 'port' && step.readyValue.trim() !== '') return `${when} · ready on port ${step.readyValue.trim()}`
  if (step.readyKind === 'line' && step.readyValue.trim() !== '') return `${when} · ready on a line`
  return when
}

// ─── where a step runs ───────────────────────────────────────────────────────

export interface RunsInChoice {
  /** '' is the main project. */
  value: string
  label: string
  /** Named by the step but not one of the projects Flow can run it in here. */
  missing: boolean
}

/**
 * The "Runs in" choices for a step: the conversation's projects, the main one
 * first. A project the step names that is not among them is kept (marked), so
 * opening the panel never loses it — Save refuses it with a sentence.
 */
export function runsInChoices(
  draft: RunSetupDraft,
  places: readonly Pick<RunPlace, 'name' | 'root'>[],
  step: Pick<DraftStep, 'runsIn'>,
): RunsInChoice[] {
  const out: RunsInChoice[] = [{ value: '', label: draft.projectName, missing: false }]
  for (const place of places) {
    if (place.root === null || sameProject(place.name, draft.projectName)) continue
    if (out.some((choice) => sameProject(choice.label, place.name))) continue
    out.push({ value: place.name, label: place.name, missing: false })
  }
  if (step.runsIn !== null && !out.some((choice) => sameProject(choice.value, step.runsIn ?? ''))) {
    out.push({ value: step.runsIn, label: `${step.runsIn} · ${SETUP_STRINGS.notHere}`, missing: true })
  }
  return out
}

// ─── the "Suggested" list ────────────────────────────────────────────────────

/** How many suggestions show before "Show all". */
export const TOP_SUGGESTIONS = 4

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

function matches(draft: RunSetupDraft, step: DraftStep, suggestion: RunSuggestion): boolean {
  return (
    normalizeCommand(step.command) === normalizeCommand(suggestion.command) &&
    sameProject(step.runsIn ?? draft.projectName, suggestion.projectName)
  )
}

export interface OfferedSuggestion {
  suggestion: RunSuggestion
  /** "jupiter-app · you ran it 6 times" */
  meta: string
  /** 1-based position of the step it was added as in this draft, or null. */
  addedAs: number | null
}

export interface SuggestionGroup {
  projectName: string
  items: OfferedSuggestion[]
}

export interface OfferedSuggestions {
  top: OfferedSuggestion[]
  groups: SuggestionGroup[]
  total: number
}

/**
 * What the "Suggested" list offers: suggestions arrive ranked (usage first);
 * one per (project, command); a command already a SAVED step is left out; one
 * added in this draft stays, saying which step it became. `top` is the first
 * few; `groups` is everything, grouped by project in first-seen order.
 */
export function offeredSuggestions(
  draft: RunSetupDraft,
  suggestions: readonly RunSuggestion[],
  limit = TOP_SUGGESTIONS,
): OfferedSuggestions {
  const seen = new Set<string>()
  const items: OfferedSuggestion[] = []
  for (const suggestion of suggestions) {
    if (suggestion.use === 'once') continue // a running step's list only
    const key = `${suggestion.projectName.toLowerCase()}::${normalizeCommand(suggestion.command)}`
    if (seen.has(key)) continue
    seen.add(key)
    if (draft.steps.some((step) => !step.isNew && matches(draft, step, suggestion))) continue
    const index = draft.steps.findIndex((step) => step.isNew && matches(draft, step, suggestion))
    items.push({
      suggestion,
      meta: `${suggestion.projectName} · ${suggestion.source}`,
      addedAs: index < 0 ? null : index + 1,
    })
  }
  const groups: SuggestionGroup[] = []
  for (const item of items) {
    const group = groups.find((candidate) => sameProject(candidate.projectName, item.suggestion.projectName))
    if (group !== undefined) group.items.push(item)
    else groups.push({ projectName: item.suggestion.projectName, items: [item] })
  }
  return { top: items.slice(0, limit), groups, total: items.length }
}
