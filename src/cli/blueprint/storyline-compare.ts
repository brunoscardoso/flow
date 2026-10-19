/**
 * CODE STORY TODAY ⇄ AFTER — a plan's change, read at the level of the code
 * (plan `story-today-after` phase 1).
 *
 *   planflow-ai blueprint storyline (--file <path> | --part <ref>) --plan <name> [--base <rev>] --json
 *
 * The storyline verb (`storyline-verb.ts`) reads the story as the working tree
 * has it — that is After. With `--plan`, this module adds a `compare` to the
 * answer: what each piece went through since the plan's starting point, and
 * what the plan says will still happen. One code path computes it (allowed-
 * pattern #14); the app only renders it.
 *
 * TWO KINDS OF ANSWER, NEVER MIXED.
 *   • FACT — `pieces`, `removed`, `hunks`: Today's text (`git show <base>:<path>`)
 *     and After's text read by the same extractor, matched by piece id, and a
 *     line diff per changed piece. A renamed function honestly reads as one
 *     removed and one added — matching is by id, never by similarity.
 *   • PREDICTION — `predicted`: the plan's own words. A piece in a file a phase
 *     lists is "changes" (with the task line that names it); a function anchor
 *     (`symbol:`, from the plan's Story or its proposals) naming a piece that
 *     does not exist is "planned"; a listed file that does not exist is
 *     "planned-file". Nothing predicted is ever drawn as code — it carries no
 *     text but the task. When the real diff already marks a piece changed or
 *     added, its prediction is dropped: fact wins, and the predictions the
 *     code has not reached yet remain (FR-4).
 *   • NOTE PREDICTIONS (plan `plan_change_review`) — a plan carrying change
 *     notes predicts from its notes ONLY (no phase-file sweep, no Story
 *     anchors): `note-change` (the function's piece and its quoted lines, or
 *     `quoteMissing` — never guessed, FR-9), `note-new` (signature, purpose,
 *     callers and the callers' pieces) and `note-file`. Every note is kept
 *     whatever the diff says: a note whose code already changed carries
 *     `fact` beside its recorded verdict, so Verify shows both (FR-8, FR-20).
 *     A sibling project's note is read in that project's checkout; with none
 *     here it is `codeUnavailable` (FR-14). Plans without notes are unchanged
 *     (NFR-5).
 *
 * THE STARTING POINT IS NAMED, NEVER GUESSED (`resolveStoryBase`), in order:
 *   1. `--base <rev>` — the caller said so (`given`, or `worktree` when the app
 *      passes a thread worktree's base);
 *   2. the newest `run_intent` for this plan in `flow/.rounds.jsonl` carrying a
 *      `base` — the commit the run started from (`run`);
 *   3. HEAD, but only when the working tree differs from it for the story's
 *      files — before the plan runs, uncommitted work IS the change (`head`);
 *   4. none — After is the plan's prediction only, and `baseSource` is null.
 * A starting point that does not resolve to a commit is never replaced by a
 * guess: a given one answers with a `baseNote`; a recorded one falls to the
 * next rung.
 *
 * WHAT IS IN SCOPE. Predictions are about the story on screen: pieces of its
 * files, function anchors in its files, and planned files in the folder of
 * one of its files. Only ACTIVE plans (`flow/plans/plan_<name>_v<N>.md`, the
 * newest version) are compared — an archived plan's starting point is history.
 * The Story's `file:` anchors are context (a step names the code it talks
 * about) and are not read as intent; the phases' `**Files**:` are — or, for a
 * phase that declares none, the file paths its prose names in backticks.
 *
 * Today's text is cached by (commit, path) under
 * `flow/brain/.structure/storyline/base/` — a commit never changes, and the
 * folder is generated knowledge (`knowledge-classes.ts`, the `storyline/` row).
 * Git runs as an argv array with a timeout, never through a shell; any failure
 * is fail-soft to "no Today".
 *
 * EVERY LANGUAGE (plan `story-any-language`): Today is read by the reader After
 * was read by — passed in as `extract` — so a Python or Go story compares
 * exactly like a TypeScript one.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { parseChangeNotes, type ChangeNote } from '../state/change-notes.js';
import { parsePlanContent } from '../state/plan-parser.js';
import { readRoundsEntries } from '../state/rounds-reader.js';
import { readFileSafe, toPosixPath } from './extractors/scan.js';
import { anchorLocation } from './feature-ports.js';
import type { EffectiveProposal } from './proposal-store.js';
import { parseStorySection } from './story-grammar.js';
import type { Anchor } from './types.js';
import { hasStorylineReader } from './storyline-reader.js';
import { functionPiecesOf, noteReportOf, pieceHolding, quoteInFile, quoteInFunction } from './storyline-notes.js';
import type {
  StorylineAnswer,
  StorylineBaseSource,
  StorylineCompare,
  StorylineDiffLine,
  StorylineHunk,
  StorylineNoteFact,
  StorylineNotePrediction,
  StorylinePhasePrediction,
  StorylinePiece,
  StorylinePieceChange,
  StorylinePrediction,
  StorylineResult,
} from './storyline-types.js';
import { hashFileContent } from './store.js';

// ── Caps ─────────────────────────────────────────────────

/** Diff lines shown per changed piece; the rest is counted in `hiddenLines`. */
export const MAX_DIFF_LINES_PER_PIECE = 200;
/** Unchanged lines kept on each side of a change inside a hunk. */
export const DIFF_CONTEXT_LINES = 2;
/**
 * Above this many Today × After line pairs the LCS table is not built: the
 * piece is shown as all of Today removed and all of After added — still true,
 * just not minimal.
 */
