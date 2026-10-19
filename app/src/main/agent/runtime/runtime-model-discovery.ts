// Which models has this runtime actually used? (multi_runtime_support)
//
// Flow cannot ASK either CLI what an account may use — no subcommand, no API
// Flow is entitled to call. So the picker offered Auto and whatever the user
// typed, and somebody looking at Codex's own `/model` list (which shows
// several) reasonably read that as broken.
//
// But both tools write down what they ran, and that is a better answer than a
// hardcoded list: it is this account's, on this machine, and it cannot go stale
// against a plan change.
//
//   ~/.codex/sessions/**/rollout-*.jsonl   each session's first lines carry
//                                          "model":"gpt-5.1-codex-max"
//   ~/.copilot/data.db                     provider_models (the CLI's own
//                                          catalogue) + sessions.model
//   ~/.claude.json                         modelAccessCache (per-account
//                                          entitlement) + additionalModelOptions
//                                          Cache (the CLI's own extra picker
//                                          entries, with labels)
//
// CLAUDE WAS THE ONE RUNTIME LEFT OUT of all this, and its picker was five
// hardcoded aliases as a result: a model an account gained never appeared, and
// the composer explicitly skipped this module for `claude` (see threads/index).
// It turns out Claude has the RICHEST source of the three — its config carries
// an entitlement list AND the extra options its own picker shows.
//
// Measured here: the newest rollouts answer in 1-6 ms each, and the sweep is
// bounded to the newest handful — the vault-scan lesson (a directory that grows
// forever must never be walked in full).

import { readdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { AUTO_MODEL, modelOptionsFor } from '../../../shared/runtime-models'

export interface ModelDiscoveryDeps {
  homedirFn?: () => string
  env?: NodeJS.ProcessEnv
  /** Injected in tests: list a directory (names only). */
  readdirFn?: (path: string) => string[]
  /** Injected in tests: read a file. */
  readFileFn?: (path: string) => string
  /** Injected in tests: newest-first ordering key. */
  mtimeFn?: (path: string) => number
  /** Injected in tests: rows from copilot's own database. */
  copilotModelsFn?: (dbPath: string) => string[]
}

/** How many session files a sweep looks at. Newest first; the rest are history. */
const SESSION_SCAN_LIMIT = 12

/** `"model":"…"` as it appears in a rollout line. */
const MODEL_IN_JSON = /"model"\s*:\s*"([^"]+)"/g

function codexHome(deps: ModelDiscoveryDeps): string {
  const env = deps.env ?? process.env
  return env['CODEX_HOME'] ?? join(deps.homedirFn?.() ?? homedir(), '.codex')
}

function safeMtime(path: string, mtime: (path: string) => number): number {
  try {
    return mtime(path)
  } catch {
    return 0
  }
}

