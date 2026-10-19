/**
 * Run-script compiler — pure compile core for the compiled run artifact.
 *
 * Compiles plan markdown into a typed `RunScript`: parsed phases, wave
 * groups, per-phase model routing, and user overrides resolved into the
 * phases themselves. Compilation is PURE — no fs, no clock, no Date.now;
 * the sha256 plan hash (node:crypto) is the only crypto use, and hashing is
 * pure. Same inputs always yield deep-equal output; `serializeRunScript`
 * makes it byte-identical (stable key order, 2-space indent, trailing
 * newline — the story-compile serialization precedent).
 *
 * Override resolution never mutates the input: stale overrides (referencing
 * phases/tasks that no longer exist) produce a `stale-override` diagnostic
 * with a precise message, are NOT applied, and are NOT dropped from the
 * `overrides` block carried on the artifact. A dependency cycle refuses the
 * whole compile with a thrown Error (`compile refused: dependency cycle …`),
 * reusing the wave calculator's cycle detection.
 */

import { createHash } from 'node:crypto';
import { calculateModelTiers, MOST_CAPABLE_MODEL } from './model-router.js';
import { DEFAULT_COMPLEXITY, PHASE_HEADER_SHAPE, parsePlanDetailed } from './plan-parser.js';
import { countNotes, withoutReviewLines } from './change-notes.js';
import type {
  ModelTier,
  RunCommitStrategy,
  RunDiagnostic,
  RunNote,
  RunOverrides,
  RunPhase,
  RunPhaseOverride,
  RunScript,
  RunTask,
  WaveGroup,
} from './types.js';
import { calculateWaves, findDependencyCycle } from './wave-calculator.js';

/** Compiler knobs sourced from project config (never from the plan file). */
export interface CompileOptions {
  /** flow/.flowconfig `model_routing`. The CALLER states it: this library
   *  defaults to false so a direct call cannot tier by accident, while the
   *  project default is true and `plan compile` always passes the resolved
   *  config. Off compiles an empty routing table and every phase runs on the
   *  most capable model (#670). */
  modelRouting?: boolean;
}

/** Current run-script artifact version. */
const RUN_SCRIPT_VERSION = 1;
/** JSON indent width — matches the sibling stores' serialization. */
const JSON_INDENT = 2;
/** Commit strategy compiled runs default to (atomic commits per task). */
const DEFAULT_COMMIT_STRATEGY: RunCommitStrategy = 'per-task';

/** `"<phase>"` — a phase-override key. */
const PHASE_KEY_PATTERN = /^(\d+)$/;
/** `"<phase>.<task-index>"` — a task-override key. */
const TASK_KEY_PATTERN = /^(\d+)\.(\d+)$/;

/**
 * Sha256 hex digest of the plan markdown (pure — no I/O). Exported so the
 * change-simulation baseline can key on the SAME hash the run script uses (one
 * definition of "the plan changed").
 *
 * Hashed WITHOUT the change notes' review lines (`status:`, `verdict:`,
 * `comments:` — `withoutReviewLines`): recording a decision is not a change to
 * what the plan builds, and a verdict written after a run must not make the
 * run's own `phase_result` entries stale for resume. Any other edit — a note's
 * `what:`/`why:`/`where:`, a task, a phase — changes the hash.
 */
export function hashPlanContent(planContent: string): string {
  return createHash('sha256').update(withoutReviewLines(planContent), 'utf-8').digest('hex');
}

/**
 * Resolve phase overrides against the parsed phases. Stale or malformed keys
 * become diagnostics; only overrides that resolve land in the returned map.
 */
function resolvePhaseOverrides(
  overrides: RunOverrides,
  phaseNumbers: Set<number>,
  diagnostics: RunDiagnostic[],
): Map<number, RunPhaseOverride> {
  const resolved = new Map<number, RunPhaseOverride>();
  for (const [key, override] of Object.entries(overrides.phases ?? {})) {
    const match = PHASE_KEY_PATTERN.exec(key);
    if (match === null) {
      diagnostics.push({
        severity: 'stale-override',
        message: `override for phase "${key}" is stale: malformed key (expected "<phase>")`,
      });
      continue;
    }
    const phaseNumber = parseInt(match[1], 10);
    if (!phaseNumbers.has(phaseNumber)) {
      diagnostics.push({
        severity: 'stale-override',
        message: `override for phase ${phaseNumber} is stale: no such phase`,
      });
      continue;
    }
    resolved.set(phaseNumber, override);
  }
  return resolved;
}

