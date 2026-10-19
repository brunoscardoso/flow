/**
 * Where a loop's pipeline stands — derived, never stored.
 *
 * A consumer run does not remember anything between runs: it is a fresh
 * headless run that READS state. So "where am I" has to be a function of the
 * artifacts the project already keeps — `flow/STATE.md`, the compiled run
 * artifact (`<plan>.run.json` with its `planHash` lineage) and the
 * `phase_result` entries in `flow/.rounds.jsonl`. Nothing here writes a second
 * copy of that answer, because a second copy is a thing that can disagree with
 * the first, and the disagreement would surface as a run re-running a stage the
 * rounds record already shows finished.
 *
 * PURE CORE, I/O AT ONE EDGE. `deriveStage`, `evaluateStall` and the two state
 * transforms are functions of their inputs and an injected `now`;
 * `readPipelineInput` is the ONLY function in this module that touches the
 * filesystem. That is the same discipline `next.ts` follows, and it is what
 * makes a stage assertion a constant rather than a fixture-dependent guess.
 *
 * WHICH PLAN, AND FROM WHERE. Every lookup below is keyed by a plan NAME, and
 * that name has exactly ONE source: the `loop-plan:` record on a claim
 * (`claimedPlan`, threaded in by the caller). `flow/STATE.md` used to be a
 * fallback source, and that is retired: the interactive session writes that
 * file too, so a loop with nothing claimed read a human's unrelated plan back
 * as its own pipeline — `STATE.md` is a mirror for a person, never the link
 * between two runs (#1599). Its `Active Skill` survives only as a stage
 * REFINEMENT for a plan a claim already named.
 * With NEITHER source the name is empty and the stage is `none`: nothing here
 * scans `flow/discovery/` or `flow/plans/` for a document to name it, which with
 * 10+ finished features on disk would report an arbitrary one as permanently in
 * flight (C-2). A plan name is recorded, or it is absent — never guessed.
 *
 * ONE POLICY LIVES HERE, IN CODE (allowed-pattern #14): which of
 * `none | discovery | plan | wave N of M | review` a pipeline is at. The run
 * artifact is authoritative for execution; the documents on disk are
 * authoritative upstream of it; `STATE.md`'s `Active Skill` only breaks ties
 * neither of those answers.
 *
 * WHAT PHASE 6 TOOK OUT OF IT: the stalled-pipeline policy (resume counting,
 * abandonment) and the awaiting-approval pause. Both were SUPERVISION — they
 * existed so something outside a run could notice it failing at the same stage
 * over and over and take the machinery back. The supervisor was the daemon's
 * loop task and finalizer, deleted in Phase 5; a policy with nobody left to
 * enforce it is a rule that reads as true and never fires. The escalation pause
 * moved to `loop-state.ts`, beside the other pauses, because that is all it ever
 * wrote.
 *
 * WHAT STAYED, AND WHY: the derivation itself. "Is a pipeline stage in flight"
 * is what tells `loop log --record` that a run holding a claim ended HONESTLY —
 * it handed the stage to the next run rather than abandoning the item. That is a
 * queue invariant enforced in code (allowed-pattern #14), and it is the reason
 * this module is a split rather than a deletion.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readRoundsEntries } from '../state/rounds-reader.js';
import { evaluateResume } from '../state/resume-evaluator.js';
import { readRunScript } from '../state/run-script-store.js';
import { parseStateMd } from '../state/state-md-parser.js';
import type { RoundsEntry } from '../state/rounds-reader.js';
import type { ExecutionState, RunScript } from '../state/types.js';

// ── the stage vocabulary ─────────────────────────────────

/**
 * Which stage of the project's own pipeline a loop is at.
 *
 * `wave` is one kind rather than one per wave number: the wave INDEX is data
 * (`wave` / `waves`), not a separate state, so a plan gaining a wave does not
 * gain a stage kind.
 */
export type PipelineStageKind = 'none' | 'discovery' | 'plan' | 'wave' | 'review';

/** Every stage kind, for validation and exhaustiveness. */
export const PIPELINE_STAGE_KINDS: readonly PipelineStageKind[] = [
  'none',
  'discovery',
  'plan',
  'wave',
  'review',
];

