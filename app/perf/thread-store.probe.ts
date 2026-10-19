/**
 * The thread surface, at the size the complaint comes from.
 *
 * A long session is what a heavy user has, and every read here is on the path
 * between clicking a thread and seeing it. Two of them were already bounded
 * after a live 6.98 MB measurement; this probe keeps that honest and puts a
 * number on the rest — including the ones nobody has measured yet (search, the
 * sidebar list, the per-turn reconcile).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, type FlowDatabase } from '../src/main/store/db'
import { ThreadStore } from '../src/main/store/thread-store'
import { boundedToolCalls } from '../src/main/ipc/index'
import { measure, report, writeBaseline, type Measurement } from './harness'

/** The worst case a real user reaches — a long day in one thread. */
const TOOL_CALLS = 600
/** 8 KB of output per call: a file read, a grep result, a diff. */
const OUTPUT_BYTES = 8 * 1024
/** A Write's input is the whole file — the bulk left once outputs are bounded. */
const WRITE_BYTES = 14 * 1024
const MESSAGES = 1_200
/** Threads in the sidebar of somebody who has been using this for months. */
const THREADS = 200
/** What the renderer actually mounts — the bound the handlers pass. */
const OUTPUT_LIMIT = 60

describe('thread store at the size that hurts', () => {
  let dir: string
  let db: FlowDatabase
  let store: ThreadStore
  let bigThread: string
  let lastCallId = ''
  const measurements: Measurement[] = []

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-perf-'))
    db = openDatabase(join(dir, 'flow.sqlite'))
    store = new ThreadStore(db)

    const root = '/repo'
    for (let i = 0; i < THREADS; i += 1) {
      store.createThread({ workspaceRoot: root, title: `Thread ${String(i)}` })
    }
    const thread = store.createThread({ workspaceRoot: root, title: 'The long one' })
    bigThread = thread.id
    const output = JSON.stringify({ content: 'x'.repeat(OUTPUT_BYTES) })
    // …and one call in five is a Write carrying a whole file. That mix is what
    // the live 6.98 MB measurement was taken on; a session of nothing but Reads
    // would flatter every number here.
    const writeInput = JSON.stringify({
      file_path: '/repo/src/some/deep/path/file.ts',
      content: 'y'.repeat(WRITE_BYTES),
    })
    for (let i = 0; i < MESSAGES; i += 1) {
      store.appendMessage(bigThread, i % 2 === 0 ? 'user' : 'assistant', `message ${String(i)}`)
    }
    for (let i = 0; i < TOOL_CALLS; i += 1) {
      const isWrite = i % 5 === 0
      const call = store.recordToolCall({
        threadId: bigThread,
        toolName: isWrite ? 'Write' : 'Read',
        inputJson: isWrite
          ? writeInput
          : JSON.stringify({ file_path: `/repo/src/file-${String(i)}.ts` }),
      })
      store.updateToolCall(call.id, { status: 'success', outputJson: output })
      lastCallId = call.id
    }
  })

  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    report('thread store', measurements)
    writeBaseline('thread store', measurements)
  })

  it('measures every read on the open-a-thread path', async () => {
    measurements.push(
      await measure('threads:list (sidebar)', () => store.listThreads('/repo'), {
        items: THREADS + 1,
        bytesOf: true,
      }),
      await measure('threads:get (bounded)', () => store.getThread(bigThread), { bytesOf: true }),
      await measure(
        'messages:list (all)',
        () => store.listMessages(bigThread),
        { items: MESSAGES, bytesOf: true, note: 'what an unbounded read would cost' },
      ),
      await measure('messages:list (60)', () => store.listMessages(bigThread, { limit: 60 }), {
        bytesOf: true,
      }),
      await measure(
        'toolCalls:list (unbounded)',
        () => store.listToolCalls(bigThread),
        { items: TOOL_CALLS, bytesOf: true, note: 'the 4.96 MB that started this' },
      ),
      await measure(
        'toolCalls:list (bounded)',
        () =>
          boundedToolCalls(
            store.listToolCalls(bigThread, { outputLimit: OUTPUT_LIMIT }),
            OUTPUT_LIMIT,
          ),
        { bytesOf: true, note: 'what crosses IPC today' },
      ),
      await measure(
        'sqlite: bounded in the query',
        () => store.listToolCalls(bigThread, { outputLimit: OUTPUT_LIMIT }),
        { items: TOOL_CALLS, bytesOf: true, note: 'what main allocates to answer it' },
      ),
      await measure('toolCalls:get (one)', () => store.getToolCall(bigThread, lastCallId), {
        bytesOf: true,
        note: 'what a card costs when the reader opens it',
      }),
      // What MAIN allocates to answer the bounded read — not what crosses IPC.
      // A megabyte of strings built and thrown away is still a megabyte of
      // strings, on the process every window waits behind (pattern #19).
      await measure(
        'sqlite: every row, every blob',
        () =>
          db
            .prepare('SELECT * FROM tool_calls WHERE thread_id = ? ORDER BY started_at ASC, id ASC')
            .all(bigThread),
        { items: TOOL_CALLS, bytesOf: true, note: 'the read behind the bounded answer' },
      ),
      await measure(
        'sqlite: outputs, no inputs',
        () =>
          db
            .prepare(
              'SELECT id, thread_id, message_id, tool_name, output_json, status, started_at,' +
                ' completed_at FROM tool_calls WHERE thread_id = ? ORDER BY started_at ASC, id ASC',
            )
            .all(bigThread),
        { items: TOOL_CALLS, bytesOf: true, note: 'how much of the read is the outputs' },
      ),
      await measure(
        'sqlite: metadata only',
        () =>
          db
            .prepare(
              'SELECT id, thread_id, message_id, tool_name, status, started_at, completed_at' +
                ' FROM tool_calls WHERE thread_id = ? ORDER BY started_at ASC, id ASC',
            )
            .all(bigThread),
        { items: TOOL_CALLS, bytesOf: true, note: 'the same rows without their outputs' },
      ),
      // WHAT EVERY TURN COMPLETION READS. The brain's working-set capture asks
      // for every tool call's input on each successful turn — to pull one field
      // out of each (`file_path`).
      await measure('capture: every input (per turn)', () => store.listToolCallInputs(bigThread), {
        items: TOOL_CALLS,
        bytesOf: true,
        note: 'what the capture used to read on every successful turn',
      }),
      await measure('capture: just the paths', () => store.listToolCallPaths(bigThread), {
        items: TOOL_CALLS,
        bytesOf: true,
        note: 'what it reads now — the one field it looks at',
      }),
      await measure('threads:search', () => store.searchThreads('message', '/repo'), {
        bytesOf: true,
      }),
      // FULL-TEXT SEARCH, at the size a heavy user's profile reaches: the real
      // one measured here holds 21,745 messages across 122 threads.
      await measure('threads:search (fts, common word)', () => store.searchThreads('lorem', '/repo'), {
        bytesOf: true,
        note: 'a word that hits every thread — the worst case for the index',
      }),
    )
    // The probe asserts nothing about speed — a threshold here would turn a
    // measurement into a flaky test. It records; the reader decides.
    expect(measurements.length).toBeGreaterThan(0)
  })
})
