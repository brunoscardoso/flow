import {
  HAR_MAX_BYTES,
  TEXT_ATTACH_MAX_BYTES,
  classifyAttachment,
  rejectReasonMessage,
} from './text-file-attach'

describe('classifyAttachment (#772)', () => {
  it('images keep the vision pipeline', () => {
    expect(classifyAttachment('shot.png', 'image/png', 100)).toBe('image')
  })

  it('markdown and common text/code files classify as text', () => {
    expect(classifyAttachment('notes.md', '', 100)).toBe('text')
    expect(classifyAttachment('README.markdown', '', 100)).toBe('text')
    expect(classifyAttachment('data.json', 'application/json', 100)).toBe('text')
    expect(classifyAttachment('script.py', '', 100)).toBe('text')
    expect(classifyAttachment('anything.weird', 'text/plain', 100)).toBe('text')
  })

  it('extension matching is case-insensitive', () => {
    expect(classifyAttachment('SPEC.MD', '', 100)).toBe('text')
  })

  it('oversized text is refused loudly, not silently truncated', () => {
    expect(classifyAttachment('huge.log', '', TEXT_ATTACH_MAX_BYTES + 1)).toBe('text-too-large')
    expect(classifyAttachment('fits.log', '', TEXT_ATTACH_MAX_BYTES)).toBe('text')
  })

  it('binary/unknown files are unsupported', () => {
    expect(classifyAttachment('app.zip', 'application/zip', 100)).toBe('unsupported')
    expect(classifyAttachment('noext', '', 100)).toBe('unsupported')
  })

  it('a 0-byte text file classifies as text-empty, never a silent drop (#1086)', () => {
    expect(classifyAttachment('empty.md', '', 0)).toBe('text-empty')
    expect(classifyAttachment('empty.txt', 'text/plain', 0)).toBe('text-empty')
    // 0-byte images stay on the image pipeline (validateAttachment refuses them).
    expect(classifyAttachment('empty.png', 'image/png', 0)).toBe('image')
    // Unsupported wins over empty — the type is the more useful refusal.
    expect(classifyAttachment('empty.zip', 'application/zip', 0)).toBe('unsupported')
  })
})

describe('rejectReasonMessage (#1086)', () => {
  it('names the file and states the reason for every reject class', () => {
    expect(rejectReasonMessage('big.log', 'text-too-large')).toBe(
      `big.log is too large to attach as text (limit ${Math.round(TEXT_ATTACH_MAX_BYTES / 1024)} KB).`,
    )
    expect(rejectReasonMessage('empty.md', 'text-empty')).toBe('empty.md is empty (nothing to attach).')
    expect(rejectReasonMessage('locked.md', 'unreadable')).toBe('locked.md could not be read.')
    expect(rejectReasonMessage('report.pdf', 'unsupported')).toBe(
      "report.pdf isn't a supported attachment (images, text files and .har recordings).",
    )
  })
})

describe('a network recording is read, not pasted', () => {
  // A .har fell between the two existing answers and was refused by both: the
  // extension is not on the text list, and a real capture (1–22 MB) is far
  // past the text cap anyway. Reported 2026-09-09 as "add compatibility to add
  // to the chat .har files".
  it('classifies a .har by NAME, whatever type the OS reports', () => {
    // Browsers hand a .har over as application/json or as an empty string
    // depending on the platform, so the media type decides nothing here.
    for (const type of ['application/json', 'text/plain', '', 'application/octet-stream']) {
      expect(classifyAttachment('capture.har', type, 5_600_000)).toBe('har')
    }
    expect(classifyAttachment('CAPTURE.HAR', '', 1024)).toBe('har')
  })

  it('is not bound by the text cap, which is the whole point', () => {
    // 22 MB is refused as text and accepted as a recording: it is summarised,
    // never pasted into the message.
    const big = 22 * 1024 * 1024
    expect(classifyAttachment('capture.json', 'application/json', big)).toBe('text-too-large')
    expect(classifyAttachment('capture.har', 'application/json', big)).toBe('har')
  })

  it('still has a ceiling, because the renderer parses it', () => {
    expect(classifyAttachment('huge.har', '', HAR_MAX_BYTES + 1)).toBe('har-too-large')
    expect(classifyAttachment('empty.har', '', 0)).toBe('text-empty')
  })

  it('leaves every other classification exactly as it was', () => {
    expect(classifyAttachment('shot.png', 'image/png', 1024)).toBe('image')
    expect(classifyAttachment('notes.md', 'text/markdown', 1024)).toBe('text')
    expect(classifyAttachment('report.pdf', 'application/pdf', 1024)).toBe('unsupported')
  })

  it('says why a recording was refused, in its own words', () => {
    expect(rejectReasonMessage('big.har', 'har-too-large')).toContain('too large to read')
    expect(rejectReasonMessage('odd.har', 'har-unreadable')).toBe(
      "odd.har isn't a HAR network recording Flow can read.",
    )
  })
})