export const MAX_DIFF_CELLS = 4_000_000;
/** How long one git call may take before it counts as "no answer". */
export const GIT_TIMEOUT_MS = 10_000;
/** The largest file text `git show` may hand back. */
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Today's texts, under the storyline cache folder. */
export const BASE_CACHE_DIRNAME = 'base';

/** A plan name is a slug — anything else names no plan file. */
const PLAN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAN_FILE_PATTERN = /^plan_(.+)_v(\d+)\.md$/;
const PHASE_HEADING_PATTERN = /^#{2,4}\s*Phase\s+(\d+)\b/i;
const FILES_FIELD_PATTERN = /^\s*\*\*Files:?\*\*/i;
const FIELD_OR_BREAK_PATTERN = /^(?:#{1,6}\s|---\s*$|\*\*[A-Za-z])/;
const BACKTICK_PATTERN = /`([^`]+)`/g;
const CONCRETE_FILE_PATTERN = /^[^\s*]+\/[^\s*/]+\.[A-Za-z0-9]+$/;
/** Proposal states whose anchors no longer speak for the plan. */
const RETIRED_PROPOSAL_STATES = new Set(['rejected', 'stale', 'cleared']);

// ── The plan's intent ────────────────────────────────────

export interface PlanIntentPhase {
  number: number;
  name: string;
  /** Task lines, in order. */
  tasks: string[];
  /** Project-relative files the phase touches. */
  files: string[];
}

/** A function the plan names: `symbol:src/a.ts#run` (or `file:src/a.ts:run`). */
export interface PlanSymbolAnchor {
  file?: string;
  symbol: string;
  phases: number[];
}

export interface PlanIntent {
  name: string;
  phases: PlanIntentPhase[];
  symbols: PlanSymbolAnchor[];
  /**
   * The plan's readable change notes, in plan order. When there are any, they
   * are the plan's whole prediction — phases' files and Story anchors are not
   * read as intent (old plans, which carry none, predict exactly as before).
   */
  notes: ChangeNote[];
}

/** An active plan, found by name. */
export interface FoundPlan {
  name: string;
  path: string;
  content: string;
}

/**
 * The newest version of an active plan: `flow/plans/plan_<name>_v<N>.md`.
 * Accepts the slug, or the file's own name (`plan_x_v2.md`). Null when no such
 * plan is active — archived plans are not looked for.
 */
export function findActivePlan(flowDir: string, requested: string): FoundPlan | null {
  const name = planSlugOf(requested);
  if (name === null) return null;
  const plansDir = join(flowDir, 'plans');
  let entries: string[];
  try {
    entries = readdirSync(plansDir);
  } catch {
    // No plans folder: no active plan by any name.
    return null;
  }
  let best: { version: number; file: string } | null = null;
  for (const entry of entries) {
    const match = PLAN_FILE_PATTERN.exec(entry);
    if (match === null || match[1] !== name) continue;
    const version = Number.parseInt(match[2] ?? '', 10);
    if (best === null || version > best.version) best = { version, file: entry };
  }
  if (best === null) return null;
  const path = join(plansDir, best.file);
  const content = readFileSafe(path);
  return content === null ? null : { name, path, content };
}

function planSlugOf(requested: string): string | null {
  let name = basename(requested.trim()).replace(/\.md$/, '');
  const fileShape = /^plan_(.+)_v\d+$/.exec(name);
  if (fileShape !== null) name = fileShape[1] ?? '';
  return PLAN_NAME_PATTERN.test(name) ? name : null;
}

