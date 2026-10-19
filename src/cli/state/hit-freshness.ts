/**
 * Hit-freshness contract — the ONE resolution path from a layered search hit
 * to `fresh | stale | unknown` (allowed-pattern #14). Every `brain search`
 * hit carries this flag so skipping code reads stays safe: fresh means the
 * indexed knowledge still matches the code on disk, stale means the code
 * moved since indexing ("○ stale — verify against code"), unknown means no
 * machine check exists for that hit kind (rendered plain).
 *
 * Per-kind resolution:
 *
 * - **symbol / code** hits carry the source file's recorded content hash
 *   (`fileHash` from `symbols.jsonl` / the card's `hash:` line). The file is
 *   re-checked through the ONE hashing code path (`hashRepoFile`), with the
 *   file-stamps baseline (`file-stamps.json`) as a cheap mtime/size
 *   pre-filter — a stamp whose recorded hash equals the hit's hash and whose
 *   mtime+size still match skips the content hash (hints only, never the
 *   truth — forbidden-pattern #10: any mismatch falls through to the hash).
 * - **module** hits (`flow/brain/modules/<slug>.md`) resolve through the
 *   progressive-learning state (`learning-state.jsonl`): learned → fresh,
 *   stale → stale, queued/learning/absent → unknown. Read-only here — that
 *   store's single writer is the app's learning-state module.
 * - **decision / error / feature** hits resolve to `unknown` today: these
 *   brain markdown files carry no machine-checkable anchors (the stale-check
 *   evaluator covers the investigation store's anchored notes, which are not
 *   markdown hits). When anchored note markdown lands, this is the seam.
 * - everything else → unknown.
 *
 * Re-learn signal: stale CODE hits are NOT appended anywhere from here —
 * `learning-state.jsonl` is a full-rewrite, single-writer store owned by the
 * app process, and no CLI-side append seam exists. Deliberately skipped
 * rather than inventing a new store; `blueprint stale-check` remains the
 * staleness authority that feeds re-learn.
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readFileStamps } from '../blueprint/file-stamps.js';
import type { FileStamp } from '../blueprint/file-stamps.js';
import { hashRepoFile, statRepoFile } from '../blueprint/store.js';
import type { LayeredHit } from './brain-search-core.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three freshness states a hit can render with. */
export type HitFreshness = 'fresh' | 'stale' | 'unknown';

/** Where the resolver reads its evidence from. */
export interface FreshnessSources {
  /** Repo root the recorded paths are relative to. */
  repoRoot: string;
  /** The project's `flow/` directory (stamps, learning state). */
  flowDir: string;
}

/** Resolves one hit; construct once per search via `createFreshnessResolver`. */
export type FreshnessResolver = (hit: LayeredHit) => HitFreshness;

// ---------------------------------------------------------------------------
// Learning-state (read-only minimal parser)
// ---------------------------------------------------------------------------

type LearningStatus = 'queued' | 'learning' | 'learned' | 'stale';

const LEARNING_STATUSES: readonly LearningStatus[] = ['queued', 'learning', 'learned', 'stale'];

