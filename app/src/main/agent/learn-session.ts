// learn-session — the progressive-learning SPIKE + learn-pass executor.
//
// Two layers, one binding cage (NFR1):
//
//   1. THE CAGED SESSION (runCagedSession / buildCagedOptions):
//      a headless, multi-turn Claude Agent SDK query whose ONLY tools are the
//      read-only trio Read / Grep / Glob. The session has ZERO write tools —
//      it can inspect the module but cannot mutate anything. It returns plain
//      structured text; it never touches the filesystem or the blueprint.
//
//   2. THE EXECUTOR (runLearnPass):
//      plain TypeScript that runs AFTER the session returns. It parses the
//      session's structured output and performs ALL writes itself — the module
//      brain doc via fs, and the investigation note via the bundled
//      `planflow-ai blueprint observe` CLI. The agent proposes; the executor
//      disposes.
//
// ## Spike Findings
//
// The SPIKE question was: can the one-shot generator precedent
// (sdkTitleGenerator: maxTurns 1, allowedTools []) extend to a headless,
// multi-turn session that USES tools but runs with no UI and no thread? Yes.
// The exact SDK options that make headless-with-tools work:
//
//   • `allowedTools: ['Read', 'Grep', 'Glob']` — pre-approves the read trio so
//     each call EXECUTES without a permission roundtrip. This is what lets a
//     multi-turn session actually do work headless (the one-shot precedent
//     used `[]`, so it never needed a tool to run).
//   • `permissionMode: 'default'` + a `canUseTool` callback that resolves
//     SYNCHRONOUSLY (deny-all-else) — the main session also runs 'default' +
//     canUseTool, but it BLOCKS on a renderer verdict, which is what makes it
//     "interactive". Our canUseTool never parks: it returns allow for the read
//     trio and deny for everything else immediately, so the loop is fully
//     headless with no UI dependency and no hang.
//   • `maxTurns: <N>` bounds the agentic loop so a confused model cannot spin.
//   • streaming single-prompt input (singleUserPrompt) + consuming the message
//     stream to the final `{ type: 'result', subtype: 'success' }` message,
//     whose `.result` is the structured text — identical to runOneShot.
//   • `abortController` wired from the caller's AbortSignal so a cancelled
//     learn pass tears the SDK query down.
//
// Belt-and-suspenders: even though `allowedTools` is a whitelist, canUseTool
// still fires for any tool OUTSIDE it, and we deny in code (allowed-pattern
// #14 — the invariant lives in one code path, not prompt convention). There is
// no path by which the caged session writes anything.
//
// What canUseTool does NOT see: the whitelisted trio itself. A bare
// `allowedTools` entry auto-approves its tool before the callback is consulted
// (the SDK warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). That costs the cage nothing
// — everything it must deny is outside the whitelist — but it means canUseTool
// is useless for OBSERVING reads. Read observation therefore runs as a
// PreToolUse hook, which fires for pre-approved tools too (allowed-pattern #10).
//
// MODULE FORMAT: the SDK is ESM-only and the main process bundles to CJS, so
// the SDK loads through a runtime dynamic import() kept out of TypeScript's CJS
// down-compilation (new Function) — mirroring agent-manager.ts. Tests inject a
// `queryFn` and never load the real SDK.

import { spawn } from 'child_process'
import { runInCliHost } from '../cli-host/client'
import { bindAgentBinary, ensureAgentBinary } from './agent-binary'
import { runInBackground } from './background-priority'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'

import type {
  Options,
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
} from '@anthropic-ai/claude-agent-sdk'

import type { QueryFunction } from './agent-manager'
import { ClaudeRuntime } from './runtime/claude-runtime'
import { BRAIN_FIRST_COMPACT } from './brain-first'
import type { BundledCli } from '../blueprint/derive-runner'
import { slugify } from '../brain/compaction'
import { adjudicableClaimPaths, isClaimImagePath } from '../../shared/claim-files'
import { describeSdkActivity } from './sdk-activity'

// ── Constants ────────────────────────────────────────────────────────────

/** The ONLY tools a learn session may use — read-only, no writes (NFR1). */
export const CAGED_READ_TOOLS = ['Read', 'Grep', 'Glob'] as const
const CAGED_READ_TOOL_SET = new Set<string>(CAGED_READ_TOOLS)

/**
 * Default turn budget for a caged session. One Read is one turn, and a pass is
 * offered up to DEFAULT_RANK_CAPS.maxFiles code files plus CLAIM_FILE_MAX_COUNT
 * claim docs — a budget below that sum makes exhaustion structural, not
 * exceptional (live orbit-app failure 2026-07-30 at the former budget of 12).
 */
const DEFAULT_CAGED_MAX_TURNS = 30

/** SDK module specifier — mirrors agent-manager's dynamic-import loader. */
const SDK_MODULE_SPECIFIER = '@anthropic-ai/claude-agent-sdk'

/** Hard wall-clock cap on the bundled-CLI observe invocation. */
const OBSERVE_TIMEOUT_MS = 30_000

/** Cap on the captured stderr tail surfaced as a one-line error. */
const STDERR_TAIL_CHARS = 2_000

/** Default file-ranking caps: entry-first, size-ascending, then truncate. */
export const DEFAULT_RANK_CAPS: RankCaps = { maxFiles: 15, maxBytes: 60 * 1024 }

/** Max claim files offered to one learn pass for adjudication (NFR4). */
export const CLAIM_FILE_MAX_COUNT = 8

/** Max total claim-file bytes offered to one learn pass (NFR4). */
export const CLAIM_FILE_MAX_BYTES = 64 * 1024

/** Max `--against` witnesses passed to one adjudicate invocation. */
export const ADJUDICATE_AGAINST_MAX = 10

// ── The caged session (SPIKE mechanism) ────────────────────────────────────

/** Parameters for a single caged, headless read-only session. */
export interface CagedSessionParams {
  /** Working directory — the session's Read/Grep/Glob scope. */
  cwd: string
  /** The single user prompt driving the session. */
  prompt: string
  /** Model id (e.g. 'haiku' | 'sonnet'). Omit → SDK default. */
  model?: string
  /** Turn budget (default DEFAULT_CAGED_MAX_TURNS). */
  maxTurns?: number
  /** Cancels the underlying SDK query when signalled. */
  abortSignal?: AbortSignal
  /** Account-resolved auth env (see agent-manager.applyAuthEnv). */
  authEnv?: NodeJS.ProcessEnv
  /** Inject the SDK query fn (tests). Default: dynamic-import the real SDK. */
  queryFn?: QueryFunction
  /** Notified with each whitelisted Read tool's file_path (throttled upstream). */
  onRead?: (filePath: string) => void
  /** Called as the session works — tool calls, thinking, writing. Feeds the
   *  Learning panel's activity log and its stall watchdog. */
  onActivity?: (kind: string, detail?: string) => void
}

/**
 * The read-only permission cage: allow ONLY Read/Grep/Glob, deny everything
 * else in code. Resolves synchronously (no UI, no parking) so the session runs
 * fully headless. This is the single code path that enforces NFR1 — never a
 * prompt convention (allowed-pattern #14).
 *
 * APPROVAL ONLY — never observation. A bare `allowedTools` entry auto-approves
 * its tool BEFORE canUseTool is consulted, so this callback is never invoked for
 * Read/Grep/Glob (the SDK warns: CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). It still
 * fires for every tool outside the whitelist, which is exactly where the cage
 * needs it. Read observation lives in the PreToolUse hook below
 * (allowed-pattern #10: approve at canUseTool, observe at hooks).
 */
export function createCagedCanUseTool(): CanUseTool {
  return async (toolName, input, options) => {
    if (CAGED_READ_TOOL_SET.has(toolName)) {
      return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID }
    }
    return {
      behavior: 'deny',
      message: `learn session is read-only — ${toolName} is not permitted`,
      toolUseID: options.toolUseID,
    }
  }
}

/**
 * Observe every Read the caged session performs, for live learn progress.
 *
 * Hooks ALWAYS fire — including for tools pre-approved via `allowedTools` —
 * which is why this cannot live in canUseTool (it was there, and the whitelist
 * shadowed it, so `learn:progress` never broadcast and the Learning panel sat
 * silent through an entire pass). Mirrors createBashMirrorHooks in
 * terminal/bash-bridge.ts. Purely observational: always resolves `{}`, never
 * influencing whether the tool runs.
 */
export function createLearnReadHooks(onRead?: (filePath: string) => void): {
  PreToolUse: HookCallbackMatcher[]
} {
  const preToolUse: HookCallback = (input) => {
    if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Read') {
      const toolInput = input.tool_input
      const fp =
        typeof toolInput === 'object' && toolInput !== null
          ? (toolInput as { file_path?: unknown }).file_path
          : undefined
      if (typeof fp === 'string' && fp.length > 0) onRead?.(fp)
    }
    return Promise.resolve({})
  }
  return { PreToolUse: [{ matcher: 'Read', hooks: [preToolUse] }] }
}

/**
 * Build the SDK Options for a caged session. Pure given its inputs (the
 * AbortController is supplied by the caller) so the option shape is unit-
 * testable without a live SDK. See the Spike Findings for why this exact set
 * makes headless-with-tools work.
 */
