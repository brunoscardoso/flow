import { attachmentRelPath, extensionForMediaType } from './attachment-path'

describe('extensionForMediaType (#456)', () => {
  it('maps each allowed image type to its extension', () => {
    expect(extensionForMediaType('image/png')).toBe('png')
    expect(extensionForMediaType('image/jpeg')).toBe('jpg')
    expect(extensionForMediaType('image/gif')).toBe('gif')
    expect(extensionForMediaType('image/webp')).toBe('webp')
  })
  it('falls back to bin for anything unexpected', () => {
    expect(extensionForMediaType('application/octet-stream')).toBe('bin')
  })
})

describe('attachmentRelPath', () => {
  it('is thread-scoped and carries the media-type extension', () => {
    expect(attachmentRelPath('t1', 'a1', 'image/png')).toBe('t1/a1.png')
    expect(attachmentRelPath('t2', 'a9', 'image/jpeg')).toBe('t2/a9.jpg')
  })
  it('stays relative (never absolute)', () => {
    expect(attachmentRelPath('t1', 'a1', 'image/webp').startsWith('/')).toBe(false)
  })
  it('sanitizes : and / out of the id so the path is a single component per segment (Windows forbids : in path segments)', () => {
    const id = 'msg-1:img:image/png:1024:AAAABBBB'
    expect(attachmentRelPath('t1', id, 'image/png')).toBe('t1/msg-1_img_image_png_1024_AAAABBBB.png')
  })
})
