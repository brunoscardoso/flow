// Feature graph feed (feature-blueprint).
//
// Runs the bundled CLI `blueprint features graph --json` and parses stdout into
// a BlueprintFeatureGraph the board can render. Mirrors brief-runner: captures
// STDOUT, FAIL-SOFT on every path — a missing CLI, a refusal line, a timeout or
// unparseable output all yield `available: false` with a one-line reason, so the
// board falls back to its empty state rather than breaking.
import { spawn } from 'child_process'

import type { BundledCli } from './derive-runner'
import type {
  BlueprintFeatureEdge,
  BlueprintFeatureFolders,
  BlueprintFeatureGraph,
  BlueprintFeatureLimitations,
  BlueprintFeatureNode,
  BlueprintFolderRow,
  BlueprintMissingHome,
  BlueprintViewFailure,
} from '../../shared/ipc-contract'
import { isFeatureRole, type FeatureRole, type FeatureRoleSource } from '../../shared/feature-role'

const FEATURES_TIMEOUT_MS = 30_000

function unavailable(reason: string): BlueprintFeatureGraph {
  return { available: false, reason, nodes: [], edges: [], limitations: null }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

/**
 * Narrow the gap report.
 *
 * Returns null — meaning UNKNOWN — when the CLI sent no `limitations` block or
 * sent one that is not an object. A default-shaped zero would be read by the
 * board as "measured, and nothing is missing", which is the opposite of what an
 * older bundle actually told us.
 */
function parseLimitations(raw: unknown): BlueprintFeatureLimitations | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const content = (obj.content ?? {}) as Record<string, unknown>
  const views = (obj.views ?? {}) as Record<string, unknown>
  if (typeof content.features !== 'number') return null

  const failures: BlueprintViewFailure[] = []
  for (const entry of Array.isArray(views.failures) ? views.failures : []) {
    const f = entry as Record<string, unknown>
    if (typeof f.slug !== 'string') continue
    failures.push({
      slug: f.slug,
      path: typeof f.path === 'string' ? f.path : '',
      state: f.state === 'unreadable' ? 'unreadable' : 'invalid',
      orphaned: f.orphaned === true,
      orphanReason: typeof f.orphanReason === 'string' ? f.orphanReason : '',
      // VERBATIM. The validator's wording is the finding; re-phrasing it here
      // would put a second opinion between the reader and the check that ran.
      errors: (Array.isArray(f.errors) ? f.errors : []).filter(
        (error): error is string => typeof error === 'string',
      ),
    })
  }

  const missingHomes = narrowMissingHomes(obj.missingHomes)
  return {
    ...(missingHomes === null ? {} : { missingHomes }),
    content: {
      features: count(content.features),
      withParts: count(content.withParts),
      withLearned: count(content.withLearned),
      unreadable: count(content.unreadable),
    },
    views: {
      total: count(views.total),
      valid: count(views.valid),
      broken: count(views.broken),
      orphaned: count(views.orphaned),
      failures,
    },
  }
}

/**
 * Chosen homes that no longer name a folder. Null when the CLI sent no list —
 * an older bundle could not say, and an empty list would claim it checked.
 * A malformed entry is dropped.
 */
