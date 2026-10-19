import type { LoopQueueItem, TaskSummary } from '../../shared/ipc-contract'
import type { BoardCard, BoardQueueGroup } from './board-model'
import { cardChatContext, chatContextLabel, chatContextText } from './card-chat-context'

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    key: 'ledger::flow/loops/queue.jsonl#3',
    title: 'deleteTenant passes the external id into findChatsByTenant',
    origin: 'loop',
    lane: 'todo',
    taskId: null,
    itemId: '3',
    queueKey: 'ledger::flow/loops/queue.jsonl',
    loop: 'find',
    url: null,
    prUrl: null,
    attention: false,
    blockedReason: null,
    heldBy: null,
    missingReason: null,
    ageLabel: '6m ago',
    autoFix: false,
    threadStatus: null,
    backgroundTasks: 0,
    ...overrides,
  }
}

function group(): BoardQueueGroup {
  return {
    key: 'ledger::flow/loops/queue.jsonl',
    kind: 'ledger',
    location: 'flow/loops/queue.jsonl',
    label: 'This project · queue',
    loops: ['find', 'fix'],
    readable: true,
    reason: null,
    todo: [],
  }
}

function item(overrides: Partial<LoopQueueItem> = {}): LoopQueueItem {
  return {
    id: '3',
    loop: 'find',
    title: 'deleteTenant passes the external id',
    body: '<!-- loop: find -->\nThe query filters `Chat.tenantId`, the internal FK.',
    fingerprint: 'abc',
    state: 'open',
    labels: ['loop-find'],
    approved: true,
    createdAt: '2026-08-17T10:00:00.000Z',
    ...overrides,
  }
}

function task(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 't1',
    projectRoot: '/repo',
    title: 'Imported ticket',
    source: 'jira',
    externalKey: 'PRJ-14',
    externalUrl: null,
    lane: 'doing',
    suggestDone: false,
    threadId: null,
    originThreadId: null,
    description: 'The alias resolution diverges between auth.ts and mcpAuth.ts.',
    images: null,
    autoFix: false,
    prUrl: null,
    brief: null,
    briefStatus: 'idle',
    archivedAt: null,
    createdAt: '2026-08-17T10:00:00.000Z',
    updatedAt: '2026-08-17T10:00:00.000Z',
    ...overrides,
  }
}

describe('chatContextLabel', () => {
  it('names the list and the item, the way the ticket view does', () => {
    expect(chatContextLabel(card(), null, group())).toBe('This project · queue · #3')
  })

  it('prefers the tracker’s own key when the card has one', () => {
    expect(chatContextLabel(card({ itemId: null }), task(), group())).toBe(
      'This project · queue · PRJ-14',
    )
  })

  it('still has something to say for a card with neither', () => {
    expect(chatContextLabel(card({ itemId: null }), null, null)).toBe('Task')
  })
})

describe('chatContextText', () => {
  it('leads with the title, then the facts that change what to do', () => {
    const text = chatContextText(card({ url: 'https://example.test/3' }), item(), null, group())
    expect(text).toContain('# deleteTenant passes the external id into findChatsByTenant')
    expect(text).toContain('id: #3')
    expect(text).toContain('list: This project · queue')
    expect(text).toContain('loop: find')
    expect(text).toContain('state: todo')
    expect(text).toContain('link: https://example.test/3')
  })

  it('carries the body VERBATIM, markers stripped and nothing summarized', () => {
    const text = chatContextText(card(), item(), null, group())
    expect(text).toContain('The query filters `Chat.tenantId`, the internal FK.')
    expect(text).not.toContain('<!-- loop: find -->')
  })

  it('falls back to a local record’s description when there is no queue item', () => {
    const text = chatContextText(card({ taskId: 't1', itemId: null }), null, task(), null)
    expect(text).toContain('diverges between auth.ts and mcpAuth.ts')
  })

  it('says why a card is stuck, because that changes the answer', () => {
    const text = chatContextText(
      card({ lane: 'blocked', blockedReason: 'waiting for approval', heldBy: 'run-2' }),
      item(),
      null,
      group(),
    )
    expect(text).toContain('state: blocked')
    expect(text).toContain('blocked: waiting for approval')
    expect(text).toContain('held by: run-2')
  })
})

describe('cardChatContext', () => {
  it('is the terminal’s own payload shape, so it attaches beside one', () => {
    const context = cardChatContext(card(), item(), null, group())
    expect(context?.source).toBe('task')
    expect(context?.label).toBe('This project · queue · #3')
    expect(context?.text).toContain('# deleteTenant')
  })

  it('still attaches a bodyless card — the facts alone are worth having', () => {
    const context = cardChatContext(card({ title: 'x' }), null, null, null)
    expect(context).not.toBeNull()
    expect(context?.text).toContain('# x')
  })
})
