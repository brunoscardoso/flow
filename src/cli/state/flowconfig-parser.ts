/**
 * Flowconfig Parser
 *
 * Parses `flow/.flowconfig` YAML into a structured FlowConfig object.
 * Uses regex-based line parsing consistent with the heartbeat daemon pattern.
 * Provides legacy fallbacks for `.autopilot` and `.gitcontrol` files.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WALKTHROUGH_MODELS, type EngineStatus, type FlowConfig, type WalkthroughModel } from './types.js';
import { stripTrailingComment } from '../utils/config-comment.js';
import { readAliasedKey } from './flowconfig-aliases.js';

const DEFAULT_CONFIG: FlowConfig = {
  // A PROJECT NOBODY HAS ASKED HAS AUTOPILOT OFF, and this constant now says
  // so. It used to say `true` and nothing ever read it: both branches of
  // `parseFlowConfig` below assign `autopilot` unconditionally — from the
  // `autopilot` key when it is present, and from the legacy `.autopilot`
  // marker file when it is not — so the effective default has always been
  // `false` while the literal announced the opposite (discovery C4).
  //
  // Not a live bug, and it is fixed anyway because enforcement keys entirely
  // on this value: the chain refuses to start on a project whose switch is
  // off, so a reader who trusts this line concludes that every project
  // chains by default. A constant that contradicts the behaviour is a
  // second specification (allowed-pattern #14), and the only reason this one
  // never lied out loud is that the code never asked it.
  autopilot: false,
  commit: false,
  push: false,
  pr: false,
  pr_draft: false,
  guarded_autopilot: false,
  branch: '',
  remote: 'origin',
  base_refresh: true,
  wave_execution: true,
  phase_isolation: true,
  model_routing: true,
  max_verify_retries: 2,
  walkthrough_model: 'sonnet',
};

const MIN_VERIFY_RETRIES = 1;
const MAX_VERIFY_RETRIES = 5;

/**
 * Extract a boolean value from flowconfig content by key name.
 * Returns undefined if the key is not found.
 *
 * Post-colon whitespace stays on the SAME line (`[ \t]`), for the reason
 * spelled out on `extractString` below and in forbidden-pattern #16: with
 * `\s*` a key left blank reads the next line's value as its own, and a
 * boolean that silently inherits the neighbouring key's `true` is a setting
 * nobody wrote. An absent value must read as absent, which for a boolean
 * means "the default", not "whatever came next".
 */
function extractBoolean(content: string, key: string): boolean | undefined {
  const match = content.match(new RegExp(`^${key}:[ \\t]*(true|false)`, 'm'));
  if (!match) return undefined;
  return match[1] === 'true';
}

/**
 * Extract a string value from flowconfig content by key name.
 * Returns undefined if the key is not found.
 *
 * Post-colon whitespace is constrained to the same line (`[ \t]`), matching the
 * dotted-key extractors below. With `\s*` a KEY LEFT BLANK swallowed the next
 * line as its own value — `remote:` followed by `remote_branch_pattern: x`
 * parsed the remote as `"remote_branch_pattern:"`, and a blank `branch:` took
 * whatever line came after it as the project's base branch. A config key that
 * silently names a destination nobody wrote is the same class of bug as an
 * unbound push (thread_remote_binding); an absent value must read as absent.
 *
 * AND WHERE IT ENDS. `(.+)` runs to end of line, so a trailing `# …` comment
 * became part of the value (#1804) — the same class of defect one character
 * later on the same line. Its boolean and number siblings never had it, because
 * `(true|false)` and `(\d+)` stop at the value; so this one file tolerated
 * comments on some keys and corrupted others. `branch: main   # note` became a
 * PR base no branch answers to.
 */