function narrowMissingHomes(raw: unknown): BlueprintMissingHome[] | null {
  if (!Array.isArray(raw)) return null
  const out: BlueprintMissingHome[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const m = entry as Record<string, unknown>
    if (!nonEmpty(m.id) || !nonEmpty(m.feature) || !nonEmpty(m.home)) continue
    out.push({ id: m.id, feature: m.feature, part: nonEmpty(m.part) ? m.part : null, home: m.home })
  }
  return out
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function finiteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Rows a node may carry — the CLI's own cap, enforced again at the boundary. */
export const MAX_FOLDER_ROWS = 4

/**
 * Narrow a node's `folders` — WHERE IT LIVES.
 *
 * A malformed row is DROPPED (a path that is not a non-empty string, a count
 * that is not a finite non-negative number); `share` is clamped to 0..1; at
 * most `MAX_FOLDER_ROWS` survive. A block with no surviving row is null — no
 * rows is drawn as no rows, never as a guessed folder.
 */
export function narrowFolders(raw: unknown): BlueprintFeatureFolders | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const f = raw as Record<string, unknown>
  const rows: BlueprintFolderRow[] = []
  for (const entry of Array.isArray(f.rows) ? f.rows : []) {
    if (rows.length >= MAX_FOLDER_ROWS) break
    if (typeof entry !== 'object' || entry === null) continue
    const r = entry as Record<string, unknown>
    if (!nonEmpty(r.path) || !finiteCount(r.lines) || !finiteCount(r.files)) continue
    if (typeof r.share !== 'number' || !Number.isFinite(r.share)) continue
    rows.push({
      path: r.path,
      lines: r.lines,
      files: r.files,
      share: Math.min(1, Math.max(0, r.share)),
      ...(r.pinned === true ? { pinned: true as const } : {}),
    })
  }
  if (rows.length === 0) return null
  return {
    rows,
    // Never fewer folders than rows we are about to draw.
    folderCount: Math.max(rows.length, finiteCount(f.folderCount) ? Math.trunc(f.folderCount) : 0),
    spread: f.spread === true,
    pinned: f.pinned === true && rows[0]?.pinned === true,
    pinMissing: nonEmpty(f.pinMissing) ? f.pinMissing : null,
    files: finiteCount(f.files) ? Math.trunc(f.files) : 0,
    lines: finiteCount(f.lines) ? Math.trunc(f.lines) : 0,
    // The import trace was left out (a cold index); the rows are still true.
    ...(f.partial === true ? { partial: true as const } : {}),
  }
}

const UNDERSTANDING = new Set(['none', 'learning', 'learned', 'stale'])

/**
 * The kinds this reader lets through — a WHITELIST, never a passthrough.
 *
 * `part` was added when the CLI began emitting a feature's `## Parts` as nodes.
 * Until then this guard read `n.kind !== 'core' && n.kind !== 'child'`, so every
 * part node the CLI sent was dropped HERE, in main, before the renderer could
 * see it — a fix applied only to the renderer's mapping would have produced a
 * still-empty ring and looked like a failed change.
 *
 * A kind this set does not name is still DROPPED. A future CLI kind must be
 * taught to the board deliberately; arriving on the ring by default is how an
 * unrecognised thing gets drawn as whatever it happens to sit next to.
 */
const FEATURE_KINDS = new Set(['core', 'child', 'part'])

/**
 * Narrow the CLI's JSON to the contract shape. A malformed entry is DROPPED
 * rather than passed through: a feature board rendering half-understood nodes
 * confidently is worse than one rendering fewer, and the user has no way to
 * tell the difference.
 */
/** A `size` the CLI measured — two finite, non-negative counts. */
function isSize(raw: unknown): raw is { files: number; lines: number } {
  if (typeof raw !== 'object' || raw === null) return false
  const { files, lines } = raw as Record<string, unknown>
  return (
    typeof files === 'number' &&
    typeof lines === 'number' &&
    Number.isFinite(files) &&
    Number.isFinite(lines) &&
    files >= 0 &&
    lines >= 0
  )
}

/**
 * Narrow a CLI node list to the contract shape — shared by the board's own
 * graph read and the Workspace map's per-project graphs, so a node means the
 * same thing on both sheets (allowed-pattern #14).
 */