/** What a plan says it will touch: its phases' files and tasks, and its function anchors. */
export function readPlanIntent(name: string, content: string, proposals: readonly EffectiveProposal[]): PlanIntent {
  const parsedNotes = parseChangeNotes(content);
  const filesByPhase = phaseFiles(content, parsedNotes.blocks);
  const phases: PlanIntentPhase[] = parsePlanContent(content).map((phase) => ({
    number: phase.number,
    name: phase.name,
    tasks: phase.tasks.map((task) => task.name),
    files: filesByPhase.get(phase.number) ?? [],
  }));

  const symbols: PlanSymbolAnchor[] = [];
  const addSymbol = (anchor: Anchor, phaseNumbers: readonly number[]): void => {
    const location = anchorLocation(anchor.kind, anchor.ref);
    if (location.symbol === undefined) return;
    const rawFile = location.file ?? anchor.file;
    const file = rawFile === undefined ? undefined : normalizeRel(rawFile);
    symbols.push({ ...(file === undefined ? {} : { file }), symbol: location.symbol, phases: [...phaseNumbers] });
  };
  for (const step of parseStorySection(content, `plan_${name}`).steps) {
    for (const anchor of step.anchors) addSymbol(anchor, step.phases);
  }
  for (const proposal of proposals) {
    if (RETIRED_PROPOSAL_STATES.has(proposal.state)) continue;
    const phaseNumbers = proposal.phase === undefined ? [] : [proposal.phase];
    for (const anchor of proposal.anchors) addSymbol(anchor, phaseNumbers);
  }
  return { name, phases, symbols, notes: parsedNotes.notes };
}

/**
 * Each phase's files: its `**Files**:` field (both bold variants, inline or a
 * bulleted list) — or, for a phase that declares none, the backticked paths its
 * prose names. A prose mention counts only when it is written as a PATH to a
 * file (a separator and an extension), so a basename in a sentence is not a
 * declaration. Lines inside a `#### Change notes` block are not prose: a
 * note's backticked quote or signature is code, never a file the phase lists.
 */
function phaseFiles(content: string, noteBlocks: ReadonlyArray<{ startLine: number; endLine: number }>): Map<number, string[]> {
  const inNoteBlock = (lineNo: number): boolean =>
    noteBlocks.some((block) => lineNo >= block.startLine && lineNo <= block.endLine);
  const declared = new Map<number, string[]>();
  const mentioned = new Map<number, string[]>();
  let phase: number | null = null;
  let inFiles = false;
  const push = (map: Map<number, string[]>, line: string): void => {
    if (phase === null) return;
    const list = map.get(phase) ?? [];
    for (const token of line.matchAll(BACKTICK_PATTERN)) {
      const path = normalizeRel(token[1] ?? '');
      if (CONCRETE_FILE_PATTERN.test(path) && !list.includes(path)) list.push(path);
    }
    map.set(phase, list);
  };
  for (const [index, line] of content.split('\n').entries()) {
    if (inNoteBlock(index + 1)) {
      inFiles = false;
      continue;
    }
    const heading = PHASE_HEADING_PATTERN.exec(line);
    if (heading !== null) {
      phase = Number.parseInt(heading[1] ?? '', 10);
      inFiles = false;
      continue;
    }
    if (/^##\s/.test(line)) {
      phase = null;
      inFiles = false;
      continue;
    }
    if (phase === null) continue;
    push(mentioned, line);
    if (FILES_FIELD_PATTERN.test(line)) {
      inFiles = true;
      push(declared, line);
      continue;
    }
    if (!inFiles) continue;
    const trimmed = line.trim();
    if (trimmed === '' || FIELD_OR_BREAK_PATTERN.test(trimmed)) {
      inFiles = false;
      continue;
    }
    push(declared, line);
  }
  const files = new Map<number, string[]>();
  for (const [number, list] of mentioned) {
    const own = declared.get(number) ?? [];
    files.set(number, own.length > 0 ? own : list);
  }
  return files;
}

// ── The starting point ───────────────────────────────────

export interface StoryBase {
  base: string | null;
  source: StorylineBaseSource | null;
  note?: string;
}

export interface ResolveStoryBaseInput {
  repoRoot: string;
  flowDir: string;
  plan: string;
  /** `--base <rev>`, when the caller named one. */
  given?: string;
  /** What a given base is: `given` (default) or a thread worktree's base. */
  givenSource?: 'given' | 'worktree';
  /** The story's files — HEAD is the starting point only when they differ from it. */
  files: readonly string[];
}

