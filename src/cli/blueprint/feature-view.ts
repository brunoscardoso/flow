/**
 * Feature view (feature-view) — the curated, GENERATED picture of one feature.
 *
 * WHY THIS EXISTS
 * ===============
 * The brief drew whatever a feature's anchors resolved to, which is a picture of
 * DIRECTORIES. A change record spanning two repos rendered as two boxes named
 * after folders. The approved prototype
 * (`flow/references/blueprint-feature-view-mock.html`) renders the same feature
 * as `Browser · Chat UI → send message → Gateway BFF → SSE tokens → orbit-core
 * engine`, and an engineer learns the system from it. No amount of styling turns
 * the first into the second — it is a different artifact.
 *
 * That artifact is what this module defines. The mock's `DATA` is the contract,
 * verbatim: components with semantic kinds and human titles, edges that carry
 * LABELS, per-component prose, code excerpts, verified references, brief slots
 * and a rollout ladder.
 *
 * AND IT IS GENERATED, NOT AUTHORED. The mock was produced by reading
 * `plan_chat_session_cache_rework_v1.md`. So a pass emits this shape (phase 2) and
 * the board draws it (phase 3) — nobody hand-draws a diagram.
 *
 * DERIVED AND DISPOSABLE. A view is rebuilt from the plan, the discovery docs
 * and the code; the previous one rotates to `.prev.json`. The PRECIOUS knowledge
 * lives in the feature's `## Learned` section, never here.
 *
 * VALIDATION IS THE FEATURE. A view whose edges name absent components, or whose
 * code excerpt points outside its file, is REFUSED — nothing is written. A
 * confidently drawn wrong diagram beats no diagram in the eye and loses in
 * truth, and a fabricated code excerpt would look exactly like evidence.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readFeatures } from './feature-store.js';
import { VIEW_PORT_CROSSES_MAX } from './feature-view-ports-prompt.js';

export { PORTS_EXAMPLE_LINE, VIEW_PORT_CROSSES_MAX, viewPortsPromptLines } from './feature-view-ports-prompt.js';

/** Where views live, relative to `flow/`. Derived — safe to delete. */
export const FEATURE_VIEWS_DIRNAME = join('brain', '.structure', 'feature-views');

/** Component kinds, frozen. Mirrors the mock's node `kind` vocabulary. */
export const VIEW_NODE_KINDS = ['project', 'endpoint', 'integration', 'datastore', 'function', 'module'] as const;
export type ViewNodeKind = (typeof VIEW_NODE_KINDS)[number];

/** How a component differs between Today and After. */
export const VIEW_DELTAS = ['stable', 'modify', 'new', 'remove'] as const;
export type ViewDelta = (typeof VIEW_DELTAS)[number];

/** How a connection differs between Today and After. */
export const VIEW_EDGE_DELTAS = ['kept', 'added', 'removed'] as const;
export type ViewEdgeDelta = (typeof VIEW_EDGE_DELTAS)[number];

/** A real excerpt, read from disk — never the model's recollection of it. */
export interface ViewCode {
  /** Repo-relative file the excerpt comes from. */
  file: string;
  /** 1-indexed inclusive line range. */
  from: number;
  to: number;
  /** Why this code matters — one or two sentences. */
  note: string;
  /** Where the note came from ("source: the comment block in the file"). */
  noteSrc?: string;
  /** The excerpt itself, read from `file` at write time. */
  text: string;
}

/** One curated component. */
export interface ViewNode {
  id: string;
  kind: ViewNodeKind;
  /** Human title — "Gateway BFF", not "src/app/api/chat". */
  title: string;
  /** Secondary line — "streamTurn". */
  sub?: string;
  delta: ViewDelta;
  /** Rollout phases that touch this component. */
  phases?: number[];
  /** What this component IS. */
  doc?: string;
  /** What it does today / after the change. */
  now?: string;
  next?: string;
  /** Id of a nested view to drill into. */
  view?: string;
  code?: ViewCode;
  /** Verified references: `[ref, what it shows]`. */
  refs?: Array<[string, string]>;
}

/** One labelled connection. The label is what makes the picture explain. */
export interface ViewEdge {
  from: string;
  to: string;
  label: string;
  /** Label in the After state, when the change alters it. */
  labelNext?: string;
  delta: ViewEdgeDelta;
}

/**
 * The far end of a port the pass named (plan `diagram-entry-exit` phase 2) —
 * only as finely as it READ. `project` absent means this project; a `file` and
 * a `symbol` are this project's code, checked against the repo.
 */
export interface ViewPortFar {
  /** Another project's slug in the Workspace. Absent: the far end is in this project. */
  project?: string;
  /** The far feature's slug. */
  feature?: string;
  /** Repo-relative file the crossing is made in. */
  file?: string;
  /** Function / symbol in `file` — must appear in its text. */
  symbol?: string;
}

/** One entry into, or exit out of, a level — touching one of its components. */
export interface ViewPort {
  /** What crosses, in a few words: "chat request", "SSE tokens". */
  crosses: string;
  /** Id of the component of THIS level the crossing touches. */
  node: string;
  far: ViewPortFar;
}

