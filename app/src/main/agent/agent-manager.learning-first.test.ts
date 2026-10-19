// AgentManager × basic discovery (decision 2026-10-06: a conversation starts
// only on projects Flow has learned) — a REAL ThreadStore over a temp
// better-sqlite3 DB, a fake SDK query and the REAL coordinator
// (learn/basic-discovery.ts) over fake sweeps.
//
// Proven here: a first message on a project without basic discovery is stored
// and HELD (no session starts) while the thread says why, then delivered when
// the sweep ends; a failure says so with Try again and never drops the
// message; and an attached project still being learned — by the person or by
// the first-message gate — is left out of the session's folders and joins on
// the next send after its sweep. One door: both paths ask `require`.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'

import type { AgentStreamEvent } from '../../shared/ipc-contract'
import type { CredentialsManager } from '../credentials'
import { createBasicDiscovery, type BasicDiscovery } from '../learn/basic-discovery'
import type { BasicDiscoveryRunOutcome } from '../project/learn-orchestrator'
import { openDatabase, type FlowDatabase } from '../store/db'
import { ThreadStore } from '../store/thread-store'
import { AGENT_STREAM_EVENT, AgentManager, type QueryFunction } from './agent-manager'
import { createContextGate } from './context-gate'
import { PermissionBroker } from './permissions'

interface FakeQuery {
  push(message: unknown): void
  close: jest.Mock
  interrupt: jest.Mock
  setModel: jest.Mock
  [Symbol.asyncIterator](): AsyncIterator<unknown>
}

function makeFakeQuery(): FakeQuery {
  const buffered: unknown[] = []
  let waiting: ((result: IteratorResult<unknown>) => void) | null = null
  let ended = false
  return {
    push(message) {
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: message, done: false })
      } else buffered.push(message)
    },
    close: jest.fn(() => {
      ended = true
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve({ value: undefined, done: true })
      }
    }),
    interrupt: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (buffered.length > 0) return Promise.resolve({ value: buffered.shift(), done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            waiting = resolve
          })
        },
      }
    },
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

