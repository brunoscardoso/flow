// Compaction / promotion (#52, Phase 3) — turn raw, un-trusted working-set
// captures (flow/brain/.raw/) into promoted, queryable feature memories
// (flow/brain/features/<slug>.md). The compaction pass dedupes, drops noise,
// merges records for the same feature, and renders canonical markdown.
//
// WHERE THE TIER BOUNDARY ACTUALLY LIVES. This comment used to name
// `isTrustedBrainPath` (store.ts) as the guarantee that .raw/ is never queried.
// That was prose, not code: nothing in production has ever called that
// function. The boundary is enforced by ENUMERATION instead — `readBrainDocs`
// (query.ts) walks a fixed allowlist, `MARKDOWN_TIERS`, holding exactly
// features/errors/decisions, and `brain:query` → `searchBrain` is the only
// trusted read there is. `.raw/` is a sibling directory that no read path ever
// names, so it cannot be reached rather than being filtered out.
//
// That is still ONE code path (allowed-pattern #14), but it is an allowlist,
// and an allowlist only holds while it stays closed: widening `MARKDOWN_TIERS`,
// or swapping its per-tier readdir for a recursive walk of flow/brain/, would
// breach the boundary silently. `searchBrain (real fs) — tier boundary` in
// query.test.ts is what fails if either happens, and it uses
// `isTrustedBrainPath` as its oracle so the two definitions cannot drift.
//
// Compaction is the ONLY thing that moves data across the boundary — a
// promotion step, not just cleanup.

import { promises as fsPromises } from 'fs'
import { join } from 'path'

import { withFileLock, type FileLockLimits } from '../store/file-lock'
import { BRAIN_SUBDIRS } from './store'
import type { FeatureMemory, RawWorkingSet, WorkingSetFile, WorkingSetRole } from './types'

/** Generated / vendored files that carry no working-set signal. */
const NOISE_PATTERN =
  /(^|\/)(node_modules|dist|out|build|coverage|\.next|\.turbo)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.min\.js$|\.map$/

/** Kebab-case slug from a thread/task title — the feature markdown filename stem. */
export function slugify(title: string): string {
  // Keep Unicode letters/numbers (CJK, Cyrillic, Greek, …), not just ASCII, so a
  // non-Latin title yields a real, distinct stem instead of collapsing to a
  // shared `untitled` (#168). NFKC folds compatibility forms consistently.
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  // Still empty (pure punctuation/emoji) → a stable per-title hash so distinct
  // titles get distinct files rather than all churning one `untitled.md`.
  return slug || `untitled-${shortHash(title)}`
}

/** Deterministic 8-hex FNV-1a hash — no crypto dependency, stable per string. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function mergeFiles(files: readonly WorkingSetFile[]): WorkingSetFile[] {
  const roles = new Map<string, WorkingSetRole>()
  for (const file of files) {
    if (NOISE_PATTERN.test(file.path)) continue
    if (roles.get(file.path) === 'edited') continue
    roles.set(file.path, file.role)
  }
  return [...roles.entries()]
    .map(([path, role]) => ({ path, role }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function summarize(title: string, files: readonly WorkingSetFile[]): string {
  const edited = files.filter((f) => f.role === 'edited').length
  const read = files.length - edited
  return `Working set for "${title}" — ${files.length} file(s): ${edited} edited, ${read} read.`
}

/**
 * Compact raw captures into feature memories: group by slug(title), merge and
 * de-noise files, and produce one memory per feature. Pure and deterministic.
 * Records that reduce to zero meaningful files are dropped.
 */
export function compact(records: readonly RawWorkingSet[]): FeatureMemory[] {
  const byFeature = new Map<string, RawWorkingSet[]>()
  for (const record of records) {
    const key = slugify(record.title)
    const group = byFeature.get(key)
    if (group) group.push(record)
    else byFeature.set(key, [record])
  }

  const memories: FeatureMemory[] = []
  for (const [feature, group] of byFeature) {
    const files = mergeFiles(group.flatMap((r) => r.files))
    if (files.length === 0) continue
    // Newest capture wins for title/provenance (records arrive oldest-first).
    const latest = group[group.length - 1]
    memories.push({
      feature,
      title: latest.title,
      files,
      summary: summarize(latest.title, files),
      decisions: [],
      provenance: { threadId: latest.threadId, capturedAt: latest.capturedAt },
    })
  }
  return memories.sort((a, b) => a.feature.localeCompare(b.feature))
}

/**
 * Union a freshly-compacted memory with the feature file already on disk: merge
 * the working sets (edited stays sticky over read) and de-dupe decisions, then
 * refresh the summary. Keeps the newest title/provenance (#167).
 */
export function mergeIntoExisting(memory: FeatureMemory, existingMarkdown: string): FeatureMemory {
  const prior = parseExistingFeature(existingMarkdown)
  const files = mergeFiles([...prior.files, ...memory.files])
  const decisions = [...new Set([...prior.decisions, ...memory.decisions])]
  return { ...memory, files, decisions, summary: summarize(memory.title, files) }
}