/** Whether a value is a known stage kind. */
export function isPipelineStageKind(value: string): value is PipelineStageKind {
  return (PIPELINE_STAGE_KINDS as readonly string[]).includes(value);
}

/**
 * Which input NAMED the plan this stage is about.
 *
 * Reported so a run that is resuming can say WHY it believes there is a pipeline
 * in flight. `claim` means it came from the item a run is holding — the only
 * source that can dispatch work. `'state'` is RETIRED as a producible value:
 * `STATE.md` no longer names a plan (the handoff rides the claim, #1599 — the
 * interactive session writes that file too, and its plan is not the queue's).
 * It stays in the union so recorded results that carry it still parse, and it
 * renders with the note it always did. `none` means no claim named one — the
 * honest answer that sends the run to claim something new.
 */
export type PipelineStageSource = 'none' | 'claim' | 'state';

/** The half-sentence each source is reported with. Empty for `none`. */
export function stageSourceNote(source: PipelineStageSource): string {
  switch (source) {
    case 'claim':
      return 'from the claim';
    case 'state':
      return 'from flow/STATE.md';
    case 'none':
      return '';
  }
}

/** Where a pipeline stands, as every surface reports it. */
export interface PipelineStage {
  kind: PipelineStageKind;
  /** One line, always non-empty — printable verbatim in a log, a panel or a PR. */
  label: string;
  /** Normalized plan name, or '' when no plan is named. */
  plan: string;
  /** 1-based wave number. 0 when the stage is not a wave. */
  wave: number;
  /** How many waves the compiled artifact has. 0 when it is not compiled yet. */
  waves: number;
  /** Phases still to run, ascending. Empty when nothing is compiled. */
  pendingPhases: number[];
  /** Phases already complete (or skipped), ascending. */
  completedPhases: number[];
  /**
   * Whether the rounds record establishes `planHash` lineage for this artifact.
   * False means resume proved nothing — every phase reads as pending, which is
   * the conservative direction (`resume-evaluator.ts`).
   */
  lineage: boolean;
  /** Whether anything is in flight at all — `kind !== 'none'`. */
  inFlight: boolean;
  /** Which input named `plan` — the claim, `STATE.md`, or neither. */
  source: PipelineStageSource;
}

/** Everything `deriveStage` reads. No I/O, no clock. */
export interface PipelineInput {
  /** Parsed `flow/STATE.md`, or null when there is none. */
  state: ExecutionState | null;
  /**
   * The plan recorded on the loop's own claim (`loop-plan:`), or ''.
   *
   * THE ONLY SOURCE. A consumer run remembers nothing between runs, so the
   * handoff has to be something on disk — and the item a run is holding is a
   * record both runs already read. Empty means no claim names a plan, which
   * means no pipeline: `state` below refines a claim-named stage and never
   * substitutes for one.
   */
  claimPlan: string;
  /** The compiled run artifact for the active plan, or null when uncompiled. */
  script: RunScript | null;
  /** Every parsed line of `flow/.rounds.jsonl`. */
  rounds: RoundsEntry[];
  /** Whether `flow/discovery/discovery_<plan>_v*.md` exists. */
  discoveryDocExists: boolean;
  /** Whether `flow/plans/plan_<plan>_v*.md` exists. */
  planDocExists: boolean;
}

/** The stage a project with nothing in flight is at. */
export function idleStage(): PipelineStage {
  return {
    kind: 'none',
    label: 'no pipeline in flight',
    plan: '',
    wave: 0,
    waves: 0,
    pendingPhases: [],
    completedPhases: [],
    lineage: false,
    inFlight: false,
    source: 'none',
  };
}

/**
 * Which of a queue's items names the plan this loop's pipeline is on, or ''.
 *
 * NEVER GUESSES, and that is the whole contract. A run holds an item; entering a
 * stage records the plan on it; so the plan is read back from the items the loop
 * already has open. Three things can be true and only two of them are an answer:
 *
 *   - exactly one open item names a plan — that is the pipeline
 *   - several name the SAME plan (a stalled run gave its item back mid-pipeline,
 *     which deliberately leaves the record on it) — still one answer
 *   - several name DIFFERENT plans and none is this run's own claim — no answer.
 *     Picking one would be the scan-and-hope this module exists to refuse; ''
 *     means no claim names a pipeline, and the stage is `none`.
 *
 * `owner` breaks the tie when this run holds one of them, which is the case that
 * matters: the run's own claim outranks a ghost another run left behind.
 */
