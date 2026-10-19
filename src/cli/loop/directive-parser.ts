/**
 * Parser for a loop directive — `flow/loops/<name>.md`.
 *
 * A directive is the loop's DIRECTION, versioned in git: frontmatter naming the
 * engine, queue, scope and caps, plus `## Direction` and `## Rules` prose the
 * run prompt reads. Steering a loop is therefore a commit, and what it was
 * pointed at last month is `git log`.
 *
 * PARSING IS STRICT AND REFUSES — it never falls back to a default mission, a
 * default queue or a silently-dropped cap. A loop runs unattended for hours; a
 * directive that half-parses is a loop chasing the wrong thing with nobody
 * watching, so an unreadable field stops the loop loudly instead. Refusals are
 * plain-message `Error`s naming the file and the exact field; the command layer
 * owns the transport (one `loop refused:` line, exit 1).
 *
 * The strictness extends to UNKNOWN KEYS. `max_open_issue` is a plausible typo
 * of `max_open_issues`, and a parser that ignored it would run the loop
 * uncapped while the file on disk looks like it set a cap. The valid key list
 * is small, versioned and printed in the refusal, so a rejected key is a
 * one-line fix rather than a mystery.
 *
 * Frontmatter is parsed here rather than by a YAML dependency, mirroring
 * `feature-store.ts`: the grammar is a fixed, flat `key: value` set with inline
 * `[a, b]` lists, and the CLI stays dependency-free.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_LEDGER_PATH,
  DEFAULT_LOOP_SLICE,
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_MAX_RUN_MINUTES,
  MAX_CONCURRENT_RUNS_LIMIT,
  DEFAULT_MAX_OPEN_ISSUES,
  LOOP_ENGINES,
  LOOP_QUEUE_KINDS,
  LOOP_SLICES,
  isLoopEngine,
  isLoopQueueKind,
  isLoopSlice,
} from './types.js';
import type { LoopDirective, LoopSlice } from './types.js';
import { topicProblem } from './queue-backend.js';
import { stripTrailingComment } from '../utils/config-comment.js';

/** Directory holding loop RUNTIME state (state.json, beats.jsonl, queue.jsonl), relative to `flow/`. */
export const LOOPS_DIRNAME = 'loops';

/**
 * Directory holding loop DIRECTIVES, relative to the project root.
 *
 * Directives are versioned intent — the whole steering model is "edit the
 * mission, commit, and the next run pulls it", including on another machine.
 * They cannot live under `flow/`, which is a symlink into the vault: git
 * refuses to track anything beyond a symbolic link, so a directive written
 * there exists on exactly one computer and `git pull` at the top of every run
 * can never carry it. That contradiction shipped once; this constant is the
 * fix.
 *
 * Runtime state stays in `flow/loops/` on purpose — it is local, derived and
 * correctly untracked. Intent is versioned; state is not.
 */
export const TRACKED_LOOPS_DIRNAME = 'loops';

/** Fence delimiting the frontmatter block. */
const FRONTMATTER_FENCE = '---';

/**
 * What `max_run_minutes` was called when a run was called a run.
 *
 * Accepted on read and normalized to the current key. A directive is COMMITTED
 * and shared, so a teammate's checkout can carry the old spelling long after
 * this one is updated — and strict parsing would stop their loop over a rename
 * that changed nothing about what they meant.
 */
export const LEGACY_MAX_RUN_MINUTES_KEY = 'max_beat_minutes';

/**
 * Every key the frontmatter grammar allows. Anything else refuses — see the
 * module header on why an ignored key is worse than a refused one.
 */
export const DIRECTIVE_KEYS = [
  'loop',
  'engine',
  'paused',
  'mission',
  'scope',
  'slice',
  'queue',
  'repo',
  'path',
  'label',
  'topic',
  'max_open_issues',
  'max_run_minutes',
  'max_concurrent_runs',
  'needs_approval',
] as const;

/**
 * Loop names are used as filenames, branch segments (`loop/<name>/…`) and
 * state-store keys, so the grammar is the intersection of what all three take:
 * lowercase alphanumerics in dash-separated runs.
 */
