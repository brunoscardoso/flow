/**
 * THE ONE DOOR.
 *
 * Every field that leaves this machine passes through here, and here is the only
 * place that decides whether it may. One boundary rather than a rule repeated at
 * each call site (allowed-pattern #14) — a rule restated in five places is five
 * rules, and the fifth is the one somebody edits.
 *
 * NOTHING LEAVES UNTIL SOMEBODY SAYS SO. `enabled` starts false and stays false
 * until a person has answered the question in the first-run wizard. A version
 * that collected before the switch existed is the version some clients would be
 * running, and no later change takes that back.
 *
 * FAILS SILENT AND CHEAP. A telemetry layer that throws, blocks, retries forever
 * or delays startup is worse than no telemetry at all. Every path here returns
 * rather than raises, and the send is handed to a transport that is expected to
 * be slow, absent or broken (NFR-2, allowed-pattern #19).
 */

import { refusalsFor } from '../../shared/telemetry-allowlist'

/** What a caller hands in. Keys are checked against the allowlist, not trusted. */
export type TelemetryPayload = Record<string, unknown>

/** Where an accepted payload goes. Injected, so a test needs no network. */
export type TelemetryTransport = (payload: TelemetryPayload) => void

export interface TelemetryBoundaryDeps {
  /**
   * Whether the person has said yes. Read at SEND time, not captured —
   * a switch that only takes effect after a restart is a switch that lied.
   */
  isEnabled: () => boolean
  /** Where accepted payloads go. */
  transport: TelemetryTransport
  /**
   * Told about a refusal. Wired to a console warning in development and to
   * nothing in production: a refusal is a bug in Flow, not in the user's day.
   */
  onRefused?: (payload: TelemetryPayload, fields: string[]) => void
}

export interface TelemetryBoundary {
  /** Offer a payload. Returns what happened, so a caller can be tested. */
  send(payload: TelemetryPayload): 'sent' | 'disabled' | 'refused'
}

export function createTelemetryBoundary(deps: TelemetryBoundaryDeps): TelemetryBoundary {
  return {
    send(payload: TelemetryPayload): 'sent' | 'disabled' | 'refused' {
      // THE SWITCH IS CHECKED FIRST, before the payload is even looked at. With
      // it off nothing is inspected, nothing is queued and nothing is built —
      // there is no path from here to the network at all, which is the claim
      // `telemetry-boundary.test.ts` proves rather than asserts.
      if (!deps.isEnabled()) return 'disabled'

      const refusals = refusalsFor(payload)
      if (refusals.length > 0) {
        deps.onRefused?.(
          payload,
          refusals.map((refusal) => refusal.field),
        )
        // THE WHOLE PAYLOAD, NOT THE OFFENDING FIELD. Stripping the bad key and
        // sending the rest is the shape that quietly normalises a leak: the
        // event still arrives, so nobody investigates. Refusing the lot makes
        // the mistake visible where it was made.
        return 'refused'
      }

      try {
        deps.transport(payload)
        return 'sent'
      } catch {
        // A transport that throws must not reach the caller: the caller is a
        // feature doing its actual job, and telemetry is never worth failing it.
        return 'refused'
      }
    },
  }
}
