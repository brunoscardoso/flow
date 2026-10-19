/**
 * The workflow ladder — discovery → create-plan → execute-plan → review-code.
 *
 * Autopilot has always been PROSE: a config key, plus an "AUTOPILOT MODE CHECK"
 * block pasted into four command files asking the model to please run the next
 * thing. Nothing executed the chain, so nothing could refuse a stage whose
 * predecessor never happened. This module is the pure half of the fix — the
 * ladder as data, so that a verb can refuse an edge and a runtime driver can
 * issue the next rung, both reading the SAME table (allowed-pattern #14). Two
 * mechanisms reading two ladders is how the board loop and the autopilot chain
 * would silently drift apart; there is one ladder and it is here.
 *
 * NO I/O, NO MODEL, NO SIDE EFFECTS. This file imports no filesystem module at
 * all, and it never will: proofs are DESCRIBED here and READ by injected deps
 * (`stagesCompleted` below), which is what makes the whole ladder testable
 * without a filesystem and what keeps every judgement out of the CLI verb
 * (`src/cli/commands/loop.ts:938` — no model call ever enters a verb).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE PROOFS ARE NOT `flow/STATE.md`
 *
 * The obvious answer is "each stage records that it ran", and
 * `.claude/commands/discovery-plan.md` and `create-plan.md` already claim to
 * write `flow/STATE.md`. That answer is wrong, and the reason is the whole
 * point of this feature: STATE.md is written *by a model following prose*.
 * Enforcement that reads it depends on the model having remembered — which is
 * the same prose problem one level down, wearing a filename.
 *
 * So each proof reads what a stage inevitably IS, not what it was asked to
 * record:
 *
 *   | stage        | proof                                          | strength |
 *   |--------------|------------------------------------------------|----------|
 *   | discovery    | `flow/discovery/discovery_<f>_v<N>.md` exists  | weak     |
 *   | create-plan  | `flow/plans/plan_<f>_v<N>.md` PARSES as a plan  | strong   |
 *   | execute-plan | a `phase_result` entry in `flow/.rounds.jsonl`  | strong   |
 *   | review-code  | `flow/reviewed-code/review_<scope>.md` exists   | weak     |
 *
 * TWO OF THE FOUR ARE FILE PRESENCE, AND THIS MODULE SAYS SO rather than
 * implying parity. `strength` is carried on every proof and on every completion
 * this module reports precisely so that a consumer CANNOT treat presence and
 * parse as equal — a `touch` in the discovery directory satisfies the discovery
 * rung, and a person who deletes a discovery file can confuse the chain. That
 * is an accepted cost, taken deliberately against the alternative of depending
 * on bookkeeping a model may skip. A consumer that wants to warn, escalate or
 * ask before trusting a rung has the fact it needs in hand; one that ignores
 * `strength` has ignored it on purpose.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERY PROOF IS BOUND TO A FEATURE
 *
 * The first cut of this module matched ANY feature's artifacts — `discovery_.+`,
 * `plan_.+`, "any `phase_result` entry". Run against this repo that answers
 * every rung `done`: `flow/discovery/` holds ten documents, `flow/plans/` ten,
 * `flow/reviewed-code/` eleven, and `flow/.rounds.jsonl` already carries four
 * `phase_result` entries from the `worktree-ui-removal` plan. `nextStage` came
 * back `null` for a chain that had not started, so THE REFUSAL THIS FEATURE
 * EXISTS FOR COULD NEVER FIRE. A ladder that reports a stage done because
 * somebody, once, ran that stage for something else is worse than no ladder:
 * it is a gate that is always open and looks shut.
 *
 * So the question is "did THIS FEATURE's discovery run", and every proof is
 * scoped by the feature slug: `discovery_<feature>_v<N>.md`,
 * `plan_<feature>_v<N>.md`, `review_<feature>.md`, and a `phase_result` whose
 * `plan` field equals the feature (the rounds record carries the bare slug —
 * verified live: `{"type":"phase_result","plan":"worktree-ui-removal",…}`).
 *
 * THE FEATURE IS NOT OPTIONAL ON THE ENFORCING PATH. `stagesCompleted` requires
 * it, and the loose question lives behind a different NAME —
 * `stagesCompletedForAnyFeature` — rather than behind an absent argument. An
 * optional feature that falls back to the loose match is the same bug as the
 * one above, one level quieter: nobody writing a refusal would choose the loose
 * answer, but plenty would forget to pass the slug. An empty slug THROWS for
 * the same reason: refusing to answer beats answering the wrong question.
 *
 * SEPARATORS ARE NOT NORMALIZED. Real slugs in this repo use both (
 * `worktree-ui-removal`, `file_explorer_content_search`), so the match is
 * literal — and the slug is escaped before it enters a pattern, or a feature
 * containing `.` or `+` would quietly become a wildcard and reopen the gate.
 *
 * KNOWN LIMIT — THE PARSE PROOF IS STRICTER THAN THIS REPO'S PLANS. Measured
 * live: 5 of the 10 documents in `flow/plans/` head their phases `## Phase N`,
 * and `plan-parser.ts` requires `### Phase N` (its own header explains why it
 * declines to widen the heading level). `plan_harness-autopilot_v1.md` — the
 * plan that asked for this module — is one of the five. So a real, complete,
 * currently-executing plan reports `create-plan` NOT done, and an enforcing
 * caller would demand the plan be written again.
 *
 * That is a FALSE REFUSAL: it blocks work, the opposite direction from the weak
 * proofs, and the worse one. This module does not paper over it and does not
 * quietly downgrade the proof — the proof table is a decision taken elsewhere.
 * It reports the near miss instead (`StagesCompletedResult.nearMisses`), so a
 * refusal can say "a plan document is there and could not be read as a plan"
 * rather than "there is no plan" (allowed-pattern #21 — a refusal that asks a
 * question carries its own answer). Whoever wires the refusal decides what to
 * do with that; they cannot fail to see it.
 *
 * KNOWN LIMIT, stated rather than hidden: a review document named for a SCOPE
 * instead of the feature (`review_worktree-implementation.md` against the
 * feature `worktree-mode`) will not be found, and the chain will ask for the
 * review again. That direction is the safe one — a repeated review, never a
 * skipped one — and it is the same accepted cost as the weak proofs above.
 *
 * WHY A `phase_result` OF ANY STATUS COUNTS. `resume-evaluator.ts` filters
 * `status === 'success'` because it is answering "which phases need re-running".
 * This ladder answers a different question — "did the previous stage RUN" — and
 * a phase that ran and failed still ran. Requiring success here would refuse
 * `/review-code` on exactly the changeset most worth reviewing.
 */

