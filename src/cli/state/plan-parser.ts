/**
 * Plan markdown parser
 *
 * Parses plan files (flow/plans/plan_*.md) into structured PlanPhase objects.
 * Extracts phase headers, complexity scores, dependencies, tasks, and verify tags.
 */

import { readFileSync } from 'node:fs';
import type { PlanPhase, PlanTask } from './types.js';
import { parseChangeNotes, type ChangeNote, type UnreadableNote } from './change-notes.js';
import { HEADING_SHAPED_RE, PHASE_HEADER_RE } from './plan-headings.js';

/**
 * `**Complexity**: 8` and `**Complexity**: 8/10` are the same statement.
 *
 * THE SUFFIX IS THE UNIT, NOT THE VALUE, and requiring it made 59 of the 167
 * complexity lines in this repo's archived plans unreadable — 35% (#1810). Each
 * one silently took the default of 5, including ten written `7` and four
 * written `8`, all of which should have routed to opus. Complexity is not
 * decorative: it picks the model, so two missing characters downgraded the
 * phase.
 *
 * The regex was already tolerant of trailing content — `6/10 (Medium-high)`
 * parses — so it was intolerant only of the ABSENT suffix, which is the more
 * common variant. This is the same widening the phase-header separator got one
 * line above, for the same reason: plans are authored by an LLM following a
 * prose template, and a grammar narrower than the documents it is fed keeps
 * collecting near-misses.
 *
 * Anchored at the line's start so a `**Complexity**` mentioned mid-sentence in
 * a phase's prose cannot be read as its score.
 */
const COMPLEXITY_RE = /^\*\*Complexity(?:\*\*:|:\*\*)\s*(\d+)(?:\/10)?\b/;

/**
 * A `**Complexity**` line, whatever follows the colon — used to spot near-misses.
 *
 * WIDENED WITH THE VALUE GRAMMAR, deliberately (#1844). #1810 made the `/10`
 * suffix optional and added this detector so an unreadable complexity would be
 * said out loud — but both regexes kept the colon OUTSIDE the emphasis, and 59
 * lines in this repo's plans write `**Complexity:** 6`. Those did not merely
 * default to 5; they were not recognised as complexity lines at all, so the
 * detector reported nothing and the silence #1810 set out to end simply moved.
 * A widening that leaves its own diagnostic behind relocates the problem.
 */
const COMPLEXITY_LINE_RE = /^\*\*Complexity(?:\*\*:|:\*\*)/;

/** The documented range. Anything outside it is not a complexity score. */
const MAX_COMPLEXITY = 10;
const DEPENDENCIES_RE = /\*\*Dependencies(?:\*\*:|:\*\*)\s*(.+)/;

/**
 * A dependency list written as bare phase numbers — `2, 3` rather than
 * `Phase 2, Phase 3`.
 *
 * Both forms are in the corpus and only the second was read, so `2, 3` yielded
 * NO dependencies (#1844) — not a sequential fallback, which is what an absent
 * line gets, but an explicit empty list. 26 such lines are live today,
 * including one in an active plan, and each one lets its phase into wave 1
 * beside the prerequisites it declared.
 *
 * Deliberately strict: only digits, separators and the word "and". A value like
 * `Phase 2 (after the v3 cut)` must keep going through the `Phase N` reader
 * rather than having stray numbers scraped out of its prose.
 */
const BARE_PHASE_LIST_RE = /^[\d\s,and&+]+$/i;

/** The `Phase`/`Phases` keyword, wherever it appears in a dependency value. */
const PHASE_KEYWORD_RE = /Phases?/gi;
/**
 * A task, in the three shapes this repo's plans are actually written in.
 *
 * The checkbox was the only one recognised, and it is a MINORITY of the corpus
 * in the sense that matters: 681 tasks parsed, 134 dropped, and eleven of 44
 * plans had EVERY task dropped (#1821). A dropped task takes its `<verify>`
 * with it — 58 verification commands, silently — and the phase then compiles to
 * `tasks: []` with exit 0 and no diagnostic, so `/execute-plan` reads the
 * artifact that is documented as its orchestration source of truth and finds
 * nothing to do.
 *
 * This is the same widening the phase-header separator and the complexity
 * suffix each already got, for the reason recorded there: plans are authored by
 * an LLM following a prose template, and a grammar narrower than the documents
 * it is fed keeps collecting near-misses. The template documents the checkbox;
 * `/create-plan` has demonstrably emitted the other two.
 */
