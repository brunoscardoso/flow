// What a gesture on a card means (loops-on-the-board, Phase 6, tasks 6.3–6.5).
//
// The claim assertions are all one assertion wearing four hats: the CLI's own
// sentence reaches the user. A generic "claim failed" would pass a test that
// only checked the card came back — so every case below asserts the REASON.

import {
  cardApproval,
  cardRelease,
  cardShare,
  claimOutcome,
  heldByThisInstallation,
  queueItemFor,
  relayed,
  releaseNotice,
  resolveCardLoop,
  runRecordFacts,
  runRecordNotice,
  shareOutcome,
} from './board-actions'
import { APPROVAL_BLOCKED_REASON, type BoardCard, type BoardQueueGroup } from './board-model'
import type {
  LoopClaimResult,
  LoopFileResult,
  LoopQueueItem,
  LoopQueueSnapshot,
  LoopStatusRow,
  LoopsSnapshot,
  TaskSummary,
} from '../../shared/ipc-contract'

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    key: 'queue:github::dev/plan-flow#1533',
    title: 'code map refactor',
    origin: 'github',
    lane: 'todo',
    taskId: null,
    itemId: '1533',
    queueKey: 'github::dev/plan-flow',
    loop: 'fix',
    url: 'https://github.com/dev/plan-flow/issues/1533',
    prUrl: null,
    attention: false,
    blockedReason: null,
    heldBy: null,
    missingReason: null,
    ageLabel: '2d ago',
    autoFix: false,
    threadStatus: null,
    backgroundTasks: 0,
    ...overrides,
  }
}

function group(overrides: Partial<BoardQueueGroup> = {}): BoardQueueGroup {
  return {
    key: 'github::dev/plan-flow',
    kind: 'github',
    location: 'dev/plan-flow',
    label: 'dev/plan-flow',
    loops: ['fix'],
    readable: true,
    reason: null,
    todo: [],
    ...overrides,
  }
}

function claim(overrides: Partial<LoopClaimResult>): LoopClaimResult {
  return { status: 'claimed', loop: 'fix', owner: 'run-1', reason: null, item: null, ...overrides }
}

function statusRow(overrides: Partial<LoopStatusRow> = {}): LoopStatusRow {
  return {
    loop: 'fix',
    pause: null,
    locks: [],
    queue: {
      open: 1,
      closed: 0,
      claimed: 0,
      awaitingApproval: 1,
      parked: 0,
      claimable: 0,
      maxOpenIssues: 20,
      capReached: false,
    },
    awaitingApprovalIds: ['1533'],
    ...overrides,
  }
}

function loops(rows: LoopStatusRow[]): LoopsSnapshot {
  return {
    available: true,
    reason: null,
    loops: rows,
    globalPause: null,
    digest: null,
    generatedAt: null,
  }
}

