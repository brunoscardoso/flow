import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from './db'
import { ThreadStore } from './thread-store'
import { AttachmentStore } from './attachment-store'
import type { MessageAttachmentInput } from '../../shared/ipc-contract'

/** A content-derived attachment id, exactly as the composer produces one
 *  (img:<mediaType>:<byteSize>:<fingerprint>) — deterministic per image. */
const IMG: MessageAttachmentInput = {
  id: 'img:image/png:1024:AAAABBBBCCCCDDDD',
  mediaType: 'image/png',
  fileName: 'shot.png',
  byteSize: 1024,
  dataBase64: Buffer.from('fake-png-bytes').toString('base64'),
}

describe('AttachmentStore', () => {
  let tempDir: string
  let db: FlowDatabase
  let threads: ThreadStore
  let store: AttachmentStore
  let threadId: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-attach-store-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    threads = new ThreadStore(db)
    store = new AttachmentStore(db, join(tempDir, 'attachments'))
    threadId = threads.createThread({ projectRoot: '/repo' }).id
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('persists the SAME image across two messages without a PK collision (#688-adjacent crash)', () => {
    const m1 = threads.appendMessage(threadId, 'user', 'first').id
    const m2 = threads.appendMessage(threadId, 'user', 'second').id

    const saved1 = store.save(threadId, m1, [IMG])
    // Before the fix this threw SQLITE_CONSTRAINT_PRIMARYKEY: the content-derived
    // input.id was the PRIMARY KEY, so the same image in a second message
    // collided and crashed threads:sendMessage.
    const saved2 = store.save(threadId, m2, [IMG])

    expect(saved1[0].id).not.toBe(saved2[0].id)
    expect(store.listForMessage(m1)).toHaveLength(1)
    expect(store.listForMessage(m2)).toHaveLength(1)
    // Each message's attachment reads its own bytes back.
    expect(store.read(saved1[0].id)?.dataUrl).toContain('base64,')
    expect(store.read(saved2[0].id)?.dataUrl).toContain('base64,')
  })

  it('namespaces the stored id by messageId so rows are per-message unique', () => {
    const m1 = threads.appendMessage(threadId, 'user', 'x').id
    const [saved] = store.save(threadId, m1, [IMG])
    expect(saved!.id).toBe(`${m1}:${IMG.id}`)
  })

  it('still stores several distinct images on one message', () => {
    const m1 = threads.appendMessage(threadId, 'user', 'multi').id
    const second: MessageAttachmentInput = { ...IMG, id: 'img:image/png:2048:ZZZZ', byteSize: 2048 }
    store.save(threadId, m1, [IMG, second])
    expect(store.listForMessage(m1)).toHaveLength(2)
  })
})
