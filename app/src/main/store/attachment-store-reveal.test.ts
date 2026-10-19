import { join, resolve } from 'node:path'

import { AttachmentStore } from './attachment-store'
import type { FlowDatabase } from './db'

// A minimal db stub: absolutePath() only ever calls prepare(sql).get(id). We
// map ids to { rel_path } rows so the confinement logic is tested WITHOUT the
// native better-sqlite3 binary (AttachmentStore imports FlowDatabase type-only).
function stubDb(rows: Record<string, { rel_path: string } | undefined>): FlowDatabase {
  return {
    prepare: () => ({
      get: (id: string) => rows[id],
    }),
  } as unknown as FlowDatabase
}

const ROOT = '/attach/root'

describe('AttachmentStore.absolutePath (reveal guard #1063)', () => {
  it('resolves a valid id to an absolute path inside the attachments root', () => {
    const store = new AttachmentStore(stubDb({ a1: { rel_path: 't1/a1.png' } }), ROOT)
    expect(store.absolutePath('a1')).toBe(join(ROOT, 't1/a1.png'))
  })

  it('returns null for an unknown id', () => {
    const store = new AttachmentStore(stubDb({}), ROOT)
    expect(store.absolutePath('nope')).toBeNull()
  })

  it('rejects a stored rel_path that traverses outside the root', () => {
    const store = new AttachmentStore(stubDb({ evil: { rel_path: '../../etc/passwd' } }), ROOT)
    expect(store.absolutePath('evil')).toBeNull()
  })

  it('rejects a stored rel_path that is absolute', () => {
    const store = new AttachmentStore(stubDb({ evil: { rel_path: '/etc/passwd' } }), ROOT)
    expect(store.absolutePath('evil')).toBeNull()
  })

  it('rejects a rel_path that resolves back to the root itself', () => {
    const store = new AttachmentStore(stubDb({ dot: { rel_path: '.' } }), ROOT)
    expect(store.absolutePath('dot')).toBeNull()
  })

  it('keeps a nested rel_path confined', () => {
    const store = new AttachmentStore(stubDb({ ok: { rel_path: 'thread/deep/x.webp' } }), ROOT)
    expect(store.absolutePath('ok')).toBe(resolve(ROOT, 'thread/deep/x.webp'))
  })
})