function queueItem(overrides: Partial<LoopQueueItem> = {}): LoopQueueItem {
  return {
    id: '1533',
    loop: 'fix',
    title: 'code map refactor',
    body: 'the finding\n\nloop: fix\nloop-claim: run-1',
    fingerprint: 'abc',
    state: 'open',
    labels: [],
    approved: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

function queueSnapshot(
  rows: { loop: string; items: LoopQueueItem[] | null }[],
): LoopQueueSnapshot {
  return {
    available: true,
    reason: null,
    state: 'open',
    loops: rows,
    generatedAt: null,
  }
}

describe('resolveCardLoop', () => {
  it('takes the loop the item itself names', () => {
    expect(resolveCardLoop(card(), [group()])).toEqual({ loop: 'fix', reason: null })
  })

  it('falls back to the queue when exactly one loop reads it', () => {
    expect(resolveCardLoop(card({ loop: null }), [group()])).toEqual({ loop: 'fix', reason: null })
  })

  it('refuses to guess when two loops read one list', () => {
    const resolved = resolveCardLoop(card({ loop: null }), [group({ loops: ['find', 'fix'] })])
    expect(resolved.loop).toBeNull()
    expect(resolved.reason).toContain('find and fix')
    expect(resolved.reason).toContain('dev/plan-flow')
  })
})

describe('claimOutcome (6.3 / 6.4)', () => {
  it('settles the card in Doing on a claim, with nothing to say', () => {
    expect(claimOutcome(card(), claim({ status: 'claimed' }))).toEqual({
      claimed: true,
      lane: 'doing',
      note: null,
      notice: null,
    })
  })

  it('returns the card to Todo carrying the refusal, verbatim', () => {
    const reason =
      "item 1533 is awaiting approval (loop-needs-approval)"
    const outcome = claimOutcome(card(), claim({ status: 'refused', reason }))
    expect(outcome.claimed).toBe(false)
    expect(outcome.lane).toBe('todo')
    expect(outcome.note).toBe(reason)
    expect(outcome.notice).toEqual({
      title: "Couldn't claim this item",
      body: reason,
      level: 'error',
    })
  })

  it('never leaves a failed claim silent, even when the CLI gave no reason', () => {
    const outcome = claimOutcome(card(), claim({ status: 'refused', reason: null }))
    expect(outcome.note).toBe('the claim was refused')
    expect(outcome.notice?.level).toBe('error')
  })

  // 6.4 — the foreignClaimant sentence is the whole payload: WHO has the item is
  // the thing a generic failure could never say. What it must NOT carry into the
  // UI is the CLI's trailing "run this by hand" invocation — the CLI writes for a
  // terminal, and the board has a Release control.
  it('surfaces the foreign claimant’s sentence as information, minus the command', () => {
    const reason =
      "item 1533 is held by '@rival' on the queue (loop-claimed + assignee) — another run has it; " +
      'release it with `planflow-ai loop unclaim --loop fix --id 1533`'
    const outcome = claimOutcome(card({ heldBy: '@rival' }), claim({ status: 'refused', reason }))
    expect(outcome.lane).toBe('todo')
    // The substance survives whole …
    expect(outcome.note).toContain("held by '@rival'")
    expect(outcome.note).toContain('another run has it')
    // … and the instruction to go do it by hand does not.
    expect(outcome.note).not.toContain('planflow-ai')
    expect(outcome.note).not.toContain('--id')
    expect(outcome.notice).toEqual({
      title: 'Someone else has this item',
      body: outcome.note,
      level: 'info',
    })
  })

  it('leaves a reason that carries no command completely alone', () => {
    const reason = 'item 1533 is awaiting approval (needs-approval)'
    const outcome = claimOutcome(card(), claim({ status: 'refused', reason }))
    expect(outcome.note).toBe(reason)
  })

  it('reads a lost race as information, not as a fault', () => {
    const reason = 'item 1533 was taken by someone else while it was being claimed'
    const outcome = claimOutcome(card(), claim({ status: 'lost', reason }))
    expect(outcome.notice).toEqual({
      title: 'Someone else has this item',
      body: reason,
      level: 'info',
    })
  })

  it('reads an empty queue as information', () => {
    const outcome = claimOutcome(card(), claim({ status: 'empty', reason: 'no claimable items' }))
    expect(outcome.claimed).toBe(false)
    expect(outcome.notice).toEqual({
      title: 'Nothing to claim',
      body: 'no claimable items',
      level: 'info',
    })
  })
})

// ── the durable owner (review finding H1) ────────────────────────────────
//
// THE SENTENCE THAT WAS ACTIVELY WRONG. A claim that landed while its local
// record did not left `heldBy` set to this window's own claim, and every retry
// arrived under a freshly minted `run-<ts>-<pid>` the queue had never seen —
// so the CLI refused it and the board announced "Someone else has this item"
// about the user's own claim, with no in-app way to let go.

const MINE = 'flow-ide-3f2a9c1b7e04'

describe('a card held by THIS installation is told apart from a stranger’s (H1)', () => {
  it('recognises its own claim, and only its own', () => {
    expect(heldByThisInstallation(card({ heldBy: MINE }), MINE)).toBe(true)
    expect(heldByThisInstallation(card({ heldBy: '@rival' }), MINE)).toBe(false)
    expect(heldByThisInstallation(card({ heldBy: 'run-20260814-991' }), MINE)).toBe(false)
    expect(heldByThisInstallation(card({ heldBy: null }), MINE)).toBe(false)
  })

  it('answers false with no owner in hand — a board that cannot name itself claims nothing', () => {
    // An older preload with no `loops:owner`. The conservative reading is the
    // pre-H1 one: a held card is somebody else's.
    expect(heldByThisInstallation(card({ heldBy: MINE }), null)).toBe(false)
    expect(heldByThisInstallation(card({ heldBy: MINE }), '')).toBe(false)
    expect(heldByThisInstallation(card({ heldBy: '' }), '')).toBe(false)
  })

  it('stops saying "Someone else has this item" about our own claim', () => {
    const reason = 'item 1533 is awaiting approval (loop-needs-approval)'
    const held = card({ heldBy: MINE })

    // Before: heldBy non-null was enough. After: only a holder that is not us.
    expect(claimOutcome(held, claim({ status: 'refused', reason }), MINE).notice).toEqual({
      title: "Couldn't claim this item",
      body: reason,
      level: 'error',
    })
    expect(claimOutcome(held, claim({ status: 'refused', reason }), '@rival').notice?.title).toBe(
      'Someone else has this item',
    )
    expect(claimOutcome(held, claim({ status: 'refused', reason }), null).notice?.title).toBe(
      'Someone else has this item',
    )
  })

  it('still calls a lost race someone else’s, even on a card we appear to hold', () => {
    // `lost` is the CLI's word about the claim just attempted, not about the
    // marker on the card — another run got there between the read and the write.
    const outcome = claimOutcome(card({ heldBy: MINE }), claim({ status: 'lost', reason: 'gone' }), MINE)
    expect(outcome.notice?.title).toBe('Someone else has this item')
  })

  it('leaves a stranger’s claim reading exactly as it did before', () => {
    const reason = "item 1533 is held by '@rival' on the queue"
    expect(claimOutcome(card({ heldBy: '@rival' }), claim({ status: 'refused', reason }), MINE)).toEqual(
      claimOutcome(card({ heldBy: '@rival' }), claim({ status: 'refused', reason })),
    )
  })
})

describe('cardRelease — the claim’s other half (H1)', () => {
  it('offers a press naming the loop and the id on a card we hold', () => {
    expect(cardRelease(card({ heldBy: MINE }), [group()], MINE)).toEqual({
      loop: 'fix',
      id: '1533',
      label: 'Release',
      actionable: true,
      blockedReason: null,
    })
  })

  it('offers nothing on a stranger’s claim, on an unheld item, or with no owner', () => {
    // A button that exists only to be refused invites the attempt. The CLI's
    // ownership check would refuse it anyway — this is the surface agreeing.
    expect(cardRelease(card({ heldBy: '@rival' }), [group()], MINE)).toBeNull()
    expect(cardRelease(card({ heldBy: null }), [group()], MINE)).toBeNull()
    expect(cardRelease(card({ heldBy: MINE }), [group()], null)).toBeNull()
  })

  it('offers nothing on a card with no queue item — a local record moves by lane', () => {
    expect(cardRelease(card({ heldBy: MINE, itemId: null }), [group()], MINE)).toBeNull()
  })

  it('renders disabled, saying what is wrong rather than a command, when nothing names the loop', () => {
    const ambiguous = cardRelease(
      card({ heldBy: MINE, loop: null }),
      [group({ loops: ['find', 'fix'] })],
      MINE,
    )
    expect(ambiguous?.actionable).toBe(false)
    expect(ambiguous?.loop).toBeNull()
    // NO COMMAND IN A SENTENCE A PERSON READS. A disabled control says what is
    // wrong in the terms of the thing on screen; pasting a terminal invocation
    // hands the reader the app's internals and asks them to finish by hand.
    expect(ambiguous?.blockedReason).not.toContain('planflow-ai')
    expect(ambiguous?.blockedReason).not.toContain('--id')
    expect(ambiguous?.blockedReason).toContain('find and fix')
  })
})

describe('releaseNotice', () => {
  it('says released when something was actually released', () => {
    expect(releaseNotice('code map refactor', { ok: true, reason: null, wasClaimed: true })).toEqual({
      title: 'Released',
      body: 'code map refactor is back on the list for anyone — or any loop — to claim.',
      level: 'info',
    })
  })

  it('does not claim to have undone something it did not', () => {
    // Releasing what nobody held is success in the CLI, and the surface has to
    // say the same thing without inventing an undo.
    const notice = releaseNotice('code map refactor', { ok: true, reason: null, wasClaimed: false })
    expect(notice.title).toBe('Nothing to release')
    expect(notice.level).toBe('info')
  })

  it('carries the CLI refusal verbatim', () => {
    const reason = "item 1533 is held by '@rival' on the queue"
    expect(releaseNotice('x', { ok: false, reason, wasClaimed: false })).toEqual({
      title: "Couldn't release this item",
      body: reason,
      level: 'error',
    })
  })

  it('names an untitled item rather than saying nothing', () => {
    expect(releaseNotice('   ', { ok: true, reason: null, wasClaimed: true }).body).toContain(
      'The item',
    )
  })
})

// ── the two failures a claimed record can have (review finding L2) ───────

describe('runRecordNotice', () => {
  it('distinguishes a record that was never created from one that would not move', () => {
    const created = runRecordNotice('code map refactor', 'not-created', 'database is locked')
    const moved = runRecordNotice('code map refactor', 'not-moved', 'database is locked')

    // The bug: BOTH used to be reported as "Claimed, with no local record" —
    // a sentence about a record the user can see sitting in Todo.
    expect(created.title).toBe('Claimed, with no local record')
    expect(moved.title).not.toBe(created.title)
    expect(moved.title).toContain('Todo')
    expect(moved.body).toContain('Flow recorded the run')
    expect(created.body).toContain('could not record the run')
  })

  it('carries the IPC reason on both, verbatim', () => {
    expect(runRecordNotice('x', 'not-created', 'database is locked').body).toContain(
      'database is locked',
    )
    expect(runRecordNotice('x', 'not-moved', 'database is locked').body).toContain(
      'database is locked',
    )
  })

  it('reads as information when nothing failed — the queue just published no key', () => {
    const notice = runRecordNotice('code map refactor', 'unrecordable')
    expect(notice.level).toBe('info')
    expect(notice.body).toContain('no link or location')
  })

  it('never suggests the claim itself did not land', () => {
    for (const failure of ['unrecordable', 'not-created', 'not-moved'] as const) {
      expect(runRecordNotice('code map refactor', failure).body).toContain('is yours on the queue')
    }
  })

  it('drops a dangling dash when there is no reason to give', () => {
    expect(runRecordNotice('x', 'not-created').body).toBe(
      'x is yours on the queue, but Flow could not record the run.',
    )
  })
})

describe('cardApproval (6.5)', () => {
  const gated = card({ lane: 'blocked', blockedReason: APPROVAL_BLOCKED_REASON, attention: true })

  it('offers a press naming the loop and the id', () => {
    expect(cardApproval(gated, [group()], loops([statusRow()]))).toEqual({
      loop: 'fix',
      id: '1533',
      label: 'Approve',
      actionable: true,
      blockedReason: null,
    })
  })

  it('is offered even when the status snapshot never arrived — the id came from the list', () => {
    const approval = cardApproval(gated, [group()], null)
    expect(approval?.actionable).toBe(true)
    expect(approval?.loop).toBe('fix')
  })

  it('renders disabled, saying what is wrong rather than a command, when nothing names the loop', () => {
    const orphan = card({
      lane: 'blocked',
      blockedReason: APPROVAL_BLOCKED_REASON,
      loop: null,
    })
    const approval = cardApproval(orphan, [group({ loops: ['find', 'fix'] })], null)
    expect(approval?.actionable).toBe(false)
    expect(approval?.blockedReason).not.toContain('planflow-ai')
    expect(approval?.blockedReason).not.toContain('--id')
    // The supplied reason is kept — it names WHICH lists were ambiguous, which
    // is more use than the generic fallback.
    expect(approval?.blockedReason).toContain('find and fix')
  })

  it('will not write on a disagreement between the two reads', () => {
    // `loop status` names the waiting items and this one is not among them.
    const approval = cardApproval(gated, [group()], loops([statusRow({ awaitingApprovalIds: ['9999'] })]))
    expect(approval?.actionable).toBe(false)
    expect(approval?.blockedReason).not.toContain('planflow-ai')
    expect(approval?.blockedReason).toContain('not listed as waiting for approval')
  })

  it('is absent for a card that is not behind the gate', () => {
    expect(cardApproval(card(), [group()], loops([statusRow()]))).toBeNull()
    const otherwiseBlocked = card({ lane: 'blocked', blockedReason: 'held elsewhere', attention: true })
    expect(cardApproval(otherwiseBlocked, [group()], loops([statusRow()]))).toBeNull()
  })

  it('is absent for a purely local record — there is no queue item to approve', () => {
    const local = card({
      itemId: null,
      queueKey: null,
      loop: null,
      lane: 'blocked',
      blockedReason: APPROVAL_BLOCKED_REASON,
    })
    expect(cardApproval(local, [group()], loops([statusRow()]))).toBeNull()
  })
})

// ── The run record a claim materializes (6.6 / FR-7) ──────────────────────
//
// The gap these guard: the first cut sent the claimed item's URL to the
// issue IMPORTER, which refetches. A ledger item has no URL and no fetchable
// tracker, so the queue kind that exists to make Flow the truth source was the
// one kind that recorded nothing.

describe('queueItemFor', () => {
  it('finds the item in the snapshot the board already read', () => {
    const item = queueItem()
    const snapshot = queueSnapshot([{ loop: 'fix', items: [queueItem({ id: '1' }), item] }])
    expect(queueItemFor(snapshot, group(), '1533')).toBe(item)
  })

  it('ignores rows for loops that do not read this queue', () => {
    const snapshot = queueSnapshot([{ loop: 'other', items: [queueItem()] }])
    expect(queueItemFor(snapshot, group(), '1533')).toBeNull()
  })

  it('answers null for a queue nobody could read — null items are not empty ones', () => {
    expect(queueItemFor(queueSnapshot([{ loop: 'fix', items: null }]), group(), '1533')).toBeNull()
  })

  it('resolves the OWN queue\'s item when two queues share an id (#1765)', () => {
    // Ids are unique only per queue — "12" in a GitHub queue and a ledger at
    // once is ordinary. The group scope must pick the clicked card's queue,
    // never the first match across all of them.
    const ours = queueItem({ title: 'the right one' })
    const snapshot = queueSnapshot([
      { loop: 'other', items: [queueItem({ title: 'the wrong one' })] },
      { loop: 'fix', items: [ours] },
    ])
    expect(queueItemFor(snapshot, group(), '1533')).toBe(ours)
  })
})

describe('runRecordFacts (FR-7)', () => {
  it('records a GitHub item under the key the board joins on, with its link', () => {
    const facts = runRecordFacts(card(), group(), queueItem())
    expect(facts).toEqual({
      externalKey: 'dev/plan-flow#1533',
      itemId: '1533',
      url: 'https://github.com/dev/plan-flow/issues/1533',
      title: 'code map refactor',
      body: 'the finding\n\nloop: fix\nloop-claim: run-1',
      queueKind: 'github',
    })
  })

  // The whole point of the phase: a ledger item has no URL and no tracker, and
  // it still gets a key — the ledger path plus the item's id.
  it('records a ledger item, which has no link and nothing to fetch', () => {
    const ledgerGroup = group({
      key: 'ledger::flow/loops/queue.jsonl',
      kind: 'ledger',
      location: 'flow/loops/queue.jsonl',
      label: 'flow/loops/queue.jsonl',
      loops: ['ops'],
    })
    const facts = runRecordFacts(
      card({ url: null, itemId: '7', loop: 'ops', queueKey: ledgerGroup.key, origin: 'you' }),
      ledgerGroup,
      queueItem({ id: '7', loop: 'ops', title: 'tidy the ledger', body: 'because' }),
    )
    expect(facts).toEqual({
      externalKey: 'flow/loops/queue.jsonl#7',
      itemId: '7',
      title: 'tidy the ledger',
      body: 'because',
      queueKind: 'ledger',
    })
    expect(facts).not.toHaveProperty('url')
  })

  it('falls back to the link when the queue named no location', () => {
    const nameless = group({ key: 'loop:fix', kind: null, location: null, label: 'fix' })
    const facts = runRecordFacts(card({ queueKey: 'loop:fix' }), nameless, queueItem())
    expect(facts?.externalKey).toBeUndefined()
    expect(facts?.url).toBe('https://github.com/dev/plan-flow/issues/1533')
  })

  // The claim still stands; only the record is impossible — and the board says
  // so rather than inventing an identity for the run.
  it('is null when the item names neither a location nor a link', () => {
    const nameless = group({ key: 'loop:fix', kind: null, location: null, label: 'fix' })
    expect(runRecordFacts(card({ url: null }), nameless, queueItem())).toBeNull()
    expect(runRecordFacts(card({ url: null }), null, null)).toBeNull()
  })

  it('records from the card alone when the snapshot no longer holds the item', () => {
    const facts = runRecordFacts(card(), group(), null)
    expect(facts?.title).toBe('code map refactor')
    expect(facts).not.toHaveProperty('body')
  })
})

// ── Sharing a thread's task onto the shared list (Phase 5, Task 5.2) ──────
//
// TWO CLAIMS ARE UNDER TEST AND ONLY ONE OF THEM IS ABOUT THE HAPPY PATH.
//
//  1. NOTHING REACHES THE SHARED LIST BY ITSELF. The control exists on exactly
//     one kind of card, and every other card gets null — a queue item, an
//     imported issue, a card a person typed, a card already in flight.
//  2. A SHARE THAT DID NOT LAND CHANGES NOTHING. `archive` is the field that
//     takes a card off the board, and a refusal must never set it.

function mirrored(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 'mirror-1',
    projectRoot: '/repo',
    title: 'run the tests',
    source: 'manual',
    // Exactly what `mirrorExternalKey` writes: `<originThreadId>#<todo key>`.
    externalKey: 'th-abc#run the tests',
    externalUrl: null,
    lane: 'todo',
    suggestDone: false,
    threadId: null,
    originThreadId: 'th-abc',
    description: null,
    images: null,
    autoFix: false,
    prUrl: null,
    brief: null,
    briefStatus: 'idle',
    archivedAt: null,
    createdAt: '2026-08-14T12:00:00.000Z',
    updatedAt: '2026-08-14T12:00:00.000Z',
    ...overrides,
  }
}

/** A mirrored card as the model draws it: a local record, on no queue at all. */
function localCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return card({
    key: 'task:mirror-1',
    title: 'run the tests',
    origin: 'assistant',
    taskId: 'mirror-1',
    itemId: null,
    queueKey: null,
    loop: null,
    url: null,
    ...overrides,
  })
}