export const LOOP_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `owner/name` — the only repo form `gh` accepts for a cross-repo call. */
export const REPO_PATTERN = /^[^\s/]+\/[^\s/]+$/;

/**
 * Where a loop's directive may live, in precedence order: the tracked
 * `<root>/loops/` first, then the legacy `flow/loops/` it used to live in.
 *
 * The project root is the parent of `flowDir` — every caller builds that path
 * as `join(target, 'flow')`, so the two are the same fact stated twice rather
 * than an assumption about layout.
 *
 * Reading both homes is a MIGRATION affordance, not a feature: a machine whose
 * directives still sit in the vault keeps working until its files are moved,
 * and nothing silently stops resolving mid-flight. The tracked home always
 * wins, so a committed directive can never be shadowed by a stale local copy.
 */
export function loopDirectiveCandidates(flowDir: string, loop: string): string[] {
  const projectRoot = dirname(flowDir);
  return [
    join(projectRoot, TRACKED_LOOPS_DIRNAME, `${loop}.md`),
    join(flowDir, LOOPS_DIRNAME, `${loop}.md`),
  ];
}

/** Absolute path of a loop's directive file — the tracked home. */
export function loopDirectivePath(flowDir: string, loop: string): string {
  return loopDirectiveCandidates(flowDir, loop)[0];
}

/** Throw the one-line refusal for a directive, always naming its source. */
function refuse(source: string, reason: string): never {
  throw new Error(`${source}: ${reason}`);
}

/** Split frontmatter lines from the body. Mirrors `feature-store.ts`. */
function splitFrontmatter(raw: string): { fm: string[] | null; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    return { fm: null, body: normalized };
  }
  const end = normalized.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length);
  if (end === -1) {
    // Unterminated fence — no frontmatter was parsed, and the caller refuses.
    return { fm: null, body: normalized };
  }
  const fm = normalized.slice(FRONTMATTER_FENCE.length + 1, end).split('\n');
  const body = normalized.slice(end + FRONTMATTER_FENCE.length + 2);
  return { fm, body };
}

/**
 * Read frontmatter lines into a key→value map. Duplicate keys REFUSE rather
 * than last-wins: two `mission` lines mean the file disagrees with itself, and
 * silently honouring one of them is how a loop ends up running the mission
 * nobody meant.
 */
function parseFrontmatter(lines: readonly string[], source: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) {
      refuse(source, `malformed frontmatter line '${trimmed}' — expected 'key: value'`);
    }
    let key = trimmed.slice(0, colon).trim();
    const value = stripTrailingComment(trimmed.slice(colon + 1)).trim();
    // The pre-rename spelling still loads. A directive is COMMITTED, so a
    // teammate's checkout (or another machine) can carry the old key long after
    // this one is updated, and refusing it would stop their loop for a rename
    // that changed nothing about what they meant.
    if (key === LEGACY_MAX_RUN_MINUTES_KEY) key = 'max_run_minutes';
    if (!(DIRECTIVE_KEYS as readonly string[]).includes(key)) {
      refuse(source, `unknown frontmatter key '${key}' — expected one of ${DIRECTIVE_KEYS.join(', ')}`);
    }
    if (fields.has(key)) {
      refuse(source, `duplicate frontmatter key '${key}'`);
    }
    fields.set(key, value);
  }
  return fields;
}

/** Parse an inline `[a, b]` list; a bare value is a one-element list. */
function parseList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === '[]') return [];
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Parse a strict boolean — anything but `true`/`false` refuses. */
function parseBoolean(
  fields: Map<string, string>,
  key: string,
  fallback: boolean,
  source: string,
): boolean {
  const raw = fields.get(key);
  if (raw === undefined || raw.length === 0) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return refuse(source, `malformed ${key} '${raw}' — expected true or false`);
}

/**
 * Parse a positive-integer cap. Empty, zero, negative, fractional and
 * non-numeric all refuse: a cap is the one field whose misreading lets a
 * producer file without bound.
 */