import type { PlanPhase } from './types.js';
import type { RoundsEntry } from './rounds-reader.js';

/** One rung of the chain. */
export type WorkflowStage = 'discovery' | 'create-plan' | 'execute-plan' | 'review-code';

/**
 * The ladder, in order. This tuple IS the order — `nextStage` and
 * `previousStage` derive from it, so a fifth stage is one edit here plus a
 * proof entry below, and nothing else.
 */
export const WORKFLOW_STAGES = [
  'discovery',
  'create-plan',
  'execute-plan',
  'review-code',
] as const satisfies readonly WorkflowStage[];

/** How a stage's proof is obtained. */
export type ProofKind = 'file-presence' | 'parse' | 'rounds';

/**
 * How much a proof is worth.
 *
 * `weak` — the artifact's PRESENCE is the whole proof; an empty file passes.
 * `strong` — the artifact's CONTENT was read and found to be what it claims.
 *
 * Carried everywhere a proof or a completion travels. See the header.
 */
export type ProofStrength = 'weak' | 'strong';

/** Directory (relative to the flow directory) holding discovery documents. */
export const DISCOVERY_DIR = 'discovery';
/** Directory (relative to the flow directory) holding active plans. */
export const PLANS_DIR = 'plans';
/** Directory (relative to the flow directory) holding code-review documents. */
export const REVIEWED_CODE_DIR = 'reviewed-code';
/** The append-only execution record, relative to the flow directory. */
export const ROUNDS_FILE = '.rounds.jsonl';

/** The rounds entry type that proves `/execute-plan` ran at least one phase. */
export const EXECUTE_PROOF_ENTRY_TYPE = 'phase_result';