function fileResult(overrides: Partial<LoopFileResult> = {}): LoopFileResult {
  return { ok: true, reason: null, status: 'filed', ...overrides }
}

describe('cardShare — the one route from a conversation to a shared list', () => {
  it('offers the control on a mirrored card, naming the list it would go on', () => {
    const share = cardShare(localCard(), mirrored(), [group()])
    expect(share?.actionable).toBe(true)
    expect(share?.loop).toBe('fix')
    expect(share?.listLabel).toBe('dev/plan-flow')
    expect(share?.blockedReason).toBeNull()
  })

  it('offers nothing on a card that is not one an assistant listed', () => {
    // A queue item: already on the list this control puts things on.
    expect(cardShare(card(), null, [group()])).toBeNull()
    // A card a person typed — manual, but no conversation produced it.
    expect(cardShare(localCard(), mirrored({ externalKey: null, originThreadId: null }), [group()])).toBeNull()
    // An imported issue that happens to name an origin thread: the tracker owns it.
    expect(
      cardShare(localCard(), mirrored({ source: 'github', externalKey: 'acme/widgets#1' }), [group()]),
    ).toBeNull()
    // A record whose key belongs to a different conversation than its origin.
    expect(cardShare(localCard(), mirrored({ externalKey: 'th-other#run the tests' }), [group()])).toBeNull()
  })

  it('offers nothing on work already in flight — sharing may not empty a lane', () => {
    for (const lane of ['doing', 'blocked', 'done'] as const) {
      expect(cardShare(localCard({ lane }), mirrored({ lane }), [group()])).toBeNull()
    }
  })

  it('says why rather than picking, when the board cannot name one list', () => {
    const none = cardShare(localCard(), mirrored(), [])
    expect(none?.actionable).toBe(false)
    expect(none?.loop).toBeNull()
    expect(none?.blockedReason).toContain('no shared list yet')

    const two = cardShare(localCard(), mirrored(), [
      group(),
      group({ key: 'github::acme/widgets', location: 'acme/widgets', label: 'acme/widgets' }),
    ])
    expect(two?.actionable).toBe(false)
    expect(two?.blockedReason).toContain('more than one list')

    // This repo's real shape: two producers reading ONE list. Each files under
    // its own directive, so picking either would be the board deciding whose
    // work this is.
    const ambiguous = cardShare(localCard(), mirrored(), [group({ loops: ['find', 'fix'] })])
    expect(ambiguous?.actionable).toBe(false)
    expect(ambiguous?.blockedReason).toContain('find and fix')

    const orphan = cardShare(localCard(), mirrored(), [group({ loops: [] })])
    expect(orphan?.actionable).toBe(false)
    expect(orphan?.blockedReason).toContain('No loop reads')
  })
})

