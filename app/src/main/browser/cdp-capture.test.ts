// CDP console + network capture over the guest `webContents.debugger`.
//
// Electron is never required here: the guest and its debugger are plain objects
// with only the methods `attachCdpCapture` touches (allowed-pattern #12 in
// spirit — mock the module surface, not the environment). Two behaviours matter:
// the attach → detach lifecycle, and graceful degradation when a debugger is
// already attached (real DevTools open), which `debugger.attach` signals by
// throwing.

import { attachCdpCapture } from './cdp-capture'
import { RollingBuffer } from './rolling-buffer'
import type { WebContents } from 'electron'

interface FakeDebugger {
  attach: jest.Mock
  detach: jest.Mock
  isAttached: jest.Mock
  on: jest.Mock
  removeListener: jest.Mock
  sendCommand: jest.Mock
}

interface FakeGuest {
  debugger: FakeDebugger
  on: jest.Mock
  once: jest.Mock
  removeListener: jest.Mock
}

function makeGuest(attachThrows = false): FakeGuest {
  const dbg: FakeDebugger = {
    attach: jest.fn(() => {
      if (attachThrows) throw new Error('Another debugger is already attached')
    }),
    detach: jest.fn(),
    isAttached: jest.fn(() => true),
    on: jest.fn(),
    removeListener: jest.fn(),
    sendCommand: jest.fn(() => Promise.resolve({})),
  }
  return { debugger: dbg, on: jest.fn(), once: jest.fn(), removeListener: jest.fn() }
}

/** The registered `dbg.on('message', …)` handler the CDP layer wired up. */
function messageHandler(
  guest: FakeGuest,
): (event: unknown, method: string, params: unknown) => void {
  const entry = guest.debugger.on.mock.calls.find(([evt]) => evt === 'message')
  if (!entry) throw new Error('no message listener registered')
  return entry[1] as (event: unknown, method: string, params: unknown) => void
}

describe('attach lifecycle', () => {
  it('attaches, enables domains, and reports available()===true', () => {
    const guest = makeGuest()
    const buffer = new RollingBuffer()
    const handle = attachCdpCapture(guest as unknown as WebContents, buffer, jest.fn())

    expect(guest.debugger.attach).toHaveBeenCalledWith('1.3')
    expect(handle.available()).toBe(true)
    // Listeners for the two message/detach channels + the guest lifecycle events.
    expect(guest.debugger.on).toHaveBeenCalledWith('message', expect.any(Function))
    expect(guest.debugger.on).toHaveBeenCalledWith('detach', expect.any(Function))
    expect(guest.on).toHaveBeenCalledWith('did-navigate', expect.any(Function))
    expect(guest.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
  })

  it('detach() tears down listeners, detaches the debugger, and flips available()', () => {
    const guest = makeGuest()
    const handle = attachCdpCapture(guest as unknown as WebContents, new RollingBuffer(), jest.fn())

    handle.detach()

    expect(handle.available()).toBe(false)
    expect(guest.debugger.detach).toHaveBeenCalledTimes(1)
    expect(guest.debugger.removeListener).toHaveBeenCalledWith('message', expect.any(Function))
    expect(guest.on).toHaveBeenCalledWith('did-navigate', expect.any(Function))
    expect(guest.removeListener).toHaveBeenCalledWith('did-navigate', expect.any(Function))
  })

  it('detach() is idempotent — a second call does not detach twice', () => {
    const guest = makeGuest()
    const handle = attachCdpCapture(guest as unknown as WebContents, new RollingBuffer(), jest.fn())
    handle.detach()
    handle.detach()
    expect(guest.debugger.detach).toHaveBeenCalledTimes(1)
  })
})

describe('DevTools-contention degradation', () => {
  it('returns an inert handle when debugger.attach throws — available()===false, no crash', () => {
    const guest = makeGuest(true)
    const buffer = new RollingBuffer()
    const onUpdated = jest.fn()

    const handle = attachCdpCapture(guest as unknown as WebContents, buffer, onUpdated)

    expect(handle.available()).toBe(false)
    // No listeners wired, nothing enabled, and detach() is a safe no-op.
    expect(guest.debugger.on).not.toHaveBeenCalled()
    expect(guest.on).not.toHaveBeenCalled()
    expect(() => handle.detach()).not.toThrow()
    expect(guest.debugger.detach).not.toHaveBeenCalled()
    expect(onUpdated).not.toHaveBeenCalled()
  })
})

describe('event capture wiring', () => {
  it('routes a console message into the buffer and notifies onBufferUpdated', () => {
    const guest = makeGuest()
    const buffer = new RollingBuffer()
    const onUpdated = jest.fn()
    attachCdpCapture(guest as unknown as WebContents, buffer, onUpdated)

    messageHandler(guest)({}, 'Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'boom' }],
      timestamp: 1234,
    })

    expect(buffer.counts().console).toBe(1)
    const [entry] = buffer.slice('console', { mode: 'last-n', n: 1 })
    expect(entry.kind).toBe('console')
    expect(onUpdated).toHaveBeenCalledWith('console', expect.objectContaining({ console: 1 }))
  })

  it('ignores messages once detached (no capture after teardown)', () => {
    const guest = makeGuest()
    const buffer = new RollingBuffer()
    const handle = attachCdpCapture(guest as unknown as WebContents, buffer, jest.fn())
    const handler = messageHandler(guest)

    handle.detach()
    handler({}, 'Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ type: 'string', value: 'late' }],
      timestamp: 1,
    })

    expect(buffer.counts().console).toBe(0)
  })
})

