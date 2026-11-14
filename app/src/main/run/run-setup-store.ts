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
 * A conversation runs each project in ITS checkout when it has one, else in
 * the project folder (FR-9). The primary project's checkout is the thread's
 * `worktreePath`; an attached project's is its `thread_roots` row.
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

  /** Every layer of every project in the scope, and the merged steps with provenance. */
  async resolve(scope: RunScope): Promise<RunResolution> {
    const conversation = scope.threadId === null ? {} : this.#deps.threads.getRunTweaks(scope.threadId)
    const projects: RunProjectLayers[] = []
    for (const project of this.projectsOf(scope)) {
      const shared = await this.readShared(project.root)
      projects.push({
        root: project.root,
        name: this.#deps.projectName?.(project.root) ?? (basename(project.root) || project.root),
        cwd: project.cwd,
        setup: shared.setup,
        hasSharedSetup: shared.setup !== null,
        problems: shared.problems,
        personal: this.#deps.personal.getRunTweaks(project.root),
        conversation: conversation[project.root] ?? {},
      })
    }
    return { scope, scopeKey: runScopeKey(scope), projects, steps: resolveRunSteps(projects) }
  }

  /**
   * Write one layer of one project in the scope. A project outside the scope
   * is refused (the renderer never names a file to write), and so is a
   * conversation layer without a conversation.
   */
  async save(scope: RunScope, change: RunSaveChange): Promise<void> {
    const inScope = this.projectsOf(scope).some((project) => project.root === change.projectRoot)
    if (!inScope) throw new RunSetupError('That project is not part of this Run, so nothing was saved.')
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
