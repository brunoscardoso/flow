// LspManager lifecycle tests against a REAL child process: a scripted fake
// LSP server (spawned as `<node> -e <script>`) that speaks Content-Length
// framed JSON-RPC over stdio. The fake server reports what it received back
// through publishDiagnostics messages, which is the one observable channel
// the client exposes — so double didOpens (LOG-12), backoff bypasses
// (LOG-13) and large-document sync floods (PERF-5) all become assertable.
//
// Under scripts/run-jest.mjs, process.execPath is Electron running as Node
// (ELECTRON_RUN_AS_NODE=1 is inherited by the spawned child), so `-e` behaves
// exactly like plain `node -e`.

import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  LARGE_DOCUMENT_SYNC_INTERVAL_MS,
  LARGE_DOCUMENT_THRESHOLD_BYTES,
  LSP_DIAGNOSTICS_EVENT,
  LspManager,
  type LanguageServerConfig,
  type LspDiagnosticsEvent,
} from './lsp-manager'

// ── Fake LSP server ──────────────────────────────────────────────────────
//
// Behaviors:
//   · appends one line to $FAKE_LSP_SPAWN_LOG on boot (spawn counting)
//   · initialize → { capabilities: {} }
//   · didOpen    → publishDiagnostics message `didOpen#<count-for-uri>`
//   · didChange  → publishDiagnostics message `didChange#<version>`;
//                  exits(1) first when the new text contains 'CRASH'
//   · exit       → process.exit(0); other requests → null result

const FAKE_SERVER_SCRIPT = `
const fs = require('fs')
if (process.env.FAKE_LSP_SPAWN_LOG) fs.appendFileSync(process.env.FAKE_LSP_SPAWN_LOG, 'spawn\\n')
let buffer = Buffer.alloc(0)
const opens = Object.create(null)
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n')
  process.stdout.write(body)
}
function diagnostics(uri, message) {
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message }
  ] } })
}
function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
    return
  }
  if (message.method === 'textDocument/didOpen') {
    const uri = message.params.textDocument.uri
    opens[uri] = (opens[uri] || 0) + 1
    diagnostics(uri, 'didOpen#' + opens[uri])
    return
  }
  if (message.method === 'textDocument/didChange') {
    if (message.params.contentChanges[0].text.includes('CRASH')) process.exit(1)
    diagnostics(message.params.textDocument.uri, 'didChange#' + message.params.textDocument.version)
    return
  }
  if (message.method === 'exit') process.exit(0)
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: null })
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n')
    if (headerEnd < 0) return
    const match = /Content-Length:\\s*(\\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))
    const length = Number(match[1])
    if (buffer.length < headerEnd + 4 + length) return
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')
    buffer = buffer.subarray(headerEnd + 4 + length)
    handle(JSON.parse(body))
  }
})
`

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition not met within timeout')
    }
    await sleep(25)
  }
}

describe('LspManager against a scripted fake server', () => {
  let root: string
  let spawnLog: string
  let manager: LspManager
  let diagnostics: LspDiagnosticsEvent[]

  const messages = (): string[] =>
    diagnostics.flatMap((event) => event.diagnostics.map((diagnostic) => diagnostic.message))

  function spawnCount(): number {
    try {
      return readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flow-lsp-'))
    spawnLog = join(root, 'spawn.log')
    const config: LanguageServerConfig = {
      id: 'fake',
      command: process.execPath,
      args: ['-e', FAKE_SERVER_SCRIPT],
      env: { FAKE_LSP_SPAWN_LOG: spawnLog, ELECTRON_RUN_AS_NODE: '1' },
      fileExtensions: ['.foo'],
    }
    manager = new LspManager()
    manager.registerServer(config)
    diagnostics = []
    manager.on(LSP_DIAGNOSTICS_EVENT, (event: LspDiagnosticsEvent) => diagnostics.push(event))
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  it('sends exactly one textDocument/didOpen for concurrent opens of one document (LOG-12)', async () => {
    const file = join(root, 'a.foo')

    const results = await Promise.all([
      manager.didOpen(root, file, 'same text'),
      manager.didOpen(root, file, 'same text'),
      manager.didOpen(root, file, 'same text'),
      manager.didOpen(root, file, 'same text'),
    ])
    expect(results).toEqual([true, true, true, true])

    await waitFor(() => messages().includes('didOpen#1'))
    await sleep(200) // settle: a protocol-violating second didOpen would land here
    expect(messages()).toContain('didOpen#1')
    expect(messages()).not.toContain('didOpen#2')
    expect(spawnCount()).toBe(1)
  })

  it('folds a concurrent open with NEWER text into a didChange, not a second didOpen (LOG-12)', async () => {
    const file = join(root, 'b.foo')

    await Promise.all([
      manager.didOpen(root, file, 'first text'),
      manager.didOpen(root, file, 'second text'),
    ])

    await waitFor(() => messages().includes('didChange#2'))
    expect(messages()).toContain('didOpen#1')
    expect(messages()).not.toContain('didOpen#2')
  })

  it('honors the crash-restart backoff instead of spawning immediately (LOG-13)', async () => {
    const file = join(root, 'c.foo')
    await manager.didOpen(root, file, 'initial')
    expect(spawnCount()).toBe(1)

    // Make the server crash, leaving one open document → a restart is
    // scheduled with RESTART_BASE_DELAY_MS (1s) of backoff.
    await manager.didChange(root, file, 'CRASH')
    await sleep(300) // let the exit event land and the restart get scheduled

    // A request during the backoff window must NOT spawn a server instantly…
    const change = manager.didChange(root, file, 'hello after restart')
    await sleep(400) // well inside the 1s backoff
    expect(spawnCount()).toBe(1)

    // …but must resolve once the scheduled restart brings the server up.
    await change
    expect(spawnCount()).toBe(2)
    // The restarted server replayed the document (its own didOpen#1) and then
    // received the pending change.
    await waitFor(() => {
      const fromRestart = diagnostics.slice()
      return (
        fromRestart.some((event) => event.diagnostics[0]?.message === 'didOpen#1') &&
        fromRestart.some((event) => event.diagnostics[0]?.message.startsWith('didChange#'))
      )
    })
  }, 15_000)

  it('throttles didChange for large documents and trailing-flushes the latest text (PERF-5)', async () => {
    const file = join(root, 'd.foo')
    await manager.didOpen(root, file, 'small')

    const large = 'a'.repeat(LARGE_DOCUMENT_THRESHOLD_BYTES + 16)

    // Leading edge: the first over-threshold change syncs immediately (v2).
    await manager.didChange(root, file, large)
    await waitFor(() => messages().includes('didChange#2'))

    // Inside the throttle window: deferred, not sent…
    await manager.didChange(root, file, `${large}b`)
    await sleep(300)
    expect(messages()).not.toContain('didChange#3')

    // …until the trailing flush ships the LATEST text (v3).
    await waitFor(
      () => messages().includes('didChange#3'),
      LARGE_DOCUMENT_SYNC_INTERVAL_MS + 3_000,
    )

    // Small documents keep syncing immediately.
    await manager.didChange(root, file, 'small again')
    await waitFor(() => messages().includes('didChange#4'))
  }, 15_000)
})
