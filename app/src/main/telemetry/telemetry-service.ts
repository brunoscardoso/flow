/**
 * THE INSTALL REPORT AND THE SESSION BOUNDARY — what Phase 2 actually emits.
 *
 * One service, created once at startup, holding the session's identity for as
 * long as the app runs. It answers two questions and no others: how many
 * installations are there and on what, and how long was this run.
 *
 * ── NOTHING IS SENT ANYWHERE YET, ON PURPOSE ────────────────────────────────
 *
 * The transport is injected and DEFAULTS TO NOWHERE. The host and its
 * write-only ingest key are Phase 4's, and they are the one thing nobody has
 * supplied; inventing an endpoint here would mean a build that posts a client's
 * install facts to an address chosen by whoever typed fastest. So the seam is
 * built, wired and tested, and the default transport drops what it is given.
 *
 * That makes the wiring provable today — the payload, the vocabulary, the
 * consent gate and the boundary are all exercised end to end — and leaves
 * exactly one line to change when the host exists.
 *
 * EVERY PATH IS FAIL-SILENT AND OFF THE HOT PATH. This runs during startup and
 * during quit, where a throw is a window that will not open and a quit that
 * hangs (allowed-pattern #19). The boundary already swallows a transport that
 * throws; this adds the same promise around reading the store.
 */

import {
  createTelemetryBoundary,
  type TelemetryPayload,
  type TelemetryTransport,
} from './telemetry-boundary'
import { installPayload, telemetryInstallId, type MachineFacts } from './install-facts'
import { usageEvent, type EventShapes } from '../../shared/telemetry-events'
import type { EventName } from '../../shared/telemetry-allowlist'

export interface TelemetryServiceDeps {
  /** The installation's coordination id. Derived before it is sent, never copied. */
  rootInstallId: () => string
  /** When this installation first ran. */
  firstRunAt: () => string
  /**
   * The signed-in person, or null.
   *
   * READ AT SEND TIME, like consent, so signing in or out takes effect on the
   * next report rather than on the next restart. Optional because sign-in is
   * optional: an installation that never signs in never has one, and the field
   * is then absent rather than empty.
   */
  identityId?: () => string | null
  /** Has the person said yes? Three-valued upstream; only `true` sends. */
  consent: () => boolean | null
  /** Read from the machine by the caller, so this module stays testable. */
  facts: () => MachineFacts
  /** A fresh id for this run of the app. */
  newSessionId: () => string
  /** Injected clock, so a duration is testable without waiting. */
  now?: () => number
  /** Where an accepted payload goes. Defaults to nowhere — see the header. */
  transport?: TelemetryTransport
  onRefused?: (payload: Record<string, unknown>, fields: string[]) => void
}

export interface TelemetryService {
  /** App ready. Reports the installation and opens the session. */
  start(): void
  /** App quitting. Closes the session with its duration. */
  end(): void
  /** This run's id. */
  sessionId(): string
  /**
   * Record one usage event.
   *
   * THE ONLY WAY TO EMIT ONE. The name and its shape are checked by the
   * compiler (`telemetry-events.ts`) and the fields again by the door, so a
   * seam calling this cannot invent either. It returns nothing and throws
   * nothing: a seam is a feature doing its actual job, and telemetry is never
   * worth failing it.
   */
  record<K extends EventName>(name: K, props: EventShapes[K]): void
}