const TASK_RE = /^- \[[ x]\]\s+(.+)$/;

/**
 * `- **Task 1.1** — do the thing`, and the same bullet without the emphasis
 * (`- Task 1.1: do the thing`).
 *
 * The NUMBER is what makes it a task, not the bold: a bullet merely starting
 * with the word "Task" in prose does not match. The unbolded variant is the
 * fourth shape found in this corpus, and it was found by the taskless-phase
 * diagnostic added alongside this — which is the argument for having it.
 */
const BOLD_TASK_RE = /^- \*{0,2}Task\s+\d+(?:\.\d+)*\*{0,2}\s*[—–:-]?\s*(.+)$/;

/**
 * `**Tasks**:` — opens a numbered list whose items are tasks.
 *
 * All three bolding variants the corpus uses: `**Tasks**:`, `**Tasks:**` (the
 * colon inside the emphasis) and a bare `Tasks:`. Which side of the colon the
 * asterisks fall on is a typographic accident of whoever wrote the template
 * that day, and it is not worth a dropped phase.
 */
const TASKS_HEADER_RE = /^\*{0,2}Tasks\*{0,2}:\*{0,2}\s*$/;

/** `1. do the thing`, counted ONLY inside a `**Tasks**:` list. Numbered lines
 *  are ordinary prose everywhere else in a phase, so this shape cannot be
 *  recognised on its own without inventing tasks out of narrative. */
const NUMBERED_TASK_RE = /^\d+\.\s+(.+)$/;

/** Any other `**Field**:` line, or a rule/heading — ends a `**Tasks**:` list.
 *  In the corpus a task list is always followed by one of these (`**Files**:`
 *  is the usual one) or by the next phase. */
