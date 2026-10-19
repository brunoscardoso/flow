// Plan-features reader — the "what was implemented" view's data source.
//
// Reads plan-flow's plan files (the SAME `## Phase N` + `**Files**:`
// declarations the review panel uses for phase attribution) and returns one
// BlueprintFeature per plan: its phases, each phase's title, and the files
// that phase touched. This is DURABLE and CLI-INDEPENDENT — a finished
// feature shows its implementation surface even when the full `planflow-ai
// blueprint derive` never ran (so the Blueprint board can answer "what did
// this feature implement?" straight from the plans).
//
// Sources, in order (active plans first so an in-progress plan wins over a
// same-named archived one):
//   flow/plans/plan_*.md    → archived: false (active / in-progress)
//   flow/archive/plan_*.md  → archived: true  (completed features)
//
// SECURITY: the caller supplies only a rootId (validated absolute rootPath in
// main); paths are constructed HERE from the fixed `flow/plans` and
// `flow/archive` suffixes. Never throws — a missing dir or unreadable plan is
// skipped, not fatal.

import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'

import type { BlueprintFeature, BlueprintFeaturePhase } from '../../shared/ipc-contract'
import { featureSlug, isConcreteFile, normalizeRel, parsePlanPhases } from '../review/phase-map'
import { phaseLabel } from '../review/review-service'

/** Is a body token path-shaped enough to show as a file? (concrete file OR a
 *  directory prefix `foo/bar/` — but not a bare glob or prose). */
function isFileLikeToken(path: string): boolean {
  if (/\s/.test(path) || path.includes('*')) return false
  if (path.endsWith('/') && path.length > 1) return true
  return isConcreteFile(path)
}

/**
 * A phase's files for the feature view: the precise `**Files**:` tokens first
 * (declared intent), then any file-looking tokens mentioned in the phase body
 * (Description/Tasks) — many plans embed paths there instead of a Files block.
 * De-duped, order preserved.
 */
export function phaseFiles(fileTokens: string[], bodyTokens: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (raw: string): void => {
    const norm = normalizeRel(raw)
    if (norm.length === 0 || seen.has(norm)) return
    if (!isFileLikeToken(norm)) return
    seen.add(norm)
    out.push(norm)
  }
  for (const token of fileTokens) add(token)
  for (const token of bodyTokens) add(token)
  return out
}

/** Parse one plan file's text into a BlueprintFeature (null when it has no phases). */
export function planToFeature(
  planFileName: string,
  text: string,
  archived: boolean,
): BlueprintFeature | null {
  const parsed = parsePlanPhases(text)
  if (parsed.length === 0) return null

  const distinctFiles = new Set<string>()
  const phases: BlueprintFeaturePhase[] = parsed
    .sort((a, b) => a.phase.localeCompare(b.phase, undefined, { numeric: true }))
    .map((phase) => {
      const files = phaseFiles(phase.fileTokens, phase.bodyTokens)
      for (const file of files) if (isConcreteFile(file)) distinctFiles.add(file)
      return { phase: phase.phase, label: phaseLabel(phase.phase), title: phase.title, files }
    })

  return {
    feature: featureSlug(planFileName),
    plan: planFileName,
    archived,
    phases,
    fileCount: distinctFiles.size,
  }
}

/**
 * Read every plan under the project's flow/plans + flow/archive into the
 * implemented-features list. De-duped by plan filename (active wins over a
 * same-named archived plan). Sorted active-first, then by feature slug.
 */
export async function readPlanFeatures(projectRoot: string): Promise<BlueprintFeature[]> {
  const sources: Array<{ dir: string; archived: boolean }> = [
    { dir: join(projectRoot, 'flow', 'plans'), archived: false },
    { dir: join(projectRoot, 'flow', 'archive'), archived: true },
  ]
  const seen = new Set<string>()
  const features: BlueprintFeature[] = []
  for (const { dir, archived } of sources) {
    let names: string[]
    try {
      names = (await fsPromises.readdir(dir)).filter((n) => /^plan_.*\.md$/.test(n)).sort()
    } catch {
      continue // missing dir → nothing from this source
    }
    for (const name of names) {
      if (seen.has(name)) continue
      let text: string
      try {
        text = await fsPromises.readFile(join(dir, name), 'utf8')
      } catch {
        continue
      }
      const feature = planToFeature(name, text, archived)
      if (feature !== null) {
        seen.add(name)
        features.push(feature)
      }
    }
  }
  return features.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1 // active first
    return a.feature.localeCompare(b.feature)
  })
}

/** A located plan file with its raw text (for the feature trace). */
export interface LocatedPlan {
  name: string
  text: string
  archived: boolean
}

/**
 * Locate the plan file backing a feature slug (active preferred over a
 * same-named archived plan). Returns null when no plan matches. Never throws.
 */
export async function findFeaturePlan(
  projectRoot: string,
  feature: string,
): Promise<LocatedPlan | null> {
  const sources: Array<{ dir: string; archived: boolean }> = [
    { dir: join(projectRoot, 'flow', 'plans'), archived: false },
    { dir: join(projectRoot, 'flow', 'archive'), archived: true },
  ]
  for (const { dir, archived } of sources) {
    let names: string[]
    try {
      names = (await fsPromises.readdir(dir)).filter((n) => /^plan_.*\.md$/.test(n)).sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (featureSlug(name) !== feature) continue
      try {
        return { name, text: await fsPromises.readFile(join(dir, name), 'utf8'), archived }
      } catch {
        continue
      }
    }
  }
  return null
}
