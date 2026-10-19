import {
  SESSION_FAILURE_PREFIX,
  TURN_FAILURE_PREFIX,
  isTurnFailureNote,
  turnFailureDetail,
  turnFailureNote,
} from './turn-failure'

describe('isTurnFailureNote (#1048)', () => {
  it('classifies both persisted failure-note shapes', () => {
    expect(isTurnFailureNote(`${TURN_FAILURE_PREFIX} ECONNRESET while streaming`)).toBe(true)
    expect(isTurnFailureNote(`${SESSION_FAILURE_PREFIX} session crashed`)).toBe(true)
  })

  it('leaves the #981 interrupt note — and ordinary system rows — as calm notes', () => {
    expect(isTurnFailureNote('Interrupted by you')).toBe(false)
    expect(isTurnFailureNote('Thread imported from backup')).toBe(false)
    expect(isTurnFailureNote('')).toBe(false)
  })

  it('matches only as a PREFIX, not mid-content mentions', () => {
    expect(isTurnFailureNote('The note said "Agent turn failed:" earlier')).toBe(false)
  })
})

describe('the runtime\u2019s diagnostic never reaches the card', () => {
  // Reported 2026-09-09 with a screenshot: "Agent turn failed: [ede_diagnostic]
  // result_type=user last_content_type=n/a stop_reason=tool_use". Every field
  // there names the SDK's internals, and `stop_reason=tool_use` is an ORDINARY
  // mid-turn stop being reported as a failure.
  it('drops the diagnostic and says something a person can act on', () => {
    const raw = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'
    expect(turnFailureDetail(raw)).toBeNull()
    const note = turnFailureNote(raw)
    expect(note).not.toContain('ede_diagnostic')
    expect(note).not.toContain('stop_reason')
    expect(note).toContain('send again')
  })

  it('matches the SHAPE, so a renamed tag does not start leaking again', () => {
    expect(turnFailureDetail('[some_other_tag] a=1 b=2')).toBeNull()
    expect(turnFailureDetail('[ede_diagnostic] result_type=user stop_reason=null')).toBeNull()
  })

  it('keeps a real reason exactly as it was — that is the card\u2019s whole value', () => {
    const real = 'Credit balance is too low'
    expect(turnFailureDetail(real)).toBe(real)
    expect(turnFailureNote(real)).toBe(`${TURN_FAILURE_PREFIX} ${real}`)
  })

  it('does not mistake ordinary prose containing = for a diagnostic', () => {
    const prose = 'the tool returned exit=1 and no output'
    expect(turnFailureDetail(prose)).toBe(prose)
  })

  it('still renders as an error card either way', () => {
    expect(isTurnFailureNote(turnFailureNote(null))).toBe(true)
    expect(isTurnFailureNote(turnFailureNote('[ede_diagnostic] a=b'))).toBe(true)
    expect(isTurnFailureNote(turnFailureNote('real reason'))).toBe(true)
  })
})
