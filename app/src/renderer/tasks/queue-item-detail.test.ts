import type { LoopQueueItem } from '../../shared/ipc-contract'
import type { BoardCard, BoardQueueGroup } from './board-model'
import {
  buildQueueItemDetail,
  queueItemMenuEntries,
  readableBody,
  readableLabels,
} from './queue-item-detail'

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    key: 'github::acme/widgets#3',
    title: 'deleteTenant passes the external id into findChatsByTenant',
    origin: 'loop',
    lane: 'todo',
    taskId: null,
    itemId: '3',
    queueKey: 'github::acme/widgets',
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

function group(overrides: Partial<BoardQueueGroup> = {}): BoardQueueGroup {
  return {
    key: 'ledger::flow/loops/queue.jsonl',
    kind: 'ledger',
    location: 'flow/loops/queue.jsonl',
    label: 'This project · queue',
    loops: ['find', 'fix'],
    readable: true,
    reason: null,
    todo: [],
    ...overrides,
  }
}

function item(overrides: Partial<LoopQueueItem> = {}): LoopQueueItem {
  return {
    id: '3',
    loop: 'find',
    title: 'deleteTenant passes the external id into findChatsByTenant',
    body: '<!-- loop: find -->\n<!-- fingerprint: abc123 -->\n\nThe query filters `Chat.tenantId`.',
    fingerprint: 'abc123',
    state: 'open',
    labels: ['loop-find', 'bug'],
    approved: true,
    createdAt: '2026-08-17T10:00:00.000Z',
    ...overrides,
  }
}

describe('readableBody', () => {
  it('strips the markers the loops write to each other', () => {
    expect(readableBody(item().body)).toBe('The query filters `Chat.tenantId`.')
  })

  it('is null for an item whose body is only markers, or missing', () => {
    expect(readableBody('<!-- loop: find -->\n')).toBeNull()
    expect(readableBody(undefined)).toBeNull()
    expect(readableBody('   ')).toBeNull()
  })
})

describe('readableLabels', () => {
  it('drops the bookkeeping the card already says, keeps the rest', () => {
    expect(readableLabels(['loop-find', 'bug', 'claimed', 'tenancy'])).toEqual(['bug', 'tenancy'])
  })

  it('answers for an item the read never labelled', () => {
    expect(readableLabels(undefined)).toEqual([])
  })
})

describe('buildQueueItemDetail', () => {
  it('names the list and the item on it', () => {
    const detail = buildQueueItemDetail(card(), item(), group())
    expect(detail.subtitle).toBe('This project · queue · #3')
    expect(detail.title).toContain('deleteTenant')
    expect(detail.body).toBe('The query filters `Chat.tenantId`.')
  })

  it('offers both acts on an item nobody is holding', () => {
    const detail = buildQueueItemDetail(card(), item(), group())
    expect(detail.claim.actionable).toBe(true)
    expect(detail.dismiss.actionable).toBe(true)
    expect(detail.dismiss.blockedReason).toBeNull()
  })

  it('refuses both while somebody else’s run holds it, and says whose', () => {
    const detail = buildQueueItemDetail(card({ heldBy: 'run-20260817-1' }), item(), group())
    expect(detail.claim.actionable).toBe(false)
    expect(detail.dismiss.actionable).toBe(false)
    expect(detail.dismiss.blockedReason).toContain('run-20260817-1')
  })

  it('will not claim work that is already started, but will still dismiss it', () => {
    const detail = buildQueueItemDetail(card({ lane: 'doing', taskId: 't1' }), item(), group())
    expect(detail.claim.actionable).toBe(false)
    expect(detail.claim.blockedReason).toContain('already started')
    expect(detail.dismiss.actionable).toBe(true)
  })

  it('refuses in the board’s own terms when no loop owns the item', () => {
    // Forbidden pattern #12: the reason names what is wrong with the thing on
    // screen, never the file or the flag that would fix it.
    const detail = buildQueueItemDetail(card({ loop: '' }), item(), group())
    expect(detail.dismiss.actionable).toBe(false)
    expect(detail.dismiss.blockedReason).toContain("can't tell which list")
    expect(detail.dismiss.blockedReason).not.toMatch(/planflow-ai|--loop|loops\//)
  })

  it('says what a dismissal costs, and never calls it a delete', () => {
    // It is `loop close --reason wontfix`: permanent memory the producers read
    // back, not an erasure. A button labelled Delete would be a lie about both.
    const detail = buildQueueItemDetail(card(), item(), group())
    expect(detail.dismiss.label).toBe('Dismiss')
    expect(detail.dismissHint).toContain('stop filing it')
    expect(detail.dismissHint).toContain('Everyone on the list sees it')
  })

  it('still opens for an item the read gave no body or group for', () => {
    const detail = buildQueueItemDetail(card({ title: '' }), null, null)
    expect(detail.title).toBe('Untitled item')
    expect(detail.body).toBeNull()
    expect(detail.emptyBody).toContain('no description')
    expect(detail.subtitle).toBe('#3')
  })
})

describe('queueItemMenuEntries', () => {
  // A card Flow owns answers a right-click; an item from the shared list
  // answered with nothing — the reader learns a gesture on one card and it does
  // nothing on the card beside it.
  it('offers the ticket’s own acts, and no new verbs', () => {
    const entries = queueItemMenuEntries(buildQueueItemDetail(card(), item(), group()))
    expect(entries.map((entry) => entry.id)).toEqual(['open', 'chat', 'claim', 'dismiss'])
    expect(entries.every((entry) => entry.enabled)).toBe(true)
  })

  it('keeps the ellipsis on Dismiss — it still asks for the reason', () => {
    const entries = queueItemMenuEntries(buildQueueItemDetail(card(), item(), group()))
    expect(entries.find((entry) => entry.id === 'dismiss')?.label).toBe('Dismiss…')
  })

  it('marks only Dismiss destructive', () => {
    const entries = queueItemMenuEntries(buildQueueItemDetail(card(), item(), group()))
    expect(entries.filter((entry) => entry.danger).map((entry) => entry.id)).toEqual(['dismiss'])
  })

  it('carries a refusal onto the item instead of hiding it', () => {
    const entries = queueItemMenuEntries(
      buildQueueItemDetail(card({ heldBy: 'run-2' }), item(), group()),
    )
    const claim = entries.find((entry) => entry.id === 'claim')
    expect(claim?.enabled).toBe(false)
    expect(claim?.blockedReason).toContain('run-2')
    // Open and Add to chat never refuse: reading is not an act on the queue.
    expect(entries.find((entry) => entry.id === 'open')?.enabled).toBe(true)
    expect(entries.find((entry) => entry.id === 'chat')?.enabled).toBe(true)
  })
})