/**
 * Resolve task verify overrides against the parsed phases. Stale or
 * malformed keys become diagnostics; resolved entries are keyed
 * `"<phase>.<task-index>"`.
 */
function resolveTaskOverrides(
  overrides: RunOverrides,
  taskKeys: Set<string>,
  phaseNumbers: Set<number>,
  diagnostics: RunDiagnostic[],
): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const [key, override] of Object.entries(overrides.tasks ?? {})) {
    const match = TASK_KEY_PATTERN.exec(key);
    if (match === null) {
      diagnostics.push({
        severity: 'stale-override',
        message: `override for task "${key}" is stale: malformed key (expected "<phase>.<task-index>")`,
      });
      continue;
    }
    const phaseNumber = parseInt(match[1], 10);
    if (!phaseNumbers.has(phaseNumber)) {
      diagnostics.push({
        severity: 'stale-override',
        message: `override for task ${key} is stale: no such phase`,
      });
      continue;
    }
    if (!taskKeys.has(key)) {
      diagnostics.push({
        severity: 'stale-override',
        message: `override for task ${key} is stale: no such task`,
      });
      continue;
    }
    if (override.verify !== undefined) {
      resolved.set(key, override.verify);
    }
  }
  return resolved;
}

/** Stable diagnostic order: severity, then message (plain byte comparison). */
function compareDiagnostics(a: RunDiagnostic, b: RunDiagnostic): number {
  if (a.severity !== b.severity) {
    return a.severity < b.severity ? -1 : 1;
  }
  if (a.message !== b.message) {
    return a.message < b.message ? -1 : 1;
  }
  return 0;
}

/**
 * Compile plan markdown plus user overrides into a `RunScript`.
 *
 * Deterministic and pure: parse → wave grouping → per-phase model routing →
 * override resolution. Overrides referencing nonexistent phases/tasks are
 * diagnosed as `stale-override` and skipped, never applied and never dropped
 * from the carried `overrides` block.
 *
 * @throws Error whose message starts with `compile refused: dependency cycle`
 *   (listing the participating phases) when the plan's dependency graph is
 *   cyclic — reusing the wave calculator's cycle detection rather than the
 *   calculator's silent sequential fallback.
 */
