/**
 * Flow CLI command — `planflow-ai flow <verb>`.
 *
 * THE WRITE DOOR onto `flow/.flowconfig`. The `/flow` skill used to describe
 * the file in prose and let a model edit it line by line; every rule the file
 * has — which keys exist, what values they accept, how a key is removed
 * without disturbing the comment above it — lived in a paragraph a model was
 * asked to remember. This verb is that rule set in code (allowed-pattern #14),
 * and the skill calls it.
 *
 * Contract (the `worktree` / `guard classify` precedent):
 *
 *   - Success: the result object via `process.stdout.write` with `--json`,
 *     otherwise the same object rendered as human lines. A SECOND FORMATTER,
 *     never a second computation.
 *   - Refusal: ONE `flow refused: <reason>` line via the repo logger (which
 *     routes through console.log — allowed-pattern #15), exit code 1, and
 *     NOTHING WRITTEN. A batch is validated whole before the first byte is
 *     merged, so `flow set commit=true push=banana` changes neither key.
 *   - No model call ever enters a verb.
 *
 * `stage` joins the family as a READER rather than a writer — the autopilot
 * ladder's refusal (`flow-stage.ts`). It touches no file, and it is here rather
 * than in a command of its own because it is subject to the same contract: one
 * result object, two formatters, one refusal line.
 *
 * Two things this verb deliberately does NOT do:
 *
 *   - It does not cascade. `pr: true` implies push and commit, and
 *     `parseFlowConfig` already applies that on every read — writing the
 *     implied keys here would make a second place that has to agree with it.
 *   - It does not remove a key nobody named (forbidden-pattern #15). `unset`
 *     is the only path to a deletion, and it deletes exactly what it was told.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as log from '../utils/logger.js';
import { parseFlowConfig } from '../state/flowconfig-parser.js';
import { parseFlowconfigKeys } from '../state/flowconfig-merge.js';
import { canonicalFlowconfigKey, legacyKeyOf } from '../state/flowconfig-aliases.js';
import { writeFlowconfigKeys } from '../state/flowconfig-writer.js';
import { applyShareMode } from '../handlers/shared.js';
import { isValidRefName, isValidRemoteName } from '../loop/remote-binding.js';
import {
  StageCheckRefusal,
  checkStage,
  renderStageVerdict,
  requireStage,
} from './flow-stage.js';
import { RiskCheckRefusal, checkRisk, renderRiskVerdict } from './flow-risk.js';
import { recordRisk, requireRiskLevel } from './flow-risk-record.js';
import {
  qualityStopVocabulary,
  recordPushedThrough,
  requireQualityStop,
} from './flow-pushed-through.js';
import { recordRunStart } from './flow-run-start.js';
import type { RunStartEntry } from './flow-run-start.js';
import { enforcementModeOf } from '../state/enforcement-mode.js';
import type { StageCheckVerdict } from './flow-stage.js';
import type { RiskCheckVerdict } from './flow-risk.js';
import type { RiskEntry } from '../state/risk-record.js';
import type { PushedThroughEntry } from '../state/quality-stops.js';
import { WALKTHROUGH_MODELS, type FlowConfig } from '../state/types.js';
import type { ShareMode } from '../types.js';

/** Prefix every refusal line carries — never doubled. */
const FLOW_REFUSED_PREFIX = 'flow refused:';

/** What a `stage` call has to say, for every refusal that names the shape. */
const FLOW_STAGE_USAGE = 'flow stage <stage> --check --feature <slug> [--chain <id>]';

/** What a `risk --check` call has to say — two scopes, one of them required. */
const FLOW_RISK_USAGE =
  'flow risk --check (--feature <slug> | --since <iso>) [--chain <id>]';

/** What a `risk --record` call has to say — the writing half of the same verb. */
const FLOW_RISK_RECORD_USAGE =
  'flow risk --record <low|medium|high> --feature <slug> --run <run-id> [--chain <id>] [--rationale <text>]';

/** What a `pushed-through` call has to say. */
const FLOW_PUSHED_THROUGH_USAGE =
  'flow pushed-through <stop> --feature <slug> --run <run-id> [--chain <id>] [--detail <text>]';

/** What a `run-start` call has to say. */
const FLOW_RUN_START_USAGE = 'flow run-start --plan <name> --run <run-id>';

/** Every verb this command answers to. */
export const FLOW_VERBS = [
  'set',
  'unset',
  'show',
  'stage',
  'risk',
  'pushed-through',
  'run-start',
] as const;

/** One of the verbs. */
export type FlowVerb = (typeof FLOW_VERBS)[number];

/** Whether a value is a known verb. */
export function isFlowVerb(value: string): value is FlowVerb {
  return (FLOW_VERBS as readonly string[]).includes(value);
}

/** What shape of value a key accepts. */
export type FlowKeyKind = 'boolean' | 'string' | 'number' | 'enum';

