/**
 * The recorded risk assessment — the pure half of the high-risk gate.
 *
 * `/execute-plan` rates its own changeset at Step 7b2 and records the verdict in
 * `flow/.rounds.jsonl` through `planflow-ai flow risk --record`, the ONE writer
 * (`../commands/flow-risk-record.ts`), which validates the vocabulary and stamps
 * the chain driving the run:
 *
 *   {"ts":"…","run_id":"…","type":"risk","phase":null,"plan":"…",
 *    "risk_level":"low|medium|high","risk_rationale":"…","chain":"…"|null}
 *
 * The skill doc has said since #653 that an autopilot run pauses before push/PR
 * when that says `high`. NOTHING MADE IT TRUE (discovery C3): the sentence lived
 * in prose and no code read the entry. This module reads it.
 *
 * IT NEVER JUDGES RISK. Rating a changeset means reading the changeset, which is
 * a model's job, and no model call ever enters a verb
 * (`src/cli/commands/loop.ts:938`). This is `requireVerdict`'s shape
 * (`src/cli/loop/classify.ts`): the CLI enforces that a record EXISTS and says
 * what it says, and every judgement stays with the agent that wrote it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT "NO ASSESSMENT" MEANS — ARGUED, NOT DEFAULTED
 *
 * A missing assessment is not the same fact as a low one, and the two must not
 * share an answer. On the ENFORCED path a missing assessment REFUSES, under its
 * own reason code (`risk-unassessed`, never `risk-high`), because:
 *
 *   - the enforced chain always runs `/execute-plan`, whose Step 7b2 writes the
 *     entry before anything is published. Its absence in a chained run is not a
 *     project that never adopted the record — it is a run whose assessment step
 *     did not happen, which is an anomaly, not a clearance;
 *   - the seam being gated is a PUSH: irreversible to someone else. "Nobody
 *     rated this" is the weakest possible ground for crossing it;
 *   - the house precedent already decided this. `requireVerdict` refuses an item
 *     with no recorded classification for exactly this reason: work that starts
 *     without a record is the failure the store exists to prevent;
 *   - and the cost of being wrong is asymmetric. Refusing withholds a publish
 *     while the work stays committed locally — recoverable in one gesture.
 *     Allowing publishes an unassessed changeset to other people, which is not.
 *
 * On the REPORTING path a missing assessment refuses NOTHING. A person running
 * `/execute-plan` by hand on a project that has never written a risk entry gets
 * the same verdict, exit 0, and no corner to be stuck in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE SCOPE IS NOT OPTIONAL, AND WHY THERE ARE TWO OF THEM
 *
 * Phase 1's first cut of the workflow ladder matched ANY feature's artifacts and
 * therefore reported every rung done on this repo — a gate that is always open
 * and looks shut. The same trap is open here: `flow/.rounds.jsonl` is one file
 * per project holding every plan's entries for ever, so "the latest risk entry"
 * would let one plan's assessment gate — or CLEAR — another's. So a reading is
 * always scoped, and the scope is stated out loud:
 *
 *   - `stated` — the caller knows the plan slug (the `/execute-plan` skill does).
 *     Entries are matched by feature; the newest wins.
 *   - `observed` — the caller knows WHEN its run began but not what the plan was
 *     called (the IDE chain drives a thread, not a slug). Entries are bounded to
 *     that instant, the feature is RESOLVED from the newest bounded entry that
 *     names one, and the assessment is then matched against that feature. An
 *     older entry from another plan is out of the window and can neither gate
 *     nor clear this run.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THAT WAS NOT ENOUGH, AND THE REVIEW PROVED IT LIVE (#1915 C1)
 *
 * The first cut of `observed` resolved its subject with `lastFeatureNamed` — the
 * newest admitted entry naming any plan — and then read THAT plan's latest
 * rating. One appended line was therefore both the question and the answer: it
 * nominated itself as the subject and supplied its own verdict. A `high`
 * assessment that had just refused a publish was cleared by appending
 *
 *   {"type":"risk","plan":"anything-at-all","risk_level":"low","risk_rationale":"looks fine"}
 *
 * with no knowledge of the real plan slug needed — exit 1 became exit 0. It
 * needs no attacker, either: two plans in flight in one project answer for each
 * other, because whichever wrote last owns the resolution. The limit this header
 * used to state ("the reading reports the feature it resolved, so the mismatch is
 * visible rather than silent") was a mitigation NO CALLER PERFORMED — the IDE's
 * gate branched on the exit code and dropped the payload. A mitigation nothing
 * performs is a comment, not a defence, and it has been deleted rather than
 * reworded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ENFORCED READING IS KEYED ON THE CHAIN ID, AND ON NOTHING ELSE
 *
 * The root is that the enforced run had no identity on the wire that a file
 * cannot forge. It has exactly one: the chain id, minted by `AutopilotChain`
 * and by nothing else, riding on the message that starts every rung. So:
 *
 *   - an ENFORCED reading (a chain id is given) admits ONLY entries stamped with
 *     that chain id, and the assessment it finds IS the subject — the feature is
 *     read off the winning entry instead of being resolved from some other line.
 *     No step is left at which a line can nominate which question gets asked;
 *   - a REPORTING reading (no chain id) is untouched, deliberately. It refuses
 *     nothing (discovery R3), so its resolution cannot open a gate — there is no
 *     gate — and narrowing it would corner the person running a verb by hand.
 *
 * `flow risk --record` is the ONE writer that stamps the id, mirroring
 * `flow pushed-through`, which was built in the same phase WITH this protection
 * and never lost it while `risk` was composed from a paragraph. A coordinator
 * that forgets `--chain` while recording writes an unstamped entry, and the
 * enforced gate then refuses under `risk-unassessed`. That is the direction a
 * mistake has to fail in: forgetting withholds a publish, it never grants one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT AN ENFORCED GATE DOES WITH A PRE-EXISTING UNSTAMPED ENTRY — IT REFUSES
 *
 * Decided, not inherited. Every `risk` entry written before this change is
 * unstamped and was hand-composed, so a lenient rule ("accept an unstamped entry
 * that names this feature") would be indistinguishable from the forgery above:
 * an unstamped line is exactly what an appended one looks like. An unstamped
 * entry therefore never satisfies an ENFORCED gate.
 *
 * Nothing that worked stops working. Enforcement exists only where a chain is
 * driving; chains are newer than every entry in every existing rounds file; and
 * the reporting path — all any project or manual run has ever used — reads
 * exactly as it always did. The cost of the strict choice is the asymmetry
 * already argued above: refusing WITHHOLDS a publish while the work stays
 * committed locally, recoverable in one gesture, and the lenient reading
 * publishes an unassessed changeset to other people, which is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE SPELLINGS OF "WHICH PLAN", AND WHY ALL THREE ARE ACCEPTED
 *
 * The doc and the live file disagree, and the doc is not the tiebreaker
 * (allowed-pattern #11 — validate against the live tool). The skill's own
 * example `risk` entry carries NO `plan` field at all; every entry in this
 * repo's live rounds file carries one, bare (`"plan":"worktree-ui-removal"`);
 * and `run_intent` is documented as carrying the FILENAME (`plan_user-auth_v1`).
 * A reader that accepted only the live spelling would find zero risk entries in
 * a project whose coordinator followed the doc, and would then refuse every
 * publish for ever under `risk-unassessed`. So all three are matched, in one
 * predicate, here.
 *
 * Pure: no filesystem, no clock, no model. Entries come from
 * `rounds-reader.ts`; the verb wires the two together.
 */

