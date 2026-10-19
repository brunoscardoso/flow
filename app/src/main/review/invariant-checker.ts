// Invariant checker (#898 Phase B) — the background service that reads each
// touched module's learned `## Invariants` against its changed hunks and
// returns ADVISORY verdicts. Never gates approval, never blocks UI, zero
// tokens on unchanged input (hash-keyed cache).
//
// Discipline mirrors review-verdict-writer.ts: this module touches only
// node:fs/path/crypto (no Electron) so it loads under plain Node; every I/O
// and model seam is injected (`InvariantCheckerDeps`) — unit tests mock the
// runner, wiring (src/main/index.ts) supplies the real git diff + the
// haiku-tier `generateBrief` one-shot.
//
// Caps are LOUD, never silent (no-silent-caps rule): a pass checks at most
// MAX_MODULES_PER_PASS modules and MAX_HUNK_BYTES of diff per module; anything
// over-cap is reported `not-checked` with its reason.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type {
  BlueprintGraph,
  InvariantCheckResult,
  InvariantVerdict,
  InvariantVerdictKind,
  ModuleCheckReport,
} from '../../shared/ipc-contract'
import { moduleNodeIdForPath } from '../../shared/module-owner'
import { parseInvariants } from '../learn/invariants'

// Verdict/report/result types live in the shared contract (ipc-contract.ts) —
// they cross the IPC boundary; re-exported here for the checker's consumers.
export type {
  InvariantCheckResult,
  InvariantVerdict,
  InvariantVerdictKind,
  ModuleCheckReport,
  ModuleCheckStatus,
} from '../../shared/ipc-contract'

/** ≤8 modules per pass — over-cap modules surface `not-checked`. */
export const MAX_MODULES_PER_PASS = 8
/** ≤32KB of diff hunks per module — larger modules surface `not-checked`. */
export const MAX_HUNK_BYTES = 32 * 1024

const VERDICT_KINDS: readonly InvariantVerdictKind[] = ['violates', 'touches', 'clear']

// ── Cache (derived/disposable tier) ─────────────────────────────────────────

/** `flow/brain/.structure/invariant-verdicts.json` — safe to delete. */
export const CACHE_RELATIVE_PATH = join('flow', 'brain', '.structure', 'invariant-verdicts.json')

interface CacheEntry {
  /** The content key (`cacheKeyFor`) this entry is valid for. */
  key: string
  verdicts: InvariantVerdict[]
}

export interface InvariantVerdictCache {
  version: 2
  /** Keyed by MODULE, one entry each, holding its current content key. A module
   *  has exactly one live diff state at a time, so keying by module bounds the
   *  store at O(modules) structurally — v1 keyed by `<module>|<docHash>|<hunksHash>`
   *  and grew one permanent, never-hit-again entry per diff state (#1682). */
  entries: Record<string, CacheEntry>
}

const EMPTY_CACHE: InvariantVerdictCache = { version: 2, entries: {} }

export function loadVerdictCache(rootPath: string): InvariantVerdictCache {
  const path = join(rootPath, CACHE_RELATIVE_PATH)
  if (!existsSync(path)) return { ...EMPTY_CACHE, entries: {} }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as InvariantVerdictCache
    // Version mismatch covers legacy v1 (add-only, unbounded) files: the tier
    // is disposable, so they are simply rebuilt bounded (#1682).
    if (raw?.version !== 2 || typeof raw.entries !== 'object' || raw.entries === null) {
      return { ...EMPTY_CACHE, entries: {} }
    }
    return raw
  } catch {
    return { ...EMPTY_CACHE, entries: {} } // disposable tier — corrupt = rebuilt
  }
}