/** A level's entries (`in`) and exits (`out`). Optional: older views have none. */
export interface ViewPorts {
  in?: ViewPort[];
  out?: ViewPort[];
}

/** One drawable level: the root view, or a component's nested view. */
export interface ViewLevel {
  title: string;
  kicker?: string;
  summary?: string;
  summaryNext?: string;
  nodes: ViewNode[];
  edges: ViewEdge[];
  /** What reaches this level from outside, and what it reaches out to. */
  ports?: ViewPorts;
}

/** The port sides a level may declare, in drawing order. */
export const VIEW_PORT_SIDES = ['in', 'out'] as const;
export type ViewPortSide = (typeof VIEW_PORT_SIDES)[number];

/** One item in a brief slot: a tone and its text. */
export type ViewSlotItem = [tone: string, text: string];

/** The brief chrome the mock leads with. */
export interface ViewBrief {
  /** The KNOWN ISSUE band. Absent ⇒ no band; never synthesised. */
  problem?: string;
  /** The Unchanged guarantee band. */
  unchanged?: string;
  todayHow?: ViewSlotItem[];
  todayProblems?: ViewSlotItem[];
  why?: ViewSlotItem[];
  /** Claims nothing in the code can prove. */
  fails?: ViewSlotItem[];
}

/** The whole artifact for one feature. */
export interface FeatureView {
  /** Feature slug this view belongs to. */
  feature: string;
  /** Where it came from — `plan:<name>`, `code`, or both. */
  provenance: string;
  /** ISO date generated. */
  generatedAt: string;
  meta: { title: string; sub?: string };
  brief: ViewBrief;
  /** Rollout phases, in order. */
  phases?: Array<{ n: number; title: string }>;
  /** Levels by id. `root` is required and is what opens. */
  views: Record<string, ViewLevel>;
}

/** Result of validating a candidate view. */
export interface ViewValidation {
  ok: boolean;
  errors: string[];
}

const ROOT_VIEW = 'root';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSlot(value: unknown): value is ViewSlotItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => Array.isArray(item) && item.length === 2 && item.every((part) => typeof part === 'string'),
    )
  );
}

/**
 * Validate a candidate view against the contract AND against the repo.
 *
 * Every failure here is a way the surface could lie:
 *  - an edge naming an absent component draws a line from nowhere
 *  - a drill target naming an absent view is a dead door
 *  - a code excerpt outside its file is FABRICATED EVIDENCE, which is the worst
 *    thing this surface can show — it looks exactly like proof
 *
 * `repoRoot` is optional so the pure shape rules can be checked without a repo;
 * pass it to check excerpts against real files.
 */
export function validateFeatureView(
  candidate: unknown,
  repoRoot?: string,
  options: ValidateFeatureViewOptions = {},
): ViewValidation {
  const errors: string[] = [];
  const portCheck = portContext(repoRoot, options);
  if (!isRecord(candidate)) {
    return { ok: false, errors: ['view is not an object'] };
  }
  if (typeof candidate.feature !== 'string' || candidate.feature.length === 0) {
    errors.push('view needs a non-empty "feature"');
  }
  if (!isRecord(candidate.views)) {
    return { ok: false, errors: [...errors, 'view needs a "views" object'] };
  }
  const views = candidate.views;
  if (!isRecord(views[ROOT_VIEW])) {
    errors.push(`view needs a "${ROOT_VIEW}" level — that is what opens`);
  }

  for (const [levelId, rawLevel] of Object.entries(views)) {
    if (!isRecord(rawLevel)) {
      errors.push(`level '${levelId}' is not an object`);
      continue;
    }
    const nodes = Array.isArray(rawLevel.nodes) ? rawLevel.nodes : [];
    const edges = Array.isArray(rawLevel.edges) ? rawLevel.edges : [];
    if (typeof rawLevel.title !== 'string' || rawLevel.title.length === 0) {
      errors.push(`level '${levelId}' needs a title`);
    }

    const ids = new Set<string>();
    for (const raw of nodes) {
      if (!isRecord(raw)) {
        errors.push(`level '${levelId}' has a component that is not an object`);
        continue;
      }
      const id = raw.id;
      if (typeof id !== 'string' || id.length === 0) {
        errors.push(`level '${levelId}' has a component with no id`);
        continue;
      }
      if (ids.has(id)) errors.push(`level '${levelId}' repeats component id '${id}'`);
      ids.add(id);
      if (typeof raw.title !== 'string' || raw.title.length === 0) {
        errors.push(`component '${id}' needs a human title`);
      }
      if (!VIEW_NODE_KINDS.includes(raw.kind as ViewNodeKind)) {
        errors.push(`component '${id}' has kind '${String(raw.kind)}' — expected ${VIEW_NODE_KINDS.join('|')}`);
      }
      if (!VIEW_DELTAS.includes(raw.delta as ViewDelta)) {
        errors.push(`component '${id}' has delta '${String(raw.delta)}' — expected ${VIEW_DELTAS.join('|')}`);
      }
      if (raw.view !== undefined) {
        if (typeof raw.view !== 'string' || !isRecord(views[raw.view])) {
          errors.push(`component '${id}' drills into '${String(raw.view)}', which is not a view — a dead door`);
        }
      }
      if (raw.code !== undefined) {
        errors.push(...validateCode(id, raw.code, repoRoot));
      }
      if (raw.refs !== undefined && !isSlot(raw.refs)) {
        errors.push(`component '${id}' has malformed refs — expected [ref, what] pairs`);
      }
    }

    for (const raw of edges) {
      if (!isRecord(raw)) {
        errors.push(`level '${levelId}' has a connection that is not an object`);
        continue;
      }
      const from = typeof raw.from === 'string' ? raw.from : '';
      const to = typeof raw.to === 'string' ? raw.to : '';
      // A line from nowhere is worse than a missing line: it asserts a
      // relationship between things the reader cannot see.
      if (!ids.has(from)) {
        errors.push(`level '${levelId}' has a connection from '${from}', which is not a component here`);
      }
      if (!ids.has(to)) {
        errors.push(`level '${levelId}' has a connection to '${to}', which is not a component here`);
      }
      if (typeof raw.label !== 'string' || raw.label.length === 0) {
        errors.push(`connection '${from} → ${to}' has no label — an unlabelled line explains nothing`);
      }
      if (!VIEW_EDGE_DELTAS.includes(raw.delta as ViewEdgeDelta)) {
        errors.push(
          `connection '${from} → ${to}' has delta '${String(raw.delta)}' — expected ${VIEW_EDGE_DELTAS.join('|')}`,
        );
      }
    }

    if (rawLevel.ports !== undefined) {
      errors.push(...validatePorts(levelId, rawLevel.ports, ids, portCheck));
    }
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)].sort() };
}