/** One allowlisted key. */
export interface FlowKeySpec {
  kind: FlowKeyKind;
  /** The accepted values, for `enum` keys. */
  values?: readonly string[];
  /** Inclusive bounds, for `number` keys. */
  min?: number;
  max?: number;
  /** One line, in the words a person would use for the setting. */
  help: string;
  /**
   * An extra rule the kind cannot express — a git ref name, a placeholder
   * vocabulary. Returns what the value FAILED to be (and optionally what would
   * have worked), or `null` when the value is fine.
   */
  check?: (value: string) => FlowKeyMismatch | null;
}

/** What a `check` says about a value it rejects. */
export interface FlowKeyMismatch {
  /** The noun the value failed to be — `branch name`, `worktree start`. */
  noun: string;
  /** What would have worked, when naming it helps more than the noun alone. */
  hint?: string;
}

/** The placeholders a `remote_branch_pattern` may carry — `fillPattern`'s vocabulary. */
const REMOTE_BRANCH_PLACEHOLDERS = ['ticket', 'slug', 'local', 'user'] as const;

/** Anything in braces, so `{Ticket}` and `{sprint}` are both caught. */
const ANY_PLACEHOLDER = /\{([^}]*)\}/g;

/** Engine consent keys are a FAMILY (`engines.<name>`), not one key. */
const ENGINE_KEY = /^engines\.[a-z0-9_-]+$/;

/** The values an engine key accepts — `pending` included, because `init` writes it. */
const ENGINE_VALUES = ['enabled', 'declined', 'pending'] as const;

/** How a `worktree_start` value naming a branch is written. */
const BRANCH_START = /^branch:(.+)$/;

/** The bounds the resolver clamps to — refused here so a typo is reported, not silently squashed. */
const MIN_BASE_REFRESH_TIMEOUT_MS = 1_000;
const MAX_BASE_REFRESH_TIMEOUT_MS = 30_000;
/**
 * The worktree bounds, mirrored from the app's worktree settings resolver
 * (`app/src/main/flow/worktree-settings.ts`).
 *
 * MIRRORED, NOT IMPORTED, for the reason the branch prefix is: the app and the
 * CLI are different packages with different module systems, and the app cannot
 * be imported from here. Both sides clamp where they READ, so a value outside
 * these is corrected rather than trusted — this pair exists to REFUSE it at the
 * moment somebody types it, which is the only moment they can fix it.
 */
const MIN_WORKTREE_CAP = 1;
const MAX_WORKTREE_CAP = 100;
const MIN_SETUP_TIMEOUT_MS = 1_000;
const MAX_SETUP_TIMEOUT_MS = 5 * 60_000;

/**
 * Every key `flow set` accepts, and what it accepts.
 *
 * THIS LIST AND `.claude/commands/flow.md` ARE ONE TABLE IN TWO PLACES — the
 * doc is what a person reads and this is what refuses them, so a key added to
 * one belongs in the other in the same change. `help` is written in the
 * setting's own words rather than the key's, because it is what a person sees.
 *
 * RENAMED KEYS ARE LISTED UNDER THEIR NEW NAME ONLY. The old `workspace_*`
 * names are accepted as input and resolved here (`specFor`); a write lands
 * under the new name AND the old one, transitionally, so older builds stay in
 * step (`../state/flowconfig-aliases.ts`).
 */
