// Learning-progress model (#582) — pure, DOM-free. Computes the overall learning
// percentage + per-module rows the status panel renders, from data the board
// already holds in its BlueprintSnapshot (graph module nodes + learning-state
// entries). No new IPC: the blueprint watcher refreshes the snapshot on every
// learning-state transition, so a percentage derived here updates live.

import type {
  BlueprintGraph,
  BlueprintLearningEntry,
  BlueprintLearningStatus,
} from '../../shared/ipc-contract'
import { ignoreSource } from '../../shared/learn-ignore'
import { featuresUnderstood } from '../../shared/understood'
// The lens's join and its share, from the module that already owns both for the
// code map — never a second copy of either (see `lensCoverage`).
import { coverageOf, moduleOfPath } from './territory-layout'

/** A module's row in the status panel: its id + learning status ('none' when it
 *  has no learning-state entry yet; 'ignored' when the module is on the
 *  learning ignore list but carries a prior entry) + when that status was last
 *  noted. */
export interface LearnModuleRow {
  module: string
  status: BlueprintLearningStatus | 'none' | 'ignored'
  notedAt?: string
}

/** Overall learning progress for the status panel. */
export interface LearnProgress {
  /** Total learnable modules — the union of every graph module node (any depth)
   *  and every module with a learning entry (the denominator, prefix-normalized). */
  total: number
  learned: number
  learning: number
  queued: number
  stale: number
  /** learned / total, 0–100 (0 when total is 0). Unrounded — the bar wants the
   *  real value, and the label decides its own precision (percentLabel). */
  percent: number
  /**
   * The percentage as the panel prints it, with enough decimals that finishing
   * one module MOVES it.
   *
   * At 360 modules a whole percent is 3.6 modules, so an hour of work could
   * leave "1%" exactly where it started — the number said nothing was
   * happening while something was. See formatLearnPercent.
   */
  percentLabel: string
  /** Per-module rows: every depth-1 module (learned-first-then-active ordering),
   *  followed by any learning entry for a non-depth-1 module (manual learns). */
  rows: LearnModuleRow[]
  /**
   * True when any module is QUEUED OR MARKED LEARNING IN THE FILE.
   *
   * NOT "a pass is running" — that is `learn:status`, asked of the process that
   * would know. A row saying 'queued' is a note a previous session left; three
   * of them kept the panel claiming it was learning for fifteen hours. This
   * remains useful as "there is outstanding work", and is named accordingly at
   * every call site.
   */
  active: boolean
}

const MODULE_PREFIX = 'module:'

/** Normalize a module ref so a graph id (`module:src/lib`) and a learning-state
 *  entry (`src/lib`, written bare by the orchestrator) compare equal. Without
 *  this the two never matched, so learned modules read as 'none' and the
 *  percentage stuck at 0 while the list showed them LEARNED (#learn-progress). */
function normalizeModuleRef(ref: string): string {
  return ref.startsWith(MODULE_PREFIX) ? ref.slice(MODULE_PREFIX.length) : ref
}

/** EVERY module node id (any depth) — the full learnable universe. The overall
 *  percentage is over this, not just depth-1, so a nested single-root project
 *  (everything under `src/`, one depth-1 node) still reports honest progress
 *  across all its modules rather than "0/1". */
export function allModuleIds(graph: BlueprintGraph | null | undefined): string[] {
  if (!graph || !Array.isArray(graph.nodes)) return []
  return graph.nodes.filter((node) => node.kind === 'module').map((node) => node.id)
}

/**
 * The modules the "Learn all" action should enqueue: those still needing work —
 * status 'none' (never learned) or 'stale' (drifted). Excludes 'learned' (done),
 * in-flight 'learning'/'queued' (already enqueued), and 'ignored' (scaffolding —
 * only a deliberate per-module Learn touches those), so clicking it again
 * mid-run never double-queues. Returns the (normalized) module paths in the
 * panel's row order.
 *
 * Consistency with T1 onboarding (#learn-ignore round 2): "Learn all" enqueues
 * PER-MODULE from this list (learn:learnModule), never via
 * enqueueBasicDiscovery, so it need not mirror the orchestrator's
 * selectOnboardingModules container-descent. Both draw ignores from the SAME
 * shared matcher (isIgnoredModule — defaults + dot-dirs + extras), so neither
 * surface ever promises an ignored module. The panel's list is deliberately a
 * superset (every non-ignored module at any depth, containers included) —
 * users can learn any specific module, containers among them.
 */