function parsePositiveInt(
  fields: Map<string, string>,
  key: string,
  fallback: number,
  source: string,
): number {
  const raw = fields.get(key);
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^\d+$/.test(raw)) {
    refuse(source, `malformed ${key} '${raw}' — expected a positive integer`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed <= 0) {
    refuse(source, `malformed ${key} '${raw}' — expected a positive integer`);
  }
  return parsed;
}

/**
 * `max_concurrent_runs` — how many runs of this loop may run at once.
 *
 * CAPPED, unlike the other counts. `max_open_issues` and `max_run_minutes` bound
 * things the machine does not pay for by the unit; a run slot is a whole git
 * worktree on disk and a run's worth of CPU, so a fat-fingered `20` should be a
 * refusal naming the ceiling rather than twenty checkouts appearing in a sibling
 * directory.
 */
function parseConcurrentRuns(fields: Map<string, string>, source: string): number {
  const parsed = parsePositiveInt(
    fields,
    'max_concurrent_runs',
    DEFAULT_MAX_CONCURRENT_RUNS,
    source,
  );
  if (parsed > MAX_CONCURRENT_RUNS_LIMIT) {
    refuse(
      source,
      `max_concurrent_runs ${String(parsed)} is above the limit of ${String(MAX_CONCURRENT_RUNS_LIMIT)} — each run holds its own git worktree`,
    );
  }
  return parsed;
}

/**
 * Extract a `## <heading>` section's prose, trimmed. Absent yields the empty
 * string — prose is guidance for the run prompt, not an invariant, so its
 * absence is a thin directive rather than a broken one.
 */
export function extractSection(body: string, heading: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const wanted = heading.trim().toLowerCase();
  const collected: string[] = [];
  let inside = false;
  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match !== null) {
      if (inside) break;
      inside = match[1].trim().toLowerCase() === wanted;
      continue;
    }
    if (inside) collected.push(line);
  }
  return collected.join('\n').trim();
}

/**
 * Parse directive content into a validated `LoopDirective`.
 *
 * `source` names the file in every refusal message (callers pass the path);
 * it never affects what is parsed. Throws on any violation — nothing partial
 * is ever returned.
 */