export const FLOW_KEYS: Record<string, FlowKeySpec> = {
  autopilot: { kind: 'boolean', help: 'Chain the flow automatically for a feature request' },
  commit: { kind: 'boolean', help: 'Commit after each completed task' },
  push: { kind: 'boolean', help: 'Push once every phase and the build have passed' },
  pr: { kind: 'boolean', help: 'Open a pull request after the push' },
  pr_draft: { kind: 'boolean', help: 'Open those pull requests as drafts until they are reviewed' },
  guarded_autopilot: {
    kind: 'boolean',
    help: 'Ask before each irreversible step of an autonomous run',
  },
  branch: {
    kind: 'string',
    help: 'The base a thread\'s worktree is cut from and a pull request opens against (blank = the branch you are on)',
    check: (value) => (isValidRefName(value) ? null : { noun: 'branch name' }),
  },
  remote: {
    kind: 'string',
    help: 'The remote a thread publishes to',
    check: (value) => (isValidRemoteName(value) ? null : { noun: 'remote name' }),
  },
  remote_branch_pattern: {
    kind: 'string',
    help: 'How a thread\'s remote branch is named, e.g. feature/{ticket}',
    check: checkRemoteBranchPattern,
  },
  thread_worktrees: { kind: 'boolean', help: 'Give each thread its own worktree' },
  worktree_start: {
    kind: 'string',
    help: 'Where a thread\'s worktree starts when nobody names a start',
    check: checkWorktreeStart,
  },
  base_refresh: { kind: 'boolean', help: 'Bring the base up to date before cutting a worktree' },
  // THE FOUR THE IDE COULD WRITE AND THIS COULD NOT.
  //
  // The settings panel has had rows for these for as long as they have existed,
  // and `flow set` answered "unknown key" for every one — so the documented
  // "terminals and skills use `planflow-ai flow set`" was true of some worktree
  // settings and not of the rest. Found 2026-09-18 trying to set the one that
  // gives a Python checkout its interpreter.
  worktree_setup: {
    kind: 'string',
    help: 'A command to run in each new worktree before the agent starts, e.g. uv sync',
  },
  worktree_setup_timeout_ms: {
    kind: 'number',
    min: MIN_SETUP_TIMEOUT_MS,
    max: MAX_SETUP_TIMEOUT_MS,
    help: 'How long that command may take, in milliseconds',
  },
  worktree_cap: {
    kind: 'number',
    min: MIN_WORKTREE_CAP,
    max: MAX_WORKTREE_CAP,
    help: 'How many conversations may keep files of their own on disk',
  },
  base_refresh_timeout_ms: {
    kind: 'number',
    min: MIN_BASE_REFRESH_TIMEOUT_MS,
    max: MAX_BASE_REFRESH_TIMEOUT_MS,
    help: 'How long that refresh may take, in milliseconds',
  },
  model_routing: { kind: 'boolean', help: 'Pick a model per phase from its complexity' },
  phase_isolation: { kind: 'boolean', help: 'Run each phase in a sub-agent with a clean context' },
  wave_execution: { kind: 'boolean', help: 'Run independent phases in parallel waves' },
  max_verify_retries: {
    kind: 'number',
    min: 1,
    max: 5,
    help: 'Repair attempts before a failed task verification is escalated',
  },
  walkthrough_model: {
    kind: 'enum',
    values: WALKTHROUGH_MODELS,
    help: 'Which model writes a discovery\'s artifact page (/artifact)',
  },
  learn_auto: { kind: 'boolean', help: 'Re-learn a module automatically when its code drifts' },
  learn_ignore: { kind: 'string', help: 'Extra modules to leave out of learning, comma-separated' },
  share: {
    kind: 'enum',
    values: ['local', 'shared'],
    help: 'Whether this project\'s knowledge travels with the code',
  },
  webhook_url: { kind: 'string', help: 'Where notifications are posted, comma-separated' },
  telegram_bot_token: { kind: 'string', help: 'The bot that carries two-way messages' },
  telegram_chat_id: { kind: 'string', help: 'The chat those messages go to' },
  'commands.lint': { kind: 'string', help: 'The lint command the pipeline gate runs' },
};

/**
 * The spec for a key, resolving the `engines.<name>` family and the old name of
 * a renamed key (`workspace_start` → `worktree_start`). Null when unknown.
 */
export function specFor(key: string): FlowKeySpec | null {
  const canonical = canonicalFlowconfigKey(key);
  const known = Object.prototype.hasOwnProperty.call(FLOW_KEYS, canonical) ? FLOW_KEYS[canonical] : undefined;
  if (known !== undefined) return known;
  if (ENGINE_KEY.test(key)) {
    return {
      kind: 'enum',
      values: ENGINE_VALUES,
      help: 'Whether this optional engine is used for the steps that can delegate to it',
    };
  }
  return null;
}

/** `remote_branch_pattern` — every placeholder must be one the filler knows. */
function checkRemoteBranchPattern(value: string): FlowKeyMismatch | null {
  // An unknown placeholder is not a harmless typo: `fillPattern` cannot fill
  // it, so the whole pattern falls through to the next suggestion rung and the
  // convention someone wrote silently stops applying.
  const unknown: string[] = [];
  for (const match of value.matchAll(ANY_PLACEHOLDER)) {
    const name = match[1];
    if (!(REMOTE_BRANCH_PLACEHOLDERS as readonly string[]).includes(name)) unknown.push(match[0]);
  }
  if (unknown.length > 0) {
    return {
      noun: 'pattern',
      hint: `${unknown.join(' and ')} cannot be filled; expected ${REMOTE_BRANCH_PLACEHOLDERS.map((name) => `{${name}}`).join(', ')}`,
    };
  }
  return null;
}

/** `worktree_start` — `here`, `trunk`, or `branch:<name>` with a real ref name. */
function checkWorktreeStart(value: string): FlowKeyMismatch | null {
  if (value === 'here' || value === 'trunk') return null;
  const named = BRANCH_START.exec(value);
  if (named !== null && isValidRefName(named[1])) return null;
  return { noun: 'worktree start', hint: 'expected here, trunk, or branch:<name>' };
}

/**
 * Why `value` is not acceptable for `key`, or null when it is.
 *
 * VALIDATED, NEVER SANITIZED (allowed-pattern #22): this value was TYPED, so
 * the setting a person is told about has to be the setting that gets written.
 * A derived value would be sanitized instead — that path is elsewhere.
 */
