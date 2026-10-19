// PhaseMap — builds a file→phase mapping for a project by reading plan-flow's
// execution records, so the review panel can group uncommitted changes by the
// plan phase that produced them.
//
// Attribution is by FILE, not time (robust to parallel wave execution): each
// `progress` entry in flow/.wave-context.jsonl carries `{agent: "phase-N",
// data: { files_modified: [...] }}`. We accumulate those into a path→phase
// map. wave-context.jsonl is EPHEMERAL (plan-flow deletes it at execution
// end), so the caller snapshots the map while it exists; a file claimed by
// more than one phase keeps ALL its phases (a plan-flow "file conflict").
//
// Sequential (non-wave) execution writes no wave-context, so those changes map
// to no phase and land in the review panel's "Other changes" group.

import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'

/** A file's phase attribution: the phase ids (e.g. "phase-2") that touched it. */
export type FileToPhases = Map<string, Set<string>>

/** Where plan-flow keeps its per-run wave coordination log (under the project). */
export function waveContextPath(projectRoot: string): string {
  return join(projectRoot, 'flow', '.wave-context.jsonl')
}

interface WaveProgressEntry {
  agent?: unknown
  type?: unknown
  data?: { files_modified?: unknown }
}

/**
 * Read flow/.wave-context.jsonl and build a path (project-relative, as written
 * by the skill) → set-of-phase-ids map. Returns an empty map when the file is
 * absent (no plan run / already cleaned up / sequential execution). Never
 * throws — a malformed line is skipped, not fatal.
 */
export async function readPhaseMap(projectRoot: string): Promise<FileToPhases> {
  const map: FileToPhases = new Map()
  let raw: string
  try {
    raw = await fsPromises.readFile(waveContextPath(projectRoot), 'utf8')
  } catch {
    return map // absent → nothing to attribute
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let entry: WaveProgressEntry
    try {
      entry = JSON.parse(trimmed) as WaveProgressEntry
    } catch {
      continue
    }
    if (entry.type !== 'progress') continue
    const phase = typeof entry.agent === 'string' ? entry.agent : null
    const files = entry.data?.files_modified
    if (phase === null || !Array.isArray(files)) continue
    for (const file of files) {
      if (typeof file !== 'string' || file.length === 0) continue
      const key = normalizeRel(file)
      const phases = map.get(key) ?? new Set<string>()
      phases.add(phase)
      map.set(key, phases)
    }
  }
  return map
}

