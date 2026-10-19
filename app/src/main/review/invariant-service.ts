// Invariant-checker service (#898 Phase B) — owns the per-root lifecycle
// around runInvariantCheck: debounced triggers on git changes, a single
// in-flight pass per root (a trigger during a pass queues exactly one rerun),
// the latest snapshot for the list channel, and the push on completion.
// Electron-free: broadcast + all checker deps are injected (index.ts wires
// BrowserWindow.send, git diffs, and the haiku-tier generateBrief).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  BlueprintGraph,
  InvariantCheckSnapshot,
  InvariantVerdictsEvent,
} from '../../shared/ipc-contract'
import {
  appendInvariantRounds,
  buildInvariantRoundsEntries,
  loadVerdictCache,
  runInvariantCheck,
  saveVerdictCache,
} from './invariant-checker'
import { moduleSlug } from '../agent/learn-session'

/** Debounce for git:changed storms (a checkout touches hundreds of files). */
const TRIGGER_DEBOUNCE_MS = 2_000

/** Fail-soft graph read straight off the structure layer (disposable tier). */
export function readGraphForRoot(rootPath: string): BlueprintGraph | null {
  const path = join(rootPath, 'flow', 'brain', '.structure', 'graph.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BlueprintGraph
  } catch {
    return null
  }
}

/** Learned module doc for a module dir, or null when never learned. */
export function readModuleDoc(rootPath: string, moduleDir: string): string | null {
  const path = join(rootPath, 'flow', 'brain', 'modules', `${moduleSlug(moduleDir)}.md`)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

export interface InvariantServiceDeps {
  /** Repo-relative changed files for a root (from git status), [] when clean. */
  getChangedFiles: (rootPath: string) => Promise<string[]>
  /** Working-tree diff hunks for one file of a root. */
  diffFor: (rootPath: string, filePath: string) => Promise<string>
  /** One-shot model call — null when no agent is available for the root. */
  runModel: (rootPath: string, prompt: string) => Promise<string | null>
  /** Push a completed pass to the renderer(s). */
  broadcast: (event: InvariantVerdictsEvent) => void
  now?: () => Date
}

export interface InvariantService {
  /** Debounced check trigger (git:changed, board bind). */
  trigger(rootPath: string): void
  /** Latest completed pass for the list channel. */
  snapshot(rootPath: string): InvariantCheckSnapshot
  dispose(): void
}

export function createInvariantService(deps: InvariantServiceDeps): InvariantService {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const snapshots = new Map<string, InvariantCheckSnapshot>()
  const running = new Set<string>()
  const rerunQueued = new Set<string>()
  let disposed = false

  async function runPass(rootPath: string): Promise<void> {
    if (running.has(rootPath)) {
      rerunQueued.add(rootPath)
      return
    }
    running.add(rootPath)
    try {
      const changedFiles = await deps.getChangedFiles(rootPath)
      const result = await runInvariantCheck(
        { graph: readGraphForRoot(rootPath), changedFiles },
        {
          readDoc: (moduleDir) => readModuleDoc(rootPath, moduleDir),
          diffFor: (filePath) => deps.diffFor(rootPath, filePath),
          runModel: (prompt) => deps.runModel(rootPath, prompt),
          loadCache: () => loadVerdictCache(rootPath),
          saveCache: (cache) => saveVerdictCache(rootPath, cache),
        },
      )
      if (disposed) return
      const now = deps.now?.() ?? new Date()
      const checkedAt = now.toISOString()
      snapshots.set(rootPath, { result, checkedAt })
      await appendInvariantRounds(rootPath, buildInvariantRoundsEntries(result.verdicts, now))
      deps.broadcast({ rootId: rootPath, result, checkedAt })
    } catch (error) {
      console.warn('[invariants] pass failed (non-fatal):', error)
    } finally {
      running.delete(rootPath)
      if (rerunQueued.delete(rootPath) && !disposed) void runPass(rootPath)
    }
  }

  return {
    trigger(rootPath: string): void {
      if (disposed) return
      const existing = timers.get(rootPath)
      if (existing !== undefined) clearTimeout(existing)
      timers.set(
        rootPath,
        setTimeout(() => {
          timers.delete(rootPath)
          void runPass(rootPath)
        }, TRIGGER_DEBOUNCE_MS),
      )
    },
    snapshot(rootPath: string): InvariantCheckSnapshot {
      return snapshots.get(rootPath) ?? { result: null, checkedAt: null }
    },
    dispose(): void {
      disposed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
