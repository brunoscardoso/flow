import {
  DRAFT_STORE_CAP,
  draftFor,
  parseDraftStore,
  serializeDraftStore,
  withDraft,
  type DraftStore,
} from './composer-draft'

describe('composer per-thread drafts (#1067)', () => {
  describe('parseDraftStore', () => {
    it('degrades malformed input to an empty store', () => {
      expect(parseDraftStore(null)).toEqual([])
      expect(parseDraftStore('')).toEqual([])
      expect(parseDraftStore('not json')).toEqual([])
      expect(parseDraftStore('{"a":1}')).toEqual([])
      expect(parseDraftStore('[["ok","draft"],["bad"],[1,2],["","x"],["id",3]]')).toEqual([
        ['ok', 'draft'],
      ])
    })

    it('round-trips through serializeDraftStore', () => {
      const store = withDraft(withDraft([], 't1', 'hello'), 't2', 'world')
      expect(parseDraftStore(serializeDraftStore(store))).toEqual(store)
    })

    it('caps an oversized persisted list, keeping the newest entries', () => {
      const big = JSON.stringify(
        Array.from({ length: DRAFT_STORE_CAP + 10 }, (_, i) => [`t${i}`, `d${i}`]),
      )
      const parsed = parseDraftStore(big)
      expect(parsed).toHaveLength(DRAFT_STORE_CAP)
      expect(parsed[parsed.length - 1]).toEqual([`t${DRAFT_STORE_CAP + 9}`, `d${DRAFT_STORE_CAP + 9}`])
    })
  })

  describe('draftFor / withDraft', () => {
    it('stores and restores a draft per thread id', () => {
      let store: DraftStore = []
      store = withDraft(store, 'a', 'draft for A')
      store = withDraft(store, 'b', 'draft for B')
      expect(draftFor(store, 'a')).toBe('draft for A')
      expect(draftFor(store, 'b')).toBe('draft for B')
      expect(draftFor(store, 'c')).toBe('')
    })

    it('a whitespace-only draft removes the entry (clear-on-send)', () => {
      let store = withDraft([], 'a', 'about to send')
      store = withDraft(store, 'a', '')
      expect(store).toEqual([])
      store = withDraft(withDraft([], 'a', 'x'), 'a', '   \n ')
      expect(draftFor(store, 'a')).toBe('')
    })

    it('is a no-op (same reference) when nothing changes', () => {
      const empty: DraftStore = []
      expect(withDraft(empty, 'a', '   ')).toBe(empty)
      const store = withDraft([], 'a', 'text')
      expect(withDraft(store, 'a', 'text')).toBe(store)
    })

    it('updates in place move the thread to the most-recent slot', () => {
      let store: DraftStore = []
      store = withDraft(store, 'a', 'one')
      store = withDraft(store, 'b', 'two')
      store = withDraft(store, 'a', 'one edited')
      expect(store.map(([id]) => id)).toEqual(['b', 'a'])
      expect(draftFor(store, 'a')).toBe('one edited')
    })

    it('caps the store, evicting the least-recently-saved thread', () => {
      let store: DraftStore = []
      for (let i = 0; i < DRAFT_STORE_CAP + 5; i++) {
        store = withDraft(store, `t${i}`, `draft ${i}`)
      }
      expect(store).toHaveLength(DRAFT_STORE_CAP)
      expect(draftFor(store, 't0')).toBe('') // evicted
      expect(draftFor(store, `t${DRAFT_STORE_CAP + 4}`)).toBe(`draft ${DRAFT_STORE_CAP + 4}`)
    })
  })
})
