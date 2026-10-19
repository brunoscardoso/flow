// AttachmentStore — image attachment persistence (#456). Bytes live on disk under
// the app's userData (`<rootDir>/<threadId>/<id>.<ext>`); the DB holds only metadata
// (message_attachments, migration 15). Isolated from ThreadStore so the filesystem
// concern stays in one place; the messages:list handler merges list() into each
// user message, and attachments:read serves bytes as a data URL for the transcript.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { MessageAttachment, MessageAttachmentInput } from '../../shared/ipc-contract'
import { attachmentRelPath } from './attachment-path'
import type { FlowDatabase } from './db'

interface AttachmentRow {
  id: string
  message_id: string
  thread_id: string
  media_type: string
  file_name: string
  rel_path: string
  byte_size: number
  width: number | null
  height: number | null
  created_at: string
}

function toMessageAttachment(row: AttachmentRow): MessageAttachment {
  return {
    id: row.id,
    mediaType: row.media_type,
    fileName: row.file_name,
    byteSize: row.byte_size,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
  }
}

export class AttachmentStore {
  constructor(
    private readonly db: FlowDatabase,
    private readonly rootDir: string,
  ) {}

  /** Write each attachment's bytes to disk and insert its metadata row. */
  save(
    threadId: string,
    messageId: string,
    inputs: readonly MessageAttachmentInput[],
  ): MessageAttachment[] {
    const now = new Date().toISOString()
    const insert = this.db.prepare(
      `INSERT INTO message_attachments
         (id, message_id, thread_id, media_type, file_name, rel_path, byte_size, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const saved: MessageAttachment[] = []
    for (const input of inputs) {
      // `message_attachments.id` is the PRIMARY KEY and each row belongs to ONE
      // message (message_id column). `input.id` is content-derived
      // (img:<mediaType>:<size>:<fingerprint>) — great for the composer's
      // within-message dedupe, but the SAME image sent in two different messages
      // reuses that id and collided on the PK (SQLITE_CONSTRAINT_PRIMARYKEY,
      // crashing threads:sendMessage). Namespace the persisted id (and its file
      // path) by messageId so a re-sent image is a distinct row. messageId is a
      // fresh UUID per send and input.id is unique within a message, so the pair
      // is globally unique.
      const rowId = `${messageId}:${input.id}`
      const relPath = attachmentRelPath(threadId, rowId, input.mediaType)
      const absPath = join(this.rootDir, relPath)
      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, Buffer.from(input.dataBase64, 'base64'))
      insert.run(
        rowId,
        messageId,
        threadId,
        input.mediaType,
        input.fileName,
        relPath,
        input.byteSize,
        input.width ?? null,
        input.height ?? null,
        now,
      )
      saved.push({
        id: rowId,
        mediaType: input.mediaType,
        fileName: input.fileName,
        byteSize: input.byteSize,
        width: input.width,
        height: input.height,
      })
    }
    return saved
  }

  /** Attachment metadata for a message (empty when none) — DB only, no bytes. */
  listForMessage(messageId: string): MessageAttachment[] {
    const rows = this.db
      .prepare('SELECT * FROM message_attachments WHERE message_id = ? ORDER BY created_at')
      .all(messageId) as AttachmentRow[]
    return rows.map(toMessageAttachment)
  }

  /**
   * Absolute on-disk path for an attachment's bytes, confined to the store root
   * (#1063 — reveal in the OS file manager). Returns null when the id is unknown
   * OR the stored rel_path would resolve outside the root. Defense-in-depth: the
   * rel_path is server-written, but a resolved path is never trusted to stay
   * in-bounds — this mirrors the project `resolveInsideRoot` discipline so no
   * crafted id can steer a reveal outside the attachments directory.
   */
  absolutePath(attachmentId: string): string | null {
    const row = this.db
      .prepare('SELECT * FROM message_attachments WHERE id = ?')
      .get(attachmentId) as AttachmentRow | undefined
    if (!row) return null
    const abs = resolve(this.rootDir, row.rel_path)
    const rel = relative(this.rootDir, abs)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
    return abs
  }

  /** An attachment's bytes as a data URL for rendering (null → unknown/missing). */
  read(attachmentId: string): { dataUrl: string } | null {
    const row = this.db
      .prepare('SELECT * FROM message_attachments WHERE id = ?')
      .get(attachmentId) as AttachmentRow | undefined
    if (!row) return null
    try {
      const bytes = readFileSync(join(this.rootDir, row.rel_path))
      return { dataUrl: `data:${row.media_type};base64,${bytes.toString('base64')}` }
    } catch {
      // File missing/unreadable — degrade to no image rather than throwing.
      return null
    }
  }
}