import type { RoundsEntry } from './rounds-reader.js';

/** The three levels `/execute-plan` may record. */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;

/** One recorded level. */
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** The rounds entry type that carries an assessment. */
export const RISK_ENTRY_TYPE = 'risk';

/** The one level that stops an enforced run before it publishes. */
export const BLOCKING_RISK: RiskLevel = 'high';

/** Whether a value is a level this gate understands. */
export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value);
}

/** One recorded assessment, in the rounds record's envelope. */
export interface RiskEntry extends Record<string, unknown> {
  ts: string;
  run_id: string;
  type: typeof RISK_ENTRY_TYPE;
  /** Run-level, like `pushed_through` — the record's own convention. */
  phase: null;
  /** The plan slug, the way every live entry in this repo scopes itself. */
  plan: string;
  risk_level: RiskLevel;
  /** The one sentence the coordinator wrote. `null` when it wrote none. */
  risk_rationale: string | null;
  /**
   * The chain that was driving, when one was — THE WHOLE POINT.
   *
   * An enforced gate admits only entries carrying the id it was called with, so
   * this field is the run's identity rather than a label about it. It is `null`
   * for a manual run, which no enforced gate will ever read.
   */
  chain: string | null;
}

/** What the writer verb is told. */
export interface RiskEntryInput {
  level: RiskLevel;
  feature: string;
  runId: string;
  chain: string | null;
  rationale: string | null;
  ts: string;
}

