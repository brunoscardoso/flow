import {
  ALLOWED_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  attachmentId,
  canAddAttachment,
  isAllowedImageType,
  validateAttachment,
} from './image-attachment'

describe('isAllowedImageType (#456)', () => {
  it('accepts the four v1 image types, rejects everything else', () => {
    for (const type of ALLOWED_IMAGE_TYPES) expect(isAllowedImageType(type)).toBe(true)
    expect(isAllowedImageType('application/pdf')).toBe(false)
    expect(isAllowedImageType('text/plain')).toBe(false)
    expect(isAllowedImageType('image/svg+xml')).toBe(false)
    expect(isAllowedImageType('')).toBe(false)
  })
})

describe('validateAttachment', () => {
  it('accepts a well-formed image within the size cap', () => {
    expect(validateAttachment({ mediaType: 'image/png', byteSize: 1024 })).toEqual({ ok: true })
  })
  it('rejects a non-image type with a reason', () => {
    const v = validateAttachment({ mediaType: 'application/pdf', byteSize: 10 })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/images only/i)
  })
  it('rejects an empty image', () => {
    expect(validateAttachment({ mediaType: 'image/png', byteSize: 0 }).ok).toBe(false)
  })
  it('rejects an oversized image with a reason', () => {
    const v = validateAttachment({ mediaType: 'image/png', byteSize: MAX_IMAGE_BYTES + 1 })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/too large/i)
  })
})

describe('attachmentId', () => {
  it('is stable for identical inputs (dedupes a re-attached image) and varies otherwise', () => {
    expect(attachmentId('image/png', 100, 'abc')).toBe(attachmentId('image/png', 100, 'abc'))
    expect(attachmentId('image/png', 100, 'abc')).not.toBe(attachmentId('image/png', 100, 'xyz'))
  })
})

describe('canAddAttachment', () => {
  it('enforces the per-message cap', () => {
    expect(canAddAttachment(0)).toBe(true)
    expect(canAddAttachment(MAX_ATTACHMENTS_PER_MESSAGE - 1)).toBe(true)
    expect(canAddAttachment(MAX_ATTACHMENTS_PER_MESSAGE)).toBe(false)
  })
})