export function claimedPlan(
  items: readonly { state: string; plan?: string; claimedBy?: string }[],
  owner?: string,
): string {
  const named = items
    .filter((item) => item.state === 'open')
    .map((item) => ({ ...item, named: normalizePlanName(item.plan) }))
    .filter((item) => item.named.length > 0);
  if (named.length === 0) return '';

  const holder = owner?.trim() ?? '';
  const mine = holder.length === 0 ? [] : named.filter((item) => item.claimedBy === holder);
  if (mine.length > 0) {
    const distinct = new Set(mine.map((item) => item.named));
    // One run holding two pipelines is not a thing the verbs can produce, so a
    // disagreement here is corruption — and refusing is the safe direction.
    return distinct.size === 1 ? mine[0].named : '';
  }

  const distinct = new Set(named.map((item) => item.named));
  return distinct.size === 1 ? named[0].named : '';
}

// ── normalization ────────────────────────────────────────

/**
 * `STATE.md`'s `Active Plan` → the plan name the run artifact is keyed by.
 *
 * A plan is written as `flow/plans/plan_<name>_v<N>.md` and compiles to
 * `flow/plans/<name>.run.json`, so both spellings have to normalize to the same
 * `<name>` — otherwise a STATE.md that happens to record the filename would
 * silently find no artifact and report the pipeline as uncompiled.
 */
export function normalizePlanName(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (value.length === 0) return '';
  const lowered = value.toLowerCase();
  // The placeholders STATE.md uses for "nothing" — all of them mean no plan.
  if (lowered === 'none' || lowered === 'null' || lowered === 'n/a' || lowered === '-') {
    return '';
  }
  return value
    .replace(/\.md$/i, '')
    .replace(/^plan_/i, '')
    .replace(/_v\d+$/i, '');
}

/**
 * `STATE.md`'s `Active Skill` → the stage word it implies, or ''.
 *
 * Matched by substring on purpose: the field is written by a skill, not by a
 * parser, and shows up as `execute-plan`, `/execute-plan` and
 * `execute-plan (phase 3)` in real files.
 */
export function skillStage(raw: string | null | undefined): '' | 'discovery' | 'plan' | 'wave' | 'review' {
  const value = (raw ?? '').trim().toLowerCase();
  if (value.length === 0 || value === 'none' || value === 'null') return '';
  if (value.includes('review')) return 'review';
  if (value.includes('execute-plan') || value.includes('execute plan')) return 'wave';
  if (value.includes('create-plan') || value.includes('create plan')) return 'plan';
  if (value.includes('discovery')) return 'discovery';
  return '';
}

// ── stage derivation ─────────────────────────────────────

/** The wave holding the first pending phase, and how many waves there are. */
function locateWave(script: RunScript, pending: readonly number[]): { wave: number; waves: number } {
  const pendingSet = new Set(pending);
  const waves = [...script.waves].sort((a, b) => a.wave_number - b.wave_number);
  if (waves.length > 0) {
    const index = waves.findIndex((wave) =>
      wave.phase_numbers.some((phase) => pendingSet.has(phase)),
    );
    // A pending phase in no wave at all (a malformed artifact) reads as the
    // first wave rather than as "no wave" — the run still has work to do.
    return { wave: index >= 0 ? waves[index].wave_number : waves[0].wave_number, waves: waves.length };
  }
  // No wave grouping: every phase is its own wave, in phase order.
  const phases = [...script.phases].sort((a, b) => a.number - b.number);
  const index = phases.findIndex((phase) => pendingSet.has(phase.number));
  return { wave: index >= 0 ? index + 1 : 1, waves: phases.length };
}

/** The printable line for a stage. */
function stageLabel(kind: PipelineStageKind, plan: string, wave: number, waves: number): string {
  const suffix = plan.length === 0 ? '' : ` — plan ${plan}`;
  switch (kind) {
    case 'none':
      return 'no pipeline in flight';
    case 'discovery':
      return `discovery${suffix}`;
    case 'plan':
      return `plan${suffix}`;
    case 'wave':
      return `wave ${wave} of ${waves === 0 ? '?' : waves}${suffix}`;
    case 'review':
      return `review${suffix}`;
  }
}

