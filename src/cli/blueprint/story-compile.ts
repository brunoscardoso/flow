/**
 * Compile core for the `blueprint narrate` verb — the single mediated write
 * path producing `flow/brain/.structure/story.json` (allowed-pattern #14:
 * invariants live in ONE code path, not prompt convention).
 *
 * The compile takes a plan/discovery/brainstorm doc's `## Story` section
 * (parsed by `story-grammar.ts`), resolves each step's anchors and flow ids
 * against the current derived graph plus the effective proposal set
 * ("ghosts"), and emits a `CompiledStory`:
 *
 * - STRICT mode refuses (nothing written, exit 1) on ANY unresolved anchor,
 *   unknown flow id, or non-positive-integer phase — listing ALL violations
 *   at once, sorted. A missing graph is itself a strict refusal.
 * - DRAFT mode is lenient: the same problems compile with `draft: true` and a
 *   populated `unresolvedAnchors`, and the summary counts drafts.
 *
 * An absent `## Story` section refuses in BOTH modes. Steps are capped at
 * `STORY_STEP_CAP` with an EXPLICIT warning listing dropped titles — never a
 * silent truncation.
 *
 * The store write is atomic (temp file + rename) under a `story.lock` file
 * with the sibling stores' `acquireGraphLock` semantics (brief retry, stale
 * reclaim). Serialization is DETERMINISTIC — stable key order, 2-space
 * indent, steps in source order, NO timestamps/clock — so the same inputs
 * always produce byte-identical `story.json` (determinism rule).
 *
 * Compilation is pure (no I/O, no clock); only `writeCompiledStory`,
 * `readCompiledStory`, and `clearCompiledStory` touch the filesystem.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveStoryAnchors } from './anchors.js';
import type { EffectiveProposal } from './proposal-store.js';
import { acquireGraphLock } from './store.js';
import { parseFlowItem, parseStorySection } from './story-grammar.js';
import type { Anchor, BlueprintGraph, CompiledStory, StoryStep } from './types.js';
import { STORY_STEP_CAP } from './types.js';

/** Filename of the compiled story store inside `<flowDir>/brain/.structure/`. */
export const STORY_FILENAME = 'story.json';
/** Temp file the story serialization lands in before the atomic rename. */
const STORY_TEMP_FILENAME = 'story.json.tmp';
/** Lock file shared by every story-store writer (ONE lock per store). */
const STORY_LOCK_FILENAME = 'story.lock';
/** JSON indent width — matches the sibling graph store's serialization. */
const JSON_INDENT = 2;
/** Lowest valid plan phase number (phases are 1-based; 0 is a violation). */
const MIN_PHASE = 1;

/**
 * One-line notice thrown when a story write cannot acquire the store lock.
 * Surfaced fail-soft by the CLI as `narrate refused: story store busy — retry`.
 */
export const STORY_STORE_BUSY_NOTICE = 'story store busy — retry';

/** The `## Story` section heading (level 2, exact word) — mirrors the grammar. */
const STORY_HEADING_PATTERN = /^##\s+Story\s*$/;

/** Compile mode: strict refuses on any resolution gap; draft is lenient. */
export type StoryMode = 'draft' | 'strict';

/** Proposal states an anchor/flow id may resolve against (mirrors anchors.ts). */
const RESOLVABLE_PROPOSAL_STATES: ReadonlySet<EffectiveProposal['state']> = new Set([
  'proposed',
  'accepted',
]);

/**
 * Detect a `## Story` heading without parsing the whole section. The parser
 * returns `{ steps: [], warnings: [] }` for BOTH "no story section" and
 * "empty story section", so the compile pass distinguishes them here: an
 * absent section refuses, an empty-but-present section compiles to zero steps.
 */
export function hasStorySection(markdown: string): boolean {
  return markdown
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .some((line) => STORY_HEADING_PATTERN.test(line));
}

/**
 * Infer the compile mode from the doc's source path, unless an explicit flag
 * overrides it: docs under `flow/plans/` are strict, docs under
 * `flow/discovery/` or `flow/brainstorms/` are draft. Any other path returns
 * null — the caller must refuse unless a `--draft`/`--strict` flag was given.
 */