/** The plan's starting point — named, never guessed (see the header). */
export function resolveStoryBase(input: ResolveStoryBaseInput): StoryBase {
  const given = typeof input.given === 'string' ? input.given.trim() : '';
  if (given !== '') {
    const sha = resolveCommit(input.repoRoot, given);
    if (sha !== null) return { base: sha, source: input.givenSource ?? 'given' };
    return {
      base: null,
      source: null,
      note: `Flow couldn't find the starting point ${given} in this project's history, so After shows the plan's prediction only.`,
    };
  }
  const recorded = recordedRunBase(input.flowDir, input.plan);
  if (recorded !== null) {
    const sha = resolveCommit(input.repoRoot, recorded);
    if (sha !== null) return { base: sha, source: 'run' };
  }
  const head = resolveCommit(input.repoRoot, 'HEAD');
  if (head !== null && input.files.length > 0 && workingTreeDiffers(input.repoRoot, input.files)) {
    return { base: head, source: 'head' };
  }
  return { base: null, source: null };
}

/** The `base` of the newest `run_intent` recorded for this plan, or null. */
function recordedRunBase(flowDir: string, plan: string): string | null {
  let base: string | null = null;
  for (const entry of readRoundsEntries(flowDir)) {
    if (entry.type !== 'run_intent' || entry.plan !== plan) continue;
    const value = entry['base'];
    // Append order is time order: the last one standing is the newest run.
    if (typeof value === 'string' && value.trim() !== '') base = value.trim();
  }
  return base;
}

function resolveCommit(repoRoot: string, rev: string): string | null {
  // A rev starting with `-` would be read as an option: never a commit name.
  if (rev.startsWith('-')) return null;
  const result = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  if (result === null) return null;
  const sha = result.trim();
  return sha === '' ? null : sha;
}

function workingTreeDiffers(repoRoot: string, files: readonly string[]): boolean {
  const status = runGit(repoRoot, ['status', '--porcelain', '--untracked-files=all', '--', ...files]);
  return status !== null && status.trim() !== '';
}

/**
 * Today's text of one file, read from the starting commit and cached by
 * (commit, path). Null when the file did not exist there — or git could not
 * say, which reads the same and is never cached.
 */
export function makeBaseTextReader(repoRoot: string, base: string, cacheDir: string | null): (path: string) => string | null {
  return (path: string): string | null => {
    const cachePath = cacheDir === null ? null : join(cacheDir, BASE_CACHE_DIRNAME, `${hashFileContent(`${base}\0${path}`)}.json`);
    const cached = cachePath === null ? null : readCachedBaseText(cachePath, base, path);
    if (cached !== null) return cached;
    const text = runGit(repoRoot, ['show', `${base}:./${path}`]);
    if (text !== null && cachePath !== null) {
      try {
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ base, path, text }), 'utf-8');
      } catch {
        // Fail-soft: an unwritable cache costs the next read a `git show`.
      }
    }
    return text;
  };
}

function readCachedBaseText(cachePath: string, base: string, path: string): string | null {
  const raw = readFileSafe(cachePath);
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw) as { base?: unknown; path?: unknown; text?: unknown };
    if (record.base !== base || record.path !== path || typeof record.text !== 'string') return null;
    return record.text;
  } catch {
    // A corrupt entry is re-read from git and rewritten — it is only a cache.
    return null;
  }
}

/**
 * One git call: argv, no shell, a timeout. Its stdout, or null on any failure.
 * `execFileSync`, like `corpus-index.ts`, so suites that mock `child_process`
 * for the blueprint command keep one shape of mock.
 */
function runGit(cwd: string, args: readonly string[]): string | null {
  if (!existsSync(cwd)) return null;
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch {
    // Not a repository, an unknown rev, a path absent at that commit, a
    // timeout: each one is "git could not say", and the caller has a rung for it.
    return null;
  }
}

// ── The comparison ───────────────────────────────────────

export interface CompareStorylineInput {
  /** The story as the working tree has it — After. */
  result: StorylineResult;
  plan: PlanIntent;
  base: StoryBase;
  /** Today's text of a story file at `base.base`, or null when it did not exist. */
  readBaseText: (path: string) => string | null;
  /**
   * Read Today's text of a story file with the SAME reader After was read with
   * (`StorylineReaders.extract` — the compiler for TS/JS, tree-sitter for every
   * other language), so the two sides are matched piece id for piece id.
   */
  extract: (file: string, text: string) => StorylineAnswer;
  /** Whether a project-relative file exists in the working tree. */
  fileExists: (relPath: string) => boolean;
  /**
   * After's text of a story file (a sibling project's spelled `<project>/<path>`)
   * — where a change note's quote is looked for. Absent: no quote is found.
   */
  readText?: (storyFile: string) => string | null;
  /**
   * Where a change note's code is on the story. Absent: a note in this
   * project is its own path, and a sibling project's has no code here.
   */
  noteLocation?: (note: ChangeNote) => NoteLocation;
  /** Story files from another checkout — the starting point is not theirs, so they get no facts. */
  foreignFiles?: ReadonlySet<string>;
  /**
   * Every piece id After has in a story file, when the story carries only
   * some of them (a plan's story draws the noted functions of a file, not the
   * file). A piece of Today's text is `removed` only when After's WHOLE file
   * lacks it — a piece merely left undrawn is not a removal. Absent: the
   * story's own pieces are the file's.
   */
  afterPieceIds?: (file: string) => ReadonlySet<string> | undefined;
}