/**
 * Where the pipeline stands.
 *
 * WHICH PLAN comes first, because every branch below is keyed by it: the run's
 * own claim, then `STATE.md`, then nothing. `source` records which answered, and
 * it is reported rather than inferred — a run resuming a stage has to be able to
 * say why it believes there is one, and "the file said so" and "the item I am
 * holding said so" are different levels of evidence (#1599).
 *
 * PRECEDENCE of the STAGE, and the reason for it:
 *
 *   1. The COMPILED ARTIFACT is authoritative for execution. It knows the waves
 *      and, with the rounds record, which phases are done — no other source
 *      can answer "wave 2 of 4", and `STATE.md` would only ever be a stale
 *      restatement of it.
 *   2. Without an artifact, the DOCUMENTS ON DISK are authoritative: a plan
 *      document means the plan stage produced its output (so the next stage is
 *      execution, uncompiled — `waves: 0`), a discovery document means the
 *      discovery stage did.
 *   3. `STATE.md`'s `Active Skill` breaks ties neither of those answers — it is
 *      the only thing that can say "a review is under way" for a pipeline whose
 *      phases are not the point. It refines the stage of the CLAIM-named plan
 *      only; with no claim there is no pipeline for it to refine (#1599).
 *
 * Nothing in flight at all reads as `none`, which is what a run with no
 * pipeline to resume needs in order to go claim something new.
 */
export function deriveStage(input: PipelineInput): PipelineStage {
  const fromClaim = normalizePlanName(input.claimPlan);
  const plan = fromClaim;
  // THE HANDOFF RIDES THE CLAIM, AND ONLY THE CLAIM (#1599). `STATE.md` used to
  // be a fallback plan source here — "counts as having answered when it named a
  // plan OR a skill" — but that file is a MIRROR the interactive session writes
  // too, so the fallback fabricated pipelines out of a human's unrelated work:
  // a loop run with nothing claimed read the session's windows_support state
  // and was dispatched to "advance" waves that were never the queue's. The
  // skill line survives only as a REFINEMENT for a plan a claim already named
  // (it is still the one thing that can say "a review is under way" for that
  // plan); with no claim there is no pipeline, and `none` is what sends a run
  // off to claim something new instead of resuming work nothing can name.
  const skill = fromClaim.length > 0 ? skillStage(input.state?.active_skill) : '';
  const source: PipelineStageSource = fromClaim.length > 0 ? 'claim' : 'none';

  if (input.script !== null) {
    const script = input.script;
    const resume = evaluateResume(script, input.rounds);
    const pendingPhases = resume.filter((phase) => phase.state === 'pending').map((phase) => phase.phase);
    const completedPhases = resume
      .filter((phase) => phase.state === 'complete')
      .map((phase) => phase.phase);
    const lineage = input.rounds.some(
      (entry) =>
        (entry.type === 'run_intent' || entry.type === 'phase_result') &&
        entry.planHash === script.planHash,
    );
    const named = plan.length === 0 ? normalizePlanName(script.plan) : plan;

    if (pendingPhases.length === 0) {
      return {
        kind: 'review',
        label: stageLabel('review', named, 0, 0),
        plan: named,
        wave: 0,
        waves: script.waves.length,
        pendingPhases,
        completedPhases,
        lineage,
        inFlight: true,
        source,
      };
    }
    const located = locateWave(script, pendingPhases);
    return {
      kind: 'wave',
      label: stageLabel('wave', named, located.wave, located.waves),
      plan: named,
      wave: located.wave,
      waves: located.waves,
      pendingPhases,
      completedPhases,
      lineage,
      inFlight: true,
      source,
    };
  }

  // NO PLAN, NO PIPELINE. The document flags below are keyed on the plan name
  // by `readPipelineInput`, so they cannot be true without one there — but this
  // function is pure and callable with any input, and a doc flag with no plan
  // must not manufacture a stage for a pipeline nothing can name.
  if (plan.length === 0) {
    return idleStage();
  }

  // No artifact — upstream of execution, or a review of work that never compiled.
  if (skill === 'review') {
    return { ...idleStage(), kind: 'review', label: stageLabel('review', plan, 0, 0), plan, inFlight: true, source };
  }
  if (input.planDocExists || skill === 'wave') {
    // The plan exists but nothing has compiled it yet: the next run compiles
    // and runs wave 1. `waves: 0` says the total is not knowable yet rather
    // than pretending it is 1.
    return { ...idleStage(), kind: 'wave', label: stageLabel('wave', plan, 1, 0), plan, wave: 1, inFlight: true, source };
  }
  if (input.discoveryDocExists || skill === 'plan') {
    return { ...idleStage(), kind: 'plan', label: stageLabel('plan', plan, 0, 0), plan, inFlight: true, source };
  }
  if (skill === 'discovery' || plan.length > 0) {
    return {
      ...idleStage(),
      kind: 'discovery',
      label: stageLabel('discovery', plan, 0, 0),
      plan,
      inFlight: true,
      source,
    };
  }
  return idleStage();
}