/** Normalize a record's path to compare against git's project-relative paths. */
export function normalizeRel(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/**
 * A phase attribution rule that isn't a single exact path — a directory prefix
 * (`app/src/review/`) or a glob suffix (`*.test.ts`) declared in a plan phase.
 */
export interface PhasePattern {
  phase: string
  test: (filePath: string) => boolean
}

/** A phase's human title + its plan's feature slug, for commit-message suggestions. */
export interface PhaseMeta {
  /** Phase title from the heading (e.g. "CSS Rainbow Palette"), or "". */
  title: string
  /** Feature slug from the plan filename (e.g. "rainbow-theme"). */
  feature: string
}

/**
 * Phase attribution from the EXECUTION RECORD — what each phase actually
 * touched, rather than what its plan predicted.
 *
 * WHY THIS EXISTS. The other two sources both come up empty on a finished run:
 *
 *   · flow/.wave-context.jsonl carries files_modified per phase, but it is
 *     ephemeral (deleted at execution end) and only written in WAVE mode, so a
 *     sequential run never produces one at all.
 *   · a plan's `**Files**:` sections are durable, but real plans do not carry
 *     them — measured on this project's own archived plans, 7 phases and 10
 *     phases with zero Files sections between them. The paths live in task
 *     prose, which is deliberately not used for attribution (an incidental
 *     mention would move somebody else's change into your phase).
 *
 * Which left every change in "Other changes" and made phase-by-phase commit
 * impossible for any completed plan.
 *
 * flow/.rounds.jsonl is the append-only execution record, archived beside the
 * plan as rounds_<plan>.jsonl. Its `phase_result` entries already had a slot
 * for this — `anchors`, documented as "module/file anchors from that phase's
 * touched files" — which was optional and, in practice, absent. Reading it is
 * what makes attribution durable, factual and mode-independent.
 *
 * Non-file anchors are ignored rather than guessed at: an anchor without a
 * slash or an extension is a module id, not a path, and attributing a change to
 * one would be inventing a mapping nobody wrote.
 */
export async function readRoundsPhaseMap(projectRoot: string): Promise<PlanPhaseMap> {
  const exact: FileToPhases = new Map()
  const meta = new Map<string, PhaseMeta>()
  const files = [
    join(projectRoot, 'flow', '.rounds.jsonl'),
    ...(await archivedRoundsFiles(projectRoot)),
  ]
  for (const path of files) {
    let raw: string
    try {
      raw = await fsPromises.readFile(path, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let entry: RoundsEntry
      try {
        entry = JSON.parse(trimmed) as RoundsEntry
      } catch {
        continue // a torn last line is normal for an append-only log
      }
      if (entry.type !== 'phase_result') continue
      const plan = typeof entry.plan === 'string' ? entry.plan : null
      const phaseNumber = typeof entry.phase === 'number' ? entry.phase : null
      if (plan === null || phaseNumber === null) continue
      const key = qualifyPhase(plan, `phase-${String(phaseNumber)}`)
      if (!meta.has(key)) {
        meta.set(key, { title: typeof entry.name === 'string' ? entry.name : '', feature: plan })
      }
      const anchors = Array.isArray(entry.anchors) ? entry.anchors : []
      for (const anchor of anchors) {
        if (typeof anchor !== 'string') continue
        const path = normalizeAnchorPath(anchor)
        if (path === null) continue
        const set = exact.get(path) ?? new Set<string>()
        set.add(key)
        exact.set(path, set)
      }
    }
  }
  return { exact, patterns: [], meta }
}

interface RoundsEntry {
  type?: unknown
  plan?: unknown
  phase?: unknown
  name?: unknown
  anchors?: unknown
}

/** Archived per-plan rounds records (rounds_<plan>.jsonl), or none. */
async function archivedRoundsFiles(projectRoot: string): Promise<string[]> {
  const dir = join(projectRoot, 'flow', 'archive')
  try {
    const names = await fsPromises.readdir(dir)
    return names.filter((n) => /^rounds_.*\.jsonl$/.test(n)).map((n) => join(dir, n))
  } catch {
    return []
  }
}

/**
 * A file anchor as a project-relative path, or null when it is not one.
 *
 * An anchor may be a module id ("threads", "renderer/git") as well as a file,
 * and a module must contribute nothing — attributing to one would claim every
 * change under a directory for a single phase.
 *
 * The test is an EXTENSION, not a slash. Requiring a slash was the first cut
 * and it was wrong: it threw away every file at the repository root, so a plan
 * that touched `package.json` or `a.ts` attributed nothing and the change fell
 * back into "Other changes" — the exact failure this reader exists to fix,
 * reintroduced one directory up. A module id has no extension, which separates
 * the two cleanly on its own.
 */
function normalizeAnchorPath(anchor: string): string | null {
  const trimmed = anchor.trim().replace(/^\.\//, '')
  if (trimmed === '' || trimmed.includes(' ')) return null
  if (!/\.[A-Za-z0-9]{1,8}$/.test(trimmed)) return null
  return trimmed
}

/** Exact-path phase map plus non-exact patterns (from plan `Files:` lines). */
export interface PlanPhaseMap {
  exact: FileToPhases
  patterns: PhasePattern[]
  /** phase id → title/feature, for suggested commit messages. */
  meta: Map<string, PhaseMeta>
}

/**
 * Compose a plan-scoped phase key. Bare phase ids (`phase-2`) are NOT unique —
 * every plan has one — so folding all plans under the bare id collided unrelated
 * archived plans' phases into one group with a first-read-wins title/feature
 * (#144). Qualifying by feature slug (`rainbow-theme#phase-2`) keeps each plan's
 * phases distinct. The `#` separator can't occur in a feature slug (featureSlug
 * emits only `[a-z0-9-]`), so the key round-trips unambiguously.
 */
export function qualifyPhase(feature: string, phase: string): string {
  return `${feature}#${phase}`
}

/** plan_rainbow_theme_v1.md → "rainbow-theme". */
export function featureSlug(planFileName: string): string {
  return planFileName
    .replace(/^plan_/, '')
    .replace(/_v\d+\.md$/i, '')
    .replace(/\.md$/i, '')
    .replace(/_/g, '-')
}

/**
 * Build phase attribution from the project's ACTIVE plan files' per-phase
 * `**Files**:` declarations. Unlike wave-context.jsonl this is DURABLE — it
 * survives execution — so a completed plan's changes still group by phase.
 * Reads every `flow/plans/plan_*.md`; a file declared by multiple phases keeps
 * all of them. Never throws (missing dir → empty).
 */
export async function readPlanPhaseMap(projectRoot: string): Promise<PlanPhaseMap> {
  const exact: FileToPhases = new Map()
  const patterns: PhasePattern[] = []
  const meta = new Map<string, PhaseMeta>()
  // Active AND archived: /execute-plan moves a completed plan into flow/archive/,
  // so a just-run plan's attribution lives there — reading only flow/plans/
  // would drop it and collapse everything into "Other changes".
  const dirs = [join(projectRoot, 'flow', 'plans'), join(projectRoot, 'flow', 'archive')]
  for (const dir of dirs) {
    let names: string[]
    try {
      names = (await fsPromises.readdir(dir)).filter((n) => /^plan_.*\.md$/.test(n))
    } catch {
      continue
    }
    for (const name of names) {
      let raw: string
      try {
        raw = await fsPromises.readFile(join(dir, name), 'utf8')
      } catch {
        continue
      }
      parsePlan(raw, featureSlug(name), exact, patterns, meta)
    }
  }
  return { exact, patterns, meta }
}

/** One plan phase as parsed from the plan text (before rule classification). */
export interface ParsedPlanPhase {
  /** Phase id, e.g. "phase-2". */
  phase: string
  /** Phase title from the heading (e.g. "Content & markup"), or "". */
  title: string
  /**
   * Backticked path tokens declared under this phase's `**Files**:` section —
   * the PRECISE set used for git attribution (parsePlan). Empty when the plan
   * has no Files section (many plans embed paths in Description/Tasks instead).
   */
  fileTokens: string[]
  /**
   * EVERY backticked token in the phase body (Description, Tasks, Files, …).
   * A superset used only by the feature view, which filters it down to
   * file-looking tokens — NEVER used for git attribution (incidental mentions
   * would mis-attribute changes).
   */
  bodyTokens: string[]
}

/**
 * Parse `## Phase N` headings + their bodies. Collects two token sets per
 * phase: `fileTokens` from the `**Files**:` section only (precise, for git
 * attribution — handles both same-line paths and the bulleted-list template),
 * and `bodyTokens` from every backticked span in the phase (a superset for
 * the feature view). Pure — the SINGLE source of phase structure, consumed by
 * both attribution (parsePlan) and the feature view (plan-features).
 */
export function parsePlanPhases(text: string): ParsedPlanPhase[] {
  const phases = new Map<string, ParsedPlanPhase>()
  let current: ParsedPlanPhase | null = null
  let inFiles = false
  const collectFiles = (line: string): void => {
    if (current === null) return
    for (const token of line.matchAll(/`([^`]+)`/g)) {
      current.fileTokens.push(token[1].trim())
    }
  }
  for (const line of text.split('\n')) {
    const heading = /^#{2,4}\s*Phase\s+(\d+)\s*(?:[—–:-]\s*(.+?))?\s*$/i.exec(line)
    if (heading) {
      const phase = `phase-${heading[1]}`
      inFiles = false
      // First heading for a phase id wins its title (mirrors the meta rule).
      current =
        phases.get(phase) ?? { phase, title: (heading[2] ?? '').trim(), fileTokens: [], bodyTokens: [] }
      if (!phases.has(phase)) phases.set(phase, current)
      continue
    }
    // Every backticked token in the phase body feeds the (feature-only) superset.
    if (current !== null) {
      for (const token of line.matchAll(/`([^`]+)`/g)) {
        current.bodyTokens.push(token[1].trim())
      }
    }
    // Both authoring variants (#783): `**Files**:` (colon outside the bold —
    // the original template) AND `**Files:**` (colon inside — what newer
    // /create-plan output writes). The stricter regex silently parsed ZERO
    // tokens from the newer variant, so every changed file fell into "Other
    // changes" even for plans that declared their files per phase.
    if (/^\s*\*\*Files:?\*\*/i.test(line)) {
      // Enter files mode; grab any inline paths on this same line too.
      inFiles = true
      collectFiles(line)
      continue
    }
    if (!inFiles) continue
    // Continue collecting from the bulleted list until a section boundary.
    const trimmed = line.trim()
    if (
      trimmed === '' ||
      /^#{1,6}\s/.test(trimmed) ||
      trimmed === '---' ||
      /^\*\*[A-Za-z]/.test(trimmed)
    ) {
      inFiles = false
      continue
    }
    collectFiles(line)
  }
  return [...phases.values()]
}

/**
 * Fold parsed phases into the attribution structures (exact map + patterns +
 * per-phase meta), keyed by a PLAN-SCOPED phase id (`<feature>#phase-N`) so
 * identical phase ids across plans never collide (#144). Each declared token is
 * classified by addRule under that scoped key.
 */
/**
 * File extensions that make a backticked token a real FILE reference. An
 * allowlist, so JS expressions and prose (`document.title`, `tsc --noEmit`,
 * `aria-label`) never masquerade as paths. Lives here, with the plan parser,
 * because two consumers now depend on it: the feature view's file list and
 * this file's body-token attribution.
 */
const FILE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'rb', 'swift',
  'kt', 'cs', 'css', 'scss', 'less', 'html', 'json', 'jsonc', 'md', 'mdx', 'yml',
  'yaml', 'toml', 'sql', 'sh', 'vue', 'svelte', 'graphql', 'gql', 'prisma', 'env',
])

