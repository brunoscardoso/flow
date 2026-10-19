/**
 * Transcript backfill for promoted sub-agent child threads (#1931).
 *
 * THE GAP THIS CLOSES. A promoted child's transcript normally comes from rows
 * the stream bridge tagged while the sub-agent streamed through the parent
 * session. Runs that predate that capture — and any run whose internals never
 * reached this process (an app restart mid-run empties the bridge's in-memory
 * spawn maps) — left NOTHING to re-home, so promotion produced a child with a
 * banner and an empty feed. The SDK, however, persists every sub-agent's full
 * transcript in session storage (`<config>/projects/<dir>/<sessionId>/
 * subagents/agent-<agentId>.jsonl`), and exposes it via `listSubagents` +
 * `getSubagentMessages`. This module reads that transcript at promotion time
 * and materializes it into the child through the ThreadStore — the same single
 * writer every other transcript row goes through (allowed-pattern #14).
 *
 * WHEN IT RUNS. Only when the child is EMPTY (zero messages, zero tool calls):
 * a child the re-home path populated, a child already backfilled, and a child
 * the user has continued are all left exactly as they are. Idempotent by that
 * guard, and fail-soft everywhere — session files missing, the SDK throwing,
 * an unresolvable agent — one log line, empty child, promotion never crashes.
 *
 * HOW THE AGENT IS FOUND, in order:
 *   1. The spawn record's stored `agent_id` (schema v38, stamped from the
 *      runtime's task events) — deterministic, covers every run after this
 *      build.
 *   2. Historical runs: recover the spawn's SDK `tool_use_id` from the PARENT
 *      session transcript (`getSessionMessages`) by matching the spawn record's
 *      input (prompt, then description) against Task/Agent `tool_use` blocks,
 *      then pick the sub-agent whose messages carry that id as their
 *      `parent_tool_use_id`. Validated against real session storage
 *      (2026-10-07): every sub-agent message carries the spawn's tool_use id,
 *      while the sub-agent's own first user message (the prompt) is NOT
 *      returned by `getSubagentMessages` — an `attachment` entry between the
 *      prompt and the first assistant message breaks the SDK's parentUuid
 *      chain walk in every observed transcript — so prompt-matching against
 *      the CHILD transcript cannot work and is not attempted first.
 *   3. Last resort: the child transcript's own first message, when it IS a
 *      user prompt, matched against the spawn's prompt.
 * Ambiguity (multiple or zero candidates) picks NONE — a wrong transcript in
 * the child is worse than an empty one.
 *
 * SESSION STORAGE LOCATION. The SDK resolves its storage root from
 * `process.env.CLAUDE_CONFIG_DIR` at call time; account-bound projects keep
 * their sessions under the account's isolated config dir. The readers are the
 * SDK's own (pattern #11 — the exact code that wrote the files), so the env
 * var is set around the calls and restored, serialized through one mutex so
 * two concurrent promotions can never see each other's dir. Residual window:
 * a LEGACY-auth session whose env snapshot (`{...process.env}` in authEnv) is
 * taken during a swapped read would inherit the account dir — account-bound
 * sessions are immune (buildAccountEnv overwrites the var), legacy installs
 * never swap (resolveConfigDir → null), so it takes a mixed account/legacy
 * project set AND a session starting inside a first-promotion's file reads.
 */
import type { ThreadStore, ToolCallRecord } from '../store/thread-store'

/** The SDK session-storage readers this module uses — injectable for tests. */
export interface BackfillSdk {
  listSubagents(sessionId: string): Promise<string[]>
  getSubagentMessages(
    sessionId: string,
    agentId: string,
    options?: { limit?: number },
  ): Promise<SessionMessageLike[]>
  getSessionMessages(sessionId: string): Promise<SessionMessageLike[]>
}

/** The parts of the SDK's SessionMessage this module reads (shape validated
 *  against the live SDK, 2026-10-07): `message` is the raw Anthropic API
 *  message; `timestamp` is the transcript entry's own time. */
export interface SessionMessageLike {
  type: string
  message?: unknown
  parent_tool_use_id?: string | null
  timestamp?: string
}

export interface SubagentBackfillDeps {
  threadStore: ThreadStore
  /** The account-isolated CLAUDE_CONFIG_DIR for a project's sessions, or null
   *  for legacy auth (SDK default: ~/.claude). Resolved per parent thread. */
  resolveConfigDir?: (projectRoot: string) => Promise<string | null>
  /** Tests inject a fake; production lazy-imports the real ESM SDK. */
  sdk?: BackfillSdk
}