/**
 * The entry, built in ONE place — `buildPushedThroughEntry`'s sibling.
 *
 * `run_id` is taken from the caller rather than minted, for that module's own
 * reason: a run has one id and nobody invents a second scheme, so a verb that
 * could not be given one would be a verb that has to make one up.
 */
export function buildRiskEntry(input: RiskEntryInput): RiskEntry {
  return {
    ts: input.ts,
    run_id: input.runId,
    type: RISK_ENTRY_TYPE,
    phase: null,
    plan: input.feature,
    risk_level: input.level,
    risk_rationale: input.rationale,
    chain: input.chain,
  };
}

/**
 * Is this entry stamped with the chain that is asking?
 *
 * The one identity test, so that "which entries belong to this enforced run" has
 * exactly one answer (allowed-pattern #14). Compared trimmed, because the id
 * arrives through a command line on one side and a JSON field on the other.
 */
export function entryStampedBy(entry: RoundsEntry, chain: string): boolean {
  const wanted = chain.trim();
  if (wanted.length === 0) return false;
  const stamped = typeof entry.chain === 'string' ? entry.chain.trim() : '';
  return stamped.length > 0 && stamped === wanted;
}

/**
 * Which entries a reading is allowed to look at.
 *
 * A discriminated union rather than two optional fields: a caller cannot pass
 * neither, and a consumer reading the payload can say which question was asked.
 */
export type RiskScope =
  | { kind: 'stated'; feature: string }
  | { kind: 'observed'; since: string };

/** Characters that would turn a slug into a pattern instead of a name. */
const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** A slug made safe to embed in a pattern — a NAME matches itself, nothing more. */
function escapeForPattern(value: string): string {
  return value.replace(REGEXP_SPECIALS, '\\$&');
}

/**
 * The run-id shape the record uses: `<plan-slug>-<YYYYMMDD[-HHMMSS]>`, plus the
 * documented planning-time exception `<plan-slug>-plan`.
 *
 * The date is required rather than optional so that a feature called `harness`
 * does not claim `harness-autopilot-20260911-182332`: after `harness-` comes
 * `a`, not a digit, and the match fails — which is the whole point.
 */
const RUN_ID_SUFFIX = '(?:-\\d{8}(?:-\\d{6})?|-plan)$';

/** The filename spelling of a plan, as `run_intent` is documented to carry it. */
const PLAN_FILENAME_SUFFIX = '_v\\d+(?:\\.md)?$';

/**
 * Does this entry belong to `feature`? The ONE predicate — see the header's
 * three spellings.
 */
export function entryNamesFeature(entry: RoundsEntry, feature: string): boolean {
  const slug = escapeForPattern(feature.trim());
  if (slug.length === 0) return false;
  const plan = typeof entry.plan === 'string' ? entry.plan : null;
  if (plan !== null) {
    if (plan === feature.trim()) return true;
    if (new RegExp(`^plan_${slug}${PLAN_FILENAME_SUFFIX}`).test(plan)) return true;
  }
  const runId = typeof entry.run_id === 'string' ? entry.run_id : null;
  if (runId !== null && new RegExp(`^${slug}${RUN_ID_SUFFIX}`).test(runId)) return true;
  return false;
}

