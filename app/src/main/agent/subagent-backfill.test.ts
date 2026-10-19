// Transcript backfill for promoted sub-agent child threads (#1931).
//
// The SDK readers are injected as a fake store of SessionMessage-shaped
// entries whose shapes were pinned against the LIVE SDK (0.3.204) over real
// session storage (2026-10-07):
//   - every sub-agent message carries `parent_tool_use_id` = the spawn's
//     tool_use id (from the transcript's .meta.json)
//   - the sub-agent's own opening user prompt is NOT returned (an attachment
//     entry breaks the SDK's parentUuid chain walk in every observed
//     transcript), so transcripts here start with assistant messages
//   - assistant content blocks arrive one per SDK message (thinking, text and
//     tool_use as separate entries), tool results as user messages with
//     tool_result blocks

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from '../store/db'
import { ThreadStore } from '../store/thread-store'
import {
  makeSubagentBackfill,
  type BackfillSdk,
  type SessionMessageLike,
} from './subagent-backfill'

const ROOT = '/tmp/project-backfill'
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const SPAWN_PROMPT = 'Research the latest AI and technical news and write a roundup.'
const SPAWN_DESCRIPTION = 'AI research/technical news roundup'

/** One assistant SessionMessage with the given content blocks. */
function assistantMessage(
  blocks: unknown[],
  options: { timestamp?: string; model?: string } = {},
): SessionMessageLike {
  return {
    type: 'assistant',
    parent_tool_use_id: 'toolu_spawn_01',
    timestamp: options.timestamp ?? '2026-10-01T10:00:00.000Z',
    message: { role: 'assistant', model: options.model ?? 'claude-opus-5', content: blocks },
  }
}

/** One user SessionMessage (tool results arrive this way). */
function userMessage(content: unknown, timestamp = '2026-10-01T10:00:05.000Z'): SessionMessageLike {
  return {
    type: 'user',
    parent_tool_use_id: 'toolu_spawn_01',
    timestamp,
    message: { role: 'user', content },
  }
}

/** A realistic transcript: thinking → text → tool_use → tool_result → answer. */
function sampleTranscript(): SessionMessageLike[] {
  return [
    assistantMessage([{ type: 'thinking', thinking: 'what sources to check' }], {
      timestamp: '2026-10-01T10:00:01.000Z',
    }),
    assistantMessage([{ type: 'text', text: 'Searching for news.' }], {
      timestamp: '2026-10-01T10:00:02.000Z',
    }),
    assistantMessage(
      [{ type: 'tool_use', id: 'toolu_inner_1', name: 'WebSearch', input: { query: 'ai news' } }],
      { timestamp: '2026-10-01T10:00:03.000Z' },
    ),
    userMessage(
      [{ type: 'tool_result', tool_use_id: 'toolu_inner_1', is_error: false, content: '3 results' }],
      '2026-10-01T10:00:04.000Z',
    ),
    assistantMessage([{ type: 'text', text: 'Here is the roundup.' }], {
      timestamp: '2026-10-01T10:00:05.000Z',
    }),
  ]
}

/** A fake SDK over `agents`: agentId → its transcript. `parentMessages` is the
 *  parent session transcript (for spawn tool_use_id recovery). Records calls. */
function fakeSdk(
  agents: Record<string, SessionMessageLike[]>,
  parentMessages: SessionMessageLike[] = [],
): BackfillSdk & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    listSubagents: async (sessionId) => {
      calls.push(`listSubagents:${sessionId}`)
      return Object.keys(agents)
    },
    getSubagentMessages: async (_sessionId, agentId, options) => {
      calls.push(`getSubagentMessages:${agentId}:${options?.limit ?? 'all'}`)
      const messages = agents[agentId] ?? []
      return options?.limit !== undefined ? messages.slice(0, options.limit) : messages
    },
    getSessionMessages: async (sessionId) => {
      calls.push(`getSessionMessages:${sessionId}`)
      return parentMessages
    },
  }
}

/** The parent transcript's Task spawn block carrying the spawn's tool_use id. */
function parentSpawnMessage(
  toolUseId: string,
  prompt = SPAWN_PROMPT,
  description = SPAWN_DESCRIPTION,
): SessionMessageLike {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    timestamp: '2026-10-01T09:59:59.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description, prompt } }],
    },
  }
}

