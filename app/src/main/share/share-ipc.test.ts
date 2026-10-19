/**
 * The share IPC handlers refuse any sender that is not the app window's own
 * top frame — before the client is touched (no file read, no request).
 */
const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>()

jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel)
    },
  },
}))

import type { ShareClient } from './share-client'
import { isAppMainFrame, registerShareChannels } from './share-ipc'

const APP_URL = 'file:///app/out/renderer/index.html'
const mainFrame = { name: 'main', url: APP_URL }
const sender = { mainFrame, id: 1 }
const trusted = { senderFrame: mainFrame, sender }
const subframe = { senderFrame: { name: 'walkthrough iframe', url: APP_URL }, sender }
/** The same window's top frame, navigated away from the app (review R2-M8). */
const navigatedFrame = { name: 'main', url: 'https://evil.example/' }
const navigated = { senderFrame: navigatedFrame, sender: { mainFrame: navigatedFrame, id: 1 } }

function fakeClient() {
  const calls: string[] = []
  const answer = async (name: string) => {
    calls.push(name)
    return { ok: true, share: null, local: null, views: [] }
  }
  const client = {
    get: () => answer('get'),
    check: () => answer('check'),
    publish: () => answer('publish'),
    updateAccess: () => answer('update'),
    revoke: () => answer('revoke'),
    views: () => answer('views'),
  } as unknown as ShareClient
  return { client, calls }
}

let warnSpy: jest.SpyInstance
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  handlers.clear()
})
afterEach(() => warnSpy.mockRestore())

const CHANNELS = ['share:get', 'share:check', 'share:publish', 'share:update', 'share:revoke', 'share:views'] as const

describe('share IPC sender check', () => {
  it("answers the app window's top frame, and refuses a subframe without touching the client", async () => {
    const { client, calls } = fakeClient()
    const dispose = registerShareChannels({
      client,
      isTrustedSender: (event) =>
        isAppMainFrame(event as never, (s: { id: number }) => s.id === 1, (url) => url === APP_URL),
    })
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort())

    // The positive: the trusted frame reaches the client on every channel.
    for (const channel of CHANNELS) {
      await handlers.get(channel)?.(trusted, { rootPath: '/r', docPath: 'd', id: 'shareABCD1234', confirmed: true })
    }
    expect(calls).toEqual(['get', 'check', 'publish', 'update', 'revoke', 'views'])

    calls.length = 0
    for (const event of [subframe, navigated]) {
      for (const channel of CHANNELS) {
        const result = await handlers.get(channel)?.(event, { rootPath: '/r', docPath: 'd', id: 'shareABCD1234', confirmed: true })
        expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
      }
    }
    expect(calls).toEqual([])
    dispose()
    expect(handlers.size).toBe(0)
  })

  it('a sender check that throws is a refusal, not an answer', async () => {
    const { client, calls } = fakeClient()
    registerShareChannels({
      client,
      isTrustedSender: () => {
        throw new Error('frame gone')
      },
    })
    expect(await handlers.get('share:get')?.(trusted, { rootPath: '/r', docPath: 'd' })).toMatchObject({
      ok: false,
      reason: 'unavailable',
    })
    expect(calls).toEqual([])
  })
})
