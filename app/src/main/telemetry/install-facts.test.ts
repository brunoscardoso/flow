import { installPayload, telemetryInstallId } from './install-facts'
import { INSTALL_FIELDS } from '../../shared/telemetry-allowlist'
import { refusalsFor } from '../../shared/telemetry-allowlist'

const FACTS = {
  appVersion: '0.1.10',
  platform: 'darwin',
  osVersion: '25.6.0',
  arch: 'arm64',
  locale: 'en-GB',
  timezone: 'America/Sao_Paulo',
  firstRunAt: '2026-09-01T10:00:00.000Z',
}

const ROOT = 'flow-ide-3f2a9c1b7e04'

describe('telemetryInstallId', () => {
  it('is stable for one installation across runs', () => {
    expect(telemetryInstallId(ROOT)).toBe(telemetryInstallId(ROOT))
  })

  it('differs between installations', () => {
    expect(telemetryInstallId(ROOT)).not.toBe(telemetryInstallId('flow-ide-000000000000'))
  })

  // THE REASON THIS FUNCTION EXISTS. The root id is written into GitHub issue
  // bodies by every loop claim (`<!-- loop-claim: flow-ide-… -->`), which on a
  // public repo is public text. Sending it verbatim would make the telemetry
  // row joinable to a named repository — and the payload would still contain no
  // project name, so no field-level check would ever catch it.
  it('does not carry the coordination id it is derived from', () => {
    const derived = telemetryInstallId(ROOT)
    expect(derived).not.toContain(ROOT)
    expect(derived).not.toContain('flow-ide')
    expect(derived).not.toContain('3f2a9c1b7e04')
  })

  it('is a short hex word, readable in a table row', () => {
    expect(telemetryInstallId(ROOT)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('installPayload', () => {
  it('sends the derived id, never the root', () => {
    const payload = installPayload(ROOT, 'session-1', FACTS)
    expect(payload.installId).toBe(telemetryInstallId(ROOT))
    expect(JSON.stringify(payload)).not.toContain(ROOT)
  })

  it('carries every install fact the contract names', () => {
    // `identityId` is the one conditional field — there is no signed-in person
    // until somebody signs in — so the unconditional claim is about the rest.
    const payload = installPayload(ROOT, 'session-1', FACTS)
    const absent = INSTALL_FIELDS.filter(
      (field) => field !== 'identityId' && payload[field] === undefined,
    )
    expect(absent).toEqual([])
  })

  it('carries the join only when somebody is signed in', () => {
    expect(installPayload(ROOT, 's', FACTS)['identityId']).toBeUndefined()
    expect(installPayload(ROOT, 's', FACTS, 'auth0|abc')['identityId']).toBe('auth0|abc')
  })

  // ABSENT AND EMPTY ARE DIFFERENT FACTS. A receiving end that sees `''`
  // cannot tell "nobody signed in" from "signed in as nothing".
  it.each([null, undefined, ''])('treats %p as nobody, not as an empty person', (value) => {
    const payload = installPayload(ROOT, 's', FACTS, value as string | null | undefined)
    expect('identityId' in payload).toBe(false)
  })

  // THE BOUNDARY IS THE AUTHORITY, and this proves the two agree rather than
  // assuming it: a payload this module builds must pass the door unrefused.
  it('passes the allowlist it was written against', () => {
    expect(refusalsFor(installPayload(ROOT, 'session-1', FACTS))).toEqual([])
  })

  it('reads nothing from the machine on its own', () => {
    // Every value in the payload traces to an argument. If this module ever
    // starts reading `process` or `os` directly, the payload stops being a
    // function of its inputs and this test is where that shows.
    const a = installPayload(ROOT, 's', FACTS)
    const b = installPayload(ROOT, 's', { ...FACTS, arch: 'x64', locale: 'pt-BR' })
    expect(a.arch).toBe('arm64')
    expect(b.arch).toBe('x64')
    expect(b.locale).toBe('pt-BR')
  })
})
