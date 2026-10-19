/**
 * What a turn costs the main process, per event.
 *
 * The agent SDK runs IN main: every streamed token, every tool call and every
 * tool result is parsed, translated, persisted and broadcast on the thread that
 * draws the UI. A person running agents all day is running this all day, which
 * is exactly when the app was reported as unusable — and none of it crosses a
 * measurement boundary, so none of it has ever been counted.
 *
 * A real turn needs a model. The bridge does not: it takes SDK messages and a
 * store, both of which can be real here. So this feeds a turn's worth of
 * traffic through the real bridge into a real SQLite store and reports the cost
 * per event and per turn.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase, type FlowDatabase } from '../src/main/store/db'
import { ThreadStore } from '../src/main/store/thread-store'
import { StreamBridge } from '../src/main/agent/stream-bridge'
import type { AgentStreamEvent } from '../src/shared/ipc-contract'
import { measure, report, writeBaseline, type Measurement } from './harness'

/** A busy turn: a paragraph of tokens, then a tool, over and over. */
const TOOL_CALLS = 200
/** Token deltas per paragraph — the SDK emits one per few characters. */
const DELTAS_PER_BLOCK = 40
/** A tool result's size — a file read, a grep, a diff. */
const RESULT_BYTES = 8 * 1024

describe('one agent turn, through the real bridge', () => {
  let dir: string
  let db: FlowDatabase
  let store: ThreadStore
  const measurements: Measurement[] = []

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-perf-agent-'))
    db = openDatabase(join(dir, 'flow.db'))
    store = new ThreadStore(db)
  })
  afterAll(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
    report('agent turn', measurements)
    writeBaseline('agent turn', measurements)
  })

  /** Feed a whole turn through a fresh bridge; returns what it emitted. */
  function runTurn(toolCalls: number): { events: number; result: string } {
    const thread = store.createThread({ workspaceRoot: '/repo', title: 'turn' })
    const emitted: AgentStreamEvent[] = []
    const bridge = new StreamBridge(thread.id, store, {
      emit: (event: AgentStreamEvent) => emitted.push(event),
      onSessionId: () => undefined,
      onTurnComplete: () => undefined,
    } as unknown as ConstructorParameters<typeof StreamBridge>[2])

    const send = (message: unknown): void => bridge.handleMessage(message as never)
    send({ type: 'system', subtype: 'init', session_id: 'sess-1' })
    const output = 'x'.repeat(RESULT_BYTES)

    for (let call = 0; call < toolCalls; call += 1) {
      send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } })
      send({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      })
      for (let delta = 0; delta < DELTAS_PER_BLOCK; delta += 1) {
        send({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'token ' },
          },
        })
      }
      send({
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_stop', index: 0 },
      })
      send({
        type: 'assistant',
        // The bridge ignores sub-agent traffic (`parent_tool_use_id`), so a
        // synthetic turn without this field measures the ignore path.
        parent_tool_use_id: null,
        message: {
          id: `msg-${String(call)}`,
          content: [
            { type: 'text', text: 'token '.repeat(DELTAS_PER_BLOCK) },
            {
              type: 'tool_use',
              id: `tool-${String(call)}`,
              name: call % 5 === 0 ? 'Write' : 'Read',
              input: { file_path: `/repo/src/file-${String(call)}.ts` },
            },
          ],
        },
      })
      send({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: `tool-${String(call)}`, content: output },
          ],
        },
      })
    }
    send({ type: 'result', subtype: 'success', result: 'done', session_id: 'sess-1' })
    return { events: emitted.length, result: thread.id }
  }

  it('measures the cost of a turn on the thread that draws the UI', async () => {
    // A probe that measures nothing is worse than no probe: prove the traffic
    // actually landed before believing any number below it.
    const sanity = runTurn(5)
    const persisted = store.listToolCalls(sanity.result)
    console.log(
      `sanity: ${String(sanity.events)} events emitted, ` +
        `${String(persisted.length)} tool calls persisted, ` +
        `${String(store.listMessages(sanity.result).length)} messages persisted`,
    )
    expect(persisted.length).toBeGreaterThan(0)
    const perTurn = await measure('a 200-tool turn', () => runTurn(TOOL_CALLS), {
      runs: 3,
      items: TOOL_CALLS,
      note: `${String(TOOL_CALLS * (DELTAS_PER_BLOCK + 6))} SDK messages`,
    })
    measurements.push(perTurn)
    const messages = TOOL_CALLS * (DELTAS_PER_BLOCK + 6)
    measurements.push({
      name: 'per SDK message',
      ms: Math.round((perTurn.ms / messages) * 10000) / 10000,
      note: 'main-process time, per streamed event',
    })
    // And the pieces, so a regression names itself.
    measurements.push(
      await measure('1,000 text deltas', () => {
        const thread = store.createThread({ workspaceRoot: '/repo' })
        const bridge = new StreamBridge(thread.id, store, {
          emit: () => undefined,
          onSessionId: () => undefined,
          onTurnComplete: () => undefined,
        } as unknown as ConstructorParameters<typeof StreamBridge>[2])
        bridge.handleMessage({ type: 'system', subtype: 'init', session_id: 's' } as never)
        bridge.handleMessage({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start' },
        } as never)
        bridge.handleMessage({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        } as never)
        for (let i = 0; i < 1_000; i += 1) {
          bridge.handleMessage({
            type: 'stream_event',
            parent_tool_use_id: null,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'token ' },
            },
          } as never)
        }
      }),
    )
    expect(perTurn.ms).toBeGreaterThan(0)
  })
})
