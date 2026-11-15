/**
 * THE RUN SETUP STORE — where a Run setup lives, and the one place a scope is
 * turned into its projects, working folders and steps.
 *
 * A Run setup is the PERSON'S OWN, on this computer: it is kept in app
 * settings and is never written into a project or its Workspace, so it never
 * syncs to anyone (user decision, 2026-11-14).
 *
 * EACH STEP BELONGS TO ONE PROJECT — the one it runs in — and is stored with
 * that project. A conversation's Run is every step of every project it has
 * (its main project and the attached ones), combined into ONE list. The order
 * of that list is kept once, on this computer, across projects, so the same
 * steps keep the same relative order in every conversation that combines them.
 * A step runs in the conversation's checkout of its project when it has one,
 * else in the project folder (FR-9).
 *
 * OLDER DATA. A setup stored under one project may hold steps that name
 * another project to run in. Such a step belongs to the project it names: it
 * is read that way, and the next Save that touches it moves it there. Nothing
 * is dropped on the way.
 *
 * The personal and conversation tweak layers are retired from the panel; a
 * Run resolves with none (their stored data is left as it is).
 *
 * Every dependency is injected so the tests run against fakes.
 */
import { basename } from 'path'

import {
  mergeRunOrder,
  newStepId,
  parseRunSetup,
  resolveOnceSteps,
  resolveRunSteps,
  runScopeKey,
  runStepRef,
  serializeRunSetup,
  type RunPlace,
  type RunProjectLayers,
  type RunResolution,
  type RunSaveChange,
  type RunScope,
  type RunSetup,
  type RunStep,
} from '../../shared/run-setup'

/** What the store needs to know about a conversation. */
export interface RunThreadSource {
  /** Null for an unknown conversation. */
  getThread(threadId: string): { projectRoot: string; worktreePath: string | null } | null
  /** The conversation's OTHER projects. */
  getThreadRoots(threadId: string): string[]
  /** The checkouts those other projects have. */
  getThreadRootWorktrees(threadId: string): Array<{ rootPath: string; worktreePath: string }>
}

export interface RunPersonalSource {
  /** A project's own Run steps as stored text, local to this computer — never a shared file. */
  getRunSetup(projectRoot: string): string | null
  setRunSetup(projectRoot: string, text: string | null): void
  /** Every project that has stored steps. */
  listRunSetupRoots(): string[]
  /** The one order of steps across projects, as step references. */
  getRunOrder(): string[]
  setRunOrder(refs: string[]): void
}

export interface RunSetupStoreDeps {
  threads: RunThreadSource
  personal: RunPersonalSource
  /** A project's name as the app shows it. */
  projectName?: (root: string) => string
}

/** A refusal a person reads — plain words, no path or setting (forbidden-pattern #12). */
export class RunSetupError extends Error {}

interface ScopeProject {
  root: string
  cwd: string
}

interface NamedProject extends ScopeProject {
  name: string
}

/** One stored step, where it is stored and which project of the scope it runs in. */
interface StoredStep {
  /** The project it is stored with. */
  owner: string
  /** Its position in that project's stored list. */
  index: number
  step: RunStep
  ref: string
  /** The scope project it runs in, or null when it is not one of the scope's. */
  project: NamedProject | null
}