function extractString(content: string, key: string): string | undefined {
  // THE CAPTURE STARTS AT THE COLON, whitespace included, so the comment rule
  // can see whether the `#` was introduced by whitespace. Consuming the spaces
  // in `[ \t]*` first would hide that: `branch:   # not decided yet` would
  // arrive as `#·not·decided·yet` with nothing in front of the `#`, survive the
  // strip, and become a base branch reading `"# not decided yet"` — a key left
  // blank on purpose, silently naming a destination nobody wrote, which is the
  // very failure this extractor was narrowed for once already.
  const match = content.match(new RegExp(`^${key}:([ \\t]*.*)$`, 'm'));
  if (!match) return undefined;
  const value = stripTrailingComment(match[1]).trim();
  // Nothing but a comment leaves no value behind, and an empty string is not
  // one — absent must read as absent, so the default can apply.
  return value.length === 0 ? undefined : value;
}

/**
 * Extract a numeric value from flowconfig content by key name.
 * Returns undefined if the key is not found — which includes a key left
 * blank and a key whose value is not a number at all.
 *
 * Same-line whitespace only (forbidden-pattern #16): a blank
 * `base_refresh_timeout_ms:` followed by `max_verify_retries: 2` must not
 * become a two-millisecond timeout.
 */
function extractNumber(content: string, key: string): number | undefined {
  const match = content.match(new RegExp(`^${key}:[ \\t]*(\\d+)`, 'm'));
  if (!match) return undefined;
  return parseInt(match[1], 10);
}

/**
 * Extract engine registry entries from flowconfig content.
 * Collects dotted keys `engines.<name>: enabled|declined|pending` per line.
 * Unknown dotted suffixes (e.g. `engines.lavish.asked_at`) are ignored.
 * Returns undefined if no engine keys are found.
 */
function extractEngines(content: string): Record<string, EngineStatus> | undefined {
  // Object.create(null): a prototype-less accumulator so an engine literally
  // named `__proto__` is stored as a plain key instead of hitting the prototype setter.
  const engines: Record<string, EngineStatus> = Object.create(null);
  // Post-colon whitespace is constrained to the same line ([ \t]) so a value
  // on the following line cannot leak into this key via `\s` matching `\n`.
  const pattern = /^engines\.([a-z0-9_-]+):[ \t]*(enabled|declined|pending)[ \t\r]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    engines[match[1]] = match[2] as EngineStatus;
  }
  return Object.keys(engines).length > 0 ? engines : undefined;
}

/**
 * Extract the one-time graphify migration marker
 * `engines.graphify_migration_asked: true|false` from flowconfig content.
 * This dotted key carries a boolean (not an engine status), so it is read
 * separately from `extractEngines`. Returns undefined if not present.
 */
function extractGraphifyMigrationAsked(content: string): boolean | undefined {
  // Post-colon whitespace is constrained to the same line ([ \t]) so a value
  // on the following line cannot leak into this key via `\s` matching `\n`.
  const match = content.match(/^engines\.graphify_migration_asked:[ \t]*(true|false)[ \t\r]*$/m);
  if (!match) return undefined;
  return match[1] === 'true';
}

/**
 * Extract project command entries from flowconfig content.
 * Collects dotted keys `commands.<name>: <cmd>` per line (currently only `commands.lint`).
 * Unknown command names are ignored. Returns undefined if no command keys are found.
 */
function extractCommands(content: string): { lint?: string } | undefined {
  // Post-colon whitespace is constrained to the same line ([ \t]) so a value
  // on the following line cannot leak into this key via `\s` matching `\n`.
  // Captured from the colon for the same reason `extractString` is (#1804).
  const match = content.match(/^commands\.lint:([ \t]*.*)$/m);
  if (!match) return undefined;
  // A lint command carrying `  # note` into a shell is the same bug wearing
  // different clothes.
  const lint = stripTrailingComment(match[1]).trim();
  // A trimmed-empty value means no lint command is configured.
  if (lint === '') return undefined;
  return { lint };
}