/**
 * What proves a stage ran — a DESCRIPTION, never a filesystem call.
 *
 * A discriminated union rather than one flat record with nullable fields: a
 * consumer that wants the directory has to establish first that the proof is
 * a file at all, which is the distinction the flat shape kept losing.
 */
interface FileProofShape {
  /** Directory relative to the flow directory. */
  dir: string;
  /**
   * Human-readable filename shape with a `<feature>` placeholder.
   * `filenameShapeFor` substitutes it; nothing matches against this string.
   */
  filenameShape: string;
  /** Everything before the feature slug in a filename. */
  filenamePrefix: string;
  /** Regex source for everything after the feature slug (e.g. `_v\\d+\\.md`). */
  filenameSuffixSource: string;
  /**
   * Matches ANY feature's artifact.
   *
   * DO NOT USE THIS FOR A REFUSAL — it is the pattern that reported a fresh
   * chain finished (see the header). It is named to be conspicuous. Refusals
   * want `filenamePatternFor(stage, feature)`.
   */
  anyFeaturePattern: RegExp;
  /** Why this artifact and not a bookkeeping file. */
  why: string;
}

export type StageProof =
  | ({
      stage: WorkflowStage;
      kind: 'file-presence';
      /** Always `weak` — presence only; see the module header. */
      strength: 'weak';
    } & FileProofShape)
  | ({
      stage: WorkflowStage;
      kind: 'parse';
      /** Always `strong` — the content was read and understood. */
      strength: 'strong';
      /** The module that does the reading, for the reader's benefit. */
      parser: string;
    } & FileProofShape)
  | {
      stage: WorkflowStage;
      kind: 'rounds';
      /** Always `strong` — a coordinator-written record, not a model's note. */
      strength: 'strong';
      /** The record file, relative to the flow directory. */
      file: string;
      /** The entry `type` that counts. */
      entryType: typeof EXECUTE_PROOF_ENTRY_TYPE;
      /**
       * The entry field that must equal the feature slug.
       *
       * Verified live: `phase_result` entries carry the bare slug
       * (`"plan":"worktree-ui-removal"`), not a filename and not a path.
       */
      scopeField: 'plan';
      /** The module that reads it, for the reader's benefit. */
      reader: string;
      why: string;
    };

const PROOFS: { readonly [S in WorkflowStage]: StageProof } = {
  discovery: {
    stage: 'discovery',
    kind: 'file-presence',
    strength: 'weak',
    dir: DISCOVERY_DIR,
    filenameShape: 'discovery_<feature>_v<N>.md',
    filenamePrefix: 'discovery_',
    filenameSuffixSource: '_v\\d+\\.md',
    anyFeaturePattern: /^discovery_.+_v\d+\.md$/,
    why:
      'A discovery document is the only thing the stage inevitably leaves behind. ' +
      'Presence only: there is no grammar a discovery doc must satisfy, so an ' +
      'empty file passes and the chain can be confused by deleting a real one.',
  },
  'create-plan': {
    stage: 'create-plan',
    kind: 'parse',
    strength: 'strong',
    dir: PLANS_DIR,
    filenameShape: 'plan_<feature>_v<N>.md',
    filenamePrefix: 'plan_',
    filenameSuffixSource: '_v\\d+\\.md',
    anyFeaturePattern: /^plan_.+_v\d+\.md$/,
    parser: 'src/cli/state/plan-parser.ts',
    why:
      'A plan has a grammar (`### Phase <n>: <title>` with tasks), so the proof ' +
      'can read the content instead of trusting the filename. A file that names ' +
      'itself a plan and parses to zero phases is not proof of anything.',
  },
  'execute-plan': {
    stage: 'execute-plan',
    kind: 'rounds',
    strength: 'strong',
    file: ROUNDS_FILE,
    entryType: EXECUTE_PROOF_ENTRY_TYPE,
    scopeField: 'plan',
    reader: 'src/cli/state/rounds-reader.ts',
    why:
      'The rounds record is written by the execute coordinator itself, not by a ' +
      'model asked to remember. Any status counts — a phase that ran and failed ' +
      'still ran, and that changeset is the one most worth reviewing.',
  },
  'review-code': {
    stage: 'review-code',
    kind: 'file-presence',
    strength: 'weak',
    dir: REVIEWED_CODE_DIR,
    filenameShape: 'review_<feature>.md',
    filenamePrefix: 'review_',
    filenameSuffixSource: '\\.md',
    anyFeaturePattern: /^review_.+\.md$/,
    why:
      'A review document is what the stage produces. Presence only, for the same ' +
      'reason as discovery: the document has no shape the CLI can verify.',
  },
};

