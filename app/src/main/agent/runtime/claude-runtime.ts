// The Claude runtime adapter (multi_runtime_support, Phase 2, Task 2.2).
//
// The first `AgentRuntime` implementation: it wraps the Claude Agent SDK's
// `query()` lifecycle — the machinery agent-manager has run inline since the
// start — behind the one seam every provider implements. This is the EXTRACTION
// step, not the rewire: it lifts the session spine (build SDK options → drive
// the query → surface the session id → send/setModel/dispose) and the
// containment bridge (RuntimeToolVerdict → SDK PermissionResult) into a unit
// the coordinator can hold by interface. agent-manager keeps running its own
// wiring until Task 2.3 swaps it onto this class.
//
// Two things stay INJECTED rather than owned here, on purpose:
//   • `translate` — the SDKMessage → AgentStreamEvent mapping lives in
//     StreamBridge, which is thread-store-coupled and the coordinator's to own.
//     The runtime reuses it (at wire-up agent-manager passes
//     `(m) => bridge.handleMessage(m)`) instead of forking that translation.
//   • `providerOptions` — the coordinator-owned SDK options the runtime has no
//     business assembling (containment PreToolUse hooks, PostToolUse
//     edit-tracking, dialogs, account env, cli-shim PATH). Merged over the base.
// Keeping both as seams is what lets this file be exercised with a mock SDK and
// no Electron/app graph.

import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

import type { AgentStreamEvent } from '../../../shared/ipc-contract'
import type {
  AgentRuntime,
  RuntimeCallbacks,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeStartOptions,
} from './agent-runtime'
import { AsyncMessageQueue } from './message-queue'

/** Injectable SDK `query()` — the exact shape agent-manager uses; tests pass a
 *  mock that returns a scripted async stream. */
export type ClaudeQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options?: Options
}) => Query

/**
 * Translate ONE SDK message into normalized events. Injected so the runtime
 * REUSES the coordinator's canonical StreamBridge translation instead of
 * forking it — the runtime owns lifecycle + containment, not transcript shape.
 */
export type ClaudeMessageTranslator = (
  message: SDKMessage,
  emit: (event: AgentStreamEvent) => void,
  onSessionId: (sessionId: string) => void,
) => void

/**
 * Coordinator-owned SDK options the runtime does not itself assemble
 * (containment hooks, edit-tracking, dialogs, account env, cli-shim PATH).
 * Merged OVER the base options this runtime builds, so agent-manager supplies
 * the real ones at wire-up (Task 2.3) without the runtime importing the app.
 */
export type ClaudeProviderOptions = (options: RuntimeStartOptions) => Partial<Options>

export interface ClaudeRuntimeDeps {
  queryFn: ClaudeQueryFn
  translate: ClaudeMessageTranslator
  providerOptions?: ClaudeProviderOptions
}

/**
 * Claude's declared capabilities. Containment is NATIVE (the SDK's `canUseTool`
 * approval channel + PreToolUse containment hooks), which satisfies the
 * admission gate; every productivity capability is present, so no feature has
 * to degrade for Claude.
 */
export const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  driveHeadless: true,
  parseableStream: true,
  resumeHandle: true,
  containment: 'native',
  toolApproval: 'per-tool',
  toolEvents: true,
  subAgents: 'native',
  modelSelection: true,
}

/** The first user turn (and every follow-up) as the SDK's user-message shape —
 *  identical to the literal agent-manager pushes today. */
function userMessage(content: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  } as SDKUserMessage
}

/**
 * The SDK wants an `AbortController`; the interface hands us an `AbortSignal`
 * the coordinator owns. Forward the external signal into a controller the SDK
 * (and dispose) can abort — pre-aborted signals abort immediately.
 */
function linkedAbortController(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) {
    controller.abort()
  } else {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller
}

export class ClaudeRuntime implements AgentRuntime {
  readonly id = 'claude'
  readonly capabilities = CLAUDE_CAPABILITIES

  constructor(private readonly deps: ClaudeRuntimeDeps) {}

