/**
 * The refusal half of autopilot — `planflow-ai flow stage <stage> --check`.
 *
 * Autopilot is two mechanisms. A DRIVER issues the next rung; this is the
 * REFUSAL that makes the wrong rung impossible. They are deliberately not the
 * same thing: a driver that is careful is a driver that can be careless
 * tomorrow, and the whole reason autopilot never worked was that its ordering
 * lived in prose four command files agreed to remember. The ladder is data
 * (`../state/workflow-stages.ts`), the proofs are artifacts a stage inevitably
 * leaves behind, and this module is the gate that reads them.
 *
 * NO MODEL CALL ENTERS A VERB (`src/cli/commands/loop.ts:938`). Every judgement
 * here is a file that is there or is not, read through `StageProofDeps`. The
 * CLI reports; the agent decides what to do about it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT GUARDS: THE IMMEDIATE PREDECESSOR, NOT THE WHOLE LADDER
 *
 * `flow stage execute-plan` asks one question — did `create-plan` leave proof
 * for THIS feature — and not "is every rung below me done". The stricter
 * reading is available (`done` and `next` ride along in every payload) and is
 * deliberately not the gate: a plan that ran its phases but whose document was
 * later edited into something the parser cannot read would have its REVIEW
 * refused, which blocks work over a rung that demonstrably happened. The
 * ladder's own header calls that direction the worse one, and it is right.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO MODES, ONE COMPUTATION (discovery R3)
 *
 * The verdict is computed ONCE, by `evaluateStageCheck`, and the mode decides
 * only whether it refuses:
 *
 *   - ENFORCED — the call carries the chain's id, so a chain is driving. A
 *     missing proof is a `flow refused:` line and exit 1.
 *   - REPORTING — no chain id. The SAME verdict is emitted, exit 0, nothing
 *     refused. A person running `/create-plan` by hand against a year-old
 *     discovery is never refused into a corner; enforcement is a property of
 *     the enforced run, not a new law for everybody.
 *
 * The mode is a TAGGED VALUE (`StageCheckMode`), not "is the chain string
 * empty". A mode inferred from an absent field is a mode that flips when a
 * caller forgets an argument, and the direction it flips in — silently
 * enforcing, or silently not — is exactly the thing nobody would notice.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * "THERE IS NO PLAN" WHEN A PLAN IS SITTING RIGHT THERE
 *
 * `plan-parser.ts` requires `### Phase <n>: <title>`, exactly three hashes, and
 * declines to widen (#1809 — accepting `##` would compile this repo's older
 * plans to zero-task phases that enter the pipeline and run nothing, silently).
 * Six of `plan_harness-autopilot_v1.md`'s headings are `##`. So the plan that
 * ASKED FOR THIS MODULE does not parse, and a gate that reported "there is no
 * plan" would send its author to write one that already exists.
 *
 * So a near miss is a DISTINCT refusal reason carrying `whyNoPhases`'s
 * author-actionable sentence (allowed-pattern #21 — a refusal that asks a
 * question carries its own answer). `predecessor-missing` and
 * `predecessor-unreadable` are different problems with different remedies and
 * this verb says which it found.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HUMAN FIELDS AND DIAGNOSTIC FIELDS ARE SEPARATE ON PURPOSE
 *
 * `StageProof` carries `parser`, `reader` and `why`, which name real source
 * paths. That is right for a terminal refusal and forbidden in Flow IDE text
 * (forbidden-pattern #12 — never hand a GUI reader the app's internals and ask
 * them to finish the job). So the payload keeps them behind `diagnostic`, and
 * everything a person should read — `message`, `expected`, `found`,
 * `diagnosis` — sits at the top level. A GUI consumer picking the top level
 * cannot accidentally render a module path.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { enforcementModeOf } from '../state/enforcement-mode.js';
import { parsePlan, whyNoPhases } from '../state/plan-parser.js';
import { readRoundsEntries } from '../state/rounds-reader.js';
import {
  PLANS_DIR,
  WORKFLOW_STAGES,
  previousStage,
  proofDescriptionFor,
  proofOf,
  stageOf,
  stagesCompleted,
} from '../state/workflow-stages.js';
import type { EnforcementMode } from '../state/enforcement-mode.js';
import type {
  ProofKind,
  ProofStrength,
  StageEvidence,
  StageNearMiss,
  StageProof,
  StageProofDeps,
  WorkflowStage,
} from '../state/workflow-stages.js';

/** Why a stage may not run. `null` on the success path. */
export type StageRefusalReason = 'predecessor-missing' | 'predecessor-unreadable';