export function buildCagedOptions(params: {
  cwd: string
  abortController: AbortController
  model?: string
  maxTurns?: number
  authEnv?: NodeJS.ProcessEnv
  onRead?: (filePath: string) => void
}): Options {
  const options: Options = {
    cwd: params.cwd,
    maxTurns: params.maxTurns ?? DEFAULT_CAGED_MAX_TURNS,
    // Whitelist the read trio — pre-approved, so they execute headless.
    allowedTools: [...CAGED_READ_TOOLS],
    permissionMode: 'default',
    // Deny everything outside the whitelist in code (belt-and-suspenders).
    canUseTool: createCagedCanUseTool(),
    // Read observation goes through hooks, which fire even for the pre-approved
    // whitelist — canUseTool never sees them (see createLearnReadHooks).
    hooks: createLearnReadHooks(params.onRead),
    // THE ONLY PROOF OF LIFE DURING THE COMPOSING PHASE. Without partial
    // messages the SDK is silent from the last tool result until the finished
    // assistant message lands — minutes, on a real feature — and a watchdog
    // cannot tell that from a dead session because there is nothing to hear.
    // Measured on orbit-app's Auth: 181 seconds of that silence, and the
    // pass was killed one step from writing its answer.
    //
    // These are fed to the watchdog, never printed (`describeSdkActivity`
    // reports them as 'stream'); the cage is untouched — a partial message is
    // an extra copy of output already flowing, not a new capability.
    includePartialMessages: true,
    abortController: params.abortController,
  }
  if (params.model) options.model = params.model
  if (params.authEnv) options.env = params.authEnv
  return options
}

/**
 * Run a caged, headless read-only session to completion and return its final
 * structured text (the last `result:success` message). Never throws for a
 * missing result — returns '' so the executor's parser reports malformed.
 */
export async function runCagedSession(params: CagedSessionParams): Promise<string> {
  const queryFn = params.queryFn ?? (await loadSdkQuery())
  let result = ''
  // multi_runtime_support (Phase 2, Task 2.3): the caged session now drives its
  // SDK query THROUGH the ClaudeRuntime seam instead of calling queryFn inline —
  // the first real adopter of the AgentRuntime interface. The cage (NFR1) is
  // unchanged: buildCagedOptions still supplies allowedTools/canUseTool/hooks;
  // the runtime only owns the query lifecycle.
  // Declared BEFORE the runtime because the translator below resolves it: a
  // caged call is one turn, and the stream it rides on does not end when that
  // turn does (see the result branch).
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const runtime = new ClaudeRuntime({
    queryFn,
    // The caged session wants the final structured text — AND a heartbeat.
    //
    // This used to say the normalized event stream was "discarded (there is no
    // renderer for a headless learn pass)", and discarded it by ignoring the
    // `emit` the runtime hands every translator. That made `onEvent` dead code
    // for this path, which made `onActivity` dead for every caller of it, which
    // is why the silence watchdog below could hear file reads and nothing else
    // — and killed real passes three minutes into composing an answer.
    //
    // Reading the raw message is deliberate: normalizing one to carry a
    // heartbeat would be a second mapping to keep honest, for a path with
    // nothing to render it.
    translate: (message) => {
      if (message.type === 'result' && message.subtype === 'success') {
        result = message.result
      }
      // ONE TURN IS THE WHOLE CALL, and nothing else will say so.
      //
      // ClaudeRuntime opens an AsyncMessageQueue, pushes the prompt and never
      // closes it — streaming input mode, which is right for a chat session
      // that stays open for the next thing a person types. A caged pass has no
      // person: after `result` the SDK waits for a message that never comes,
      // the `for await` never ends, and `onDone` never fires.
      //
      // So every caged session ran forever. Measured on orbit-app's
      // Playbooks: the answer was complete at 212.6s and the pass was killed by
      // the silence watchdog at 393.5s — 181 seconds spent holding a finished
      // result before throwing it away. That watchdog was the only thing ever
      // ending these calls, which is why raising its window would have made the
      // bug slower rather than fixed it.
      if (message.type === 'result') resolveDone()
      if (params.onActivity === undefined) return
      const activity = describeSdkActivity(message)
      if (activity !== null) params.onActivity(activity.kind, activity.detail)
    },
    providerOptions: () => cagedProviderExtras(params),
  })
  // start() is synchronous and returns the handle; `done` (above) settles on
  // the result message or, failing that, when the stream ends.
  const session = runtime.start(
    {
      threadId: 'learn',
      cwd: params.cwd,
      additionalRoots: [],
      prompt: params.prompt,
      ...(params.model !== undefined ? { model: params.model } : {}),
      resumeSessionId: null,
      // The runtime links its own AbortController to this signal; a caller
      // without one gets a never-aborting signal (the pre-reroute default).
      abortSignal: params.abortSignal ?? new AbortController().signal,
    },
    {
      // WHAT IT IS DOING BETWEEN READS. These were all discarded, so a pass
      // that spent six minutes thinking or grepping looked identical to one
      // that had died: the panel's last word was a filename from minute one.
      onEvent: (event) => {
        if (params.onActivity === undefined) return
        if (event.kind === 'tool-start') params.onActivity('tool', event.toolCall.toolName)
        else if (event.kind === 'thinking' && event.active) params.onActivity('thinking')
        else if (event.kind === 'message-start') params.onActivity('writing')
        else if (event.kind === 'error') params.onActivity('error', event.message)
      },
      onSessionId: () => {},
      onDone: () => resolveDone(),
    },
  )
  await done
  // Dispose closes the underlying query — parity with the old finally-close.
  try {
    session.dispose()
  } catch {
    // A query that already ended has nothing to close.
  }
  return result
}

/**
 * The caged Options fields ClaudeRuntime does NOT own, as a providerOptions
 * partial: reuse buildCagedOptions (whose own tests still pin the read-only
 * cage) and strip the fields the runtime assembles from RuntimeStartOptions —
 * `cwd`, `model`, and the `abortController` (the runtime links its own to the
 * caller's AbortSignal).
 *
 * `includePartialMessages` USED TO BE FORCED OFF here — "to match the
 * pre-reroute caged session, which only ever read `result:success`" — which was
 * true of a session nobody was watching. Once a watchdog was pointed at this
 * pass, that line became the reason it had nothing to hear while the model
 * composed, and real runs were killed 181 seconds into writing their answer.
 * Now it takes the runtime's own value, like every other field the runtime
 * assembles.
 */
function cagedProviderExtras(params: CagedSessionParams): Partial<Options> {
  const full = buildCagedOptions({
    cwd: params.cwd,
    abortController: new AbortController(),
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
    ...(params.authEnv !== undefined ? { authEnv: params.authEnv } : {}),
    ...(params.onRead !== undefined ? { onRead: params.onRead } : {}),
  })
  const { cwd: _cwd, abortController: _abort, model: _model, ...extras } = full
  return extras
}

// ── File ranking ────────────────────────────────────────────────────────────

/** A candidate file with its byte size, fed to the ranker. */
export interface ModuleFile {
  /** Path relative to the module/repo root — used in the prompt and for reads. */
  path: string
  /** Byte size on disk — drives the size-ascending secondary sort + byte cap. */
  size: number
}

/** Ranking caps: how many files and how many total bytes to include. */
export interface RankCaps {
  maxFiles: number
  maxBytes: number
}

/** True for entry-point files (index/barrel) — ranked ahead of the rest. */
function isEntryFile(path: string): boolean {
  const base = path.split(/[/\\]/).pop() ?? path
  return /^index\.(ts|tsx|js|jsx|mjs|cjs)$/.test(base)
}

/**
 * Rank a module's files for the learn prompt: entry points (index/barrel)
 * first, then size-ascending (small, dense files carry the most signal per
 * token), then truncate to the caps. At least one file is always kept even if
 * it alone exceeds maxBytes, so an oversized lone file is still learned.
 */
export function rankModuleFiles(
  files: readonly ModuleFile[],
  caps: RankCaps = DEFAULT_RANK_CAPS,
): ModuleFile[] {
  const sorted = [...files].sort((a, b) => {
    const rankA = isEntryFile(a.path) ? 0 : 1
    const rankB = isEntryFile(b.path) ? 0 : 1
    if (rankA !== rankB) return rankA - rankB
    if (a.size !== b.size) return a.size - b.size
    return a.path.localeCompare(b.path)
  })
  const picked: ModuleFile[] = []
  let bytes = 0
  for (const file of sorted) {
    if (picked.length >= caps.maxFiles) break
    if (picked.length > 0 && bytes + file.size > caps.maxBytes) break
    picked.push(file)
    bytes += file.size
  }
  return picked
}

// ── Claim files (trust-tiers) ────────────────────────────────────────────────
//
// A module's foreign docs/images are Tier-2 CLAIMS — unverified statements
// ABOUT the code. The learn pass offers them for adjudication against the code
// it reads; the executor records the verdicts via the ONE verdict write path,
// `planflow-ai blueprint adjudicate` (allowed-pattern #14 — never a direct
// write to the tier store from the app).

/** Doc extensions counted as claims — mirrors the CLI's `classifyTier`. */
const CLAIM_DOC_EXTENSIONS = ['.md', '.mdx', '.rst', '.txt']

