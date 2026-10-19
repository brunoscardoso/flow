/**
 * `planflow-ai brain search` — the ONE front door for project-knowledge
 * questions (brain-first-retrieval Phase 2). Runs the layered fan-out from
 * `brain-search-core` (markdown corpus + generated INDEX.md + symbols
 * sidecar), resolves per-hit freshness through the `hit-freshness` contract,
 * and renders capped output:
 *
 *   1. ● fresh symbol app/src/main/project/thread-scope-manager.ts:54
 *      ThreadScopeManager (class, typescript) — …
 *   …
 *   drill: planflow-ai brain search "<query>" --full <id>
 *
 * ≤5 hits by default, each ≤200 tokens; the final line is ALWAYS the
 * drill-down hint. `--full <id>` prints one hit's full chunk; `--json` emits
 * the structured shape. There is no index to be missing: the corpus is the
 * project's own markdown, so a project with nothing to find answers `no hits`
 * rather than apologising for an absent database.
 *
 * `state-query` remains the back-compat alias over the same core
 * (allowed-pattern #14) — args and JSON output preserved for the skills
 * that parse it.
 */

import { join, resolve } from 'node:path';
import {
  BRAIN_SEARCH_SCOPES,
  layeredBrainSearch,
  workspaceProjectsToSearch,
} from '../state/brain-search-core.js';
import type { BrainSearchScope, LayeredHit, WorkspaceSearchContext } from '../state/brain-search-core.js';
import { createFreshnessResolver } from '../state/hit-freshness.js';
import type { FreshnessResolver, HitFreshness } from '../state/hit-freshness.js';
import { workspaceContextOf } from '../handlers/workspace-model.js';
import { readWorkspaceLinks } from '../handlers/workspace-links.js';

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

export interface BrainSearchOptions {
  scope?: string;
  limit?: number;
  /** Hit id whose full chunk should be printed instead of the ranked list. */
  full?: string;
  json?: boolean;
  /** Project root (defaults to cwd at the CLI layer). */
  target: string;
}

/** One rendered hit in `--json` output. */
export interface BrainSearchJsonHit {
  id: string;
  kind: string;
  freshness: HitFreshness;
  file: string;
  heading?: string;
  codeFile?: string;
  line?: number;
  score: number;
  layers: string[];
  snippet: string;
  /** The Workspace project the hit came from (`--scope workspace`, and link hits). */
  project?: string;
}

/** Said once when `--scope workspace` is asked of a project in no Workspace. */
export const NOT_IN_WORKSPACE_NOTE = 'this project is in no Workspace — searched this project only';

const DEFAULT_LIMIT = 5;
/** Candidate pool used when hunting a `--full <id>` target. */
const FULL_LOOKUP_POOL = 25;
/** ≤200 tokens per hit — 3 snippet lines capped well under that budget. */
const SNIPPET_MAX_LINES = 3;
const SNIPPET_LINE_MAX_CHARS = 160;

// ---------------------------------------------------------------------------
// Rendering (pure — unit-tested directly)
// ---------------------------------------------------------------------------

/** `● fresh` / `○ stale` / plain (unknown gets no marker — rendered plain). */
function freshnessTag(freshness: HitFreshness): string {
  if (freshness === 'fresh') {
    return '● fresh ';
  }
  if (freshness === 'stale') {
    return '○ stale ';
  }
  return '';
}

/**
 * The one-line pointer for a hit — `file:line` wherever a line is known.
 *
 * The contract promises a `file:line` pointer, and under the retired index only
 * SYMBOL hits could keep it: chunks came out of a database that never recorded
 * where in a file they began, so every other hit pointed at a whole document and
 * left the reader to find the paragraph. The file engine reads the file, so it
 * knows — and a pointer that lands on the right line is the difference between
 * drilling down costing one screen and costing a whole document.
 */
export function hitPointer(hit: LayeredHit): string {
  if (hit.kind === 'symbol' && hit.codeFile !== undefined && hit.line !== undefined) {
    return `${hit.codeFile}:${hit.line}`;
  }
  if (hit.kind === 'code' && hit.codeFile !== undefined) {
    return `${hit.codeFile} (${hit.file}${hit.line !== undefined ? `:${hit.line}` : ''})`;
  }
  const at = hit.line !== undefined ? `${hit.file}:${hit.line}` : hit.file;
  return hit.heading !== undefined ? `${at} › ${hit.heading}` : at;
}