/** Module-path → card-slug, mirroring `moduleSlugOf` in code-cards.ts. */
function slugOfModulePath(modulePath: string): string {
  return modulePath.replace(/\//g, '-');
}

/**
 * Read `flow/brain/.structure/learning-state.jsonl` into a slug → status map
 * (latest record per module wins, `notedAt` ISO order). READ-ONLY — the app's
 * learning-state store is the single writer. Fail-soft: missing/corrupt file
 * or lines yield an empty map.
 */
function readLearningStatusBySlug(flowDir: string): Map<string, LearningStatus> {
  const bySlug = new Map<string, { status: LearningStatus; notedAt: string }>();
  let raw: string;
  try {
    raw = readFileSync(join(flowDir, 'brain', '.structure', 'learning-state.jsonl'), 'utf-8');
  } catch {
    return new Map();
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Sanctioned fail-soft: corrupt line — skip it rather than failing the read
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.module !== 'string' || record.module === '') {
      continue;
    }
    if (!LEARNING_STATUSES.includes(record.status as LearningStatus)) {
      continue;
    }
    const notedAt = typeof record.notedAt === 'string' ? record.notedAt : '';
    const slug = slugOfModulePath(record.module);
    const existing = bySlug.get(slug);
    if (existing === undefined || notedAt >= existing.notedAt) {
      bySlug.set(slug, { status: record.status as LearningStatus, notedAt });
    }
  }
  return new Map([...bySlug].map(([slug, entry]) => [slug, entry.status]));
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Whether the stamps baseline lets us call the file fresh without hashing:
 * the stamp's recorded hash must equal the hit's recorded hash AND the
 * file's current mtime+size must equal the stamp's hints.
 */
function stampConfirmsFresh(
  repoRoot: string,
  stamp: FileStamp | undefined,
  recordedHash: string,
): boolean {
  if (stamp === undefined || stamp.contentHash !== recordedHash) {
    return false;
  }
  if (stamp.mtimeMs === undefined || stamp.size === undefined) {
    return false;
  }
  const stat = statRepoFile(repoRoot, stamp.path);
  return stat.status === 'ok' && stat.mtimeMs === stamp.mtimeMs && stat.size === stamp.size;
}

/** Freshness of one recorded (path, hash) pair against the disk. */
function resolveCodeFreshness(
  sources: FreshnessSources,
  stampsByPath: Map<string, FileStamp>,
  codeFile: string,
  recordedHash: string,
): HitFreshness {
  if (stampConfirmsFresh(sources.repoRoot, stampsByPath.get(codeFile), recordedHash)) {
    return 'fresh';
  }
  const result = hashRepoFile(sources.repoRoot, codeFile);
  if (result.status !== 'ok') {
    // Gone (or escapes the repo — never legitimately reachable): the indexed
    // knowledge describes a file that no longer exists there.
    return 'stale';
  }
  return result.contentHash === recordedHash ? 'fresh' : 'stale';
}

/**
 * Build the per-search freshness resolver. Evidence stores (file stamps,
 * learning state) are read lazily ONCE and cached for the resolver's
 * lifetime — a search resolves at most `limit` hits, so per-hit work is a
 * stat (pre-filter hit) or one content hash.
 */
export function createFreshnessResolver(sources: FreshnessSources): FreshnessResolver {
  let stampsByPath: Map<string, FileStamp> | null = null;
  let learningBySlug: Map<string, LearningStatus> | null = null;

  const stamps = (): Map<string, FileStamp> => {
    if (stampsByPath === null) {
      const store = readFileStamps(sources.flowDir);
      stampsByPath = new Map((store?.stamps ?? []).map((stamp) => [stamp.path, stamp]));
    }
    return stampsByPath;
  };

  const learning = (): Map<string, LearningStatus> => {
    if (learningBySlug === null) {
      learningBySlug = readLearningStatusBySlug(sources.flowDir);
    }
    return learningBySlug;
  };

  return (hit: LayeredHit): HitFreshness => {
    switch (hit.kind) {
      case 'symbol':
      case 'code': {
        if (hit.codeFile === undefined || hit.fileHash === undefined) {
          return 'unknown';
        }
        return resolveCodeFreshness(sources, stamps(), hit.codeFile, hit.fileHash);
      }
      case 'module': {
        const slug = basename(hit.file).replace(/\.md$/, '');
        const status = learning().get(slug);
        if (status === 'learned') {
          return 'fresh';
        }
        if (status === 'stale') {
          return 'stale';
        }
        return 'unknown';
      }
      default:
        // decision/error/feature/resource/rule/plan/discovery/note: no
        // machine-checkable anchors on these markdown files today — see the
        // module doc comment for the seam.
        return 'unknown';
    }
  };
}
