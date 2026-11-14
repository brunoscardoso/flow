/**
 * THE RUN SETUP STORE — where each layer of a Run setup lives, and the one
 * place a scope is turned into its projects, working folders and steps.
 *
 *   shared        `<project>/flow/run/setup.json` — the project's Flow folder,
 *                 which may be a link into a Workspace; written THROUGH it, so
 *                 the file syncs with the team (knowledge class `authored`).
 *   personal      app settings, per machine, per project.
 *   conversation  the conversation's own row (migration v42), per project.
 *
 * ONE LIST PER RUN. A Run's steps are the PRIMARY project's setup — one file,
 * one order. A step may run in another project, named by `runsIn`: one of the
 * scope's projects (in the conversation's checkout of it when it has one, else
 * its folder — FR-9), else a sibling of the same Workspace that is on this
 * computer, else nowhere: the step is reported as unable to start. The other
 * attached projects' own setup files are not merged in; each is the Run of a
 * conversation whose primary project it is.
 *
 * Every write of the shared file is atomic (temp file + rename) and async —
 * nothing here blocks main (allowed-pattern #19). Every dependency is injected
 * so the tests run against fakes and temp folders.
 */
import { randomBytes } from 'crypto'
import { basename, join } from 'path'

import {
  parseRunSetup,
  resolveRunSteps,
  runScopeKey,
  serializeRunSetup,
  type RunPlace,
  type RunProjectLayers,
  type RunResolution,
  type RunSaveChange,
  type RunScope,
  type RunSetup,
  type RunTweaks,
  type RunTweaksByProject,
} from '../../shared/run-setup'

/** The project folder's Flow folder name, and the Run file inside it. */
const FLOW_DIR = 'flow'
const RUN_DIR = 'run'
const SETUP_FILE = 'setup.json'

export function sharedSetupPath(projectRoot: string): string {
  return join(projectRoot, FLOW_DIR, RUN_DIR, SETUP_FILE)
}

export interface RunStoreFs {
  /** The file's text, or null when it does not exist. */
  readFile(path: string): Promise<string | null>
  writeFile(path: string, text: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  /** True when the path is a directory (following links). */
  isDirectory(path: string): Promise<boolean>
}

/** What the store needs to know about a conversation. */
export interface RunThreadSource {
  /** Null for an unknown conversation. */
  getThread(threadId: string): { projectRoot: string; worktreePath: string | null } | null
  /** The conversation's OTHER projects. */
  getThreadRoots(threadId: string): string[]
  /** The checkouts those other projects have. */
  getThreadRootWorktrees(threadId: string): Array<{ rootPath: string; worktreePath: string }>
  getRunTweaks(threadId: string): RunTweaksByProject
  setRunTweaks(threadId: string, tweaks: RunTweaksByProject): void
}

export interface RunPersonalSource {
  getRunTweaks(projectRoot: string): RunTweaks
  setRunTweaks(projectRoot: string, tweaks: RunTweaks): RunTweaks
}

export interface RunSetupStoreDeps {
  fs: RunStoreFs
  threads: RunThreadSource
  personal: RunPersonalSource
  /** A project's name as the app shows it. */
  projectName?: (root: string) => string
  /**
   * The folders, on this computer, of the other projects in the primary
   * project's Workspace — async and cached by the caller; never a sync spawn
   * (allowed-pattern #19). Absent or failing: no siblings.
   */
  workspaceSiblings?: (primaryRoot: string) => Promise<string[]>
}

/** A refusal a person reads — plain words, no path or setting (forbidden-pattern #12). */
export class RunSetupError extends Error {}

interface ScopeProject {
  root: string
  cwd: string
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
    const others = this.#deps.threads
      .getThreadRoots(scope.threadId)
      .filter((root) => root !== thread.projectRoot)
      .map((root) => {
        const checkout = checkouts.get(root)
        return { root, cwd: checkout !== undefined && checkout !== '' ? checkout : root }
      })
    return [primary, ...others]
  }

  /** A project's name as the app shows it. */
  nameOf(root: string): string {
    return this.#deps.projectName?.(root) ?? (basename(root) || root)
  }