/** A token is a concrete file (allowlisted extension, no glob, no whitespace). */
export function isConcreteFile(path: string): boolean {
  if (path.includes('*') || path.endsWith('/') || /\s/.test(path)) return false
  const match = /\.([a-z0-9]+)$/i.exec(path)
  return match !== null && FILE_EXTENSIONS.has(match[1].toLowerCase())
}

/**
 * The file paths a phase's PROSE names, for a phase that declared no `**Files**:`.
 *
 * WHY THIS EXISTS. Phase attribution read `**Files**:` sections and nothing
 * else, and the plan template stopped emitting them — so plans authored by
 * `/create-plan` produced no attribution at all, every change fell into "Other
 * changes", and the Phases tab became a second copy of the Changes tab. Of 43
 * plans in this repo, 11 declare Files; of 278 phases, 68 do. The other 210
 * phases named their files in Description and Tasks bullets instead, in
 * backticks, where a reader can see them perfectly well and the panel could not.
 *
 * WHY IT IS NARROWER THAN THE FEATURE VIEW'S READING. `phaseFiles` (the
 * blueprint's) keeps directory prefixes too, because listing a directory a
 * phase touched is harmless. Attribution is not a listing — it decides which
 * commit a change belongs to — so a prose mention must not be able to sweep a
 * whole tree. Measured on this repo: unfiltered body tokens yield 258 paths of
 * which 177 name nothing that exists (prose fragments like `run-log.ts` from a
 * rename sentence); requiring a real path shape leaves 101, none of them a
 * directory and none a glob.
 *
 * So: exact files only, and only ones written as a PATH (containing a
 * separator). A bare basename in prose is a mention, not a declaration.
 *
 * Declared `**Files**:` always wins — a phase that has one never consults its
 * prose, keeping deliberate declarations exactly as expressive as they were
 * (directories and globs included).
 */