/** What the port checks may consult beyond the candidate itself. */
export interface ValidateFeatureViewOptions {
  /**
   * Feature slugs a port's `far.feature` may name in THIS project. Omitted with
   * a `repoRoot`, the store at `<repoRoot>/flow` is read; omitted without one,
   * the name is not checked — the same rule as file citations, which are only
   * checked when there is a repo to check them against.
   */
  knownFeatures?: readonly string[];
}

interface PortContext {
  repoRoot?: string;
  knownFeatures?: ReadonlySet<string>;
  /** File text by repo-relative path; null when it does not exist or cannot be read. */
  textOf: (file: string) => string | null;
}

function portContext(repoRoot: string | undefined, options: ValidateFeatureViewOptions): PortContext {
  let known: readonly string[] | undefined = options.knownFeatures;
  if (known === undefined && repoRoot !== undefined) {
    try {
      known = readFeatures(join(repoRoot, 'flow')).map((feature) => feature.slug);
    } catch {
      // An unreadable store knows no feature: a port naming one is refused,
      // never waved through on the grounds that nothing could be checked.
      known = [];
    }
  }
  const cache = new Map<string, string | null>();
  const textOf = (file: string): string | null => {
    if (repoRoot === undefined) return null;
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    let text: string | null = null;
    const abs = join(repoRoot, file);
    if (existsSync(abs)) {
      try {
        text = readFileSync(abs, 'utf-8');
      } catch {
        text = null;
      }
    }
    cache.set(file, text);
    return text;
  };
  return {
    ...(repoRoot === undefined ? {} : { repoRoot }),
    ...(known === undefined ? {} : { knownFeatures: new Set(known) }),
    textOf,
  };
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.trim().length > 0);
}

/**
 * Validate a level's entries and exits (plan `diagram-entry-exit` phase 2).
 *
 * Same rule as every other claim in a view: a bad port REFUSES THE VIEW. A port
 * is a line drawn from outside the diagram to one of its boxes, and a port onto
 * an absent box, or one citing a file that is not there or a function that file
 * never mentions, is the same lie as a line from nowhere or an invented excerpt.
 */
function validatePorts(levelId: string, raw: unknown, ids: ReadonlySet<string>, check: PortContext): string[] {
  if (!isRecord(raw)) return [`level '${levelId}' has ports that are not an object — expected { in, out }`];
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!VIEW_PORT_SIDES.includes(key as ViewPortSide)) {
      errors.push(`level '${levelId}' has a port side '${key}' — expected ${VIEW_PORT_SIDES.join('|')}`);
    }
  }
  for (const side of VIEW_PORT_SIDES) {
    const list = raw[side];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`level '${levelId}' ports.${side} is not a list`);
      continue;
    }
    list.forEach((port, index) => {
      errors.push(...validatePort(`level '${levelId}' ${side}-port ${String(index + 1)}`, port, ids, check));
    });
  }
  return errors;
}