/**
 * Whether this call is a chain driving, or a person asking.
 *
 * A tagged union rather than an optional string: see the header. `enforced`
 * cannot exist without the chain that justifies it.
 *
 * THE SAME VALUE EVERY GATE IN THIS FAMILY USES. It is the shared
 * `EnforcementMode` under its original name, not a copy of it — `flow risk`
 * asks the identical question of the identical argument, and two definitions
 * that agree today are how two gates stop agreeing tomorrow
 * (allowed-pattern #14).
 */
export type StageCheckMode = EnforcementMode;

/**
 * The developer-facing half of a verdict — names source modules.
 *
 * NEVER RENDER THIS IN A GUI (forbidden-pattern #12). It exists so a terminal
 * refusal can say which module did the reading, and so that a GUI consumer
 * choosing the top-level fields cannot pick one of these by accident.
 */
export interface StageCheckDiagnostic {
  /** How the predecessor's proof is obtained. */
  proofKind: ProofKind;
  /** How much that proof is worth — presence, or content that was understood. */
  proofStrength: ProofStrength;
  /** The module that reads it, when there is one. */
  module: string | null;
  /** Why this artifact and not a bookkeeping file — the proof table's rationale. */
  why: string;
}

/** One stage's verdict. Computed once; rendered two ways; refused in one mode. */
export interface StageCheckVerdict {
  stage: WorkflowStage;
  feature: string;
  /** The rung this one depends on. `null` for `discovery`, the bottom rung. */
  previous: WorkflowStage | null;
  /** Whether the stage may run. */
  satisfied: boolean;
  /** Why not, when not. */
  reason: StageRefusalReason | null;
  /** One sentence a person can act on. Human-facing. */
  message: string;
  /** What would satisfy the predecessor. Human-facing. `null` at the bottom rung. */
  expected: string | null;
  /** The artifact that was found and proved nothing. Human-facing. */
  found: string | null;
  /** Why that artifact proved nothing, in its author's terms. Human-facing. */
  diagnosis: string | null;
  /** Rungs with proof for this feature, in ladder order. */
  done: WorkflowStage[];
  /** One entry per completed rung — what answered, and how strong it was. */
  evidence: StageEvidence[];
  /** The first rung without proof, or `null` when the chain is finished. */
  next: WorkflowStage | null;
  /** See `StageCheckDiagnostic`. `null` at the bottom rung. */
  diagnostic: StageCheckDiagnostic | null;
  /** Which question was asked — enforcing, or reporting. */
  mode: StageCheckMode['mode'];
  /** The chain driving this call, or `null` for a manual one. */
  chain: string | null;
}

/**
 * The refusal payload — the verdict, plus the reason code at the front.
 *
 * `refused` first, matching `worktree refused: unbound` (allowed-pattern #21):
 * the consumer that only wants to know WHAT happened reads one field, and the
 * consumer that wants to ask the person about it has the rest already.
 */
export interface StageCheckRefusalPayload extends StageCheckVerdict {
  refused: StageRefusalReason;
  verb: 'stage';
}

/**
 * A refusal that carries its own answer.
 *
 * Thrown by the verb and caught by `runFlow`, which writes `payload` to stdout
 * and then the one `flow refused:` line — prose after payload, on the same
 * stream, exactly as allowed-pattern #24 says consumers should expect it.
 */
export class StageCheckRefusal extends Error {
  readonly payload: StageCheckRefusalPayload;

