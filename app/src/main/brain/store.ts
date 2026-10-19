// Brain store layout — the single knowledge store's on-disk shape (#52).
//
//   flow/brain/
//     features/     canonical MD: feature → working-set, decisions, summary  (precious)
//     errors/       canonical MD: reusable error patterns + fixes            (precious)
//     decisions/    canonical MD: rationale, ruled-out, contracts            (precious)
//     .raw/         auto-captured working sets, untrusted                    (transient)
//     .structure/   derived structure graph, rebuilt each scan              (disposable)
//
// `flow/` is itself a symlink to the central vault; join() through it is fine —
// the project file layer handles containment.

import { join } from 'path'

/** Subdirectories of the brain store, as root-relative POSIX paths. */
export const BRAIN_SUBDIRS = {
  features: 'flow/brain/features',
  errors: 'flow/brain/errors',
  decisions: 'flow/brain/decisions',
  raw: 'flow/brain/.raw',
  structure: 'flow/brain/.structure',
} as const

export type BrainSubdir = keyof typeof BRAIN_SUBDIRS

/** The derived structure graph, relocated here from flow/.blueprint/ (Phase 4). */
export const STRUCTURE_GRAPH_RELPATH = 'flow/brain/.structure/graph.json'

/** Absolute path to a brain subdirectory under `rootPath`. */
export function brainSubdirPath(rootPath: string, sub: BrainSubdir): string {
  return join(rootPath, BRAIN_SUBDIRS[sub])
}

/**
 * The single tier boundary: only these kinds are trusted/queryable. `.raw/` is
 * deliberately excluded — un-compacted captures must never surface as fact
 * (allowed-pattern #14: the invariant lives in ONE code path, not prompt text).
 */
const TRUSTED_SUBDIRS: readonly BrainSubdir[] = ['features', 'errors', 'decisions', 'structure']

/** True when a brain-relative path belongs to a trusted (queryable) tier. */
export function isTrustedBrainPath(relPath: string): boolean {
  const normalized = relPath.split('\\').join('/')
  if (normalized.includes(`${BRAIN_SUBDIRS.raw}/`) || normalized.endsWith(BRAIN_SUBDIRS.raw)) {
    return false
  }
  return TRUSTED_SUBDIRS.some(
    (sub) => normalized === BRAIN_SUBDIRS[sub] || normalized.startsWith(`${BRAIN_SUBDIRS[sub]}/`),
  )
}