function validatePort(where: string, raw: unknown, ids: ReadonlySet<string>, check: PortContext): string[] {
  if (!isRecord(raw)) return [`${where} is not an object`];
  const errors: string[] = [];
  const node = typeof raw.node === 'string' ? raw.node : '';
  if (!ids.has(node)) {
    errors.push(`${where} touches '${node}', which is not a component here`);
  }
  const crosses = typeof raw.crosses === 'string' ? raw.crosses.trim() : '';
  if (crosses.length === 0) {
    errors.push(`${where} says nothing about what crosses — an unlabelled port explains nothing`);
  } else if (crosses.length > VIEW_PORT_CROSSES_MAX) {
    errors.push(`${where} says what crosses in ${String(crosses.length)} characters — at most ${String(VIEW_PORT_CROSSES_MAX)}`);
  }
  if (!isRecord(raw.far)) {
    errors.push(`${where} names no far end`);
    return errors;
  }
  const far = raw.far;
  const { project, feature, file, symbol } = far;
  if (!optionalString(project) || !optionalString(feature) || !optionalString(file) || !optionalString(symbol)) {
    errors.push(`${where} has a far end whose project/feature/file/symbol is not a non-empty string`);
    return errors;
  }
  if (project === undefined && feature === undefined && file === undefined) {
    errors.push(`${where} names no far end — a project, a feature or a file`);
  }
  // A feature in ANOTHER project is that project's name to keep; this store
  // cannot vouch for it either way, and the port is drawn as Flow's suggestion.
  if (feature !== undefined && project === undefined && check.knownFeatures !== undefined && !check.knownFeatures.has(feature)) {
    errors.push(`${where} names feature '${feature}', which is not a feature in this project`);
  }
  if (symbol !== undefined && file === undefined) {
    errors.push(`${where} names '${symbol}' without the file it is in — nothing could check it`);
  }
  if (file !== undefined) {
    if (project !== undefined) {
      // The only repo a validator can read is this one: a cited line in another
      // project would be evidence nobody checked, which is the one thing a view
      // must never carry.
      errors.push(`${where} cites '${file}' in project '${project}' — a file can only be cited in this project's code`);
    } else if (check.repoRoot !== undefined) {
      const text = check.textOf(file);
      if (text === null) {
        errors.push(`${where} cites '${file}', which does not exist`);
      } else if (symbol !== undefined && !text.includes(symbol)) {
        errors.push(`${where} cites '${symbol}' in '${file}', which never mentions it`);
      }
    }
  }
  return errors;
}

/** What a stored excerpt's text is doing relative to the file it cites (#1435). */
export type ExcerptFreshness =
  | { kind: 'fresh' }
  /**
   * The text still exists, at a different line — a pure shift, recoverable.
   * `from..to` is where the MATCHED text sits now — the compared claim, after
   * trailing blank lines are dropped. A healer must take both: rebuilding the
   * span from the stored range instead re-inherits the trailing blanks the
   * comparison never checked, and near EOF that computes an address past the
   * end of the file — a range the validator refuses.
   */
  | { kind: 'shifted'; from: number; to: number }
  /** The text is nowhere in the file — the citation quotes code that is gone. */
  | { kind: 'gone' }
  /** No stored text to compare (older artifact) — nothing can be said. */
  | { kind: 'unknown' };

/**
 * Compare a stored excerpt against the file as it reads NOW (#1435).
 *
 * The format's one guarantee is that the model names a file and line range and
 * the executor reads the text from disk, so a drawer can never show invented
 * code. That holds at write time and was never re-checked afterwards:
 * `validateCode` only asked whether the range was inside the file, so a view
 * whose source moved on stayed `valid` and the drawer kept printing
 * `file:from-to` above text those lines no longer say. Measured on real data,
 * 6 of 29 excerpts across 6 passing views had drifted within 4 days, and one
 * quoted a line that exists nowhere in the file — deleted code presented as
 * current evidence, with a precise citation.
 *
 * Pure and total: takes the file's lines, answers what happened. A shift
 * reports where the text actually starts now, which is what a self-healing
 * re-anchor needs.
 */
export function checkExcerptFreshness(
  fileLines: readonly string[],
  from: number,
  to: number,
  storedText: unknown,
): ExcerptFreshness {
  if (typeof storedText !== 'string' || storedText.length === 0) return { kind: 'unknown' };
  const stored = storedText.replace(/\r\n/g, '\n').split('\n');
  // Trailing blank lines are an artifact of how the excerpt was sliced, not part
  // of the claim — comparing them would report drift for a file that only gained
  // a newline at EOF.
  while (stored.length > 0 && (stored[stored.length - 1] ?? '').trim() === '') stored.pop();
  if (stored.length === 0) return { kind: 'unknown' };

  const matchesAt = (start: number): boolean =>
    stored.every((line, offset) => fileLines[start + offset] === line);

  // `from` is 1-based; a fresh excerpt still sits exactly where it says.
  if (from >= 1 && from - 1 + stored.length <= fileLines.length && matchesAt(from - 1)) {
    return { kind: 'fresh' };
  }
  for (let start = 0; start + stored.length <= fileLines.length; start += 1) {
    if (matchesAt(start)) return { kind: 'shifted', from: start + 1, to: start + stored.length };
  }
  return { kind: 'gone' };
}