export function createTelemetryService(deps: TelemetryServiceDeps): TelemetryService {
  const now = deps.now ?? (() => Date.now())
  // NOWHERE, until Phase 4 says where. Not a queue, not a file — a payload
  // accepted by the boundary and then dropped, so no data waits on disk for a
  // destination that does not exist yet.
  const transport = deps.transport ?? ((): void => {})

  const boundary = createTelemetryBoundary({
    // READ AT SEND TIME, and only a literal `true` passes: `null` is nobody
    // having been asked, which is not a yes.
    isEnabled: () => deps.consent() === true,
    transport,
    onRefused: deps.onRefused,
  })

  let session: string | null = null
  let startedAt = 0
  /** `rootInstallId()` reads the store; an event is not a reason to. */
  let rootId: string | null = null

  function rootOnce(): string {
    if (rootId === null) rootId = deps.rootInstallId()
    return rootId
  }

  /**
   * SEND ONE EVENT — the single path every event takes.
   *
   * `session.started` and `session.ended` used to be built and sent inline in
   * `start`/`end`, beside a `record` that stamped things they did not get. Two
   * paths, one of which was forgotten — the shape allowed-pattern #14 exists to
   * prevent, and the shape my own attribution test caught a minute after it was
   * written.
   */
  function sendEvent<K extends EventName>(name: K, props: EventShapes[K]): void {
    boundary.send({
      ...usageEvent(name, props),
      installId: telemetryInstallId(rootOnce()),
      ...(session === null ? {} : { sessionId: session }),
    } as unknown as TelemetryPayload)
  }

  return {
    sessionId(): string {
      if (session === null) session = deps.newSessionId()
      return session
    },

    start(): void {
      try {
        session = deps.newSessionId()
        startedAt = now()

        // STAMPED ON EVERY LAUNCH, WHATEVER THE ANSWER. If somebody declines
        // now and says yes in a year, the date they installed Flow should be
        // the real one rather than the date they changed their mind — so the
        // stamp is taken before the gate, and it never leaves the machine
        // unless the gate opens later.
        deps.firstRunAt()

        // NOT A SECOND AUTHORITY — the boundary below still decides, and still
        // checks. This is here because an argument is evaluated BEFORE the call
        // it is passed to: building the payload first would read the store and
        // the machine on every launch for somebody who said no, which is
        // precisely the work the door promises not to do when it is shut.
        if (deps.consent() !== true) return
        // The installation, then the fact that a run began. Two payloads
        // because they answer different questions and age differently — the
        // install facts change with an upgrade, the session never repeats.
        boundary.send(
          installPayload(
            rootOnce(),
            session,
            { ...deps.facts(), firstRunAt: deps.firstRunAt() },
            // THE JOIN. Absent until somebody signs in, which makes the events
            // an installation already sent theirs afterwards — without anything
            // being re-sent, and without a second identifier existing.
            deps.identityId?.() ?? null,
          ),
        )
        sendEvent('session.started', { at: startedAt, sessionId: session })
      } catch {
        // Startup must not fail for this.
      }
    },

    record<K extends EventName>(name: K, props: EventShapes[K]): void {
      try {
        // Same gate, same reason as `start`: the argument is built before the
        // call, so a declined installation must not pay for a payload the door
        // is going to refuse anyway.
        if (deps.consent() !== true) return
        // The cast is narrow and one-directional: a generic `UsageEvent<K>`
        // has no index signature, so TypeScript will not widen it to the
        // door's `Record<string, unknown>` even though every value of it IS
        // one at runtime. Nothing is weakened by it — the property names were
        // already checked by `usageEvent`'s signature at the call site, and the
        // door checks them again itself a line later.
        sendEvent(name, props)
      } catch {
        // A seam must never fail because telemetry did.
      }
    },

    end(): void {
      try {
        if (session === null) return
        sendEvent('session.ended', {
          at: now(),
          durationMs: now() - startedAt,
          sessionId: session,
        })
      } catch {
        // Quit must not hang for this.
      }
    },
  }
}

/**
 * The facts this app reads from the machine — the ONLY place that reads them.
 *
 * Takes what the caller already has (Electron's app/process) and adds the one
 * value that is computed rather than read. It does NOT invent `firstRunAt`: the
 * store owns that, and a reader that returned a placeholder for it would be a
 * machine claiming to know when it was installed.
 */
export function readMachineFacts(deps: {
  appVersion: string
  platform: string
  osVersion: string
  arch: string
  locale: string
}): MachineFacts {
  return {
    appVersion: deps.appVersion,
    platform: deps.platform,
    osVersion: deps.osVersion,
    arch: deps.arch,
    locale: deps.locale,
    // The ZONE, not the offset and not the time: "America/Sao_Paulo" is a
    // coarse fact about a population, and it is already implied by the locale.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}