export interface BackfillResult {
  filled: boolean
  reason?: string
}

const SDK_MODULE_SPECIFIER = '@anthropic-ai/claude-agent-sdk'

/** Runtime import() that TypeScript's CJS output cannot rewrite to require —
 *  the same seam flow-tools and agent-manager use for the ESM-only SDK. */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>

async function loadRealSdk(): Promise<BackfillSdk> {
  return (await dynamicImport(SDK_MODULE_SPECIFIER)) as BackfillSdk
}

/** Serializes every CLAUDE_CONFIG_DIR swap — see the module note. */
let configDirLock: Promise<unknown> = Promise.resolve()

/** Run `work` with `process.env.CLAUDE_CONFIG_DIR` pointed at `configDir`
 *  (null = leave the environment alone), restoring the previous value after.
 *  Serialized so overlapping backfills cannot interleave their swaps. */
async function withConfigDir<T>(configDir: string | null, work: () => Promise<T>): Promise<T> {
  if (configDir === null) return work()
  const run = configDirLock.then(async () => {
    const previous = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = configDir
    try {
      return await work()
    } finally {
      if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = previous
    }
  })
  configDirLock = run.catch(() => undefined)
  return run
}

/**
 * Build the backfill: given a promoted CHILD thread id, materialize its
 * sub-agent transcript from SDK session storage when (and only when) the child
 * is empty. Awaited by the `threads:openSubagent` handler BEFORE it returns,
 * so the renderer's thread switch lands on a populated child.
 */
export function makeSubagentBackfill(
  deps: SubagentBackfillDeps,
): (childThreadId: string) => Promise<BackfillResult> {
  const { threadStore } = deps
  return async (childThreadId) => {
    try {
      const child = threadStore.getThread(childThreadId)
      if (!child?.parentThreadId || !child.originToolCallId) {
        return { filled: false, reason: 'not a promoted child' }
      }
      // THE IDEMPOTENCE GUARD: anything already in the child — re-homed rows,
      // a previous backfill, the user's own continuation — means no backfill.
      if (
        threadStore.countMessages(childThreadId) > 0 ||
        threadStore.countToolCalls(childThreadId) > 0
      ) {
        return { filled: false, reason: 'child not empty' }
      }
      const parent = threadStore.getThread(child.parentThreadId)
      const sessionId = parent?.sdkSessionId ?? null
      if (parent === null || sessionId === null) {
        return { filled: false, reason: 'parent has no SDK session' }
      }
      // The spawn lives on the PARENT and is never re-homed (the re-home moves
      // rows TAGGED with it, not the Task call itself).
      const spawn = threadStore.getToolCall(parent.id, child.originToolCallId)
      const sdk = deps.sdk ?? (await loadRealSdk())
      const configDir = (await deps.resolveConfigDir?.(parent.projectRoot)) ?? null

      return await withConfigDir(configDir, async () => {
        const messages = await resolveTranscript(sdk, sessionId, spawn)
        if (messages === null || messages.length === 0) {
          console.warn(
            `[SubagentBackfill] no transcript resolved for child ${childThreadId} ` +
              `(session ${sessionId}) — leaving the child empty`,
          )
          return { filled: false, reason: 'no transcript resolved' }
        }
        materialize(threadStore, childThreadId, messages)
        return { filled: true }
      })
    } catch (error) {
      // Fail-soft by contract: promotion must survive a missing session file,
      // a broken transcript, or the SDK itself throwing.
      console.warn(`[SubagentBackfill] backfill failed for child ${childThreadId}:`, error)
      return { filled: false, reason: 'error' }
    }
  }
}

/** The spawn's parsed Task input — what every matching rung keys on. */
interface SpawnInput {
  description: string
  prompt: string
}

function parseSpawnInput(inputJson: string | null | undefined): SpawnInput {
  if (typeof inputJson !== 'string') return { description: '', prompt: '' }
  try {
    const parsed = JSON.parse(inputJson) as { description?: unknown; prompt?: unknown }
    return {
      description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '',
    }
  } catch {
    return { description: '', prompt: '' }
  }
}

/** The sub-agent's transcript, through the resolution ladder in the module
 *  note. Null when no agent can be attributed unambiguously. */