/** Repo-root directories owned by plan-flow — docs under them are the system's
 *  OWN verified store, never foreign claims (mirrors the CLI's own-tier rule). */
const OWN_TIER_DIRS = ['flow', '.claude']

/**
 * True when a repo-relative path is a Tier-2 claim file: a doc/image extension
 * outside the own-store directories. A small local predicate mirroring the
 * CLI's `classifyTier` claim rules — deliberately NOT the app's drift-bucket
 * `classifyFileClass`, which is a different feature.
 */
export function isClaimFilePath(relPath: string): boolean {
  const posix = relPath.split('\\').join('/')
  if (OWN_TIER_DIRS.some((dir) => posix === dir || posix.startsWith(`${dir}/`))) {
    return false
  }
  const lowered = posix.toLowerCase()
  return (
    // Images still COUNT as claims (#1130) — an image beside the code is an
    // unverified statement about it. They are only excluded where the system
    // would try to ADJUDICATE them, which a text reader cannot do.
    CLAIM_DOC_EXTENSIONS.some((extension) => lowered.endsWith(extension)) ||
    isClaimImagePath(lowered)
  )
}

/** Claim files that fit the caps, plus the paths that did not (`overCap`). */
export interface CappedClaimFiles {
  claimFiles: ModuleFile[]
  overCap: string[]
}

/**
 * Order a module's claim files deterministically (docs before images, then by
 * path) and apply the NFR4 caps: at most CLAIM_FILE_MAX_COUNT files and
 * CLAIM_FILE_MAX_BYTES total. Files beyond the caps are carried separately as
 * `overCap` paths — the executor records them `unverifiable` rather than
 * silently dropping them.
 */
export function capClaimFiles(files: readonly ModuleFile[]): CappedClaimFiles {
  // #1130: images are DROPPED, not merely deprioritised. This session is a
  // caged text reader (Read/Grep/Glob, no vision), so an image claim could only
  // ever come back `unverifiable` — the prompt said so itself. Dropping them
  // outright rather than into `overCap` matters: an over-cap file is still
  // recorded `unverifiable`, which is the permanently-stuck row this fixes.
  const ordered = [...adjudicableClaimPaths(files)].sort((a, b) => a.path.localeCompare(b.path))
  const claimFiles: ModuleFile[] = []
  const overCap: string[] = []
  let bytes = 0
  for (const file of ordered) {
    if (claimFiles.length >= CLAIM_FILE_MAX_COUNT || bytes + file.size > CLAIM_FILE_MAX_BYTES) {
      overCap.push(file.path)
      continue
    }
    claimFiles.push(file)
    bytes += file.size
  }
  return { claimFiles, overCap }
}

// ── The feature roster ───────────────────────────────────────────────────────
//
// THE LOAD-BEARING HALF of recording relationships. A pass reading Playbooks
// sees a skill slug resolved by a binder — but it can only write
// `feature:skills` if it knows Skills is a named capability in THIS project's
// store. Without the roster it writes a sentence about a binder and records no
// edge at all, which is why `relates` is empty in all 101 features across three
// projects.
//
// The entries come from the CLI's `buildFeatureRoster` (src/cli/blueprint/
// feature-graph.ts), which reuses `featureSummary` so a roster line and a board
// card say the same thing. The shape is declared structurally here because the
// app does not import the CLI's sources.

/** One feature the learn pass may name. Mirrors the CLI's FeatureRosterEntry. */
export interface FeatureRosterEntry {
  /** The id a relationship's `target` must name — `feature:<slug>`. */
  id: string
  name: string
  /** `core` (a capability) or `child` (a change record). */
  kind?: 'core' | 'child'
  /** One line saying what it is. May be empty — an unlearned feature says nothing. */
  summary?: string
}

/**
 * Longest summary rendered per roster line.
 *
 * Only SUMMARIES are truncated; no entry is ever dropped. A roster missing the
 * one name the pass needed is the exact failure this feature exists to fix, so
 * a long store costs lines rather than losing vocabulary.
 */
export const ROSTER_SUMMARY_MAX_CHARS = 120

/** One roster line: `- feature:skills — Skills: <summary>`. */
function rosterLine(entry: FeatureRosterEntry): string {
  const summary = (entry.summary ?? '').replace(/\s+/g, ' ').trim()
  const clipped =
    summary.length > ROSTER_SUMMARY_MAX_CHARS
      ? `${summary.slice(0, ROSTER_SUMMARY_MAX_CHARS - 1).trimEnd()}…`
      : summary
  const change = entry.kind === 'child' ? ' (change record)' : ''
  return `- ${entry.id} — ${entry.name}${change}${clipped.length > 0 ? `: ${clipped}` : ''}`
}

/**
 * Render the roster block, or nothing at all when the roster is empty.
 *
 * An EMPTY roster renders no block on purpose: a heading followed by no names,
 * plus an instruction to name one of them, is an invitation to invent an id —
 * and a hallucinated feature id is worse than a missing edge, because it looks
 * like recorded knowledge.
 */
export function renderFeatureRoster(roster: readonly FeatureRosterEntry[]): string[] {
  if (roster.length === 0) return []
  return [
    '',
    "Features already named in this project's knowledge base:",
    roster.map(rosterLine).join('\n'),
    '',
    'If what you read connects this code to one of those capabilities, RECORD THE',
    'RELATIONSHIP by naming its id exactly as written above — a relationship is an id',
    'from this list plus the mechanism you saw, never a sentence about a mechanism with',
    'no id in it. Never invent an id that is not on the list: a made-up feature reads as',
    'recorded knowledge and is worse than no edge at all. If the other side is not on',
    'the list, say so in prose instead.',
  ]
}

/**
 * THE PRODUCER. `renderFeatureRoster` has been plumbed through both prompts
 * since the schema landed, and no caller populated it — a roster that is always
 * empty renders nothing, so the feature was inert in production while every
 * unit test passed.
 *
 * The list comes from the CLI (`blueprint features roster --json`), which is
 * how every other store fact reaches this process: the app does not import the
 * CLI's sources, and re-implementing `buildFeatureRoster` here would be a
 * second answer to "what features exist" that could disagree with the board's.
 *
 * FAIL-SOFT, ALWAYS. An older bundled CLI has no `roster` verb, a fresh project
 * has no store, and neither is a reason to fail a learn — both yield an empty
 * roster, which renders no block at all, which is exactly the prompt this pass
 * had before rosters existed.
 */
export async function loadFeatureRoster(
  bundledCli: BundledCli,
  rootPath: string,
  runCli: CliRunner = runBundledCliCapturing,
): Promise<FeatureRosterEntry[]> {
  const result = await runCli(bundledCli, rootPath, ['blueprint', 'features', 'roster', '--json'])
  if (!result.ok) return []
  return parseFeatureRoster(result.stdout)
}

/** Narrow the roster verb's JSON. A malformed entry is dropped, never guessed. */
export function parseFeatureRoster(stdout: string): FeatureRosterEntry[] {
  const candidate = extractJsonObject(stdout)
  if (candidate === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return []
  }
  const list = (parsed as Record<string, unknown> | null)?.['roster']
  if (!Array.isArray(list)) return []
  const entries: FeatureRosterEntry[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const id = record['id']
    const name = record['name']
    // An entry with no id is worse than useless here: it is a name the pass
    // would be invited to relate to and could never write.
    if (typeof id !== 'string' || id.length === 0) continue
    if (typeof name !== 'string' || name.length === 0) continue
    const kind = record['kind']
    const summary = record['summary']
    entries.push({
      id,
      name,
      ...(kind === 'core' || kind === 'child' ? { kind } : {}),
      ...(typeof summary === 'string' && summary.length > 0 ? { summary } : {}),
    })
  }
  return entries
}

// ── Prompt template ─────────────────────────────────────────────────────────

/**
 * Build the learn-pass prompt: instruct the caged session to read the ranked
 * files (via its Read/Grep/Glob tools) and emit a single JSON object. The
 * shape is fixed so parseLearnOutput can validate it.
 */