/**
 * What proves `stage` ran, described GENERICALLY — for any feature.
 *
 * The scoped question ("did THIS feature's stage run") is
 * `filenamePatternFor` / `stagesCompleted`. This is the description, not the
 * gate. Pure lookup — reads no file.
 */
export function proofOf(stage: WorkflowStage): StageProof {
  return PROOFS[stage];
}

/** Characters that would turn a feature slug into a pattern instead of a name. */
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * A feature slug, made safe to embed in a pattern.
 *
 * A slug is a NAME, and every character in it must match itself. Without this,
 * a feature called `v1.2` matches `v1X2` and a feature called `a+b` matches
 * `ab` — a quiet widening of exactly the gate this module exists to keep shut.
 * Hyphens and underscores need no escaping and are left alone: real slugs here
 * use both (`worktree-ui-removal`, `file_explorer_content_search`) and the
 * separators are never normalized into each other.
 */
export function escapeFeatureForPattern(feature: string): string {
  return feature.replace(REGEXP_SPECIALS, '\\$&');
}

/**
 * Refuses a feature slug that cannot scope anything.
 *
 * Throws rather than falling back to the loose match. An empty slug would build
 * `^discovery__v\d+\.md$`, which matches nothing and so reports every rung
 * undone — survivable, but it would mean a caller with a bug gets a plausible
 * answer instead of a complaint, and the next caller's bug might land the other
 * way.
 */
function requireFeature(feature: string): string {
  const trimmed = feature.trim();
  if (trimmed.length === 0) {
    throw new Error('a workflow stage proof needs a feature to scope it to; none was given');
  }
  return trimmed;
}

/** The one place a feature-bound filename pattern is built. */
function buildFilenamePattern(shape: FileProofShape, feature: string): RegExp {
  return new RegExp(
    `^${shape.filenamePrefix}${escapeFeatureForPattern(feature)}${shape.filenameSuffixSource}$`,
  );
}

/**
 * The filename pattern that proves `stage` ran FOR `feature`.
 *
 * `null` for `execute-plan`, whose proof is a rounds entry and not a file —
 * the one stage with no filename to match. Throws on an empty feature.
 */
export function filenamePatternFor(stage: WorkflowStage, feature: string): RegExp | null {
  const proof = proofOf(stage);
  if (proof.kind === 'rounds') {
    return null;
  }
  return buildFilenamePattern(proof, requireFeature(feature));
}

/**
 * What this stage's proof would be CALLED for this feature — for refusals.
 *
 * One place builds this string so a refusal and a log cannot disagree about
 * what was looked for (allowed-pattern #14). The rounds stage has no filename,
 * so it describes the record instead.
 */
export function proofDescriptionFor(stage: WorkflowStage, feature: string): string {
  const proof = proofOf(stage);
  const named = requireFeature(feature);
  if (proof.kind === 'rounds') {
    return `${proof.file} (${proof.entryType} with ${proof.scopeField} ${named})`;
  }
  return `${proof.dir}/${proof.filenameShape.replace('<feature>', named)}`;
}

/**
 * The next rung to run, given the stages that already have proof.
 *
 * THE LADDER IS ORDERED, NOT A SET DIFFERENCE. A gap in the middle is the case
 * that matters: if `execute-plan` has proof but `create-plan` does not, the next
 * stage is `create-plan` — the chain does not step over a missing rung because
 * something further up happened to leave a trace. Returns `null` only when
 * every stage is done.
 */
export function nextStage(done: readonly WorkflowStage[]): WorkflowStage | null {
  for (const stage of WORKFLOW_STAGES) {
    if (!done.includes(stage)) {
      return stage;
    }
  }
  return null;
}