describe('shareOutcome — what the answer does to the card', () => {
  it('takes the local card off the board once the work is on the list', () => {
    const outcome = shareOutcome('run the tests', 'dev/plan-flow', fileResult())
    expect(outcome.onTheList).toBe(true)
    expect(outcome.archive).toBe(true)
    expect(outcome.note).toBeNull()
    expect(outcome.notice.level).toBe('info')
    expect(outcome.notice.body).toContain('dev/plan-flow')
  })

  it('treats an item already on the list the same way, and says so', () => {
    const outcome = shareOutcome('run the tests', 'dev/plan-flow', fileResult({ status: 'duplicate' }))
    expect(outcome.archive).toBe(true)
    expect(outcome.notice.title).toBe('Already on the list')
  })

  it('archives on a clean exit whose report did not parse — the write landed', () => {
    expect(shareOutcome('run the tests', null, fileResult({ status: null })).archive).toBe(true)
  })

  it('LEAVES THE CARD EXACTLY AS IT WAS when the share did not land', () => {
    const outcome = shareOutcome('run the tests', 'dev/plan-flow', {
      ok: false,
      reason: 'the queue is unreachable',
      status: null,
    })
    expect(outcome.onTheList).toBe(false)
    expect(outcome.archive).toBe(false)
    expect(outcome.notice.level).toBe('error')
    // The reason RIDES THE CARD, not just a toast that is gone in five seconds.
    expect(outcome.note).toBe('the queue is unreachable')
  })

  it('never shows a refusal that carries a command, a path or a config key', () => {
    // The three shapes `loop file` can actually refuse with. Each one is fit to
    // relay or it is dropped for the app's own sentence — never leaked.
    const refusals = [
      'file requires --loop <name>',
      "no directive for loop 'fix' at /Users/someone/thing/flow/loops/fix.md or /Users/someone/vault/loops/fix.md",
      "instruction 'find UI gaps' has filed 20 of 20 — stop here and let a person look at what is already in the list (to carry on after looking: loop resume --loop find --focus 'find UI gaps')",
      'held by @rival since Tuesday — release it with `planflow-ai loop unclaim --loop fix --id 1533`',
    ]
    for (const reason of refusals) {
      const outcome = shareOutcome('run the tests', 'acme/widgets', { ok: false, reason, status: null })
      for (const token of ['planflow-ai', 'loops/', '.md', 'paused:', '--']) {
        expect(outcome.notice.body).not.toContain(token)
        expect(outcome.note).not.toContain(token)
      }
      expect(outcome.notice.body.length).toBeGreaterThan(0)
    }
  })
})

