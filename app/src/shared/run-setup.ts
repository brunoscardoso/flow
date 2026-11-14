/**
 * A PROJECT'S RUN SETUP — the steps that start it, the layers a person can
 * tweak them in, and the one merge of those layers. DOM-free and Node-free:
 * main and the renderer both import it.
 *
 * Every sentence in `problems` is shown to a person, so each is plain words
 * and names no path, command line or setting (forbidden-pattern #12).
 */

export type RunReady = { kind: 'port'; port: number } | { kind: 'line'; text: string }

export interface RunStep {
  id: string
  name: string
  command: string
  start: 'now' | 'after-previous'
  ready?: RunReady
  readyTimeoutMs?: number
}

export interface RunSetup {
  version: 1
  steps: RunStep[]
}

/** One person's (or one conversation's) change to a shared step. `ready: null` removes the check. */
export interface RunTweak {
  command?: string
  skip?: boolean
  ready?: RunReady | null
}

export type RunLayer = 'shared' | 'personal' | 'conversation'

export interface RunScope {
  rootPath: string
  threadId: string | null
}

export function runScopeKey(scope: RunScope): string {
  return `${scope.rootPath}::${scope.threadId ?? ''}`
}

export interface ResolvedRunStep {
  /** `${projectRoot}::${id}` */
  key: string
  projectRoot: string
  projectName: string
  cwd: string
  id: string
  name: string
  command: string
  start: 'now' | 'after-previous'
  ready?: RunReady
  readyTimeoutMs: number
  from: { command: RunLayer; ready: RunLayer }
}

export type RunStepStatus =
  | 'idle'
  | 'waiting'
  | 'starting'
  | 'running'
  | 'ready'
  | 'exited'
  | 'stopped'
  | 'blocked'
  | 'timed-out'

export interface RunStepState {
  key: string
  name: string
  projectRoot: string
  status: RunStepStatus
  terminalId: string | null
  exitCode: number | null
  /** Plain-words reason, e.g. what the step is waiting for. */
  detail: string | null
}

export interface RunGroupState {
  scopeKey: string
  active: boolean
  steps: RunStepState[]
}

export const DEFAULT_READY_TIMEOUT_MS = 60_000
export const MIN_READY_TIMEOUT_MS = 5_000
export const MAX_READY_TIMEOUT_MS = 10 * 60_000

export function clampReadyTimeout(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_READY_TIMEOUT_MS
  return Math.min(MAX_READY_TIMEOUT_MS, Math.max(MIN_READY_TIMEOUT_MS, Math.round(ms)))
}

export function emptyRunSetup(): RunSetup {
  return { version: 1, steps: [] }
}

// ─── ids ─────────────────────────────────────────────────────────────────────

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

export function newStepId(name: string, existingIds: Iterable<string>): string {
  return uniqueId(slug(name) || 'step', new Set(existingIds))
}

// ─── parse / serialize ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReady(raw: unknown): { ready?: RunReady; problem?: string } {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) return { problem: 'a ready check that could not be read' }
  if (raw.kind === 'port') {
    const port = raw.port
    if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { ready: { kind: 'port', port } }
    }
    return { problem: 'a ready check with a port that is not a valid number' }
  }
  if (raw.kind === 'line') {
    if (typeof raw.text === 'string' && raw.text.trim() !== '') {
      return { ready: { kind: 'line', text: raw.text } }
    }
    return { problem: 'a ready check with no text to wait for' }
  }
  return { problem: 'a ready check of an unknown kind' }
}

export function parseRunSetup(text: string): { setup: RunSetup; problems: string[] } {
  const problems: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { setup: emptyRunSetup(), problems: ['The Run setup could not be read, so it was treated as empty.'] }
  }
  if (!isRecord(raw) || !Array.isArray(raw.steps)) {
    return { setup: emptyRunSetup(), problems: ['The Run setup has no list of steps, so it was treated as empty.'] }
  }
  const steps: RunStep[] = []
  const taken = new Set<string>()
  raw.steps.forEach((entry, index) => {
    const position = index + 1
    if (!isRecord(entry)) {
      problems.push(`Step ${position} could not be read and was left out.`)
      return
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name === '') {
      problems.push(`Step ${position} has no name and was left out.`)
      return
    }
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    if (command === '') {
      problems.push(`The step "${name}" has nothing to run and was left out.`)
      return
    }
    const parsedReady = parseReady(entry.ready)
    if (parsedReady.problem !== undefined) {
      problems.push(`The step "${name}" has ${parsedReady.problem}, so it was left out.`)
      return
    }
    const wanted = typeof entry.id === 'string' && slug(entry.id) !== '' ? slug(entry.id) : slug(name) || 'step'
    const id = uniqueId(wanted, taken)
    taken.add(id)
    const step: RunStep = {
      id,
      name,
      command,
      start: entry.start === 'after-previous' ? 'after-previous' : 'now',
    }
    if (parsedReady.ready !== undefined) step.ready = parsedReady.ready
    if (typeof entry.readyTimeoutMs === 'number' && Number.isFinite(entry.readyTimeoutMs)) {
      step.readyTimeoutMs = clampReadyTimeout(entry.readyTimeoutMs)
    }
    steps.push(step)
  })
  return { setup: { version: 1, steps }, problems }
}

