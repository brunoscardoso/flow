import {
  dequeue,
  enqueuePrompt,
  moveToFront,
  queuePreview,
  isComposerFreeStatus,
  queuedRestore,
  removeQueued,
  shouldAutoDrainOnStatus,
  sendNowFlagTransition,
  shouldDrainAfterSendNow,
  type QueuedPrompt,
} from './prompt-queue'
import type { MessageAttachmentInput } from '../../shared/ipc-contract'

const p = (id: string, content = id): QueuedPrompt => ({
  id,
  content,
  attachments: [],
  preview: content,
})

describe('queuePreview (#472, #1046)', () => {
  it('takes the first line, ellipsized past the cap', () => {
    expect(queuePreview('hello world')).toBe('hello world')
    expect(queuePreview('line one\nline two')).toBe('line one')
    expect(queuePreview('x'.repeat(60), [], 10)).toBe(`${'x'.repeat(10)}…`)
  })

  it('names a single attachment on an attachment-only prompt — never "" (#1046)', () => {
    expect(queuePreview('', [{ fileName: 'screenshot.png' }])).toBe('📎 screenshot.png')
  })

  it('keeps two attachment-only prompts distinguishable by fileName (#1046)', () => {
    const a = queuePreview('', [{ fileName: 'shot-a.png' }])
    const b = queuePreview('', [{ fileName: 'shot-b.png' }])
    expect(a).not.toBe(b)
  })

  it('collapses several attachments to a count', () => {
    expect(queuePreview('', [{ fileName: 'a.png' }, { fileName: 'b.png' }])).toBe('📎 2 images')
  })

  it('appends the attachment tag to a text prompt that also carries an image', () => {
    expect(queuePreview('with an image attached', [{ fileName: 'shot.png' }])).toBe(
      'with an image attached · 📎 shot.png',
    )
  })

  it('a whitespace-only first line yields just the attachment tag', () => {
    expect(queuePreview('  \nsecond line', [{ fileName: 'shot.png' }])).toBe('📎 shot.png')
  })
})

describe('queuedRestore (#491)', () => {
  const img: MessageAttachmentInput = {
    id: 'att-1',
    mediaType: 'image/png',
    fileName: 'shot.png',
    byteSize: 1234,
    dataBase64: 'AAAA',
  }
  const item = { content: 'analyze this', attachments: [img] as const }

  it('restores BOTH text and attachments into an empty composer', () => {
    expect(queuedRestore(item, { hasText: false, hasAttachments: false })).toEqual({
      text: 'analyze this',
      attachments: [img],
    })
  })

  it('restores nothing when the user has already typed a fresh draft', () => {
    expect(queuedRestore(item, { hasText: true, hasAttachments: false })).toEqual({
      text: null,
      attachments: null,
    })
  })

  it('restores text but NOT attachments when the composer already has attachments', () => {
    // Don't clobber attachments the user picked while the previous turn ran.
    expect(queuedRestore(item, { hasText: false, hasAttachments: true })).toEqual({
      text: 'analyze this',
      attachments: null,
    })
  })

  it('restores nothing when the composer has both text and attachments', () => {
    expect(queuedRestore(item, { hasText: true, hasAttachments: true })).toEqual({
      text: null,
      attachments: null,
    })
  })

  it('restores an empty attachments list for a text-only queued item', () => {
    const textOnly = { content: 'just text', attachments: [] as const }
    expect(queuedRestore(textOnly, { hasText: false, hasAttachments: false })).toEqual({
      text: 'just text',
      attachments: [],
    })
  })
})

describe('shouldAutoDrainOnStatus (#490)', () => {
  it('drains only on a natural completion (working → done)', () => {
    expect(shouldAutoDrainOnStatus('working', 'done')).toBe(true)
  })

  it('does NOT drain on interrupt (working → idle) — the stop button', () => {
    expect(shouldAutoDrainOnStatus('working', 'idle')).toBe(false)
  })

  it('does NOT drain on a failed turn (working → failed)', () => {
    expect(shouldAutoDrainOnStatus('working', 'failed')).toBe(false)
  })

  it('does NOT drain on paused states (needs-decision / blocked)', () => {
    expect(shouldAutoDrainOnStatus('working', 'needs-decision')).toBe(false)
    expect(shouldAutoDrainOnStatus('working', 'blocked')).toBe(false)
  })

  it('does NOT drain when staying working, or when the previous state was not working', () => {
    expect(shouldAutoDrainOnStatus('working', 'working')).toBe(false)
    // A later done → idle reset must not double-drain.
    expect(shouldAutoDrainOnStatus('done', 'idle')).toBe(false)
    expect(shouldAutoDrainOnStatus('idle', 'done')).toBe(false)
  })
})

