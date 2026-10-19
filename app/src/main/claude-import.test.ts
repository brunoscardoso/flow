// claude-import tests — importer dedup + counts against a fake store and an
// injected reader (no real filesystem, no real DB, no module mocking).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ParsedSession } from './claude-history'
import { claudeProjectDir, listSessionFiles, readSessionFile } from './claude-history'
import { openDatabase, type FlowDatabase } from './store/db'
import { ThreadStore, type ThreadRecord } from './store/thread-store'
import { importClaudeSessions, type ClaudeSessionReader } from './claude-import'

const ROOT = '/Users/x/proj'

function session(id: string): ParsedSession {
  return {
    sessionId: id,
    title: `session ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    messages: [{ role: 'user', content: 'hi', createdAt: '2026-01-01T00:00:00.000Z' }],
  }
}

/**
 * A reader that maps file path → ParsedSession | null from a fixed table,
 * counting reads so tests can assert dedup happened BEFORE the file was opened.
 */
function fakeReader(table: Record<string, ParsedSession | null>): ClaudeSessionReader & { reads: number } {
  const reader = {
    reads: 0,
    listSessionFiles: () => Object.keys(table),
    readSessionFile(filePath: string) {
      reader.reads++
      return table[filePath] ?? null
    },
  }
  return reader
}

/** A fake store recording imports, with a settable set of already-present ids. */
function fakeStore(present: string[] = []) {
  const existing = new Set(present)
  const imported: string[] = []
  return {
    imported,
    getThreadBySdkSessionId(id: string): ThreadRecord | null {
      return existing.has(id) ? ({ id: 'x' } as ThreadRecord) : null
    },
    importThread(input: { sdkSessionId: string }): ThreadRecord {
      imported.push(input.sdkSessionId)
      existing.add(input.sdkSessionId)
      return { id: input.sdkSessionId } as ThreadRecord
    },
  }
}

describe('importClaudeSessions', () => {
  it('imports every new session and reports the count', async () => {
    const store = fakeStore()
    const reader = fakeReader({ '/a.jsonl': session('a'), '/b.jsonl': session('b') })

    const result = await importClaudeSessions(store, ROOT, reader)

    expect(result).toEqual({ imported: 2, skipped: 0 })
    expect(store.imported).toEqual(['a', 'b'])
  })

  it('skips sessions already present (dedup) — idempotent re-run', async () => {
    const store = fakeStore(['a']) // 'a' already imported
    const reader = fakeReader({ '/a.jsonl': session('a'), '/b.jsonl': session('b') })

    const result = await importClaudeSessions(store, ROOT, reader)

    expect(result).toEqual({ imported: 1, skipped: 1 })
    expect(store.imported).toEqual(['b'])
  })

  it('dedups by FILENAME before opening the file — an already-imported session costs zero reads (#1667)', async () => {
    const store = fakeStore(['a']) // filename 'a.jsonl' → session id 'a', already present
    const reader = fakeReader({ '/a.jsonl': session('a'), '/b.jsonl': session('b') })

    const result = await importClaudeSessions(store, ROOT, reader)

    expect(result).toEqual({ imported: 1, skipped: 1 })
    expect(reader.reads).toBe(1) // only '/b.jsonl' was read; '/a.jsonl' never opened
  })

  it('falls back to the parsed sessionId for a file whose name is not its session id', async () => {
    const store = fakeStore(['a']) // session 'a' present, but its file is named oddly
    const reader = fakeReader({ '/renamed-copy.jsonl': session('a') })

    const result = await importClaudeSessions(store, ROOT, reader)

    expect(result).toEqual({ imported: 0, skipped: 1 })
    expect(reader.reads).toBe(1) // filename gave no match, so the read happened — then parsed-id dedup caught it
    expect(store.imported).toEqual([])
  })

  it('skips unreadable/empty sessions (null) and session-id-less ones', async () => {
    const store = fakeStore()
    const reader = fakeReader({
      '/a.jsonl': null,
      '/b.jsonl': { ...session('b'), sessionId: '' },
      '/c.jsonl': session('c'),
    })

    const result = await importClaudeSessions(store, ROOT, reader)

    expect(result).toEqual({ imported: 1, skipped: 2 })
    expect(store.imported).toEqual(['c'])
  })

  it('reports zero for a project with no Claude Code history', async () => {
    const store = fakeStore()
    await expect(importClaudeSessions(store, ROOT, fakeReader({}))).resolves.toEqual({
      imported: 0,
      skipped: 0,
    })
  })

  it('passes the original session timestamps + a fresh importedAt through to the store', async () => {
    const captured: Array<{ sdkSessionId: string; createdAt: string; importedAt: string }> = []
    const store = {
      getThreadBySdkSessionId: () => null,
      importThread: (input: { sdkSessionId: string; createdAt: string; importedAt: string }) => {
        captured.push(input)
        return { id: input.sdkSessionId } as ThreadRecord
      },
    }
    await importClaudeSessions(store, ROOT, fakeReader({ '/a.jsonl': session('a') }))
    expect(captured[0]?.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(captured[0]?.importedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

// End-to-end against the REAL reader + a REAL better-sqlite3 store, using this
// machine's actual Claude Code sessions for the plan-flow repo. Guarded: skipped
// when no such sessions exist, so CI/other machines don't depend on them.
describe('importClaudeSessions (live: real reader + real DB)', () => {
  const repoRoot = '/Users/dev/Projects/Personal/plan-flow'
  const hasStore = listSessionFiles(repoRoot).length > 0
  const maybe = hasStore ? it : it.skip

  let tempDir: string
  let db: FlowDatabase
  let store: ThreadStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-claude-import-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  maybe('imports real sessions once and is idempotent on re-run', async () => {
    expect(claudeProjectDir(repoRoot)).toContain('-Users-dev-Projects-Personal-plan-flow')

    const first = await importClaudeSessions(store, repoRoot)
    expect(first.imported).toBeGreaterThan(0)

    const threads = store.listThreads(repoRoot)
    expect(threads.length).toBe(first.imported)
    for (const thread of threads) {
      expect(thread.importedAt).not.toBeNull()
      expect(thread.sdkSessionId).toBeTruthy()
      expect(store.listMessages(thread.id).length).toBeGreaterThan(0)
    }

    // Second run: nothing new is imported, every file is accounted for, and —
    // the point of #1667 — no ALREADY-IMPORTED session is re-read, because
    // dedup matches the filename before the file is opened.
    let reads = 0
    const countingReader = {
      listSessionFiles,
      readSessionFile: (filePath: string) => {
        reads++
        return readSessionFile(filePath)
      },
    }
    const second = await importClaudeSessions(store, repoRoot, countingReader)
    expect(second.imported).toBe(0)

    // `skipped` COUNTS THREE DIFFERENT THINGS — already-imported, unimportable
    // (empty/unreadable/no session id), and the fallback dedup — so
    // `second.skipped === first.imported` only holds when every file on disk
    // imports cleanly. This directory has one that does not, and the assertion
    // went red for a reason that was never about the code: a real directory
    // holds whatever it holds (forbidden-pattern #19).
    //
    // The invariant that IS true: every file is accounted for, both times.
    expect(second.skipped).toBe(first.imported + first.skipped)

    // …and the read count is the claim #1667 actually makes. An unimportable
    // file is re-read, correctly — it was never imported, so there is nothing
    // for the filename dedup to match. What must never be re-read is a session
    // already in the store, and that is what this pins.
    expect(reads).toBe(first.skipped)
    expect(store.listThreads(repoRoot).length).toBe(first.imported)
  })
})
