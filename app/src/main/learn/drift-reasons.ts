// WHY A MODULE DRIFTED — the reason on each row of the Learning panel's
// Drifted group ("24 files changed").
//
// The answer is the staleness check Flow already has: the read-only CLI
// `blueprint stale-check --json` re-hashes every file a learned note was
// stamped with and reports the notes whose files changed or went missing. It
// is run ONCE per request for the whole project (never per module), off the
// main thread's critical path (async spawn with a timeout), and its report is
// cached briefly so reopening the group does not spawn again.
//
// A note counts toward a module when one of its anchors resolves under the
// module's path — the SAME containment rule the CLI's own `--module` filter
// uses (`noteUnderModule` in src/cli/blueprint/stale-check.ts), so the count
// a row shows is the count `stale-check --module <m>` would report.
//
// The decision core is pure and exported for tests; the runner is injected.

import { parseStaleCheckJson, type StaleCheckReport } from './learn-triggers'

/** How long one project's report is reused before the check runs again. */
export const DRIFT_REASONS_TTL_MS = 20_000

/** Repo-relative paths a note's anchors point at (mirrors the CLI's notePaths). */
export function anchorPaths(anchors: readonly unknown[]): string[] {
  const paths: string[] = []
  for (const anchor of anchors) {
    if (typeof anchor !== 'object' || anchor === null) continue
    const record = anchor as Record<string, unknown>
    if ((record.kind === 'file' || record.kind === 'module') && typeof record.ref === 'string') {
      paths.push(record.ref)
    } else if (record.kind === 'symbol' && typeof record.file === 'string') {
      paths.push(record.file)
    }
  }
  return paths
}

function normalize(path: string): string {
  return path.replace(/^module:/, '').replace(/\/+$/, '')
}

function under(path: string, module: string): boolean {
  const p = normalize(path)
  return p === module || p.startsWith(`${module}/`)
}

/**
 * For each requested module, the distinct files (changed or missing) of every
 * stale note that resolves under it. A module no stale note resolves under is
 * left out — the panel then shows no reason rather than a guess.
 */
export function driftFilesByModule(report: StaleCheckReport, modules: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const raw of modules) {
    const module = normalize(raw)
    if (module === '') continue
    const files = new Set<string>()
    for (const note of report.stale) {
      if (!anchorPaths(note.anchors).some((path) => under(path, module))) continue
      for (const file of note.changedFiles) files.add(file)
      for (const file of note.missingFiles) files.add(file)
    }
    if (files.size > 0) out[raw] = [...files].sort()
  }
  return out
}

/** Runs the project-wide stale-check and returns its parsed report, or null. */
export type ProjectStaleCheck = (rootPath: string) => Promise<StaleCheckReport | null>

/** Build the stale-check runner over the bundled CLI's capturing spawn. */
export function makeProjectStaleCheck(
  runCli: (cwd: string, args: readonly string[], options: { timeoutMs: number }) => Promise<{ ok: boolean; stdout?: string }>,
  timeoutMs = 30_000,
): ProjectStaleCheck {
  return async (rootPath) => {
    try {
      const result = await runCli(rootPath, ['blueprint', 'stale-check', '--json'], { timeoutMs })
      if (!result.ok || typeof result.stdout !== 'string') return null
      return parseStaleCheckJson(result.stdout)
    } catch {
      // Sanctioned fail-soft: a check that could not run gives no reasons.
      return null
    }
  }
}

/**
 * The `learn:driftReasons` answer: one check per project per TTL (concurrent
 * asks share the one in flight), then the per-module file lists. Null when the
 * check could not run.
 */
export function makeDriftReasons(
  check: ProjectStaleCheck,
  now: () => number = Date.now,
  ttlMs = DRIFT_REASONS_TTL_MS,
): (rootPath: string, modules: readonly string[]) => Promise<Record<string, string[]> | null> {
  const cache = new Map<string, { at: number; report: Promise<StaleCheckReport | null> }>()
  return async (rootPath, modules) => {
    const cached = cache.get(rootPath)
    let pending: Promise<StaleCheckReport | null>
    if (cached !== undefined && now() - cached.at < ttlMs) {
      pending = cached.report
    } else {
      pending = check(rootPath)
      cache.set(rootPath, { at: now(), report: pending })
    }
    const report = await pending
    if (report === null) {
      // A failed check is not cached: the next open may succeed.
      if (cache.get(rootPath)?.report === pending) cache.delete(rootPath)
      return null
    }
    return driftFilesByModule(report, modules)
  }
}
