// Promotion of a sub-agent (a parent Task tool-call) into a real, navigable
// CHILD thread, and the hierarchy/filter rules that keep children nested rather
// than loose in the top-level list (#1931).

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from './db'
import { THREAD_STORE_CHANGE_EVENT, ThreadStore, type ThreadChangeEvent } from './thread-store'

const ROOT_A = '/tmp/project-a'

describe('sub-agent child threads (#1931)', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: ThreadStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-subagent-threads-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  /** A parent thread with one Task tool-call that spawned a sub-agent, plus the
   *  sub-agent's own inner rows tagged with the Task tool-call id. Returns the
   *  parent thread and the spawn tool-call id. */
  function seedParentWithSubagent(description = 'Fetch AI news'): {
    parentId: string
    toolCallId: string
  } {
    const parent = store.createThread({ projectRoot: ROOT_A, title: 'Main' })
    const spawn = store.recordToolCall({
      threadId: parent.id,
      toolName: 'Agent',
      inputJson: JSON.stringify({ description, subagent_type: 'general-purpose', prompt: 'go' }),
    })
    // The sub-agent's inner execution, tagged as belonging to the spawn.
    store.appendMessage(parent.id, 'assistant', 'thinking about news', null, spawn.id)
    store.recordToolCall({
      threadId: parent.id,
      toolName: 'WebSearch',
      inputJson: JSON.stringify({ query: 'ai news' }),
      parentToolCallId: spawn.id,
    })
    return { parentId: parent.id, toolCallId: spawn.id }
  }

  it('promotes a sub-agent into a titled child carrying parent + origin', () => {
    const { parentId, toolCallId } = seedParentWithSubagent()
    const child = store.openSubagentThread(parentId, toolCallId)

    expect(child.parentThreadId).toBe(parentId)
    expect(child.originToolCallId).toBe(toolCallId)
    expect(child.title).toBe('Fetch AI news')
    expect(child.projectRoot).toBe(ROOT_A)
  })

  it('is idempotent — a second open returns the same child', () => {
    const { parentId, toolCallId } = seedParentWithSubagent()
    const first = store.openSubagentThread(parentId, toolCallId)
    const second = store.openSubagentThread(parentId, toolCallId)
    expect(second.id).toBe(first.id)
    expect(store.listChildThreads(parentId)).toHaveLength(1)
  })

  it('re-homes the sub-agent rows into the child', () => {
    const { parentId, toolCallId } = seedParentWithSubagent()
    const child = store.openSubagentThread(parentId, toolCallId)

    // The sub-agent message now reads as the child's own history (tag cleared).
    const childMessages = store.listMessages(child.id)
    expect(childMessages.some((m) => m.content === 'thinking about news')).toBe(true)
    // ...and is no longer a sub-agent message hanging off the parent's tool-call.
    expect(store.listSubagentMessages(parentId, toolCallId)).toHaveLength(0)
  })

  it('keeps children out of the top-level list unless asked', () => {
    const { parentId, toolCallId } = seedParentWithSubagent()
    store.openSubagentThread(parentId, toolCallId)

    const topLevel = store.listThreads(undefined, {})
    expect(topLevel.map((t) => t.id)).toContain(parentId)
    expect(topLevel.every((t) => t.parentThreadId == null)).toBe(true)

    const withChildren = store.listThreads(undefined, { includeChildren: true })
    expect(withChildren.some((t) => t.parentThreadId === parentId)).toBe(true)
  })

  it('lists a parent’s children newest-first', () => {
    const { parentId, toolCallId } = seedParentWithSubagent()
    const child = store.openSubagentThread(parentId, toolCallId)
    const children = store.listChildThreads(parentId)
    expect(children).toHaveLength(1)
    expect(children[0]?.id).toBe(child.id)
  })

  it('homes rows written AFTER promotion straight into the child, with the child’s events (#1931 D-4)', () => {
    // The live-update path: the origin session keeps streaming sub-agent rows
    // while the user reads the promoted child. They must land in the CHILD —
    // untagged, exactly as a re-home leaves them — and the change events must
    // carry the child's id, because that is what the child's pane listens for.
    const { parentId, toolCallId } = seedParentWithSubagent()
    const child = store.openSubagentThread(parentId, toolCallId)

    const events: Array<{ entity: string; threadId: string }> = []
    store.on(THREAD_STORE_CHANGE_EVENT, (event: ThreadChangeEvent) =>
      events.push({ entity: event.entity, threadId: event.threadId }),
    )

    const message = store.appendMessage(parentId, 'assistant', 'streamed live', null, toolCallId)
    const call = store.recordToolCall({
      threadId: parentId,
      toolName: 'Read',
      inputJson: JSON.stringify({ file_path: '/x' }),
      parentToolCallId: toolCallId,
    })

    expect(message.threadId).toBe(child.id)
    expect(message.parentToolCallId).toBeNull()
    expect(call.threadId).toBe(child.id)
    expect(call.parentToolCallId).toBeNull()
    expect(store.listMessages(child.id).some((m) => m.content === 'streamed live')).toBe(true)
    expect(store.listToolCalls(child.id).some((c) => c.id === call.id)).toBe(true)
    // Nothing stayed behind tagged on the parent…
    expect(store.listSubagentMessages(parentId, toolCallId)).toHaveLength(0)
    // …and every event named the child, not the parent.
    expect(events).toEqual([
      { entity: 'message', threadId: child.id },
      { entity: 'tool_call', threadId: child.id },
    ])
  })

  it('unarchives an archived child when a redirected row arrives — proof of life', () => {
    // Archiving a promoted child while its origin still streams would strand
    // the redirected rows in a thread no list shows. A redirect-at-write into
    // an archived child clears archived_at and emits the thread event the
    // sidebar re-shows it on (the same event updateThread's archive toggle emits).
    const { parentId, toolCallId } = seedParentWithSubagent()
    const child = store.openSubagentThread(parentId, toolCallId)
    store.updateThread(child.id, { archived: true })
    expect(store.getThread(child.id)?.archivedAt).not.toBeNull()

    const events: ThreadChangeEvent[] = []
    store.on(THREAD_STORE_CHANGE_EVENT, (event: ThreadChangeEvent) => events.push(event))

    const message = store.appendMessage(parentId, 'assistant', 'still alive', null, toolCallId)

    // The row landed in the child…
    expect(message.threadId).toBe(child.id)
    expect(store.listMessages(child.id).some((m) => m.content === 'still alive')).toBe(true)
    // …which is unarchived again and announced, so the sidebar re-shows it.
    expect(store.getThread(child.id)?.archivedAt).toBeNull()
    expect(store.listChildThreads(parentId).map((t) => t.id)).toContain(child.id)
    expect(events).toContainEqual(
      expect.objectContaining({ entity: 'thread', action: 'updated', threadId: child.id }),
    )
  })

  it('getToolCallById finds a re-homed row the parent-keyed read cannot (#1931)', () => {
    // The bridge finalizes a sub-agent tool call by record id while holding the
    // PARENT's thread id — after promotion the row lives in the child, so the
    // completion path reads by id alone.
    const { parentId, toolCallId } = seedParentWithSubagent()
    const child = store.openSubagentThread(parentId, toolCallId)
    const call = store.recordToolCall({
      threadId: parentId,
      toolName: 'Read',
      parentToolCallId: toolCallId,
    })
    expect(store.getToolCall(parentId, call.id)).toBeNull()
    expect(store.getToolCallById(call.id)?.threadId).toBe(child.id)
  })

  it('leaves an unpromoted sub-agent’s rows tagged on the parent (unchanged path)', () => {
    const { parentId, toolCallId } = seedParentWithSubagent()
    // No promotion. A late row stays on the parent, tagged.
    const message = store.appendMessage(parentId, 'assistant', 'still inline', null, toolCallId)
    expect(message.threadId).toBe(parentId)
    expect(message.parentToolCallId).toBe(toolCallId)
    expect(
      store.listSubagentMessages(parentId, toolCallId).some((m) => m.content === 'still inline'),
    ).toBe(true)
  })

  it('falls back to the subagent_type when the Task has no description', () => {
    const parent = store.createThread({ projectRoot: ROOT_A, title: 'Main' })
    const spawn = store.recordToolCall({
      threadId: parent.id,
      toolName: 'Agent',
      inputJson: JSON.stringify({ subagent_type: 'code-reviewer', prompt: 'review' }),
    })
    const child = store.openSubagentThread(parent.id, spawn.id)
    expect(child.title).toBe('code-reviewer')
  })

  it('throws when the parent thread does not exist', () => {
    expect(() => store.openSubagentThread('nope', 'nah')).toThrow(/unknown parent/)
  })
})