/** Validate one code excerpt. With a repoRoot, against the real file. */
function validateCode(nodeId: string, raw: unknown, repoRoot?: string): string[] {
  if (!isRecord(raw)) return [`component '${nodeId}' has a malformed code excerpt`];
  const errors: string[] = [];
  const file = raw.file;
  const from = raw.from;
  const to = raw.to;
  if (typeof file !== 'string' || file.length === 0) {
    errors.push(`component '${nodeId}' code excerpt names no file`);
  }
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isInteger(from) || !Number.isInteger(to)) {
    errors.push(`component '${nodeId}' code excerpt needs integer from/to lines`);
    return errors;
  }
  if (from < 1 || to < from) {
    errors.push(`component '${nodeId}' code excerpt has an impossible range ${String(from)}..${String(to)}`);
  }
  if (typeof raw.note !== 'string' || raw.note.length === 0) {
    errors.push(`component '${nodeId}' code excerpt needs a note saying why it matters`);
  }
  // #1435: the excerpt's whole purpose is to carry the text it read from disk.
  // Nothing checked it was even a string, so a malformed one reached the drawer.
  if (typeof raw.text !== 'string' || raw.text.length === 0) {
    errors.push(`component '${nodeId}' code excerpt carries no text`);
  }
  if (repoRoot !== undefined && typeof file === 'string' && file.length > 0) {
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) {
      errors.push(`component '${nodeId}' quotes '${file}', which does not exist`);
    } else {
      let lines = 0;
      try {
        lines = readFileSync(abs, 'utf-8').split('\n').length;
      } catch {
        errors.push(`component '${nodeId}' quotes '${file}', which could not be read`);
        return errors;
      }
      if (to > lines) {
        // The excerpt claims lines the file does not have — the clearest
        // possible signal that the text was invented rather than read.
        errors.push(
          `component '${nodeId}' quotes '${file}' lines ${String(from)}..${String(to)}, but it has ${String(lines)}`,
        );
      }
    }
  }
  return errors;
}

/** Directory holding generated views for a project. */
export function featureViewsDir(flowDir: string): string {
  return join(flowDir, FEATURE_VIEWS_DIRNAME);
}

/** Path of one feature's view artifact. */
export function featureViewPath(flowDir: string, slug: string): string {
  return join(featureViewsDir(flowDir), `${slug}.json`);
}

/**
 * Read a feature's view, or null when there is none / it is unreadable.
 *
 * Fail-soft by design: a missing or corrupt view must leave the board on its
 * previous behaviour, never blank. This is the one guarantee that lets the new
 * surface ship without risking the old one.
 */
export function readFeatureView(flowDir: string, slug: string): FeatureView | null {
  return inspectFeatureView(flowDir, slug)?.view ?? null;
}

/* ── Inspection: the verdict `readFeatureView` throws away ──────────────────
 *
 * `readFeatureView` answers null for a missing view, a corrupt one and a
 * REFUSED one alike, and that is the right answer for a caller that has to
 * draw something: all three mean "nothing to draw". It is the wrong answer for
 * a caller asking WHY, and until now there was no other caller.
 *
 * Measured on this repo: `feature-views/` holds one artifact, it has failed the
 * validator since 2026-08-04 with three specific errors, and nothing anywhere
 * reported that. A rotted view was invisible rather than visibly broken.
 *
 * So the verdict gets a second reader rather than a weaker validator. Nothing
 * below relaxes a single rule — `inspectFeatureView` runs exactly the same
 * `validateFeatureView`, keeps its messages VERBATIM, and still hands back a
 * `view` only when it passed. `readFeatureView` is now implemented on top of
 * it, so there is one code path and the two can never disagree about what is
 * drawable.
 */

/** What one stored artifact is. `orphaned` is orthogonal and reported beside. */
export type ViewArtifactState = 'valid' | 'invalid' | 'unreadable';

/** File suffixes that are not artifacts: rotations and in-flight writes. */
const NON_ARTIFACT_SUFFIXES = ['.prev.json', '.tmp'];

/** One stored view artifact, with the reason it is or is not drawable. */
export interface FeatureViewInspection {
  /** The slug it is FILED under — its filename, not what it claims to be. */
  slug: string;
  /** Full path, so a report can name the file a human would open. */
  path: string;
  state: ViewArtifactState;
  /** The validator's own messages, VERBATIM. Empty when `state` is `valid`. */
  errors: string[];
  /** The feature this artifact CLAIMS. Empty when it names none. */
  claims: string;
  /** True when this artifact belongs to no feature — see `orphanReason`. */
  orphaned: boolean;
  /** Why, in one clause. Empty when it is not orphaned. */
  orphanReason: string;
  /** The view — only ever when `state` is `valid`. */
  view: FeatureView | null;
  /**
   * Citations whose text no longer matches the lines they name (#1435), one
   * clause each. Deliberately NOT validation errors: a view is marked invalid
   * with `view: null`, so failing it for an excerpt that merely slid 16 lines
   * would take a whole curated drawer away over a recoverable shift — a worse
   * answer than the stale citation it replaces. Reported so `blueprint` can say
   * it, and so a re-anchor pass has something to act on.
   */
  staleExcerpts: string[];
}