/**
 * Read legacy `.autopilot` file to determine autopilot setting.
 * File existence means autopilot is enabled.
 */
function readLegacyAutopilot(flowDir: string): boolean {
  return existsSync(join(flowDir, '.autopilot'));
}

/**
 * Read legacy `.gitcontrol` file for commit/push/branch settings.
 * Returns partial config values found in the file.
 */
function readLegacyGitControl(flowDir: string): { commit?: boolean; push?: boolean; branch?: string } {
  const gitControlPath = join(flowDir, '.gitcontrol');
  if (!existsSync(gitControlPath)) return {};

  try {
    const content = readFileSync(gitControlPath, 'utf-8');
    return {
      commit: extractBoolean(content, 'commit'),
      push: extractBoolean(content, 'push'),
      branch: extractString(content, 'branch'),
    };
  } catch {
    return {};
  }
}

/**
 * Parse `flow/.flowconfig` into a structured FlowConfig object.
 *
 * Applies defaults for missing keys and falls back to legacy files
 * (`.autopilot`, `.gitcontrol`) when keys are absent from `.flowconfig`.
 */
export function parseFlowConfig(flowDir: string): FlowConfig {
  const configPath = join(flowDir, '.flowconfig');
  const config: FlowConfig = { ...DEFAULT_CONFIG };

  if (!existsSync(configPath)) {
    // No .flowconfig — use legacy fallbacks + defaults
    config.autopilot = readLegacyAutopilot(flowDir);
    const legacy = readLegacyGitControl(flowDir);
    if (legacy.commit !== undefined) config.commit = legacy.commit;
    if (legacy.push !== undefined) config.push = legacy.push;
    if (legacy.branch !== undefined) config.branch = legacy.branch;
    return config;
  }

  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch {
    return config;
  }

  // Parse boolean keys
  const autopilot = extractBoolean(content, 'autopilot');
  if (autopilot !== undefined) {
    config.autopilot = autopilot;
  } else {
    // Legacy fallback: check .autopilot file
    config.autopilot = readLegacyAutopilot(flowDir);
  }

  const commit = extractBoolean(content, 'commit');
  const push = extractBoolean(content, 'push');
  const pr = extractBoolean(content, 'pr');
  const prDraft = extractBoolean(content, 'pr_draft');
  const guardedAutopilot = extractBoolean(content, 'guarded_autopilot');
  const branch = extractString(content, 'branch');
  const provider = extractString(content, 'provider');
  // `remote` and `remote_branch_pattern` (thread_remote_binding). `remote:`
  // cannot be matched by `remote_branch_pattern:` — `extractString` anchors the
  // colon to the key — so the two are read independently.
  const remote = extractString(content, 'remote');
  const remoteBranchPattern = extractString(content, 'remote_branch_pattern');

  if (commit !== undefined) {
    config.commit = commit;
  }
  if (push !== undefined) {
    config.push = push;
  }
  if (pr !== undefined) {
    config.pr = pr;
  }
  if (prDraft !== undefined) {
    config.pr_draft = prDraft;
  }
  if (guardedAutopilot !== undefined) {
    config.guarded_autopilot = guardedAutopilot;
  }
  if (branch !== undefined) {
    config.branch = branch;
  }
  if (provider !== undefined) {
    config.provider = provider;
  }
  // A blank value is "not configured", not "the empty remote": an empty remote
  // name would reach `git push ''` and fail with git's error rather than ours.
  if (remote !== undefined && remote !== '') {
    config.remote = remote;
  }
  // Absent OR blank leaves the pattern unset, so the suggestion ladder starts
  // at its second rung instead of proposing an empty branch name.
  if (remoteBranchPattern !== undefined && remoteBranchPattern !== '') {
    config.remote_branch_pattern = remoteBranchPattern;
  }

  // Legacy fallback for git keys not found in .flowconfig
  if (commit === undefined || push === undefined || branch === undefined) {
    const legacy = readLegacyGitControl(flowDir);
    if (commit === undefined && legacy.commit !== undefined) config.commit = legacy.commit;
    if (push === undefined && legacy.push !== undefined) config.push = legacy.push;
    if (branch === undefined && legacy.branch !== undefined) config.branch = legacy.branch;
  }

  const waveExecution = extractBoolean(content, 'wave_execution');
  if (waveExecution !== undefined) config.wave_execution = waveExecution;

  const phaseIsolation = extractBoolean(content, 'phase_isolation');
  if (phaseIsolation !== undefined) config.phase_isolation = phaseIsolation;

  const modelRouting = extractBoolean(content, 'model_routing');
  if (modelRouting !== undefined) config.model_routing = modelRouting;

  // Worktree defaults (worktree_settings_ui). All three are OPTIONAL layers:
  // absent means the project has no opinion and the IDE's resolver falls
  // through to the user's global default and then to the built-in, which is
  // today's behaviour. Nothing here is clamped or enum-checked — the resolver
  // clamps the timeout, and `flow set` refuses a bad value where it is typed
  // (allowed-pattern #22), so a hand-edited oddity still reaches a layer that
  // can report it rather than being silently rewritten here.
  //
  // `worktree_start` was once `workspace_start`; the old key is read forever
  // when the new one is absent, and the old one wins when both are present (dual-write: an older build writes only it)
  // (`./flowconfig-aliases.ts`).
  const worktreeStart = readAliasedKey('worktree_start', (key) => extractString(content, key));
  if (worktreeStart !== undefined && worktreeStart !== '') {
    config.worktree_start = worktreeStart;
  }

  // Default ON, and only the literal `false` turns it off — the same rule the
  // app applies to `thread_worktrees` and `learn_auto`, because the failure
  // mode of guessing "off" is a safeguard that quietly stops running.
  const baseRefresh = extractBoolean(content, 'base_refresh');
  if (baseRefresh !== undefined) config.base_refresh = baseRefresh;

  const baseRefreshTimeoutMs = extractNumber(content, 'base_refresh_timeout_ms');
  if (baseRefreshTimeoutMs !== undefined) config.base_refresh_timeout_ms = baseRefreshTimeoutMs;

  const maxVerifyRetries = extractNumber(content, 'max_verify_retries');
  if (maxVerifyRetries !== undefined) {
    config.max_verify_retries = Math.max(MIN_VERIFY_RETRIES, Math.min(MAX_VERIFY_RETRIES, maxVerifyRetries));
  }

  // Anything but a known tier reads as the default: the value picks a model
  // for a sub-agent, and a typo must not become a model name nobody offers.
  const walkthroughModel = extractString(content, 'walkthrough_model');
  if (walkthroughModel !== undefined && (WALKTHROUGH_MODELS as readonly string[]).includes(walkthroughModel)) {
    config.walkthrough_model = walkthroughModel as WalkthroughModel;
  }

  // A project's own cache directories, comma-separated. Entries are names as
  // they sit in the main checkout; the link step skips any that are absent, so
  // a stale entry costs nothing.
  const links = extractString(content, 'worktree_links');
  if (links !== undefined) {
    const entries = links
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (entries.length > 0) config.worktree_links = entries;
  }

  // Parse dotted keys: engine registry and project commands.
  // Absent keys leave the optional fields undefined (backward compatible).
  const engines = extractEngines(content);
  if (engines !== undefined) config.engines = engines;

  const graphifyMigrationAsked = extractGraphifyMigrationAsked(content);
  if (graphifyMigrationAsked !== undefined) config.graphify_migration_asked = graphifyMigrationAsked;

  const commands = extractCommands(content);
  if (commands !== undefined) config.commands = commands;

  // Validation cascade: pr → push → commit
  if (config.pr) {
    config.push = true;
    config.commit = true;
  } else if (config.push) {
    config.commit = true;
  }

  return config;
}
