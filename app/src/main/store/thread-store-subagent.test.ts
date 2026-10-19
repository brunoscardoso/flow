// Sub-agent sub-chat storage tests (#1931) — real better-sqlite3, fresh temp DB.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from './db'
import { LATEST_SCHEMA_VERSION } from './migrations'
import { ThreadStore } from './thread-store'

describe('ThreadStore sub-agent transcripts (#1931)', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: ThreadStore
  let threadId: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-subagent-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
    threadId = store.createThread({ projectRoot: '/tmp/project' }).id
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('migration v36 is applied (parent_tool_call_id round-trips)', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(36)
    const task = store.recordToolCall({ threadId, toolName: 'Agent' })
    const sub = store.recordToolCall({ threadId, toolName: 'Grep', parentToolCallId: task.id })
    expect(sub.parentToolCallId).toBe(task.id)
  })

  it('main-thread reads exclude sub-agent rows; parent-scoped reads return them', () => {
    const task = store.recordToolCall({ threadId, toolName: 'Agent' })
    store.appendMessage(threadId, 'assistant', 'main text')
    store.appendMessage(threadId, 'assistant', 'sub text', null, task.id)
    store.recordToolCall({ threadId, toolName: 'Grep', parentToolCallId: task.id })

    // Main thread sees only its own rows (NFR-1 — unchanged by sub-agent rows).
    expect(store.listMessages(threadId).map((m) => m.content)).toEqual(['main text'])
    expect(store.listToolCalls(threadId).map((t) => t.toolName)).toEqual(['Agent'])
    expect(store.countMessages(threadId)).toBe(1)
    expect(store.countToolCalls(threadId)).toBe(1)

    // The sub-agent transcript, keyed by the parent Task id.
    expect(store.listSubagentMessages(threadId, task.id).map((m) => m.content)).toEqual(['sub text'])
    expect(store.listSubagentToolCalls(threadId, task.id).map((t) => t.toolName)).toEqual(['Grep'])
  })

  it('getToolCall still fetches a sub-agent tool call by id (for the tab)', () => {
    const task = store.recordToolCall({ threadId, toolName: 'Agent' })
    const sub = store.recordToolCall({ threadId, toolName: 'Grep', parentToolCallId: task.id })
    expect(store.getToolCall(threadId, sub.id)?.parentToolCallId).toBe(task.id)
  })

  it('a thread with no sub-agents has empty sub-agent reads', () => {
    const task = store.recordToolCall({ threadId, toolName: 'Agent' })
    expect(store.listSubagentMessages(threadId, task.id)).toEqual([])
    expect(store.listSubagentToolCalls(threadId, task.id)).toEqual([])
  })

  it('promotedChildId answers the spawn → child question (the live layer asks it per message)', () => {
    const task = store.recordToolCall({ threadId, toolName: 'Agent' })
    // Unpromoted: no child, no live targeting.
    expect(store.promotedChildId(threadId, task.id)).toBeNull()
    const child = store.openSubagentThread(threadId, task.id)
    expect(store.promotedChildId(threadId, task.id)).toBe(child.id)
    // Same code path as redirect-at-write: an archived child asked about by
    // live traffic is proof-of-life unarchived.
    store.updateThread(child.id, { archived: true })
    expect(store.promotedChildId(threadId, task.id)).toBe(child.id)
    expect(store.getThread(child.id)?.archivedAt ?? null).toBeNull()
  })
})