export interface InspectFeatureViewOptions {
  /** Check code excerpts against the repo's real files. */
  repoRoot?: string;
  /**
   * Slugs the feature store actually holds.
   *
   * Given, an artifact naming a feature outside the set is orphaned: the
   * feature was renamed or deleted and its picture outlived it. Omitted, the
   * check stops at the filename, because "not in the store" cannot be asserted
   * from a store nobody handed in.
   */
  knownFeatures?: readonly string[];
}

/**
 * Why an artifact belongs to no feature, or '' when it belongs to one.
 *
 * THE ORPHAN IS REAL, NOT HYPOTHETICAL. This repo's one artifact names no
 * feature at all, which is also one of the three validator errors — and a file
 * that names no owner is exactly the file a store sweep would otherwise skip
 * over forever, because there is no feature to look at that would mention it.
 */
function orphanReasonFor(
  slug: string,
  claims: string,
  knownFeatures?: readonly string[],
): string {
  if (claims.length === 0) return 'names no feature';
  if (claims !== slug) return `is filed as '${slug}' but names '${claims}'`;
  if (knownFeatures !== undefined && !knownFeatures.includes(claims)) {
    return `names '${claims}', which is not a feature in the store`;
  }
  return '';
}

/**
 * Inspect one stored view. Null when there is no file at all — an absence is
 * not a limitation, and reporting one would put every unwritten feature on a
 * list of things that are broken.
 */
export function inspectFeatureView(
  flowDir: string,
  slug: string,
  options: InspectFeatureViewOptions = {},
): FeatureViewInspection | null {
  const filePath = featureViewPath(flowDir, slug);
  if (!existsSync(filePath)) return null;
  const base = { slug, path: filePath, claims: '', orphaned: false, orphanReason: '', view: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    // UNREADABLE IS NOT ORPHANED. What feature a file that will not parse
    // belongs to is unknown, and guessing "none" would invent a second fault
    // on top of the one that is actually there.
    return {
      ...base,
      state: 'unreadable',
      errors: [`is not readable JSON: ${(error as Error).message}`],
      staleExcerpts: [],
    };
  }

  const validation = validateFeatureView(parsed, options.repoRoot);
  const claims =
    isRecord(parsed) && typeof parsed.feature === 'string' ? parsed.feature.trim() : '';
  // Only a record can be said to name a feature or not; a JSON array or number
  // fails at 'view is not an object' and adding "names no feature" to that is
  // noise, not a second finding.
  const orphanReason = isRecord(parsed) ? orphanReasonFor(slug, claims, options.knownFeatures) : '';
  // Freshness is only askable of a view that PASSED — an invalid artifact has
  // no trustworthy excerpts to compare — and only with a repo to re-read.
  const view = validation.ok ? (parsed as FeatureView) : null;
  const staleExcerpts =
    view !== null && options.repoRoot !== undefined ? staleExcerptsOf(view, options.repoRoot) : [];

  return {
    ...base,
    state: validation.ok ? 'valid' : 'invalid',
    errors: validation.errors,
    claims,
    orphaned: orphanReason.length > 0,
    orphanReason,
    view,
    staleExcerpts,
  };
}

/** One excerpt the walker visited: where it lives, and what its text is doing. */
interface ExcerptFreshnessEntry {
  /** Key of the level in `views` that holds the node. */
  levelId: string;
  /** The node itself — a REFERENCE into the walked view, so a caller that
   * deep-copied the view first can rewrite through it. */
  node: ViewNode;
  /** The node's excerpt, same reference semantics as `node`. */
  code: ViewCode;
  freshness: ExcerptFreshness;
}

/**
 * Visit every node with a code excerpt across ALL levels and answer, per
 * excerpt, what its text is doing relative to the file it cites (#1435).
 *
 * ONE WALK FOR BOTH READERS. Staleness reporting (`staleExcerptsOf`) and the
 * self-heal (`healFeatureView`) act on the same question — "where is this text
 * now?" — and if each walked the artifact its own way they could disagree
 * about which excerpts drifted (that is exactly how the original bug lived:
 * the validator walked one shape, the staleness walk another). Invariants live
 * in one code path (allowed-pattern #14), so this is the only walk.
 *
 * The first cut of the staleness walk read `levels[].components[]` — a shape
 * no real artifact has; the contract is `views` (a record of levels) →
 * `nodes[]`, which is what the validator checks and what this walks.
 *
 * Fail-soft on files: an unreadable file says nothing about the excerpt, so it
 * reports `unknown` — never a throw, never a false 'gone'. The per-file line
 * cache lives here so a view citing one file from twenty nodes reads it once.
 *
 * Takes a VALIDATED view — callers hold one from `inspectFeatureView` before
 * asking, so the walk needs no defensive re-narrowing.
 */
