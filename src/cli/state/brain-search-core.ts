/**
 * Layered brain search core — the ONE search implementation behind both
 * `planflow-ai brain search` (front door) and `planflow-ai state-query`
 * (back-compat alias), allowed-pattern #14.
 *
 * ONE ENGINE: FILES. The corpus is 5.2 MB of markdown, and it is searched as
 * markdown — ripgrep plus a deterministic scorer over the corpus and the
 * generated `flow/brain/.derived/INDEX.md`, all of it in
 * `brain-file-search.ts`. There is no database, no embedding runtime and no
 * derived index to keep in sync; a project that still has a leftover
 * `.brain.sqlite` on disk is simply never read.
 *
 * Layers (run together):
 *
 * 1. **Files layer** — heading-aware chunks from the markdown corpus, scored
 *    by weighted term frequency with a coverage factor, narrowed by ripgrep
 *    (with a whole-corpus fallback when `rg` is absent). Includes the
 *    generated `INDEX.md`, which carries each feature's summary, parts and
 *    RELATIONSHIP edges — the relational answers live there.
 * 2. **Symbols layer** — exact / prefix / case-insensitive substring NAME
 *    match over `flow/brain/.structure/symbols.jsonl` (loaded once, cached
 *    in-process). Fixed base scores — 0.9 exact, 0.75 prefix, 0.6 substring
 *    — no embeddings: "where is ThreadScopeManager" must be an exact hit.
 *
 * Merge: chunk legs are RRF-fused then normalized to a 0..1 band; symbol
 * scores are already absolute in that band. Hits whose underlying SOURCE
 * file appears in ≥2 distinct layers get a +0.15 agreement boost (noto's
 * load-bearing signal), results are deduped by (file, heading/name), sorted
 * deterministically, and capped at the caller's limit.
 *
 * REGRESSION, RECORDED RATHER THAN DENIED: the side-by-side comparison in
 * `docs/brain-search-comparison.md` scored 5 file-path wins, 5 index wins and
 * 2 ties over 12 fixed questions. Every question the index won was
 * VOCABULARY-BRIDGING — "fails twice" reaching a section titled *Retry
 * Behavior*, "know a module is stale" reaching *The Staleness Authority*. That
 * is what the embeddings bought, and it is what was given up. Phrase a question
 * in the corpus's own words and the file path answers it; phrase it in
 * synonyms and it may not.
 *
 * Fail-soft everywhere: a missing corpus root, an unreadable file, or a missing
 * sidecar collapses the affected layer to empty — never an error surfaced to
 * the caller.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_ROOTS, fileSearchLegs, queryStems } from './brain-file-search.js';
import { describeLink, linkFromSide, type WorkspaceLinkRecord } from '../handlers/workspace-links.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What a hit points at — derived from its source file's home directory. */
export type HitKind =
  | 'code'
  | 'symbol'
  | 'module'
  | 'decision'
  | 'error'
  | 'feature'
  | 'resource'
  | 'rule'
  | 'plan'
  | 'discovery'
  | 'note'
  | 'link';

/** One merged, ranked hit from the layered search. */
export interface LayeredHit {
  /** Stable short id — hash of (file, heading/name); survives re-runs. */
  id: string;
  kind: HitKind;
  /** Repo-relative file the hit lives in (md file, or code file for symbols). */
  file: string;
  /** Chunk heading, or the symbol name for symbol hits. */
  heading?: string;
  /**
   * The CODE file this hit describes, when there is one — the H2 path of a
   * code-card section, or the symbol's own path. Drives freshness + agreement.
   */
  codeFile?: string;
  /** 1-based declaration line (symbol hits only). */
  line?: number;
  /** Full chunk text (or the symbol's rendered one-line description). */
  content: string;
  score: number;
  /** Distinct layers that contributed (`hybrid`, `fts`, `symbols`). */
  layers: string[];
  chunkType?: string;
  /** Recorded content hash of `codeFile` at index time, when known. */
  fileHash?: string;
  /**
   * The Workspace project this hit came from (`--scope workspace`). When set,
   * `file` and `codeFile` are namespaced `<project>/…`.
   */
  project?: string;
}