export function narrowFeatureNodes(rawNodes: unknown): BlueprintFeatureNode[] {
  const nodes: BlueprintFeatureNode[] = []
  for (const raw of Array.isArray(rawNodes) ? rawNodes : []) {
    const n = raw as Record<string, unknown>
    if (
      typeof n.id !== 'string' ||
      typeof n.slug !== 'string' ||
      typeof n.name !== 'string' ||
      typeof n.kind !== 'string' ||
      !FEATURE_KINDS.has(n.kind) ||
      typeof n.understanding !== 'string' ||
      !UNDERSTANDING.has(n.understanding) ||
      typeof n.active !== 'boolean' ||
      typeof n.anchorCount !== 'number'
    ) {
      continue
    }
    nodes.push({
      id: n.id,
      slug: n.slug,
      name: n.name,
      kind: n.kind as BlueprintFeatureNode['kind'],
      understanding: n.understanding as BlueprintFeatureNode['understanding'],
      active: n.active,
      anchorCount: n.anchorCount,
      // HOW MUCH CODE THE NODE STANDS ON. Both numbers or neither: a size with
      // one half missing would draw an area from a number that was never sent.
      ...(isSize(n.size) ? { size: { files: n.size.files, lines: n.size.lines } } : {}),
      ...(typeof n.summary === 'string' && n.summary.length > 0 ? { summary: n.summary } : {}),
      // WHERE IT LIVES — validated row by row; absent stays absent.
      ...withFolders(n.folders),
      ...(typeof n.parent === 'string' ? { parent: n.parent } : {}),
      // WHICH FEATURE A PART BELONGS TO, by slug. Same absent-stays-absent rule
      // as `domain` below: a part carries it, a core feature and a change
      // record do not, and synthesising one here would invent an ownership the
      // CLI never claimed.
      ...(typeof n.partOf === 'string' && n.partOf.trim().length > 0 ? { partOf: n.partOf } : {}),
      // The board's root-ring grouping. Absent stays absent — a synthesised
      // default here would be indistinguishable from a human-written domain.
      ...(typeof n.domain === 'string' && n.domain.trim().length > 0 ? { domain: n.domain } : {}),
      // WHAT KIND OF THING IT IS. Both fields or neither, each on its list: an
      // off-list role from a newer or a broken bundle is dropped, so the board
      // draws no icon rather than one it cannot name.
      ...withRole(n.role, n.roleSource),
    })
  }
  return nodes
}

const ROLE_SOURCES: ReadonlySet<string> = new Set<FeatureRoleSource>(['person', 'learn', 'guess'])

function withRole(role: unknown, source: unknown): { role?: FeatureRole; roleSource?: FeatureRoleSource } {
  if (!isFeatureRole(role) || typeof source !== 'string' || !ROLE_SOURCES.has(source)) return {}
  return { role, roleSource: source as FeatureRoleSource }
}

function withFolders(raw: unknown): { folders?: BlueprintFeatureFolders } {
  const folders = narrowFolders(raw)
  return folders === null ? {} : { folders }
}

/** Narrow a CLI edge list — see `narrowFeatureNodes`. */
export function narrowFeatureEdges(rawEdges: unknown): BlueprintFeatureEdge[] {
  const edges: BlueprintFeatureEdge[] = []
  for (const raw of Array.isArray(rawEdges) ? rawEdges : []) {
    const e = raw as Record<string, unknown>
    if (typeof e.from !== 'string' || typeof e.to !== 'string') continue
    edges.push({
      from: e.from,
      to: e.to,
      // The staleness verdict travels WITH the edge: a relationship whose
      // mechanism moved must not be drawn as a verified fact. Absent stays
      // absent — an older bundle sends none, and synthesising a `stale: false`
      // here would claim a check that never ran.
      ...(e.stale === true ? { stale: true } : {}),
    })
  }
  return edges
}

function parseFeaturesJson(stdout: string): BlueprintFeatureGraph {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return unavailable('no output')
  if (!trimmed.startsWith('{')) return unavailable(trimmed.split('\n')[0] ?? 'features refused')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return unavailable('unparseable features output')
  }
  const obj = parsed as Record<string, unknown>

  const nodes = narrowFeatureNodes(obj.nodes)
  const edges = narrowFeatureEdges(obj.edges)

  return {
    available: true,
    reason: null,
    nodes,
    edges,
    limitations: parseLimitations(obj.limitations),
    // Whether the folder rows had the project's whole import index. Absent
    // (an older CLI) stays absent; only the CLI's own words pass.
    ...(obj.importIndex === 'complete' || obj.importIndex === 'partial' || obj.importIndex === 'none'
      ? { importIndex: obj.importIndex }
      : {}),
  }
}

/**
 * Run the feature graph for `rootPath` via the bundled CLI. Fail-soft — never
 * throws. `spawnFn` is injectable for tests.
 */
/** Discovery walks the repo and the plan corpus — slower than a graph read. */
const DISCOVER_TIMEOUT_MS = 120_000

