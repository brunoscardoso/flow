// Source providers for the command palette — one per kind, each turning the
// app's existing IPC + the command registry into typed PaletteCandidates.
//
// DOM-free: the IPC calls and the event emitter are INJECTED (the view binds
// them to window.flow.* and document.dispatchEvent), so these providers are
// importable and unit-testable under node-env jest. Each provider is fail-soft
// (a rejected IPC yields []) and accepts an optional `isStale` generation guard
// so the caller can drop results from a superseded keystroke.

import type { SlashCommand, ThreadSummary } from '../../shared/ipc-contract'
import type { PaletteCandidate } from './palette-types'
import { fuzzyScore } from './palette-fuzzy'
import { foldSlashCommands, buildStaticCommands, type PaletteCommand, type PaletteEmit } from './palette-commands'

/** Injected IPC + emitter surface — the view binds these to the live app. */
export interface PaletteSourceDeps {
  listAllFiles: (request: {
    rootPath: string
    limit?: number
  }) => Promise<{ relPaths: string[]; truncated: boolean }>
  searchThreads: (request: { query: string; projectRoot?: string }) => Promise<ThreadSummary[]>
  listCommands: (request: { rootPath: string }) => Promise<SlashCommand[]>
  emit: PaletteEmit
}

/** Returns true when the current async result is stale and must be discarded. */
export type StaleGuard = () => boolean

/** Basename of a POSIX relative path (the file's display label). */
function baseName(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash === -1 ? relPath : relPath.slice(slash + 1)
}

/** Directory portion of a POSIX relative path, or '' at the root. */
function dirName(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash === -1 ? '' : relPath.slice(0, slash)
}

/**
 * File candidates: the bounded ignore-aware flat list, fuzzy-filtered by `term`.
 * An empty term returns [] — the empty state shows recents, not the whole tree.
 * `run` opens the file via flow:open-file (the editor's existing listener).
 */
export async function fileCandidates(
  rootPath: string,
  term: string,
  deps: PaletteSourceDeps,
  isStale?: StaleGuard,
): Promise<PaletteCandidate[]> {
  if (term.length === 0) return []
  let relPaths: string[]
  try {
    const result = await deps.listAllFiles({ rootPath })
    relPaths = result.relPaths
  } catch {
    return []
  }
  if (isStale?.()) return []

  const matched: PaletteCandidate[] = []
  for (const relPath of relPaths) {
    // Score against the full relative path so typing a directory segment works;
    // fuzzy's boundary bonus already rewards a hit at the basename start.
    const score = fuzzyScore(term, relPath)
    if (score === null) continue
    matched.push({
      kind: 'file',
      id: relPath,
      label: baseName(relPath),
      sublabel: dirName(relPath) || undefined,
      score,
      run: () => deps.emit('flow:open-file', { rootPath, relPath }),
    })
  }
  return matched
}

/**
 * Thread candidates from the existing FTS search (titles AND message bodies,
 * project-scoped, updated_at DESC). `recencyAt` = updatedAt feeds the ranker's
 * recency boost; `score` is the title fuzzy match (0 when only the body matched,
 * i.e. the "body hit" tier). `run` jumps to the thread via flow:open-thread.
 */
export async function threadCandidates(
  rootPath: string,
  term: string,
  deps: PaletteSourceDeps,
  isStale?: StaleGuard,
): Promise<PaletteCandidate[]> {
  if (term.length === 0) return []
  let threads: ThreadSummary[]
  try {
    threads = await deps.searchThreads({ query: term, projectRoot: rootPath })
  } catch {
    return []
  }
  if (isStale?.()) return []

  return threads.map((thread) => ({
    kind: 'thread',
    id: thread.id,
    label: thread.title,
    // A title match ranks the thread up; a body-only match still shows (score 0).
    score: fuzzyScore(term, thread.title) ?? 0,
    recencyAt: thread.updatedAt,
    run: () => deps.emit('flow:open-thread', { threadId: thread.id }),
  }))
}

/**
 * Command candidates from a pre-built command list, fuzzy-filtered by `term`.
 * An empty term returns all commands (command mode's ">"" shows the full list);
 * a non-empty term keeps fuzzy matches on the label.
 */
export function commandCandidates(term: string, commands: readonly PaletteCommand[]): PaletteCandidate[] {
  const out: PaletteCandidate[] = []
  for (const command of commands) {
    if (term.length === 0) {
      out.push(toCommandCandidate(command, 0))
      continue
    }
    const score = fuzzyScore(term, command.label)
    if (score === null) continue
    out.push(toCommandCandidate(command, score))
  }
  return out
}

function toCommandCandidate(command: PaletteCommand, score: number): PaletteCandidate {
  return {
    kind: 'command',
    id: command.id,
    label: command.label,
    sublabel: command.hint,
    icon: command.icon,
    score,
    run: command.run,
  }
}

/** Bind the static registry (no slash folding) to the emitter — the synchronous
 *  fallback the view can show instantly before slash commands load. */
export function staticCommandList(deps: PaletteSourceDeps): PaletteCommand[] {
  return buildStaticCommands(deps.emit)
}

/** Fold discovered slash commands onto the static registry (fail-soft). */
export async function loadCommandList(
  rootPath: string,
  deps: PaletteSourceDeps,
  isStale?: StaleGuard,
): Promise<PaletteCommand[]> {
  let discovered: SlashCommand[] = []
  try {
    discovered = await deps.listCommands({ rootPath })
  } catch {
    discovered = []
  }
  if (isStale?.()) return buildStaticCommands(deps.emit)
  return [...buildStaticCommands(deps.emit), ...foldSlashCommands(discovered, deps.emit)]
}