/** Chunk-shaped row produced by the files leg. */
export interface ChunkHit {
  chunkId?: number;
  file: string;
  heading: string | undefined;
  content: string;
  score: number;
  chunkType: string;
  /**
   * 1-based line the chunk starts at. The files leg always knows it (it reads
   * the file); the retired index legs never did, which is why the `file:line`
   * half of the contract used to be symbol-only.
   */
  line?: number;
}

/** One row of the symbols layer. */
export interface SymbolHit {
  name: string;
  kind: string;
  path: string;
  line: number;
  language: string;
  fileHash: string;
  score: number;
}

/** Scope names accepted by `brain search`. */
export type BrainSearchScope =
  | 'code'
  | 'symbols'
  | 'modules'
  | 'decisions'
  | 'resources'
  | 'plans'
  | 'all'
  | 'workspace';

export const BRAIN_SEARCH_SCOPES: readonly BrainSearchScope[] = [
  'code',
  'symbols',
  'modules',
  'decisions',
  'resources',
  'plans',
  'all',
  'workspace',
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RRF_K = 60;
const AGREEMENT_BOOST = 0.15;
const SYMBOL_EXACT_SCORE = 0.9;
const SYMBOL_PREFIX_SCORE = 0.75;
const SYMBOL_SUBSTRING_SCORE = 0.6;
/** Substring matches on tokens shorter than this are noise, not signal. */
const SYMBOL_SUBSTRING_MIN_TOKEN = 4;
/**
 * The weakest substring match worth a slot, as a fraction of
 * `SYMBOL_SUBSTRING_SCORE` (#1954).
 *
 * A substring match used to be all-or-nothing: ANY one query token appearing
 * anywhere in a name scored the full 0.6. So `why was the lavish engine
 * retired` handed four of its five slots to symbols matching the bare word
 * `engine` — `LoopDirectiveEngine`, `EngineTimers`, `LOOP_ENGINES`,
 * `createWorkspaceSyncEngine` — none of which has anything to do with lavish
 * or with retirement. The result cap is 5, so each one cost an answer AND
 * invited a speculative read.
 *
 * 0.55 is read off the real cases rather than chosen. The three noise hits
 * above sit at 0.33, 0.33 and 0.50 — the last being `EngineTimers`, half of
 * whose name IS the matched word, which is why a floor on name coverage alone
 * would have kept it. Both hits that must survive clear 1.0: `where is the
 * ThreadScopeManager defined` is one token of three but the whole name, and
 * `sync engine` is a quarter of `createWorkspaceSyncEngine` but the whole
 * query. Nothing real lies between 0.50 and 1.0, so the floor is not finely
 * balanced — it sits in a wide gap.
 */
const SYMBOL_SUBSTRING_FLOOR = 0.55;
/** Cap of symbol-layer candidates fed into the merge. */
const SYMBOL_LAYER_CAP = 12;
/**
 * Slots one source file may hold, as a fraction of the result limit (#1954).
 * At the default limit of 5 this is one apiece, which is what it takes for a
 * five-slot answer to be about five things.
 */
const PER_FILE_SLOT_DIVISOR = 3;

/** `brain search` scope → source-file prefixes for the chunk legs. */
const BRAIN_SCOPE_TO_DIRS: Record<BrainSearchScope, string[]> = {
  code: ['flow/brain/code/'],
  symbols: [], // symbols scope skips the chunk legs entirely
  modules: ['flow/brain/modules/'],
  decisions: ['flow/brain/decisions/'],
  resources: ['.claude/resources/', '.claude/rules/'],
  plans: ['flow/plans/'],
  all: [],
  workspace: [],
};

/** Archived plans/discovery are historical noise for every caller. */
export const DEFAULT_EXCLUDE_PATHS = ['flow/archive/'];

const HASH_LINE_PATTERN = /^hash: ([0-9a-f]{64})$/m;

// ---------------------------------------------------------------------------
// Kind + id helpers
// ---------------------------------------------------------------------------

/** Directory-prefix → hit kind, first match wins. */
const KIND_PREFIXES: ReadonlyArray<{ prefix: string; kind: HitKind }> = [
  // The generated index is the FEATURE layer, not a stray note — a hit in it
  // answers "what is this capability and what does it relate to", which is
  // exactly what a hit in `features/` answers. Listed first because it lives
  // under a path no other rule claims.
  { prefix: 'flow/brain/.derived/INDEX.md', kind: 'feature' },
  { prefix: 'flow/brain/code/', kind: 'code' },
  { prefix: 'flow/brain/modules/', kind: 'module' },
  { prefix: 'flow/brain/decisions/', kind: 'decision' },
  { prefix: 'flow/brain/errors/', kind: 'error' },
  { prefix: 'flow/brain/features/', kind: 'feature' },
  { prefix: '.claude/resources/', kind: 'resource' },
  { prefix: '.claude/rules/', kind: 'rule' },
  { prefix: 'flow/plans/', kind: 'plan' },
  { prefix: 'flow/discovery/', kind: 'discovery' },
];

/** Resolve the hit kind of a chunk from its source file's location. */
export function kindOfSourceFile(sourceFile: string): HitKind {
  const match = KIND_PREFIXES.find(({ prefix }) => sourceFile.startsWith(prefix));
  return match?.kind ?? 'note';
}

/** Stable short hit id — 8 hex chars of sha256(file NUL heading/name). */
export function hitId(file: string, headingOrName: string | undefined): string {
  return createHash('sha256')
    .update(`${file}\u0000${headingOrName ?? ''}`)
    .digest('hex')
    .slice(0, 8);
}

// ---------------------------------------------------------------------------
// Symbols layer
// ---------------------------------------------------------------------------

interface SymbolCacheEntry {
  mtimeMs: number;
  size: number;
  rows: Array<Omit<SymbolHit, 'score'>>;
}

/** In-process sidecar cache, keyed by absolute sidecar path. */
const symbolCache = new Map<string, SymbolCacheEntry>();

/** TEST-ONLY: drop the in-process symbols cache. */
export function clearSymbolCacheForTests(): void {
  symbolCache.clear();
}

function loadSymbolRows(flowDir: string): Array<Omit<SymbolHit, 'score'>> {
  const sidecarPath = join(flowDir, 'brain', '.structure', 'symbols.jsonl');
  let stat;
  try {
    stat = statSync(sidecarPath);
  } catch {
    return [];
  }

  const cached = symbolCache.get(sidecarPath);
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.rows;
  }

  let raw: string;
  try {
    raw = readFileSync(sidecarPath, 'utf-8');
  } catch {
    return [];
  }

  const rows: Array<Omit<SymbolHit, 'score'>> = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Sanctioned fail-soft: corrupt sidecar line — skip it, keep the rest
      continue;
    }
    const row = parsed as Record<string, unknown>;
    if (
      typeof row.name === 'string' && row.name !== '' &&
      typeof row.path === 'string' && row.path !== '' &&
      typeof row.kind === 'string' &&
      typeof row.line === 'number' &&
      typeof row.language === 'string' &&
      typeof row.fileHash === 'string'
    ) {
      rows.push({
        name: row.name,
        kind: row.kind,
        path: row.path,
        line: row.line,
        language: row.language,
        fileHash: row.fileHash,
      });
    }
  }

  symbolCache.set(sidecarPath, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
  return rows;
}

