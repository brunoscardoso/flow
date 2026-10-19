// Chat-learn trigger — keeping learning consistent with what the user is
// actually working on.
//
// THE GAP THIS FILLS
// ==================
// Two mechanisms already grow the store, and neither one covers a conversation:
//
//   • T3 auto re-learn (learn-triggers.ts) fires on FILE SAVES, and only for a
//     module that was ALREADY learned. A module nobody ever learned stays
//     unlearned no matter how much it is edited.
//   • Brain capture (brain/capture.ts) records every file a turn touched into
//     `flow/brain/.raw/`, and compaction promotes it — SILENTLY, with no learn
//     pass and no consent.
//
// So a user can spend an afternoon in chat changing a subsystem the blueprint
// has no understanding of, and the board learns nothing. This module closes
// that: after a turn touches files, decide whether to ASK the user to learn the
// area they are working in.
//
// WHY ASK AT ALL
// ==============
// A learn pass costs model time and writes to precious, human-owned feature
// files. Everything auto-learn does today is either free (staleness re-hashing)
// or already user-approved (a run's release entries). Spending tokens because
// someone read a file is neither, so consent is the honest gate — the same call
// the basic-discovery prompt makes.
//
// PURE DECISION CORE: no fs, no spawn, no Electron — every input is passed in,
// mirroring learn-triggers.ts. The caller owns the effects (the prompt, the
// enqueue, the reclass). `mapFileToModule` is IMPORTED rather than re-derived:
// "which module owns this file" has one definition (allowed-pattern #14).

import { mapFileToModule } from './learn-triggers'
import type { BlueprintLearningStatus } from '../../shared/ipc-contract'
import type { WorkingSetFile } from '../brain/types'

/**
 * Minimum touched files in one module before it is worth interrupting for.
 * A single incidental read is not evidence that someone is working on an area;
 * two or more files in the same module is the cheapest signal that they are.
 */
export const MIN_TOUCHED_FILES = 2

/** An edited file is stronger evidence of "working on this" than a read. */
const EDIT_WEIGHT = 2
const READ_WEIGHT = 1

/** A core feature as the decision needs it — slug, display name, anchors. */
export interface CoreFeatureLike {
  slug: string
  name: string
  /** Anchor ids, e.g. `module:src/app/api/billing`. */
  anchors: readonly string[]
}

/** What the user would be asked about. */
export interface ChatLearnAsk {
  /** The depth-1 module the conversation concentrated on. */
  modulePath: string
  /** Files touched inside it (after noise filtering). */
  fileCount: number
  /** The core feature that owns this module, when one claims it. */
  parentSlug: string | null
  parentName: string | null
}

export interface ChatLearnInput {
  /** The turn's working set (brain capture's own output shape). */
  files: readonly WorkingSetFile[]
  /** Depth-1 module paths from the derived graph. */
  modulePaths: readonly string[]
  /** Current learning status per module path. */
  statusByModule: ReadonlyMap<string, BlueprintLearningStatus>
  /** Core features, for resolving what the work hangs under. */
  cores: readonly CoreFeatureLike[]
  /** Threads already asked — one prompt per thread, ever. */
  askedThreads: ReadonlySet<string>
  threadId: string
}

/**
 * A module is "settled" when learning it again would tell the user nothing new
 * right now: it is understood, or a pass is already on its way. `stale` is
 * deliberately NOT settled — drifted understanding is exactly what a fresh look
 * should fix — but T3 already handles the drift case for previously-learned
 * modules, so in practice this fires for `none`.
 */
function isSettled(status: BlueprintLearningStatus | undefined): boolean {
  return status === 'learned' || status === 'learning' || status === 'queued'
}

/**
 * Weighted per-module tally of a turn's working set. Files that map to no
 * module (repo-root configs, files outside the spine) are dropped rather than
 * pooled into a fake module.
 */
export function tallyModules(
  files: readonly WorkingSetFile[],
  modulePaths: readonly string[],
): Map<string, { files: number; weight: number }> {
  const tally = new Map<string, { files: number; weight: number }>()
  for (const file of files) {
    const modulePath = mapFileToModule(file.path, modulePaths)
    if (modulePath === undefined) continue
    const current = tally.get(modulePath) ?? { files: 0, weight: 0 }
    current.files += 1
    current.weight += file.role === 'edited' ? EDIT_WEIGHT : READ_WEIGHT
    tally.set(modulePath, current)
  }
  return tally
}

/**
 * The core feature that claims this module, by anchor. Ties are broken by the
 * LONGEST matching anchor: a feature anchored at `src/app/api/billing` owns that
 * work more specifically than one anchored at `src/app`, and the specific owner
 * is the useful parent. Deterministic on equal length (slug order) so the same
 * inputs always name the same parent.
 */
export function owningCore(
  modulePath: string,
  cores: readonly CoreFeatureLike[],
): CoreFeatureLike | null {
  let best: { core: CoreFeatureLike; length: number } | null = null
  for (const core of cores) {
    for (const anchor of core.anchors) {
      if (!anchor.startsWith('module:')) continue
      const path = anchor.slice('module:'.length)
      const claims = modulePath === path || modulePath.startsWith(`${path}/`)
      if (!claims) continue
      if (
        best === null ||
        path.length > best.length ||
        (path.length === best.length && core.slug < best.core.slug)
      ) {
        best = { core, length: path.length }
      }
    }
  }
  return best === null ? null : best.core
}

/**
 * Decide whether this turn warrants asking to learn, and about what.
 *
 * Returns null — ask nothing — when the thread was already asked, when the turn
 * touched too little to be evidence, or when the area the user is working in is
 * already understood. Silence is the common case by construction: the prompt
 * should feel like it noticed something, not like it fires after every turn.
 */
export function resolveChatLearnAsk(input: ChatLearnInput): ChatLearnAsk | null {
  if (input.askedThreads.has(input.threadId)) return null
  if (input.files.length === 0 || input.modulePaths.length === 0) return null

  const tally = tallyModules(input.files, input.modulePaths)
  if (tally.size === 0) return null

  // The module the conversation concentrated on: heaviest first (edits count
  // double), then most files, then path order so the choice is deterministic.
  const ranked = [...tally.entries()].sort((a, b) => {
    if (b[1].weight !== a[1].weight) return b[1].weight - a[1].weight
    if (b[1].files !== a[1].files) return b[1].files - a[1].files
    return a[0].localeCompare(b[0])
  })

  for (const [modulePath, counts] of ranked) {
    if (counts.files < MIN_TOUCHED_FILES) continue
    if (isSettled(input.statusByModule.get(modulePath))) continue
    const parent = owningCore(modulePath, input.cores)
    return {
      modulePath,
      fileCount: counts.files,
      parentSlug: parent?.slug ?? null,
      parentName: parent?.name ?? null,
    }
  }
  return null
}