export function unlearnedModules(progress: LearnProgress): string[] {
  return progress.rows
    .filter((row) => row.status === 'none' || row.status === 'stale')
    .map((row) => row.module)
    // SHALLOW FIRST. A real project put 360 modules in this queue, and it was
    // working through them in row order — `flow/resources`, then
    // `src/app/api/audio`, then `src/app/api/audit` — so after an hour the map
    // had leaves and no trunk. Learning `src`, then `src/app`, then
    // `src/components` gives the shape of the project first, and makes stopping
    // early a reasonable thing to do.
    .sort((a, b) => a.split('/').length - b.split('/').length)
}

/** Ordering weight for the panel: active work first, then done, then untouched. */
const STATUS_ORDER: Record<LearnModuleRow['status'], number> = {
  learning: 0,
  queued: 1,
  stale: 2,
  learned: 3,
  none: 4,
  ignored: 5,
}

/**
 * Compute learning progress from a graph's depth-1 modules and the learning-state
 * entries. `percent` is learned/total over the depth-1 set; rows join each
 * depth-1 module to its latest status, plus any learning entry whose module isn't
 * a depth-1 node (a manual `/learn <module>`), so nothing being learned is hidden.
 * Pure and deterministic (stable sort by status then module id).
 *
 * Learning-ignored modules (#learn-ignore — built-in scaffolding segments plus
 * the `learn_ignore` extras) are excluded from every count (numerator AND
 * denominator, so the percentage stays honest): with no entry they show nothing
 * (no row); with a prior entry they render as an 'ignored' row instead of
 * stale/learned noise. An in-flight entry ('learning'/'queued' — a deliberate
 * manual Learn of an ignored module) keeps its live status so the override
 * stays visible, while still counting toward nothing.
 */
export function computeLearnProgress(
  graph: BlueprintGraph | null | undefined,
  learning: readonly BlueprintLearningEntry[] = [],
  ignoreExtras: readonly string[] = [],
): LearnProgress {
  // Index learning entries by NORMALIZED module path so a bare `src/lib` entry
  // matches a `module:src/lib` graph node (the mismatch that pinned percent at 0).
  const byModule = new Map<string, BlueprintLearningEntry>()
  for (const entry of learning) byModule.set(normalizeModuleRef(entry.module), entry)

  // The universe is the UNION of every graph module node and every module that
  // has a learning entry — so a learned module missing from a still-building
  // ("Structure limited") graph is not dropped from the denominator, and a graph
  // module never learned is still counted as remaining work. Deduped by path.
  const keys = new Set<string>()
  for (const id of allModuleIds(graph)) keys.add(normalizeModuleRef(id))
  for (const entry of learning) keys.add(normalizeModuleRef(entry.module))
  // Split the universe: counted modules vs ignored ones. Ignored modules leave
  // the denominator entirely; only those with a prior entry keep a row.
  const modules: string[] = []
  const rows: LearnModuleRow[] = []
  for (const module of keys) {
    const entry = byModule.get(module)
    const ignored = ignoreSource(module, ignoreExtras)
    if (ignored !== null) {
      // #1450: WHO ignored it decides whether it keeps a row.
      //
      // A built-in ignore (scaffolding, tests, dot-dirs) that was never learned
      // is noise — it has never been part of this panel and listing it would
      // bury the modules that are. But a user-added ignore arrives by the user
      // clicking Ignore on a row they were looking at, and on a fresh project
      // every module is `none`, so the same rule made the row VANISH: no pill,
      // no toast, no undo, the count silently dropping 0/6 → 0/5 — while the
      // module stayed drawn on the code map directly above. It also made the
      // panel's own Unignore action unreachable for exactly the modules a user
      // is most likely to ignore, since that action only renders on a row.
      if (ignored === 'default' && entry === undefined) continue
      const inFlight = entry?.status === 'learning' || entry?.status === 'queued'
      rows.push({
        module,
        status: inFlight && entry !== undefined ? entry.status : 'ignored',
        ...(entry?.notedAt === undefined ? {} : { notedAt: entry.notedAt }),
      })
      continue
    }
    modules.push(module)
    rows.push({ module, status: entry?.status ?? 'none', notedAt: entry?.notedAt })
  }
  rows.sort((a, b) =>
    STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]
      ? STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
      : a.module.localeCompare(b.module),
  )

  const total = modules.length
  const count = (status: BlueprintLearningStatus): number =>
    modules.reduce((n, m) => n + (byModule.get(m)?.status === status ? 1 : 0), 0)
  const learned = count('learned')
  const learning_ = count('learning')
  const queued = count('queued')
  const stale = count('stale')
  const percent = total === 0 ? 0 : (learned / total) * 100

  return {
    total,
    learned,
    learning: learning_,
    queued,
    stale,
    percent,
    percentLabel: formatLearnPercent(learned, total),
    rows,
    active: rows.some((r) => r.status === 'learning' || r.status === 'queued'),
  }
}