export function buildLearnPrompt(input: {
  modulePath: string
  rankedFiles: readonly ModuleFile[]
  /** Claim-tier docs/images to adjudicate — already capped (capClaimFiles). */
  claimFiles?: readonly ModuleFile[]
  /**
   * The project's features, as the names a relationship may use. Absent or
   * empty ⇒ the prompt is exactly what it was before rosters existed, so a
   * caller that has no store is never asked to name something.
   */
  roster?: readonly FeatureRosterEntry[]
}): string {
  const fileList = input.rankedFiles.map((f) => `- ${f.path}`).join('\n')
  // #1130: filter here too, not only in capClaimFiles — a caller that builds a
  // prompt without capping must not be able to reintroduce an image the model
  // cannot read. One predicate, every adjudicating surface.
  const claimFiles = adjudicableClaimPaths(input.claimFiles ?? [])
  const hasClaims = claimFiles.length > 0
  const claimList = claimFiles
    .map((f) => `- ${f.path}`)
    .join('\n')
  return [
    `You are documenting the module at \`${input.modulePath}\` for a project knowledge base.`,
    'Read the files below using your Read/Grep/Glob tools, then produce ONE concise summary.',
    '',
    // Injected from .claude/resources/core/brain-first.md (compact variant) —
    // the cage has no Bash, so the constant's Grep-fallback clause applies.
    BRAIN_FIRST_COMPACT,
    '',
    'Files (ranked; read the ones you need):',
    fileList,
    ...(hasClaims
      ? [
          '',
          'Docs to adjudicate (trust tiers: these are UNVERIFIED claims about the code, not ground truth):',
          claimList,
          '',
          'Adjudicate each doc against the code you actually read: `corroborated` when the code',
          'confirms what the doc claims, `contradicted` when the code disagrees with it,',
          '`unverifiable` when you cannot tell from the code you read. Never let a doc',
          'override what the code says.',
        ]
      : []),
    ...renderFeatureRoster(input.roster ?? []),
    '',
    'Reply with ONLY a single JSON object — no prose, no code fence — of this shape:',
    '{',
    '  "docMarkdown": "<a Markdown doc: what this module is, its responsibilities, key exports/types, and how it fits the system>",',
    '  "noteSummary": "<one or two sentences capturing the single most important thing to know about this module>",',
    '  "keyAnchors": ["symbol:<file>#<name>", "file:<path>"]  // OPTIONAL — omit if none',
    ...(hasClaims
      ? [
          '  "docVerdicts": [{"path": "<doc path from the list above>", "verdict": "corroborated|contradicted|unverifiable", "evidence": "<one line>"}]  // one entry per doc listed above',
        ]
      : []),
    '}',
    '',
    'The docMarkdown must be self-contained Markdown, UNDER 250 lines — summarize rather than exhaust (large modules overrun the output budget and the JSON never closes). Do not invent files you did not read.',
    '',
    'The docMarkdown MUST end with a `## Invariants` section: bulleted, ONE testable',
    'invariant per bullet — a property of this module that changed code could violate',
    '(ordering guarantees, ownership rules, required call sequences, format contracts).',
    'Where possible each bullet names the file(s) it was verified against in backticks,',
    'e.g. `- All writes go through observe() (`store.ts`, `writer.ts`)`. If the code',
    'shows nothing worth asserting, emit exactly:',
    '## Invariants',
    '- (none observed)',
  ].join('\n')
}

// ── Structured-output parsing ────────────────────────────────────────────────

/** The three adjudication outcomes — mirrors the CLI's TierVerdictKind. */
export type DocVerdictKind = 'corroborated' | 'contradicted' | 'unverifiable'

const DOC_VERDICT_KINDS: readonly DocVerdictKind[] = [
  'corroborated',
  'contradicted',
  'unverifiable',
]

/** Max length of a verdict's one-line evidence note. */
const EVIDENCE_MAX_CHARS = 200

/** One adjudication the caged session returned for an offered claim file. */
export interface DocVerdict {
  path: string
  verdict: DocVerdictKind
  evidence?: string
}

/** The validated shape the caged session is asked to emit. */
export interface LearnOutput {
  docMarkdown: string
  noteSummary: string
  keyAnchors?: string[]
  docVerdicts?: DocVerdict[]
}

/**
 * Parse the session's structured output, fail-soft. Accepts a bare JSON object
 * or one wrapped in a ```json fence / surrounded by stray prose (extracts the
 * outermost {...}). Returns null when nothing valid is found or the required
 * string fields are missing/empty.
 *
 * `offeredClaimPaths` scopes docVerdicts: a verdict is kept only for a path
 * that was actually offered (one verdict per path — first wins), with a valid
 * verdict kind; evidence is coerced to a single ≤200-char line. Absent or
 * malformed docVerdicts never fail the parse — they are simply treated as none.
 */
export function parseLearnOutput(
  raw: string,
  offeredClaimPaths: readonly string[] = [],
): LearnOutput | null {
  const candidate = extractJsonObject(raw)
  if (candidate === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const docMarkdown = record['docMarkdown']
  const noteSummary = record['noteSummary']
  if (typeof docMarkdown !== 'string' || docMarkdown.trim().length === 0) return null
  if (typeof noteSummary !== 'string' || noteSummary.trim().length === 0) return null
  const keyAnchors = Array.isArray(record['keyAnchors'])
    ? record['keyAnchors'].filter((a): a is string => typeof a === 'string')
    : undefined
  const docVerdicts = parseDocVerdicts(record['docVerdicts'], offeredClaimPaths)
  return {
    docMarkdown: docMarkdown.trim(),
    noteSummary: noteSummary.trim(),
    ...(keyAnchors && keyAnchors.length > 0 ? { keyAnchors } : {}),
    ...(docVerdicts.length > 0 ? { docVerdicts } : {}),
  }
}

/** Validate a raw docVerdicts candidate, dropping anything malformed or not
 *  among the offered claim paths. Fail-soft — never throws. */
function parseDocVerdicts(raw: unknown, offeredClaimPaths: readonly string[]): DocVerdict[] {
  if (!Array.isArray(raw) || offeredClaimPaths.length === 0) return []
  const offered = new Set(offeredClaimPaths)
  const seen = new Set<string>()
  const verdicts: DocVerdict[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const path = entry['path']
    const verdict = entry['verdict']
    if (typeof path !== 'string' || !offered.has(path) || seen.has(path)) continue
    if (typeof verdict !== 'string' || !DOC_VERDICT_KINDS.includes(verdict as DocVerdictKind)) {
      continue
    }
    seen.add(path)
    const evidence =
      typeof entry['evidence'] === 'string' ? coerceEvidenceLine(entry['evidence']) : undefined
    verdicts.push({
      path,
      verdict: verdict as DocVerdictKind,
      ...(evidence !== undefined ? { evidence } : {}),
    })
  }
  return verdicts
}

/** Collapse evidence to one trimmed line of at most EVIDENCE_MAX_CHARS. */
function coerceEvidenceLine(text: string): string | undefined {
  const line = text.replace(/\s+/g, ' ').trim().slice(0, EVIDENCE_MAX_CHARS)
  return line.length > 0 ? line : undefined
}

/** Trailer appended to salvaged docs so their provenance is honest. */
const SALVAGE_TRAILER =
  '\n\n*(salvaged from an oversized learn response — consider drilling into a submodule and re-learning)*'

/**
 * Last-resort recovery when BOTH attempts return unparseable output (#learn-
 * large-modules): a big module often overruns the output budget so the JSON
 * never closes — but the docMarkdown string usually STARTED, and its content
 * is real. Two salvage cases:
 *   A. broken JSON with a started `"docMarkdown": "` — decode the string value
 *      up to the cut (honoring escapes) and use it;
 *   B. the model ignored the JSON contract and replied in plain markdown.
 * Returns null when neither yields a substantive doc (≥80 chars) — the honest
 * failure stays. Salvaged docs carry a provenance trailer.
 */
export function salvageLearnOutput(raw: string): LearnOutput | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const summaryFrom = (doc: string): string => {
    for (const line of doc.split('\n')) {
      const text = line.trim()
      if (text === '' || text.startsWith('#')) continue
      return text.length > 200 ? `${text.slice(0, 197)}…` : text
    }
    return 'Salvaged module summary (truncated learn response).'
  }

  // Case A — decode the started docMarkdown JSON string.
  const keyIndex = trimmed.indexOf('"docMarkdown"')
  if (keyIndex !== -1) {
    const colon = trimmed.indexOf(':', keyIndex)
    const openQuote = colon === -1 ? -1 : trimmed.indexOf('"', colon + 1)
    if (openQuote !== -1) {
      let doc = ''
      for (let i = openQuote + 1; i < trimmed.length; i += 1) {
        const ch = trimmed[i]
        if (ch === '\\') {
          const next = trimmed[i + 1]
          if (next === 'n') doc += '\n'
          else if (next === 't') doc += '\t'
          else if (next === '"') doc += '"'
          else if (next === '\\') doc += '\\'
          else doc += next ?? ''
          i += 1
        } else if (ch === '"') {
          break // string closed — the breakage was elsewhere in the object
        } else {
          doc += ch
        }
      }
      const cleaned = doc.trim()
      if (cleaned.length >= 80) {
        return { docMarkdown: cleaned + SALVAGE_TRAILER, noteSummary: summaryFrom(cleaned) }
      }
    }
  }

  // Case B — plain-markdown reply (contract ignored, content real).
  if (!trimmed.startsWith('{') && /^#{1,3}\s/m.test(trimmed) && trimmed.length >= 80) {
    return { docMarkdown: trimmed + SALVAGE_TRAILER, noteSummary: summaryFrom(trimmed) }
  }

  return null
}

/** Extract the outermost balanced {...} from a string, or null. */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return raw.slice(start, i + 1)
    }
  }
  return null
}

// ── Module doc writer ────────────────────────────────────────────────────────

/** Filename stem for a module path — reuses the brain slugify (kebab). */
export function moduleSlug(modulePath: string): string {
  return slugify(modulePath)
}

const CHANGELOG_HEADING = '## Changelog'

/**
 * Write (or refresh) the module's brain doc at
 * `flow/brain/modules/<slug>.md`. On first learn the file is created with the
 * doc body plus an initial changelog line; on re-learn the body is replaced
 * with the fresh doc and a dated `re-learned` line is APPENDED to the
 * preserved changelog. Returns the absolute doc path.
 */