async function resolveTranscript(
  sdk: BackfillSdk,
  sessionId: string,
  spawn: ToolCallRecord | null,
): Promise<SessionMessageLike[] | null> {
  // Rung 1: the stored agent id (new runs). Tried directly — an id the session
  // does not know simply reads as an empty transcript and falls through.
  const storedAgentId = spawn?.agentId ?? null
  if (storedAgentId !== null && storedAgentId.length > 0) {
    const messages = await sdk.getSubagentMessages(sessionId, storedAgentId)
    if (messages.length > 0) return messages
  }

  const input = parseSpawnInput(spawn?.inputJson)
  const agents = await sdk.listSubagents(sessionId)
  if (agents.length === 0) return null

  // Rung 2: recover the spawn's tool_use_id from the parent transcript, then
  // pick the agent whose messages carry it as parent_tool_use_id.
  const toolUseId = await matchSpawnToolUseId(sdk, sessionId, input)
  if (toolUseId !== null) {
    for (const agentId of agents) {
      const [first] = await sdk.getSubagentMessages(sessionId, agentId, { limit: 1 })
      if (first !== undefined && first.parent_tool_use_id === toolUseId) {
        return sdk.getSubagentMessages(sessionId, agentId)
      }
    }
  }

  // Rung 3: the child transcript's own opening prompt, when the SDK returned
  // one (observed to be dropped in practice — see the module note).
  if (input.prompt.length === 0 && input.description.length === 0) return null
  const matches: string[] = []
  for (const agentId of agents) {
    const [first] = await sdk.getSubagentMessages(sessionId, agentId, { limit: 1 })
    const text = firstUserText(first)
    if (text === null) continue
    const promptMatch = input.prompt.length > 0 && text.startsWith(input.prompt.slice(0, 200))
    const descriptionMatch = input.description.length > 0 && text.includes(input.description)
    if (promptMatch || descriptionMatch) matches.push(agentId)
  }
  const only = matches.length === 1 ? matches[0] : undefined
  if (only === undefined) return null
  return sdk.getSubagentMessages(sessionId, only)
}

/** The spawn's SDK tool_use_id, recovered from the parent transcript's Task
 *  `tool_use` blocks by input match — or null unless EXACTLY ONE matches. */
async function matchSpawnToolUseId(
  sdk: BackfillSdk,
  sessionId: string,
  input: SpawnInput,
): Promise<string | null> {
  if (input.prompt.length === 0 && input.description.length === 0) return null
  let parentMessages: SessionMessageLike[]
  try {
    parentMessages = await sdk.getSessionMessages(sessionId)
  } catch {
    return null
  }
  const candidates = new Set<string>()
  for (const message of parentMessages) {
    for (const block of contentBlocks(message)) {
      if (block.type !== 'tool_use') continue
      const blockInput = (block as { input?: unknown }).input
      if (typeof blockInput !== 'object' || blockInput === null) continue
      const spawnLike = blockInput as { prompt?: unknown; description?: unknown }
      if (typeof spawnLike.prompt !== 'string') continue
      const id = (block as { id?: unknown }).id
      if (typeof id !== 'string') continue
      const promptMatch = input.prompt.length > 0 && spawnLike.prompt.trim() === input.prompt
      const descriptionMatch =
        input.prompt.length === 0 &&
        typeof spawnLike.description === 'string' &&
        spawnLike.description.trim() === input.description
      if (promptMatch || descriptionMatch) candidates.add(id)
    }
  }
  if (candidates.size !== 1) return null
  return [...candidates][0] ?? null
}

/** A SessionMessage's API content blocks, or [] for string/absent content. */
function contentBlocks(message: SessionMessageLike | undefined): Array<{ type: string }> {
  const api = message?.message
  if (typeof api !== 'object' || api === null) return []
  const content = (api as { content?: unknown }).content
  if (!Array.isArray(content)) return []
  return content.filter(
    (block): block is { type: string } =>
      typeof block === 'object' && block !== null && typeof (block as { type?: unknown }).type === 'string',
  )
}

/** The message's text when it is a USER message with string content. */
function firstUserText(message: SessionMessageLike | undefined): string | null {
  if (message === undefined || message.type !== 'user') return null
  const api = message.message
  if (typeof api !== 'object' || api === null) return null
  const content = (api as { content?: unknown }).content
  return typeof content === 'string' ? content : null
}