/**
 * The feature an entry belongs to, when it says so — for `observed` resolution.
 *
 * Prefers the explicit field; falls back to stripping the run-id's timestamp,
 * which is deterministic and is the only thing a doc-shaped `risk` entry
 * carries. `null` when the entry names no plan at all.
 */
export function featureOfEntry(entry: RoundsEntry): string | null {
  const plan = typeof entry.plan === 'string' ? entry.plan.trim() : '';
  if (plan.length > 0) {
    const filename = /^plan_(.+)_v\d+(?:\.md)?$/.exec(plan);
    return filename === null ? plan : filename[1];
  }
  const runId = typeof entry.run_id === 'string' ? entry.run_id.trim() : '';
  const stripped = /^(.+?)(?:-\d{8}(?:-\d{6})?|-plan)$/.exec(runId);
  return stripped === null ? null : stripped[1];
}

/**
 * An entry's timestamp — `ts`, or `at`, whichever it carries.
 *
 * BOTH SPELLINGS ARE REAL (allowed-pattern #11 — validate against the live tool,
 * not its docs). The envelope documents `ts`, and this repo's own rounds file
 * holds five entries from a September run keyed `at` instead. A reader that knew
 * only the documented name would drop a whole run's entries out of an observed
 * window and then answer confidently about what was left, which is the quiet
 * half of the always-open-and-looks-shut failure.
 */
