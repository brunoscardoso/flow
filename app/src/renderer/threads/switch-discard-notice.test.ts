import { switchDiscardNotice } from './switch-discard-notice'

// #1327 / #1328: the composer drops attachments and queued prompts on a thread
// switch — deliberately, and correctly (#688 / #472: they must not misroute).
// It said nothing about either, so the composer came back looking intact and
// the next ⏎ sent "compare the attached screenshot" with nothing attached,
// while a committed queued prompt simply never fired.

describe('switchDiscardNotice (#1327, #1328)', () => {
  it('stays silent when the switch cost nothing', () => {
    // A notice on every switch would be noise, and noise stops being read.
    expect(switchDiscardNotice({ attachments: 0, queued: 0 }, 'Any thread')).toBeNull()
  })

  it('names the attachment that was removed, and the thread it belonged to', () => {
    const notice = switchDiscardNotice({ attachments: 1, queued: 0 }, 'Design review')
    expect(notice?.title).toBe('Attachment removed')
    expect(notice?.body).toContain('1 attachment removed')
    expect(notice?.body).toContain('Design review')
  })

  it('leads with the QUEUE, which is the more surprising loss', () => {
    // A queued prompt is a message the user already committed — the input
    // cleared and a pill promised it would auto-send.
    const notice = switchDiscardNotice({ attachments: 2, queued: 1 }, 'Build fix')
    expect(notice?.title).toBe('Queued prompt cancelled')
    expect(notice?.body.indexOf('queued prompt')).toBeLessThan(
      notice?.body.indexOf('attachments') ?? 0,
    )
  })

  it('pluralises both', () => {
    const notice = switchDiscardNotice({ attachments: 3, queued: 2 }, 't')
    expect(notice?.body).toContain('2 queued prompts cancelled')
    expect(notice?.body).toContain('3 attachments removed')
  })

  it('says WHY, because the behaviour is deliberate', () => {
    const notice = switchDiscardNotice({ attachments: 1, queued: 0 }, 't')
    expect(notice?.body).toContain('don’t follow you between threads')
  })

  it('falls back gracefully for an untitled thread', () => {
    const notice = switchDiscardNotice({ attachments: 1, queued: 0 }, '   ')
    expect(notice?.body).toContain('the previous thread')
    expect(notice?.body).not.toContain('“')
  })

  it('ignores nonsense counts rather than announcing them', () => {
    expect(switchDiscardNotice({ attachments: -2, queued: 0 }, 't')).toBeNull()
    expect(switchDiscardNotice({ attachments: 0.4, queued: 0 }, 't')).toBeNull()
  })
})
