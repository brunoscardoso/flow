import {
  DRAFT_CANVAS_HISTORY,
  DRAFT_VERSION_NAME_MAX,
  draftVersionTimeText,
  parseDraftHistoryRequest,
} from './draft-history-messages'

const message = (rest: Record<string, unknown>): unknown => ({ type: DRAFT_CANVAS_HISTORY, ...rest })

describe('parseDraftHistoryRequest', () => {
  it('reads each request', () => {
    expect(parseDraftHistoryRequest(message({ op: 'undo' }))).toEqual({ op: 'undo' })
    expect(parseDraftHistoryRequest(message({ op: 'list' }))).toEqual({ op: 'list' })
    expect(parseDraftHistoryRequest(message({ op: 'save', name: '  First  ' }))).toEqual({ op: 'save', name: 'First' })
    expect(parseDraftHistoryRequest(message({ op: 'restore', version: 'first' }))).toEqual({ op: 'restore', version: 'first' })
  })

  it('refuses anything else', () => {
    expect(parseDraftHistoryRequest(null)).toBeNull()
    expect(parseDraftHistoryRequest([])).toBeNull()
    expect(parseDraftHistoryRequest({ op: 'undo' })).toBeNull()
    expect(parseDraftHistoryRequest(message({ op: 'wipe' }))).toBeNull()
    expect(parseDraftHistoryRequest(message({ op: 'save' }))).toBeNull()
    expect(parseDraftHistoryRequest(message({ op: 'save', name: '   ' }))).toBeNull()
    expect(parseDraftHistoryRequest(message({ op: 'save', name: 'x'.repeat(DRAFT_VERSION_NAME_MAX + 1) }))).toBeNull()
    expect(parseDraftHistoryRequest(message({ op: 'restore', version: '../x' }))).toBeNull()
    expect(parseDraftHistoryRequest(message({ op: 'restore', version: 7 }))).toBeNull()
  })
})

describe('draftVersionTimeText', () => {
  const now = new Date(2026, 10, 18, 15, 0).getTime()
  it('shows HH:MM for today and a short date otherwise', () => {
    expect(draftVersionTimeText(new Date(2026, 10, 18, 9, 5).toISOString(), now)).toBe('09:05')
    expect(draftVersionTimeText(new Date(2026, 10, 3, 9, 5).toISOString(), now)).toBe('Nov 3')
    expect(draftVersionTimeText(new Date(2025, 11, 25, 9, 5).toISOString(), now)).toBe('Dec 25')
  })
  it('shows nothing for a time it cannot read', () => {
    expect(draftVersionTimeText('', now)).toBe('')
    expect(draftVersionTimeText('not a date', now)).toBe('')
  })
})
