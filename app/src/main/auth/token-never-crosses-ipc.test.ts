/**
 * THE SESSION TOKEN NEVER CROSSES IPC.
 *
 * The contract states this as an invariant at the top of `ipc-contract.ts` —
 * "no channel may return a credential value, and none should carry one either"
 * — and an invariant nobody asserts is a sentence.
 *
 * This drives the REAL handlers with a REAL stored identity carrying a
 * recognisable token, and reads what they answer. The store's own tests prove
 * the token round-trips; this proves it stops at the process boundary.
 */
/** The channels register against electron's ipcMain; this captures them. */
const mockHandlers = new Map<string, (event: unknown, request: unknown) => unknown>()
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, request: unknown) => unknown): void => {
      mockHandlers.set(channel, handler)
    },
    removeHandler: (channel: string): void => {
      mockHandlers.delete(channel)
    },
  },
}))

import { registerSettingsChannels } from '../settings/ipc'
import { createIdentityStore, type StoredIdentity } from './identity-store'

const TOKEN = 'flow-session-THIS-MUST-NEVER-LEAVE-MAIN'

const IDENTITY: StoredIdentity = {
  subject: 'github|42',
  displayName: 'Dev User',
  token: TOKEN,
  expiresAt: null,
}

/** A real store holding a real token. */
function realStore() {
  let file: Buffer | null = null
  return createIdentityStore({
    encryption: {
      isEncryptionAvailable: () => true,
      encryptString: (p) => Buffer.from(`enc:${p}`, 'utf8'),
      decryptString: (b) => {
        const t = b.toString('utf8')
        if (!t.startsWith('enc:')) throw new Error('nope')
        return t.slice(4)
      },
    },
    read: () => file,
    write: (data) => {
      file = data
    },
    remove: () => {
      file = null
    },
  })
}

/** Captures every response the auth channels give. */
function driveChannels() {
  const store = realStore()
  store.save(IDENTITY)
  // The store really does hold it — otherwise every absence below is vacuous.
  expect(store.load()?.token).toBe(TOKEN)

  mockHandlers.clear()
  registerSettingsChannels({
    appSettings: {
      getTelemetryConsent: () => null,
      setTelemetryConsent: () => {},
      getUseDays: () => 0,
      getConsentAsks: () => 0,
      recordConsentAsk: () => {},
    },
    identity: {
      // HANDS OVER THE WHOLE RECORD, TOKEN AND ALL — on purpose.
      //
      // The first version of this test had the dep strip the token itself, so
      // the handler's own stripping was never exercised: planting a
      // pass-through leak in the handler did not fail the suite. That is a test
      // asserting its own harness.
      //
      // There are two layers in production — main's closure builds a narrow
      // object, and the handler rebuilds one — and this makes the SECOND
      // load-bearing by simulating a careless first. A future wiring that
      // forgets to strip is exactly what this now catches.
      load: () => store.load() as unknown as { subject: string; displayName: string | null },
      signOut: () => store.signOut(),
    },
    signIn: async () => ({ ok: true as const, subject: IDENTITY.subject, displayName: 'Dev User' }),
    signInAvailable: () => true,
    broadcast: () => {},
  } as never)
  const handlers = new Map<string, (request: unknown) => unknown>()
  for (const [channel, fn] of mockHandlers) handlers.set(channel, (request) => fn({}, request))
  return { handlers, store }
}

describe('the session token stops at the process boundary', () => {
  it('is held by the store — so the absences below mean something', () => {
    const { store } = driveChannels()
    expect(store.load()?.token).toBe(TOKEN)
  })

  it('does not appear in what any auth channel answers', async () => {
    const { handlers } = driveChannels()
    const answers: unknown[] = []
    for (const channel of ['auth:whoAmI', 'auth:available', 'auth:signIn', 'auth:signOut']) {
      const handler = handlers.get(channel)
      expect(handler).toBeDefined()
      answers.push(await handler?.({}))
    }
    const wire = JSON.stringify(answers)
    expect(wire).not.toContain(TOKEN)
    expect(wire).not.toContain('flow-session')
    expect(wire).not.toMatch(/\btoken\b/i)
  })

  it('answers whoAmI with exactly a subject and a display name', async () => {
    const { handlers } = driveChannels()
    const who = (await handlers.get('auth:whoAmI')?.({})) as Record<string, unknown>
    expect(Object.keys(who).sort()).toEqual(['displayName', 'subject'])
  })

  // A REBUILT OBJECT, not the stored record. The only thing keeping a live
  // credential out of the renderer is that nobody hands it over — so this pins
  // that the handler constructs its answer rather than passing through.
  it('does not hand back the stored record itself', async () => {
    const { handlers, store } = driveChannels()
    const who = await handlers.get('auth:whoAmI')?.({})
    expect(who).not.toBe(store.load())
    expect(who).not.toHaveProperty('token')
    expect(who).not.toHaveProperty('expiresAt')
  })

  it('still says nothing about a token after signing out', async () => {
    const { handlers } = driveChannels()
    const report = await handlers.get('auth:signOut')?.({})
    expect(JSON.stringify(report)).not.toContain(TOKEN)
    const after = await handlers.get('auth:whoAmI')?.({})
    expect(after).toBeNull()
  })
})