interface Gathered {
  projects: NamedProject[]
  stored: Map<string, { setup: RunSetup | null; problems: string[] }>
  /** The steps this scope sees, in the one order. */
  visible: StoredStep[]
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export class RunSetupStore {
  readonly #deps: RunSetupStoreDeps

  constructor(deps: RunSetupStoreDeps) {
    this.#deps = deps
  }

  /** The scope's projects in order (the primary first) with each one's working folder. */
  projectsOf(scope: RunScope): ScopeProject[] {
    if (scope.threadId === null) return [{ root: scope.rootPath, cwd: scope.rootPath }]
    const thread = this.#deps.threads.getThread(scope.threadId)
    if (thread === null) return [{ root: scope.rootPath, cwd: scope.rootPath }]
    const checkouts = new Map(
      this.#deps.threads.getThreadRootWorktrees(scope.threadId).map((row) => [row.rootPath, row.worktreePath]),
    )
    const primary: ScopeProject = {
      root: thread.projectRoot,
      cwd: thread.worktreePath !== null && thread.worktreePath !== '' ? thread.worktreePath : thread.projectRoot,
    }
    const seen = new Set([thread.projectRoot])
    const others: ScopeProject[] = []
    for (const root of this.#deps.threads.getThreadRoots(scope.threadId)) {
      if (seen.has(root)) continue
      seen.add(root)
      const checkout = checkouts.get(root)
      others.push({ root, cwd: checkout !== undefined && checkout !== '' ? checkout : root })
    }
    return [primary, ...others]
  }

  /** A project's name as the app shows it. */
  nameOf(root: string): string {
    return this.#deps.projectName?.(root) ?? (basename(root) || root)
  }

  /**
   * Every project a step of this scope may run in: the scope's projects only,
   * the primary first, each in its working folder. A project outside the
   * conversation is not offered — its steps would never run here.
   */
  async placesOf(scope: RunScope): Promise<RunPlace[]> {
    return this.#named(scope).map((project) => ({ name: project.name, root: project.root, cwd: project.cwd, from: 'scope' }))
  }

  /** One project's stored steps, or null when it has none. */
  async readShared(projectRoot: string): Promise<{ setup: RunSetup | null; problems: string[] }> {
    return this.#read(projectRoot)
  }

  /**
   * The scope's combined Run: every stored step whose project is one of the
   * scope's, in the one order (steps it does not name yet go last, grouped by
   * the project they are stored with — the main project first, then the
   * scope's order), each running in its project's working folder.
   */
  async resolve(scope: RunScope): Promise<RunResolution> {
    const gathered = this.#gather(scope)
    const primary = gathered.projects[0]!
    const combined: RunStep[] = gathered.visible.map((entry) => {
      const step: RunStep = { ...entry.step, id: entry.ref }
      step.runsIn = entry.project!.name
      return step
    })
    const owners = new Set([...gathered.projects.map((project) => project.root), ...gathered.visible.map((entry) => entry.owner)])
    const problems = [...owners].flatMap((root) => gathered.stored.get(root)?.problems ?? [])
    const project: RunProjectLayers = {
      root: primary.root,
      name: primary.name,
      cwd: primary.cwd,
      setup: combined.length === 0 ? null : { version: 1, steps: combined },
      hasSharedSetup: combined.length > 0,
      problems,
      personal: {},
      conversation: {},
    }
    const places = await this.placesOf(scope)
    return {
      scope,
      scopeKey: runScopeKey(scope),
      project,
      places,
      steps: resolveRunSteps(project, places, { keyOf: (step) => step.id }),
      once: resolveOnceSteps(project, places, { keyOf: (step) => step.id }),
    }
  }

  /**
   * Write the scope's whole combined list. Each step is stored with the
   * project it runs in (the main project when it names none); a step that
   * changed project, or is new, gets a fresh id there. Steps this scope cannot
   * see are left exactly as they are, and so is their place in the one order.
   */
  async save(scope: RunScope, change: RunSaveChange): Promise<void> {
    const gathered = this.#gather(scope)
    const primary = gathered.projects[0]!
    const visibleByRef = new Map(gathered.visible.map((entry) => [entry.ref, entry]))

    // Where each step of the draft goes, and whether it keeps its stored id.
    const placed = change.steps.map((step) => {
      const wanted = step.runsIn?.trim() ?? ''
      const target = wanted === '' ? primary : gathered.projects.find((project) => sameName(project.name, wanted))
      if (target === undefined) {
        throw new RunSetupError(
          `“${step.name}” runs in ${wanted}, which is not part of this conversation, so nothing was saved.`,
        )
      }
      const existing = visibleByRef.get(step.id)
      const keepId = existing !== undefined && existing.owner === target.root ? existing.step.id : null
      return { step, target: target.root, keepId, id: keepId ?? '' }
    })

    const touched = new Set<string>([...gathered.visible.map((entry) => entry.owner), ...placed.map((entry) => entry.target)])
    const visibleRefs = new Set(visibleByRef.keys())
    const lists = new Map<string, RunStep[]>()
    for (const root of touched) {
      const kept = (gathered.stored.get(root)?.setup?.steps ?? []).filter(
        (step) => !visibleRefs.has(runStepRef(root, step.id)),
      )
      lists.set(root, kept)
    }
    // Ids: the kept ones first, so a fresh id never takes one already in use.
    for (const root of touched) {
      const taken = new Set(lists.get(root)!.map((step) => step.id))
      for (const entry of placed) if (entry.target === root && entry.keepId !== null) taken.add(entry.keepId)
      for (const entry of placed) {
        if (entry.target !== root || entry.keepId !== null) continue
        entry.id = newStepId(entry.step.name, taken)
        taken.add(entry.id)
      }
    }
    for (const entry of placed) {
      const { runsIn: _runsIn, ...own } = entry.step
      lists.get(entry.target)!.push({ ...own, id: entry.id })
    }

    for (const [root, steps] of lists) this.#write(root, { version: 1, steps })
    let order: string[] = []
    try {
      order = this.#deps.personal.getRunOrder()
    } catch {
      order = []
    }
    this.#deps.personal.setRunOrder(
      mergeRunOrder(order, visibleRefs, placed.map((entry) => runStepRef(entry.target, entry.id))),
    )
  }