/** First non-empty lines of the content, capped per line and in count. */
export function hitSnippet(content: string): string[] {
  const lines: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    lines.push(
      line.length > SNIPPET_LINE_MAX_CHARS ? `${line.slice(0, SNIPPET_LINE_MAX_CHARS - 1)}…` : line,
    );
    if (lines.length >= SNIPPET_MAX_LINES) {
      break;
    }
  }
  return lines;
}

/**
 * Render the ranked human output. The final line is ALWAYS the drill-down
 * hint — with the top hit's id when there is one, a placeholder otherwise.
 */
export function renderHits(
  query: string,
  hits: LayeredHit[],
  freshnessOf: (hit: LayeredHit) => HitFreshness,
  scope: BrainSearchScope = 'all',
): string {
  const lines: string[] = [];
  if (hits.length === 0) {
    lines.push('no hits');
  }
  hits.forEach((hit, index) => {
    const freshness = freshnessOf(hit);
    const staleSuffix = freshness === 'stale' ? ' — verify against code' : '';
    lines.push(`${index + 1}. ${freshnessTag(freshness)}${hit.kind} ${hitPointer(hit)}${staleSuffix}`);
    for (const snippetLine of hitSnippet(hit.content)) {
      lines.push(`   ${snippetLine}`);
    }
    lines.push(`   id: ${hit.id}`);
  });
  const drillId = hits.length > 0 ? hits[0].id : '<id>';
  // A Workspace hit's id only resolves inside a Workspace search.
  const scopeFlag = scope === 'workspace' ? ' --scope workspace' : '';
  lines.push(`drill: planflow-ai brain search "${query}"${scopeFlag} --full ${drillId}`);
  return lines.join('\n');
}

/** Render one hit's FULL content (the `--full <id>` view). */
export function renderFullHit(hit: LayeredHit, freshness: HitFreshness): string {
  const lines = [
    `${freshnessTag(freshness)}${hit.kind} ${hitPointer(hit)}`,
    `id: ${hit.id} · layers: ${hit.layers.join('+')} · score: ${hit.score.toFixed(3)}`,
  ];
  if (freshness === 'stale') {
    lines.push('○ stale — verify against code');
  }
  lines.push('', hit.content);
  return lines.join('\n');
}

/** The structured `--json` shape for one hit. */
export function toJsonHit(hit: LayeredHit, freshness: HitFreshness): BrainSearchJsonHit {
  return {
    id: hit.id,
    kind: hit.kind,
    freshness,
    file: hit.file,
    heading: hit.heading,
    codeFile: hit.codeFile,
    line: hit.line,
    score: hit.score,
    layers: hit.layers,
    snippet: hitSnippet(hit.content).join('\n'),
    ...(hit.project === undefined ? {} : { project: hit.project }),
  };
}

/**
 * The Workspace this project is in, as the search core reads it — or
 * undefined outside one. Resolved through `workspace status`'s own lookup
 * (allowed-pattern #14); nothing here derives a Workspace path.
 */
function workspaceSearchContext(projectRoot: string): WorkspaceSearchContext | undefined {
  const status = workspaceContextOf(projectRoot);
  if (status === null || status.workspace === null || status.project === null) return undefined;
  const self = status.project;
  return {
    workspace: status.workspace.slug,
    selfSlug: self.slug,
    projects: [
      { slug: self.slug, self: true, flowDir: join(projectRoot, 'flow'), repoRoot: projectRoot },
      ...status.siblings.map((sibling) => ({ slug: sibling.slug, self: false, flowDir: sibling.flowPath, repoRoot: sibling.localPath })),
    ],
    links: readWorkspaceLinks(status.workspace.path).links,
  };
}

/**
 * Freshness for a hit from any project: a namespaced hit is judged against
 * ITS project's stamps, with its paths un-namespaced first.
 */