describe('network facts for the Network panel', () => {
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  it('records type, initiator, sizes, cache, timing phases and the address', async () => {
    const guest = makeGuest()
    const buffer = new RollingBuffer()
    attachCdpCapture(guest as unknown as WebContents, buffer, jest.fn())
    const emit = messageHandler(guest)
    emit(null, 'Network.requestWillBeSent', {
      requestId: 'r1',
      type: 'Fetch',
      initiator: { type: 'script', stack: { callFrames: [{ functionName: 'load', url: 'http://localhost:3000/app.js', lineNumber: 9, columnNumber: 2 }] } },
      request: { url: 'http://localhost:3000/api/desks', method: 'GET', headers: {} },
      timestamp: 100,
      wallTime: 1_700_000_000,
    })
    emit(null, 'Network.responseReceived', {
      requestId: 'r1',
      type: 'Fetch',
      response: {
        url: 'http://localhost:3000/api/desks', status: 200, headers: { 'content-type': 'application/json' }, mimeType: 'application/json',
        remoteIPAddress: '127.0.0.1', remotePort: 3000, protocol: 'http/1.1',
        timing: { requestTime: 100, dnsStart: -1, dnsEnd: -1, connectStart: -1, connectEnd: -1, sslStart: -1, sslEnd: -1, sendStart: 1, sendEnd: 2, receiveHeadersEnd: 42 },
      },
    })
    emit(null, 'Network.dataReceived', { requestId: 'r1', dataLength: 3000 })
    emit(null, 'Network.dataReceived', { requestId: 'r1', dataLength: 1200 })
    emit(null, 'Network.loadingFinished', { requestId: 'r1', timestamp: 100.05, encodedDataLength: 1840 })
    await flush()
    const [capture] = buffer.slice('network', { mode: 'last-n', n: 1 })
    expect(capture?.kind === 'network' && capture.payload).toMatchObject({
      resourceType: 'Fetch',
      mimeType: 'application/json',
      transferBytes: 1840,
      resourceBytes: 4200,
      remoteAddress: '127.0.0.1:3000',
      protocol: 'http/1.1',
      initiator: { type: 'script', url: 'http://localhost:3000/app.js', line: 10 },
      phases: { queued: 1, send: 1, wait: 40, download: 8 },
      ts: 1_700_000_000_000,
    })
  })

  it('keeps a redirect’s hop as its own row, and says why a request failed', async () => {
    const guest = makeGuest()
    const buffer = new RollingBuffer()
    attachCdpCapture(guest as unknown as WebContents, buffer, jest.fn())
    const emit = messageHandler(guest)
    emit(null, 'Network.requestWillBeSent', { requestId: 'r2', request: { url: 'http://localhost:3000/old', method: 'GET', headers: {} }, timestamp: 1 })
    emit(null, 'Network.requestWillBeSent', {
      requestId: 'r2',
      redirectResponse: { url: 'http://localhost:3000/old', status: 301, headers: { location: '/new' } },
      request: { url: 'http://localhost:3000/new', method: 'GET', headers: {} },
      timestamp: 1.01,
    })
    emit(null, 'Network.loadingFailed', { requestId: 'r2', timestamp: 1.02, errorText: 'net::ERR_CONNECTION_REFUSED' })
    emit(null, 'Network.requestWillBeSent', { requestId: 'r3', request: { url: 'http://localhost:3000/logo.svg', method: 'GET', headers: {} }, timestamp: 2 })
    emit(null, 'Network.requestServedFromCache', { requestId: 'r3' })
    emit(null, 'Network.loadingFinished', { requestId: 'r3', timestamp: 2.001, encodedDataLength: 0 })
    await flush()
    const payloads = buffer.slice('network', { mode: 'last-n', n: 5 }).map((capture) => (capture.kind === 'network' ? capture.payload : null))
    expect(payloads[0]).toMatchObject({ url: 'http://localhost:3000/old', status: 301, redirectedTo: 'http://localhost:3000/new' })
    expect(payloads[1]).toMatchObject({ url: 'http://localhost:3000/new', status: 0, failure: 'net::ERR_CONNECTION_REFUSED' })
    expect(payloads[2]).toMatchObject({ url: 'http://localhost:3000/logo.svg', servedFrom: 'memory cache', transferBytes: 0 })
  })

  it('reports DOMContentLoaded and load in wall-clock time, reset by a navigation', () => {
    const guest = makeGuest()
    const handle = attachCdpCapture(guest as unknown as WebContents, new RollingBuffer(), jest.fn())
    const emit = messageHandler(guest)
    emit(null, 'Network.requestWillBeSent', { requestId: 'd', request: { url: 'http://localhost:3000/', method: 'GET', headers: {} }, timestamp: 50, wallTime: 1000 })
    emit(null, 'Page.domContentEventFired', { timestamp: 50.4 })
    emit(null, 'Page.loadEventFired', { timestamp: 50.6 })
    expect(handle.pageTimings()).toMatchObject({ domContentLoaded: 1_000_400, load: 1_000_600 })
    const navigate = guest.on.mock.calls.find(([event]) => event === 'did-navigate')?.[1] as () => void
    navigate()
    expect(handle.pageTimings()).toMatchObject({ domContentLoaded: null, load: null })
  })
})

