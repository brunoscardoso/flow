import { thumbAlt, thumbModels } from './attachment-thumbs'

describe('thumbAlt (#456)', () => {
  it('uses the file name, falling back to a generic alt', () => {
    expect(thumbAlt('shot.png')).toBe('shot.png')
    expect(thumbAlt('')).toBe('Attached image')
    expect(thumbAlt(undefined)).toBe('Attached image')
    expect(thumbAlt('   ')).toBe('Attached image')
  })
})

describe('thumbModels', () => {
  it('is empty for no attachments', () => {
    expect(thumbModels(undefined)).toEqual([])
    expect(thumbModels([])).toEqual([])
  })

  it('carries the data URL when bytes are in hand (echo) and omits it otherwise (history)', () => {
    expect(
      thumbModels([
        { id: 'a', fileName: 'a.png', dataUrl: 'data:image/png;base64,AAAA' },
        { id: 'b', fileName: 'b.png' },
      ]),
    ).toEqual([
      { id: 'a', alt: 'a.png', dataUrl: 'data:image/png;base64,AAAA' },
      { id: 'b', alt: 'b.png', dataUrl: undefined },
    ])
  })
})