function workspaceFreshness(own: FreshnessResolver, workspace: WorkspaceSearchContext | undefined): FreshnessResolver {
  if (workspace === undefined) return own;
  const byProject = new Map<string, FreshnessResolver>();
  for (const project of workspace.projects) {
    byProject.set(
      project.slug,
      project.self ? own : createFreshnessResolver({ repoRoot: project.repoRoot ?? project.flowDir, flowDir: project.flowDir }),
    );
  }
  return (hit) => {
    if (hit.project === undefined || hit.kind === 'link') return own(hit);
    const resolver = byProject.get(hit.project);
    if (resolver === undefined) return 'unknown';
    const prefix = `${hit.project}/`;
    const strip = (value: string | undefined): string | undefined =>
      value !== undefined && value.startsWith(prefix) ? value.slice(prefix.length) : value;
    return resolver({ ...hit, file: strip(hit.file) ?? hit.file, codeFile: strip(hit.codeFile) });
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Print a refusal and fail the command — the ONE refusal path this command
 * has (#1591). Both refusals it can raise (an unknown `--scope`, an
 * unresolvable `--full <id>`) go through here, so they cannot drift apart
 * again: each exits 1, and each emits parseable JSON under `--json` instead
 * of a bare prose line a JSON consumer blows up on. Drill ids are explicitly
 * perishable, so a stale one is the everyday failure, not a rare one.
 */
function refuse(message: string, context: { query: string; full?: string; json?: boolean }): void {
  if (context.json === true) {
    console.log(
      JSON.stringify(
        { query: context.query, full: context.full ?? null, error: message, hit: null },
        null,
        2,
      ),
    );
  } else {
    console.log(`brain search: ${message}`);
  }
  process.exitCode = 1;
}

/** Validate/normalize the scope argument. Throws on an unknown scope. */
function parseScope(raw: string | undefined): BrainSearchScope {
  const scope = raw ?? 'all';
  if (!BRAIN_SEARCH_SCOPES.includes(scope as BrainSearchScope)) {
    throw new Error(
      `unknown scope "${scope}" — valid: ${BRAIN_SEARCH_SCOPES.join(', ')}`,
    );
  }
  return scope as BrainSearchScope;
}

export async function runBrainSearch(query: string, options: BrainSearchOptions): Promise<void> {
  const projectRoot = resolve(options.target);
  const flowDir = join(projectRoot, 'flow');

  let scope: BrainSearchScope;
  try {
    scope = parseScope(options.scope);
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error), {
      query,
      full: options.full,
      json: options.json,
    });
    return;
  }

  const limit = options.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0
    ? options.limit
    : DEFAULT_LIMIT;

  // The Workspace is looked up only for the scopes that read it: the whole
  // corpus (which surfaces this project's cross-project links) and
  // `workspace` itself.
  const workspace = scope === 'all' || scope === 'workspace' ? workspaceSearchContext(projectRoot) : undefined;
  const notes: string[] = [];
  if (scope === 'workspace' && workspace === undefined) {
    notes.push(NOT_IN_WORKSPACE_NOTE);
  }
  if (scope === 'workspace' && workspace !== undefined) {
    const { skipped } = workspaceProjectsToSearch(workspace);
    if (skipped.length > 0) {
      notes.push(`searched ${workspace.projects.length - skipped.length} of ${workspace.projects.length} projects — not searched: ${skipped.map((project) => project.slug).join(', ')}`);
    }
  }

  const hits = await layeredBrainSearch({
    projectRoot,
    flowDir,
    query,
    scope,
    ...(workspace === undefined ? {} : { workspace }),
    // A --full lookup hunts across a wider pool so drill-down ids from a
    // previous run keep resolving even when they ranked below the cap.
    limit: options.full !== undefined ? Math.max(limit, FULL_LOOKUP_POOL) : limit,
  });

  const resolveFreshness = workspaceFreshness(createFreshnessResolver({ repoRoot: projectRoot, flowDir }), workspace);
  const workspaceFields = scope === 'workspace'
    ? { workspace: workspace?.workspace ?? null, ...(notes.length > 0 ? { note: notes.join('; ') } : {}) }
    : {};

  if (options.full !== undefined) {
    const target = hits.find((hit) => hit.id === options.full);
    if (target === undefined) {
      refuse(`id ${options.full} not found — re-run the search for fresh ids`, {
        query,
        full: options.full,
        json: options.json,
      });
      return;
    }
    if (options.json) {
      console.log(JSON.stringify({ query, scope, ...workspaceFields, hit: { ...toJsonHit(target, resolveFreshness(target)), content: target.content } }, null, 2));
    } else {
      console.log(renderFullHit(target, resolveFreshness(target)));
    }
    return;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        { query, scope, ...workspaceFields, hits: hits.map((hit) => toJsonHit(hit, resolveFreshness(hit))) },
        null,
        2,
      ),
    );
    return;
  }

  for (const note of notes) console.log(`brain search: ${note}`);
  console.log(renderHits(query, hits, resolveFreshness, workspace === undefined ? 'all' : scope));
}
