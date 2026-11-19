import { createHistoryQueue, draftHistoryScript, readDraftHistoryState, runDraftHistory, RESTORE_FAILED, UNDO_FAILED } from './draft-history-host'
import type { DraftHistoryApi } from './draft-history-host'

const target = { rootPath: '/p', canvas: 'checkout' }
const VERSIONS = [{ version: 'first', name: 'First', savedAt: '2026-11-18T10:00:00.000Z' }]

function fakeApi(overrides: Partial<DraftHistoryApi> = {}): DraftHistoryApi & { calls: string[] } {
  const calls: string[] = []
  const api: DraftHistoryApi = {
    undoCanvas: async () => {
      calls.push('undo')
      return { ok: true, files: ['cart.html'] }
    },
    undoCount: async () => {
      calls.push('count')
      return { count: 2 }
    },
    saveVersion: async (request) => {
      calls.push(`save:${request.name}`)
      return { ok: true, version: VERSIONS[0] }
    },
    listVersions: async () => {
      calls.push('list')
      return { versions: VERSIONS }
    },
    restoreVersion: async (request) => {
      calls.push(`restore:${request.version}`)
      return { ok: true, files: ['cart.html', 'layout.json'] }
    },
    ...overrides,
  }
  return Object.assign(api, { calls })
}

describe('runDraftHistory', () => {
  it('undoes the canvas and answers the files to reload and the new count', async () => {
    const api = fakeApi()
    expect(await runDraftHistory(api, target, { op: 'undo' }, { panelOpen: false })).toEqual({
      state: { done: 'undo', undoCount: 2 },
      files: ['cart.html'],
    })
  })

  it('asks the page to re-read the picked element only while the panel is open', async () => {
    const outcome = await runDraftHistory(fakeApi(), target, { op: 'undo' }, { panelOpen: true })
    expect(outcome.state.refresh).toBe(true)
    const restored = await runDraftHistory(fakeApi(), target, { op: 'restore', version: 'first' }, { panelOpen: true })
    expect(restored).toEqual({ state: { done: 'restore', undoCount: 2, refresh: true }, files: ['cart.html', 'layout.json'] })
  })

  it('answers a refusal as its sentence, with nothing to reload', async () => {
    const api = fakeApi({ undoCanvas: async () => ({ ok: false, reason: 'Nothing to undo.' }) })
    expect(await runDraftHistory(api, target, { op: 'undo' }, { panelOpen: false })).toEqual({
      state: { error: 'Nothing to undo.', undoCount: 2 },
      files: [],
    })
  })

  it('lists, saves and then lists again', async () => {
    const api = fakeApi()
    expect((await runDraftHistory(api, target, { op: 'list' }, { panelOpen: false })).state).toEqual({ versions: VERSIONS, undoCount: 2 })
    expect((await runDraftHistory(api, target, { op: 'save', name: 'First' }, { panelOpen: false })).state).toEqual({
      done: 'save',
      versions: VERSIONS,
    })
  })

  it('never lets an exception or a path reach the page', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('ENOENT /Users/someone/flow/drafts/x')
    }
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const undo = await runDraftHistory(fakeApi({ undoCanvas: boom }), target, { op: 'undo' }, { panelOpen: false })
      expect(undo).toEqual({ state: { error: UNDO_FAILED }, files: [] })
      const restore = await runDraftHistory(fakeApi({ restoreVersion: boom }), target, { op: 'restore', version: 'a' }, { panelOpen: false })
      expect(restore.state.error).toBe(RESTORE_FAILED)
      expect(JSON.stringify(restore)).not.toContain('/Users')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the page door', () => {
  it('reads the count, and says nothing when it cannot', async () => {
    expect(await readDraftHistoryState(fakeApi(), target)).toEqual({ undoCount: 2 })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const api = fakeApi({ undoCount: async () => Promise.reject(new Error('x')) })
      expect(await readDraftHistoryState(api, target)).toEqual({})
    } finally {
      warn.mockRestore()
    }
  })

  it('carries the state as data, never as code', () => {
    const script = draftHistoryScript({ error: "'); alert(1); ('" })
    expect(script).toBe(`window.flowCanvas && window.flowCanvas.history ? window.flowCanvas.history({"error":"'); alert(1); ('"}) : null`)
  })

  it('runs requests one after another', async () => {
    const queue = createHistoryQueue()
    const order: string[] = []
    const slow = queue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('first')
    })
    const fast = queue(async () => {
      order.push('second')
    })
    await Promise.all([slow, fast])
    expect(order).toEqual(['first', 'second'])
  })
})