/** Where a note's code is: a story file (and whether it exists in its project), or nowhere on this machine. */
export type NoteLocation = { storyFile: string; exists: boolean } | { codeUnavailable: true };

export function compareStoryline(input: CompareStorylineInput): StorylineCompare {
  const { result, plan, base } = input;
  const pieces: Record<string, StorylinePieceChange> = {};
  const removed: StorylinePiece[] = [];
  const hunks: Record<string, StorylineHunk[]> = {};
  const hiddenLines: Record<string, number> = {};
  const unreadable: string[] = [];

  const foreign = input.foreignFiles ?? new Set<string>();
  if (base.base !== null) {
    for (const file of result.files) {
      if (foreign.has(file)) continue;
      const todayText = input.readBaseText(file);
      const afterPieces = result.pieces.filter((piece) => piece.file === file);
      if (todayText === null) {
        for (const piece of afterPieces) pieces[piece.id] = 'added';
        continue;
      }
      const today = input.extract(file, todayText);
      if (!today.ok) {
        unreadable.push(file);
        continue;
      }
      const todayById = new Map(today.pieces.map((piece) => [piece.id, piece]));
      const afterIds = input.afterPieceIds?.(file) ?? new Set(afterPieces.map((piece) => piece.id));
      for (const piece of afterPieces) {
        const before = todayById.get(piece.id);
        if (before === undefined) {
          pieces[piece.id] = 'added';
          continue;
        }
        if (before.text === piece.text) {
          pieces[piece.id] = 'same';
          continue;
        }
        pieces[piece.id] = 'changed';
        const diff = pieceHunks(before, piece);
        hunks[piece.id] = diff.hunks;
        if (diff.hidden > 0) hiddenLines[piece.id] = diff.hidden;
      }
      for (const piece of today.pieces) {
        if (afterIds.has(piece.id)) continue;
        pieces[piece.id] = 'removed';
        removed.push(piece);
      }
    }
  }

  const predicted: StorylinePrediction[] =
    plan.notes.length > 0
      ? predictFromNotes(result, plan.notes, base.base === null ? null : pieces, input)
      : predict(result, plan, input.fileExists).filter((prediction) => {
          if (prediction.pieceId === undefined) return true;
          const fact = pieces[prediction.pieceId];
          // FACT WINS: what the code already shows is not predicted again.
          return fact !== 'changed' && fact !== 'added';
        });

  const counts = { changed: 0, added: 0, removed: 0 };
  for (const change of Object.values(pieces)) {
    if (change !== 'same') counts[change] += 1;
  }
  return {
    plan: plan.name,
    base: base.base,
    baseSource: base.source,
    ...(base.note === undefined ? {} : { baseNote: base.note }),
    pieces,
    removed,
    hunks,
    hiddenLines,
    unreadable,
    predicted,
    summary: {
      ...counts,
      predicted: predicted.filter((prediction) => prediction.kind === 'changes' || prediction.kind === 'note-change').length,
      planned: predicted.filter((prediction) => prediction.kind !== 'changes' && prediction.kind !== 'note-change').length,
    },
  };
}

// ── Prediction ───────────────────────────────────────────

/**
 * A plan with change notes: one prediction per note, in plan order. Fact does
 * not win here — a note whose function the real diff already changed keeps
 * its prediction and carries the `fact`, so Verify shows the diff and the
 * verdict side by side.
 */
