/**
 * The runtime half of a loops snapshot — the pauses in `flow/loops/state.json`.
 *
 * WHY IT EXISTS AT ALL is the bug it fixes: the directive reader beside it says
 * plainly that a loop's pause lives in state.json and is not read there, and the
 * handler built on it filled the gap with a hard-coded `pause: null`. That was
 * harmless while nothing in the app wrote a state pause and became a lie the
 * moment something did — the board's stop wrote one, so pressing pause did
 * nothing visible: the write landed, the read could not see it, and the button
 * stayed on "Stop".
 */

import { emptyRuntimeState, readRuntimeState } from './runtime-state-reader'

const NOW = Date.parse('2026-09-05T12:00:00.000Z')

const reader = (body: string) => () => Promise.resolve(body)
const missing = () => Promise.reject(new Error('ENOENT'))

describe('reading what is paused', () => {
  it('reports a per-loop pause with its reason', async () => {
    const state = await readRuntimeState(
      '/p/flow',
      NOW,
      reader(
        JSON.stringify({
          version: 1,
          loops: { fix: { pause: { reason: 'stopped from the task board', since: '2026-09-05T11:00:00.000Z' } } },
        }),
      ),
    )
    expect(state.pauses['fix']).toEqual({
      reason: 'stopped from the task board',
      since: '2026-09-05T11:00:00.000Z',
      until: null,
    })
  })

  it('reports a global pause separately from a loop’s own', async () => {
    const state = await readRuntimeState(
      '/p/flow',
      NOW,
      reader(JSON.stringify({ version: 1, globalPause: { reason: 'all stop', since: '' }, loops: {} })),
    )
    expect(state.globalPause?.reason).toBe('all stop')
    expect(state.pauses).toEqual({})
  })

  it('AN EXPIRED PAUSE IS NOT A PAUSE', async () => {
    // A board that went on showing one would report a loop as stopped while the
    // next run walks straight past it.
    const state = await readRuntimeState(
      '/p/flow',
      NOW,
      reader(
        JSON.stringify({
          version: 1,
          loops: { fix: { pause: { reason: 'an hour', since: '', until: '2026-09-05T11:00:00.000Z' } } },
        }),
      ),
    )
    expect(state.pauses['fix']).toBeUndefined()
  })

  it('keeps a pause whose expiry has not arrived', async () => {
    const state = await readRuntimeState(
      '/p/flow',
      NOW,
      reader(
        JSON.stringify({
          version: 1,
          loops: { fix: { pause: { reason: 'an hour', since: '', until: '2026-09-05T13:00:00.000Z' } } },
        }),
      ),
    )
    expect(state.pauses['fix']?.until).toBe('2026-09-05T13:00:00.000Z')
  })

  it('keeps a pause whose expiry cannot be read — dropping it would restart loops nobody re-authorized', async () => {
    const state = await readRuntimeState(
      '/p/flow',
      NOW,
      reader(JSON.stringify({ version: 1, loops: { fix: { pause: { reason: 'x', since: '', until: 'whenever' } } } })),
    )
    expect(state.pauses['fix']).toBeDefined()
  })

  it('a pause with no reason still reads as a pause', async () => {
    const state = await readRuntimeState(
      '/p/flow',
      NOW,
      reader(JSON.stringify({ version: 1, loops: { fix: { pause: { since: '' } } } })),
    )
    expect(state.pauses['fix']?.reason).toBe('paused')
  })
})

describe('fail-soft, like the directive reader beside it', () => {
  it('a missing file is the NORMAL case — nothing has ever been paused', async () => {
    expect(await readRuntimeState('/p/flow', NOW, missing)).toEqual(emptyRuntimeState())
  })

  it('a corrupt file reads as no pauses rather than refusing', async () => {
    // A board that will not draw because a local cache is malformed is worse
    // than one that draws what the committed directives say. The CLI is the
    // authority and refuses for itself.
    expect(await readRuntimeState('/p/flow', NOW, reader('{ not json'))).toEqual(emptyRuntimeState())
    expect(await readRuntimeState('/p/flow', NOW, reader('[]'))).toEqual(emptyRuntimeState())
  })

  it('a loop entry that is not an object costs only itself', async () => {
    const state = await readRuntimeState(
      '/p/flow',
      NOW,
      reader(JSON.stringify({ version: 1, loops: { bad: 7, fix: { pause: { reason: 'ok', since: '' } } } })),
    )
    expect(Object.keys(state.pauses)).toEqual(['fix'])
  })
})
