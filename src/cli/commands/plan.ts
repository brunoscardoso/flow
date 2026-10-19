/**
 * Plan CLI commands — `planflow-ai plan compile <plan>` and
 * `planflow-ai plan archive <plan>`.
 *
 * `compile` compiles a plan into its deterministic run-script artifact
 * (`flow/plans/<plan>.run.json`) via the pure compiler
 * (`state/run-compiler.ts`) and the mediated store
 * (`state/run-script-store.ts`). Recompiles recover the preserved
 * `overrides` block from the previous artifact — an unreadable artifact
 * means starting fresh with empty overrides, never patching.
 *
 * `archive` is the production caller of the store's `archiveRunScript`
 * operation: it moves BOTH `<plan>.run.json` and its rotated
 * `<plan>.run.prev.json` into `flow/archive/` through one code path, so the
 * execute-plan archive step never depends on an agent typing two paths into
 * an `mv` (allowed-pattern #14 — invariants live in one code path).
 *
 * `<plan>` is either a plan NAME (e.g. `compiled-run-scripts`, resolved by
 * globbing `flow/plans/plan_<name>_v*.md` and picking the highest version)
 * or a direct path to a plan `.md` file. `archive` additionally accepts a
 * name whose plan doc has already moved — the artifacts are keyed by name,
 * not by the doc still being in `flow/plans/`.
 *
 * Failure contract: an unresolvable/unreadable plan, a compile refusal
 * (dependency cycle), or a busy store prints ONE `compile refused: <reason>`
 * line via the repo logger (which routes through console.log —
 * allowed-pattern #15) and exits 1, writing NOTHING. `archive` uses the same
 * shape with an `archive refused:` prefix.
 */

import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { error as logError } from '../utils/logger.js';
import { compileRunScript } from '../state/run-compiler.js';
import { parseFlowConfig } from '../state/flowconfig-parser.js';
import {
  archiveRunScript,
  readRunScript,
  runScriptPath,
  runScriptPrevPath,
  writeRunScript,
} from '../state/run-script-store.js';
import { readRoundsEntries } from '../state/rounds-reader.js';
import { evaluateResume, type ResumeStatus } from '../state/resume-evaluator.js';
import type { RunScript } from '../state/types.js';
import { whyNoPhases } from '../state/plan-parser.js';
import { archiveRounds, summarizeArchivedRounds } from '../state/rounds-summary.js';
import { locateWorkspaceProject } from '../handlers/workspace-locate.js';
import {
  countNotes,
  isNoteStatus,
  isNoteVerdict,
  NOTE_STATUSES,
  NOTE_VERDICTS,
  parseChangeNotes,
  setNoteStatus,
  setNoteVerdict,
  type NoteCounts,
  type UnreadableNote,
} from '../state/change-notes.js';
import { findActivePlan, type FoundPlan } from '../blueprint/storyline-compare.js';
import { StorylineReaders } from '../blueprint/storyline-reader.js';
import { noteCheckoutRoot, noteProjectsOf, noteReportOf, resolveNoteQuote } from '../blueprint/storyline-notes.js';
import type { NoteQuote, StorylineNote } from '../blueprint/storyline-types.js';

/** Prefix every compile failure line carries — never doubled. */
const COMPILE_REFUSED_PREFIX = 'compile refused:';
/** Prefix every archive failure line carries — never doubled. */
const ARCHIVE_REFUSED_PREFIX = 'archive refused:';
/** Directory (under `flow/`) archived plans and their artifacts move into. */
const ARCHIVE_DIRNAME = 'archive';
/** Short planHash prefix length shown in the report header. */
const PLAN_HASH_PREFIX_LENGTH = 12;
/** Plans directory (under `flow/`) where plan markdown files live. */
const PLANS_DIRNAME = 'plans';
/** `plan_<name>_v<version>.md` — extracts the bare plan name from a filename. */
const PLAN_FILENAME_PATTERN = /^plan_(.+?)(?:_v\d+)?\.md$/;

