/**
 * THE SETUP PANEL'S DRAFT — editing the Run's ONE ordered list of steps before
 * Save: add, remove, move, change, and which project each step runs in; the
 * sentences that say what is wrong; which layer a Save writes (Everyone / Just
 * me / This conversation); the one sentence that says what Save will do to a
 * Run that is going; and the short "Suggested" list.
 *
 * DOM-free. Every sentence is shown to a person (forbidden-pattern #12): it
 * names steps and states, never a file, a setting or a command line. Main
 * re-parses whatever is saved; this only composes the request.
 *
 *   Everyone          the shared setup — the only layer that can add, remove,
 *                     rename or reorder steps.
 *   Just me           this computer's tweaks: a command, a ready check, skip.
 *   This conversation the conversation's own tweaks, over the person's.
 */
import {
  newStepId,
  type RunGroupState,
  type RunLayer,
  type RunPlace,
  type RunProjectLayers,
  type RunReady,
  type RunSaveChange,
  type RunStep,
  type RunSuggestion,
  type RunTweak,
  type RunTweaks,
} from '../../shared/run-setup'
import { countWord } from './run-group-model'

export type ReadyKind = 'none' | 'port' | 'line'

export interface DraftStep {
  /** Stable for the draft; for a step not saved yet it is the id it will get. */
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
  /** The NAME of the project it runs in; null = the setup's own project. */
  runsIn: string | null
  /** Where a step added from a suggestion came from: "jupiter-app · package.json". */
  origin: string | null
}

export interface RunSetupDraft {
  projectRoot: string
  projectName: string
  layer: RunLayer
  steps: DraftStep[]
  /** Saved steps the person removed (Everyone only). */
  removed: string[]
  /** The steps as the draft started, to tell what changed. */
  original: DraftStep[]
}

export const LAYER_LABELS: Record<RunLayer, string> = {
  shared: 'Everyone',
  personal: 'Just me',
  conversation: 'This conversation',
}

export const LAYER_TITLES: Record<RunLayer, string> = {
  shared: 'Change the steps for everyone who works on this project',
  personal: 'Change the steps only on this computer',
  conversation: 'Change the steps only in this conversation',
}

/** Every fixed sentence the panel shows — scanned by the test for #12. */
export const SETUP_STRINGS = {
  title: 'Run setup',
  close: 'Close setup',
  intro: 'Steps start in order, each in its own terminal.',
  savesFor: 'Saves for',
  suggested: 'Suggested',
  add: 'Add',
  addStep: '+ Add a step',
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
  skip: 'Turn this step off — it stays here for later',
  unskip: 'Turn this step on',
  skipped: 'Off',
  cancel: 'Cancel',
  save: 'Save',
  saveAndRun: 'Save and run',
  saving: 'Saving…',
  askAgent: 'Ask the agent to set it up',
  askAgentTitle: 'Send a message asking the agent to propose the steps',
  askAgentNoConversation: 'Open a conversation to ask the agent',
  showLess: 'Show fewer',
  empty: 'Add the first process to start, or pick one below.',
  structureOnlyEveryone:
    'Only Everyone can add, rename, reorder or move a step to another project. Just me and This conversation can change a command, a ready check, or skip a step.',
  noConversation: 'Open a conversation to keep changes for it alone.',
  dragHandle: 'Drag to reorder',
  notHere: 'not on this computer',
} as const

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

function applyTweak(step: DraftStep, tweak: RunTweak | undefined): DraftStep {
  if (tweak === undefined) return step
  const next = { ...step }
  if (tweak.command !== undefined) next.command = tweak.command
  if (tweak.skip !== undefined) next.skipped = tweak.skip
  if (tweak.ready !== undefined) Object.assign(next, readyFields(tweak.ready ?? undefined))
  return next
}