describe('where a page starts', () => {
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  it('starts a new page at the main frame’s document request, not at the late did-navigate', async () => {
    const guest = makeGuest()
    guest.debugger.sendCommand.mockImplementation((method: string) =>
      Promise.resolve(method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'top' } } } : {}),
    )
    const buffer = new RollingBuffer()
    attachCdpCapture(guest as unknown as WebContents, buffer, jest.fn())
    // The domains are enabled one after another; let every step settle.
    for (let i = 0; i < 10; i++) await flush()
    const emit = messageHandler(guest)
    const finish = (id: string, url: string, extra: Record<string, unknown> = {}): void => {
      emit(null, 'Network.requestWillBeSent', { requestId: id, request: { url, method: 'GET', headers: {} }, timestamp: 1, ...extra })
      emit(null, 'Network.loadingFinished', { requestId: id, timestamp: 1.01 })
    }
    finish('old', 'http://localhost:3000/old-page-call')
    // An iframe's document is not a new page.
    finish('frame', 'http://localhost:3000/embed', { type: 'Document', frameId: 'child' })
    finish('doc', 'http://localhost:3000/', { type: 'Document', frameId: 'top' })
    // The new page's script starts a request…
    emit(null, 'Network.requestWillBeSent', { requestId: 'early', request: { url: 'http://localhost:3000/api/early', method: 'GET', headers: {} }, timestamp: 1.02 })
    // …and only then does main hear did-navigate. It must not drop it.
    const navigate = guest.on.mock.calls.find(([event]) => event === 'did-navigate')?.[1] as () => void
    navigate()
    emit(null, 'Network.loadingFinished', { requestId: 'early', timestamp: 1.03 })
    await flush()
    const urls = buffer.slice('network', { mode: 'since-nav' }).map((capture) => (capture.kind === 'network' ? capture.payload.url : ''))
    expect(urls).toEqual(['http://localhost:3000/', 'http://localhost:3000/api/early'])
  })
})