describe('relayed — a CLI sentence a person may actually be shown', () => {
  it('keeps a clean reason as it is', () => {
    expect(relayed('the queue is unreachable', 'fallback')).toBe('the queue is unreachable')
  })

  it('falls back rather than leaking an invocation it could not clean up', () => {
    expect(relayed('file requires --loop <name>', 'fallback')).toBe('fallback')
  })

  it('falls back on nothing at all', () => {
    expect(relayed(null, 'fallback')).toBe('fallback')
    expect(relayed('   ', 'fallback')).toBe('fallback')
  })

  it('keeps the substance of a reason whose command tail it removed', () => {
    const line = relayed(
      "instruction 'x' has filed 20 of 20 — stop here and let a person look (to carry on: loop resume --loop find)",
      'fallback',
    )
    expect(line).toContain('stop here and let a person look')
    expect(line).not.toContain('--')
  })

  it('falls back on a bare DIRECTORY path — the shape `forReader` cannot collapse', () => {
    // FOUND ON SCREEN, not in a model. `forReader` turns `…/broken.md` into
    // "its settings" because a file is a thing a reader can be told about; a
    // directory carries no extension to anchor on, and one arrives whenever a
    // whole loops folder cannot be listed. The token list walked past it —
    // no `planflow-ai`, no flag, no `.md`, and `loops/` needs the trailing
    // slash this path does not have — so the reader met an absolute path.
    expect(
      relayed(
        '/Users/someone/Projects/thing/loops: unreadable (EACCES: permission denied, scandir)',
        'fallback',
      ),
    ).toBe('fallback')
  })

  it('still keeps a sentence whose only slash is a word, not a path', () => {
    expect(relayed('one loop fills the list and/or empties it', 'fallback')).toBe(
      'one loop fills the list and/or empties it',
    )
  })
})