export function serializeRunSetup(setup: RunSetup): string {
  const steps = setup.steps.map((step) => {
    const out: Record<string, unknown> = {
      id: step.id,
      name: step.name,
      command: step.command,
      start: step.start,
    }
    if (step.ready !== undefined) {
      out.ready = step.ready.kind === 'port' ? { kind: 'port', port: step.ready.port } : { kind: 'line', text: step.ready.text }
    }
    if (step.readyTimeoutMs !== undefined) out.readyTimeoutMs = step.readyTimeoutMs
    return out
  })
  return `${JSON.stringify({ version: 1, steps }, null, 2)}\n`
}

// ─── resolve ─────────────────────────────────────────────────────────────────

export interface RunProjectInput {
  root: string
  name: string
  cwd: string
  setup: RunSetup | null
  personal: Record<string, RunTweak>
  conversation: Record<string, RunTweak>
}

export function resolveRunSteps(projects: RunProjectInput[]): ResolvedRunStep[] {
  const resolved: ResolvedRunStep[] = []
  for (const project of projects) {
    for (const step of project.setup?.steps ?? []) {
      const personal = project.personal[step.id]
      const conversation = project.conversation[step.id]
      // The nearest layer that SAYS something wins; a conversation's `skip: false` undoes a personal skip.
      const skip = conversation?.skip ?? personal?.skip ?? false
      if (skip) continue

      let command = step.command
      let commandFrom: RunLayer = 'shared'
      if (personal?.command !== undefined) {
        command = personal.command
        commandFrom = 'personal'
      }
      if (conversation?.command !== undefined) {
        command = conversation.command
        commandFrom = 'conversation'
      }

      let ready: RunReady | undefined = step.ready
      let readyFrom: RunLayer = 'shared'
      if (personal?.ready !== undefined) {
        ready = personal.ready ?? undefined
        readyFrom = 'personal'
      }
      if (conversation?.ready !== undefined) {
        ready = conversation.ready ?? undefined
        readyFrom = 'conversation'
      }

      const out: ResolvedRunStep = {
        key: `${project.root}::${step.id}`,
        projectRoot: project.root,
        projectName: project.name,
        cwd: project.cwd,
        id: step.id,
        name: step.name,
        command,
        start: step.start,
        readyTimeoutMs: clampReadyTimeout(step.readyTimeoutMs),
        from: { command: commandFrom, ready: readyFrom },
      }
      if (ready !== undefined) out.ready = ready
      resolved.push(out)
    }
  }
  return resolved
}

// ─── tweaks ──────────────────────────────────────────────────────────────────

/** A layer's tweaks to one project's steps, keyed by step id. */
export type RunTweaks = Record<string, RunTweak>

/** A conversation's tweaks: it can span projects, so they are keyed by project root first. */
export type RunTweaksByProject = Record<string, RunTweaks>

/**
 * Read stored tweaks defensively — they come from a database row or a settings
 * value an older or newer build may have written. Anything malformed is
 * dropped field by field; this never throws.
 */
export function parseRunTweaks(raw: unknown): RunTweaks {
  const out: RunTweaks = {}
  if (!isRecord(raw)) return out
  for (const [stepId, value] of Object.entries(raw)) {
    if (!isRecord(value) || stepId === '') continue
    const tweak: RunTweak = {}
    if (typeof value.command === 'string' && value.command.trim() !== '') tweak.command = value.command.trim()
    if (typeof value.skip === 'boolean') tweak.skip = value.skip
    if (value.ready === null) tweak.ready = null
    else if (value.ready !== undefined) {
      const parsed = parseReady(value.ready)
      if (parsed.ready !== undefined) tweak.ready = parsed.ready
    }
    if (Object.keys(tweak).length > 0) out[stepId] = tweak
  }
  return out
}

export function parseRunTweaksByProject(raw: unknown): RunTweaksByProject {
  const out: RunTweaksByProject = {}
  if (!isRecord(raw)) return out
  for (const [root, value] of Object.entries(raw)) {
    const tweaks = parseRunTweaks(value)
    if (root !== '' && Object.keys(tweaks).length > 0) out[root] = tweaks
  }
  return out
}

// ─── suggestions and the scope's resolution ─────────────────────────────────

/** A command a project already declares, offered by the first-time picker and the panel's chips. */
export interface RunSuggestion {
  projectRoot: string
  projectName: string
  name: string
  command: string
  /** Where it was found, as a plain label: "package.json", "Procfile", "README"… */
  source: string
}

/** One project of a scope with every layer read, as `resolve` answers it. */
export interface RunProjectLayers extends RunProjectInput {
  /** False when the project has no shared setup yet. */
  hasSharedSetup: boolean
  /** Plain sentences about steps of the shared setup that could not be read. */
  problems: string[]
}

export interface RunResolution {
  scope: RunScope
  scopeKey: string
  projects: RunProjectLayers[]
  steps: ResolvedRunStep[]
}

/** What a Save writes — one layer of one project in the scope. */
export type RunSaveChange =
  | { layer: 'shared'; projectRoot: string; setup: RunSetup }
  | { layer: 'personal'; projectRoot: string; tweaks: RunTweaks }
  | { layer: 'conversation'; projectRoot: string; tweaks: RunTweaks }

/** A scope that has a Run going — the sidebar's running mark. */
export interface RunScopeSummary {
  scopeKey: string
  rootPath: string
  threadId: string | null
  /** Steps whose process is going (or waiting to start). */
  running: number
}

/** Everything the Run group and its panel draw for one scope. */
export interface RunView {
  resolution: RunResolution
  state: RunGroupState
}

/** A Save's answer: the new view, or a plain sentence saying why nothing was saved. */
export type RunSaveAnswer = { ok: true; view: RunView } | { ok: false; reason: string }