export function writeModuleDoc(
  rootPath: string,
  modulePath: string,
  docMarkdown: string,
  now: Date,
): string {
  const docPath = join(rootPath, 'flow', 'brain', 'modules', `${moduleSlug(modulePath)}.md`)
  const date = now.toISOString().slice(0, 10)
  const existed = existsSync(docPath)
  const priorChangelog = existed ? readChangelog(readFileSync(docPath, 'utf8')) : []
  const newLine = existed
    ? `- ${date}: re-learned \`${modulePath}\``
    : `- ${date}: initial learn of \`${modulePath}\``
  const changelog = [...priorChangelog, newLine]
  const contents = `${docMarkdown.trimEnd()}\n\n${CHANGELOG_HEADING}\n\n${changelog.join('\n')}\n`
  mkdirSync(dirname(docPath), { recursive: true })
  writeFileSync(docPath, contents, 'utf8')
  return docPath
}

/** Pull existing `- ...` changelog lines from a doc's Changelog section. */
function readChangelog(markdown: string): string[] {
  const idx = markdown.indexOf(CHANGELOG_HEADING)
  if (idx === -1) return []
  return markdown
    .slice(idx + CHANGELOG_HEADING.length)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
}

// ── blueprint observe invocation ─────────────────────────────────────────────

/** Validated `<kind>:<ref>` anchor grammar accepted by `blueprint observe`. */
// symbol anchors REQUIRE the `<file>#<name>` form — the model sometimes emits
// bare `symbol:LoginForm`, which can never resolve (live failure 2026-07-24).
const ANCHOR_PATTERN = /^(?:symbol:.+#.+|(?:file|table|endpoint|module):.+)$/

/** Anchor kinds a learn target may already be expressed in (graph node ids). */
const NODE_ID_KIND_PATTERN = /^(?:module|endpoint|table|file|symbol):/

/**
 * The IDENTITY anchor for a learn target. A learn job's `modulePath` is a
 * graph node's identity, which is a folder-spine module path (`src/app/addins`)
 * for module nodes but an ALREADY-PREFIXED node id for the others
 * (`endpoint:GET /api/x`). Blindly prefixing `module:` turned the latter into
 * `module:endpoint:GET /api/x`, which resolves against nothing: `--lenient-
 * anchors` then dropped the identity and wrote an orphan note that no re-learn
 * could supersede, so the node failed the contradiction rule forever (live
 * orbit-app failure 2026-07-30).
 */
export function identityAnchor(modulePath: string): string {
  return NODE_ID_KIND_PATTERN.test(modulePath) ? modulePath : `module:${modulePath}`
}

/**
 * Build the `blueprint observe` CLI args for a learn note. The note text
 * carries the summary plus a link to the just-written doc (default provenance
 * is fine — the note text IS the provenance). A supersede request adds the
 * explicit `--status supersedes --supersedes <fp> --reason <why>` trio the CLI
 * requires. Extra keyAnchors are appended only when they match the grammar.
 */
export function buildObserveArgs(input: {
  rootPath: string
  modulePath: string
  noteSummary: string
  docPath: string
  keyAnchors?: readonly string[]
  supersede?: { fingerprint: string; reason: string }
}): string[] {
  const relDoc = relative(input.rootPath, input.docPath)
  const note = `${input.noteSummary}\n\nDoc: ${relDoc}`
  // --lenient-anchors: the FIRST anchor is the note's identity (the CLI never
  // drops it); the model's keyAnchors are decoration — an unresolvable one
  // must never sink the pass (live failures 2026-07-24: symbol:LoginForm /
  // symbol:main refused observe).
  // --conflict-scope primary: decoration overlaps other notes by design — a
  // child module's files are anchored by its parent's note, and bare symbol
  // refs (`GET`) recur across unrelated modules. Only the identity anchor can
  // contradict (live orbit-app failure 2026-07-30).
  const args = [
    'blueprint',
    'observe',
    '--lenient-anchors',
    '--conflict-scope',
    'primary',
    '--note',
    note,
    '--anchor',
    identityAnchor(input.modulePath),
  ]
  for (const anchor of input.keyAnchors ?? []) {
    if (!ANCHOR_PATTERN.test(anchor)) continue
    // file:/symbol: anchors must point at REGULAR FILES — the model sometimes
    // anchors a directory ('file:src/types/ontology', live failure 2026-07-24),
    // which resolves against the graph but can never hash-stamp.
    const relPath = anchor.startsWith('file:')
      ? anchor.slice('file:'.length)
      : anchor.startsWith('symbol:')
        ? anchor.slice('symbol:'.length).split('#')[0]
        : null
    if (relPath !== null) {
      try {
        if (!statSync(join(input.rootPath, relPath)).isFile()) continue
      } catch {
        continue // missing — never anchor what can't be stamped
      }
    }
    args.push('--anchor', anchor)
  }
  if (input.supersede) {
    args.push(
      '--status',
      'supersedes',
      '--supersedes',
      input.supersede.fingerprint,
      '--reason',
      input.supersede.reason,
    )
  }
  return args
}

/**
 * Build the `blueprint adjudicate` CLI args for one doc verdict — the ONE
 * verdict write path (allowed-pattern #14: the CLI verb validates tier/store/
 * hash; the app never writes the tier store directly). `against` is capped at
 * ADJUDICATE_AGAINST_MAX witnesses and omitted when empty.
 */
export function buildAdjudicateArgs(input: {
  path: string
  verdict: DocVerdictKind
  against: readonly string[]
  evidence?: string
}): string[] {
  const args = ['blueprint', 'adjudicate', '--path', input.path, '--verdict', input.verdict]
  const against = input.against.slice(0, ADJUDICATE_AGAINST_MAX)
  if (against.length > 0) {
    args.push('--against', against.join(','))
  }
  if (input.evidence !== undefined && input.evidence.length > 0) {
    args.push('--evidence', input.evidence)
  }
  return args
}

/**
 * Build the `blueprint observe` args surfacing a CONTRADICTED doc on the
 * board. The observe grammar has no 'contradicted' status flag (`--status`
 * accepts only observed|corroborates|supersedes), and a plain `observed` write
 * would be REFUSED by observe's contradiction rule — the learn pass just wrote
 * an active note on `module:<modulePath>`. `--status corroborates` is what the
 * CLI actually accepts here: the note ADDS to the module's investigation
 * record, and the doc-vs-code contradiction lives in the note text. The doc
 * itself rides along as a `file:` anchor (ANCHOR_PATTERN accepts it), so the
 * note is hash-stamped against the contradicting doc.
 */
export function buildContradictionObserveArgs(input: {
  modulePath: string
  docPath: string
  evidence?: string
}): string[] {
  const note =
    input.evidence !== undefined && input.evidence.length > 0
      ? `Doc contradicts code: ${input.docPath} — ${input.evidence}`
      : `Doc contradicts code: ${input.docPath}`
  return [
    'blueprint',
    'observe',
    '--note',
    note,
    '--anchor',
    `module:${input.modulePath}`,
    '--anchor',
    `file:${input.docPath}`,
    '--status',
    'corroborates',
  ]
}

/** Result of invoking the bundled CLI (stdout captured for parsing). */
export interface CliRunResult {
  ok: boolean
  stdout: string
  error?: string
  /** Full captured stderr tail (up to STDERR_TAIL_CHARS) — `error` is only its
   *  last line, which truncates multi-line refusals (e.g. narrate's strict-mode
   *  violation list); callers that need the verbatim text read this instead. */
  stderr?: string
}

/** Signature of the bundled-CLI invoker — injectable for tests. */
export type CliRunner = (
  bundledCli: BundledCli,
  cwd: string,
  args: readonly string[],
) => Promise<CliRunResult>

/**
 * Default CLI runner: spawn the app-embedded planflow-ai as Electron-as-Node,
 * capturing stdout (unlike provisioner.runBundledCli, which ignores it — we
 * need the `observed: note <fingerprint>` line). Never rejects.
 */
export async function runBundledCliCapturing(
  bundledCli: BundledCli,
  cwd: string,
  args: readonly string[],
  /** Longer than the default for verbs that legitimately run long (knowledge enable from a big vault). */
  options: {
    timeoutMs?: number
    /** Extra variables for the child, layered over the inherited environment. */
    env?: Record<string, string>
  } = {},
): Promise<CliRunResult> {
  const timeoutMs = options.timeoutMs ?? OBSERVE_TIMEOUT_MS
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...options.env }
  // SPAWNED FROM THE HOST, NOT FROM HERE. posix_spawn from Electron's main
  // process is expensive enough to show up as most of its CPU during a stall
  // (see cli-host/host.ts); the host does it instead. A null answer means the
  // host is unavailable, and the original in-process spawn below runs.
  const hosted = runInCliHost({
    execPath: bundledCli.execPath,
    args: [bundledCli.cliPath, ...args],
    cwd,
    env,
    captureStdout: true,
    timeoutMs,
  })
  if (hosted !== null) {
    const result = await hosted
    if (result.error !== 'cli host exited' && result.error !== 'cli host unreachable') {
      return result.ok
        ? { ok: true, stdout: result.stdout }
        : {
            ok: false,
            stdout: result.stdout,
            // The host reports a non-zero exit with no `error` — and this CLI
            // writes its refusals to STDOUT (allowed-pattern #15), so a failed
            // derive used to log an empty reason. Name it the way the
            // in-process path below does.
            error: result.error ?? refusalLine(result.stderr) ?? refusalLine(result.stdout) ?? 'exited with an error',
            stderr: result.stderr,
          }
    }
  }
  return new Promise<CliRunResult>((resolve) => {
    let stdout = ''
    let stderrTail = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bundledCli.execPath, [bundledCli.cliPath, ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
      // DERIVED WORK LOSES TO THE WINDOW. These children hash thousands of
      // files (measured: ~7 s of CPU for one root), and several can run at
      // once — which is how the main process ended up starved for 27 seconds
      // with no slow handler anywhere. See background-priority.ts.
      runInBackground(child.pid)
    } catch (error) {
      resolve({ ok: false, stdout: '', error: (error as Error).message })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, stdout, error: 'timed out', stderr: stderrTail })
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS)
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, error: error.message, stderr: stderrTail })
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      resolve(
        code === 0
          ? { ok: true, stdout }
          : {
              ok: false,
              stdout,
              error: refusalLine(stderrTail) ?? `exited with ${String(code)}`,
              stderr: stderrTail,
            },
      )
    })
  })
}