/** Render a feature memory to canonical Obsidian-readable markdown. */
export function renderFeatureMemory(memory: FeatureMemory): string {
  const lines: string[] = [
    '---',
    `feature: ${memory.feature}`,
    `title: ${JSON.stringify(memory.title)}`,
    `thread_id: ${memory.provenance.threadId}`,
    `captured_at: ${memory.provenance.capturedAt}`,
    '---',
    '',
    `# ${memory.title}`,
    '',
    memory.summary,
    '',
    '## Working set',
    '',
  ]
  for (const file of memory.files) {
    lines.push(`- \`${file.path}\` — ${file.role}`)
  }
  if (memory.decisions.length > 0) {
    lines.push('', '## Decisions', '')
    for (const decision of memory.decisions) lines.push(`- ${decision}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * True when the markdown is an auto-captured working set — either marker is
 * sufficient: a `thread_id:` frontmatter key (renderFeatureMemory's own output)
 * or a body line opening "Working set for …" (summarize's own output). Anything
 * else under features/ is a REAL feature (human/plan-authored) and is precious:
 * compaction must never merge into or overwrite it (#1681).
 *
 * Mirrors `isWorkingSetCapture` in src/cli/blueprint/feature-store.ts — the
 * read-side detector the feature store uses to EXCLUDE working sets. The two
 * live in separate packages, so keep the markers in sync if either changes.
 */
export function isWorkingSetMarkdown(markdown: string): boolean {
  const normalized = markdown.replace(/\r\n/g, '\n')
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---\n', 4)
    if (end !== -1) {
      const fm = normalized.slice(4, end).split('\n')
      if (fm.some((line) => line.trimStart().startsWith('thread_id:'))) return true
    }
  }
  return /^\s*Working set for\b/m.test(normalized)
}

export interface CompactionDeps {
  /** List `<name>.json` raw files (basenames) under flow/brain/.raw/. */
  listRaw: (rawDir: string) => Promise<string[]>
  /** Read one raw file's JSON text. */
  readRaw: (path: string) => Promise<string>
  /** Read an existing feature markdown file, or null when it doesn't exist yet
   *  (so compaction can MERGE into it rather than overwrite — #167). */
  readFeature: (path: string) => Promise<string | null>
  /** Write a promoted feature markdown file. */
  writeFeature: (path: string, content: string) => Promise<void>
  /** Remove a consumed raw file. */
  removeRaw: (path: string) => Promise<void>
}

/**
 * Parse a previously-promoted feature markdown back into its working set +
 * decisions, so a new compaction can UNION with it (features/ is precious and
 * accumulates across sessions — #167). Tolerant: unknown lines are ignored.
 */
export function parseExistingFeature(markdown: string): {
  files: WorkingSetFile[]
  decisions: string[]
} {
  const files: WorkingSetFile[] = []
  const decisions: string[] = []
  let section: 'working' | 'decisions' | null = null
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim().toLowerCase()
      section = heading === 'working set' ? 'working' : heading === 'decisions' ? 'decisions' : null
      continue
    }
    if (section === 'working') {
      const match = /^-\s+`(.+?)`\s+—\s+(edited|read)\b/.exec(line)
      if (match) files.push({ path: match[1], role: match[2] as WorkingSetRole })
    } else if (section === 'decisions') {
      const match = /^-\s+(.+)$/.exec(line)
      if (match) decisions.push(match[1].trim())
    }
  }
  return { files, decisions }
}

/** Default IO deps backed by the real filesystem. */
export function fsCompactionDeps(): CompactionDeps {
  return {
    listRaw: async (rawDir) => {
      try {
        const entries = await fsPromises.readdir(rawDir)
        return entries.filter((name) => name.endsWith('.json'))
      } catch {
        return []
      }
    },
    readRaw: (path) => fsPromises.readFile(path, 'utf8'),
    readFeature: async (path) => {
      try {
        return await fsPromises.readFile(path, 'utf8')
      } catch {
        return null // not promoted yet
      }
    },
    writeFeature: async (path, content) => {
      await fsPromises.mkdir(join(path, '..'), { recursive: true })
      await fsPromises.writeFile(path, content, 'utf8')
    },
    removeRaw: (path) => fsPromises.rm(path, { force: true }),
  }
}

export interface CompactionResult {
  promoted: number
  features: string[]
}

/**
 * Serializes compaction per root. Two threads finishing a turn near-simultaneously
 * both fire runCompaction on the same root; the read-modify-write (snapshot .raw/
 * → merge → write feature → delete raw) would otherwise interleave destructively —
 * the slower pass overwrites the feature with its stale view AND both delete the
 * consumed raw files, permanently losing a co-occurring thread's working set (#267).
 */
const compactionChainByRoot = new Map<string, Promise<unknown>>()

/**
 * Limits for the feature-store lock. Roomier than the learning-state store's:
 * one pass promotes every raw working set a root accumulated, so a legitimate
 * holder can be inside for a while, and thirty seconds of waiting means a
 * wedged holder rather than a busy one.
 */
const FEATURE_STORE_LOCK_LIMITS: FileLockLimits = {
  staleMs: 30_000,
  waitMs: 30_000,
  retryMs: 50,
}

/**
 * Where the feature store's advisory lock lives. Deliberately NOT beside its
 * target: `features/` is precious and Obsidian-visible, and a lock file
 * appearing and vanishing in a human's vault is noise. `.structure/` is the
 * derived, hidden tier — disposable by contract — and every process can
 * compute this path from the root alone, which is all a shared lock needs.
 */
function featureStoreLockPath(rootPath: string): string {
  return join(rootPath, BRAIN_SUBDIRS.structure, 'features.lock')
}

/**
 * Run the compaction pass: read every raw capture, compact into feature
 * memories, write each to flow/brain/features/<slug>.md (idempotent — same slug
 * supersedes, never duplicates), and remove the consumed raw files. Serialized
 * per root so overlapping invocations never race (#267).
 */
export async function runCompaction(
  rootPath: string,
  deps: CompactionDeps = fsCompactionDeps(),
): Promise<CompactionResult> {
  const prior = compactionChainByRoot.get(rootPath) ?? Promise.resolve()
  // A failed prior pass must not block the next; swallow it before chaining.
  const run = prior.catch(() => undefined).then(() => runCompactionOnce(rootPath, deps))
  compactionChainByRoot.set(rootPath, run)
  try {
    return await run
  } finally {
    // Drop the chain entry once this is the tail (no newer pass queued behind it).
    if (compactionChainByRoot.get(rootPath) === run) compactionChainByRoot.delete(rootPath)
  }
}

async function runCompactionOnce(
  rootPath: string,
  deps: CompactionDeps,
): Promise<CompactionResult> {
  const rawDir = join(rootPath, BRAIN_SUBDIRS.raw)
  const rawNames = await deps.listRaw(rawDir)
  if (rawNames.length === 0) return { promoted: 0, features: [] }

  const records: RawWorkingSet[] = []
  const consumed: string[] = []
  for (const name of rawNames) {
    const abs = join(rawDir, name)
    try {
      const parsed = JSON.parse(await deps.readRaw(abs)) as RawWorkingSet
      if (parsed && Array.isArray(parsed.files) && typeof parsed.title === 'string') {
        records.push(parsed)
        consumed.push(abs)
      }
    } catch {
      // Skip a corrupt raw file; leave it in place for inspection.
    }
  }

  const memories = compact(records)
  const promoted: string[] = []
  // The read-merge-write below is one critical section per root. The
  // per-process chain above serializes THIS process; the lock file adds the
  // writer the chain cannot see — a `planflow-ai` verb rewriting the same
  // feature markdown — because read-then-full-rewrite loses whichever side
  // read first, silently and without an error to notice.
  await withFileLock(featureStoreLockPath(rootPath), FEATURE_STORE_LOCK_LIMITS, async () => {
    for (const memory of memories) {
      const featuresDir = join(rootPath, BRAIN_SUBDIRS.features)
      let featurePath = join(featuresDir, `${memory.feature}.md`)
      // MERGE into any existing feature file — features/ is precious and
      // accumulates a feature's working set across sessions. Overwriting would
      // silently drop files/decisions promoted by earlier sessions (#167).
      let existing = await deps.readFeature(featurePath)
      if (existing !== null && !isWorkingSetMarkdown(existing)) {
        // `<slug>.md` is a REAL feature — a thread title that slugifies to an
        // existing feature's name must not destroy it (#1681). Divert this
        // thread's working set to a sibling path namespaced by thread id; the
        // diverted file still carries the working-set markers, so the feature
        // store keeps excluding it and later sessions keep merging into it.
        featurePath = join(
          featuresDir,
          `${memory.feature}--ws-${shortHash(memory.provenance.threadId)}.md`,
        )
        existing = await deps.readFeature(featurePath)
        if (existing !== null && !isWorkingSetMarkdown(existing)) {
          // The diverted path is ALSO a real file somehow — leave both untouched
          // rather than destroy either; the working set is transient anyway.
          continue
        }
      }
      const toWrite = existing ? mergeIntoExisting(memory, existing) : memory
      await deps.writeFeature(featurePath, renderFeatureMemory(toWrite))
      promoted.push(memory.feature)
    }
  })
  for (const abs of consumed) {
    await deps.removeRaw(abs)
  }
  return { promoted: promoted.length, features: promoted }
}

/**
 * Session-start sweep: compact any raw captures left over from a previous
 * session (e.g. a crash before the post-turn compaction ran). Best-effort per
 * root — one root's failure never blocks the others.
 */
export async function sweepBrainRoots(rootPaths: readonly string[]): Promise<void> {
  for (const rootPath of rootPaths) {
    try {
      await runCompaction(rootPath)
    } catch {
      // A sweep failure for one root must not block startup or the others.
    }
  }
}