export function invalidValueReason(key: string, spec: FlowKeySpec, value: string): string | null {
  if (value.trim().length === 0) {
    return `${key} needs a value — 'flow unset ${key}' is how it goes back to the default`;
  }
  if (spec.kind === 'boolean' && value !== 'true' && value !== 'false') {
    return `'${value}' is not a valid boolean for ${key} (expected true or false)`;
  }
  if (spec.kind === 'enum' && !(spec.values ?? []).includes(value)) {
    return `'${value}' is not a valid value for ${key} (expected ${(spec.values ?? []).join(', ')})`;
  }
  if (spec.kind === 'number') {
    const min = spec.min ?? Number.MIN_SAFE_INTEGER;
    const max = spec.max ?? Number.MAX_SAFE_INTEGER;
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      return `'${value}' is not a valid number for ${key} (expected a whole number between ${min} and ${max})`;
    }
  }
  const extra = spec.check?.(value) ?? null;
  if (extra !== null) {
    const hint = extra.hint === undefined ? '' : ` (${extra.hint})`;
    return `'${value}' is not a valid ${extra.noun} for ${key}${hint}`;
  }
  return null;
}

/** Everything the verbs read off the command line. */
export interface FlowCommandOptions {
  /** The project root. Defaults to the current directory. */
  target: string;
  /** Emit the result object rather than the human lines. */
  json?: boolean;
  /** `stage` only — ask whether the named stage may run. Required by `stage`. */
  check?: boolean;
  /** `stage` only — the feature slug every proof is scoped to. Required. */
  feature?: string;
  /**
   * `stage` and `risk` — the chain driving this call.
   *
   * ITS PRESENCE IS THE ENFORCEMENT (discovery R3). With it, a missing record
   * refuses; without it the same verdict is reported and exit stays 0, so a
   * person invoking a stage or a publish by hand is never refused into a corner.
   *
   * ON `risk` IT IS ALSO THE IDENTITY. `--record` stamps it onto the entry and
   * `--check` admits only entries carrying it, which is what stops an appended
   * line from answering for a run it has nothing to do with (#1915 C1). The id
   * is the harness's own — it rides on the `<!-- flow-chain: … -->` marker in the
   * message that started the run — and is never invented by a caller.
   */
  chain?: string;
  /**
   * `risk` only — the instant the run began, for a caller that knows WHEN but
   * not what the plan was called. The feature is resolved from the record's own
   * newest entry at or after it (`../state/risk-record.ts`).
   */
  since?: string;
  /**
   * `risk` only — record an assessment at this level rather than reading one.
   *
   * THE WRITING HALF OF THE SAME VERB, and the one writer of a `risk` entry.
   * `--check` and `--record` are mutually exclusive: a call that both asked and
   * answered would be the defect this fixes wearing a command line
   * (`./flow-risk-record.ts`).
   */
  record?: string;
  /** `risk --record` only — the one sentence the coordinator wrote about the changeset. */
  rationale?: string;
  /** `pushed-through`, `risk --record` and `run-start` — the run id the entry belongs to. Never minted here. */
  run?: string;
  /** `pushed-through` only — the coordinator's sentence about what it went past. */
  detail?: string;
  /** `run-start` only — the plan the run executes (slug or plan file name). */
  plan?: string;
}

/** What every verb returns — one object, two formatters. */
export interface FlowResult {
  verb: FlowVerb;
  target: string;
  /** Keys written by this call, in the order they were given (`set`). */
  set?: Record<string, string>;
  /** Keys removed by this call (`unset`) — only those that were actually there. */
  unset?: string[];
  /** Keys named for removal that the file did not carry. */
  absent?: string[];
  /** `stage` only — whether the named stage may run, and what says so. */
  stage?: StageCheckVerdict;
  /** `risk --check` only — whether the work may be published, and what says so. */
  risk?: RiskCheckVerdict;
  /** `risk --record` only — the assessment that was appended, stamp included. */
  riskRecorded?: RiskEntry;
  /** `pushed-through` only — the entry that was appended. */
  pushedThrough?: PushedThroughEntry;
  /** `run-start` only — the `run_intent` that was appended, `base` included. */
  runStart?: RunStartEntry;
  /** The fully-defaulted config as every consumer reads it. */
  config: FlowConfig;
  /**
   * The keys literally present in the file, with their raw values. PRESENCE IS
   * THE POINT: `config` cannot tell a project that set `commit: false` from
   * one that never mentioned it, and that difference is what inheritance and
   * provenance are built on.
   */
  raw: Record<string, string>;
}

/** Normalize any thrown error into a single `flow refused: <reason>` line. */
function toRefusalLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(FLOW_REFUSED_PREFIX) ? message : `${FLOW_REFUSED_PREFIX} ${message}`;
}