export function inferMode(sourcePath: string, flag?: StoryMode): StoryMode | null {
  if (flag !== undefined) {
    return flag;
  }
  const posixPath = sourcePath.split('\\').join('/');
  if (posixPath.includes('flow/plans/')) {
    return 'strict';
  }
  if (posixPath.includes('flow/discovery/') || posixPath.includes('flow/brainstorms/')) {
    return 'draft';
  }
  return null;
}

/** `plan_<name>_vN.md` / `discovery_<name>_vN.md` / `brainstorm_<name>_vN.md`. */
const DERIVED_PLAN_NAME_PATTERN = /^(?:plan|discovery|brainstorm)_(.+?)(?:_v\d+)?$/;

/**
 * Resolve the plan name a story belongs to: the explicit `--plan` value when
 * given, else derived from the doc filename per the naming conventions
 * (`plan_<name>_vN.md`, `discovery_<name>_vN.md`, `brainstorm_<name>_vN.md`).
 * Returns null when neither is available — the caller refuses.
 */
export function derivePlanName(sourcePath: string, explicitPlan?: string): string | null {
  if (explicitPlan !== undefined && explicitPlan.length > 0) {
    return explicitPlan;
  }
  const base = basename(sourcePath).replace(/\.md$/, '');
  const match = DERIVED_PLAN_NAME_PATTERN.exec(base);
  return match !== null ? match[1] : null;
}

/**
 * Whether a bare flow node id resolves — either an EXACT graph node id, or a
 * live (`proposed`/`accepted`) proposal's `predictedNodeId`. Mirrors the
 * ghost-resolution rules used for anchors so flow overlays and anchor chips
 * share one notion of "resolves".
 */
function flowIdResolves(item: string, graph: BlueprintGraph | null, proposals: EffectiveProposal[]): boolean {
  const { id } = parseFlowItem(item);
  if (graph !== null && graph.nodes.some((node) => node.id === id)) {
    return true;
  }
  return proposals.some(
    (proposal) => RESOLVABLE_PROPOSAL_STATES.has(proposal.state) && proposal.predictedNodeId === id,
  );
}

/**
 * Whether a `flow_before` id resolves — GRAPH ONLY, never proposals.
 *
 * `flow_before` is a claim about what exists TODAY, so a ghost id there would
 * assert that a predicted node is already real. Refusing it is what lets the
 * brief derive a REMOVAL honestly: a node present in before and in no after
 * is gone, and that conclusion is only sound if before is provably real.
 */
function flowBeforeIdResolves(item: string, graph: BlueprintGraph | null): boolean {
  const { id } = parseFlowItem(item);
  return graph !== null && graph.nodes.some((node) => node.id === id);
}

/** Input to the pure `compileStory` pass. */
export interface CompileStoryInput {
  /** Raw markdown of the source doc. */
  markdown: string;
  /** Repo-relative (or as-passed) path of the doc — stored on the story. */
  sourcePath: string;
  /** Plan/feature name the story belongs to. */
  plan: string;
  mode: StoryMode;
  /** Current derived graph, or null when no derive has run (draft-tolerant). */
  graph: BlueprintGraph | null;
  /** Effective proposals ("ghosts") the anchors/flow ids may resolve against. */
  proposals: EffectiveProposal[];
}

/** Result of a compile: a story to write, or a refusal with one+ reasons. */
export type CompileStoryResult =
  | { status: 'ok'; story: CompiledStory }
  | { status: 'refused'; reasons: string[] };

/**
 * Compile a doc's `## Story` section into a `CompiledStory`. Pure — no I/O,
 * no clock; the same inputs always yield deep-equal output.
 *
 * Refusals (nothing to write):
 * - absent `## Story` section → `no ## Story section in <doc>` (both modes)
 * - strict + null graph → `no blueprint — run planflow-ai blueprint derive first`
 * - strict + any resolution gap → ALL violations, sorted, one per reason
 *
 * Draft mode never refuses on resolution gaps: affected steps carry
 * `draft: true` and a populated `unresolvedAnchors`.
 */