describe('AgentManager × basic discovery', () => {
  let tempDir: string
  let api: string
  let web: string
  let db: FlowDatabase
  let store: ThreadStore
  let broker: PermissionBroker
  const credentialsStub = { get: () => null } as unknown as CredentialsManager

  /** Projects that have their basic discovery. */
  let discovered: Set<string>
  /** Sweeps in flight, by root — the test ends them. */
  let sweeps: Map<string, (outcome: BasicDiscoveryRunOutcome) => void>
  let sweepRuns: string[]
  let bd: BasicDiscovery

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'flow-learning-first-')))
    api = join(tempDir, 'orbit-core')
    web = join(tempDir, 'web')
    for (const dir of [api, web]) mkdirSync(dir)
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
    broker = new PermissionBroker(db)
    discovered = new Set()
    sweeps = new Map()
    sweepRuns = []
    bd = createBasicDiscovery({
      hasRecord: (root) => Promise.resolve(discovered.has(root)),
      record: (root) => {
        discovered.add(root)
        return Promise.resolve()
      },
      run: (root) => {
        sweepRuns.push(root)
        return new Promise((resolve) => sweeps.set(root, resolve))
      },
      isReady: () => true,
      inWorkspace: () => Promise.resolve(true),
      automatic: () => true,
      onChange: () => undefined,
      log: () => undefined,
    })
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function endSweep(root: string, outcome: BasicDiscoveryRunOutcome): void {
    const resolve = sweeps.get(root)
    if (resolve === undefined) throw new Error(`no sweep running for ${root}`)
    sweeps.delete(root)
    resolve(outcome)
  }

  function manager(options: { gateAttaches?: string } = {}) {
    const captured: Options[] = []
    const queries: FakeQuery[] = []
    const inputs: unknown[] = []
    const queryFn = jest.fn(({ prompt, options: opts }: { prompt: unknown; options?: Options }): Query => {
      captured.push(opts ?? {})
      inputs.push(prompt)
      const query = makeFakeQuery()
      queries.push(query)
      return query as unknown as Query
    }) as unknown as QueryFunction
    const gate =
      options.gateAttaches === undefined
        ? undefined
        : createContextGate({
            workspaceOf: async () => ({
              workspace: { slug: 'acme', name: 'Acme' },
              current: { slug: 'api', name: 'orbit-core', description: 'api', localPath: api, flowPath: join(tempDir, 'f1') },
              siblings: [{ slug: 'web', name: 'web', description: 'web', localPath: web, flowPath: join(tempDir, 'f2') }],
            }),
            askModel: async ({ prompt }) => (prompt.includes('"attached"') ? '{"primary":"api","attached":["web"]}' : null),
            attachedRoots: (threadId) => store.getThreadRoots(threadId),
            projectsChosen: () => false,
            attach: (threadId, roots) => {
              for (const root of roots) store.addThreadRoot(threadId, root)
              // What main wires: an attach goes through the same door.
              void bd.require(store.getThreadRoots(threadId))
            },
            recordNote: () => undefined,
            announceChosen: () => undefined,
            announceOffer: () => undefined,
            openRoot: async (localPath) => localPath,
            localDescriptions: { get: () => null, set: () => undefined },
            readHead: async () => null,
            log: () => undefined,
          })
    const instance = new AgentManager(store, credentialsStub, broker, {
      queryFn,
      titleGenerator: async () => null,
      loadExternalMcpServers: () => ({}),
      basicDiscovery: bd,
      ...(gate === undefined ? {} : { contextGate: gate }),
    })
    const events: AgentStreamEvent[] = []
    instance.on(AGENT_STREAM_EVENT, (event: AgentStreamEvent) => events.push(event))
    const learningFirst = (): AgentStreamEvent[] => events.filter((event) => event.kind === 'learning-first')
    return { instance, captured, queries, inputs, learningFirst }
  }

  async function finishTurn(query: FakeQuery, threadId: string): Promise<void> {
    query.push({ type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude' })
    store.appendMessage(threadId, 'assistant', 'done')
    query.push({ type: 'result', subtype: 'success', is_error: false, result: 'done', usage: { input_tokens: 1, output_tokens: 1 } })
    await flush()
  }

  it('a project WITH basic discovery sends at once — nothing waits', async () => {
    discovered.add(api)
    const { instance, captured, learningFirst } = manager()
    const thread = store.createThread({ projectRoot: api })
    await instance.sendMessage(thread.id, 'hello')
    expect(captured).toHaveLength(1)
    expect(learningFirst()).toEqual([])
    expect(sweepRuns).toEqual([])
    instance.dispose()
  })

  it('the first message waits for the sweep, says so, and is delivered when it is done', async () => {
    const { instance, captured, inputs, learningFirst } = manager()
    const thread = store.createThread({ projectRoot: api })
    const { messageId } = await instance.sendMessage(thread.id, 'add a discount field')
    await flush()
    // The sweep IS running (positive first) …
    expect(sweepRuns).toEqual([api])
    // … the message is stored, no session has started, and the thread says why.
    expect(store.listMessages(thread.id).map((message) => message.id)).toContain(messageId)
    expect(captured).toHaveLength(0)
    expect(learningFirst()).toEqual([{ kind: 'learning-first', threadId: thread.id, state: 'waiting', projects: ['orbit-core'] }])
    expect(instance.learningFirstState(thread.id)).toEqual({ state: 'waiting', projects: ['orbit-core'] })

    endSweep(api, { kind: 'done', learned: 3, failed: 0 })
    await flush()
    expect(captured).toHaveLength(1)
    const pending = (inputs[0] as { takePending(): Array<{ message: { content: unknown } }> }).takePending()
    expect(JSON.stringify(pending[0]?.message.content)).toContain('add a discount field')
    expect(learningFirst().map((event) => (event as { state: string }).state)).toEqual(['waiting', 'done'])
    expect(instance.learningFirstState(thread.id)).toBeNull()
    expect(discovered.has(api)).toBe(true)
    instance.dispose()
  })

  it('a second message sent while waiting is kept and delivered after the first', async () => {
    const { instance, captured, inputs } = manager()
    const thread = store.createThread({ projectRoot: api })
    await instance.sendMessage(thread.id, 'first ask')
    await instance.sendMessage(thread.id, 'and the tests')
    await flush()
    expect(captured).toHaveLength(0)
    expect(sweepRuns).toEqual([api])
    endSweep(api, { kind: 'done', learned: 1, failed: 0 })
    await flush()
    expect(captured).toHaveLength(1)
    const pending = (inputs[0] as { takePending(): Array<{ message: { content: unknown } }> }).takePending()
    expect(pending.map((entry) => JSON.stringify(entry.message.content))).toEqual([
      expect.stringContaining('first ask'),
      expect.stringContaining('and the tests'),
    ])
    instance.dispose()
  })

  it('a failed sweep says so with the reason and keeps the message; Try again runs it again and delivers', async () => {
    const { instance, captured, learningFirst } = manager()
    const thread = store.createThread({ projectRoot: api })
    await instance.sendMessage(thread.id, 'add a discount field')
    await flush()
    endSweep(api, { kind: 'failed', reason: 'None of the 2 parts Flow tried could be learned.' })
    await flush()
    expect(captured).toHaveLength(0)
    const failed = learningFirst().at(-1) as { state: string; detail?: string }
    expect(failed.state).toBe('failed')
    expect(failed.detail).toBe(
      "Flow couldn't learn orbit-core, so your message hasn't been sent yet. None of the 2 parts Flow tried could be learned.",
    )
    expect(store.listMessages(thread.id).map((message) => message.content)).toContain('add a discount field')

    await instance.retryLearningFirst(thread.id)
    await flush()
    expect(sweepRuns).toEqual([api, api])
    expect(instance.learningFirstState(thread.id)?.state).toBe('waiting')
    endSweep(api, { kind: 'done', learned: 2, failed: 0 })
    await flush()
    expect(captured).toHaveLength(1)
    instance.dispose()
  })

  it('an attached project still being learned is left out of the folders, and joins on the next send after its sweep', async () => {
    discovered.add(api)
    const { instance, captured, queries } = manager()
    const thread = store.createThread({ projectRoot: api })
    store.setThreadRoots(thread.id, [web])
    await instance.sendMessage(thread.id, 'first')
    await flush()
    // Positive first: the attached project's sweep IS running …
    expect(sweepRuns).toEqual([web])
    expect(bd.isDeferred(web)).toBe(true)
    // … the turn went ahead (its own project is learned) without it.
    expect(captured).toHaveLength(1)
    expect(captured[0].additionalDirectories?.includes(web) ?? false).toBe(false)
    await finishTurn(queries[0], thread.id)

    endSweep(web, { kind: 'done', learned: 1, failed: 0 })
    await flush()
    await instance.sendMessage(thread.id, 'second')
    expect(captured).toHaveLength(2)
    expect(captured[1].additionalDirectories).toContain(web)
    instance.dispose()
  })

  it('a project the first-message gate attaches waits the same way (one door)', async () => {
    discovered.add(api)
    const { instance, captured } = manager({ gateAttaches: web })
    const thread = store.createThread({ projectRoot: api })
    await instance.sendMessage(thread.id, 'Add a discount field to the orders endpoint and show it on the checkout screen.')
    await flush()
    expect(store.getThreadRoots(thread.id)).toEqual([web]) // the gate DID attach it
    expect(sweepRuns).toEqual([web])
    expect(captured).toHaveLength(1)
    expect(captured[0].additionalDirectories?.includes(web) ?? false).toBe(false)
    instance.dispose()
  })
})