function timestampOf(entry: RoundsEntry): string | null {
  for (const key of ['ts', 'at'] as const) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Entries at or after `since`.
 *
 * COMPARED AS INSTANTS, NOT AS STRINGS. The two spellings are also two formats —
 * `2026-09-11T21:23:32Z` beside `2026-09-11T11:38:56.998793` — and a lexical
 * comparison across an offset form gives the wrong answer silently.
 *
 * AN ENTRY WITH NO USABLE TIMESTAMP IS OUT. It cannot be shown to belong to this
 * run, and the gate's whole job is to refuse what cannot be shown — the same
 * direction as the absent-assessment decision above.
 */
function atOrAfter(entries: readonly RoundsEntry[], since: string): RoundsEntry[] {
  const floor = Date.parse(since);
  if (Number.isNaN(floor)) return [];
  return entries.filter((entry) => {
    const raw = timestampOf(entry);
    if (raw === null) return false;
    const at = Date.parse(raw);
    return !Number.isNaN(at) && at >= floor;
  });
}

/** One assessment, as the gate reports it. */
export interface RiskAssessment {
  level: RiskLevel;
  /** The one sentence the coordinator wrote. `null` when it wrote none. */
  rationale: string | null;
  /** The run that recorded it. */
  runId: string | null;
  /** When it was recorded. */
  ts: string | null;
}

/** Why there is no assessment, when there is none. */
export type RiskAbsence =
  /** The rounds record holds nothing at all for this scope. */
  | 'no-record'
  /** Entries exist in scope, but none of them is an assessment. */
  | 'unassessed';

/** What a scoped read of the record found. */
export interface RiskReading {
  scope: RiskScope;
  /** The feature every entry was matched against — resolved, under `observed`. */
  feature: string | null;
  /** The assessment in force, or `null`. The LATEST recorded one wins. */
  assessment: RiskAssessment | null;
  /** Why not, when not. `null` alongside an assessment. */
  absence: RiskAbsence | null;
}

/** The assessment fields, read defensively off an entry. */
function assessmentOf(entry: RoundsEntry): RiskAssessment | null {
  if (!isRiskLevel(entry.risk_level)) return null;
  return {
    level: entry.risk_level,
    rationale:
      typeof entry.risk_rationale === 'string' && entry.risk_rationale.trim().length > 0
        ? entry.risk_rationale
        : null,
    runId: typeof entry.run_id === 'string' ? entry.run_id : null,
    ts: timestampOf(entry),
  };
}

/**
 * The assessment in force for one scope — and, when a chain is driving, for one
 * chain.
 *
 * THE LATEST RECORDED ONE WINS, by position in the append-only file rather than
 * by timestamp — the file's order is the record's order, and a re-assessment is
 * a new line exactly as a re-classification is (`classify.ts`). A `risk` entry
 * whose `risk_level` is not one of the three is not an assessment and is
 * skipped, never read as a fourth level.
 *
 * `chain` is the mode, not an extra filter (see the header). Absent, this is the
 * reporting reading, unchanged in every particular from the one that shipped;
 * present, it is the enforced reading, which admits only what that chain wrote.
 */
export function readRisk(
  entries: readonly RoundsEntry[],
  scope: RiskScope,
  chain: string | null = null,
): RiskReading {
  return chain === null || chain.trim().length === 0
    ? readReported(entries, scope)
    : readEnforced(entries, scope, chain.trim());
}

/**
 * The reporting reading — what a person asking by hand gets.
 *
 * Deliberately untouched by the C1 fix. It refuses NOTHING, so there is no gate
 * here for a stray line to open, and a stricter rule would only take answers
 * away from the one caller that is never cornered by them.
 */
function readReported(entries: readonly RoundsEntry[], scope: RiskScope): RiskReading {
  const admitted = scope.kind === 'stated' ? [...entries] : atOrAfter(entries, scope.since);

  const feature =
    scope.kind === 'stated'
      ? scope.feature.trim()
      : (lastFeatureNamed(admitted) ?? null);

  if (feature === null || feature.length === 0) {
    return { scope, feature: null, assessment: null, absence: 'no-record' };
  }

  const mine = admitted.filter((entry) => entryNamesFeature(entry, feature));
  if (mine.length === 0) {
    return { scope, feature, assessment: null, absence: 'no-record' };
  }

  const latest = latestAssessment(mine);
  return latest === null
    ? { scope, feature, assessment: null, absence: 'unassessed' }
    : { scope, feature, assessment: latest.assessment, absence: null };
}

/**
 * The enforced reading — what a chain gets, and the answer to C1.
 *
 * THE SUBJECT IS NEVER RESOLVED FROM "THE NEWEST LINE THAT NAMES ANYTHING". The
 * admitted set is the entries this chain stamped; the assessment is the newest
 * `risk` entry among them; and the feature is read OFF that entry. A line the
 * chain did not write cannot be the answer, and it cannot change the question
 * either, which is the half the first cut left open.
 *
 * A `stated` scope narrows further rather than replacing the chain test: the
 * caller that knows the slug is saying which feature it expects, and a
 * chain-stamped assessment for a DIFFERENT feature is a real anomaly that must
 * not clear this publish. Both conditions, or nothing.
 */
function readEnforced(
  entries: readonly RoundsEntry[],
  scope: RiskScope,
  chain: string,
): RiskReading {
  const inWindow = scope.kind === 'stated' ? [...entries] : atOrAfter(entries, scope.since);
  const stamped = inWindow.filter((entry) => entryStampedBy(entry, chain));
  const admitted =
    scope.kind === 'stated'
      ? stamped.filter((entry) => entryNamesFeature(entry, scope.feature))
      : stamped;

  // A stated scope always reports the feature it was ASKED about, so a refusal
  // can say what would have satisfied it even when this chain wrote nothing.
  const stated = scope.kind === 'stated' ? scope.feature.trim() : null;

  const latest = latestAssessment(admitted);
  if (latest === null) {
    return {
      scope,
      feature: stated ?? lastFeatureNamed(admitted),
      assessment: null,
      absence: admitted.length === 0 ? 'no-record' : 'unassessed',
    };
  }

  return { scope, feature: stated ?? latest.feature, assessment: latest.assessment, absence: null };
}

/** The newest entry of the set that is an assessment, with the feature it names. */
function latestAssessment(
  entries: readonly RoundsEntry[],
): { assessment: RiskAssessment; feature: string | null } | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== RISK_ENTRY_TYPE) continue;
    const assessment = assessmentOf(entry);
    if (assessment !== null) {
      return { assessment, feature: featureOfEntry(entry) };
    }
  }
  return null;
}

/** The feature named by the newest entry that names one. */
function lastFeatureNamed(entries: readonly RoundsEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const named = featureOfEntry(entries[index]);
    if (named !== null && named.length > 0) return named;
  }
  return null;
}