export function compileStory(input: CompileStoryInput): CompileStoryResult {
  const { markdown, sourcePath, plan, mode, graph, proposals } = input;

  if (!hasStorySection(markdown)) {
    return { status: 'refused', reasons: [`no ## Story section in ${sourcePath}`] };
  }
  if (mode === 'strict' && graph === null) {
    return { status: 'refused', reasons: ['no blueprint — run planflow-ai blueprint derive first'] };
  }

  // Grammar parse lives in Wave 1's story-grammar module (imported, not
  // duplicated). Its warnings (dropped malformed items/blocks) carry through.
  const parsed = parseStorySection(markdown, sourcePath);
  const warnings = [...parsed.warnings];

  // Density cap (STORY_STEP_CAP): drop overflow steps with an EXPLICIT warning
  // naming every dropped title — never a silent truncation. Resolution then
  // runs only on the kept steps.
  let steps = parsed.steps;
  if (steps.length > STORY_STEP_CAP) {
    const dropped = steps.slice(STORY_STEP_CAP);
    warnings.push(
      `story step cap (${STORY_STEP_CAP}) exceeded — dropped ${dropped.length} step(s): ${dropped
        .map((step) => `"${step.title}"`)
        .join(', ')}`,
    );
    steps = steps.slice(0, STORY_STEP_CAP);
  }

  const violations: string[] = [];
  const compiledSteps: StoryStep[] = steps.map((step) => {
    const resolutions = resolveStoryAnchors(step.anchors, graph, proposals);
    const unresolvedAnchors = resolutions
      .filter((resolution) => !resolution.resolved)
      .map((resolution) => `${resolution.anchor.kind}:${resolution.anchor.ref}`);
    const unresolvedFlow = step.flow.filter((id) => !flowIdResolves(id, graph, proposals));
    // ASYMMETRY (the load-bearing rule): after may include ghosts, before may not.
    const unresolvedBefore = step.flowBefore.filter((id) => !flowBeforeIdResolves(id, graph));
    const badPhases = step.phases.filter((phase) => !Number.isInteger(phase) || phase < MIN_PHASE);
    const draft =
      unresolvedAnchors.length > 0 ||
      unresolvedFlow.length > 0 ||
      unresolvedBefore.length > 0 ||
      badPhases.length > 0;

    if (mode === 'strict') {
      for (const anchor of unresolvedAnchors) {
        violations.push(`unresolved anchor ${anchor} (step "${step.title}")`);
      }
      for (const id of unresolvedFlow) {
        violations.push(`unknown flow id ${id} (step "${step.title}")`);
      }
      for (const id of unresolvedBefore) {
        // Distinct message: a ghost here is not "unknown", it is a claim that
        // something predicted already exists.
        violations.push(
          `flow_before id ${id} is not in the derived graph — before describes what exists TODAY, so predicted nodes are not allowed (step "${step.title}")`,
        );
      }
      for (const phase of badPhases) {
        violations.push(`invalid phase ${phase} (step "${step.title}")`);
      }
    }

    return { ...step, unresolvedAnchors, draft };
  });

  if (mode === 'strict' && violations.length > 0) {
    return { status: 'refused', reasons: [...violations].sort() };
  }

  // The two AUTHORED slots — `unchanged` (negative space) and `fails` (how it
  // breaks, user-side) — carry most of the brief's comprehension weight and no
  // extractor can produce them. They WARN, never refuse: the discovery
  // questions that produce them are new, and a hard block would fire before
  // they have proven they reliably yield good answers. Story-level, not
  // per-step: the brief renders one band and one failure list.
  if (mode === 'strict') {
    if (!compiledSteps.some((step) => step.unchanged !== undefined)) {
      warnings.push(
        'no `unchanged:` in any step — the change brief will render without its negative-space band (what explicitly does NOT change)',
      );
    }
    if (!compiledSteps.some((step) => step.fails.length > 0)) {
      warnings.push(
        'no `fails:` in any step — the change brief will render without its failure-modes slot (how this breaks, user-side)',
      );
    }
  }

  const story: CompiledStory = { plan, sourcePath, mode, steps: compiledSteps, warnings };
  return { status: 'ok', story };
}

// ── serialization ────────────────────────────────────────

/** Serialize one anchor with a canonical, stable key order. */
function serializeAnchor(anchor: Anchor): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: anchor.kind, ref: anchor.ref };
  if (anchor.file !== undefined) {
    out.file = anchor.file;
  }
  return out;
}