function predictFromNotes(
  result: StorylineResult,
  notes: readonly ChangeNote[],
  facts: Readonly<Record<string, StorylinePieceChange>> | null,
  input: CompareStorylineInput,
): StorylineNotePrediction[] {
  const foreign = input.foreignFiles ?? new Set<string>();
  const locate = input.noteLocation ?? ((note: ChangeNote): NoteLocation =>
    note.target.project === undefined
      ? { storyFile: note.target.file, exists: input.fileExists(note.target.file) }
      : { codeUnavailable: true });
  const factOf = (storyFile: string, ids: readonly string[]): StorylineNoteFact | undefined =>
    facts === null || foreign.has(storyFile) ? undefined : noteFact(ids.map((id) => facts[id]));

  return notes.map((note): StorylineNotePrediction => {
    const location = locate(note);
    const project = note.target.project;
    const common = {
      file: 'storyFile' in location ? location.storyFile : project === undefined ? note.target.file : `${project}/${note.target.file}`,
      note: noteReportOf(note),
      ...(project === undefined ? {} : { project }),
      ...('codeUnavailable' in location ? { codeUnavailable: true as const } : {}),
      ...('storyFile' in location && !location.exists ? { fileMissing: true as const } : {}),
    };
    const symbol = note.target.symbol ?? '';

    if (note.kind === 'file') {
      if (!('storyFile' in location)) return { kind: 'note-file', ...common };
      const prefix = `${location.storyFile}#`;
      const ids = facts === null ? [] : Object.keys(facts).filter((id) => id.startsWith(prefix));
      const fact = factOf(location.storyFile, ids);
      // A FILE NOTE MAY QUOTE ITS PLACE: found in the whole file, it marks the
      // piece that holds it (the plan story adds a few lines when none does).
      const where = note.where ?? '';
      const text = where === '' ? null : (input.readText?.(location.storyFile) ?? null);
      const quote = text === null ? null : quoteInFile(text, where);
      let quoted = {};
      if (quote?.found === 'once') {
        const holder = pieceHolding(result.pieces, location.storyFile, quote.startLine);
        quoted = { ...(holder === null ? {} : { pieceId: holder.id }), quoteLines: { startLine: quote.startLine, endLine: quote.endLine } };
      } else if (where !== '' && text !== null) {
        quoted = { quoteMissing: true as const, ...(quote?.found === 'many' ? { quoteCount: quote.count } : {}) };
      }
      return { kind: 'note-file', ...common, ...quoted, ...(fact === undefined ? {} : { fact }) };
    }

    if (note.kind === 'new') {
      const callers = note.callers ?? [];
      const signature = note.signature ?? '';
      const purpose = note.purpose ?? '';
      if (!('storyFile' in location)) {
        return { kind: 'note-new', ...common, symbol, signature, purpose, callers, callerPieces: {} };
      }
      const own = functionPiecesOf(result.pieces, location.storyFile, symbol);
      const fact = factOf(location.storyFile, own.map((piece) => piece.id));
      return {
        kind: 'note-new',
        ...common,
        ...(own[0] === undefined ? {} : { pieceId: own[0].id }),
        symbol,
        signature,
        purpose,
        callers,
        callerPieces: callerPiecesOf(result.pieces, callers, location.storyFile, project),
        ...(fact === undefined ? {} : { fact }),
      };
    }

    // A change to an existing function.
    if (!('storyFile' in location)) return { kind: 'note-change', ...common, symbol };
    const own = functionPiecesOf(result.pieces, location.storyFile, symbol);
    if (own.length === 0) {
      // Not on the story — maybe the real diff removed it.
      const fact = factOf(location.storyFile, [`${location.storyFile}#${symbol}`]);
      return { kind: 'note-change', ...common, symbol, pieceMissing: true, quoteMissing: true, ...(fact === undefined ? {} : { fact }) };
    }
    const fact = factOf(location.storyFile, own.map((piece) => piece.id));
    const text = input.readText?.(location.storyFile) ?? null;
    const quote = text === null ? null : quoteInFunction(text, own, note.where ?? '');
    const quoted =
      quote?.found === 'once'
        ? { quoteLines: { startLine: quote.startLine, endLine: quote.endLine } }
        : { quoteMissing: true as const, ...(quote?.found === 'many' ? { quoteCount: quote.count } : {}) };
    return {
      kind: 'note-change',
      ...common,
      pieceId: (own[0] as StorylinePiece).id,
      symbol,
      ...quoted,
      ...(fact === undefined ? {} : { fact }),
    };
  });
}

/** What the real diff says about a function (all its overloads) or a file (all its pieces). */
function noteFact(changes: ReadonlyArray<StorylinePieceChange | undefined>): StorylineNoteFact | undefined {
  const known = changes.filter((change): change is StorylinePieceChange => change !== undefined);
  if (known.length === 0) return undefined;
  if (known.every((change) => change === 'same')) return 'unchanged';
  if (known.every((change) => change === 'added')) return 'added';
  if (known.every((change) => change === 'removed')) return 'removed';
  return 'changed';
}