/** `<project>/flow`, where the config lives. */
function flowDirOf(target: string): string {
  return join(resolve(target), 'flow');
}

/** The raw text of the project's config, or '' when it has none. */
function readConfigText(flowDir: string): string {
  const configPath = join(flowDir, '.flowconfig');
  if (!existsSync(configPath)) return '';
  try {
    return readFileSync(configPath, 'utf-8');
  } catch {
    // Sanctioned fail-soft: an unreadable config reads as an empty one here,
    // exactly as it does for the parser. The write below recreates it.
    return '';
  }
}

/** Read both views of the config — defaulted, and as literally written. */
function readViews(flowDir: string): { config: FlowConfig; raw: Record<string, string> } {
  return { config: parseFlowConfig(flowDir), raw: parseFlowconfigKeys(readConfigText(flowDir)) };
}

/**
 * Split `key=value` at the FIRST `=`, so a value may contain its own
 * (`commands.lint=npm run lint -- --fix`).
 */
function splitPair(argument: string): { key: string; value: string } {
  const cut = argument.indexOf('=');
  if (cut <= 0) {
    throw new Error(`'${argument}' is not a key=value pair`);
  }
  return { key: argument.slice(0, cut).trim(), value: argument.slice(cut + 1).trim() };
}

/**
 * `flow set <key>=<value> ...` — validate the WHOLE batch, then write it.
 *
 * One merge for the batch rather than one per pair: a half-applied batch is a
 * config nobody asked for, and the merge already takes a set of keys.
 */
function runSet(args: string[], options: FlowCommandOptions): FlowResult {
  if (args.length === 0) {
    throw new Error('set needs at least one key=value pair');
  }

  const updates: Record<string, string> = {};
  for (const argument of args) {
    const { key, value } = splitPair(argument);
    const spec = specFor(key);
    if (spec === null) throw new Error(`unknown key '${key}'`);
    const reason = invalidValueReason(key, spec, value);
    if (reason !== null) throw new Error(reason);
    // An old name is accepted as input and written under the new one.
    updates[canonicalFlowconfigKey(key)] = value;
  }

  const target = resolve(options.target);
  const flowDir = flowDirOf(target);

  // `share` is the one key with a second half: the `.gitignore` block is
  // GENERATED from it, so writing the key alone would leave the block stating
  // a mode the project no longer has. `applyShareMode` persists the key and
  // regenerates the block in one code path — this verb defers to it rather
  // than growing a second, quieter way to change the same setting.
  const shareMode = updates['share'];
  const fileUpdates: Record<string, string | null> = { ...updates };
  if (shareMode !== undefined) {
    delete fileUpdates['share'];
    applyShareMode(target, shareMode as ShareMode);
  }
  // A RENAMED KEY IS WRITTEN UNDER BOTH SPELLINGS, WITH THE SAME VALUE — and
  // only a key this call is setting. Older Flow builds and CLIs read only the
  // old spelling and share this project, so the change has to reach them too;
  // `flow unset` removes both. Every other old key in the file stays exactly
  // where it is. TRANSITIONAL: once no build older than the rename is in use,
  // this goes back to dropping the old line instead.
  for (const key of Object.keys(fileUpdates)) {
    const legacy = legacyKeyOf(key);
    if (legacy !== undefined) fileUpdates[legacy] = fileUpdates[key];
  }
  writeFlowconfigKeys(flowDir, fileUpdates);

  return { verb: 'set', target, set: updates, ...readViews(flowDir) };
}

/**
 * `flow unset <key> ...` — remove keys so the layer beneath answers again.
 *
 * An ABSENT key is the only honest way to say "no opinion here": a key parked
 * on the default's current value freezes that value the day the default moves.
 * Naming a key the file does not carry is reported, not refused — the end
 * state the caller asked for is the state they get.
 */
function runUnset(args: string[], options: FlowCommandOptions): FlowResult {
  if (args.length === 0) {
    throw new Error('unset needs at least one key');
  }

  const keys: string[] = [];
  for (const argument of args) {
    const key = argument.trim();
    if (key.includes('=')) {
      throw new Error(`'${argument}' names a value — unset takes keys alone`);
    }
    if (specFor(key) === null) throw new Error(`unknown key '${key}'`);
    // Reported, and removed, under the setting's current name.
    const canonical = canonicalFlowconfigKey(key);
    if (!keys.includes(canonical)) keys.push(canonical);
  }

  const target = resolve(options.target);
  const flowDir = flowDirOf(target);
  const before = parseFlowconfigKeys(readConfigText(flowDir));

  // A renamed setting goes back to its default only when BOTH spellings are
  // gone — the old key is read whenever the new one is absent.
  const spellings = (key: string): string[] => {
    const legacy = legacyKeyOf(key);
    return legacy === undefined ? [key] : [key, legacy];
  };
  const isPresent = (key: string): boolean => spellings(key).some((name) => name in before);

  const removals: Record<string, null> = {};
  for (const key of keys) {
    for (const name of spellings(key)) removals[name] = null;
  }
  writeFlowconfigKeys(flowDir, removals);

  return {
    verb: 'unset',
    target,
    unset: keys.filter(isPresent),
    absent: keys.filter((key) => !isPresent(key)),
    ...readViews(flowDir),
  };
}

