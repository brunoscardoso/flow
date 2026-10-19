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