/** A resolved plan source: the markdown file plus its bare plan name. */
interface ResolvedPlan {
  /** Path of the plan markdown file (as read from disk). */
  filePath: string;
  /** Path shown in the report — relative `flow/plans/...` when resolved by name. */
  displayPath: string;
  /** Bare plan name the run-script store keys artifacts by. */
  planName: string;
}

/** Escape a plan name for embedding in the version-glob regex. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize any thrown error into a single `compile refused: <reason>` line.
 * Errors already carrying the prefix (the compiler's cycle refusal) pass
 * through untouched — never double-prefixed.
 */
function toRefusalLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(COMPILE_REFUSED_PREFIX)) {
    return message;
  }
  return `${COMPILE_REFUSED_PREFIX} ${message}`;
}

/**
 * Normalize any thrown error into a single `archive refused: <reason>` line.
 * Errors already carrying the prefix pass through untouched.
 */
function toArchiveRefusalLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(ARCHIVE_REFUSED_PREFIX)) {
    return message;
  }
  return `${ARCHIVE_REFUSED_PREFIX} ${message}`;
}

/** Bare plan name from a plan filename, falling back to the basename sans `.md`. */
function planNameFromFilename(fileName: string): string {
  const match = PLAN_FILENAME_PATTERN.exec(fileName);
  if (match !== null) {
    return match[1];
  }
  return fileName.replace(/\.md$/, '');
}

/**
 * Resolve the `<plan>` argument to a plan markdown file. A value ending in
 * `.md` is treated as a direct path; anything else is a plan name resolved
 * by globbing `flow/plans/plan_<name>_v*.md` and picking the highest
 * version. Throws a `compile refused:` error when nothing resolves.
 */
function resolvePlanFile(targetDir: string, planArg: string): ResolvedPlan {
  if (planArg.endsWith('.md')) {
    if (!existsSync(planArg)) {
      throw new Error(`${COMPILE_REFUSED_PREFIX} plan file not found: ${planArg}`);
    }
    return {
      filePath: planArg,
      displayPath: planArg,
      planName: planNameFromFilename(basename(planArg)),
    };
  }

  const plansDir = join(targetDir, 'flow', PLANS_DIRNAME);
  if (!existsSync(plansDir)) {
    throw new Error(
      `${COMPILE_REFUSED_PREFIX} no plan found for "${planArg}" (missing ${join('flow', PLANS_DIRNAME)} directory)`,
    );
  }

  const versionPattern = new RegExp(`^plan_${escapeRegExp(planArg)}_v(\\d+)\\.md$`);
  let bestFileName: string | null = null;
  let bestVersion = -1;
  for (const fileName of readdirSync(plansDir)) {
    const match = versionPattern.exec(fileName);
    if (match === null) {
      continue;
    }
    const version = parseInt(match[1], 10);
    if (version > bestVersion) {
      bestVersion = version;
      bestFileName = fileName;
    }
  }

  if (bestFileName === null) {
    throw new Error(
      `${COMPILE_REFUSED_PREFIX} no plan found for "${planArg}" in ${join('flow', PLANS_DIRNAME)}/`,
    );
  }

  return {
    filePath: join(plansDir, bestFileName),
    displayPath: join('flow', PLANS_DIRNAME, bestFileName),
    planName: planArg,
  };
}

/**
 * Build the full compile report (deterministic ordering, printed once by the
 * caller): plan header, waves, per-phase routing with `[override]`/`[skip]`
 * markers, resume states, and stale-override warnings.
 */