const FIELD_OR_BREAK_RE = /^(?:\*\*[A-Za-z][A-Za-z ]*\*{0,2}:\*{0,2}|#{1,6} |---\s*$)/;

const VERIFY_RE = /<verify>(.+)<\/verify>/;


export const DEFAULT_COMPLEXITY = 5;

/** What a phase heading has to look like, in the words an author would type. */
export const PHASE_HEADER_SHAPE = '### Phase <n>: <title>';

/**
 * Why a plan parsed to zero phases, in terms an author can act on.
 *
 * "no phases parsed" reports the SYMPTOM and withholds the one fact that fixes
 * it (#1809). A plan with six visible `## Phase` headings was told its phases
 * do not exist — and because `/execute-plan` reads the compiled artifact as its
 * orchestration source of truth, a heading level one `#` off does not degrade
 * the run, it stops the plan entering the pipeline at all.
 *
 * THE LEVEL IS NOT WIDENED, deliberately, and this diagnosis is what that costs
 * instead. 51 phase headings in this repo's own archive are `##`, which looks
 * like a case for accepting both — but every one of those plans writes its
 * tasks as numbered prose under `**Tasks**:`, not as `- [ ]` checkboxes. So
 * accepting `##` would compile them to phases with ZERO tasks, and zero-task
 * phases already compile without complaint (eleven `###` plans have none), so
 * nothing downstream would catch it. The plan would enter the pipeline and run
 * nothing, silently. A refusal that names its reason is better than a success
 * that does nothing.
 */
export function whyNoPhases(content: string): string {
  const lines = content.split('\n');

  const wrongLevel = lines.filter((line) => /^#{1,6} +Phase \d+/.test(line) && !PHASE_HEADER_RE.test(line));
  const misLevelled = wrongLevel.filter((line) => !/^### /.test(line));
  if (misLevelled.length > 0) {
    const level = (misLevelled[0] as string).match(/^#+/)?.[0] ?? '#';
    return (
      `${String(misLevelled.length)} phase heading(s) are \`${level}\` — a phase must be \`${PHASE_HEADER_SHAPE}\`, ` +
      `exactly three hashes`
    );
  }

  // Right level, wrong shape — a missing separator is the usual culprit.
  if (wrongLevel.length > 0) {
    return `phase heading(s) do not match \`${PHASE_HEADER_SHAPE}\` — a colon or dash must separate the number from the title`;
  }

  return `no \`${PHASE_HEADER_SHAPE}\` heading in the file`;
}

/**
 * Parses a plan markdown file and returns an array of PlanPhase objects.
 */
export function parsePlan(planPath: string): PlanPhase[] {
  const content = readFileSync(planPath, 'utf-8');
  return parsePlanContent(content);
}

/** A `**Complexity**` line the parser could not read, and the phase it was in. */
export interface UnreadableComplexity {
  phase: number;
  line: string;
}

/** Everything a parse learned, including what it could not read. */
export interface ParsedPlan {
  phases: PlanPhase[];
  /**
   * `**Complexity**` lines that matched no score.
   *
   * Surfaced rather than swallowed (#1810): the default of 5 is
   * indistinguishable from a deliberate 5, which is exactly why 59 unreadable
   * lines went unnoticed. A caller that can warn should warn.
   */
  unreadableComplexity: UnreadableComplexity[];
  /**
   * Phases that parsed to zero tasks.
   *
   * The backstop for the shape nobody has written yet. `whyNoPhases` above
   * declines to widen the heading level specifically because "zero-task phases
   * already compile without complaint … the plan would enter the pipeline and
   * run nothing, silently" — this is the complaint that was missing. Widening
   * the grammar fixes the three shapes we know about; saying so out loud is
   * what catches the fourth.
   */
  tasklessPhases: TasklessPhase[];
  /**
   * `**Dependencies**` lines that named something but resolved to no phases.
   *
   * Distinct from an ABSENT line (sequential fallback, silent and correct) and
   * from an explicit `none` (genuinely independent). This is the third case
   * that used to be spelled the same as the second.
   */
  unreadableDependencies: UnreadableDependencies[];
  /** Heading-shaped lines that named no readable phase. */
  unreadableHeadings: UnreadableHeading[];
  /** Every readable change note, in file order (each also on its phase). */
  notes: ChangeNote[];
  /**
   * Change notes that could not be read — reported, never dropped (an unknown
   * kind or status, a bad target, a missing field, a shared number, a note
   * outside any phase).
   */
  unreadableNotes: UnreadableNote[];
}

/**
 * A `**Dependencies**` line naming something, that resolved to no phases.
 *
 * Reported for the same reason an unreadable complexity is (#1810): the value
 * it fell back to is indistinguishable from one somebody meant.
 */
export interface UnreadableDependencies {
  phase: number;
  line: string;
}

/**
 * A heading-shaped line the parser could not read as a phase.
 *
 * Reported rather than absorbed: `whyNoPhases` already exists to explain
 * heading-shaped lines the parser rejects when NONE parse. This is the same
 * idea one level in — the plan parses, and a heading inside it does not.
 */
export interface UnreadableHeading {
  /** The phase whose body this line would otherwise have joined, if any. */
  afterPhase: number | null;
  line: string;
}

/** A phase that finalized with no tasks, and what it was called. */
export interface TasklessPhase {
  phase: number;
  name: string;
}

/**
 * Parses plan markdown content (for testability without file I/O).
 *
 * Returns the phases only — the signature every existing caller uses. Callers
 * that want to REPORT what could not be read use `parsePlanDetailed`.
 */
export function parsePlanContent(content: string): PlanPhase[] {
  return parsePlanDetailed(content).phases;
}

/** As `parsePlanContent`, plus the lines the parser could not make sense of. */
export function parsePlanDetailed(content: string): ParsedPlan {
  const phases: PlanPhase[] = [];
  const unreadable: UnreadableComplexity[] = [];
  const unreadableDependencies: UnreadableDependencies[] = [];
  const unreadableHeadings: UnreadableHeading[] = [];
  const lines = content.split('\n');
  // Change notes are read by their own parser; their lines are never tasks,
  // dependencies or complexity, whatever a comment happens to say.
  const changeNotes = parseChangeNotes(content);
  const inNoteBlock = (lineNo: number): boolean =>
    changeNotes.blocks.some((block) => lineNo >= block.startLine && lineNo <= block.endLine);
  /** Inside a `**Tasks**:` list, where a bare `1.` is a task and not prose. */
  let inTasksList = false;

  let currentPhase: {
    number: number;
    name: string;
    complexity: number | null;
    dependencies: number[] | null;
    tasks: PlanTask[];
  } | null = null;

  let lastTaskIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (inNoteBlock(i + 1)) {
      lastTaskIndex = -1;
      inTasksList = false;
      continue;
    }

    // Phase header
    const headerMatch = trimmed.match(PHASE_HEADER_RE);
    if (headerMatch) {
      // Save previous phase
      if (currentPhase) {
        phases.push(finalizePhase(currentPhase));
      }

      currentPhase = {
        number: parseInt(headerMatch[1], 10),
        name: headerMatch[2].trim(),
        complexity: null,
        dependencies: null,
        tasks: [],
      };
      lastTaskIndex = -1;
      inTasksList = false;
      continue;
    }

    // A HEADING WE COULD NOT READ ENDS THE PHASE ABOVE IT — it never extends
    // it (#1847). Absorption is the whole defect: everything under an
    // unreadable heading belongs to a section the author separated, and letting
    // it flow into the previous phase corrupts a phase that is written
    // correctly. Closing the phase here means those lines are ignored, which is
    // the honest outcome for a section the parser cannot place.
    if (HEADING_SHAPED_RE.test(trimmed)) {
      unreadableHeadings.push({ afterPhase: currentPhase?.number ?? null, line: trimmed });
      if (currentPhase) {
        phases.push(finalizePhase(currentPhase));
        currentPhase = null;
      }
      lastTaskIndex = -1;
      inTasksList = false;
      continue;
    }

    if (!currentPhase) continue;

    // `**Tasks**:` opens a numbered list; any other field line, heading or rule
    // closes it. Checked before the task shapes so the header itself is never
    // read as one of its own items.
    if (TASKS_HEADER_RE.test(trimmed)) {
      inTasksList = true;
      lastTaskIndex = -1;
      continue;
    }
    if (inTasksList && FIELD_OR_BREAK_RE.test(trimmed)) {
      inTasksList = false;
      // Not `continue` — the line is still a Complexity/Dependencies field the
      // handlers below are entitled to read.
    }

    // Complexity
    if (COMPLEXITY_LINE_RE.test(trimmed)) {
      const complexityMatch = trimmed.match(COMPLEXITY_RE);
      const value = complexityMatch ? parseInt(complexityMatch[1] as string, 10) : NaN;
      if (Number.isFinite(value) && value >= 0 && value <= MAX_COMPLEXITY) {
        currentPhase.complexity = value;
      } else {
        // UNREADABLE IS NOT FIVE. A default indistinguishable from a deliberate
        // "5" is what made this invisible for 59 lines — the compile exits 0,
        // prints nothing, and the artifact carries a number nobody wrote.
        unreadable.push({ phase: currentPhase.number, line: trimmed });
      }
      continue;
    }

    // Dependencies
    const depsMatch = trimmed.match(DEPENDENCIES_RE);
    if (depsMatch) {
      const depsValue = depsMatch[1].trim();

      if (/^none$/i.test(depsValue)) {
        currentPhase.dependencies = [];
      } else {
        const depNumbers: number[] = [];
        let match: RegExpExecArray | null;
        // Reset regex state for each use
        const phaseRefRe = /Phase\s+(\d+)/gi;
        while ((match = phaseRefRe.exec(depsValue)) !== null) {
          depNumbers.push(parseInt(match[1], 10));
        }
        // `2, 3` means the same as `Phase 2, Phase 3`, and so does
        // `Phases 1, 2, 3, 4` — the keyword said once for a whole list, which
        // the per-reference reader above sees as one dependency and then
        // nothing (#1823). Strip the keyword and read the remainder as a list,
        // but ONLY when what is left is nothing but numbers and separators, so
        // `Phase 2 (after the v3 cut)` keeps going through the reader above and
        // does not have the `3` scraped out of its prose (#1844).
        const withoutKeyword = depsValue.replace(PHASE_KEYWORD_RE, ' ').trim();
        if (BARE_PHASE_LIST_RE.test(withoutKeyword) && /\d/.test(withoutKeyword)) {
          depNumbers.length = 0;
          const bareRe = /\d+/g;
          while ((match = bareRe.exec(withoutKeyword)) !== null) {
            depNumbers.push(parseInt(match[0], 10));
          }
        }

        if (depNumbers.length > 0) {
          currentPhase.dependencies = depNumbers;
        } else {
          // "COULD NOT READ IT" IS NOT "DEPENDS ON NOTHING" (#1823). Those were
          // the same value — both `[]` — and `[]` is the strongest claim in the
          // vocabulary: `finalizePhase` gives a sequential fallback only to
          // `null`, so an unreadable line put its phase in wave 1, running in
          // parallel with the phases it named. Left as null, it takes the
          // conservative fallback and is reported.
          unreadableDependencies.push({ phase: currentPhase.number, line: trimmed });
          currentPhase.dependencies = null;
        }
      }
      continue;
    }

    // Task line — checkbox, bold `- **Task N.M**`, or a numbered item inside a
    // `**Tasks**:` list. All three land in the same place, so a `<verify>` on
    // the following line attaches identically whichever shape was used.
    const taskMatch =
      trimmed.match(TASK_RE) ??
      trimmed.match(BOLD_TASK_RE) ??
      (inTasksList ? trimmed.match(NUMBERED_TASK_RE) : null);
    if (taskMatch) {
      // A `<verify>` may sit ON the task line as well as under it — both shapes
      // are in the corpus, and the inline one is the ONLY one the numbered
      // lists use. Reading just the following line left those tasks named
      // "do the thing <verify>npx jest …</verify>" with no command attached.
      const inlineVerify = taskMatch[1].match(VERIFY_RE);
      const taskName = taskMatch[1].replace(VERIFY_RE, '').trim();
      currentPhase.tasks.push({
        index: currentPhase.tasks.length + 1,
        name: taskName,
        verify_command: inlineVerify ? inlineVerify[1].trim() : null,
      });
      // Only look BELOW for a verify when the line did not already carry one,
      // so a following line cannot overwrite an inline command.
      lastTaskIndex = inlineVerify ? -1 : currentPhase.tasks.length - 1;
      continue;
    }

    // Verify tag (must follow a task line)
    if (lastTaskIndex >= 0) {
      const verifyMatch = trimmed.match(VERIFY_RE);
      if (verifyMatch) {
        currentPhase.tasks[lastTaskIndex].verify_command = verifyMatch[1].trim();
        lastTaskIndex = -1;
        continue;
      }

      // If non-empty, non-verify line after a task, reset lastTaskIndex
      if (trimmed !== '') {
        lastTaskIndex = -1;
      }
    }
  }

  // Save the last phase
  if (currentPhase) {
    phases.push(finalizePhase(currentPhase));
  }

  const tasklessPhases: TasklessPhase[] = phases
    .filter((phase) => phase.tasks.length === 0)
    .map((phase) => ({ phase: phase.number, name: phase.name }));

  for (const phase of phases) {
    const own = changeNotes.notes.filter((note) => note.phase === phase.number);
    if (own.length > 0) phase.notes = own;
  }

  return {
    phases,
    unreadableComplexity: unreadable,
    tasklessPhases,
    unreadableDependencies,
    unreadableHeadings,
    notes: changeNotes.notes,
    unreadableNotes: changeNotes.unreadable,
  };
}

function finalizePhase(phase: {
  number: number;
  name: string;
  complexity: number | null;
  dependencies: number[] | null;
  tasks: PlanTask[];
}): PlanPhase {
  const complexity = phase.complexity ?? DEFAULT_COMPLEXITY;

  // Dependencies: if explicitly set, use them; otherwise sequential fallback
  let dependencies: number[];
  if (phase.dependencies !== null) {
    dependencies = phase.dependencies;
  } else {
    // Sequential fallback: depend on previous phase, Phase 1 has no deps
    dependencies = phase.number > 1 ? [phase.number - 1] : [];
  }

  return {
    number: phase.number,
    name: phase.name,
    complexity,
    dependencies,
    tasks: phase.tasks,
  };
}
