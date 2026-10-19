import type { MessageAttachmentInput } from '../../shared/ipc-contract'
import { buildUserContent } from './user-content'

const img = (over: Partial<MessageAttachmentInput> = {}): MessageAttachmentInput => ({
  id: 'a1',
  mediaType: 'image/png',
  fileName: 'shot.png',
  byteSize: 100,
  dataBase64: 'AAAA',
  ...over,
})

describe('buildUserContent (#456)', () => {
  it('returns the plain string unchanged when there are no attachments', () => {
    expect(buildUserContent('hello', undefined)).toBe('hello')
    expect(buildUserContent('hello', [])).toBe('hello')
  })

  it('emits a text block then one image block per attachment', () => {
    const content = buildUserContent('look at this', [img(), img({ id: 'a2', dataBase64: 'BBBB' })])
    expect(content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
    ])
  })

  it('omits the text block when the message is attachment-only', () => {
    const content = buildUserContent('', [img({ mediaType: 'image/jpeg', dataBase64: 'ZZZZ' })])
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZZZZ' } },
    ])
  })
})