  /**
   * Every project a step of this scope may run in: the scope's projects (the
   * primary first, each in its working folder), then Workspace siblings on
   * this computer that are not already listed (by folder or by name).
   */
  async placesOf(scope: RunScope): Promise<RunPlace[]> {
    const places: RunPlace[] = this.projectsOf(scope).map((project) => ({
      name: this.nameOf(project.root),
      root: project.root,
      cwd: project.cwd,
      from: 'scope',
    }))
    const primary = places[0]?.root ?? scope.rootPath
    let siblings: string[] = []
    try {
      siblings = (await this.#deps.workspaceSiblings?.(primary)) ?? []
    } catch {
      siblings = []
    }
    for (const root of siblings) {
      if (typeof root !== 'string' || root === '') continue
      const name = this.nameOf(root)
      const taken = places.some(
        (place) => place.root === root || place.name.toLowerCase() === name.toLowerCase(),
      )
      if (!taken) places.push({ name, root, cwd: root, from: 'workspace' })
    }
    return places
  }

  /** The shared setup of one project, or null when it has none. */
  async readShared(projectRoot: string): Promise<{ setup: RunSetup | null; problems: string[] }> {
    let text: string | null
    try {
      text = await this.#deps.fs.readFile(sharedSetupPath(projectRoot))
    } catch {
      return { setup: null, problems: ['The shared Run setup could not be opened, so it was treated as empty.'] }
    }
    if (text === null) return { setup: null, problems: [] }
    return parseRunSetup(text)
  }

  /** The primary project's layers, where each step runs, and the merged steps with provenance. */
  async resolve(scope: RunScope): Promise<RunResolution> {
    const conversation = scope.threadId === null ? {} : this.#deps.threads.getRunTweaks(scope.threadId)
    const places = await this.placesOf(scope)
    const primary = this.projectsOf(scope)[0] ?? { root: scope.rootPath, cwd: scope.rootPath }
    const shared = await this.readShared(primary.root)
    const project: RunProjectLayers = {
      root: primary.root,
      name: this.nameOf(primary.root),
      cwd: primary.cwd,
      setup: shared.setup,
      hasSharedSetup: shared.setup !== null,
      problems: shared.problems,
      personal: this.#deps.personal.getRunTweaks(primary.root),
      conversation: conversation[primary.root] ?? {},
    }
    return { scope, scopeKey: runScopeKey(scope), project, places, steps: resolveRunSteps(project, places) }
  }

  /**
   * Write one layer of the scope's primary project — the only setup a Run
   * reads. Any other project is refused (the renderer never names a file to
   * write), and so is a conversation layer without a conversation.
   */
  async save(scope: RunScope, change: RunSaveChange): Promise<void> {
    const primary = this.projectsOf(scope)[0]?.root ?? scope.rootPath
    if (change.projectRoot !== primary) {
      throw new RunSetupError('That project is not the one this Run belongs to, so nothing was saved.')
    }
    switch (change.layer) {
      case 'shared':
        await this.#writeShared(change.projectRoot, change.setup)
        return
      case 'personal':
        this.#deps.personal.setRunTweaks(change.projectRoot, change.tweaks)
        return
      case 'conversation': {
        if (scope.threadId === null) {
          throw new RunSetupError('Changes for one conversation can only be saved from inside a conversation.')
        }
        const all = { ...this.#deps.threads.getRunTweaks(scope.threadId) }
        if (Object.keys(change.tweaks).length === 0) delete all[change.projectRoot]
        else all[change.projectRoot] = change.tweaks
        this.#deps.threads.setRunTweaks(scope.threadId, all)
        return
      }
    }
  }

  async #writeShared(projectRoot: string, setup: RunSetup): Promise<void> {
    const { fs } = this.#deps
    // Validate by round-tripping: what is written is exactly what a reader keeps.
    const text = serializeRunSetup(parseRunSetup(serializeRunSetup(setup)).setup)
    const flowDir = join(projectRoot, FLOW_DIR)
    if (!(await fs.isDirectory(flowDir))) {
      throw new RunSetupError('This project is not set up for Flow yet, so the shared setup could not be saved.')
    }
    const runDir = join(flowDir, RUN_DIR)
    await fs.mkdir(runDir)
    const target = join(runDir, SETUP_FILE)
    const temp = join(runDir, `.${SETUP_FILE}.${randomBytes(4).toString('hex')}.tmp`)
    await fs.writeFile(temp, text)
    try {
      await fs.rename(temp, target)
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined)
      throw error
    }
  }
}

/** The real async fs. */
export function nodeRunStoreFs(): RunStoreFs {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsp = require('fs/promises') as typeof import('fs/promises')
  return {
    readFile: async (path) => {
      try {
        return await fsp.readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    writeFile: (path, text) => fsp.writeFile(path, text, 'utf8'),
    rename: (from, to) => fsp.rename(from, to),
    unlink: (path) => fsp.unlink(path),
    mkdir: async (path) => {
      await fsp.mkdir(path, { recursive: true })
    },
    isDirectory: async (path) => {
      try {
        return (await fsp.stat(path)).isDirectory()
      } catch {
        return false
      }
    },
  }
}