function walkExcerptFreshness(view: FeatureView, repoRoot: string): ExcerptFreshnessEntry[] {
  const cache = new Map<string, string[] | null>();
  const linesOf = (file: string): string[] | null => {
    const hit = cache.get(file);
    if (hit !== undefined) return hit;
    let lines: string[] | null;
    try {
      // Split tolerating CRLF. `checkExcerptFreshness` normalizes the STORED
      // text's line endings, so leaving '\r' on the file's lines would make
      // every excerpt in a CRLF checkout read 'gone' — and this branch renders
      // that verdict ("no longer in the file") under perfectly current code.
      lines = readFileSync(join(repoRoot, file), 'utf-8').split(/\r?\n/);
    } catch {
      lines = null;
    }
    cache.set(file, lines);
    return lines;
  };

  const entries: ExcerptFreshnessEntry[] = [];
  for (const [levelId, level] of Object.entries(view.views)) {
    for (const node of level.nodes) {
      const code = node.code;
      if (code === undefined) continue;
      const lines = linesOf(code.file);
      const freshness: ExcerptFreshness =
        lines === null
          ? { kind: 'unknown' }
          : checkExcerptFreshness(lines, code.from, code.to, code.text);
      entries.push({ levelId, node, code, freshness });
    }
  }
  return entries;
}

/**
 * Every citation in a view whose text has drifted from the lines it names
 * (#1435), one clause each. A pure consumer of `walkExcerptFreshness` — this
 * function only phrases; the walk decides what drifted.
 */
function staleExcerptsOf(view: FeatureView, repoRoot: string): string[] {
  const findings: string[] = [];
  for (const { node, code, freshness } of walkExcerptFreshness(view, repoRoot)) {
    if (freshness.kind === 'shifted') {
      findings.push(
        `component '${node.id}' cites ${code.file}:${String(code.from)}-${String(code.to)}, but that text now starts at line ${String(freshness.from)}`,
      );
    } else if (freshness.kind === 'gone') {
      findings.push(
        `component '${node.id}' cites ${code.file}:${String(code.from)}-${String(code.to)}, but that text is no longer anywhere in the file`,
      );
    }
  }
  return findings;
}

/**
 * Every NON-fresh excerpt in a view, addressed by level and node (#1435).
 *
 * THE ACCESSOR THE EMITTER NEEDS, AND NOTHING MORE. The brief emits a view for
 * a drawer that renders it uninspected, so any verdict the drawer should show
 * has to travel IN the emitted JSON — which means a caller outside this module
 * must be able to ask "which excerpts failed, and how?". It gets exactly that
 * answer: addresses and verdict kinds, never the walker's node references —
 * handing those out would invite a second writer around `writeFeatureView`.
 * A pure consumer of `walkExcerptFreshness`, so this reader, the staleness
 * report and the heal can never disagree about what drifted
 * (allowed-pattern #14). Fresh excerpts are omitted: absence means verified.
 */
export function excerptFreshness(
  view: FeatureView,
  repoRoot: string,
): Array<{ levelId: string; nodeId: string; kind: 'shifted' | 'gone' | 'unknown' }> {
  const findings: Array<{ levelId: string; nodeId: string; kind: 'shifted' | 'gone' | 'unknown' }> =
    [];
  for (const { levelId, node, freshness } of walkExcerptFreshness(view, repoRoot)) {
    if (freshness.kind === 'fresh') continue;
    findings.push({ levelId, nodeId: node.id, kind: freshness.kind });
  }
  return findings;
}

/**
 * Inspect every stored artifact, filed slug order.
 *
 * Scans the DIRECTORY rather than walking the feature store, which is the only
 * way an orphan can be seen at all: an artifact whose feature is gone is
 * reachable from no feature, so a store-driven walk would never open it.
 * Rotations (`.prev.json`) and in-flight writes (`.tmp`) are not artifacts.
 */
export function inspectFeatureViews(
  flowDir: string,
  options: InspectFeatureViewOptions = {},
): FeatureViewInspection[] {
  const dir = featureViewsDir(flowDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // No directory is no artifacts — the same fail-soft rule the reader keeps.
    return [];
  }
  const slugs = entries
    .filter((name) => name.endsWith('.json'))
    .filter((name) => !NON_ARTIFACT_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .map((name) => name.slice(0, -'.json'.length))
    .sort((a, b) => a.localeCompare(b));

  const inspections: FeatureViewInspection[] = [];
  for (const slug of slugs) {
    const inspection = inspectFeatureView(flowDir, slug, options);
    if (inspection !== null) inspections.push(inspection);
  }
  return inspections;
}

/**
 * Write a feature's view, rotating the previous one to `.prev.json`.
 *
 * DERIVED: this file is rebuilt from the plan, the discovery docs and the code.
 * Nothing precious lives here — the knowledge a human should keep is in the
 * feature's `## Learned` section.
 *
 * Refuses an invalid view, writing nothing.
 */
export function writeFeatureView(
  flowDir: string,
  view: FeatureView,
  repoRoot?: string,
): ViewValidation {
  const validation = validateFeatureView(view, repoRoot);
  if (!validation.ok) return validation;
  const dir = featureViewsDir(flowDir);
  mkdirSync(dir, { recursive: true });
  const filePath = featureViewPath(flowDir, view.feature);
  if (existsSync(filePath)) {
    try {
      renameSync(filePath, `${filePath.slice(0, -'.json'.length)}.prev.json`);
    } catch {
      // A failed rotation must not block the write — the previous view is
      // disposable, and losing it costs nothing a regeneration cannot restore.
    }
  }
  const temp = `${filePath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(view, null, 2)}\n`, 'utf-8');
  renameSync(temp, filePath);
  return validation;
}

