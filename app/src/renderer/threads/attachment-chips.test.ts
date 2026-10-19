import type { MessageAttachmentInput } from '../../shared/ipc-contract'
import { MAX_ATTACHMENTS_PER_MESSAGE } from './image-attachment'
import {
  addAttachment,
  addAttachmentWithOutcome,
  attachmentDataUrl,
  removeAttachment,
} from './attachment-chips'

const att = (id: string): MessageAttachmentInput => ({
  id,
  mediaType: 'image/png',
  fileName: `${id}.png`,
  byteSize: 10,
  dataBase64: 'AAAA',
})

describe('attachment-chips (#456)', () => {
  it('adds and dedupes by id', () => {
    const one = addAttachment([], att('a'))
    expect(one).toHaveLength(1)
    expect(addAttachment(one, att('a'))).toBe(one) // duplicate → unchanged
    expect(addAttachment(one, att('b'))).toHaveLength(2)
  })

  it('enforces the per-message cap', () => {
    let list: readonly MessageAttachmentInput[] = []
    for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE; i += 1) list = addAttachment(list, att(`a${i}`))
    expect(list).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE)
    const capped = addAttachment(list, att('overflow'))
    expect(capped).toBe(list) // cap reached → unchanged
  })

  it('removes by id (missing id → unchanged)', () => {
    const list = addAttachment(addAttachment([], att('a')), att('b'))
    expect(removeAttachment(list, 'a')).toHaveLength(1)
    expect(removeAttachment(list, 'missing')).toBe(list)
  })

  it('builds a data URL from media type + bytes', () => {
    expect(attachmentDataUrl({ mediaType: 'image/png', dataBase64: 'AAAA' })).toBe(
      'data:image/png;base64,AAAA',
    )
  })

  describe('addAttachmentWithOutcome (#649)', () => {
    it('reports added and grows the list', () => {
      const { list, outcome } = addAttachmentWithOutcome([], att('a'))
      expect(outcome).toBe('added')
      expect(list).toHaveLength(1)
    })

    it('reports duplicate and returns the original array', () => {
      const base = addAttachment([], att('a'))
      const { list, outcome } = addAttachmentWithOutcome(base, att('a'))
      expect(outcome).toBe('duplicate')
      expect(list).toBe(base)
    })

    it('reports cap-reached (never duplicate) for a NEW image past the cap', () => {
      let base: readonly MessageAttachmentInput[] = []
      for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE; i += 1) {
        base = addAttachment(base, att(`a${i}`))
      }
      const { list, outcome } = addAttachmentWithOutcome(base, att('overflow'))
      expect(outcome).toBe('cap-reached')
      expect(list).toBe(base)
    })

    it('reports duplicate for an already-attached image even at the cap', () => {
      let base: readonly MessageAttachmentInput[] = []
      for (let i = 0; i < MAX_ATTACHMENTS_PER_MESSAGE; i += 1) {
        base = addAttachment(base, att(`a${i}`))
      }
      const { outcome } = addAttachmentWithOutcome(base, att('a0'))
      expect(outcome).toBe('duplicate')
    })
  })
})