  constructor(payload: StageCheckRefusalPayload) {
    super(payload.message);
    this.name = 'StageCheckRefusal';
    this.payload = payload;
  }
}

/**
 * The real readers — the ONLY filesystem in the ladder.
 *
 * Fail-soft on READ, never on LOGIC: a missing directory is `[]` and an
 * unreadable plan is `null`, because "the artifact is not there" and "the
 * artifact could not be opened" are the same answer to the question the ladder
 * asks. A malformed rounds line is already skipped by `readRoundsEntries`.
 */
export function stageProofDeps(flowDir: string): StageProofDeps {
  return {
    listFiles(dir: string): readonly string[] {
      try {
        return readdirSync(join(flowDir, dir));
      } catch {
        return [];
      }
    },
    readRounds: () => readRoundsEntries(flowDir),
    parsePlan(filename: string) {
      try {
        return parsePlan(join(flowDir, PLANS_DIR, filename));
      } catch {
        return null;
      }
    },
  };
}

/**
 * The mode this call is in — the one place the chain id becomes a decision.
 *
 * `enforcementModeOf` under this module's original name, kept so the stage
 * gate's callers read in stage vocabulary while there remains exactly one
 * implementation (`../state/enforcement-mode.ts`).
 */
export const stageCheckModeOf = enforcementModeOf;

/** Every spelling of a stage this verb accepts, for the unknown-stage refusal. */
export function stageVocabulary(): string {
  return WORKFLOW_STAGES.join('|');
}

/**
 * The stage a caller named, or a throw naming what it should have been.
 *
 * `stageOf` tolerates the slash and the case, so `/create-plan` and
 * `Create-Plan` are the same request as `create-plan` — the driver passes what
 * it is about to run, which is a slash command.
 */
export function requireStage(named: string): WorkflowStage {
  const stage = stageOf(named);
  if (stage === null) {
    throw new Error(`unknown stage '${named}' — expected ${stageVocabulary()}`);
  }
  return stage;
}

/** The module that reads a proof, when reading is involved. `null` for presence. */
function readingModuleFor(proof: StageProof): string | null {
  if (proof.kind === 'parse') return proof.parser;
  if (proof.kind === 'rounds') return proof.reader;
  return null;
}

/** The diagnostic half of a proof, flattened for the payload. */
function diagnosticFor(stage: WorkflowStage): StageCheckDiagnostic {
  const proof = proofOf(stage);
  return {
    proofKind: proof.kind,
    proofStrength: proof.strength,
    module: readingModuleFor(proof),
    why: proof.why,
  };
}

/**
 * The author-actionable sentence for a plan document that did not parse.
 *
 * `stagesCompleted` reports a near miss with a generic `why` — it has no
 * filesystem and so cannot read the file twice. This is where the file is
 * already reachable, so the diagnosis comes from `whyNoPhases`, the ONE place
 * that sentence is composed (allowed-pattern #14). Falls back to the ladder's
 * generic reason when the file cannot be re-read, which is the honest answer:
 * something is there and it did not prove anything.
 */
function diagnose(flowDir: string, nearMiss: StageNearMiss): string {
  try {
    return whyNoPhases(readFileSync(join(flowDir, nearMiss.detail), 'utf-8'));
  } catch {
    return nearMiss.why;
  }
}

/** What `evaluateStageCheck` needs besides the readers. */
export interface StageCheckRequest {
  stage: WorkflowStage;
  feature: string;
  mode: StageCheckMode;
}

/**
 * The verdict — THE one computation.
 *
 * Both modes call this and neither one has an opinion the other lacks; the
 * refusal is a formatting decision taken afterwards, on the same object. Pure
 * apart from `deps` and the near-miss re-read, so the whole gate is testable
 * against a fixture with no project on disk.
 */