/** A caller as a note writes it: `name`, `Class.method` (`Class.#method`), or `<path>:<name>` / `file:<path>:<name>`. */
export function parseCaller(caller: string): { file?: string; symbol: string } {
  // A segment may be `#private`, as a note's own symbol may (`SYMBOL_RE` in change-notes.ts).
  const match = /^(?:file:)?([^\s:]+\.[A-Za-z0-9]+):(#?[A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)*)$/.exec(caller.trim());
  if (match !== null) return { file: normalizeRel(match[1] ?? ''), symbol: match[2] ?? '' };
  return { symbol: caller.trim() };
}

/**
 * Each caller's piece on the story: one named by path is looked for there; a
 * bare name in the note's own file first, else the one story piece of that
 * name. Two candidates and none in the note's file is a guess — left out.
 */
function callerPiecesOf(
  pieces: readonly StorylinePiece[],
  callers: readonly string[],
  noteFile: string,
  project: string | undefined,
): Record<string, string> {
  const found: Record<string, string> = {};
  for (const caller of callers) {
    const parsed = parseCaller(caller);
    const named = pieces.filter((piece) => namesPiece(parsed.symbol, piece));
    let candidates: StorylinePiece[];
    if (parsed.file !== undefined) {
      const file = project === undefined ? parsed.file : `${project}/${parsed.file}`;
      candidates = named.filter((piece) => piece.file === file);
    } else {
      const local = named.filter((piece) => piece.file === noteFile);
      candidates = local.length > 0 ? local : named;
    }
    const [only] = candidates;
    if (candidates.length === 1 && only !== undefined) found[caller] = only.id;
  }
  return found;
}

/** Everything the plan says about this story, before any fact is applied. */
function predict(result: StorylineResult, plan: PlanIntent, fileExists: (relPath: string) => boolean): StorylinePhasePrediction[] {
  const storyFiles = new Set(result.files);
  const storyDirs = new Set(result.files.map((file) => posix.dirname(file)));
  const byPiece = new Map<string, StorylinePhasePrediction>();
  const planned = new Map<string, StorylinePhasePrediction>();
  const phases = [...plan.phases].sort((a, b) => a.number - b.number);

  // Files a phase lists: every piece in them changes; a missing one is planned.
  for (const phase of phases) {
    for (const file of phase.files) {
      if (storyFiles.has(file)) {
        for (const piece of result.pieces) {
          if (piece.file !== file || byPiece.has(piece.id)) continue;
          byPiece.set(piece.id, {
            pieceId: piece.id,
            file,
            symbol: qualifiedName(piece),
            phase: phase.number,
            task: taskFor(phase, [qualifiedName(piece), piece.name], file),
            kind: 'changes',
          });
        }
        continue;
      }
      const key = `file\0${file}`;
      if (planned.has(key) || !inStoryFolder(file, storyDirs) || fileExists(file)) continue;
      planned.set(key, { file, phase: phase.number, task: taskFor(phase, [], file), kind: 'planned-file' });
    }
  }

  // Function anchors: a named piece changes (said more precisely than its
  // file); a name with no piece is planned.
  for (const anchor of plan.symbols) {
    const phase = phaseOfAnchor(phases, anchor);
    const matches = result.pieces.filter(
      (piece) => (anchor.file === undefined || piece.file === anchor.file) && namesPiece(anchor.symbol, piece),
    );
    if (matches.length > 0) {
      for (const piece of matches) {
        byPiece.set(piece.id, {
          pieceId: piece.id,
          file: piece.file,
          symbol: qualifiedName(piece),
          phase: phase?.number ?? null,
          task: phase === null ? '' : taskFor(phase, [anchor.symbol, piece.name], piece.file),
          kind: 'changes',
        });
      }
      continue;
    }
    const file = anchor.file;
    if (file === undefined) continue; // A bare name with no piece has nowhere to stand.
    const inStory = storyFiles.has(file) || (inStoryFolder(file, storyDirs) && !fileExists(file));
    if (!inStory) continue;
    const key = `symbol\0${file}\0${anchor.symbol}`;
    if (planned.has(key)) continue;
    planned.set(key, {
      file,
      symbol: anchor.symbol,
      phase: phase?.number ?? null,
      task: phase === null ? '' : taskFor(phase, [anchor.symbol], file),
      kind: 'planned',
    });
  }

  const order = new Map(result.pieces.map((piece, position) => [piece.id, position]));
  const changes = [...byPiece.values()].sort((a, b) => (order.get(a.pieceId ?? '') ?? 0) - (order.get(b.pieceId ?? '') ?? 0));
  return [...changes, ...planned.values()];
}

/** A planned file belongs to the story when it sits in the folder of one of the story's files. */
function inStoryFolder(file: string, storyDirs: ReadonlySet<string>): boolean {
  return hasStorylineReader(file) && storyDirs.has(posix.dirname(file));
}

function qualifiedName(piece: StorylinePiece): string {
  return piece.className === undefined ? piece.name : `${piece.className}.${piece.name}`;
}

function namesPiece(symbol: string, piece: StorylinePiece): boolean {
  return symbol === piece.name || symbol === qualifiedName(piece);
}

/**
 * The phase an anchor speaks for: the first phase it names; else the first
 * phase listing its file; else the first phase whose task names the symbol.
 */
function phaseOfAnchor(phases: readonly PlanIntentPhase[], anchor: PlanSymbolAnchor): PlanIntentPhase | null {
  for (const number of anchor.phases) {
    const named = phases.find((phase) => phase.number === number);
    if (named !== undefined) return named;
  }
  const file = anchor.file;
  if (file !== undefined) {
    const listing = phases.find((phase) => phase.files.includes(file));
    if (listing !== undefined) return listing;
  }
  return phases.find((phase) => phase.tasks.some((task) => mentionsWord(task, anchor.symbol))) ?? null;
}

/** The task line that names the symbol, else the file, else the phase's first task (else its title). */
function taskFor(phase: PlanIntentPhase, symbols: readonly string[], file: string): string {
  for (const symbol of symbols) {
    const named = phase.tasks.find((task) => mentionsWord(task, symbol));
    if (named !== undefined) return named;
  }
  const naming = phase.tasks.find((task) => task.includes(file) || mentionsWord(task, posix.basename(file)));
  return naming ?? phase.tasks[0] ?? phase.name;
}

function mentionsWord(text: string, word: string): boolean {
  if (word === '') return false;
  return new RegExp(`(?<![\\w$.])${escapeRegExp(word)}(?![\\w$])`).test(text);
}

// ── Line diff ────────────────────────────────────────────

interface PieceDiff {
  hunks: StorylineHunk[];
  /** Diff lines left out past `MAX_DIFF_LINES_PER_PIECE`. */
  hidden: number;
}

function pieceHunks(today: StorylinePiece, after: StorylinePiece): PieceDiff {
  return toHunks(diffLines(splitLines(today.text), splitLines(after.text)), today.startLine, after.startLine);
}

interface DiffOp extends StorylineDiffLine {
  /** 0-based index on each side (the side's next line, for an op that is not on it). */
  todayIndex: number;
  afterIndex: number;
}

/** A minimal line diff (longest common subsequence) of Today's lines against After's. */
export function diffLines(today: readonly string[], after: readonly string[]): DiffOp[] {
  const rows = today.length;
  const columns = after.length;
  if ((rows + 1) * (columns + 1) > MAX_DIFF_CELLS) {
    return [
      ...today.map((text, index) => ({ op: 'removed' as const, text, todayIndex: index, afterIndex: 0 })),
      ...after.map((text, index) => ({ op: 'added' as const, text, todayIndex: rows, afterIndex: index })),
    ];
  }
  // lcs[i][j] = longest common subsequence of today[i..] and after[j..].
  const width = columns + 1;
  const lcs = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        today[i] === after[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (today[i] === after[j]) {
      ops.push({ op: 'context', text: today[i] ?? '', todayIndex: i, afterIndex: j });
      i += 1;
      j += 1;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      ops.push({ op: 'removed', text: today[i] ?? '', todayIndex: i, afterIndex: j });
      i += 1;
    } else {
      ops.push({ op: 'added', text: after[j] ?? '', todayIndex: i, afterIndex: j });
      j += 1;
    }
  }
  for (; i < rows; i += 1) ops.push({ op: 'removed', text: today[i] ?? '', todayIndex: i, afterIndex: j });
  for (; j < columns; j += 1) ops.push({ op: 'added', text: after[j] ?? '', todayIndex: i, afterIndex: j });
  return ops;
}

/**
 * Group a diff into hunks: each change with `DIFF_CONTEXT_LINES` of context on
 * either side, nearby changes merged. Lines past `MAX_DIFF_LINES_PER_PIECE` are
 * counted, not shown.
 */
export function toHunks(ops: readonly DiffOp[], todayStartLine: number, afterStartLine: number): PieceDiff {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.op === 'context') return;
    const from = Math.max(0, index - DIFF_CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + DIFF_CONTEXT_LINES);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  });

  const hunks: StorylineHunk[] = [];
  let shown = 0;
  let hidden = 0;
  let current: StorylineHunk | null = null;
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index];
    if (op === undefined || !keep[index]) {
      current = null;
      continue;
    }
    if (shown >= MAX_DIFF_LINES_PER_PIECE) {
      hidden += 1;
      continue;
    }
    if (current === null) {
      current = { todayStart: todayStartLine + op.todayIndex, afterStart: afterStartLine + op.afterIndex, lines: [] };
      hunks.push(current);
    }
    current.lines.push({ op: op.op, text: op.text });
    shown += 1;
  }
  return { hunks, hidden };
}

// ── Helpers ──────────────────────────────────────────────

function splitLines(text: string): string[] {
  return text.split('\n');
}

function normalizeRel(path: string): string {
  return toPosixPath(path.trim()).replace(/^\.\//, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