export function saveVerdictCache(rootPath: string, cache: InvariantVerdictCache): void {
  const path = join(rootPath, CACHE_RELATIVE_PATH)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(cache))
  } catch (error) {
    console.warn('[invariants] cache write failed (non-fatal):', error)
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export const cacheKeyFor = (module: string, docText: string, hunks: string): string =>
  `${module}|${sha256(docText)}|${sha256(hunks)}`

// ── Grouping ────────────────────────────────────────────────────────────────

/**
 * Group changed files under their owning module DIRECTORY (the module node's
 * `sourceFile`) via the shared rollup. Files no module owns are dropped —
 * they are outside the board's module spine and have no learned doc.
 */
export function groupChangedFilesByModule(
  graph: BlueprintGraph | null,
  changedFiles: readonly string[],
): Map<string, string[]> {
  const byModule = new Map<string, string[]>()
  if (graph === null) return byModule
  const dirById = new Map<string, string>()
  for (const node of graph.nodes) {
    if (node.kind === 'module') dirById.set(node.id, node.sourceFile)
  }
  for (const filePath of changedFiles) {
    const nodeId = moduleNodeIdForPath(graph, filePath)
    if (nodeId === null) continue
    const dir = dirById.get(nodeId)
    if (dir === undefined) continue
    const bucket = byModule.get(dir)
    if (bucket === undefined) byModule.set(dir, [filePath])
    else bucket.push(filePath)
  }
  return byModule
}

// ── Prompt + parse ──────────────────────────────────────────────────────────

/** Deterministic prompt: the module's invariants + its changed hunks. */
export function buildInvariantPrompt(input: {
  module: string
  invariants: readonly string[]
  hunksByFile: ReadonlyArray<{ filePath: string; hunks: string }>
}): string {
  const invariantList = input.invariants.map((text) => `- ${text}`).join('\n')
  const diffs = input.hunksByFile
    .map(({ filePath, hunks }) => `### ${filePath}\n${hunks}`)
    .join('\n\n')
  return [
    `You are checking the module \`${input.module}\` for invariant violations.`,
    'These invariants were learned from the module\'s code and are believed to hold:',
    invariantList,
    '',
    'The working tree has these uncommitted changes (unified diff hunks):',
    diffs,
    '',
    'For EACH invariant, judge it against the diffs:',
    '- "violates": the change plainly breaks the invariant',
    '- "touches": the change modifies code the invariant depends on, but does not clearly break it',
    '- "clear": the change does not affect the invariant',
    '',
    'Reply with ONLY a JSON array — no prose, no code fence — of entries:',
    '[{"invariant": "<the invariant text>", "verdict": "violates|touches|clear", "filePath": "<the changed file it applies to>", "evidence": "<one line quoting the diff>"}]',
    '',
    'Emit one entry per (invariant, relevant file). Omit "clear" entries for files an invariant does not mention. Be conservative: prefer "touches" over "violates" unless the break is explicit.',
  ].join('\n')
}

/**
 * Parse the model's output, fail-soft: bare JSON array, or one inside a fence /
 * stray prose (outermost [...] extracted). Unknown verdicts, empty invariants,
 * and files outside the module's changed set are dropped. Never throws.
 */
export function parseInvariantModelOutput(
  raw: string,
  module: string,
  changedFiles: readonly string[],
): InvariantVerdict[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const known = new Set(changedFiles)
  const verdicts: InvariantVerdict[] = []
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const invariant = typeof entry.invariant === 'string' ? entry.invariant.trim() : ''
    const verdict = entry.verdict as InvariantVerdictKind
    const filePath = typeof entry.filePath === 'string' ? entry.filePath.trim() : ''
    if (invariant === '' || !VERDICT_KINDS.includes(verdict)) continue
    if (filePath !== '' && !known.has(filePath)) continue
    verdicts.push({
      module,
      invariant,
      verdict,
      filePath,
      evidence: typeof entry.evidence === 'string' ? entry.evidence.slice(0, 300) : '',
    })
  }
  return verdicts
}

// ── Rounds entries (re-review memory) ───────────────────────────────────────

/** `review_verdict`-style rounds entry for one advisory finding. Fingerprint
 *  `<module>+<invariant>+<file>` — re-review memory suppresses unchanged
 *  re-reports of the same finding. */
export interface InvariantRoundsEntry {
  ts: string
  run_id: string
  type: 'review_verdict'
  phase: null
  finding_fingerprint: string
  classification: 'kept'
  reason: string
  anchors: Array<{ kind: 'file'; ref: string; file: string }>
}

export function buildInvariantRoundsEntries(
  verdicts: readonly InvariantVerdict[],
  now: Date,
): InvariantRoundsEntry[] {
  return verdicts
    .filter((v) => v.verdict !== 'clear')
    .map((v) => ({
      ts: now.toISOString(),
      run_id: 'invariant-checker',
      type: 'review_verdict' as const,
      phase: null,
      finding_fingerprint: `${v.module}+${v.invariant}+${v.filePath}`,
      classification: 'kept' as const,
      reason: `${v.verdict}: ${v.evidence}`.trim(),
      anchors:
        v.filePath === ''
          ? []
          : [{ kind: 'file' as const, ref: v.filePath, file: v.filePath }],
    }))
}

/** Append advisory findings to `flow/.rounds.jsonl` — fail-soft like the
 *  review-verdict writer (a broken rounds file must never break the checker). */
export async function appendInvariantRounds(
  rootPath: string,
  entries: readonly InvariantRoundsEntry[],
): Promise<void> {
  if (entries.length === 0) return
  const path = join(rootPath, 'flow', '.rounds.jsonl')
  try {
    await appendFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
  } catch (error) {
    console.warn('[invariants] rounds append failed (non-fatal):', error)
  }
}

