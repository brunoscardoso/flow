/**
 * THE LEAK TEST — by reading what would go out, not by reading what the code
 * intended (forbidden-pattern #7).
 *
 * Everything else in this folder tests a rule. This tests the PROMISE: that no
 * path, no repository name, no prompt text and none of this machine's own
 * strings can reach the wire — proven by assembling the fullest possible
 * version of every event the app can emit, pushing it through the real door and
 * the real delivery chain, and then searching the actual bytes.
 *
 * It uses THIS machine's real strings — the home directory, the working
 * directory, the user name, the repository folder — rather than invented ones,
 * because an invented secret proves only that the invented secret was not
 * included. If Flow ever starts reading something off the machine into an
 * event, these are the strings it would be carrying.
 *
 * The e2e half of Phase 6 — driving a real thread, a real debug capture and a
 * real terminal command and reading the same bytes off a network boundary —
 * needs somewhere for the bytes to go, which is Phase 4's host. This is the
 * part that can be true today, and it is the structural half: the set of
 * things that CAN be sent is closed and enumerable, so it can be enumerated.
 */

import { homedir, hostname, userInfo } from 'node:os'
import { basename } from 'node:path'

import { createTelemetryDelivery } from './telemetry-delivery'
import { createTelemetryService } from './telemetry-service'
import { installPayload } from './install-facts'
import { usageEvent } from '../../shared/telemetry-events'
import { EVENT_NAMES } from '../../shared/telemetry-allowlist'
import type { TelemetryPayload } from './telemetry-boundary'
import type { EventShapes } from '../../shared/telemetry-events'

/** The fullest form of every event, so nothing is untested by omission. */
const EVERY_EVENT: { [K in keyof EventShapes]: EventShapes[K] } = {
  'session.started': { at: 1, sessionId: 'sess-1' },
  'session.ended': { at: 2, durationMs: 1000, sessionId: 'sess-1' },
  'thread.created': { at: 3, provider: 'claude', model: 'opus', threadCount: 12 },
  'debug.session.finished': { at: 4, durationMs: 9000, count: 3720 },
  'worktree.created': { at: 5, projectCount: 3 },
  'app.failed': { at: 6, errorKind: 'db-write', count: 1 },
}

/**
 * Strings from THIS machine that must never appear on the wire.
 *
 * Real, not invented. Short and generic ones are filtered out — a two-letter
 * user name would match inside a base64 id and the test would be noise rather
 * than signal.
 */
function machineSecrets(): string[] {
  const candidates = [
    homedir(),
    process.cwd(),
    basename(process.cwd()),
    userInfo().username,
    hostname(),
    'plan-flow',
    // Content this app actually holds, standing in for the real thing.
    'Fix the auth bug in payments',
    '/Users/someone/Projects/acme-payments/src/index.ts',
    'git@github.com:acme/payments.git',
    'sk-ant-api03-REDACTEDKEY',
    // What a sign-in leaves on this machine, once Phase 5 stores one.
    'live-session-token',
  ]
  return candidates.filter((value) => typeof value === 'string' && value.length >= 5)
}

/** Every payload the app can put on the wire, captured as it would be sent. */
async function capturedPayloads(): Promise<TelemetryPayload[]> {
  const captured: TelemetryPayload[] = []
  const delivery = createTelemetryDelivery({
    endpoint: { url: 'https://collector.invalid/ingest', key: 'flw_ingest_test' },
    postFn: async (_url, _key, batch) => {
      captured.push(...batch)
    },
  })

  const service = createTelemetryService({
    rootInstallId: () => 'flow-ide-3f2a9c1b7e04',
    firstRunAt: () => '2026-09-01T10:00:00.000Z',
    consent: () => true,
    facts: () => ({
      appVersion: '0.1.10',
      platform: process.platform,
      osVersion: '25.6.0',
      arch: process.arch,
      locale: 'en-GB',
      timezone: 'America/Sao_Paulo',
    }),
    newSessionId: () => 'sess-1',
    transport: delivery.transport,
  })

  service.start()
  for (const name of EVENT_NAMES) {
    service.record(name, EVERY_EVENT[name] as never)
  }
  service.end()
  await delivery.flush()
  return captured
}

