/**
 * THE SETUP PANEL'S DRAFT — editing a project's Run steps before Save: add,
 * remove, move, change; the sentences that say what is wrong; which layer a
 * Save writes (Everyone / Just me / This conversation); and the one sentence
 * that says what Save will do to a Run that is going.
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
  /** Tweak layers only: the step is skipped. */
  skipped: boolean
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
  savesFor: 'Saves for',
  suggested: 'Suggested:',
  addStep: '+ Add a step',
  newStep: 'New step',
  name: 'Name',
  command: 'Command',
  starts: 'Starts',
  readyWhen: 'Ready when',
  startsNow: 'Right away',
  startsAfter: 'After the step above',
  readyNone: 'It has started',
  readyPort: 'A port answers',
  readyLine: 'A line appears',
  portPlaceholder: 'Port',
  linePlaceholder: 'Text to wait for',
  moveUp: 'Move up',
  moveDown: 'Move down',
  remove: 'Remove step',
  skip: 'Skip this step',
  unskip: 'Run this step again',
  skipped: 'skipped',
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Saving…',
  project: 'Project',
  empty: 'No steps yet. Add the first one below.',
  structureOnlyEveryone:
    'Only Everyone can add, rename or reorder steps. Just me and This conversation can change a command, a ready check, or skip a step.',
  noConversation: 'Open a conversation to keep changes for it alone.',
  dragHandle: 'Drag to reorder',
} as const

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
      skipped: false,
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

/** A draft for a project with no setup yet, starting from the suggestions the person ticked. */
export function draftFromSuggestions(
  project: Pick<RunProjectLayers, 'root' | 'name'>,
  ticked: readonly RunSuggestion[],
): RunSetupDraft {
  let draft: RunSetupDraft = {
    projectRoot: project.root,
    projectName: project.name,
    layer: 'shared',
    steps: [],
    removed: [],
    original: [],
  }
  for (const suggestion of ticked) draft = addSuggestion(draft, suggestion)
  return draft
}

// ─── editing ─────────────────────────────────────────────────────────────────

export function isStructural(layer: RunLayer): boolean {
  return layer === 'shared'
}

function takenIds(draft: RunSetupDraft): string[] {
  return [...draft.steps.map((step) => step.id), ...draft.removed]
}

export function addStep(draft: RunSetupDraft, fields: Partial<Pick<DraftStep, 'name' | 'command' | 'origin'>> = {}): RunSetupDraft {
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
    origin: fields.origin ?? null,
  }
  return { ...draft, steps: [...draft.steps, step] }
}

export function addSuggestion(draft: RunSetupDraft, suggestion: RunSuggestion): RunSetupDraft {
  return addStep(draft, {
    name: suggestion.name,
    command: suggestion.command,
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

export type StepPatch = Partial<Pick<DraftStep, 'name' | 'command' | 'start' | 'readyKind' | 'readyValue' | 'skipped'>>

export function changeStep(draft: RunSetupDraft, id: string, patch: StepPatch): RunSetupDraft {
  const allowed: StepPatch = {}
  for (const [key, value] of Object.entries(patch) as Array<[keyof StepPatch, never]>) {
    if (isStructural(draft.layer) ? key !== 'skipped' : TWEAKABLE.has(key)) allowed[key] = value
  }
  if (Object.keys(allowed).length === 0) return draft
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
    const name = step.name.trim()
    const label = name === '' ? `Step ${index + 1}` : `“${name}”`
    if (name === '') problems.push(`Step ${index + 1} needs a name.`)
    else names.set(name.toLowerCase(), (names.get(name.toLowerCase()) ?? 0) + 1)
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

function toRunStep(step: DraftStep): RunStep {
  const out: RunStep = { id: step.id, name: step.name.trim(), command: step.command.trim(), start: step.start }
  const ready = readyOf(step)
  if (ready !== undefined && ready !== 'invalid') out.ready = ready
  if (step.readyTimeoutMs !== undefined) out.readyTimeoutMs = step.readyTimeoutMs
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
    return { layer: 'shared', projectRoot: draft.projectRoot, setup: { version: 1, steps: draft.steps.map(toRunStep) } }
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

/** The short line under a step row: when it starts and when it counts as ready. */
export function startsLabel(steps: readonly DraftStep[], index: number): string {
  const step = steps[index]
  const previous = index > 0 ? steps[index - 1] : null
  const when =
    step.start === 'after-previous' && previous !== null
      ? `after ${previous.name.trim() || 'the step above'}`
      : 'right away'
  if (step.readyKind === 'port' && step.readyValue.trim() !== '') return `${when} · ready on port ${step.readyValue.trim()}`
  if (step.readyKind === 'line' && step.readyValue.trim() !== '') return `${when} · ready on a line`
  return when
}

/** Said under the sentence when other projects of the scope have unsaved changes too. */
export function otherProjectsSentence(names: readonly string[]): string | null {
  if (names.length === 0) return null
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `Your changes to ${list} are saved too.`
}