/**
 * Materialize the transcript into the child, mirroring the stream bridge's
 * conventions exactly (handleSubagentAssistant / handleSubagentToolResults) so
 * the pane renders a backfilled child identically to a re-homed one:
 *   - assistant text + thinking → ONE assistant message per SDK message,
 *     thinking leading as a `> 💭` blockquote
 *   - tool_use blocks → tool-call rows, finalized from their tool_result
 *     blocks (success/error + output)
 *   - rows are UNTAGGED (no parentToolCallId) — a re-homed row ends up
 *     untagged in the child, and these match it
 *   - rows keep their SDK session-storage timestamps, so the child reads in
 *     original order (and its clock tells the truth about when the work ran)
 * A tool_use the transcript never answers is finalized `interrupted` — in a
 * finished transcript, no result means the agent was cut off mid-call.
 */
function materialize(
  threadStore: ThreadStore,
  childThreadId: string,
  messages: SessionMessageLike[],
): void {
  /** SDK tool_use_id → persisted record id, for result pairing. */
  const pending = new Map<string, string>()
  for (const message of messages) {
    const api = message.message as { role?: unknown; model?: unknown; content?: unknown } | null
    const timestamp = typeof message.timestamp === 'string' ? message.timestamp : undefined
    if (message.type === 'assistant') {
      const textParts: string[] = []
      const thinkingParts: string[] = []
      const toolUses: Array<{ id: string; name: string; input: unknown }> = []
      for (const block of contentBlocks(message)) {
        if (block.type === 'text') {
          const text = (block as { text?: unknown }).text
          if (typeof text === 'string') textParts.push(text)
        } else if (block.type === 'thinking') {
          const thinking = (block as { thinking?: unknown }).thinking
          if (typeof thinking === 'string') thinkingParts.push(thinking)
        } else if (block.type === 'tool_use') {
          const toolBlock = block as { id?: unknown; name?: unknown; input?: unknown }
          if (typeof toolBlock.id === 'string' && typeof toolBlock.name === 'string') {
            toolUses.push({ id: toolBlock.id, name: toolBlock.name, input: toolBlock.input })
          }
        }
      }
      const answer = textParts.join('')
      const thinking = thinkingParts.join('').trim()
      const segments: string[] = []
      if (thinking.length > 0) segments.push(`> 💭 ${thinking.replace(/\n/g, '\n> ')}`)
      if (answer.length > 0) segments.push(answer)
      const text = segments.join('\n\n')
      let messageId: string | undefined
      if (text.length > 0) {
        const model = typeof api?.model === 'string' ? api.model : null
        messageId = threadStore.appendMessage(
          childThreadId,
          'assistant',
          text,
          model,
          null,
          timestamp,
        ).id
      }
      for (const toolUse of toolUses) {
        const record = threadStore.recordToolCall({
          threadId: childThreadId,
          messageId,
          toolName: toolUse.name,
          inputJson: safeStringify(toolUse.input),
          startedAt: timestamp,
        })
        threadStore.updateToolCall(record.id, { status: 'running' })
        pending.set(toolUse.id, record.id)
      }
    } else if (message.type === 'user') {
      const content = api?.content
      if (typeof content === 'string') {
        if (content.trim().length > 0) {
          threadStore.appendMessage(childThreadId, 'user', content, null, null, timestamp)
        }
        continue
      }
      const userTextParts: string[] = []
      for (const block of contentBlocks(message)) {
        if (block.type === 'tool_result') {
          const resultBlock = block as {
            tool_use_id?: unknown
            is_error?: unknown
            content?: unknown
          }
          const toolUseId = typeof resultBlock.tool_use_id === 'string' ? resultBlock.tool_use_id : null
          if (toolUseId === null) continue
          const recordId = pending.get(toolUseId)
          if (recordId === undefined) continue
          pending.delete(toolUseId)
          const isError = resultBlock.is_error === true
          const output = 'content' in resultBlock ? resultBlock.content : null
          threadStore.updateToolCall(recordId, {
            status: isError ? 'error' : 'success',
            outputJson: safeStringify(output),
            completedAt: timestamp ?? new Date().toISOString(),
          })
        } else if (block.type === 'text') {
          const text = (block as { text?: unknown }).text
          if (typeof text === 'string') userTextParts.push(text)
        }
      }
      const userText = userTextParts.join('').trim()
      if (userText.length > 0) {
        threadStore.appendMessage(childThreadId, 'user', userText, null, null, timestamp)
      }
    }
  }
  // A call the transcript never answered: the agent was cut off mid-call.
  for (const recordId of pending.values()) {
    threadStore.updateToolCall(recordId, { status: 'interrupted' })
  }
}

/** Mirror of the stream bridge's serializer, so backfilled payloads read
 *  byte-identically to streamed ones. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '"[unserializable]"'
  }
}