describe('isComposerFreeStatus (#524)', () => {
  it('treats idle, done and failed as free', () => {
    expect(isComposerFreeStatus('idle')).toBe(true)
    expect(isComposerFreeStatus('done')).toBe(true)
    expect(isComposerFreeStatus('failed')).toBe(true)
  })

  it('treats working and paused states as NOT free', () => {
    expect(isComposerFreeStatus('working')).toBe(false)
    expect(isComposerFreeStatus('needs-decision')).toBe(false)
    expect(isComposerFreeStatus('blocked')).toBe(false)
  })
})

describe('shouldDrainAfterSendNow (#524)', () => {
  it('drains on any exit from working into a free state (the interrupt landing)', () => {
    // "Send now" interrupts the turn; the interrupt normally lands on idle, but a turn
    // that happened to complete/fail as it was interrupted must also drain.
    expect(shouldDrainAfterSendNow('working', 'idle')).toBe(true)
    expect(shouldDrainAfterSendNow('working', 'done')).toBe(true)
    expect(shouldDrainAfterSendNow('working', 'failed')).toBe(true)
  })

  it('does NOT drain into a paused state or while staying working', () => {
    // A turn parked awaiting input isn't free — don't fire against it.
    expect(shouldDrainAfterSendNow('working', 'needs-decision')).toBe(false)
    expect(shouldDrainAfterSendNow('working', 'blocked')).toBe(false)
    expect(shouldDrainAfterSendNow('working', 'working')).toBe(false)
  })

  it('does NOT drain when the previous state was not working', () => {
    expect(shouldDrainAfterSendNow('idle', 'idle')).toBe(false)
    expect(shouldDrainAfterSendNow('done', 'idle')).toBe(false)
  })
})

describe('sendNowFlagTransition (#594 — the flag must not latch)', () => {
  it('drains AND clears when a Send-now interrupt lands on idle', () => {
    expect(sendNowFlagTransition('working', 'idle', true)).toEqual({ clear: true, drainViaSendNow: true })
  })

  it('CLEARS the pending flag on a natural done that pre-empts the interrupt (no latch)', () => {
    // working→done clears the flag (auto-drain handles the actual send); crucially
    // the flag is now false so a LATER Stop cannot drain against the stop button.
    expect(sendNowFlagTransition('working', 'done', true).clear).toBe(true)
  })

  it('a later Stop with the flag already cleared does NOT drain', () => {
    expect(sendNowFlagTransition('working', 'idle', false)).toEqual({ clear: true, drainViaSendNow: false })
  })

  it('CLEARS on a needs-decision/blocked exit (paused), without draining there', () => {
    expect(sendNowFlagTransition('working', 'needs-decision', true)).toEqual({ clear: true, drainViaSendNow: false })
    expect(sendNowFlagTransition('working', 'blocked', true)).toEqual({ clear: true, drainViaSendNow: false })
  })

  it('does not clear or drain when the turn stays working or was not working', () => {
    expect(sendNowFlagTransition('working', 'working', true)).toEqual({ clear: false, drainViaSendNow: false })
    expect(sendNowFlagTransition('idle', 'working', true)).toEqual({ clear: false, drainViaSendNow: false })
  })
})

describe('enqueue / remove / moveToFront / dequeue', () => {
  it('enqueues to the back', () => {
    expect(enqueuePrompt([p('a')], p('b')).map((x) => x.id)).toEqual(['a', 'b'])
  })
  it('removes by id (missing → unchanged)', () => {
    const q = [p('a'), p('b')]
    expect(removeQueued(q, 'a').map((x) => x.id)).toEqual(['b'])
    expect(removeQueued(q, 'zzz')).toBe(q)
  })
  it('moves a prompt to the front ("send now")', () => {
    expect(moveToFront([p('a'), p('b'), p('c')], 'c').map((x) => x.id)).toEqual(['c', 'a', 'b'])
    const q = [p('a')]
    expect(moveToFront(q, 'missing')).toBe(q)
  })
  it('dequeues the front, returning next + rest', () => {
    expect(dequeue([p('a'), p('b')])).toEqual({
      next: p('a'),
      rest: [p('b')],
    })
    expect(dequeue([])).toEqual({ next: null, rest: [] })
  })
})
