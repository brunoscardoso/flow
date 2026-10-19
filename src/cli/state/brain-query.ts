/**
 * Project-scoped brain query module — the back-compat engine behind
 * `planflow-ai state-query`.
 *
 * Same corpus it always covered (`.claude/resources/`, `.claude/rules/`,
 * `flow/brain/`, `flow/plans/`, `flow/discovery/`, `CLAUDE.md`), same args,
 * same `{ file, heading, content, score, chunkType }` output shape the skills
 * parse — but read straight from the markdown via `brain-file-search.ts`
 * instead of from a `.brain.sqlite` index. There is no database to open, so
 * there is no "brain unavailable" state and no connection to close.
 *
 * This stays a thin adapter over the ONE search implementation shared with the
 * `brain search` front door (allowed-pattern #14).
 */

import { fileSearchLegs } from './brain-file-search.js';
import { DEFAULT_EXCLUDE_PATHS } from './brain-search-core.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  /** Filter results to a specific content scope. */
  scope?: 'resources' | 'rules' | 'brain' | 'plans' | 'discovery' | 'all';
  /** Filter results to a specific chunk type. */
  type?: string;
  /** Maximum number of results to return (default 10). */
  limit?: number;
}

export interface QueryResult {
  file: string;
  heading: string | undefined;
  content: string;
  score: number;
  chunkType: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 10;

/**
 * Maps a scope name to the directory prefixes that belong to it.
 *
 * THE ONE PLACE A SCOPE IS DEFINED. `QUERY_SCOPES` below is read off this map
 * rather than written out again, so the flag's validator and the search cannot
 * disagree about what exists (allowed-pattern #14).
 */
const SCOPE_TO_DIRS: Record<string, string[]> = {
  resources: ['.claude/resources/'],
  rules: ['.claude/rules/'],
  brain: ['flow/brain/'],
  plans: ['flow/plans/'],
  discovery: ['flow/discovery/'],
  all: [], // no filter
};

/** Every scope this query accepts, in the order `--help` lists them. */
export const QUERY_SCOPES = Object.keys(SCOPE_TO_DIRS) as QueryScope[];

/** A scope name this query understands. */
export type QueryScope = NonNullable<QueryOptions['scope']>;

/**
 * Authoritative-source boosts, carried over verbatim from the index path so a
 * skill asking `--scope resources` still gets the core rule ahead of a passing
 * mention of it. Applied to the file scorer's output rather than passed into an
 * engine, which is the only thing that changed.
 */
const BOOST_PATHS: ReadonlyArray<{ prefix: string; multiplier: number }> = [
  { prefix: '.claude/resources/core/', multiplier: 2.0 },
  { prefix: '.claude/resources/skills/', multiplier: 1.8 },
  { prefix: '.claude/resources/patterns/', multiplier: 1.5 },
  { prefix: '.claude/rules/', multiplier: 1.5 },
];

function boostFor(file: string): number {
  return BOOST_PATHS.find((boost) => file.startsWith(boost.prefix))?.multiplier ?? 1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Search the project's markdown with optional scope and type filtering.
 *
 * A project with no corpus at all yields `[]` — the same empty answer the
 * unavailable index used to give, minus the warning, because "there is nothing
 * to find here" is no longer distinguishable from (or worse than) "the index
 * was never built".
 */
export function queryProjectBrain(
  projectRoot: string,
  query: string,
  opts?: QueryOptions,
): QueryResult[] {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const scopeDirs = SCOPE_TO_DIRS[opts?.scope ?? 'all'] ?? [];

  const { chunks } = fileSearchLegs(projectRoot, query, scopeDirs);

  return chunks
    .filter(
      (chunk) =>
        // The scope allowlist is the trust-tier boundary (FR8): a chunk whose
        // file falls outside the named scope never surfaces, whatever the
        // corpus walk turned up.
        (scopeDirs.length === 0 || scopeDirs.some((dir) => chunk.file.startsWith(dir))) &&
        // Archived plans/discovery are historical noise for every caller.
        !DEFAULT_EXCLUDE_PATHS.some((prefix) => chunk.file.startsWith(prefix)) &&
        (opts?.type === undefined || chunk.chunkType === opts.type),
    )
    .map((chunk) => ({
      file: chunk.file,
      heading: chunk.heading,
      content: chunk.content,
      score: chunk.score * boostFor(chunk.file),
      chunkType: chunk.chunkType,
    }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);
}

/** A hit from a LINKED project brain — a QueryResult tagged with its source. */
export interface LinkedBrainResult extends QueryResult {
  /** The linked brain this hit came from (the link's label). */
  source: string;
}

/** A linked brain's local read-only checkout, resolved by the app (FR-9). */
export interface LinkedBrainCheckout {
  label: string;
  /** Absolute path to a checkout `queryProjectBrain` can search. */
  path: string;
}

/**
 * Search LINKED project brains read-only (team-knowledge-sharing FR-9): each
 * checkout is scored by the SAME `queryProjectBrain` as the local brain, and
 * every hit is tagged with its source label. This never writes — federation is
 * query-only; the owning brain stays the sole write target. A checkout whose
 * clone is absent simply yields no hits (queryProjectBrain returns `[]`), so a
 * missing link is skipped rather than an error.
 */
export function searchLinkedBrains(
  checkouts: LinkedBrainCheckout[],
  query: string,
  opts?: QueryOptions,
): LinkedBrainResult[] {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const hits: LinkedBrainResult[] = [];
  for (const checkout of checkouts) {
    for (const result of queryProjectBrain(checkout.path, query, opts)) {
      hits.push({ ...result, source: checkout.label });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);
}
