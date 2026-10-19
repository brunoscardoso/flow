// Claude Code session importer — turns a project's on-disk Claude Code sessions
// into app threads. Dedup is by Claude sessionId → sdk_session_id, so a re-run
// only imports sessions not already present (idempotent). Because sessions live
// at `<session-id>.jsonl`, the dedup check runs against the FILENAME before the
// file is ever opened — a re-run with nothing to import reads zero transcripts
// (#1667). Read-only against ~/.claude; every write goes through
// ThreadStore.importThread.

import type { ThreadStore } from './store/thread-store'
import {
  listSessionFiles as defaultListSessionFiles,
  readSessionFile as defaultReadSessionFile,
  sessionIdFromFileName,
  type ParsedSession,
} from './claude-history'

/** Minimal store surface the importer needs (keeps it unit-testable). */
export type ClaudeImportStore = Pick<ThreadStore, 'getThreadBySdkSessionId' | 'importThread'>

/** The reader half of the importer — injectable so tests need no fs/module mock. */
export interface ClaudeSessionReader {
  listSessionFiles(rootPath: string): string[]
  readSessionFile(filePath: string): Promise<ParsedSession | null> | ParsedSession | null
}

const DEFAULT_READER: ClaudeSessionReader = {
  listSessionFiles: defaultListSessionFiles,
  readSessionFile: defaultReadSessionFile,
}

export interface ClaudeImportResult {
  imported: number
  skipped: number
}

/**
 * Import all of a project's Claude Code sessions that are not already present.
 * `rootPath` MUST be a validated project root (the reader path is derived in
 * main — never a renderer-supplied file path). Never throws for a project with
 * no Claude Code history — it simply imports nothing.
 *
 * Async on purpose: reads go through async fs and each file is awaited, so the
 * main process services IPC between transcripts instead of freezing for the
 * whole import (#1667).
 */
export async function importClaudeSessions(
  store: ClaudeImportStore,
  rootPath: string,
  reader: ClaudeSessionReader = DEFAULT_READER,
): Promise<ClaudeImportResult> {
  const importedAt = new Date().toISOString()
  let imported = 0
  let skipped = 0

  for (const file of reader.listSessionFiles(rootPath)) {
    // Dedup BEFORE the read: the filename is the session id, so an
    // already-imported session costs a store lookup, not a 13 MB parse.
    if (store.getThreadBySdkSessionId(sessionIdFromFileName(file))) {
      skipped++
      continue
    }
    const session = await reader.readSessionFile(file)
    // Unreadable, empty, or session-id-less files are not importable.
    if (!session || !session.sessionId) {
      skipped++
      continue
    }
    // Fallback dedup for files whose name is not their session id.
    if (store.getThreadBySdkSessionId(session.sessionId)) {
      skipped++
      continue
    }
    store.importThread({
      projectRoot: rootPath,
      title: session.title,
      sdkSessionId: session.sessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      importedAt,
      messages: session.messages.map((message) => ({
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      })),
    })
    imported++
    // BREATHE BETWEEN SESSIONS. Each file is a synchronous parse (up to 13 MB)
    // and a synchronous insert transaction, and main answers every IPC call the
    // reader is waiting on. The `await` above yields only when a file is
    // actually read; a run of small files would otherwise import the lot in one
    // uninterrupted block. One macrotask per import is enough for a pending
    // `threads:list` to be served in between, which is the difference between a
    // sidebar that fills in and a cursor that spins.
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  return { imported, skipped }
}