  // ─── reading ─────────────────────────────────────────────────────────────────

  #named(scope: RunScope): NamedProject[] {
    return this.projectsOf(scope).map((project) => ({ ...project, name: this.nameOf(project.root) }))
  }

  #read(root: string): { setup: RunSetup | null; problems: string[] } {
    let text: string | null
    try {
      text = this.#deps.personal.getRunSetup(root)
    } catch {
      return { setup: null, problems: ['The Launchpad could not be read, so it was treated as empty.'] }
    }
    if (text === null) return { setup: null, problems: [] }
    return parseRunSetup(text)
  }

  /** Every stored setup, and the steps of it this scope sees, in the one order. */
  #gather(scope: RunScope): Gathered {
    const projects = this.#named(scope)
    let roots: string[] = []
    try {
      roots = this.#deps.personal.listRunSetupRoots()
    } catch {
      roots = []
    }
    const allRoots = [...new Set([...projects.map((project) => project.root), ...roots])]
    const stored = new Map(allRoots.map((root) => [root, this.#read(root)]))
    const byRoot = new Map(projects.map((project) => [project.root, project]))

    const visible: StoredStep[] = []
    for (const [owner, read] of stored) {
      const ownerName = this.nameOf(owner)
      read.setup?.steps.forEach((step, index) => {
        const named = step.runsIn?.trim() ?? ''
        // Older data: a step naming another project belongs to that project.
        const project =
          named === '' || sameName(named, ownerName)
            ? (byRoot.get(owner) ?? null)
            : (projects.find((candidate) => sameName(candidate.name, named)) ?? null)
        if (project === null) return
        visible.push({ owner, index, step, ref: runStepRef(owner, step.id), project })
      })
    }

    let order: string[] = []
    try {
      order = this.#deps.personal.getRunOrder()
    } catch {
      order = []
    }
    const position = new Map(order.map((ref, index) => [ref, index]))
    const ownerRank = (owner: string): number => {
      const index = projects.findIndex((project) => project.root === owner)
      return index < 0 ? projects.length : index
    }
    visible.sort((a, b) => {
      const pa = position.get(a.ref)
      const pb = position.get(b.ref)
      if (pa !== undefined && pb !== undefined) return pa - pb
      if (pa !== undefined) return -1
      if (pb !== undefined) return 1
      const rank = ownerRank(a.owner) - ownerRank(b.owner)
      if (rank !== 0) return rank
      if (a.owner !== b.owner) return a.owner < b.owner ? -1 : 1
      return a.index - b.index
    })
    return { projects, stored, visible }
  }

  #write(projectRoot: string, setup: RunSetup): void {
    // Validate by round-tripping: what is stored is exactly what a reader keeps.
    const clean = parseRunSetup(serializeRunSetup(setup)).setup
    this.#deps.personal.setRunSetup(projectRoot, clean.steps.length === 0 ? null : serializeRunSetup(clean))
  }
}