export function compileRunScript(
  planContent: string,
  planName: string,
  overrides: RunOverrides,
  options: CompileOptions = {},
): RunScript {
  const { phases, unreadableComplexity, tasklessPhases, unreadableDependencies, unreadableHeadings, notes, unreadableNotes } =
    parsePlanDetailed(planContent);

  const cycle = findDependencyCycle(phases);
  if (cycle.length > 0) {
    throw new Error(
      `compile refused: dependency cycle: phases ${cycle.join(', ')}`,
    );
  }

  const waves = calculateWaves(phases);
  // Off means NO tiering — routing stays [] and every phase gets the most
  // capable model; only true bakes tiers into the artifact (#670). The flag
  // is never defaulted FROM here: `plan compile` resolves it from
  // flow/.flowconfig, where it defaults to true.
  const routing = calculateModelTiers(phases, options.modelRouting ?? false);
  const modelByPhase = new Map(routing.map((tier) => [tier.phase, tier.model]));

  const phaseNumbers = new Set(phases.map((p) => p.number));
  const taskKeys = new Set(
    phases.flatMap((p) => p.tasks.map((t) => `${p.number}.${t.index}`)),
  );

  const diagnostics: RunDiagnostic[] = [];
  // A COMPLEXITY THAT COULD NOT BE READ IS SAID OUT LOUD (#1810). The parser
  // falls back to 5, and a fallback 5 is indistinguishable from an authored 5 —
  // which is how 59 unreadable lines in this repo's own plans each silently
  // picked the model for their phase. The number still defaults, so nothing
  // refuses; the artifact now records that it WAS a default.
  for (const entry of unreadableComplexity) {
    diagnostics.push({
      severity: 'info',
      message:
        `phase ${String(entry.phase)}: could not read a complexity from "${entry.line}" — ` +
        `defaulted to ${String(DEFAULT_COMPLEXITY)}; a complexity is a number 0-10, e.g. \`**Complexity**: 8\``,
    });
  }
  // A HEADING-SHAPED LINE THE PARSER COULD NOT READ IS SAID OUT LOUD (#1847).
  // It used to be absorbed by the phase above it, along with everything under
  // it — so a decimal `### Phase 3.5` handed its Dependencies line to Phase 3,
  // which then depended on itself and made the whole plan refuse for a cycle
  // with no visible cause. Its body is now ignored rather than misattributed,
  // and this is what says so.
  for (const entry of unreadableHeadings) {
    const where = entry.afterPhase === null ? '' : ` (after phase ${String(entry.afterPhase)})`;
    diagnostics.push({
      severity: 'info',
      message:
        `"${entry.line}"${where} is not a phase heading — its section was skipped. ` +
        `A phase is \`${PHASE_HEADER_SHAPE}\`, and the number must be a whole number`,
    });
  }
  // A DEPENDENCY LINE THAT NAMED SOMETHING AND RESOLVED TO NOTHING IS SAID OUT
  // LOUD (#1823). It used to compile to `[]` — "depends on nothing" — which is
  // the strongest claim available, so the phase went into wave 1 alongside the
  // phases it had just named as prerequisites. It now takes the sequential
  // fallback, which over-orders rather than under-orders, and says so.
  for (const entry of unreadableDependencies) {
    diagnostics.push({
      severity: 'info',
      message:
        `phase ${String(entry.phase)}: could not read any phase from "${entry.line}" — ` +
        `assuming it follows the previous phase; write \`**Dependencies**: Phase 2, Phase 3\`, ` +
        `\`2, 3\`, or \`none\``,
    });
  }
  // A PHASE WITH NO TASKS IS SAID OUT LOUD (#1821). The parser reads three task
  // shapes now, but a fourth will be invented the next time a template is
  // reworded, and the failure mode is the quietest one this compiler has: the
  // artifact is documented as `/execute-plan`'s orchestration source of truth,
  // so a phase that compiles to `tasks: []` enters the pipeline with nothing to
  // do and nothing to verify, while both the compile output and the artifact
  // report success. Eleven of this repo's 44 plans were in that state.
  // Informational, not a refusal: a genuinely empty phase is legal, and a
  // refusal here would break every plan that has one.
  for (const entry of tasklessPhases) {
    diagnostics.push({
      severity: 'info',
      message:
        `phase ${String(entry.phase)} ("${entry.name}") compiled with no tasks — ` +
        `nothing will run or be verified for it. A task is \`- [ ] <name>\`, ` +
        `\`- **Task <n>.<m>** — <name>\`, or a numbered item under \`**Tasks**:\``,
    });
  }
  // A CHANGE NOTE THAT COULD NOT BE READ IS SAID OUT LOUD. It is not in the
  // artifact's notes, so `/execute-plan` would neither build it nor leave it
  // out on purpose — the person compiling has to hear that it was skipped.
  for (const entry of unreadableNotes) {
    const which = entry.n === undefined ? '' : ` ${String(entry.n)}`;
    diagnostics.push({
      severity: 'info',
      message: `change note${which} at line ${String(entry.line)} could not be read — ${entry.reason}`,
    });
  }
  const phaseOverrides = resolvePhaseOverrides(overrides, phaseNumbers, diagnostics);
  const verifyOverrides = resolveTaskOverrides(overrides, taskKeys, phaseNumbers, diagnostics);

  const runPhases: RunPhase[] = phases.map((phase) => {
    const phaseOverride = phaseOverrides.get(phase.number);
    return {
      number: phase.number,
      name: phase.name,
      complexity: phase.complexity,
      dependencies: [...phase.dependencies],
      model: phaseOverride?.model ?? modelByPhase.get(phase.number) ?? MOST_CAPABLE_MODEL,
      skip: phaseOverride?.skip ?? false,
      tasks: phase.tasks.map((task) => ({
        index: task.index,
        name: task.name,
        verify:
          verifyOverrides.get(`${phase.number}.${task.index}`) ??
          task.verify_command,
      })),
      notes: (phase.notes ?? []).map(
        (note): RunNote => ({ n: note.n, kind: note.kind, target: note.target.raw, status: note.status }),
      ),
    };
  });

  return {
    version: RUN_SCRIPT_VERSION,
    plan: planName,
    planHash: hashPlanContent(planContent),
    phases: runPhases,
    waves,
    routing,
    commitStrategy: DEFAULT_COMMIT_STRATEGY,
    overrides,
    diagnostics: [...diagnostics].sort(compareDiagnostics),
    notes: countNotes(notes),
  };
}