export function parseLoopDirective(content: string, source = 'directive'): LoopDirective {
  const { fm, body } = splitFrontmatter(content);
  if (fm === null) {
    refuse(source, `missing frontmatter — expected a '${FRONTMATTER_FENCE}' fenced block at the top`);
  }
  const fields = parseFrontmatter(fm, source);

  const loop = fields.get('loop')?.trim() ?? '';
  if (loop.length === 0) {
    refuse(source, "missing 'loop' — a directive must name its loop");
  }
  if (!LOOP_NAME_PATTERN.test(loop)) {
    refuse(source, `malformed loop name '${loop}' — expected lowercase alphanumerics with single dashes`);
  }

  const engine = fields.get('engine')?.trim() ?? '';
  if (engine.length === 0) {
    refuse(source, `missing 'engine' — expected ${LOOP_ENGINES.join('|')}`);
  }
  if (!isLoopEngine(engine)) {
    refuse(source, `unknown engine '${engine}' — expected ${LOOP_ENGINES.join('|')}`);
  }

  // The mission is the one field with NO default. A loop running the wrong
  // mission unattended is the failure this whole parser exists to prevent.
  const mission = fields.get('mission')?.trim() ?? '';
  if (mission.length === 0) {
    refuse(source, "missing 'mission' — a loop with no mission has nothing to run");
  }

  const queue = fields.get('queue')?.trim() ?? '';
  if (queue.length === 0) {
    refuse(source, `missing 'queue' — expected ${LOOP_QUEUE_KINDS.join('|')}`);
  }
  if (!isLoopQueueKind(queue)) {
    refuse(source, `unknown queue '${queue}' — expected ${LOOP_QUEUE_KINDS.join('|')}`);
  }

  const sliceRaw = fields.get('slice')?.trim() ?? '';
  if (sliceRaw.length > 0 && !isLoopSlice(sliceRaw)) {
    refuse(source, `unknown slice '${sliceRaw}' — expected ${LOOP_SLICES.join('|')}`);
  }
  const slice: LoopSlice = isLoopSlice(sliceRaw) ? sliceRaw : DEFAULT_LOOP_SLICE;

  const directive: LoopDirective = {
    loop,
    engine,
    paused: parseBoolean(fields, 'paused', false, source),
    mission,
    scope: parseList(fields.get('scope') ?? ''),
    slice,
    queue,
    maxOpenIssues: parsePositiveInt(fields, 'max_open_issues', DEFAULT_MAX_OPEN_ISSUES, source),
    maxRunMinutes: parsePositiveInt(fields, 'max_run_minutes', DEFAULT_MAX_RUN_MINUTES, source),
    maxConcurrentRuns: parseConcurrentRuns(fields, source),
    needsApproval: parseBoolean(fields, 'needs_approval', false, source),
    direction: extractSection(body, 'Direction'),
    rules: extractSection(body, 'Rules'),
  };

  // Queue-shaped fields: each backend needs exactly what it needs, and a field
  // belonging to the OTHER backend refuses rather than sitting there implying
  // a configuration that is not in force.
  const repo = fields.get('repo')?.trim() ?? '';
  const path = fields.get('path')?.trim() ?? '';
  if (queue === 'github') {
    if (repo.length === 0) {
      refuse(source, "queue 'github' requires 'repo: owner/name'");
    }
    if (!REPO_PATTERN.test(repo)) {
      refuse(source, `malformed repo '${repo}' — expected owner/name`);
    }
    if (path.length > 0) {
      refuse(source, "'path' applies to queue 'ledger' only");
    }
    directive.repo = repo;
  } else {
    if (repo.length > 0) {
      refuse(source, "'repo' applies to queue 'github' only");
    }
    directive.path = path.length > 0 ? path : DEFAULT_LEDGER_PATH;
  }

  const label = fields.get('label')?.trim() ?? '';
  if (label.length > 0) {
    directive.label = label;
  }

  // The topic is the one directive field that becomes REPO CONFIGURATION: the
  // GitHub backend creates a missing topic label rather than making a human go
  // and make one. So it is validated against the shared label grammar
  // (`topicProblem` — one code path, also enforced at filing) and REFUSES rather
  // than being sanitized: a topic quietly rewritten into something legal is a
  // loop filing under a word its owner never chose, discovered a week later.
  // An empty `topic:` is absence, mirroring `label:`.
  const topic = fields.get('topic')?.trim() ?? '';
  const topicIssue = topicProblem(topic);
  if (topicIssue !== null) {
    refuse(source, topicIssue);
  }
  if (topic.length > 0) {
    directive.topic = topic;
  }

  return directive;
}

/**
 * Read and parse `flow/loops/<loop>.md`.
 *
 * A missing file refuses — asking for a loop that has no directive is a typo or
 * a deleted loop, and neither may run. The `loop:` field must MATCH the
 * filename: two names for one loop would key the state store one way and the
 * queue another, and the mismatch would only surface as work quietly landing
 * under a loop nobody is watching.
 */
export function readLoopDirective(flowDir: string, loop: string): LoopDirective {
  const candidates = loopDirectiveCandidates(flowDir, loop);
  const filePath = candidates.find((candidate) => existsSync(candidate));
  if (filePath === undefined) {
    // Name BOTH homes: the commonest cause of this refusal is a directive
    // sitting in the vault on another machine, and a message naming only one
    // path sends the reader looking in the place they already looked.
    throw new Error(`no directive for loop '${loop}' at ${candidates.join(' or ')}`);
  }
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`${filePath}: unreadable (${(error as Error).message})`);
  }
  const directive = parseLoopDirective(content, filePath);
  if (directive.loop !== loop) {
    refuse(filePath, `loop '${directive.loop}' does not match its filename '${loop}.md'`);
  }
  return directive;
}
