import {
  chatLearnAreaName,
  chatLearnCopy,
  chatLearnKey,
  formatChatLearnMarker,
  parseChatLearnMarker,
  type ChatLearnMarker,
} from './chat-learn-marker'

const marker: ChatLearnMarker = { root: '/repo', module: 'src/components/modules/CoworkerPanel', files: 26, phase: 'learning' }

describe('chat-learn marker rows (2026-11-17)', () => {
  it('round-trips through the one writer and the one reader', () => {
    expect(parseChatLearnMarker(formatChatLearnMarker(marker))).toEqual(marker)
  })

  it('refuses anything that is not a well-formed marker', () => {
    expect(parseChatLearnMarker('Interrupted by you')).toBeNull()
    expect(parseChatLearnMarker('[chat-learn] not json')).toBeNull()
    expect(parseChatLearnMarker('[chat-learn] {"root":"/r","module":"m","files":2,"phase":"maybe"}')).toBeNull()
    expect(parseChatLearnMarker('[chat-learn] {"root":"","module":"m","files":2,"phase":"learned"}')).toBeNull()
    expect(parseChatLearnMarker('[chat-learn] {"root":"/r","module":"m","files":-1,"phase":"learned"}')).toBeNull()
  })

  it('keys an area by root and module, so phases of one area share a card', () => {
    expect(chatLearnKey({ ...marker, phase: 'learned' } as ChatLearnMarker)).toBe(chatLearnKey(marker))
    expect(chatLearnKey({ ...marker, root: '/other' })).not.toBe(chatLearnKey(marker))
    expect(chatLearnKey({ ...marker, module: `${marker.module}/` })).toBe(chatLearnKey(marker))
  })

  it('names the area by its last segment and never shows the path', () => {
    expect(chatLearnAreaName('src/components/modules/CoworkerPanel/')).toBe('CoworkerPanel')
    for (const phase of ['learning', 'learned', 'failed'] as const) {
      const copy = chatLearnCopy({ ...marker, phase })
      expect(`${copy.title} ${copy.detail}`).not.toContain('src/')
    }
  })

  it('asks once with two answers, and says where to change a no', () => {
    expect(parseChatLearnMarker(formatChatLearnMarker({ ...marker, phase: 'ask' }))?.phase).toBe('ask')
    expect(parseChatLearnMarker(formatChatLearnMarker({ ...marker, phase: 'declined' }))?.phase).toBe('declined')
    const ask = chatLearnCopy({ ...marker, phase: 'ask' })
    expect(ask.title).toBe('Learn CoworkerPanel for the blueprint?')
    expect(ask.detail).toMatch(/tokens/)
    expect(ask.action).toEqual({ kind: 'ask', yes: 'Learn automatically', no: 'Not now' })
    expect(chatLearnCopy({ ...marker, phase: 'declined' })).toMatchObject({ detail: 'You can turn it on in Settings.', action: null })
  })

  it('is a status line: only a failed run offers Try again', () => {
    expect(chatLearnCopy(marker).action).toBeNull()
    expect(chatLearnCopy({ ...marker, phase: 'learned' }).action).toBeNull()
    expect(chatLearnCopy({ ...marker, phase: 'failed' }).action).toEqual({ kind: 'retry', label: 'Try again' })
    expect(chatLearnCopy({ ...marker, files: 1 }).detail).toBe('from 1 file')
  })
})