/** Parse the `observed: note <fingerprint> (...)` line from observe's stdout. */
export function parseObserveFingerprint(stdout: string): string | null {
  const match = /observed: note (\S+)/.exec(stdout)
  return match ? match[1] : null
}

// ── The learn-pass executor ──────────────────────────────────────────────────

/** Parameters for a full learn pass over one module. */
export interface LearnPassParams {
  /** Repo root — the caged session's cwd and the doc/observe base. */
  rootPath: string
  /** Module path (relative to rootPath) — the anchor + doc identity. */
  modulePath: string
  /** Candidate files for the module (ranked internally). */
  files: readonly ModuleFile[]
  /** The module's claim-tier docs/images to adjudicate (capped internally). */
  claimFiles?: readonly ModuleFile[]
  /** Model id for the caged session. Omit → SDK default. */
  model?: string
  /** The app-embedded CLI used to write the investigation note. */
  bundledCli: BundledCli
  /** Supersede a prior note instead of appending a fresh one. */
  supersede?: { fingerprint: string; reason: string }
  /** File-ranking caps (default DEFAULT_RANK_CAPS). */
  caps?: RankCaps
  /** Caged-session turn budget. */
  maxTurns?: number
  /** Cancels the caged session. */
  abortSignal?: AbortSignal
  /** Account-resolved auth env for the caged session. */
  authEnv?: NodeJS.ProcessEnv
  /** Notified with each file the caged session reads (live-progress; throttled upstream). */
  onRead?: (filePath: string) => void
  /** The store's features — the vocabulary a relationship may name. */
  roster?: readonly FeatureRosterEntry[]
  /** Called as the session works (see CagedSessionParams.onActivity). */
  onActivity?: (kind: string, detail?: string) => void
}

/** Outcome of a learn pass. `ok:false` carries a one-line reason. */
export interface LearnPassResult {
  ok: boolean
  /** Absolute path to the module doc (present once written, even if observe fails). */
  docPath?: string
  /** Fingerprint of the observe note (present on a fully successful pass). */
  noteFingerprint?: string
  /** One-line failure reason when ok is false. */
  reason?: string
  /** Fail-soft adjudication failures (one line each) — never fail the learn. */
  adjudicationWarnings?: string[]
}

/** Injectable seams for the executor (tests mock the session + CLI). */
export interface LearnPassDeps {
  /** Runs the caged session. Default: runCagedSession. */
  runSession?: (params: CagedSessionParams) => Promise<string>
  /** Invokes the bundled CLI. Default: runBundledCliCapturing. */
  runCli?: CliRunner
  /** Clock — default new Date() (tests pass a fixed date for changelog). */
  now?: () => Date
}

/**
 * Run one learn pass over a module: rank files → caged read-only session →
 * parse structured output (fail-soft) → write the brain doc → write the
 * investigation note via `blueprint observe`. ALL writes happen HERE, never in
 * the session (NFR1). Returns a structured, honest result — a malformed
 * session output or a failed observe yields ok:false with a reason.
 */
export async function runLearnPass(
  params: LearnPassParams,
  deps: LearnPassDeps = {},
): Promise<LearnPassResult> {
  const ranked = rankModuleFiles(params.files, params.caps)
  const { claimFiles, overCap } = capClaimFiles(params.claimFiles ?? [])
  const offeredClaimPaths = claimFiles.map((file) => file.path)
  const prompt = buildLearnPrompt({
    modulePath: params.modulePath,
    rankedFiles: ranked,
    claimFiles,
    ...(params.roster !== undefined ? { roster: params.roster } : {}),
  })
  const runSession = deps.runSession ?? runCagedSession

  let rawOutput: string
  try {
    rawOutput = await runSession({
      cwd: params.rootPath,
      prompt,
      model: params.model,
      maxTurns: params.maxTurns,
      abortSignal: params.abortSignal,
      authEnv: params.authEnv,
      onRead: params.onRead,
      ...(params.onActivity === undefined ? {} : { onActivity: params.onActivity }),
    })
  } catch (error) {
    // Turn exhaustion is RECOVERABLE, not a dead end: the session spent its
    // budget reading and never got to emit the JSON. Fall through to the
    // corrective retry (which tells it to answer from what it has already
    // read) instead of failing the pass outright — live orbit-app failure
    // 2026-07-30, where every exhausted endpoint learn died with no retry.
    if (!isTurnExhaustion(error)) {
      return { ok: false, reason: `learn session failed: ${errorMessage(error)}` }
    }
    rawOutput = ''
  }

  let parsed = parseLearnOutput(rawOutput, offeredClaimPaths)
  if (parsed === null) {
    // One bounded retry: big modules can overrun the model's output budget so
    // the JSON never closes (live finding, run progressive-learning). Re-run
    // with a corrective, size-capped instruction before giving up.
    try {
      rawOutput = await runSession({
        cwd: params.rootPath,
        prompt: `${prompt}\n\nIMPORTANT: your previous attempt did not produce a single valid JSON object. Respond with ONLY the JSON object — no prose, no code fences. Keep docMarkdown under 250 lines; summarize rather than exhaust. Read only the files you still need — if you are running low on turns, answer from what you have already read.`,
        model: params.model,
        maxTurns: params.maxTurns,
        abortSignal: params.abortSignal,
        authEnv: params.authEnv,
        onRead: params.onRead,
      })
    } catch (error) {
      return {
        ok: false,
        reason: isTurnExhaustion(error)
          ? `learn session ran out of turns twice (${errorMessage(error)}) — module may be too large; try drilling into a submodule`
          : `learn session failed on retry: ${errorMessage(error)}`,
      }
    }
    parsed = parseLearnOutput(rawOutput, offeredClaimPaths)
  }
  if (parsed === null) {
    // Salvage before failing: a truncated response usually still carries the
    // real doc content (#learn-large-modules) — an honest partial doc beats
    // a failed pass on a module the user asked to learn.
    parsed = salvageLearnOutput(rawOutput)
  }
  if (parsed === null) {
    return {
      ok: false,
      reason: 'learn session returned malformed output twice (no parseable JSON — module may be too large; try drilling into a submodule)',
    }
  }

  const now = deps.now ? deps.now() : new Date()
  let docPath: string
  try {
    docPath = writeModuleDoc(params.rootPath, params.modulePath, parsed.docMarkdown, now)
  } catch (error) {
    return { ok: false, reason: `failed to write module doc: ${errorMessage(error)}` }
  }

  const args = buildObserveArgs({
    rootPath: params.rootPath,
    modulePath: params.modulePath,
    noteSummary: parsed.noteSummary,
    docPath,
    keyAnchors: parsed.keyAnchors,
    supersede: params.supersede,
  })
  const runCli = deps.runCli ?? runBundledCliCapturing
  const cliResult = await runCli(params.bundledCli, params.rootPath, args)
  if (!cliResult.ok) {
    return { ok: false, docPath, reason: `blueprint observe failed: ${cliResult.error ?? 'unknown'}` }
  }
  const fingerprint = parseObserveFingerprint(cliResult.stdout)
  if (fingerprint === null) {
    // A note-less "learned" is worse than a failed pass: the investigation
    // note is the ONLY thing stale-check re-hashes, so an unconfirmed note
    // silently becomes the perpetual reset loop (learned → reconcileNoteless
    // → stale → re-learn). Loud failure instead (2026-07-23 incident: the CLI
    // ran its interactive default under Electron-as-node and never observed).
    return {
      ok: false,
      docPath,
      reason: `blueprint observe output unrecognized — note not confirmed (stdout: ${cliResult.stdout.slice(0, 120).trim() || '(empty)'})`,
    }
  }

  // ADJUDICATION (trust-tiers): record the session's per-doc verdicts via the
  // CLI verb, plus contradiction notes on the board. Strictly fail-soft — a
  // failed adjudicate/observe degrades that doc to unadjudicated with a
  // warning, never failing an otherwise-successful learn.
  const adjudicationWarnings = await recordDocVerdicts({
    rootPath: params.rootPath,
    modulePath: params.modulePath,
    bundledCli: params.bundledCli,
    runCli,
    verdicts: parsed.docVerdicts ?? [],
    overCap,
    against: ranked.map((file) => file.path),
  })

  return {
    ok: true,
    docPath,
    ...(fingerprint ? { noteFingerprint: fingerprint } : {}),
    ...(adjudicationWarnings.length > 0 ? { adjudicationWarnings } : {}),
  }
}