/**
 * A percentage with enough precision to show one module's worth of progress.
 *
 * The step is 100/total: at 360 modules that is 0.28%, so the integer the panel
 * used to print stayed on "1%" through a dozen finished modules. Two decimals
 * when a module moves less than half a point, one when it moves less than five,
 * none when each module is worth a visible chunk — a twelve-module project
 * still reads "17%", not "16.67%".
 */
export function formatLearnPercent(learned: number, total: number): string {
  if (total <= 0) return '0%'
  const percent = (learned / total) * 100
  const step = 100 / total
  const decimals = step < 0.5 ? 2 : step < 5 ? 1 : 0
  return `${percent.toFixed(decimals)}%`
}

/** The learner's live state, as `learn:status` reports it. */
export interface LearnLiveState {
  running: boolean
  paused: boolean
  activeModule: string | null
  /**
   * The root the active pass belongs to, when the answer says so.
   *
   * One orchestrator serves every project, so this is not always the project
   * the panel is showing — see `learnStateLabel`.
   */
  activeRoot?: string | null
  queued: number
  /** Queued passes per project root, when main says (the per-project panel). */
  queuedByRoot?: Record<string, number>
  /** Projects paused on their own. */
  pausedRoots?: string[]
  /** When the active pass started (epoch ms), or null when idle. */
  startedAt?: number | null
}

/** One line of the learner's activity log (learn:log). */
export interface LearnLogLine {
  at: number
  kind: 'queued' | 'start' | 'read' | 'learned' | 'failed' | 'stopped' | 'note'
  module: string
  detail?: string
}

/** `6m 12s` — short, and honest about a pass that is taking a while. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes === 0) return `${String(seconds)}s`
  return `${String(minutes)}m ${String(seconds % 60)}s`
}

/**
 * One activity line, as the panel prints it: a clock time, what happened, and
 * the thing it happened to.
 *
 * The file path is shown from its LAST TWO SEGMENTS — a log where every line
 * begins with /Users/name/Projects/… is a column of noise with the answer off
 * the right edge.
 */