export function bodyFilePaths(bodyTokens: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const token of bodyTokens) {
    const path = normalizeRel(token)
    if (path.length === 0 || seen.has(path)) continue
    if (!path.includes('/')) continue
    if (!isConcreteFile(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

function parsePlan(
  text: string,
  feature: string,
  exact: FileToPhases,
  patterns: PhasePattern[],
  meta: Map<string, PhaseMeta>,
): void {
  for (const parsed of parsePlanPhases(text)) {
    const key = qualifyPhase(feature, parsed.phase)
    if (!meta.has(key)) meta.set(key, { title: parsed.title, feature })
    if (parsed.fileTokens.length > 0) {
      for (const token of parsed.fileTokens) {
        addRule(token, key, exact, patterns)
      }
      continue
    }
    // No declaration — fall back to the paths the phase's prose names.
    for (const path of bodyFilePaths(parsed.bodyTokens)) {
      const set = exact.get(path) ?? new Set<string>()
      set.add(key)
      exact.set(path, set)
    }
  }
}

/**
 * Whether `file` matches a `**Files**` glob token, honoring the directory
 * anchor (#251): the part before the FIRST `*` is a required prefix and the part
 * after the LAST `*` a required suffix, so `app/src/review/*.ts` matches only
 * .ts files under app/src/review/. A leading-`*` token (`*.test.ts`) has an
 * empty prefix → a pure suffix match. The length guard stops a short file from
 * matching both ends via overlap. Paths are project-relative (normalizeRel).
 */
export function matchesGlobToken(token: string, file: string): boolean {
  const prefix = token.slice(0, token.indexOf('*'))
  const suffix = token.slice(token.lastIndexOf('*') + 1)
  return (
    file.startsWith(prefix) &&
    file.endsWith(suffix) &&
    file.length >= prefix.length + suffix.length
  )
}

/** Classify a declared path token as an exact file, a directory, or a glob. */
function addRule(
  token: string,
  phase: string,
  exact: FileToPhases,
  patterns: PhasePattern[],
): void {
  const path = normalizeRel(token)
  if (path.length === 0) return
  if (path.includes('*')) {
    // Honor the glob's directory anchor (#251): the part BEFORE the first `*`
    // is a required prefix, so `app/src/review/*.ts` matches only .ts files
    // under app/src/review/ — not every .ts file repo-wide. A bare `*` (no
    // prefix and no suffix) would match everything, so it's dropped.
    const prefix = path.slice(0, path.indexOf('*'))
    const suffix = path.slice(path.lastIndexOf('*') + 1)
    if (prefix.length > 0 || suffix.length > 0) {
      patterns.push({ phase, test: (file) => matchesGlobToken(path, file) })
    }
    return
  }
  if (path.endsWith('/')) {
    patterns.push({ phase, test: (file) => file.startsWith(path) })
    return
  }
  if (!/\.[a-z0-9]+$/i.test(path)) {
    // No extension → treat as a directory prefix (or the dir itself).
    const dir = `${path}/`
    patterns.push({ phase, test: (file) => file === path || file.startsWith(dir) })
    return
  }
  const set = exact.get(path) ?? new Set<string>()
  set.add(phase)
  exact.set(path, set)
}

/**
 * Merge a freshly-read phase map into an accumulated snapshot (so attribution
 * survives wave-context.jsonl being deleted at execution end). Union of phases
 * per file — a later run's phases are added, never dropped.
 */
export function mergePhaseMap(into: FileToPhases, from: FileToPhases): FileToPhases {
  for (const [file, phases] of from) {
    const existing = into.get(file) ?? new Set<string>()
    for (const phase of phases) existing.add(phase)
    into.set(file, existing)
  }
  return into
}