describe('nothing from this machine reaches the wire', () => {
  // POSITIVE BEFORE ABSENCE (allowed-pattern #28). Every assertion below is an
  // absence, and an absence proves nothing unless the alternative was reachable
  // — so first: events really do flow, through the real chain, to a real POST.
  it('sends events at all, through the whole chain', async () => {
    const captured = await capturedPayloads()
    expect(captured.length).toBeGreaterThanOrEqual(EVENT_NAMES.length + 1)
    expect(captured.some((p) => p['event'] === 'session.started')).toBe(true)
    expect(captured.some((p) => p['installId'] !== undefined)).toBe(true)
  })

  it.each(machineSecrets())('does not carry %s', async (secret) => {
    const wire = JSON.stringify(await capturedPayloads())
    expect(wire).not.toContain(secret)
  })

  it('carries no absolute path, in any shape', async () => {
    const wire = JSON.stringify(await capturedPayloads())
    expect(wire).not.toMatch(/\/Users\//)
    expect(wire).not.toMatch(/[A-Z]:\\\\/)
    expect(wire).not.toMatch(/\/home\//)
    expect(wire).not.toMatch(/\.ts\b|\.tsx\b|\.js\b/)
  })

  it('carries no git or repository shape', async () => {
    const wire = JSON.stringify(await capturedPayloads())
    expect(wire).not.toMatch(/github\.com|gitlab|git@|\.git\b/)
    expect(wire).not.toMatch(/refs\/heads|origin\//)
  })

  // SIGN-IN ADDS A LIVE SESSION TOKEN to what this app holds. The join field
  // carries WHO somebody is, which is the point; the token is what proves it,
  // and there is no version of this feature where that belongs on this wire.
  it('carries no sign-in token, even when one exists', async () => {
    const wire = JSON.stringify(await capturedPayloads())
    expect(wire).not.toContain('live-session-token')
    expect(wire).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/) // a JWT
    expect(wire).not.toMatch(/refresh_token|access_token|id_token/)
  })

  it('carries nothing that looks like a credential', async () => {
    const wire = JSON.stringify(await capturedPayloads())
    expect(wire).not.toMatch(/sk-|ghp_|Bearer\s|BEGIN [A-Z ]*PRIVATE/)
  })

  // The coordination id is written into public GitHub issue bodies by every
  // loop claim, so it is the one value whose presence would quietly join an
  // "anonymous" row to a named repository.
  it('carries no coordination id, only its one-way derivation', async () => {
    const wire = JSON.stringify(await capturedPayloads())
    expect(wire).not.toContain('flow-ide-')
    expect(wire).toContain(installPayload('flow-ide-3f2a9c1b7e04', 's', {
      appVersion: '',
      platform: '',
      osVersion: '',
      arch: '',
      locale: '',
      timezone: '',
      firstRunAt: '',
    }).installId as string)
  })

  it('carries only keys the contract names — no others, on any event', async () => {
    const permitted = new Set<string>([
      'installId', 'sessionId', 'appVersion', 'platform', 'osVersion', 'arch',
      'locale', 'timezone', 'firstRunAt', 'identityId',
      'event', 'at', 'count', 'durationMs', 'provider', 'model', 'featureFlags',
      'projectCount', 'threadCount', 'errorKind',
    ])
    const strays = new Set<string>()
    for (const payload of await capturedPayloads()) {
      for (const key of Object.keys(payload)) if (!permitted.has(key)) strays.add(key)
    }
    expect([...strays]).toEqual([])
  })
})

describe('the switch off means silence at the network boundary', () => {
  it('makes no POST at all, for any event', async () => {
    let posts = 0
    const delivery = createTelemetryDelivery({
      endpoint: { url: 'https://collector.invalid/ingest', key: 'flw_ingest_test' },
      postFn: async () => {
        posts += 1
      },
    })
    const service = createTelemetryService({
      rootInstallId: () => 'flow-ide-3f2a9c1b7e04',
      firstRunAt: () => '2026-09-01T10:00:00.000Z',
      consent: () => false,
      facts: () => ({
        appVersion: '0.1.10',
        platform: 'darwin',
        osVersion: '25.6.0',
        arch: 'arm64',
        locale: 'en-GB',
        timezone: 'America/Sao_Paulo',
      }),
      newSessionId: () => 'sess-1',
      transport: delivery.transport,
    })
    service.start()
    for (const name of EVENT_NAMES) service.record(name, EVERY_EVENT[name] as never)
    service.end()
    await delivery.flush()
    expect(posts).toBe(0)
  })

  it('is silent for UNANSWERED too, which every existing install is', async () => {
    let posts = 0
    const delivery = createTelemetryDelivery({
      endpoint: { url: 'https://collector.invalid/ingest', key: 'flw_ingest_test' },
      postFn: async () => {
        posts += 1
      },
    })
    const service = createTelemetryService({
      rootInstallId: () => 'flow-ide-3f2a9c1b7e04',
      firstRunAt: () => '2026-09-01T10:00:00.000Z',
      consent: () => null,
      facts: () => ({
        appVersion: '0.1.10',
        platform: 'darwin',
        osVersion: '25.6.0',
        arch: 'arm64',
        locale: 'en-GB',
        timezone: 'America/Sao_Paulo',
      }),
      newSessionId: () => 'sess-1',
      transport: delivery.transport,
    })
    service.start()
    for (const name of EVENT_NAMES) service.record(name, EVERY_EVENT[name] as never)
    service.end()
    await delivery.flush()
    expect(posts).toBe(0)
  })
})

// The usageEvent import is exercised by the shapes above; referencing it keeps
// the compile honest about where the vocabulary comes from.
void usageEvent