function buildReportLines(
  displayPath: string,
  script: RunScript,
  resume: ResumeStatus[],
): string[] {
  const lines: string[] = [];

  lines.push(
    `plan: ${displayPath} (planHash ${script.planHash.slice(0, PLAN_HASH_PREFIX_LENGTH)})`,
  );
  // routing is [] exactly when model_routing was off at compile time (#670).
  lines.push(
    script.routing.length > 0
      ? 'model routing: on'
      : 'model routing: off — all phases use the most capable model',
  );

  for (const wave of script.waves) {
    const phases = wave.phase_numbers.map((number) => `Phase ${number}`).join(', ');
    lines.push(`Wave ${wave.wave_number}: ${phases}`);
  }

  for (const phase of script.phases) {
    const phaseOverride = script.overrides.phases?.[String(phase.number)];
    const markers: string[] = [];
    if (phaseOverride?.model !== undefined) {
      markers.push('[override]');
    }
    if (phase.skip) {
      markers.push('[skip]');
    }
    const suffix = markers.length > 0 ? ` ${markers.join(' ')}` : '';
    lines.push(`Phase ${phase.number} (complexity ${phase.complexity}) → ${phase.model}${suffix}`);
  }

  for (const status of resume) {
    const state = status.state === 'complete' ? 'complete (resumable)' : 'pending';
    lines.push(`Phase ${status.phase}: ${state}`);
  }

  // EVERY diagnostic is printed, not only the stale-override ones (#1810). An
  // `info` that reaches the artifact and never reaches the person compiling is
  // a note to nobody — and the note it exists to carry is "the number in this
  // artifact is not the number you wrote".
  for (const diagnostic of script.diagnostics) {
    lines.push(
      diagnostic.severity === 'stale-override'
        ? `warning: ${diagnostic.message}`
        : `note: ${diagnostic.message}`,
    );
  }

  return lines;
}

/**
 * `plan compile <plan>` — read the plan, recover preserved overrides from the
 * previous artifact, compile, write atomically through the store, and print
 * the report once. On any failure: one `compile refused:` line, exit 1,
 * nothing written.
 */