/**
 * Record the pass's doc verdicts through the CLI: one `blueprint adjudicate`
 * per verdict (witnessed by the ranked code files), one extra `blueprint
 * observe` per CONTRADICTED verdict (board visibility), and an `unverifiable`
 * verdict for every over-cap claim file. Every invocation is independent and
 * fail-soft; failures come back as one-line warnings.
 */
async function recordDocVerdicts(input: {
  rootPath: string
  modulePath: string
  bundledCli: BundledCli
  runCli: CliRunner
  verdicts: readonly DocVerdict[]
  overCap: readonly string[]
  against: readonly string[]
}): Promise<string[]> {
  const warnings: string[] = []
  for (const verdict of input.verdicts) {
    const adjudicateArgs = buildAdjudicateArgs({
      path: verdict.path,
      verdict: verdict.verdict,
      against: input.against,
      ...(verdict.evidence !== undefined ? { evidence: verdict.evidence } : {}),
    })
    const adjudicated = await input.runCli(input.bundledCli, input.rootPath, adjudicateArgs)
    if (!adjudicated.ok) {
      warnings.push(`adjudicate failed for ${verdict.path}: ${adjudicated.error ?? 'unknown'}`)
    }
    if (verdict.verdict === 'contradicted') {
      const observeArgs = buildContradictionObserveArgs({
        modulePath: input.modulePath,
        docPath: verdict.path,
        ...(verdict.evidence !== undefined ? { evidence: verdict.evidence } : {}),
      })
      const observed = await input.runCli(input.bundledCli, input.rootPath, observeArgs)
      if (!observed.ok) {
        warnings.push(
          `contradiction observe failed for ${verdict.path}: ${observed.error ?? 'unknown'}`,
        )
      }
    }
  }
  for (const path of input.overCap) {
    const adjudicateArgs = buildAdjudicateArgs({
      path,
      verdict: 'unverifiable',
      against: [],
      evidence: 'not adjudicated — over cap',
    })
    const adjudicated = await input.runCli(input.bundledCli, input.rootPath, adjudicateArgs)
    if (!adjudicated.ok) {
      warnings.push(`adjudicate failed for ${path}: ${adjudicated.error ?? 'unknown'}`)
    }
  }
  return warnings
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// The one-shot streaming-input helper (singleUserPrompt) moved into
// ClaudeRuntime, which now owns building the SDK user-message stream — see the
// runCagedSession reroute above (multi_runtime_support, Task 2.3).

/** Last non-empty line of a stderr tail, or null. */
function lastLine(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  return lines.length > 0 ? lines[lines.length - 1] : null
}

/** How much of a refusal to surface — enough to act on, not the whole store. */
const REFUSAL_CHARS = 300

/**
 * The ACTIONABLE line from a CLI failure.
 *
 * Every refusal in this CLI is `<verb> refused: <reason>` on its own line, but
 * a reason may embed multi-line content — `observe refused:` quotes the
 * conflicting note's fingerprint, which is `<full note text>+<anchor refs>` and
 * contains blank lines. Taking the LAST line of stderr therefore showed the
 * user the tail of somebody else's note:
 *
 *   Learning failed: blueprint observe failed:
 *   Doc: flow/brain/modules/e2e-tests-chats.md+["e2e/tests/chats", …]
 *
 * …instead of the sentence that says what to do about it. Prefer the refusal
 * line itself; fall back to the last line when there is no refusal marker.
 */
function refusalLine(text: string): string | null {
  const refusal = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => / refused: /.test(line))
  const chosen = refusal ?? lastLine(text)
  if (chosen === null) return null
  return chosen.length > REFUSAL_CHARS ? `${chosen.slice(0, REFUSAL_CHARS)}…` : chosen
}

/** Normalize an unknown thrown value to a message string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * True when the SDK ended the session because it hit `maxTurns` (it surfaces
 * as `Claude Code returned an error result: Reached maximum number of turns
 * (N)`). Matched on the message because the SDK gives no typed discriminator.
 */
export function isTurnExhaustion(error: unknown): boolean {
  return /maximum number of turns/i.test(errorMessage(error))
}

// ── SDK loading (ESM from CJS) ───────────────────────────────────────────────

type AgentSdkModule = { query: QueryFunction }

/** Runtime import() that TypeScript's CJS output cannot rewrite to require. */
const dynamicImport = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<AgentSdkModule>

/** Lazily load the real SDK's query fn (tests inject queryFn instead), bound
 *  to a binary that is known to exist — downloaded first if this install
 *  shipped without one (agent-binary.ts). */
async function loadSdkQuery(): Promise<QueryFunction> {
  const [sdk, binary] = await Promise.all([dynamicImport(SDK_MODULE_SPECIFIER), ensureAgentBinary()])
  return bindAgentBinary(sdk.query, binary.path)
}

/** Statically read a file's byte size — convenience for callers building
 *  ModuleFile lists from disk. Fail-soft: unreadable → size 0 (ranked last). */
export function fileSize(absolutePath: string): number {
  try {
    return statSync(absolutePath).size
  } catch {
    return 0
  }
}

// ── The FEATURE learn pass ─────────────────────────────────────────────────
//
// A learn pass scoped to a FEATURE rather than a module. It reads the feature's
// own anchored files and produces LEARNINGS — one-line facts about what the
// feature does and how it behaves — which the CLI writes into the feature's
// machine-owned `## Learned` section.
//
// Deliberately NOT a fan-out over the feature's modules, and NOT a synthesis of
// their docs: a feature is not the sum of its directories, and synthesising
// module docs would inherit and compound their errors. It reads the code.
//
// This is also what makes an already-implemented capability learnable with no
// plan in the picture — the pass needs anchors and files, never a plan.

/** How many learnings one pass may produce. Beyond this it is a document. */
export const FEATURE_LEARNING_MAX = 8

/** Parameters for one feature learn pass. */
export interface FeatureLearnPassParams {
  rootPath: string
  /** Feature id or slug — what `blueprint features learned --feature` takes. */
  featureRef: string
  /** Display name, for the prompt. */
  featureName: string
  /** The feature's anchored files, unranked. */
  files: readonly ModuleFile[]
  /** `code` (default) or `plan:<name>` when a run taught this. */
  provenance?: string
  /** Repo-relative plan/discovery docs about this feature (read first). */
  planDocs?: readonly string[]
  /** The store's features — the vocabulary a relationship may name. */
  roster?: readonly FeatureRosterEntry[]
  model?: string
  maxTurns?: number
  caps?: RankCaps
  bundledCli: BundledCli
  abortSignal?: AbortSignal
  authEnv?: NodeJS.ProcessEnv
  onRead?: (filePath: string) => void
  /** Injected clock — the learning's date. */
  now?: () => Date
  /**
   * Return the learnings instead of writing them to the feature's `## Learned`.
   *
   * A PART's learnings belong to the part, not to its parent — appending them
   * to the parent would pool everything the children know into one flat list
   * and lose which piece of the system each fact is about.
   */
  collectOnly?: boolean
}

export interface FeatureLearnPassResult {
  ok: boolean
  /** The learnings written, in the order the model produced them. */
  learnings?: string[]
  /** The relationships PROPOSED — the store decides which of them it accepts. */
  edges?: FeatureEdgeProposal[]
  reason?: string
}