/**
 * `flow stage <stage> --check --feature <slug> [--chain <id>]` — may this rung run?
 *
 * READ-ONLY. It writes nothing, ever: the verdict is a fact about artifacts
 * already on disk, and a gate that recorded its own findings would become a
 * second source of truth about the ladder within a week.
 *
 * `--check` is required rather than assumed so that `flow stage create-plan`
 * alone is a refusal a person can read, not a silent default chosen for them —
 * the flag is the whole surface the plan names, and a future `stage` sub-mode
 * inherits an unambiguous command line.
 */
function runStage(args: string[], options: FlowCommandOptions): FlowResult {
  const named = args[0];
  if (named === undefined || named.trim().length === 0) {
    throw new Error(`stage needs a stage to check — expected ${FLOW_STAGE_USAGE}`);
  }
  if (args.length > 1) {
    throw new Error('stage checks one stage at a time');
  }
  if (options.check !== true) {
    throw new Error(`stage takes --check — expected ${FLOW_STAGE_USAGE}`);
  }
  const feature = (options.feature ?? '').trim();
  if (feature.length === 0) {
    // The ladder's proofs are feature-scoped and the loose question lives
    // behind its own name for a reason: unscoped, this repo reports every rung
    // done at all times, so the gate would be permanently open and look shut.
    throw new Error(`stage needs --feature <slug> to scope its proofs to — expected ${FLOW_STAGE_USAGE}`);
  }

  const target = resolve(options.target);
  const flowDir = flowDirOf(target);
  const stage = checkStage(flowDir, {
    stage: requireStage(named),
    feature,
    mode: enforcementModeOf(options.chain),
  });

  return { verb: 'stage', target, stage, ...readViews(flowDir) };
}

/**
 * `flow risk` — ASK the record (`--check`), or WRITE to it (`--record`).
 *
 * TWO HALVES OF ONE FACT, AND NEVER IN ONE CALL. The gate is read-only exactly
 * like `stage`, and the writer is its own module; a call that both recorded an
 * assessment and then asked whether it passed would be the C1 defect wearing a
 * command line — the question answering itself. `--check` and `--record`
 * together is a refusal, and neither one is defaulted.
 */
function runRisk(args: string[], options: FlowCommandOptions): FlowResult {
  const recording = (options.record ?? '').trim();
  if (options.check === true && recording.length > 0) {
    throw new Error(
      'risk either asks the record or writes to it, never both in one call — ' +
        `expected ${FLOW_RISK_USAGE} or ${FLOW_RISK_RECORD_USAGE}`,
    );
  }
  if (recording.length > 0) {
    return runRiskRecord(args, options, recording);
  }
  return runRiskCheck(args, options);
}

/**
 * `flow risk --check (--feature <slug> | --since <iso>) [--chain <id>]` — may
 * this work be published?
 *
 * READ-ONLY, exactly like `stage`: the verdict is a fact about a record already
 * on disk, and a gate that wrote its own findings would become a second source
 * of truth about the run within a week.
 *
 * EXACTLY ONE SCOPE. `--feature` is the caller that knows the plan slug (the
 * `/execute-plan` skill); `--since` is the caller that knows when its run began
 * but not what the plan was called (the IDE chain drives a thread). Neither is
 * defaulted and both together is a refusal: an unscoped read of a per-project
 * record lets one plan's assessment gate — or clear — another's, which is the
 * gate that is always open and looks shut.
 *
 * `--chain` narrows further and is the identity, not a preference: under it the
 * gate reads only what that chain recorded (`./flow-risk.ts`).
 */
function runRiskCheck(args: string[], options: FlowCommandOptions): FlowResult {
  if (args.length > 0) {
    throw new Error(`risk takes no arguments — expected ${FLOW_RISK_USAGE}`);
  }
  if (options.check !== true) {
    throw new Error(`risk takes --check — expected ${FLOW_RISK_USAGE}`);
  }
  const feature = (options.feature ?? '').trim();
  const since = (options.since ?? '').trim();
  if (feature.length > 0 && since.length > 0) {
    throw new Error(`risk takes one scope, not both — expected ${FLOW_RISK_USAGE}`);
  }
  if (feature.length === 0 && since.length === 0) {
    throw new Error(`risk needs a scope to read the record with — expected ${FLOW_RISK_USAGE}`);
  }

  const target = resolve(options.target);
  const flowDir = flowDirOf(target);
  const risk = checkRisk(flowDir, {
    scope: feature.length > 0 ? { kind: 'stated', feature } : { kind: 'observed', since },
    mode: enforcementModeOf(options.chain),
  });

  return { verb: 'risk', target, risk, ...readViews(flowDir) };
}