/** The rung before `stage` — the edge a refusal guards. `null` at the bottom. */
export function previousStage(stage: WorkflowStage): WorkflowStage | null {
  const index = WORKFLOW_STAGES.indexOf(stage);
  if (index <= 0) {
    return null;
  }
  return WORKFLOW_STAGES[index - 1];
}

/**
 * Skill and command names that name a stage.
 *
 * `/discovery-plan` is the command; `discovery` is the stage. The two are
 * spelled differently on purpose (the stage is named for what it produces),
 * which is exactly why this map exists rather than a string comparison at each
 * call site.
 */
const SKILL_TO_STAGE: ReadonlyMap<string, WorkflowStage> = new Map([
  ['discovery', 'discovery'],
  ['discovery-plan', 'discovery'],
  ['create-plan', 'create-plan'],
  ['execute-plan', 'execute-plan'],
  ['review-code', 'review-code'],
]);

/**
 * The stage a skill or slash command belongs to, or `null` if it is not a rung.
 *
 * Tolerates the leading slash (`/create-plan` and `create-plan` are the same
 * request), surrounding whitespace and case. Everything else — `/review-pr`,
 * `/brainstorm`, a typo — is `null`: not a rung, so not this ladder's business.
 */
export function stageOf(skill: string): WorkflowStage | null {
  const normalized = skill.trim().replace(/^\/+/, '').toLowerCase();
  return SKILL_TO_STAGE.get(normalized) ?? null;
}

/**
 * The readers `stagesCompleted` needs — the ONLY I/O in the ladder.
 *
 * Each one mirrors a module that already exists, so the real wiring is a thin
 * adapter and nothing about the ladder's logic lives in it:
 *
 * - `listFiles` → `readdirSync(join(flowDir, dir))`, returning `[]` for a
 *   missing or unreadable directory (fail-soft is the adapter's job, matching
 *   `readRoundsEntries`). Filename MATCHING stays here, in the pure module.
 * - `readRounds` → `readRoundsEntries(flowDir)` from `rounds-reader.ts`.
 * - `parsePlan` → `parsePlan(join(flowDir, 'plans', filename))` from
 *   `plan-parser.ts`, returning `null` when the file cannot be read at all.
 */
export interface StageProofDeps {
  /** Filenames in a flow subdirectory. `[]` when it does not exist. */
  listFiles(dir: string): readonly string[];
  /** Every parsed entry of the rounds record. `[]` when there is none. */
  readRounds(): readonly RoundsEntry[];
  /** Phases parsed from one plan filename, or `null` if it could not be read. */
  parsePlan(filename: string): readonly PlanPhase[] | null;
}

/** One stage found to have a proof, and how good that proof was. */
export interface StageEvidence {
  stage: WorkflowStage;
  kind: ProofKind;
  /** The strength of the proof that actually answered. Never inferred. */
  strength: ProofStrength;
  /** What answered — a filename, or the rounds entry type. For messages. */
  detail: string;
}

/**
 * A stage whose artifact was FOUND but did not prove anything.
 *
 * The distinction a bare `done` list cannot make: "nobody wrote a plan" and
 * "somebody wrote a plan this parser cannot read" are different problems with
 * different remedies, and telling a person the first when the second is true
 * sends them to redo work that exists. Reported, never counted as proof.
 */
export interface StageNearMiss {
  stage: WorkflowStage;
  /** The artifact that was found — e.g. the plan document that did not parse. */
  detail: string;
  /** What was wrong with it, in a sentence a refusal can quote. */
  why: string;
}

/** Which rungs have proof, with the strength of each proof that answered. */
export interface StagesCompletedResult {
  /**
   * The feature every proof was scoped to, or `null` if the loose question was
   * asked. Carried so a log line cannot misreport which question was answered.
   */
  feature: string | null;
  /** In ladder order. */
  done: WorkflowStage[];
  /** One entry per completed stage, in ladder order. */
  evidence: StageEvidence[];
  /** `nextStage(done)` — the rung to run, or `null` when the chain is finished. */
  next: WorkflowStage | null;
  /**
   * Artifacts found for a stage that did not prove it ran. Empty in the normal
   * case. See `StageNearMiss` — a refusal should quote these rather than claim
   * the artifact is absent.
   */
  nearMisses: StageNearMiss[];
}