/** Collapse to the comparable name form: lowercase alphanumerics only. */
function normalizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/**
 * Exact / prefix / case-insensitive substring NAME match over the symbol
 * sidecar. A multi-word query matches exactly when its concatenated form
 * equals the name (`"thread scope manager"` → `ThreadScopeManager`). Missing
 * sidecar → `[]`.
 *
 * Exact and prefix keep their fixed scores — both mean the query named the
 * symbol. A SUBSTRING match does not mean that, so it is scored by how much
 * of the match each side explains (#1954), and dropped below
 * `SYMBOL_SUBSTRING_FLOOR`:
 *
 *   query coverage — how many of the query's tokens the name accounts for.
 *                    One word of a six-word question is not a question about
 *                    that symbol.
 *   name coverage  — how much of the NAME the matched tokens account for.
 *                    `engine` is a third of `LoopDirectiveEngine` and all of
 *                    `Engine`; the same token says different things about each.
 *
 * The better of the two is used, deliberately. Either one alone rejects a hit
 * the other recognises: `where is the ThreadScopeManager defined` is one token
 * of three (weak query coverage) but the whole name, and `sync engine` is a
 * quarter of `createWorkspaceSyncEngine` but the entire query.
 */
export function searchSymbols(flowDir: string, query: string): SymbolHit[] {
  const rows = loadSymbolRows(flowDir);
  if (rows.length === 0) {
    return [];
  }

  const wholeQuery = normalizeName(query);
  if (wholeQuery === '') {
    return [];
  }
  const tokens = [...new Set(
    query
      .split(/[^A-Za-z0-9_]+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= SYMBOL_SUBSTRING_MIN_TOKEN),
  )];

  const hits: SymbolHit[] = [];
  for (const row of rows) {
    const nameNorm = normalizeName(row.name);
    const nameLower = row.name.toLowerCase();
    let score = 0;
    if (nameNorm === wholeQuery) {
      score = SYMBOL_EXACT_SCORE;
    } else if (nameNorm.startsWith(wholeQuery)) {
      score = SYMBOL_PREFIX_SCORE;
    } else if (tokens.length > 0) {
      const matched = tokens.filter((token) => nameLower.includes(token));
      if (matched.length > 0) {
        const queryCoverage = matched.length / tokens.length;
        const matchedChars = matched.reduce((sum, token) => sum + token.length, 0);
        const nameCoverage = nameNorm.length === 0 ? 0 : Math.min(1, matchedChars / nameNorm.length);
        const coverage = Math.max(queryCoverage, nameCoverage);
        if (coverage >= SYMBOL_SUBSTRING_FLOOR) {
          score = SYMBOL_SUBSTRING_SCORE * coverage;
        }
      }
    }
    if (score > 0) {
      hits.push({ ...row, score });
    }
  }

  hits.sort(
    (a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  );
  return hits.slice(0, SYMBOL_LAYER_CAP);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Parse the recorded content hash out of a code-card chunk's text. */
export function codeCardHashOf(content: string): string | undefined {
  const match = HASH_LINE_PATTERN.exec(content);
  return match?.[1];
}

function chunkToHit(chunk: ChunkHit, score: number, layers: string[]): LayeredHit {
  const kind = kindOfSourceFile(chunk.file);
  const isCode = kind === 'code';
  return {
    id: hitId(chunk.file, chunk.heading),
    kind,
    file: chunk.file,
    heading: chunk.heading,
    codeFile: isCode ? chunk.heading : undefined,
    line: chunk.line,
    content: chunk.content,
    score,
    layers,
    chunkType: chunk.chunkType,
    fileHash: isCode ? codeCardHashOf(chunk.content) : undefined,
  };
}

function symbolToHit(symbol: SymbolHit): LayeredHit {
  return {
    id: hitId(symbol.path, symbol.name),
    kind: 'symbol',
    file: symbol.path,
    heading: symbol.name,
    codeFile: symbol.path,
    line: symbol.line,
    content: `${symbol.name} (${symbol.kind}, ${symbol.language}) — ${symbol.path}:${symbol.line}`,
    score: symbol.score,
    layers: ['symbols'],
    fileHash: symbol.fileHash,
  };
}

/**
 * RRF-fuse the two chunk legs by chunk id (falling back to file+heading when
 * an id is missing), normalize to a 0..1 band, convert symbols, apply the
 * multi-layer agreement boost, dedupe by (file, heading/name), and cap.
 * Exported pure — the unit tests drive it directly.
 */
export function mergeLayers(
  hybridChunks: ChunkHit[],
  ftsChunks: ChunkHit[],
  symbolHits: SymbolHit[],
  limit: number,
  // The two chunk legs' NAMES, so a hit reports which leg actually found it.
  // Only one chunk leg survives the index's retirement (`files`); the second
  // slot stays because the fuse is a pure, separately-tested function and a
  // second ranked leg is the shape it exists to combine.
  legNames: readonly [string, string] = ['files', 'unused'],
): LayeredHit[] {
  // --- RRF fuse of the chunk legs (rank-based, k=60) ---
  interface FusedChunk {
    chunk: ChunkHit;
    rrf: number;
    layers: Set<string>;
  }
  const fused = new Map<string, FusedChunk>();
  const chunkKey = (chunk: ChunkHit): string =>
    chunk.chunkId !== undefined ? `id:${chunk.chunkId}` : `fh:${chunk.file}\u0000${chunk.heading ?? ''}`;

  const addLeg = (leg: ChunkHit[], layerName: string): void => {
    leg.forEach((chunk, rank) => {
      const key = chunkKey(chunk);
      const existing = fused.get(key);
      const contribution = 1 / (RRF_K + rank + 1);
      if (existing === undefined) {
        fused.set(key, { chunk, rrf: contribution, layers: new Set([layerName]) });
      } else {
        existing.rrf += contribution;
        existing.layers.add(layerName);
      }
    });
  };
  addLeg(hybridChunks, legNames[0]);
  addLeg(ftsChunks, legNames[1]);

  const maxRrf = Math.max(...[...fused.values()].map((entry) => entry.rrf), 0);
  const chunkHits: LayeredHit[] = [...fused.values()].map((entry) =>
    chunkToHit(entry.chunk, maxRrf === 0 ? 0 : entry.rrf / maxRrf, [...entry.layers].sort()),
  );

  const allHits = [...chunkHits, ...symbolHits.map(symbolToHit)];

  // --- Multi-layer agreement: same SOURCE file present in ≥2 layers ---
  const layersByFile = new Map<string, Set<string>>();
  for (const hit of allHits) {
    const fileKey = hit.codeFile ?? hit.file;
    const set = layersByFile.get(fileKey) ?? new Set<string>();
    for (const layer of hit.layers) {
      set.add(layer);
    }
    layersByFile.set(fileKey, set);
  }
  for (const hit of allHits) {
    const fileKey = hit.codeFile ?? hit.file;
    if ((layersByFile.get(fileKey)?.size ?? 0) >= 2) {
      hit.score += AGREEMENT_BOOST;
    }
  }

  // --- Dedupe by (file, heading/name), keeping the best score ---
  const deduped = new Map<string, LayeredHit>();
  for (const hit of allHits) {
    const key = `${hit.file}\u0000${hit.heading ?? ''}`;
    const existing = deduped.get(key);
    if (existing === undefined || hit.score > existing.score) {
      const mergedLayers = existing === undefined
        ? hit.layers
        : [...new Set([...existing.layers, ...hit.layers])].sort();
      deduped.set(key, { ...hit, layers: mergedLayers });
    } else {
      existing.layers = [...new Set([...existing.layers, ...hit.layers])].sort();
    }
  }

  const merged = [...deduped.values()];
  merged.sort(
    (a, b) =>
      b.score - a.score ||
      a.file.localeCompare(b.file) ||
      (a.heading ?? '').localeCompare(b.heading ?? ''),
  );
  return diversify(merged, limit);
}

/**
 * Take the top `limit`, but not all from one file (#1954).
 *
 * The second half of the crowding report: `what is the difference between
 * complexity and risk` spent six of its top seven slots inside
 * `execute-plan-skill.md`, and the canonical answer — `complexity-scoring.md ›
 * Complexity vs Risk` — sat at rank 9, outside a cap of 5. One long document
 * with many headings outranks everything simply by having more chances to.
 *
 * A reader who wanted a third section of that file has its path and can go
 * there; a reader who wanted the one paragraph that answers the question could
 * not reach it at all. So the slots a single file may hold is a fraction of
 * the budget rather than all of it, and anything displaced is put back
 * afterwards in score order — a narrow result set still fills to `limit`,
 * because diversity must never cost a hit when there is nothing to swap in.
 */
function diversify(ranked: LayeredHit[], limit: number): LayeredHit[] {
  if (limit <= 0 || ranked.length <= limit) {
    return ranked.slice(0, limit);
  }
  const perFile = Math.max(1, Math.floor(limit / PER_FILE_SLOT_DIVISOR));
  const taken = new Map<string, number>();
  const picked: LayeredHit[] = [];
  const displaced: LayeredHit[] = [];

  for (const hit of ranked) {
    if (picked.length >= limit) break;
    const fileKey = hit.codeFile ?? hit.file;
    const used = taken.get(fileKey) ?? 0;
    if (used >= perFile) {
      displaced.push(hit);
      continue;
    }
    taken.set(fileKey, used + 1);
    picked.push(hit);
  }

  // Backfill in score order — `displaced` is already sorted, being a
  // subsequence of `ranked`.
  for (const hit of displaced) {
    if (picked.length >= limit) break;
    picked.push(hit);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Front door
// ---------------------------------------------------------------------------

/** One project of the Workspace, as the search reads it. */
export interface WorkspaceSearchProject {
  slug: string;
  /** The project the search was asked from. */
  self: boolean;
  /** The project's knowledge folder (what its `flow/` links to). */
  flowDir: string;
  /** This machine's checkout, or null when there is none here. */
  repoRoot: string | null;
}

/** The Workspace a search runs in — resolved by the caller (`workspace status`). */
export interface WorkspaceSearchContext {
  /** The Workspace's slug — namespaces link hits. */
  workspace: string;
  selfSlug: string;
  /** Self first, then the siblings. */
  projects: WorkspaceSearchProject[];
  /** Every cross-project link of the Workspace (`links.jsonl`). */
  links: WorkspaceLinkRecord[];
}

/** Parameters for one layered search. */
export interface LayeredSearchParams {
  projectRoot: string;
  flowDir: string;
  query: string;
  scope: BrainSearchScope;
  limit: number;
  /**
   * The Workspace this project is in, when it is in one. Drives
   * `--scope workspace` and the cross-project links layer; absent means a
   * plain per-project search, exactly as before Workspaces.
   */
  workspace?: WorkspaceSearchContext;
}

/**
 * Run the full layered fan-out for `brain search`. Scope `symbols` runs the
 * symbols layer alone; every other scope runs the files layer with the scope's
 * directory filter applied (symbols participate for `all`, `code`, and
 * `symbols` — they ARE code knowledge).
 *
 * Synchronous work wrapped in an async signature on purpose: the front door's
 * contract is a promise, and nothing downstream should have to care that the
 * answer no longer comes from a database.
 */
export async function layeredBrainSearch(params: LayeredSearchParams): Promise<LayeredHit[]> {
  const { workspace, scope } = params;
  if (scope === 'workspace' && workspace !== undefined) {
    return blendLinkHits(workspaceSearch(params, workspace), linkHits(workspace, params.query, null), params.limit);
  }
  // `workspace` outside a Workspace is this project's whole corpus — the
  // caller says so in one line (`brain search`).
  const effective: BrainSearchScope = scope === 'workspace' ? 'all' : scope;
  const hits = fileBrainSearch({ ...params, scope: effective }, BRAIN_SCOPE_TO_DIRS[effective]);
  if (effective !== 'all' || workspace === undefined) return hits;
  return blendLinkHits(hits, linkHits(workspace, params.query, workspace.selfSlug), params.limit);
}

// ---------------------------------------------------------------------------
// Workspace scope (workspaces-knowledge-hub Phase 5, FR-21)
// ---------------------------------------------------------------------------

/**
 * How many projects one `--scope workspace` search reads — self always, then
 * siblings in slug order. Each costs one bounded file search (≤400 files read),
 * so this is what keeps a big Workspace from making every question slow.
 */
export const WORKSPACE_SEARCH_PROJECT_CAP = 12;

/**
 * A sibling's corpus: its knowledge folder only, plus its own `CLAUDE.md` when
 * it has a checkout here. NOT `.claude/resources` or `.claude/rules` — those
 * are the same plan-flow assets in every project, and searching N copies of
 * them would bury the one answer that is actually the sibling's.
 */
const SIBLING_FLOW_ROOTS: readonly string[] = CORPUS_ROOTS.filter((root) => root.startsWith('flow/'));

/** Link hits: never above a real chunk's ceiling, always above noise. */
const LINK_BASE_SCORE = 0.5;
const LINK_COVERAGE_SPAN = 0.4;
/** Slots a matching link may claim in a capped result — linked knowledge is never crowded out entirely. */
const LINK_RESERVED_SLOTS = 2;

/** Which projects a Workspace search reads, and which the cap left out. */
export function workspaceProjectsToSearch(workspace: WorkspaceSearchContext): {
  searched: WorkspaceSearchProject[];
  skipped: WorkspaceSearchProject[];
} {
  const ordered = [
    ...workspace.projects.filter((project) => project.self),
    ...workspace.projects.filter((project) => !project.self).sort((a, b) => a.slug.localeCompare(b.slug)),
  ];
  return { searched: ordered.slice(0, WORKSPACE_SEARCH_PROJECT_CAP), skipped: ordered.slice(WORKSPACE_SEARCH_PROJECT_CAP) };
}

/** Prefix a hit's paths with its project, and re-mint its id from the namespaced path. */
export function namespaceHit(hit: LayeredHit, project: string): LayeredHit {
  const file = `${project}/${hit.file}`;
  return {
    ...hit,
    id: hitId(file, hit.heading),
    file,
    codeFile: hit.codeFile === undefined ? undefined : `${project}/${hit.codeFile}`,
    project,
  };
}

function siblingSearch(project: WorkspaceSearchProject, query: string, limit: number): LayeredHit[] {
  const roots = project.repoRoot === null ? SIBLING_FLOW_ROOTS : [...SIBLING_FLOW_ROOTS, 'CLAUDE.md'];
  const chunks = fileSearchLegs(project.repoRoot ?? project.flowDir, query, [], { flowDir: project.flowDir, roots }).chunks;
  // Symbols point at code; without a checkout here there is no code to open.
  const symbols = project.repoRoot === null ? [] : searchSymbols(project.flowDir, query);
  return mergeLayers(chunks, [], symbols, limit, ['files', 'unused']);
}

function workspaceSearch(params: LayeredSearchParams, workspace: WorkspaceSearchContext): LayeredHit[] {
  const all: LayeredHit[] = [];
  for (const project of workspaceProjectsToSearch(workspace).searched) {
    const hits = project.self
      ? fileBrainSearch({ ...params, scope: 'all' }, BRAIN_SCOPE_TO_DIRS.all)
      : siblingSearch(project, params.query, params.limit);
    all.push(...hits.map((hit) => namespaceHit(hit, project.slug)));
  }
  const selfFirst = (hit: LayeredHit): number => (hit.project === workspace.selfSlug ? 0 : 1);
  all.sort(
    (a, b) =>
      b.score - a.score ||
      selfFirst(a) - selfFirst(b) ||
      a.file.localeCompare(b.file) ||
      (a.heading ?? '').localeCompare(b.heading ?? ''),
  );
  return all.slice(0, params.limit);
}

/**
 * Cross-project links matching the query, as hits. `selfSlug` set = only the
 * links this project takes part in, read from its side; null = every link of
 * the Workspace. Scored by how many query stems the link's ends and note cover.
 */
export function linkHits(workspace: WorkspaceSearchContext, query: string, selfSlug: string | null): LayeredHit[] {
  const stems = queryStems(query);
  if (stems.length === 0 || workspace.links.length === 0) return [];
  const file = `${workspace.workspace}/links.jsonl`;
  const hits: LayeredHit[] = [];
  for (const link of workspace.links) {
    let heading = describeLink(link);
    let other: string | undefined;
    if (selfSlug !== null) {
      const side = linkFromSide(link, selfSlug);
      if (side === null) continue;
      heading = `${side.own.address} —${side.kind}→ ${side.other.address}`;
      other = side.other.project;
    }
    const text = `${link.from} ${link.to} ${link.kind} ${link.note ?? ''}`.replace(/[/:_.-]/g, ' ');
    const matched = stems.filter((stem) => new RegExp(`\\b${stem}`, 'i').test(text)).length;
    if (matched === 0) continue;
    const content = [
      heading,
      ...(link.note === undefined ? [] : [link.note]),
      `recorded ${link.ts.slice(0, 10)}${link.author === null ? '' : ` by ${link.author}`} · ${link.kind}`,
    ].join('\n');
    hits.push({
      id: hitId(file, heading),
      kind: 'link',
      file,
      heading,
      content,
      score: LINK_BASE_SCORE + (LINK_COVERAGE_SPAN * matched) / stems.length,
      layers: ['links'],
      ...(other === undefined ? {} : { project: other }),
    });
  }
  hits.sort((a, b) => b.score - a.score || (a.heading ?? '').localeCompare(b.heading ?? ''));
  return hits;
}

/**
 * Fold link hits into a capped result: up to `LINK_RESERVED_SLOTS` of the cap
 * go to links when any match, so a project's own corpus can never crowd its
 * cross-project knowledge out of a five-hit answer.
 */
export function blendLinkHits(hits: LayeredHit[], links: LayeredHit[], limit: number): LayeredHit[] {
  if (links.length === 0) return hits.slice(0, limit);
  const reserved = Math.min(links.length, LINK_RESERVED_SLOTS, limit);
  const kept = hits.slice(0, limit - reserved);
  const blended = [...kept, ...links.slice(0, limit - kept.length)];
  blended.sort(
    (a, b) => b.score - a.score || a.file.localeCompare(b.file) || (a.heading ?? '').localeCompare(b.heading ?? ''),
  );
  return blended;
}

// ---------------------------------------------------------------------------
// The file engine
// ---------------------------------------------------------------------------

/**
 * The file-based fan-out: the ripgrep-backed chunk leg over the markdown corpus
 * (including the generated `INDEX.md`) plus the symbols leg.
 */
function fileBrainSearch(
  params: LayeredSearchParams,
  scopeDirs: readonly string[],
): LayeredHit[] {
  const { projectRoot, flowDir, query, scope, limit } = params;
  const wantsChunks = scope !== 'symbols';
  const wantsSymbols = scope === 'all' || scope === 'code' || scope === 'symbols';

  const chunks = wantsChunks ? fileSearchLegs(projectRoot, query, scopeDirs).chunks : [];

  // The archive exclusion is applied here rather than inside the corpus walk
  // because it is a CALLER's rule ("archived plans are historical noise") — the
  // same rule, and the same constant, the retired index leg applied.
  const keep = (chunk: ChunkHit): boolean =>
    !DEFAULT_EXCLUDE_PATHS.some((prefix) => chunk.file.startsWith(prefix));

  const symbolHits = wantsSymbols ? searchSymbols(flowDir, query) : [];

  // ONE chunk leg, so the second is empty. The file scorer produces comparable
  // scores across the whole corpus (see TITLE_WEIGHT): splitting them into two
  // rank-fused legs would discard exactly the magnitude that makes the ranking
  // right. The symbols leg still participates, and still earns the agreement
  // boost when it and a code card point at the same file.
  return mergeLayers(chunks.filter(keep), [], symbolHits, limit, ['files', 'unused']);
}