export function runFeatures(
  bundledCli: BundledCli | null,
  rootPath: string,
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<BlueprintFeatureGraph> {
  if (bundledCli === null) return Promise.resolve(unavailable('bundled CLI unavailable'))
  const spawnFn = deps.spawnFn ?? spawn
  const timeoutMs = deps.timeoutMs ?? FEATURES_TIMEOUT_MS
  const args = [bundledCli.cliPath, 'blueprint', 'features', 'graph', '--json']
  return new Promise<BlueprintFeatureGraph>((resolve) => {
    let stdout = ''
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(bundledCli.execPath, args, {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    } catch (error) {
      resolve(unavailable((error as Error).message))
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(unavailable('timed out'))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve(unavailable(error.message))
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(parseFeaturesJson(stdout))
    })
  })
}

/**
 * Populate an EMPTY feature store (#1307): `features discover` mines the
 * repo's surfaces and the plan corpus into staged candidates, then
 * `features confirm --all --kind core` adopts them.
 *
 * This exists because the board's empty state used to instruct the reader to
 * run `features seed`, which is a guaranteed no-op in exactly that state
 * (seed ADOPTS files that already exist; an empty board means there are
 * none). An IDE offering a command that cannot work is worse than offering
 * nothing, so the empty state now runs the pair that does.
 *
 * Fail-soft like its sibling: never throws, and reports why on failure.
 */
export async function runFeatureDiscovery(
  bundledCli: BundledCli | null,
  rootPath: string,
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<{ ok: boolean; reason: string | null }> {
  if (bundledCli === null) return { ok: false, reason: 'bundled CLI unavailable' }
  const spawnFn = deps.spawnFn ?? spawn
  const timeoutMs = deps.timeoutMs ?? DISCOVER_TIMEOUT_MS

  const run = (args: string[]): Promise<{ ok: boolean; reason: string | null }> =>
    new Promise((resolve) => {
      let stderr = ''
      let child: ReturnType<typeof spawnFn>
      try {
        child = spawnFn(bundledCli.execPath, [bundledCli.cliPath, ...args], {
          cwd: rootPath,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
      } catch (error) {
        resolve({ ok: false, reason: (error as Error).message })
        return
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve({ ok: false, reason: 'timed out' })
      }, timeoutMs)
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ ok: false, reason: error.message })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(
          code === 0
            ? { ok: true, reason: null }
            : { ok: false, reason: stderr.trim().split('\n').pop() ?? `exited ${String(code)}` },
        )
      })
    })

  const discovered = await run(['blueprint', 'features', 'discover'])
  if (!discovered.ok) return discovered
  // Confirming is the half that actually puts anything on the board — a
  // discover that stages candidates nobody adopts leaves it just as empty.
  return run(['blueprint', 'features', 'confirm', '--all', '--kind', 'core'])
}

/**
 * Write the derived indexes for a root — `blueprint features index` (#1716).
 *
 * The Changes & discoveries browser reads a persisted corpus index that only
 * a discover pass wrote, and automatic discovery fires only on an EMPTY
 * feature store (#1307) — so any store populated before the index existed
 * (#1532) never got one, and the browser promised "the next feature discovery
 * pass" forever. This runs the index-only verb: it mines the corpus and
 * writes flow/brain/.derived/corpus-index.json without touching anchors,
 * candidates or the store. Fail-soft like its siblings — never throws.
 */
export async function runFeatureIndexing(
  bundledCli: BundledCli | null,
  rootPath: string,
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<{ ok: boolean; reason: string | null }> {
  if (bundledCli === null) return { ok: false, reason: 'bundled CLI unavailable' }
  const spawnFn = deps.spawnFn ?? spawn
  const timeoutMs = deps.timeoutMs ?? DISCOVER_TIMEOUT_MS
  return new Promise((resolve) => {
    let stderr = ''
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(bundledCli.execPath, [bundledCli.cliPath, 'blueprint', 'features', 'index'], {
        cwd: rootPath,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    } catch (error) {
      resolve({ ok: false, reason: (error as Error).message })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, reason: 'timed out' })
    }, timeoutMs)
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(
        code === 0
          ? { ok: true, reason: null }
          : { ok: false, reason: stderr.trim().split('\n').pop() ?? `exited ${String(code)}` },
      )
    })
  })
}