/**
 * `flow risk --record <level> --feature <slug> --run <run-id> [--chain <id>]` —
 * the ONE writer of a `risk` entry.
 *
 * It validates the vocabulary and the envelope and stamps the chain; it does not
 * judge, and it does not read the record for permission to write
 * (`./flow-risk-record.ts` argues why it exists at all).
 *
 * IT REFUSES TO MINT A RUN ID IT WAS NOT GIVEN, exactly as `pushed-through`
 * does: a run has one id and nobody invents a second scheme.
 */
function runRiskRecord(
  args: string[],
  options: FlowCommandOptions,
  level: string,
): FlowResult {
  if (args.length > 0) {
    throw new Error(`risk takes no arguments — expected ${FLOW_RISK_RECORD_USAGE}`);
  }
  const feature = (options.feature ?? '').trim();
  if (feature.length === 0) {
    throw new Error(
      `risk --record needs --feature <slug> to scope the record to — expected ${FLOW_RISK_RECORD_USAGE}`,
    );
  }
  const runId = (options.run ?? '').trim();
  if (runId.length === 0) {
    throw new Error(`risk --record needs --run <run-id> — expected ${FLOW_RISK_RECORD_USAGE}`);
  }

  const target = resolve(options.target);
  const flowDir = flowDirOf(target);
  const riskRecorded = recordRisk(flowDir, {
    level: requireRiskLevel(level),
    feature,
    runId,
    // NOT DEFAULTED, AND NOT GUESSED. An absent chain writes an unstamped entry
    // that no enforced gate will accept — which is the safe direction for a
    // forgotten flag (`../state/risk-record.ts`).
    chain: (options.chain ?? '').trim() || null,
    rationale: (options.rationale ?? '').trim() || null,
  });

  return { verb: 'risk', target, riskRecorded, ...readViews(flowDir) };
}

/**
 * `flow pushed-through <stop> --feature <slug> --run <run-id>` — record that an
 * enforced run went past a stop it used to honour.
 *
 * The ONE writer of a `pushed_through` entry. It does not judge and does not
 * push anything through; it validates the vocabulary and the envelope so the
 * record cannot drift into four spellings of the same fact.
 */
function runPushedThrough(args: string[], options: FlowCommandOptions): FlowResult {
  const named = args[0];
  if (named === undefined || named.trim().length === 0) {
    throw new Error(
      `pushed-through needs a stop to record — expected ${qualityStopVocabulary()}`,
    );
  }
  if (args.length > 1) {
    throw new Error('pushed-through records one stop at a time');
  }
  const feature = (options.feature ?? '').trim();
  if (feature.length === 0) {
    throw new Error(
      `pushed-through needs --feature <slug> to scope the record to — expected ${FLOW_PUSHED_THROUGH_USAGE}`,
    );
  }
  const runId = (options.run ?? '').trim();
  if (runId.length === 0) {
    // The record's own rule: a run has one id and nobody invents a second
    // scheme. A verb that could not be given one would have to make one up.
    throw new Error(
      `pushed-through needs --run <run-id> — expected ${FLOW_PUSHED_THROUGH_USAGE}`,
    );
  }

  const target = resolve(options.target);
  const flowDir = flowDirOf(target);
  const pushedThrough = recordPushedThrough(flowDir, {
    stop: requireQualityStop(named),
    feature,
    runId,
    chain: (options.chain ?? '').trim() || null,
    detail: (options.detail ?? '').trim() || null,
  });

  return { verb: 'pushed-through', target, pushedThrough, ...readViews(flowDir) };
}

/**
 * `flow run-start --plan <name> --run <run-id>` — record the commit a plan's run
 * starts from, as a `run_intent` carrying `base` (`./flow-run-start.ts`).
 *
 * The ONE writer of that line: `blueprint storyline` reads it to know what
 * Today was, and a reader's input is never hand-composed (forbidden-pattern #18).
 */
function runRunStart(args: string[], options: FlowCommandOptions): FlowResult {
  if (args.length > 0) {
    throw new Error(`run-start takes no arguments — expected ${FLOW_RUN_START_USAGE}`);
  }
  const plan = (options.plan ?? '').trim();
  if (plan.length === 0) {
    throw new Error(`run-start needs --plan <name> — expected ${FLOW_RUN_START_USAGE}`);
  }
  const runId = (options.run ?? '').trim();
  if (runId.length === 0) {
    throw new Error(`run-start needs --run <run-id> — expected ${FLOW_RUN_START_USAGE}`);
  }
  const target = resolve(options.target);
  const flowDir = flowDirOf(target);
  const runStart = recordRunStart({ target, flowDir, plan, runId });
  return { verb: 'run-start', target, runStart, ...readViews(flowDir) };
}