// ── serialization ────────────────────────────────────────

/** Serialize one task with a canonical, stable key order. */
function serializeTask(task: RunTask): Record<string, unknown> {
  return { index: task.index, name: task.name, verify: task.verify };
}

/** Serialize one phase with a canonical, stable key order. */
function serializePhase(phase: RunPhase): Record<string, unknown> {
  return {
    number: phase.number,
    name: phase.name,
    complexity: phase.complexity,
    dependencies: phase.dependencies,
    model: phase.model,
    skip: phase.skip,
    tasks: phase.tasks.map(serializeTask),
    // Absent only on an artifact compiled before notes existed — kept absent,
    // never invented, so re-serializing an old artifact changes nothing.
    ...(phase.notes === undefined
      ? {}
      : {
          notes: phase.notes.map((note) => ({ n: note.n, kind: note.kind, target: note.target, status: note.status })),
        }),
  };
}

/** Serialize one wave group with a canonical, stable key order. */
function serializeWave(wave: WaveGroup): Record<string, unknown> {
  return { wave_number: wave.wave_number, phase_numbers: wave.phase_numbers };
}

/** Serialize one routing tier with a canonical, stable key order. */
function serializeTier(tier: ModelTier): Record<string, unknown> {
  return {
    phase: tier.phase,
    complexity: tier.complexity,
    tier: tier.tier,
    model: tier.model,
  };
}

/** Rebuild a record with lexicographically sorted keys and mapped values. */
function sortedRecord<T>(
  record: Record<string, T>,
  serializeValue: (value: T) => Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = serializeValue(record[key]);
  }
  return out;
}

/** Serialize the overrides block with sorted keys and stable value key order. */
function serializeOverrides(overrides: RunOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (overrides.phases !== undefined) {
    out.phases = sortedRecord(overrides.phases, (override) => {
      const value: Record<string, unknown> = {};
      if (override.model !== undefined) {
        value.model = override.model;
      }
      if (override.skip !== undefined) {
        value.skip = override.skip;
      }
      return value;
    });
  }
  if (overrides.tasks !== undefined) {
    out.tasks = sortedRecord(overrides.tasks, (override) => {
      const value: Record<string, unknown> = {};
      if (override.verify !== undefined) {
        value.verify = override.verify;
      }
      return value;
    });
  }
  return out;
}

/**
 * Deterministically serialize a `RunScript` to JSON: fixed top-level and
 * nested key order (plain object literals in declaration order), 2-space
 * indent, trailing newline, diagnostics sorted lexicographically. Same
 * script → byte-identical output.
 */
export function serializeRunScript(script: RunScript): string {
  const out = {
    version: script.version,
    plan: script.plan,
    planHash: script.planHash,
    phases: script.phases.map(serializePhase),
    waves: script.waves.map(serializeWave),
    routing: script.routing.map(serializeTier),
    commitStrategy: script.commitStrategy,
    overrides: serializeOverrides(script.overrides),
    diagnostics: [...script.diagnostics]
      .sort(compareDiagnostics)
      .map((diagnostic) => ({
        severity: diagnostic.severity,
        message: diagnostic.message,
      })),
    ...(script.notes === undefined
      ? {}
      : {
          notes: {
            total: script.notes.total,
            accepted: script.notes.accepted,
            rejected: script.notes.rejected,
            unreviewed: script.notes.unreviewed,
          },
        }),
  };
  return `${JSON.stringify(out, null, JSON_INDENT)}\n`;
}