export function formatLearnLogLine(entry: LearnLogLine): string {
  const time = new Date(entry.at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const tail = (path: string): string => path.split('/').slice(-2).join('/')
  switch (entry.kind) {
    case 'queued':
      return `${time}  queued ${entry.module}${entry.detail === undefined ? '' : ` (${entry.detail})`}`
    case 'start':
      return `${time}  started ${entry.module}`
    case 'read':
      return `${time}  ${entry.module} — reading ${entry.detail === undefined ? '' : tail(entry.detail)}`
    case 'learned':
      return `${time}  learned ${entry.module}`
    case 'failed':
      return `${time}  failed ${entry.module}${entry.detail === undefined ? '' : ` — ${entry.detail}`}`
    case 'stopped':
      return `${time}  stopped ${entry.module}${entry.detail === undefined ? '' : ` — ${entry.detail}`}`
    default:
      return `${time}  ${entry.module}${entry.detail === undefined ? '' : ` — ${entry.detail}`}`
  }
}

/**
 * The first words of the panel's headline: what the learner is doing.
 *
 * The panel opened with "1% · 4/360 learned", which answers progress and never
 * answered the question somebody opens it with — is it doing anything? It said
 * "Learning…" on the button regardless, from rows in a file, so the honest
 * answer was not on screen at all.
 */
export function learnStateLabel(
  live: LearnLiveState,
  paused: boolean,
  /** The root the panel is showing. Omit when the caller has no root context. */
  viewedRoot?: string | null,
  /**
   * The feature-understand pass running on this board, if any.
   *
   * A SECOND PIPELINE, AND THE PANEL WAS BLIND TO IT. Learning a NODE goes
   * through `understandFeature` (draw the view, then learn its parts); learning
   * a MODULE goes through the orchestrator's queue. Only the second is what
   * `learn:status` counts, so a reader who pressed Learn on a feature watched a
   * panel titled "Learning" report "Idle · 0/362" while their pass ran — the
   * user's words: "i started the learning of the node, but this is not
   * reflecting on the learning, this is not connected?"
   *
   * It is reported, not counted: a feature is not one of the 362 modules, and
   * moving that number for it would trade a silence for a wrong total.
   */
  featurePass?: { featureName: string } | null,
): string {
  // The orchestrator's own queue takes precedence when both are going: it is
  // the one the counter beside this label is about.
  if (!live.running && featurePass != null) {
    const parts = [`Understanding ${featurePass.featureName}`]
    if (live.queued > 0) parts.push(`${String(live.queued)} queued`)
    return parts.join(' · ')
  }
  if (live.running) {
    // WHOSE PASS IS THIS? One orchestrator serves every project, and the
    // panel's Stop and Reset only reach the root the board is viewing. So a
    // pass belonging to another project must not be narrated as if it were
    // this one's — reported live: the panel read "Learning
    // orbit_core/web/api/v1 · 2m 51s" while Stop and Reset did nothing at
    // all, because they were aimed at a different root's queue. Nothing was
    // stuck; the screen was describing one project and its buttons another.
    //
    // Only when BOTH are known: without a viewedRoot (or an answer that
    // predates `activeRoot`) the old label is still the honest one, because
    // there is nothing to compare.
    const activeRoot = live.activeRoot ?? null
    const elsewhere = activeRoot !== null && viewedRoot != null && activeRoot !== viewedRoot
    if (elsewhere) {
      const parts = [`Another project is learning (${projectNameOf(activeRoot)})`]
      const away =
        live.startedAt === null || live.startedAt === undefined
          ? ''
          : formatElapsed(Date.now() - live.startedAt)
      if (away.length > 0) parts.push(away)
      return parts.join(' · ')
    }
    const what = live.activeModule === null ? 'Learning' : `Learning ${live.activeModule}`
    const parts = [what]
    // HOW LONG THIS ONE HAS BEEN GOING. Six minutes on one module is the fact
    // that turns "is it stuck?" into an answer, and it was nowhere on screen.
    const elapsed =
      live.startedAt === null || live.startedAt === undefined
        ? ''
        : formatElapsed(Date.now() - live.startedAt)
    if (elapsed.length > 0) parts.push(elapsed)
    // HOW MUCH IS LEFT. "Learning flow/resources" with 356 modules behind it
    // reads as almost done; it was hours from done.
    if (live.queued > 0) parts.push(`${String(live.queued)} queued`)
    return parts.join(' · ')
  }
  if (paused) {
    return live.queued > 0 ? `Paused · ${live.queued} queued` : 'Paused'
  }
  return live.queued > 0 ? `Idle · ${live.queued} queued` : 'Idle'
}

/** The last segment of a root path — what the reader calls that project. */
function projectNameOf(rootPath: string): string {
  const parts = rootPath.split('/').filter((segment) => segment.length > 0)
  return parts[parts.length - 1] ?? rootPath
}

/**
 * How many ticks the progress collar is cut into.
 *
 * SIXTY, not ten. Ten chunky arcs read as a segmented ring; sixty fine ticks
 * read as a DIAL, which is the shape a percentage is normally worn in and the
 * one that was asked for. It also means one tick is 1.67% — fine enough that
 * the ring moves for a single part landing out of forty, which ten could not
 * show without lying about the size of the step.
 */
export const PROGRESS_SEGMENTS = 60

/**
 * How many segments of a node's progress collar are filled.
 *
 * REAL FRACTION OR NONE AT ALL. A feature pass reports `{parts, learned}` on
 * `learn:featureParts` — named once when the parts are found, then again after
 * each is investigated — so this is a number the app actually knows. Where it
 * does not (a pass whose parts are not named yet, a module read that reports
 * only the file it is on), the answer is `null` and the caller shows the
 * indeterminate collar instead. Inventing the fraction would be inventing the
 * one number a reader would act on.
 *
 * NEVER FULL UNTIL IT IS DONE. `Math.floor` on anything short of the whole,
 * because a collar reading 10/10 beside a pass still running is the same lie
 * as a percentage that sticks at 99: the last segment lands when the last part
 * does.
 *
 * NEVER EMPTY ONCE IT HAS STARTED. One part of forty is less than half a
 * segment, and rounding it to nothing shows a reader who has waited minutes a
 * collar identical to the one they started with.
 */
export function filledSegments(
  learned: number,
  parts: number,
  segments: number = PROGRESS_SEGMENTS,
): number | null {
  if (!Number.isFinite(parts) || !Number.isFinite(learned)) return null
  if (parts <= 0) return null
  const done = Math.max(0, Math.min(learned, parts))
  if (done === 0) return 0
  if (done >= parts) return segments
  return Math.min(segments - 1, Math.max(1, Math.floor((done / parts) * segments)))
}

/** The shape `understoodFraction` needs off a feature-graph node. */
export interface UnderstandingCount {
  kind: 'core' | 'child' | 'part'
  understanding: 'none' | 'learning' | 'learned' | 'stale'
  partOf?: string
}

/**
 * How much of a ring has been understood — the centre's own figure.
 *
 * THE CENTRE MUST COUNT WHAT ITS RING HOLDS. It was counting modules
 * (`computeLearnProgress`, the Learning panel's "0/362") while the ring around
 * it held FEATURES, so a board with two features finished at 100% reported 0%
 * in the middle. Two populations, one screen, and nothing on it said they were
 * different questions.
 *
 * This is NOT the aggregation `d5ae3b83` removed. That was a node claiming an
 * UNDERSTANDING it did not have — a domain wearing its features' dot, a feature
 * wearing its modules'. A count of how many things on a ring are learned is a
 * different sentence: it is verifiable, it belongs to the ring rather than the
 * node, and the collar's hover says which population it counted. The dot still
 * speaks only for itself.
 *
 * `stale` is not done. It was learned once and the code moved underneath it, so
 * it needs the work again — counting it as complete would report a project as
 * finished the moment it drifted.
 */
export function understoodFraction(
  nodes: readonly UnderstandingCount[] | null | undefined,
  scope: { partsOf: string } | 'features',
): { done: number; total: number } | null {
  if (nodes === null || nodes === undefined) return null
  // THE PARTS BRANCH IS ONE RULE, AND IT LIVES IN `understoodBySlug`. Asking it
  // for one owner rather than filtering here is what keeps a per-node lookup
  // and a whole-graph index from ever counting a part differently
  // (allowed-pattern #14) — the board draws a percentage on every cell now, so
  // both readings run on the same paint.
  if (scope !== 'features') return understoodBySlug(nodes).get(scope.partsOf) ?? null
  // THE CAPABILITIES BRANCH IS THE CLI'S OWN FUNCTION. The Workspace map counts
  // each project's figure in the CLI, and this strip counts the zoomed-in
  // project's here — one arithmetic, so the number on a project's header band
  // and the number on its title strip cannot disagree.
  return featuresUnderstood(nodes)
}

/**
 * Every owner's parts fraction, in ONE pass over the graph.
 *
 * Same arithmetic as `understoodFraction({ partsOf })` and the same definition
 * of done (`stale` is not done — it was learned once and the code moved
 * underneath it). The difference is only WHO ASKS: a cell asking for itself
 * wants one owner, and a sheet painting a standing percentage on every cell
 * wants all of them without walking the node list once per rectangle.
 *
 * Keyed by the OWNER'S SLUG (`partOf`), which is what a part carries. Owners
 * with no parts are absent rather than `0/0` — a feature nobody has broken into
 * parts has no fraction to report, and drawing one as an empty dial would be a
 * claim about work that was never scoped.
 */
export function understoodBySlug(
  nodes: readonly UnderstandingCount[] | null | undefined,
): Map<string, { done: number; total: number }> {
  const out = new Map<string, { done: number; total: number }>()
  if (nodes === null || nodes === undefined) return out
  for (const node of nodes) {
    if (node.kind !== 'part') continue
    const owner = node.partOf
    if (owner === undefined || owner.length === 0) continue
    const row = out.get(owner) ?? { done: 0, total: 0 }
    row.total += 1
    if (node.understanding === 'learned') row.done += 1
    out.set(owner, row)
  }
  return out
}

/* ── THE LEARNING LENS'S NUMBER (Phase 8) ───────────────────────────────────*/

/**
 * How much of the GROUND under a cell has been learned.
 *
 * A feature is not a module and is never learned as one — `understandingOf` and
 * a module's learning state are two different claims, and this file has been
 * careful to keep them apart. The lens asks a third question, which is neither:
 * of the MODULES this feature's files live in, how many has the learner read?
 * That is a fact about modules, answered in the module vocabulary, and drawn as
 * a line at the cell's foot rather than as a fill — a fill would read as the
 * feature itself being understood, which is the claim it must not make.
 *
 * ONE JOIN, ONE MATCHER. The file → module rule is `moduleOfPath` and the
 * learned ÷ counted rule is `coverageOf`, both in `territory-layout.ts` and both
 * already shared with the code map. This adds no arithmetic of its own: it
 * dedupes the modules, asks `coverageOf` for the share, and reports the counts
 * behind it so a caller can say "3 of 8" without recomputing the numerator from
 * a rule of its own (allowed-pattern #14).
 *
 * `total` is the COUNTABLE module set — learning-ignored modules leave BOTH
 * sides, exactly as they do in `computeLearnProgress` and `coverageOf`, so the
 * lens and the panel can never disagree about what counts. `learned` is read
 * BACK off the share rather than counted a second time; the rounding is exact
 * because the share is `learned / total` by construction.
 *
 * An empty (or wholly ignored) file set answers `{ share: 0, learned: 0,
 * total: 0 }` — a cell standing on no countable ground draws no line at all,
 * and 0/0 must never be drawn as full.
 */
export function lensCoverage(
  files: readonly string[],
  learning: readonly BlueprintLearningEntry[] = [],
  ignoreExtras: readonly string[] = [],
): { share: number; learned: number; total: number } {
  const modules = new Set<string>()
  for (const file of files) {
    const module = moduleOfPath(file)
    if (module === null) continue
    modules.add(module)
  }
  const counted = [...modules].filter((module) => ignoreSource(module, ignoreExtras) === null)
  if (counted.length === 0) return { share: 0, learned: 0, total: 0 }
  const share = coverageOf(counted, learning, ignoreExtras)
  return { share, learned: Math.round(share * counted.length), total: counted.length }
}

/**
 * The counts half of the Learning panel's headline.
 *
 * TWO PIPELINES, AND ONLY ONE WAS NAMED. Learning a FEATURE goes through
 * `understandFeature`; learning a MODULE goes through the orchestrator's queue,
 * and only the second is what these counters have ever been about. The panel
 * said "Idle · 0.00% · 0/362 learned" — every word true, and read by a user
 * looking at a board with seven features learned as "nothing has been learned".
 *
 * The fix is not to merge the numbers. A feature is not one of the 362 modules,
 * and moving that total for it would trade a silence for a wrong count (the
 * rule `learnStateLabel` already states). It is to SAY WHICH IS WHICH, and to
 * lead with the population the reader is actually looking at — the board's
 * default view is features; the code map is behind its own button.
 *
 * The module percentage stops leading the sentence when a feature count exists,
 * because a bare "0.00%" at the front is the part that reads as a verdict on
 * the whole project.
 */
export function learnCountsLabel(
  modules: { percentLabel: string; learned: number; total: number },
  features: { done: number; total: number } | null,
): string {
  const moduleCount = `${String(modules.learned)}/${String(modules.total)} modules`
  if (features === null) return `${modules.percentLabel} · ${moduleCount} learned`
  return `${String(features.done)}/${String(features.total)} features learned · ${moduleCount}`
}