/** Serialize one step with a canonical, stable key order. */
function serializeStep(step: StoryStep): Record<string, unknown> {
  const out: Record<string, unknown> = { id: step.id, title: step.title };
  if (step.kicker !== undefined) {
    out.kicker = step.kicker;
  }
  out.body = step.body;
  out.anchors = step.anchors.map(serializeAnchor);
  // `flow` stays first and unchanged so a story compiled before the change
  // brief still serializes its original key order; the explicit before/after
  // pair follows it.
  out.flow = step.flow;
  out.flowBefore = step.flowBefore;
  out.flowAfter = step.flowAfter;
  out.phases = step.phases;
  out.decisions = step.decisions;
  out.rejected = step.rejected;
  out.questions = step.questions;
  out.fails = step.fails;
  if (step.source !== undefined) {
    out.source = step.source;
  }
  if (step.unchanged !== undefined) {
    out.unchanged = step.unchanged;
  }
  out.unresolvedAnchors = step.unresolvedAnchors;
  out.draft = step.draft;
  return out;
}

/**
 * Deterministically serialize a `CompiledStory` to JSON: stable top-level and
 * per-step key order, 2-space indent, steps in source order, no timestamps.
 * Same story → byte-identical output (trailing newline included).
 */
export function serializeStory(story: CompiledStory): string {
  const out = {
    plan: story.plan,
    sourcePath: story.sourcePath,
    mode: story.mode,
    steps: story.steps.map(serializeStep),
    warnings: story.warnings,
  };
  return `${JSON.stringify(out, null, JSON_INDENT)}\n`;
}

// ── store I/O ────────────────────────────────────────────

/**
 * Atomically write the compiled story to `<structureDir>/story.json` under
 * the store's single write lock (temp file + rename, so readers never see a
 * partial file). Creates `structureDir` if missing. Throws the one-line busy
 * notice on lock contention — nothing is written; the CLI surfaces it
 * fail-soft as a refusal.
 */
export function writeCompiledStory(structureDir: string, story: CompiledStory): void {
  mkdirSync(structureDir, { recursive: true });
  const filePath = join(structureDir, STORY_FILENAME);
  const tempPath = join(structureDir, STORY_TEMP_FILENAME);
  const lockPath = join(structureDir, STORY_LOCK_FILENAME);

  if (!acquireGraphLock(lockPath)) {
    throw new Error(STORY_STORE_BUSY_NOTICE);
  }
  try {
    writeFileSync(tempPath, serializeStory(story), 'utf-8');
    renameSync(tempPath, filePath);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Sanctioned fail-soft: lock already removed (reclaimed as stale) — nothing to clean up
    }
  }
}

/**
 * Read the compiled story from `<structureDir>/story.json`. Fail-soft:
 * missing, empty, corrupt, or shape-invalid files return null — never throws.
 */
export function readCompiledStory(structureDir: string): CompiledStory | null {
  const filePath = join(structureDir, STORY_FILENAME);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (content.length === 0) {
      return null;
    }
    const parsed = JSON.parse(content) as CompiledStory;
    if (typeof parsed.plan !== 'string' || !Array.isArray(parsed.steps)) {
      return null;
    }
    // FORWARD-COMPAT NORMALIZATION. A story.json written before the change
    // brief has no flowBefore/flowAfter/fails, and consumers iterate them
    // directly. Normalizing HERE — the one place stories enter from disk —
    // keeps every consumer strict instead of making each one defensive
    // (allowed-pattern #14). `flow` is the legacy spelling of the after-state,
    // so it seeds flowAfter; before is empty, which is exactly right: a doc
    // that described one world made no claim about a previous one.
    for (const step of parsed.steps) {
      step.flowAfter ??= step.flow ?? [];
      step.flowBefore ??= [];
      step.flow ??= step.flowAfter;
      step.fails ??= [];
    }
    return parsed;
  } catch {
    // Corrupt JSON — treat as absent; a story is recompiled, never patched
    return null;
  }
}

/** What `clearCompiledStory` did — a clear happened, or it was a no-op. */
export interface ClearStoryResult {
  cleared: boolean;
}

/**
 * Delete `<structureDir>/story.json` ONLY when its `plan` field matches
 * `plan`. A missing file, an unreadable file, or a story belonging to a
 * different plan is a silent no-op. Returns what happened. Used by the
 * execute-plan archive step so a plan's story is cleared with the plan.
 */
export function clearCompiledStory(structureDir: string, plan: string): ClearStoryResult {
  const existing = readCompiledStory(structureDir);
  if (existing === null || existing.plan !== plan) {
    return { cleared: false };
  }
  try {
    unlinkSync(join(structureDir, STORY_FILENAME));
    return { cleared: true };
  } catch {
    // Sanctioned fail-soft: file vanished between read and unlink — treat as no-op
    return { cleared: false };
  }
}