// ── The check pass ──────────────────────────────────────────────────────────

export interface InvariantCheckerDeps {
  /** Learned doc text for a module dir, or null when never learned. */
  readDoc: (module: string) => string | null
  /** Working-tree diff hunks for one repo-relative file (unified diff text). */
  diffFor: (filePath: string) => Promise<string>
  /** One-shot model call (haiku-tier in wiring; mocked in tests). Null = model
   *  unavailable — the module reports `not-checked`. */
  runModel: (prompt: string) => Promise<string | null>
  /** Cache load/save — default to loadVerdictCache/saveVerdictCache in wiring. */
  loadCache: () => InvariantVerdictCache
  saveCache: (cache: InvariantVerdictCache) => void
  /** Clock — injected so tests are deterministic. */
  now?: () => Date
}

/**
 * One advisory pass: group the changed files by module, judge each in-cap
 * module's invariants against its hunks (cache-first), and return every
 * module's outcome. Deterministic order (modules sorted); never throws.
 */
export async function runInvariantCheck(
  input: { graph: BlueprintGraph | null; changedFiles: readonly string[] },
  deps: InvariantCheckerDeps,
): Promise<InvariantCheckResult> {
  const grouped = groupChangedFilesByModule(input.graph, input.changedFiles)
  const modules = [...grouped.keys()].sort((a, b) => a.localeCompare(b))
  const inCap = modules.slice(0, MAX_MODULES_PER_PASS)
  const overCap = modules.slice(MAX_MODULES_PER_PASS)

  const cache = deps.loadCache()
  let cacheDirty = false
  const verdicts: InvariantVerdict[] = []
  const reports: ModuleCheckReport[] = []

  for (const module of inCap) {
    const files = grouped.get(module) ?? []
    const docText = deps.readDoc(module)
    if (docText === null) {
      reports.push({ module, status: 'no-invariants', reason: 'no invariants learned yet' })
      continue
    }
    const parsed = parseInvariants(docText)
    if (!parsed.present) {
      reports.push({ module, status: 'no-invariants', reason: 'no invariants learned yet' })
      continue
    }
    if (parsed.invariants.length === 0) {
      reports.push({ module, status: 'no-invariants', reason: 'none observed at learn time' })
      continue
    }

    const hunksByFile: Array<{ filePath: string; hunks: string }> = []
    let totalBytes = 0
    for (const filePath of files) {
      let hunks = ''
      try {
        hunks = await deps.diffFor(filePath)
      } catch {
        hunks = '' // unreadable diff — judged without it
      }
      totalBytes += Buffer.byteLength(hunks, 'utf8')
      hunksByFile.push({ filePath, hunks })
    }
    if (totalBytes > MAX_HUNK_BYTES) {
      reports.push({
        module,
        status: 'not-checked',
        reason: `not checked (too large: ${Math.round(totalBytes / 1024)}KB of diff, cap ${MAX_HUNK_BYTES / 1024}KB)`,
      })
      continue
    }

    const hunksCombined = hunksByFile.map((h) => `${h.filePath}\n${h.hunks}`).join('\n')
    const key = cacheKeyFor(module, docText, hunksCombined)
    const hit = cache.entries[module]
    if (hit !== undefined && hit.key === key) {
      verdicts.push(...hit.verdicts)
      reports.push({ module, status: 'checked', cached: true })
      continue
    }

    const prompt = buildInvariantPrompt({
      module,
      invariants: parsed.invariants.map((inv) => inv.text),
      hunksByFile,
    })
    let raw: string | null = null
    try {
      raw = await deps.runModel(prompt)
    } catch (error) {
      console.warn('[invariants] model call failed (non-fatal):', error)
    }
    if (raw === null) {
      reports.push({ module, status: 'not-checked', reason: 'model unavailable' })
      continue
    }
    const moduleVerdicts = parseInvariantModelOutput(raw, module, files)
    // Replaces the module's previous entry — the superseded diff state can
    // never be hit again, so keeping it would only grow the file (#1682).
    cache.entries[module] = { key, verdicts: moduleVerdicts }
    cacheDirty = true
    verdicts.push(...moduleVerdicts)
    reports.push({ module, status: 'checked', cached: false })
  }

  for (const module of overCap) {
    reports.push({
      module,
      status: 'not-checked',
      reason: `not checked (pass cap: ${MAX_MODULES_PER_PASS} modules)`,
    })
  }

  if (cacheDirty) deps.saveCache(cache)
  return { verdicts, modules: reports }
}