/** What `stagesCompleted` is asking about. The feature is not optional. */
export interface StagesCompletedOptions {
  /**
   * The feature slug — the `<feature>` of `plan_<feature>_v<N>.md` and the
   * `plan` field of a `phase_result`. Required; an empty value throws.
   */
  feature: string;
}

/**
 * Which of THIS FEATURE's stages have left proof behind.
 *
 * This is the enforcing path — what a refusal and the runtime driver read.
 * Every filesystem touch goes through `deps`; this function performs none of
 * its own. That is not a testing convenience — it is what lets the refusal verb
 * and the driver share one ladder while reading state through whatever each of
 * them already has open.
 *
 * The feature lives in an options object rather than a second positional
 * argument so that a caller cannot pass it by accident or omit it by habit;
 * omitting it does not fall back to the loose match, it fails to compile.
 */
export function stagesCompleted(
  deps: StageProofDeps,
  options: StagesCompletedOptions,
): StagesCompletedResult {
  return collect(deps, requireFeature(options.feature));
}

/**
 * Which stages have EVER run here, for any feature.
 *
 * NEVER READ THIS TO REFUSE A STAGE. On this repo it reports all four rungs
 * done at all times — ten discovery documents, ten plans, eleven reviews and
 * another plan's `phase_result` entries (see the header) — which is precisely
 * the bug the scoped path exists to fix. It answers a different and genuinely
 * useful question: has this project ever been through the chain at all.
 *
 * It is a separate NAME rather than an optional argument for exactly that
 * reason: the loose answer has to be asked for out loud.
 */
export function stagesCompletedForAnyFeature(deps: StageProofDeps): StagesCompletedResult {
  return collect(deps, null);
}

function collect(deps: StageProofDeps, feature: string | null): StagesCompletedResult {
  const done: WorkflowStage[] = [];
  const evidence: StageEvidence[] = [];
  const nearMisses: StageNearMiss[] = [];

  for (const stage of WORKFLOW_STAGES) {
    const found = evidenceFor(stage, deps, feature, nearMisses);
    if (found !== null) {
      done.push(stage);
      evidence.push(found);
    }
  }

  return { feature, done, evidence, next: nextStage(done), nearMisses };
}

function evidenceFor(
  stage: WorkflowStage,
  deps: StageProofDeps,
  feature: string | null,
  nearMisses: StageNearMiss[],
): StageEvidence | null {
  const proof = proofOf(stage);

  if (proof.kind === 'rounds') {
    // Scoped: the entry's `plan` field must name this feature. Unscoped: any
    // `phase_result`. Status is deliberately not filtered either way — the
    // question is whether the stage RAN (see the header).
    const hit = deps
      .readRounds()
      .some(
        (entry) =>
          entry.type === proof.entryType &&
          (feature === null || entry[proof.scopeField] === feature),
      );
    if (!hit) {
      return null;
    }
    return {
      stage,
      kind: proof.kind,
      strength: proof.strength,
      detail:
        feature === null
          ? `${proof.file} (${proof.entryType})`
          : `${proof.file} (${proof.entryType} with ${proof.scopeField} ${feature})`,
    };
  }

  const pattern =
    feature === null ? proof.anyFeaturePattern : buildFilenamePattern(proof, feature);

  const candidates = deps.listFiles(proof.dir).filter((filename) => pattern.test(filename));

  if (proof.kind === 'file-presence') {
    const first = candidates[0];
    if (first === undefined) {
      return null;
    }
    return { stage, kind: proof.kind, strength: proof.strength, detail: `${proof.dir}/${first}` };
  }

  // `parse` — presence is not enough; a candidate has to read as a real plan.
  for (const filename of candidates) {
    const phases = deps.parsePlan(filename);
    if (phases !== null && phases.length > 0) {
      return {
        stage,
        kind: proof.kind,
        strength: proof.strength,
        detail: `${proof.dir}/${filename}`,
      };
    }
    nearMisses.push({
      stage,
      detail: `${proof.dir}/${filename}`,
      why:
        phases === null
          ? 'the document could not be read'
          : 'the document was read but no phase in it could be understood',
    });
  }

  return null;
}