/**
 * A stable key identifying one stage across runs — what the stall counter
 * compares. The plan and the wave number are part of it, so advancing a wave
 * resets the counter without anyone having to clear it.
 */
export function stageKey(stage: PipelineStage): string {
  if (stage.kind === 'none') return 'none';
  if (stage.kind === 'wave') return `wave:${stage.plan}:${stage.wave}`;
  return `${stage.kind}:${stage.plan}`;
}

// ── the I/O edge ─────────────────────────────────────────

/** Whether `dir` holds a `<prefix>_v<N>.md` document. Fail-soft: absent → false. */
function documentExists(dir: string, prefix: string): boolean {
  if (prefix.length === 0 || !existsSync(dir)) return false;
  try {
    return readdirSync(dir).some(
      (name) => name.startsWith(`${prefix}_v`) && name.endsWith('.md'),
    );
  } catch {
    // Sanctioned fail-soft: an unreadable directory is not a document
    return false;
  }
}

/**
 * Read everything `deriveStage` needs from a flow directory. The ONLY function
 * in this module that touches disk — every judgment above it is pure.
 *
 * `claimPlan` is the plan the caller's own claim records (`claimedPlan` over the
 * queue it already listed), and it WINS over `STATE.md` — the file is a mirror
 * for a person to read, not the link between two runs. The queue read stays with
 * the caller on purpose: this module's one I/O edge is the filesystem, and a
 * network round-trip behind a function named `read…Input` is how a fail-soft
 * path acquires a way to hang.
 *
 * WITH NEITHER SOURCE NOTHING IS LOOKED UP. An empty name means the lookups are
 * skipped outright rather than run with an empty prefix — `plan_` would match no
 * document today, but a lookup keyed by nothing is one refactor away from
 * matching every document, which is the failure C-2 rules out.
 */
export function readPipelineInput(flowDir: string, claimPlan = ''): PipelineInput {
  const state = parseStateMd(flowDir);
  const fromClaim = normalizePlanName(claimPlan);
  // THE PLAN IS THE CLAIM'S, PERIOD (#1599's own doctrine, finally applied to
  // the lookups too). `STATE.md` is written by the INTERACTIVE session as well,
  // so keying the artifact and document lookups on its `Active Plan` handed a
  // loop run somebody else's pipeline, waves and all — the live instance was a
  // human's half-finished windows_support execution read back as "wave 2 is
  // mine to advance", which the run then had to refuse by judgment.
  const plan = fromClaim;
  return {
    state,
    claimPlan: fromClaim,
    script: plan.length === 0 ? null : readRunScript(flowDir, plan),
    rounds: readRoundsEntries(flowDir),
    discoveryDocExists:
      plan.length === 0 ? false : documentExists(join(flowDir, 'discovery'), `discovery_${plan}`),
    planDocExists:
      plan.length === 0 ? false : documentExists(join(flowDir, 'plans'), `plan_${plan}`),
  };
}

/** Read the flow directory and derive the stage in one call. */
export function readStage(flowDir: string, claimPlan = ''): PipelineStage {
  return deriveStage(readPipelineInput(flowDir, claimPlan));
}
