import type { PermissionRequest, UserQuestionRequest } from '../../shared/ipc-contract'
import { PendingCardQueue, QuestionQueue } from './question-queue'

const q = (requestId: string, threadId: string): UserQuestionRequest => ({
  requestId,
  threadId,
  questions: [{ question: 'Q?', header: 'H', multiSelect: false, options: [] }],
})

describe('QuestionQueue', () => {
  it('renders immediately when the thread is active and loaded', () => {
    const queue = new QuestionQueue()
    expect(queue.incoming(q('r1', 'A'), { activeThreadId: 'A', loading: false })).toEqual(q('r1', 'A'))
  })

  it('buffers a question for a non-active thread and surfaces it on flush', () => {
    const queue = new QuestionQueue()
    expect(queue.incoming(q('r1', 'A'), { activeThreadId: 'B', loading: false })).toBeNull()
    // Not the active thread → nothing flushes for B.
    expect(queue.flush('B')).toEqual([])
    // Returning to A renders the buffered question.
    expect(queue.flush('A')).toEqual([q('r1', 'A')])
  })

  it('buffers while the active thread is still loading (avoids the feed-reset wipe)', () => {
    const queue = new QuestionQueue()
    expect(queue.incoming(q('r1', 'A'), { activeThreadId: 'A', loading: true })).toBeNull()
    expect(queue.flush('A')).toEqual([q('r1', 'A')])
  })

  it('never double-renders the same request (dedup on requestId)', () => {
    const queue = new QuestionQueue()
    queue.incoming(q('r1', 'A'), { activeThreadId: 'A', loading: false })
    // A repeat delivery is dropped, and flush does not re-emit an active one.
    expect(queue.incoming(q('r1', 'A'), { activeThreadId: 'A', loading: false })).toBeNull()
    expect(queue.flush('A')).toEqual([])
  })

  it('does not buffer the same request twice', () => {
    const queue = new QuestionQueue()
    queue.incoming(q('r1', 'A'), { activeThreadId: 'B', loading: false })
    queue.incoming(q('r1', 'A'), { activeThreadId: 'B', loading: false })
    expect(queue.flush('A')).toEqual([q('r1', 'A')])
  })

  it('re-buffers an unanswered rendered question on clear, re-rendering on return', () => {
    const queue = new QuestionQueue()
    queue.incoming(q('r1', 'A'), { activeThreadId: 'A', loading: false }) // rendered on A
    queue.clearRendered() // user switches away from A — feed wiped
    expect(queue.flush('A')).toEqual([q('r1', 'A')]) // re-renders when A returns
  })

  it('does not re-render a question that was answered before the switch', () => {
    const queue = new QuestionQueue()
    queue.incoming(q('r1', 'A'), { activeThreadId: 'A', loading: false })
    queue.resolve('r1') // user answered it
    queue.clearRendered()
    expect(queue.flush('A')).toEqual([])
  })

  it('drops a buffered question once it is resolved elsewhere', () => {
    const queue = new QuestionQueue()
    queue.incoming(q('r1', 'A'), { activeThreadId: 'B', loading: false }) // buffered
    queue.resolve('r1') // session disposed / answered
    expect(queue.flush('A')).toEqual([])
  })

  it('keeps questions for different threads independent', () => {
    const queue = new QuestionQueue()
    queue.incoming(q('r1', 'A'), { activeThreadId: 'C', loading: false })
    queue.incoming(q('r2', 'B'), { activeThreadId: 'C', loading: false })
    expect(queue.flush('A')).toEqual([q('r1', 'A')])
    expect(queue.flush('B')).toEqual([q('r2', 'B')])
  })
})

// #949 — permission asks ride the same never-drop mechanism. The generic queue
// carries the invariant; this pins the permission-shaped instantiation.
describe('PendingCardQueue<PermissionRequest> (#949)', () => {
  const p = (requestId: string, threadId: string): PermissionRequest => ({
    requestId,
    threadId,
    toolName: 'Bash',
    summary: 'Run `npm test`',
    inputPreview: 'command: npm test',
  })

  it('buffers an ask for a background thread and flushes it when the thread opens', () => {
    const queue = new PendingCardQueue<PermissionRequest>()
    expect(queue.incoming(p('r1', 'A'), { activeThreadId: 'B', loading: false })).toBeNull()
    expect(queue.flush('A')).toEqual([p('r1', 'A')])
  })

  it('re-buffers an unanswered rendered ask across a thread switch', () => {
    const queue = new PendingCardQueue<PermissionRequest>()
    expect(queue.incoming(p('r1', 'A'), { activeThreadId: 'A', loading: false })).toEqual(
      p('r1', 'A'),
    )
    queue.clearRendered() // switch away — feed wiped
    expect(queue.flush('A')).toEqual([p('r1', 'A')]) // re-renders on return
  })

  it('never re-renders an answered ask, and dedupes a broker re-sync of a live one', () => {
    const queue = new PendingCardQueue<PermissionRequest>()
    queue.incoming(p('r1', 'A'), { activeThreadId: 'A', loading: false })
    // Broker re-sync delivers the same parked ask again (thread load) — dropped.
    expect(queue.incoming(p('r1', 'A'), { activeThreadId: 'A', loading: false })).toBeNull()
    queue.resolve('r1') // verdict delivered
    queue.clearRendered()
    expect(queue.flush('A')).toEqual([])
  })
})