/**
 * Re-anchor a view's SHIFTED code excerpts to where their text sits now
 * (#1435).
 *
 * WHAT HEALING IS. An excerpt stores the text it read from disk, so when the
 * cited file gains or loses lines above it the text is still there — just no
 * longer at `from..to`. That is a pure shift: the claim is intact, only the
 * address rotted. Healing rewrites the address (`from` moves to where the text
 * starts now, `to` moves with it so the span is preserved) and touches NOTHING
 * else — `text`, `note`, `noteSrc` stay verbatim, because they are the claim
 * and the claim did not change.
 *
 * WHY THIS IS SAFE. The view is DERIVED AND DISPOSABLE — rebuilt from the
 * plan, the discovery docs and the code, with the previous version rotating to
 * `.prev.json` on every write. Rewriting a line number here can lose nothing
 * precious; the worst a wrong heal could do is what regeneration already
 * fixes. And the heal only ever moves an address to text PROVEN present in the
 * file at this instant — it can never invent evidence, which is the one sin
 * this artifact guards against.
 *
 * ACCEPTED LIMITATION: first match wins. When the excerpt's text appears more
 * than once in the file, `checkExcerptFreshness` reports the first occurrence
 * and the heal anchors there — possibly a duplicate above the original site.
 * Both addresses print the same text, so the drawer still shows true evidence;
 * only the line number may name the twin.
 *
 * `gone` and `unknown` excerpts are COUNTED, never rewritten and never
 * dropped: there is no true address to move a `gone` citation to, and an
 * `unknown` one carries nothing to compare — either way, silently editing or
 * deleting it would hide the finding the staleness report exists to surface.
 *
 * Writes (via `writeFeatureView`, the one artifact writer: re-validate, rotate
 * `.prev.json`, atomic swap) ONLY when at least one excerpt healed — a no-op
 * heal must not churn the rotation. Deterministic: the same artifact against
 * the same repo state walks the same excerpts in the same order and produces
 * the same result.
 *
 * Returns null when no artifact exists or it is not valid — the writer would
 * refuse an invalid view anyway, and healing addresses inside evidence nobody
 * trusts helps no one.
 */
export function healFeatureView(
  flowDir: string,
  slug: string,
  repoRoot: string,
): { healed: number; gone: number; unknown: number } | null {
  const inspection = inspectFeatureView(flowDir, slug, { repoRoot });
  if (inspection === null || inspection.state !== 'valid' || inspection.view === null) return null;

  // Heal a STRUCTURAL COPY, never the inspected object — the parsed view is
  // input, and rewriting it in place would hand the caller an artifact that
  // silently disagrees with what was read from disk.
  const healedView = structuredClone(inspection.view);
  let healed = 0;
  let gone = 0;
  let unknown = 0;
  // Same walker as the staleness report, so the two can never disagree about
  // which excerpts drifted (allowed-pattern #14). Entries reference the copy's
  // own nodes, which is what lets the rewrite go through `code` directly.
  for (const { code, freshness } of walkExcerptFreshness(healedView, repoRoot)) {
    if (freshness.kind === 'shifted') {
      // The verdict's own span, not the stored range's. The comparison drops
      // the stored text's trailing blank lines, so re-deriving the span from
      // `to - from` would claim lines the match never checked — and near EOF
      // that computes an address past the end of the file, which the validator
      // then refuses (found in review, reproduced live).
      code.from = freshness.from;
      code.to = freshness.to;
      healed += 1;
    } else if (freshness.kind === 'gone') {
      gone += 1;
    } else if (freshness.kind === 'unknown') {
      unknown += 1;
    }
  }

  const counts = { healed, gone, unknown };
  if (healed === 0) return counts;
  // A heal writes back to the file it READ. `writeFeatureView` files by
  // `view.feature`, so a misfiled artifact — filed as '<slug>.json' but
  // claiming another feature — would come out at the CLAIMED feature's path,
  // leaving the stale original behind and minting a duplicate. That artifact
  // is already reported as orphaned by inspection; healing must not re-home
  // it, so the addresses stay stale and the counts still say what was found.
  if (healedView.feature !== slug) return counts;
  // Should not refuse — the view was valid and every rewritten address covers
  // exactly the lines the comparison matched. But `healed N` is a claim about
  // the ARTIFACT, so a refused write (the repo changing under us mid-walk)
  // must not report addresses as moved when the file still says otherwise:
  // reviewers found the earlier discard-the-result version reporting
  // `healed 1` forever over a write that never happened. Refusal stays a
  // return, never a throw — a heal that throws over a lost race would turn
  // maintenance into an outage.
  const written = writeFeatureView(flowDir, healedView, repoRoot);
  if (!written.ok) return { healed: 0, gone, unknown };
  return counts;
}