/** `flow show` — what this project says, and what it therefore runs with. */
function runShow(options: FlowCommandOptions): FlowResult {
  const target = resolve(options.target);
  return { verb: 'show', target, ...readViews(flowDirOf(target)) };
}

/**
 * How many allowlisted keys this project leaves at their defaults — a renamed
 * key counts as set when the file carries either of its spellings.
 */
function unsetCount(raw: Record<string, string>): number {
  return Object.keys(FLOW_KEYS).filter((key) => {
    const legacy = legacyKeyOf(key);
    return !(key in raw) && (legacy === undefined || !(legacy in raw));
  }).length;
}

/** The human rendering of the same result object. */
function renderHuman(result: FlowResult): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(result.set ?? {})) {
    lines.push(`flow: set ${key}=${value}`);
  }
  for (const key of result.unset ?? []) {
    lines.push(`flow: unset ${key}`);
  }
  for (const key of result.absent ?? []) {
    lines.push(`flow: ${key} was already at its default`);
  }

  if (result.stage !== undefined) {
    lines.push(...renderStageVerdict(result.stage));
  }

  if (result.risk !== undefined) {
    lines.push(...renderRiskVerdict(result.risk));
  }

  if (result.riskRecorded !== undefined) {
    const { risk_level: level, risk_rationale: rationale, chain } = result.riskRecorded;
    lines.push(
      `flow: recorded this work as ${level} risk${rationale === null ? '' : ` — ${rationale}`}`,
    );
    // SAID OUT LOUD, because it is the difference between an entry an enforced
    // gate will read and one it will refuse — and a coordinator that forgot the
    // flag finds out here rather than at the publish seam.
    lines.push(
      chain === null
        ? '  no chain was named, so this entry satisfies no enforced publish gate'
        : `  chain: ${chain}`,
    );
  }

  if (result.pushedThrough !== undefined) {
    const { stop, detail } = result.pushedThrough;
    lines.push(
      `flow: recorded that this run went past ${stop}${detail === null ? '' : ` — ${detail}`}`,
    );
  }

  if (result.runStart !== undefined) {
    const { plan, base, run_id: runId } = result.runStart;
    lines.push(`flow: recorded that run ${runId} of ${plan} starts from ${base.slice(0, 12)}`);
  }

  if (result.verb === 'show') {
    const entries = Object.entries(result.raw);
    lines.push(
      entries.length === 0
        ? 'flow: this project sets nothing — every setting is at its default'
        : `flow: ${entries.length} setting(s) set by this project`,
    );
    for (const [key, value] of entries) {
      lines.push(`  ${key}: ${value === '' ? '(blank)' : value}`);
    }
    const remaining = unsetCount(result.raw);
    // Only alongside a list — after "this project sets nothing" the count says
    // the same thing a second time.
    if (entries.length > 0 && remaining > 0) {
      lines.push(`  (${remaining} other setting(s) at their defaults)`);
    }
  }

  return lines.join('\n');
}

/** Route a verb to its runner. */
function dispatch(verb: FlowVerb, args: string[], options: FlowCommandOptions): FlowResult {
  switch (verb) {
    case 'set':
      return runSet(args, options);
    case 'unset':
      return runUnset(args, options);
    case 'show':
      return runShow(options);
    case 'stage':
      return runStage(args, options);
    case 'risk':
      return runRisk(args, options);
    case 'pushed-through':
      return runPushedThrough(args, options);
    case 'run-start':
      return runRunStart(args, options);
  }
}

/**
 * `flow <verb>` — the settings family behind one refusal contract.
 *
 * On any failure: one `flow refused:` line, exit 1, and nothing written. The
 * whole batch is validated before the merge runs, so a refusal never leaves
 * half a change behind.
 */
export function runFlow(verb: string, args: string[], options: FlowCommandOptions): void {
  try {
    if (!isFlowVerb(verb)) {
      throw new Error(`unknown verb '${verb}' — expected ${FLOW_VERBS.join('|')}`);
    }
    const result = dispatch(verb, args, options);
    process.stdout.write(
      options.json === true ? `${JSON.stringify(result)}\n` : `${renderHuman(result)}\n`,
    );
  } catch (error) {
    // A refusal that asks a question carries its own answer (allowed-pattern
    // #21): the payload goes out on stdout FIRST, then the prose line on the
    // same stream — which is why consumers scan for the last parseable `{`
    // line (allowed-pattern #24) rather than assuming stdout is only JSON.
    if (error instanceof StageCheckRefusal || error instanceof RiskCheckRefusal) {
      process.stdout.write(`${JSON.stringify(error.payload)}\n`);
    }
    log.error(toRefusalLine(error));
    process.exitCode = 1;
  }
}