/** Every rollout under `dir`, newest first, capped. */
function newestSessions(dir: string, deps: ModelDiscoveryDeps, cap: number): string[] {
  const readdir = deps.readdirFn ?? ((path: string) => readdirSync(path))
  const mtime = deps.mtimeFn ?? ((path: string) => statSync(path).mtimeMs)
  const found: string[] = []
  const walk = (current: string, depth: number): void => {
    if (depth > 4 || found.length > 2_000) return
    let names: string[]
    try {
      names = readdir(current)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(current, name)
      if (name.endsWith('.jsonl')) found.push(path)
      else if (!name.includes('.')) walk(path, depth + 1)
    }
  }
  walk(dir, 0)
  return found
    .map((path) => ({ path, at: safeMtime(path, mtime) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, cap)
    .map((entry) => entry.path)
}

/** The head of a file — a session records its model in the first lines. */
function head(path: string, deps: ModelDiscoveryDeps): string {
  const read = deps.readFileFn ?? ((target: string) => readFileSync(target, 'utf8'))
  try {
    return read(path).slice(0, 64_000)
  } catch {
    return ''
  }
}

/** True for something a person could type into a model picker. */
function looksLikeModelId(value: string): boolean {
  return value.length > 0 && value.length < 80 && !/[\s/]/.test(value)
}

function codexModels(deps: ModelDiscoveryDeps): string[] {
  const seen = new Set<string>()
  for (const path of newestSessions(join(codexHome(deps), 'sessions'), deps, SESSION_SCAN_LIMIT)) {
    for (const match of head(path, deps).matchAll(MODEL_IN_JSON)) {
      const model = match[1]
      if (model !== undefined && looksLikeModelId(model)) seen.add(model)
    }
  }
  return [...seen]
}

/**
 * The default reader for Copilot's catalogue: its SQLite, opened READ-ONLY.
 *
 * Fail-soft on everything — a schema that moved, a locked file, a CLI that has
 * not created it yet. It is another program's database; Flow reads it the way
 * it reads a config file, and never writes.
 */
function defaultCopilotModels(dbPath: string): string[] {
  // Required lazily: this runs only when someone opens Settings under Copilot.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
  const Database = require('better-sqlite3') as new (
    path: string,
    options: { readonly: boolean; fileMustExist: boolean },
  ) => {
    prepare(sql: string): { all(): Array<Record<string, unknown>> }
    close(): void
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const models = new Set<string>()
    for (const sql of [
      'SELECT DISTINCT model_id AS m FROM provider_models',
      'SELECT DISTINCT model AS m FROM sessions WHERE model IS NOT NULL',
    ]) {
      try {
        for (const row of db.prepare(sql).all()) {
          if (typeof row['m'] === 'string') models.add(row['m'])
        }
      } catch {
        // That table is not in this version — the other one may still be.
      }
    }
    return [...models]
  } finally {
    db.close()
  }
}

function copilotModels(deps: ModelDiscoveryDeps): string[] {
  const env = deps.env ?? process.env
  const home = env['COPILOT_HOME'] ?? join(deps.homedirFn?.() ?? homedir(), '.copilot')
  const read = deps.copilotModelsFn ?? defaultCopilotModels
  try {
    return read(join(home, 'data.db')).filter(looksLikeModelId)
  } catch {
    return []
  }
}

/** Where Claude Code keeps its config. `CLAUDE_CONFIG_DIR` moves the whole
 *  directory; the file sits at its root either way. */
function claudeConfigPath(deps: ModelDiscoveryDeps): string {
  const env = deps.env ?? process.env
  const configured = env['CLAUDE_CONFIG_DIR']
  const home = deps.homedirFn?.() ?? homedir()
  return configured !== undefined && configured !== ''
    ? join(configured, '.claude.json')
    : join(home, '.claude.json')
}

/**
 * What THIS account may run, from Claude Code's own config.
 *
 * TWO KEYS, AND THEY MEAN DIFFERENT THINGS:
 *
 *   modelAccessCache            [{ apiName, entitled }] — the base catalogue.
 *                               Only `entitled: true` is offered; the rest are
 *                               models the account has been TOLD ABOUT and
 *                               cannot use, which is the one thing worse than
 *                               a short list.
 *   additionalModelOptionsCache [{ value, label, … }] — extra entries the CLI's
 *                               own picker shows, and the only place a variant
 *                               like `claude-fable-5-1[1m]` appears at all.
 *                               Taken verbatim: it is already the answer.
 *
 * Read-only, and a guest in another program's file — Flow parses it the way it
 * reads a config and never writes it back.
 *
 * Fail-soft on everything: a missing file (a machine that has never run the
 * CLI), a moved schema, a partial write mid-parse. An empty list means the
 * static aliases stand, which is exactly today's behaviour.
 */
/**
 * Families the composer already offers by alias, derived from the picker's own
 * list rather than restated — so adding an alias there cannot leave a stale
 * copy here quietly re-offering it as a raw id.
 */
const CLAUDE_ALIAS_FAMILIES: ReadonlySet<string> = new Set(
  modelOptionsFor('claude')
    .map((option) => option.value)
    .filter((value) => value !== AUTO_MODEL),
)

/** Anthropic ids only. The caches carry sentinels too — a live config here held
 *  `cc-update-required-1` beside a real model — and a sentinel in a model
 *  picker is a turn that fails at send time. */
function isAnthropicId(value: string): boolean {
  return value.startsWith('claude-') && looksLikeModelId(value)
}

/**
 * The family word in an Anthropic id: `opus`, `sonnet`, `fable`, whatever ships
 * next.
 *
 * DERIVED, NEVER LISTED. A hardcoded set of families is the very thing this
 * module exists to replace — it would need editing on every release, which is
 * how the picker fell behind in the first place. The id's shape is enough: the
 * first segment after `claude-` that is not a number, which reads both the
 * modern `claude-opus-5` and the older `claude-3-5-sonnet-20241022`.
 */
function familyOf(id: string): string | null {
  for (const segment of id.slice('claude-'.length).split('-')) {
    if (segment !== '' && !/^\d+$/.test(segment)) return segment.replace(/\[.*$/, '').toLowerCase()
  }
  return null
}

/**
 * What THIS account may run, from Claude Code's own config.
 *
 * TWO KEYS, AND THEY ANSWER DIFFERENT QUESTIONS:
 *
 *   additionalModelOptionsCache  the extra entries the CLI's own picker shows,
 *                                and the ONLY place a variant like
 *                                `claude-fable-5-1[1m]` appears. Taken as ids,
 *                                because it is already the answer.
 *   modelAccessCache             [{ apiName, entitled }] — the account's base
 *                                catalogue. Only `entitled: true` counts;
 *                                offering a model the account cannot run is the
 *                                failed turn this module exists to prevent.
 *
 * ONLY WHAT THE ALIASES DO NOT ALREADY COVER. The entitled list is every
 * snapshot the account has ever been granted — eleven of them on the machine
 * this was written on, back to `claude-3-opus-20240229`. Offering all of them
 * would bury the four names people actually use under a decade of history. So
 * an id is offered only when its FAMILY is not already an alias in the picker,
 * which is exactly the case that matters: a family that did not exist when this
 * code was written now appears on its own, and nothing has to be edited for it.
 *
 * `CLAUDE_CONFIG_DIR` is honoured because the CLI honours it — this session's
 * own shell has it set, and reading the wrong file would report the wrong
 * account's models.
 *
 * Read-only, and a guest in another program's file. Fail-soft on everything: a
 * missing file (a machine that has never run the CLI), a moved schema, a
 * partial write caught mid-parse. Empty means the static aliases stand, which
 * is exactly the behaviour that shipped before this existed.
 */
function claudeModels(deps: ModelDiscoveryDeps): string[] {
  const read = deps.readFileFn ?? ((path: string) => readFileSync(path, 'utf8'))
  let parsed: unknown
  try {
    parsed = JSON.parse(read(claudeConfigPath(deps)))
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const config = parsed as Record<string, unknown>
  const models = new Set<string>()

  const additional = config['additionalModelOptionsCache']
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      if (entry === null || typeof entry !== 'object') continue
      const value = (entry as Record<string, unknown>)['value']
      if (typeof value === 'string' && isAnthropicId(value)) models.add(value)
    }
  }

  const access = config['modelAccessCache']
  if (Array.isArray(access)) {
    for (const entry of access) {
      if (entry === null || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      if (row['entitled'] !== true) continue
      const name = row['apiName']
      if (typeof name !== 'string' || !isAnthropicId(name)) continue
      const family = familyOf(name)
      if (family === null || CLAUDE_ALIAS_FAMILIES.has(family)) continue
      models.add(name)
    }
  }
  return [...models]
}

/**
 * Models `provider` is known to have used or to offer. Never throws; an empty
 * list means "nothing to suggest", and the user can still type an id.
 */
export function discoverRuntimeModels(provider: string, deps: ModelDiscoveryDeps = {}): string[] {
  if (provider === 'codex') return codexModels(deps)
  if (provider === 'copilot') return copilotModels(deps)
  if (provider === 'claude') return claudeModels(deps)
  return []
}

/**
 * Ids that a GitHub Copilot plan commonly offers — CANDIDATES, not evidence.
 *
 * Measured against a real Copilot Business account on this machine:
 *
 *   gpt-5-mini          accepted        gpt-5     "not available"
 *   claude-sonnet-4.5   accepted        gpt-4.1   "not available"
 *   claude-haiku-4.5    accepted
 *   claude-sonnet-5     ran a turn
 *
 * So a set exists, it is real, and it is per-plan. These are offered as things
 * to TRY — separately from the models Flow has watched run — because a plan
 * without one refuses it, and that refusal is now visible in the transcript
 * instead of being silence. Codex is absent on purpose: its own sessions
 * already say what it uses (see codexModels).
 *
 * LATEST GENERATION FIRST. The measured set above established that a per-plan
 * Claude set exists; the list leads with the current generation (5.5) as the
 * candidates most worth trying, keeping an older sonnet for plans that have not
 * been upgraded yet. Nothing here is CLAIMED to be available — the "(untested)"
 * marker the picker adds says exactly that.
 */
const COPILOT_CANDIDATES: readonly string[] = [
  'claude-opus-5.5',
  'claude-sonnet-5.5',
  'claude-haiku-5.5',
  'claude-sonnet-5',
  'gpt-5-mini',
]

/** Models worth OFFERING to try, with no claim that this account has them. */
export function candidateRuntimeModels(provider: string): string[] {
  return provider === 'copilot' ? [...COPILOT_CANDIDATES] : []
}