function sameProject(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** A step's `runsIn` as the draft keeps it: null when it names the setup's own project. */
function ownProject(runsIn: string | null | undefined, projectName: string): string | null {
  if (runsIn === undefined || runsIn === null || runsIn.trim() === '' || sameProject(runsIn, projectName)) return null
  return runsIn.trim()
}

function layersBelow(layer: RunLayer): Array<'personal'> {
  return layer === 'conversation' ? ['personal'] : []
}

/** The steps as the layers BELOW `layer` leave them (what a tweak is measured against). */
function baseSteps(project: RunProjectLayers, layer: RunLayer): DraftStep[] {
  return (project.setup?.steps ?? []).map((step) => {
    let draft: DraftStep = {
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
    }
    for (const below of layersBelow(layer)) draft = applyTweak(draft, project[below][step.id])
    return draft
  })
}

/** A draft for one project at one layer: the steps as that layer sees them now. */
export function startDraft(project: RunProjectLayers, layer: RunLayer): RunSetupDraft {
  const base = baseSteps(project, layer)
  const steps =
    layer === 'shared' ? base : base.map((step) => applyTweak(step, project[layer][step.id]))
  return {
    projectRoot: project.root,
    projectName: project.name,
    layer,
    steps,
    removed: [],
    original: steps.map((step) => ({ ...step })),
  }
}

/** A draft starting from the suggestions the person ticked (added after any saved steps). */
export function draftFromSuggestions(project: RunProjectLayers, ticked: readonly RunSuggestion[]): RunSetupDraft {
  let draft = startDraft(project, 'shared')
  for (const suggestion of ticked) draft = addSuggestion(draft, suggestion)
  return draft
}

/** "Set up Run": the setup as it is, with one empty step to fill in when it has none. */
export function draftToSetUp(project: RunProjectLayers): RunSetupDraft {
  const draft = startDraft(project, 'shared')
  return draft.steps.length === 0 ? addStep(draft) : draft
}

// ─── editing ─────────────────────────────────────────────────────────────────

export function isStructural(layer: RunLayer): boolean {
  return layer === 'shared'
}

function takenIds(draft: RunSetupDraft): string[] {
  return [...draft.steps.map((step) => step.id), ...draft.removed]
}

export function addStep(
  draft: RunSetupDraft,
  fields: Partial<Pick<DraftStep, 'name' | 'command' | 'origin' | 'runsIn'>> = {},
): RunSetupDraft {
  if (!isStructural(draft.layer)) return draft
  const name = fields.name ?? ''
  const step: DraftStep = {
    id: newStepId(name || 'step', takenIds(draft)),
    isNew: true,
    name,
    command: fields.command ?? '',
    start: 'now',
    readyKind: 'none',
    readyValue: '',
    skipped: false,
    runsIn: ownProject(fields.runsIn, draft.projectName),
    origin: fields.origin ?? null,
  }
  return { ...draft, steps: [...draft.steps, step] }
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
export function addSuggestion(draft: RunSetupDraft, suggestion: RunSuggestion): RunSetupDraft {
  return addStep(draft, {
    name: freeName(draft, suggestion.name, suggestion.projectName),
    command: suggestion.command,
    runsIn: suggestion.projectName,
    origin: `${suggestion.projectName} · ${suggestion.source}`,
  })
}

/** Remove a step (Everyone) — or, in a tweak layer, skip it: a tweak cannot delete a shared step. */
export function removeStep(draft: RunSetupDraft, id: string): RunSetupDraft {
  const step = draft.steps.find((candidate) => candidate.id === id)
  if (step === undefined) return draft
  if (!isStructural(draft.layer)) return changeStep(draft, id, { skipped: !step.skipped })
  return {
    ...draft,
    steps: draft.steps.filter((candidate) => candidate.id !== id),
    removed: step.isNew ? draft.removed : [...draft.removed, id],
  }
}

export function moveStep(draft: RunSetupDraft, id: string, to: number): RunSetupDraft {
  if (!isStructural(draft.layer)) return draft
  const from = draft.steps.findIndex((step) => step.id === id)
  if (from < 0) return draft
  const target = Math.max(0, Math.min(draft.steps.length - 1, to))
  if (target === from) return draft
  const steps = [...draft.steps]
  const [step] = steps.splice(from, 1)
  steps.splice(target, 0, step)
  return { ...draft, steps }
}

/** Fields a tweak layer may change; the rest belong to Everyone. */
const TWEAKABLE: ReadonlySet<keyof DraftStep> = new Set(['command', 'readyKind', 'readyValue', 'skipped'])

export type StepPatch = Partial<
  Pick<DraftStep, 'name' | 'command' | 'start' | 'readyKind' | 'readyValue' | 'skipped' | 'runsIn'>
>

export function changeStep(draft: RunSetupDraft, id: string, patch: StepPatch): RunSetupDraft {
  const allowed: StepPatch = {}
  for (const [key, value] of Object.entries(patch) as Array<[keyof StepPatch, never]>) {
    if (isStructural(draft.layer) || TWEAKABLE.has(key)) allowed[key] = value
  }
  if (Object.keys(allowed).length === 0) return draft
  if ('runsIn' in allowed) allowed.runsIn = ownProject(allowed.runsIn, draft.projectName)
  return {
    ...draft,
    steps: draft.steps.map((step) => (step.id === id ? { ...step, ...allowed } : step)),
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
export function validateDraft(draft: RunSetupDraft, options: { hasConversation: boolean }): string[] {
  const problems: string[] = []
  if (draft.layer === 'conversation' && !options.hasConversation) problems.push(SETUP_STRINGS.noConversation)
  const names = new Map<string, number>()
  draft.steps.forEach((step, index) => {
    // A row nobody has typed in is not a problem: Save leaves it out.
    if (isBlankStep(step)) return
    // An empty name is filled from the command on Save.
    const name = step.name.trim() === '' ? nameFromCommand(step.command) : step.name.trim()
    const label = name === '' ? `Step ${index + 1}` : `“${name}”`
    if (name !== '') names.set(name.toLowerCase(), (names.get(name.toLowerCase()) ?? 0) + 1)
    if (step.command.trim() === '') problems.push(`${label} needs a command to run.`)
    if (step.readyKind === 'port' && parsePort(step.readyValue) === null) {
      problems.push(
        step.readyValue.trim() === ''
          ? `${label} waits for a port, but no port is given.`
          : `${label} waits for a port, but “${step.readyValue.trim()}” is not a port number.`,
      )
    }
    if (step.readyKind === 'line' && step.readyValue.trim() === '') {
      problems.push(`${label} waits for a line, but the text to wait for is empty.`)
    }
    if (index === 0 && step.start === 'after-previous' && !step.skipped) {
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
    a.skipped === b.skipped
  )
}

export interface DraftDiff {
  added: DraftStep[]
  changed: DraftStep[]
  removed: DraftStep[]
  /** The order of the saved steps changed. */
  moved: boolean
  /** Steps a tweak layer newly skips / un-skips. */
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
  const out: RunStep = { id: step.id, name: step.name.trim(), command: step.command.trim(), start: step.start }
  const ready = readyOf(step)
  if (ready !== undefined && ready !== 'invalid') out.ready = ready
  if (step.readyTimeoutMs !== undefined) out.readyTimeoutMs = step.readyTimeoutMs
  if (step.runsIn !== null && step.runsIn.trim() !== '') out.runsIn = step.runsIn.trim()
  if (step.skipped) out.disabled = true
  return out
}

function readyKey(ready: RunReady | undefined | 'invalid'): string {
  if (ready === undefined) return ''
  if (ready === 'invalid') return 'invalid'
  return ready.kind === 'port' ? `port:${ready.port}` : `line:${ready.text}`
}

/**
 * The one change a Save sends. Everyone writes the whole step list; a tweak
 * layer writes, for every shared step, only what differs from the layers
 * below it (an unchanged step drops its tweak). `existing` is the layer's
 * current tweaks — kept for steps the shared setup no longer names.
 */
export function saveChange(
  draft: RunSetupDraft,
  project: RunProjectLayers,
): RunSaveChange {
  if (draft.layer === 'shared') {
    return { layer: 'shared', projectRoot: draft.projectRoot, setup: { version: 1, steps: savedSteps(draft.steps).map(toRunStep) } }
  }
  const below = new Map(baseSteps(project, draft.layer).map((step) => [step.id, step]))
  const existing: RunTweaks = project[draft.layer]
  const tweaks: RunTweaks = {}
  for (const [id, tweak] of Object.entries(existing)) {
    if (!below.has(id)) tweaks[id] = tweak
  }
  for (const step of draft.steps) {
    const base = below.get(step.id)
    if (base === undefined) continue
    const tweak: RunTweak = {}
    if (step.command.trim() !== base.command.trim()) tweak.command = step.command.trim()
    const ready = readyOf(step)
    if (readyKey(ready) !== readyKey(readyOf(base)) && ready !== 'invalid') tweak.ready = ready ?? null
    if (step.skipped !== base.skipped) tweak.skip = step.skipped
    if (Object.keys(tweak).length > 0) tweaks[step.id] = tweak
  }
  return { layer: draft.layer, projectRoot: draft.projectRoot, tweaks }
}

// ─── the sentence ────────────────────────────────────────────────────────────

const GOING = new Set(['waiting', 'starting', 'running', 'ready'])

function quoteList(steps: readonly DraftStep[], one: string, many: string): string {
  if (steps.length === 1) return `${one} “${steps[0].name.trim() || 'the new step'}”`
  return `${many.replace('#', countWord(steps.length))}`
}

const LAYER_REACH: Record<RunLayer, string> = {
  shared: 'Everyone working on this project gets the change.',
  personal: 'Only on this computer.',
  conversation: 'Only in this conversation.',
}

/**
 * What Save will do, in one or two sentences: which steps start, restart and
 * stop when a Run is going (the rest keep running), or that nothing starts
 * until Run when none is.
 */
export function saveSentence(draft: RunSetupDraft, state: RunGroupState | null): string {
  if (!isDirty(draft)) return 'Nothing has changed yet.'
  const diff = diffDraft(draft)
  const reach = LAYER_REACH[draft.layer]
  const prefix = `${draft.projectRoot}::`
  const going = (state?.active ?? false)
    ? state!.steps.filter((step) => step.key.startsWith(prefix) && GOING.has(step.status))
    : []
  if (going.length === 0) {
    return `Saving keeps the new setup; nothing starts until you press Run. ${reach}`
  }
  const goingIds = new Set(going.map((step) => step.key.slice(prefix.length)))
  const starts = [...diff.added, ...diff.unskipped]
  const restarts = diff.changed.filter((step) => goingIds.has(step.id))
  const stops = [...diff.removed, ...diff.skipped].filter((step) => goingIds.has(step.id))
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
  /** '' is the setup's own project. */
  value: string
  label: string
  /** Named by the step but not one of the projects Flow can run it in here. */
  missing: boolean
}

/**
 * The "Runs in" choices for a step: the setup's own project first, then every
 * other project a step can run in here. A project the step names that is not
 * among them is kept (marked), so opening the panel never loses it.
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