export async function runPlanCompile(
  planArg: string,
  options: { target: string },
): Promise<void> {
  const flowDir = join(options.target, 'flow');

  try {
    const resolved = resolvePlanFile(options.target, planArg);

    let planContent: string;
    try {
      planContent = readFileSync(resolved.filePath, 'utf-8');
    } catch (readError) {
      const message = readError instanceof Error ? readError.message : String(readError);
      throw new Error(
        `${COMPILE_REFUSED_PREFIX} cannot read plan file ${resolved.filePath}: ${message}`,
      );
    }

    // Recompiles recover the preserved overrides block; an absent or
    // unreadable artifact means starting fresh with empty overrides.
    const previous = readRunScript(flowDir, resolved.planName);
    const overrides = previous?.overrides ?? {};

    // Tiering follows flow/.flowconfig's model_routing (#670), which defaults
    // to true: only an explicit false compiles every phase to the most
    // capable model.
    const config = parseFlowConfig(flowDir);
    const script = compileRunScript(planContent, resolved.planName, overrides, {
      modelRouting: config.model_routing,
    });
    if (script.phases.length === 0) {
      // SAY WHY, not just that (#1809). The refusal used to report the symptom
      // and withhold the grammar, so a plan with six visible phase headings was
      // told its phases do not exist.
      throw new Error(
        `${COMPILE_REFUSED_PREFIX} no phases parsed from ${resolved.displayPath} — ${whyNoPhases(planContent)}`,
      );
    }

    writeRunScript(flowDir, resolved.planName, script);

    const resume = evaluateResume(script, readRoundsEntries(flowDir));
    const lines = buildReportLines(resolved.displayPath, script, resume);
    lines.push(`run script: ${join('flow', PLANS_DIRNAME, `${resolved.planName}.run.json`)}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  } catch (error) {
    logError(toRefusalLine(error));
    process.exitCode = 1;
  }
}

/**
 * Resolve the `<plan>` argument of `plan archive` to a bare plan name.
 *
 * Unlike compile, this NEVER requires the plan markdown to still be in
 * `flow/plans/` — the archive step moves the doc first, and the run-script
 * artifacts are keyed by name. A `.md` argument contributes its basename;
 * anything else is the name itself. Path separators are refused so the name
 * can only ever key files inside `flow/plans/`.
 */
function resolveArchivePlanName(planArg: string): string {
  const trimmed = planArg.trim();
  if (trimmed.length === 0) {
    throw new Error(`${ARCHIVE_REFUSED_PREFIX} no plan name given`);
  }
  const name = trimmed.endsWith('.md') ? planNameFromFilename(basename(trimmed)) : trimmed;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`${ARCHIVE_REFUSED_PREFIX} invalid plan name: ${trimmed}`);
  }
  return name;
}

/**
 * The plan FILE a rounds record is archived under (`rounds_<plan file>.jsonl`,
 * the name the execute-plan skill documents): the argument's own basename
 * when it names the markdown, else the highest `plan_<name>_v<N>.md` in
 * `flow/plans/` or `flow/archive/`, else `plan_<name>`.
 */
function planFileFor(flowDir: string, planArg: string, planName: string): string {
  const trimmed = planArg.trim();
  if (trimmed.endsWith('.md')) return basename(trimmed);
  const pattern = new RegExp(`^plan_${planName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_v(\\d+)\\.md$`);
  let best: { file: string; version: number } | null = null;
  for (const dir of [join(flowDir, 'plans'), join(flowDir, ARCHIVE_DIRNAME)]) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const match = pattern.exec(entry);
      if (match === null) continue;
      const version = Number.parseInt(match[1], 10);
      if (best === null || version > best.version) best = { file: entry, version };
    }
  }
  return best?.file ?? `plan_${planName}`;
}

/**
 * `plan archive <plan>` — the production caller of the store's
 * `archiveRunScript`: move `flow/plans/<plan>.run.json` AND its rotated
 * `<plan>.run.prev.json` into `flow/archive/`, filenames unchanged, through
 * one enforced code path. Reports exactly which artifacts moved; an absent
 * artifact is a silent no-op that never blocks archiving (exit 0). On any
 * failure: one `archive refused:` line, exit 1, nothing moved.
 */
export async function runPlanArchive(
  planArg: string,
  options: { target: string },
): Promise<void> {
  const flowDir = join(options.target, 'flow');

  try {
    const planName = resolveArchivePlanName(planArg);

    if (!existsSync(flowDir)) {
      throw new Error(
        `${ARCHIVE_REFUSED_PREFIX} no flow/ directory at ${options.target}`,
      );
    }

    // Capture what is actually there BEFORE the move, so the report names the
    // artifacts that moved rather than restating the request.
    const moved = [runScriptPath(flowDir, planName), runScriptPrevPath(flowDir, planName)]
      .filter((filePath) => existsSync(filePath))
      .map((filePath) => basename(filePath));

    archiveRunScript(flowDir, planName);

    // The LIVE rounds record is archived with its plan through the one
    // writer (`archiveRounds`): in a Workspace the archive is shared with a
    // team, so the archived copy is a summary with file:line references and
    // the full record stays on this machine (FR-17).
    const inWorkspace = locateWorkspaceProject(flowDir) !== null;
    const roundsArchived = archiveRounds(flowDir, planFileFor(flowDir, planArg, planName), { summarize: inWorkspace });
    if (roundsArchived !== null) {
      process.stdout.write(`archived: ${join('flow', ARCHIVE_DIRNAME, basename(roundsArchived))}\n`);
    }

    // Idempotent, so every archive re-checks every archived record.
    if (inWorkspace) {
      for (const filePath of summarizeArchivedRounds(flowDir, { keepFull: true })) {
        process.stdout.write(`summarized: ${join('flow', ARCHIVE_DIRNAME, basename(filePath))}\n`);
      }
    }

    if (moved.length === 0) {
      process.stdout.write(`archive: no run-script artifacts for ${planName} — nothing to move\n`);
      return;
    }
    const destinations = moved.map((name) => join('flow', ARCHIVE_DIRNAME, name)).join(', ');
    process.stdout.write(`archived: ${destinations}\n`);
  } catch (error) {
    logError(toArchiveRefusalLine(error));
    process.exitCode = 1;
  }
}

// ── Change notes: the reader and the one writer ─────────

/** Prefix every `plan notes` / `plan note` refusal carries. */
const PLAN_REFUSED_PREFIX = 'plan refused:';

/** Why a notes verb refused — the first word of its refusal line. */
export type PlanNotesRefusalReason =
  | 'unknown-plan'
  | 'notes'
  | 'unknown-note'
  | 'unreadable-note'
  | 'bad-value'
  | 'missing-why'
  | 'status-and-verdict'
  | 'nothing-to-set'
  | 'plan-changed'
  | 'write-failed';

/**
 * A refusal that carries its answer: the payload goes to stdout as one JSON
 * line, the sentence to the logger as the family's one refusal line.
 */
export class PlanNotesRefusal extends Error {
  readonly reason: PlanNotesRefusalReason;
  readonly payload: Record<string, unknown>;

  constructor(reason: PlanNotesRefusalReason, sentence: string, payload: Record<string, unknown> = {}) {
    super(`${PLAN_REFUSED_PREFIX} ${reason} — ${sentence.replace(/\s+/g, ' ').trim()}`);
    this.name = 'PlanNotesRefusal';
    this.reason = reason;
    this.payload = payload;
  }
}

/** Where a change note's quote was found in today's code. */
export type { NoteQuote } from '../blueprint/storyline-types.js';

/** One note as `plan notes` reports it: the note, and (when it quotes code here) where its quote is. */
export interface PlanNoteReport extends StorylineNote {
  /**
   * Change notes, and file notes with a `where:` — read in this checkout, or
   * in a sibling Workspace project's checkout for a `<project>/` note (absent,
   * with `quoteUnchecked`, when that checkout is not on this computer).
   */
  quote?: NoteQuote;
  /** The target file is not in the project. */
  fileMissing?: true;
  /** The file is there but has no piece of that name. */
  symbolMissing?: true;
  /**
   * No reader could find the function's lines (an unread language, a syntax
   * error), so the quote was looked for in the whole file instead.
   */
  functionUnchecked?: true;
  /**
   * A sibling Workspace project's note whose checkout is not on this
   * computer: its quote was not looked for, so `--check` cannot vouch for it.
   */
  quoteUnchecked?: true;
}

export interface PlanNotesResult {
  plan: string;
  /** The plan file, relative to the project (`flow/plans/plan_<name>_v<N>.md`). */
  path: string;
  notes: PlanNoteReport[];
  counts: NoteCounts;
  unreadable: UnreadableNote[];
}

function findPlanOrRefuse(target: string, planArg: string): FoundPlan {
  const found = findActivePlan(join(target, 'flow'), planArg);
  if (found === null) {
    throw new PlanNotesRefusal('unknown-plan', `there is no active plan named '${planArg}'`, { plan: planArg });
  }
  return found;
}

function displayPathOf(found: FoundPlan): string {
  return join('flow', PLANS_DIRNAME, basename(found.path));
}

/** Read a plan's notes, with each quote (change notes, and file notes that have one) resolved against today's code. */
export async function readPlanNotes(
  planArg: string,
  options: { target: string; readers?: StorylineReaders },
): Promise<PlanNotesResult> {
  const found = findPlanOrRefuse(options.target, planArg);
  const parsed = parseChangeNotes(found.content);
  const readers = options.readers ?? new StorylineReaders();
  // Whose code a `<project>/` prefix names — the storyline's own answer, so
  // this project's own slug is local here exactly as it is on the story.
  const projects = noteProjectsOf(options.target);
  const notes: PlanNoteReport[] = [];
  for (const note of parsed.notes) {
    const report = noteReportOf(note);
    // A change note's quote, and a file note's when it has one, are looked for
    // in today's code — a sibling project's in that project's checkout.
    const quoted = note.kind === 'change' || (note.kind === 'file' && note.where !== undefined);
    if (!quoted) {
      notes.push(report);
      continue;
    }
    const checkout = noteCheckoutRoot(projects, options.target, note.target.project);
    notes.push(
      checkout === null
        ? { ...report, quoteUnchecked: true }
        : { ...report, ...(await resolveNoteQuote(checkout.root, note, readers)) },
    );
  }
  return {
    plan: found.name,
    path: displayPathOf(found),
    notes,
    counts: countNotes(parsed.notes),
    unreadable: parsed.unreadable,
  };
}

/** The most change notes a plan may carry — see `notesFailingCheck`. */
export const MAX_PLAN_NOTES = 10;

/** The notes `--check` refuses on, each with the sentence that says why. */
export function notesFailingCheck(result: PlanNotesResult): Array<{ n?: number; line?: number; reason: string }> {
  const failing: Array<{ n?: number; line?: number; reason: string }> = [];
  for (const entry of result.unreadable) {
    failing.push({ ...(entry.n === undefined ? {} : { n: entry.n }), line: entry.line, reason: entry.reason });
  }
  for (const note of result.notes) {
    if (note.quote === undefined || note.quote.found === 'once') continue;
    let reason: string;
    if (note.fileMissing === true) reason = `${note.file} is not in the project`;
    else if (note.symbolMissing === true) reason = `${note.file} has no function named ${note.symbol ?? ''}`;
    else if (note.quote.found === 'many') reason = `the quote is found ${String(note.quote.count ?? 0)} times — quote more of the line`;
    else reason = `the quote is not in ${note.symbol ?? note.file} today`;
    failing.push({ n: note.n, reason });
  }
  // NOTES ARE FOR THE MAIN CHANGES (user, 2026-10-08: "not review every single
  // point, only the most important points of the plan"). A plan that writes one
  // note per function buries the decisions under pass-through edits; past the
  // ceiling the check refuses, so the author folds repeated edits into one note.
  if (result.notes.length > MAX_PLAN_NOTES) {
    failing.push({
      reason: `this plan has ${String(result.notes.length)} notes — keep only the main changes (at most ${String(MAX_PLAN_NOTES)}) and write a repeated edit once`,
    });
  }
  return failing.sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
}

/** Print a refusal per the family contract: payload line, then the one refusal line. */
function reportPlanRefusal(error: unknown): void {
  if (error instanceof PlanNotesRefusal) {
    process.stdout.write(`${JSON.stringify({ refused: error.reason, ...error.payload })}\n`);
    logError(error.message);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    logError(message.startsWith(PLAN_REFUSED_PREFIX) ? message : `${PLAN_REFUSED_PREFIX} ${message.replace(/\s+/g, ' ').trim()}`);
  }
  process.exitCode = 1;
}

/**
 * `plan notes <plan> [--check] [--json]` — the plan's change notes, counts and
 * unreadable notes. `--check` refuses when any change note's quote is found
 * zero or two-plus times, or any note is unreadable; without it, it never
 * refuses for those. A sibling project's note with no checkout on this
 * computer is `quoteUnchecked` — reported, never vouched for.
 */
export async function runPlanNotes(
  planArg: string,
  options: { target: string; check?: boolean; json?: boolean },
): Promise<void> {
  try {
    const result = await readPlanNotes(planArg, { target: options.target });
    if (options.check === true) {
      const failing = notesFailingCheck(result);
      if (failing.length > 0) {
        throw new PlanNotesRefusal(
          'notes',
          `${String(failing.length)} note(s) need fixing before this plan can be reviewed: ` +
            failing.map((entry) => (entry.n === undefined ? `line ${String(entry.line ?? 0)}` : `note ${String(entry.n)}`)).join(', '),
          { ...result, failing },
        );
      }
    }
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const lines = [
      `plan: ${result.path}`,
      `notes: ${String(result.counts.total)} (${String(result.counts.accepted)} accepted, ` +
        `${String(result.counts.rejected)} rejected, ${String(result.counts.unreviewed)} unreviewed)`,
    ];
    for (const note of result.notes) {
      const quote = note.quote === undefined ? '' : ` — quote ${note.quote.found}`;
      lines.push(`  ${String(note.n)}. [${note.status}] ${note.kind} ${note.target}${quote}`);
    }
    for (const entry of result.unreadable) lines.push(`  unreadable (line ${String(entry.line)}): ${entry.reason}`);
    if (options.check === true) lines.push('check: every note is readable and every quote is found once');
    process.stdout.write(`${lines.join('\n')}\n`);
  } catch (error) {
    reportPlanRefusal(error);
  }
}

/** What `plan note` was asked to set. */
export interface PlanNoteRequest {
  target: string;
  note?: string;
  status?: string;
  reason?: string;
  verdict?: string;
  why?: string;
}

export interface PlanNoteResult {
  plan: string;
  path: string;
  /** Whether the file's bytes changed. */
  changed: boolean;
  note: PlanNoteReport;
}

/**
 * How many times `plan note` re-applies its edit when another writer changed
 * the plan between its read and its write, before it refuses `plan-changed`.
 */
export const MAX_PLAN_NOTE_ATTEMPTS = 5;

/** Seams for the compare-and-swap's tests: run after the temp file is written, before the re-read. */
export interface PlanNoteWriteDeps {
  beforeCommit?: (attempt: number) => void;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Sanctioned fail-soft: the temp file was never created or is already gone.
  }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    // A plan that cannot be read back now is not the plan the edit was computed from: retry.
    return null;
  }
}

/**
 * Write `content` over `filePath` by temp + rename (a reader never sees half
 * of it) — but only if the file still holds `expected`, the text the edit was
 * computed from. Re-read AFTER the temp file is written, so the window between
 * the check and the rename is a rename's, not a write's. Returns false (and
 * leaves the file alone) when another writer got there first.
 */
function writeIfUnchanged(filePath: string, expected: string, content: string, attempt: number, deps: PlanNoteWriteDeps): boolean {
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${String(process.pid)}.tmp`);
  try {
    writeFileSync(tempPath, content, 'utf-8');
    deps.beforeCommit?.(attempt);
    if (readOrNull(filePath) !== expected) {
      removeQuietly(tempPath);
      return false;
    }
    renameSync(tempPath, filePath);
    return true;
  } catch (error) {
    removeQuietly(tempPath);
    const message = error instanceof Error ? error.message : String(error);
    throw new PlanNotesRefusal('write-failed', `the plan file could not be written: ${message}`, { path: filePath });
  }
}

/**
 * Validate a `plan note` request against the plan's notes and compute the new
 * content — pure apart from the plan lookup, and writes nothing.
 */
export function planNoteEdit(request: PlanNoteRequest, planArg: string): {
  found: FoundPlan;
  n: number;
  next: string;
} {
  const found = findPlanOrRefuse(request.target, planArg);
  const base = { plan: found.name, path: displayPathOf(found) };
  const hasStatus = request.status !== undefined;
  const hasVerdict = request.verdict !== undefined;
  if (hasStatus && hasVerdict) {
    throw new PlanNotesRefusal('status-and-verdict', 'set a status or a verdict, not both at once', base);
  }
  if (!hasStatus && !hasVerdict) {
    throw new PlanNotesRefusal('nothing-to-set', 'say which status or verdict to record', {
      ...base,
      statuses: NOTE_STATUSES,
      verdicts: NOTE_VERDICTS,
    });
  }
  const noteArg = (request.note ?? '').trim();
  if (!/^\d+$/.test(noteArg)) {
    throw new PlanNotesRefusal('bad-value', `'${noteArg}' is not a note number`, { ...base, field: 'note', value: noteArg });
  }
  const n = Number.parseInt(noteArg, 10);
  const parsed = parseChangeNotes(found.content);
  if (!parsed.notes.some((note) => note.n === n)) {
    const unreadable = parsed.unreadable.find((entry) => entry.n === n);
    if (unreadable !== undefined) {
      throw new PlanNotesRefusal('unreadable-note', `note ${String(n)} cannot be read: ${unreadable.reason}`, {
        ...base,
        note: n,
        unreadable,
      });
    }
    throw new PlanNotesRefusal('unknown-note', `this plan has no note ${String(n)}`, {
      ...base,
      note: n,
      notes: parsed.notes.map((note) => note.n),
    });
  }

  if (hasStatus) {
    const status = (request.status ?? '').trim().toLowerCase();
    if (!isNoteStatus(status)) {
      throw new PlanNotesRefusal('bad-value', `'${request.status ?? ''}' is not a status — it is ${NOTE_STATUSES.join(', ')}`, {
        ...base,
        field: 'status',
        value: request.status,
        allowed: NOTE_STATUSES,
      });
    }
    return { found, n, next: setNoteStatus(found.content, n, status, request.reason) };
  }
  const verdict = (request.verdict ?? '').trim().toLowerCase();
  if (!isNoteVerdict(verdict)) {
    throw new PlanNotesRefusal('bad-value', `'${request.verdict ?? ''}' is not a verdict — it is ${NOTE_VERDICTS.join(', ')}`, {
      ...base,
      field: 'verdict',
      value: request.verdict,
      allowed: NOTE_VERDICTS,
    });
  }
  const why = (request.why ?? '').trim();
  if (why === '') {
    throw new PlanNotesRefusal('missing-why', 'a verdict carries one sentence saying why', { ...base, note: n });
  }
  return { found, n, next: setNoteVerdict(found.content, n, verdict, why) };
}

/**
 * `plan note <plan> --note <n> (--status … [--reason …] | --verdict … --why …)`
 * — the ONE writer of a note's status and verdict. Re-reads the plan, rewrites
 * only that note's line, writes atomically; every other byte is unchanged.
 */
export async function runPlanNote(
  planArg: string,
  options: PlanNoteRequest & { json?: boolean },
): Promise<void> {
  try {
    const result = applyPlanNote(planArg, options);
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    const note = result.note;
    const decided = note.verdict !== undefined && options.verdict !== undefined
      ? `verdict ${note.verdict}`
      : `status ${note.status}`;
    process.stdout.write(`note ${String(note.n)}: ${decided}${result.changed ? '' : ' (unchanged)'}\n`);
  } catch (error) {
    reportPlanRefusal(error);
  }
}

/**
 * The write behind `plan note`, as a compare-and-swap: compute the edit from
 * the plan as read, and rename it into place only if the plan still holds
 * that text. When another writer (a second `plan note`, the app) changed it
 * in between, the edit is re-applied to the fresh text — so both decisions
 * land — up to `MAX_PLAN_NOTE_ATTEMPTS` times; a plan that never settles
 * refuses `plan-changed` and is left as the other writer left it.
 */
export function applyPlanNote(planArg: string, request: PlanNoteRequest, deps: PlanNoteWriteDeps = {}): PlanNoteResult {
  for (let attempt = 1; attempt <= MAX_PLAN_NOTE_ATTEMPTS; attempt += 1) {
    const { found, n, next } = planNoteEdit(request, planArg);
    const changed = next !== found.content;
    if (changed && !writeIfUnchanged(found.path, found.content, next, attempt, deps)) continue;
    const note = parseChangeNotes(next).notes.find((candidate) => candidate.n === n);
    if (note === undefined) {
      throw new PlanNotesRefusal('write-failed', `note ${String(n)} could not be read back after writing`, {
        path: displayPathOf(found),
        note: n,
        changed,
      });
    }
    return { plan: found.name, path: displayPathOf(found), changed, note: noteReportOf(note) };
  }
  const found = findPlanOrRefuse(request.target, planArg);
  throw new PlanNotesRefusal(
    'plan-changed',
    `the plan kept changing while this note was written (${String(MAX_PLAN_NOTE_ATTEMPTS)} tries) — nothing was written`,
    { plan: found.name, path: displayPathOf(found), note: request.note, attempts: MAX_PLAN_NOTE_ATTEMPTS },
  );
}