describe('sub-agent transcript backfill (#1931)', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: ThreadStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-subagent-backfill-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  /** A parent with an SDK session and a finished spawn, promoted to an EMPTY
   *  child (nothing was captured while it streamed — the backfill case). */
  function seedPromotedEmptyChild(options: { agentId?: string; sessionId?: string | null } = {}): {
    parentId: string
    spawnId: string
    childId: string
  } {
    const parent = store.createThread({ projectRoot: ROOT, title: 'Main' })
    if (options.sessionId !== null) {
      store.setSdkSessionId(parent.id, options.sessionId ?? SESSION_ID)
    }
    const spawn = store.recordToolCall({
      threadId: parent.id,
      toolName: 'Agent',
      inputJson: JSON.stringify({
        description: SPAWN_DESCRIPTION,
        subagent_type: 'general-purpose',
        prompt: SPAWN_PROMPT,
      }),
    })
    store.updateToolCall(spawn.id, { status: 'success', outputJson: '"done"' })
    if (options.agentId !== undefined) {
      store.setToolCallAgentId(spawn.id, options.agentId)
    }
    const child = store.openSubagentThread(parent.id, spawn.id)
    return { parentId: parent.id, spawnId: spawn.id, childId: child.id }
  }

  it('materializes an empty child from the stored agent id — messages, thinking and tools in order', async () => {
    const { childId } = seedPromotedEmptyChild({ agentId: 'a573b486cc4d5da20' })
    const sdk = fakeSdk({ a573b486cc4d5da20: sampleTranscript() })
    const backfill = makeSubagentBackfill({ threadStore: store, sdk })

    const result = await backfill(childId)
    expect(result.filled).toBe(true)

    const messages = store.listMessages(childId)
    expect(messages.map((message) => message.content)).toEqual([
      '> 💭 what sources to check',
      'Searching for news.',
      'Here is the roundup.',
    ])
    expect(messages.every((message) => message.role === 'assistant')).toBe(true)
    expect(messages[0]?.model).toBe('claude-opus-5')
    // Rows keep their SDK session-storage timestamps (original order).
    expect(messages[0]?.createdAt).toBe('2026-10-01T10:00:01.000Z')

    const toolCalls = store.listToolCalls(childId)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]?.toolName).toBe('WebSearch')
    expect(toolCalls[0]?.inputJson).toBe(JSON.stringify({ query: 'ai news' }))
    expect(toolCalls[0]?.status).toBe('success')
    expect(toolCalls[0]?.outputJson).toBe(JSON.stringify('3 results'))
    expect(toolCalls[0]?.completedAt).toBe('2026-10-01T10:00:04.000Z')
    // Untagged, like a re-homed row — the child owns it outright.
    expect(toolCalls[0]?.parentToolCallId).toBeNull()
  })

  it('finalizes an error tool_result as error, and an unanswered tool_use as interrupted', async () => {
    const { childId } = seedPromotedEmptyChild({ agentId: 'agent-x' })
    const transcript: SessionMessageLike[] = [
      assistantMessage([
        { type: 'tool_use', id: 'toolu_bad', name: 'Bash', input: { command: 'false' } },
        { type: 'tool_use', id: 'toolu_lost', name: 'Read', input: { file_path: '/x' } },
      ]),
      userMessage([
        { type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true, content: 'exit 1' },
      ]),
    ]
    const sdk = fakeSdk({ 'agent-x': transcript })
    const backfill = makeSubagentBackfill({ threadStore: store, sdk })
    await backfill(childId)

    const byName = new Map(store.listToolCalls(childId).map((call) => [call.toolName, call]))
    expect(byName.get('Bash')?.status).toBe('error')
    expect(byName.get('Bash')?.outputJson).toBe(JSON.stringify('exit 1'))
    expect(byName.get('Read')?.status).toBe('interrupted')
  })

  it('keeps a user message of the transcript as the child’s own user row', async () => {
    const { childId } = seedPromotedEmptyChild({ agentId: 'agent-x' })
    const sdk = fakeSdk({
      'agent-x': [
        userMessage('Look deeper into the second item.', '2026-10-01T10:00:00.500Z'),
        assistantMessage([{ type: 'text', text: 'On it.' }], {
          timestamp: '2026-10-01T10:00:01.000Z',
        }),
      ],
    })
    await makeSubagentBackfill({ threadStore: store, sdk })(childId)
    const messages = store.listMessages(childId)
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Look deeper into the second item.'],
      ['assistant', 'On it.'],
    ])
  })

  it('is a no-op on a NON-empty child — the re-home path already populated it', async () => {
    const { childId } = seedPromotedEmptyChild({ agentId: 'agent-x' })
    store.appendMessage(childId, 'assistant', 'already re-homed')
    const sdk = fakeSdk({ 'agent-x': sampleTranscript() })

    const result = await makeSubagentBackfill({ threadStore: store, sdk })(childId)
    expect(result.filled).toBe(false)
    expect(sdk.calls).toEqual([]) // never even reached the SDK
    expect(store.listMessages(childId)).toHaveLength(1)
  })

  it('is a no-op without throwing when the parent has no SDK session', async () => {
    const { childId } = seedPromotedEmptyChild({ sessionId: null })
    const sdk = fakeSdk({ 'agent-x': sampleTranscript() })
    const result = await makeSubagentBackfill({ threadStore: store, sdk })(childId)
    expect(result.filled).toBe(false)
    expect(store.listMessages(childId)).toHaveLength(0)
  })

  it('survives the SDK throwing — one result, empty child, no crash', async () => {
    const { childId } = seedPromotedEmptyChild()
    const sdk: BackfillSdk = {
      listSubagents: async () => {
        throw new Error('session storage unreadable')
      },
      getSubagentMessages: async () => {
        throw new Error('session storage unreadable')
      },
      getSessionMessages: async () => {
        throw new Error('session storage unreadable')
      },
    }
    const result = await makeSubagentBackfill({ threadStore: store, sdk })(childId)
    expect(result.filled).toBe(false)
    expect(store.listMessages(childId)).toHaveLength(0)
    expect(store.listToolCalls(childId)).toHaveLength(0)
  })

  it('resolves a HISTORICAL run (no stored agent id) via the parent transcript’s spawn tool_use id', async () => {
    const { childId } = seedPromotedEmptyChild() // no agentId stored
    // Two agents; only agent-b's messages carry the spawn's tool_use id. The
    // transcripts (like every real one observed) do NOT start with the prompt.
    const otherTranscript = [
      { ...assistantMessage([{ type: 'text', text: 'unrelated work' }]), parent_tool_use_id: 'toolu_other' },
    ]
    const sdk = fakeSdk(
      { 'agent-a': otherTranscript, 'agent-b': sampleTranscript() },
      [parentSpawnMessage('toolu_other', 'different prompt', 'other task'), parentSpawnMessage('toolu_spawn_01')],
    )
    const result = await makeSubagentBackfill({ threadStore: store, sdk })(childId)
    expect(result.filled).toBe(true)
    expect(store.listMessages(childId).map((message) => message.content)).toContain(
      'Here is the roundup.',
    )
    expect(store.listMessages(childId).map((message) => message.content)).not.toContain(
      'unrelated work',
    )
  })

  it('picks NONE when two spawns in the parent transcript carry the same prompt (ambiguous)', async () => {
    const { childId } = seedPromotedEmptyChild()
    const sdk = fakeSdk(
      { 'agent-a': sampleTranscript(), 'agent-b': sampleTranscript() },
      [parentSpawnMessage('toolu_spawn_01'), parentSpawnMessage('toolu_spawn_02')],
    )
    const result = await makeSubagentBackfill({ threadStore: store, sdk })(childId)
    expect(result.filled).toBe(false)
    expect(store.listMessages(childId)).toHaveLength(0)
  })

  it('picks NONE when the session has no sub-agents at all', async () => {
    const { childId } = seedPromotedEmptyChild()
    const sdk = fakeSdk({}, [parentSpawnMessage('toolu_spawn_01')])
    const result = await makeSubagentBackfill({ threadStore: store, sdk })(childId)
    expect(result.filled).toBe(false)
  })

  it('falls back to opening-prompt matching when the parent transcript lost the spawn (compaction)', async () => {
    const { childId } = seedPromotedEmptyChild()
    // The rare transcript whose prompt DID survive the SDK's chain walk.
    const withPrompt: SessionMessageLike[] = [
      userMessage(SPAWN_PROMPT, '2026-10-01T10:00:00.000Z'),
      assistantMessage([{ type: 'text', text: 'Prompt-matched findings.' }]),
    ]
    const sdk = fakeSdk({ 'agent-a': withPrompt }, [] /* parent transcript compacted away */)
    const result = await makeSubagentBackfill({ threadStore: store, sdk })(childId)
    expect(result.filled).toBe(true)
    expect(store.listMessages(childId).map((message) => message.content)).toContain(
      'Prompt-matched findings.',
    )
  })

  it('a stored agent id whose transcript is GONE falls through to matching', async () => {
    const { childId } = seedPromotedEmptyChild({ agentId: 'agent-vanished' })
    const sdk = fakeSdk({ 'agent-b': sampleTranscript() }, [parentSpawnMessage('toolu_spawn_01')])
    const result = await makeSubagentBackfill({ threadStore: store, sdk })(childId)
    expect(result.filled).toBe(true)
    expect(store.listToolCalls(childId)).toHaveLength(1)
  })

  it('backfill then promotion re-open stays idempotent — second call is a no-op', async () => {
    const { parentId, spawnId, childId } = seedPromotedEmptyChild({ agentId: 'agent-x' })
    const sdk = fakeSdk({ 'agent-x': sampleTranscript() })
    const backfill = makeSubagentBackfill({ threadStore: store, sdk })
    await backfill(childId)
    const after = store.listMessages(childId).length

    // Re-open (idempotent promotion) + second backfill: nothing doubles.
    const again = store.openSubagentThread(parentId, spawnId)
    expect(again.id).toBe(childId)
    const result = await backfill(childId)
    expect(result.filled).toBe(false)
    expect(store.listMessages(childId)).toHaveLength(after)
  })

  it('migration v38 round-trips agent_id, write-once', () => {
    const parent = store.createThread({ projectRoot: ROOT, title: 'Main' })
    const spawn = store.recordToolCall({ threadId: parent.id, toolName: 'Agent' })
    expect(store.getToolCall(parent.id, spawn.id)?.agentId).toBeNull()

    store.setToolCallAgentId(spawn.id, 'a111')
    expect(store.getToolCall(parent.id, spawn.id)?.agentId).toBe('a111')

    // Write-once: the runtime repeats the id on every progress tick.
    store.setToolCallAgentId(spawn.id, 'a222')
    expect(store.getToolCall(parent.id, spawn.id)?.agentId).toBe('a111')

    // Unknown record: a silent no-op, not an error.
    expect(() => store.setToolCallAgentId('missing', 'a333')).not.toThrow()
  })
})