  start(options: RuntimeStartOptions, callbacks: RuntimeCallbacks): RuntimeSession {
    const input = new AsyncMessageQueue()
    // Seed the first user turn — the SDK pulls it as the opening prompt.
    input.push(userMessage(options.prompt))

    const abortController = linkedAbortController(options.abortSignal)

    const baseOptions: Options = {
      cwd: options.cwd,
      includePartialMessages: true,
      // #1931: forward a sub-agent's full text/thinking so the Background-activity
      // sub-chat can render it (default forwards only tool use/results).
      forwardSubagentText: true,
      permissionMode: 'default',
      abortController,
      // additionalDirectories is omitted when empty so a single-root session is
      // byte-identical to agent-manager's default.
      ...(options.additionalRoots.length > 0
        ? { additionalDirectories: [...options.additionalRoots] }
        : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      // A resume target restores a prior SDK session; null/undefined = fresh.
      ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
      ...(callbacks.canUseTool
        ? { canUseTool: this.bridgeCanUseTool(callbacks.canUseTool) }
        : {}),
    }
    // Coordinator options win on conflict — they carry the containment hooks and
    // account env the runtime deliberately does not own.
    const sdkOptions: Options = this.deps.providerOptions
      ? { ...baseOptions, ...this.deps.providerOptions(options) }
      : baseOptions

    const query = this.deps.queryFn({ prompt: input, options: sdkOptions })

    let sessionId: string | null = null
    const onSessionId = (id: string): void => {
      if (sessionId === id) return
      sessionId = id
      callbacks.onSessionId(id)
    }

    // Consume the stream in the background: one translate() per SDK message,
    // then signal completion once (headless one-shot callers await this).
    void this.consume(query, callbacks.onEvent, onSessionId, callbacks.onDone)

    let disposed = false
    return {
      get sessionId(): string | null {
        return sessionId
      },
      send: (text: string): void => {
        input.push(userMessage(text))
      },
      setModel: (model: string): void => {
        // Fire-and-forget: the interface's setModel is synchronous; the SDK's
        // returns a promise we do not need to await here.
        void query.setModel(model)
      },
      interrupt: (): void => {
        // Stop the in-flight turn; the session stays open for the next send.
        void query.interrupt()
      },
      dispose: (): void => {
        // Safe to call twice (interface contract): guard the underlying teardown.
        if (disposed) return
        disposed = true
        input.end()
        abortController.abort()
        try {
          query.close()
        } catch {
          // A close after abort/end can throw on an already-torn stream; dispose
          // must not surface that.
        }
      },
    }
  }

  private async consume(
    query: Query,
    emit: (event: AgentStreamEvent) => void,
    onSessionId: (id: string) => void,
    onDone?: () => void,
  ): Promise<void> {
    try {
      for await (const message of query) {
        this.deps.translate(message, emit, onSessionId)
      }
    } catch {
      // Stream lifecycle errors (abort, stale resume) are the coordinator's to
      // classify at wire-up via the translated events; the loop itself must
      // never throw into the unhandled-rejection path.
    } finally {
      // Signal completion exactly once whether the stream ended cleanly or the
      // loop caught — a headless caller awaiting onDone must never hang.
      onDone?.()
    }
  }

  /**
   * Bridge a RuntimeToolVerdict-returning approval callback to the SDK's
   * `CanUseTool`. The critical invariant (allowed-pattern #10): an `allow`
   * result MUST carry `updatedInput` — the SDK Zod-validates the union and
   * fails the tool call on a missing one — so we echo the original input when
   * the verdict supplies no rewrite.
   */
  private bridgeCanUseTool(
    approve: NonNullable<RuntimeCallbacks['canUseTool']>,
  ): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      const verdict = await approve(toolName, input)
      if (verdict.behavior === 'allow') {
        const updatedInput = (verdict.updatedInput ?? input) as Record<string, unknown>
        return {
          behavior: 'allow',
          updatedInput,
          ...(options.toolUseID ? { toolUseID: options.toolUseID } : {}),
        }
      }
      return { behavior: 'deny', message: verdict.message }
    }
  }
}
