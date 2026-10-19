import {
  collapseRepeats,
  describeTarget,
  formatInteraction,
  formatLongTask,
  formatStartup,
  whileWaitingFor,
} from './perf-lines'

/**
 * These lines are the whole product of the instrument. They are read by
 * somebody holding a complaint and nothing else, so each one has to survive
 * being read cold, months later.
 */
describe('a slow moment, written down', () => {
  it('says what was in flight — or says that nothing was', () => {
    // The distinction that ends investigations: blocked-while-waiting and
    // blocked-while-computing look identical to the person feeling them.
    expect(whileWaitingFor(['project:listAllFiles 820ms'])).toBe(
      'waiting on project:listAllFiles 820ms',
    )
    expect(whileWaitingFor([])).toBe('nothing in flight')
  })

  it('reports a blocked frame with its cost and its context', () => {
    expect(formatLongTask(912.4, ['git:status 400ms'])).toBe(
      '[renderer] blocked for 912ms (waiting on git:status 400ms)',
    )
  })

  it('splits an interaction into waiting and working', () => {
    // "I click the input and the cursor spins" is usually ALL delay — the press
    // was fine, the thread was busy. A total-only line could never say so.
    const line = formatInteraction({
      name: 'click',
      total: 800,
      delay: 760,
      handler: 40,
      target: 'textarea[composer-input]',
      inFlight: [],
    })
    expect(line).toBe(
      '[renderer] click on textarea[composer-input] took 800ms ' +
        '(760ms waiting for the thread, 40ms in the handler, nothing in flight)',
    )
  })

  it('reports startup in the stages a person notices', () => {
    expect(formatStartup({ scriptMs: 120, shellMs: 300, firstPaintMs: 450 })).toBe(
      '[renderer] startup: script 120ms, shell 300ms, first paint 450ms',
    )
  })
})

describe('naming what was clicked', () => {
  const el = (attrs: Record<string, string>, className = ''): Parameters<typeof describeTarget>[0] =>
    ({
      tagName: 'BUTTON',
      className,
      getAttribute: (name: string) => attrs[name] ?? null,
    })

  it('prefers the name the app already gave it', () => {
    expect(describeTarget(el({ 'data-testid': 'send' }))).toBe('button[send]')
    expect(describeTarget(el({ 'aria-label': 'Stop' }))).toBe('button[Stop]')
  })

  it('falls back to the first class, then to the tag', () => {
    expect(describeTarget(el({}, 'gp-action-btn gp-action-side'))).toBe('button.gp-action-btn')
    expect(describeTarget(el({}))).toBe('button')
  })

  it('never throws on an event with no target', () => {
    expect(describeTarget(null)).toBe('the window')
  })
})

describe('a burst is one entry with a count', () => {
  it('collapses the same event repeating, whatever its milliseconds', () => {
    // A stall produces forty long tasks, and forty near-identical lines hide
    // the one different line between them.
    expect(
      collapseRepeats([
        '[renderer] blocked for 300ms (nothing in flight)',
        '[renderer] blocked for 412ms (nothing in flight)',
        '[renderer] blocked for 250ms (nothing in flight)',
        '[renderer] click on button.send took 900ms (…)',
      ]),
    ).toEqual([
      '[renderer] blocked for 300ms (nothing in flight) (×3)',
      '[renderer] click on button.send took 900ms (…)',
    ])
  })

  it('keeps distinct lines distinct', () => {
    const lines = ['[renderer] blocked for 300ms (waiting on a 1ms)', '[renderer] blocked for 300ms (nothing in flight)']
    expect(collapseRepeats(lines)).toEqual(lines)
  })
})