/** Build the feature prompt. Asks for FACTS, not a document. */
export function buildFeatureLearnPrompt(input: {
  featureName: string
  rankedFiles: readonly ModuleFile[]
  /** Plan/discovery docs about this feature — the WHY the code cannot state. */
  planDocs?: readonly string[]
  /**
   * The other features in the store — the names this pass may relate TO.
   *
   * This is the pass the roster was written for: it is reading ONE capability's
   * code, which is exactly when the connection to another capability is
   * visible. `runFeatureLearnPass` removes the subject from the list, so a
   * feature can never be handed its own id to relate to.
   */
  roster?: readonly FeatureRosterEntry[]
}): string {
  const docs = input.planDocs ?? []
  const hasRoster = (input.roster ?? []).length > 0
  return [
    `You are recording what is known about the feature "${input.featureName}" in a project knowledge base.`,
    'Read the files below using your Read/Grep/Glob tools, then report what you LEARNED about how this feature actually behaves.',
    '',
    BRAIN_FIRST_COMPACT,
    '',
    'Files (ranked; read the ones you need):',
    input.rankedFiles.map((file) => `- ${file.path}`).join('\n'),
    ...(docs.length > 0
      ? [
          '',
          // The plan and its discovery hold what the code cannot say: the
          // problem that motivated the work, the constraints, the mechanism
          // and the known failure modes. A reader opening this feature wants
          // that, and it exists nowhere in the source.
          'Plan and discovery documents for this feature — READ THESE FIRST. They',
          'carry the problem, the decisions and the known failure modes, none of',
          'which the code states about itself:',
          docs.map((doc) => `- ${doc}`).join('\n'),
          '',
          'Prefer a learning that explains WHY or HOW the system behaves as it does',
          '(from the docs, corroborated by code) over one that merely restates a file.',
          'If a document claims something the code contradicts, trust the CODE and say so.',
        ]
      : []),
    ...renderFeatureRoster(input.roster ?? []),
    '',
    'A learning is ONE SENTENCE stating something non-obvious and specific that is TRUE of this code.',
    'Good: "Reload can duplicate a completed turn because the streamed message id differs from the persisted row id."',
    'Bad: "This feature handles chats." (says nothing) — "useMessageCatchup exists." (the code already says that)',
    '',
    'Rules:',
    `- At most ${String(FEATURE_LEARNING_MAX)} learnings. Fewer is better than padded.`,
    '- Every learning must be grounded in a file you actually read. Never invent behaviour.',
    '- No newlines inside a learning — one line each.',
    '- If the code does not support a non-obvious claim, return fewer learnings. An empty list is a valid, honest answer.',
    '',
    'Reply with ONLY a single JSON object — no prose, no code fence:',
    hasRoster
      ? '{ "learnings": ["<one sentence>"], "relates": [{"target": "<an id from the list above>", "via": "<the file or file.ts#symbol where you saw it>", "note": "<one line: how they connect>"}] }'
      : '{ "learnings": ["<one sentence>", "<one sentence>"] }',
    // THE `relates` HALF. Recording the relationship is the deliverable the
    // roster exists for — and the `note` is what makes it worth recording: a
    // bare id says two capabilities touch and sends the reader into both of
    // them, which is the failure this whole feature is fixing.
    ...(hasRoster
      ? [
          '',
          '"relates" — one entry per connection to a listed feature that you ACTUALLY SAW in the code:',
          `- At most ${String(FEATURE_EDGE_MAX)} of them. Omit "relates" entirely if you saw none.`,
          '- "target" must be copied EXACTLY from the list above. An id that is not on the list is refused, and inventing one is worse than recording nothing.',
          '- "via" is the MECHANISM — the repo-relative file (or `file.ts#symbol`) where the connection is made. It is what lets the system notice when the mechanism changes.',
          '- "note" is ONE line answering "how do these two connect?" for somebody who will never open the other feature. "A playbook step names a skill by slug; playbook_manifest_binder.ts resolves it at authoring time" — not "related to skills".',
        ]
      : []),
  ].join('\n')
}

/** One relationship the pass proposes. Mirrors the CLI's FeatureEdge. */
export interface FeatureEdgeProposal {
  /** The other feature's id — validated against the roster by the store. */
  target: string
  /** The mechanism: a file, `file#symbol`, or a named seam. */
  via?: string
  /** One line of how/why, readable without opening either feature. */
  note?: string
}

/** How many relationships one pass may propose. Beyond this it is guessing. */
export const FEATURE_EDGE_MAX = 6

/** Longest `note` kept — an edge note is one line, not a paragraph. */
export const EDGE_NOTE_MAX_CHARS = 240

/** Collapse an edge field to one clean, capped line, or undefined. */
function edgeLine(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const line = value.replace(/\s+/g, ' ').trim().slice(0, max)
  return line.length > 0 ? line : undefined
}

/**
 * Parse the `relates` half of a feature pass's output.
 *
 * SEPARATE FROM `parseFeatureLearnOutput` on purpose: the learnings and the
 * edges are written by two different store paths and either can be refused
 * alone, so a model that returns good facts and one unusable edge must not
 * lose the facts. Never throws; anything malformed is simply not an edge.
 *
 * Membership in the roster is NOT judged here — the store owns that verdict
 * (allowed-pattern #14), and it is the only thing that actually knows which
 * features exist.
 */
export function parseFeatureLearnEdges(raw: string): FeatureEdgeProposal[] {
  const candidate = extractJsonObject(raw)
  if (candidate === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const list = (parsed as Record<string, unknown>)['relates']
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const edges: FeatureEdgeProposal[] = []
  for (const item of list) {
    if (edges.length >= FEATURE_EDGE_MAX) break
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const target = edgeLine(record['target'], 200)
    if (target === undefined || seen.has(target)) continue
    seen.add(target)
    const via = edgeLine(record['via'], 200)
    const note = edgeLine(record['note'], EDGE_NOTE_MAX_CHARS)
    edges.push({ target, ...(via !== undefined ? { via } : {}), ...(note !== undefined ? { note } : {}) })
  }
  return edges
}

/** Parse the feature pass output. Null when it is not the agreed shape. */
export function parseFeatureLearnOutput(raw: string): string[] | null {
  const candidate = extractJsonObject(raw)
  if (candidate === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const list = (parsed as Record<string, unknown>)['learnings']
  if (!Array.isArray(list)) return null
  // An EMPTY list is a valid answer ("nothing non-obvious here"), which is why
  // this returns [] rather than null — null means "the model did not answer".
  return list
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s*\n\s*/g, ' ').trim())
    .filter((item) => item.length > 0)
    .slice(0, FEATURE_LEARNING_MAX)
}

/**
 * Run one feature learn pass: caged read, then the CLI writes.
 *
 * The executor performs every write, and the WRITE ITSELF goes through
 * `blueprint features learned` rather than fs — the store owns the boundary
 * parser that stands between this pass and an unrecoverable overwrite of
 * human prose. A refusal from it (ambiguous boundary, hand-edited section)
 * surfaces verbatim and NOTHING is written.
 */
export async function runFeatureLearnPass(
  params: FeatureLearnPassParams,
  deps: { runSession?: typeof runCagedSession; runCli?: typeof runBundledCliCapturing } = {},
): Promise<FeatureLearnPassResult> {
  const ranked = rankModuleFiles(params.files, params.caps)
  if (ranked.length === 0) {
    return { ok: false, reason: 'this feature claims no readable files' }
  }
  // A feature cannot relate to itself, so it is never handed its own name.
  // `featureRef` is an id OR a slug (that is what the CLI verb takes), so both
  // are compared — matching only one would leave the subject in half the time.
  const roster = (params.roster ?? []).filter(
    (entry) => entry.id !== params.featureRef && entry.id !== `feature:${params.featureRef}`,
  )
  const prompt = buildFeatureLearnPrompt({
    featureName: params.featureName,
    rankedFiles: ranked,
    ...(params.planDocs !== undefined ? { planDocs: params.planDocs } : {}),
    ...(roster.length > 0 ? { roster } : {}),
  })
  const runSession = deps.runSession ?? runCagedSession
  const runCli = deps.runCli ?? runBundledCliCapturing

  const session = (text: string): Promise<string> =>
    runSession({
      cwd: params.rootPath,
      prompt: text,
      model: params.model,
      maxTurns: params.maxTurns,
      abortSignal: params.abortSignal,
      authEnv: params.authEnv,
      onRead: params.onRead,
    })

  let raw: string
  try {
    raw = await session(prompt)
  } catch (error) {
    // Same recovery as the module pass: turn exhaustion means it spent its
    // budget reading and never emitted, which the corrective retry can save.
    if (!isTurnExhaustion(error)) {
      return { ok: false, reason: `feature learn session failed: ${errorMessage(error)}` }
    }
    raw = ''
  }

  let learnings = parseFeatureLearnOutput(raw)
  if (learnings === null) {
    try {
      raw = await session(
        `${prompt}\n\nIMPORTANT: your previous attempt did not produce a single valid JSON object. Respond with ONLY the JSON object. If you are low on turns, answer from what you have already read.`,
      )
    } catch (error) {
      return { ok: false, reason: `feature learn session failed on retry: ${errorMessage(error)}` }
    }
    learnings = parseFeatureLearnOutput(raw)
  }
  if (learnings === null) {
    return { ok: false, reason: 'feature learn session did not return the agreed JSON shape' }
  }
  // A PART's findings belong to the part, and so would its relationships —
  // but `relates` is a field of the FEATURE, and a part has no file of its own
  // to carry one. A collect-only pass therefore proposes no edges rather than
  // attributing a part's reading to its parent.
  const edges = params.collectOnly === true ? [] : parseFeatureLearnEdges(raw)
  if (learnings.length === 0 && edges.length === 0) {
    // Honest, and not a failure — but nothing is written, so the section keeps
    // whatever it had rather than being emptied by a quiet pass.
    return { ok: true, learnings: [] }
  }

  const now = params.now ? params.now() : new Date()
  const date = now.toISOString().slice(0, 10)
  const provenance = params.provenance ?? 'code'
  if (params.collectOnly === true) return { ok: true, learnings }

  const args = ['blueprint', 'features', 'learned', '--feature', params.featureRef]
  for (const text of learnings) {
    args.push('--entry', JSON.stringify({ text, provenance, date }))
  }
  // THE SAME WRITER, one more machine-owned field. `relates` rides along on the
  // learned write rather than through a second CLI call: one invocation, one
  // re-read of the file, and no window in which the facts landed and the
  // relationships did not.
  if (edges.length > 0) args.push('--relates', JSON.stringify(edges))

  const written = await runCli(params.bundledCli, params.rootPath, args)
  if (!written.ok) {
    return {
      ok: false,
      reason: `could not write learnings: ${written.error ?? 'unknown'}`,
    }
  }
  return { ok: true, learnings, ...(edges.length > 0 ? { edges } : {}) }
}