export function evaluateStageCheck(
  deps: StageProofDeps,
  request: StageCheckRequest,
  diagnoseNearMiss: (nearMiss: StageNearMiss) => string,
): StageCheckVerdict {
  const { stage, feature, mode } = request;
  const completion = stagesCompleted(deps, { feature });
  const previous = previousStage(stage);

  const base = {
    stage,
    feature,
    previous,
    done: completion.done,
    evidence: completion.evidence,
    next: completion.next,
    mode: mode.mode,
    chain: mode.chain,
  };

  if (previous === null) {
    return {
      ...base,
      satisfied: true,
      reason: null,
      message: `${stage} is the first rung of the chain — nothing has to have run before it`,
      expected: null,
      found: null,
      diagnosis: null,
      diagnostic: null,
    };
  }

  const expected = proofDescriptionFor(previous, feature);
  const diagnostic = diagnosticFor(previous);

  if (completion.done.includes(previous)) {
    const answered = completion.evidence.find((entry) => entry.stage === previous);
    return {
      ...base,
      satisfied: true,
      reason: null,
      message: `${stage} may run for '${feature}' — ${previous} left ${answered?.detail ?? expected}`,
      expected,
      found: answered?.detail ?? null,
      diagnosis: null,
      diagnostic,
    };
  }

  // A near miss on the PREDECESSOR is the distinct refusal. Near misses on any
  // other rung belong to a different edge and are not this call's business.
  const nearMiss = completion.nearMisses.find((miss) => miss.stage === previous);
  if (nearMiss !== undefined) {
    const diagnosis = diagnoseNearMiss(nearMiss);
    return {
      ...base,
      satisfied: false,
      reason: 'predecessor-unreadable',
      message:
        `${stage} cannot run for '${feature}': ${nearMiss.detail} is there and could not be ` +
        `read as a plan — ${diagnosis}`,
      expected,
      found: nearMiss.detail,
      diagnosis,
      diagnostic,
    };
  }

  return {
    ...base,
    satisfied: false,
    reason: 'predecessor-missing',
    message:
      `${stage} cannot run for '${feature}': ${previous} has left no proof — ` +
      `expected ${expected}`,
    expected,
    found: null,
    diagnosis: null,
    diagnostic,
  };
}

/**
 * The verb's body: compute the verdict, and refuse only when a chain is driving.
 *
 * The refusal is a THROW carrying the payload so that `runFlow`'s one catch
 * keeps owning the family's contract — one `flow refused:` line, exit 1 — and
 * this module never writes to stdout itself.
 */
export function checkStage(
  flowDir: string,
  request: StageCheckRequest,
  deps: StageProofDeps = stageProofDeps(flowDir),
): StageCheckVerdict {
  const verdict = evaluateStageCheck(deps, request, (nearMiss) => diagnose(flowDir, nearMiss));

  if (verdict.satisfied || verdict.mode === 'reporting' || verdict.reason === null) {
    return verdict;
  }

  throw new StageCheckRefusal({ refused: verdict.reason, verb: 'stage', ...verdict });
}

/**
 * The human rendering of a verdict — a SECOND FORMATTER, never a second
 * computation (the family's contract).
 *
 * A reporting-mode call that found a gap says so and says that nothing was
 * refused, because "exit 0 with a complaint" is otherwise indistinguishable
 * from "exit 0, all clear" to the person reading the terminal.
 */
export function renderStageVerdict(verdict: StageCheckVerdict): string[] {
  const lines: string[] = [`flow: ${verdict.message}`];

  // Only when the sentence did not already name it — a `predecessor-missing`
  // message ends in `expected <path>`, and printing it twice reads like two
  // different facts.
  if (verdict.expected !== null && !verdict.satisfied && !verdict.message.includes(verdict.expected)) {
    lines.push(`  expected: ${verdict.expected}`);
  }
  if (verdict.done.length > 0) {
    lines.push(`  done for '${verdict.feature}': ${verdict.done.join(', ')}`);
  }
  if (!verdict.satisfied && verdict.mode === 'reporting') {
    lines.push('  nothing was refused — no chain is driving this call');
  }

  return lines;
}
