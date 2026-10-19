/**
 * ENDPOINT + SENDER, ASSEMBLED — so `index.ts` holds four lines rather than the
 * decision tree.
 *
 * This is where "we have somewhere to send things" is actually decided, and it
 * is decided ONCE, at startup, in one place. Three outcomes:
 *
 *   nowhere      the build configured no endpoint — the ordinary case, and what
 *                every build from a clone does. Events are accepted and dropped.
 *   refused      an endpoint was configured with a key that can READ. Nothing
 *                is sent, and the build says so loudly, because shipping is the
 *                irreversible act and a warning nobody reads is how the wrong
 *                key reaches a release.
 *   configured   a write-only key over https. Batched, bounded, fail-silent.
 */

import { assertWriteOnlyShape, configuredEndpoint } from './telemetry-endpoint'
import { createTelemetrySender, type TelemetrySender } from './telemetry-sender'
import type { TelemetryPayload, TelemetryTransport } from './telemetry-boundary'

export type DeliveryState = 'nowhere' | 'refused' | 'configured'

export interface TelemetryDelivery {
  /** Handed to the service. Never blocks and never throws. */
  transport: TelemetryTransport
  /** Send what is queued — called on the way out. Never rejects. */
  flush(): Promise<void>
  /** Stop the timer. */
  stop(): void
  /** What was decided, for the one startup line that reports it. */
  state: DeliveryState
  /** Why, when the state is `refused`. */
  reason: string | null
}

export interface DeliveryDeps {
  /** Injected so a test needs no network and no build-time substitution. */
  endpoint?: { url: string; key: string } | null
  postFn?: (url: string, key: string, batch: TelemetryPayload[]) => Promise<void>
  onUnreachable?: () => void
  makeSender?: typeof createTelemetrySender
}

/** The default POST. Fire-and-forget as far as every caller is concerned. */
async function postBatch(
  url: string,
  key: string,
  batch: TelemetryPayload[],
): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // A WRITE-ONLY INGEST KEY. See telemetry-endpoint.ts for why this being
      // readable by anyone who unzips the app is survivable.
      authorization: `Bearer ${key}`,
    },
    // THE EVENT BODY AS JSON, not a column per property. A shipped desktop
    // binary keeps posting the shape it was built with for months, and no
    // migration reaches a copy somebody installed in March — so the receiving
    // end stores the document and projects it in SQL.
    body: JSON.stringify({ events: batch }),
  })
  if (!response.ok) throw new Error(`ingest returned ${response.status}`)
}

export function createTelemetryDelivery(deps: DeliveryDeps = {}): TelemetryDelivery {
  const endpoint = deps.endpoint === undefined ? configuredEndpoint() : deps.endpoint
  const make = deps.makeSender ?? createTelemetrySender

  if (endpoint === null) {
    const sender = make({ onUnreachable: deps.onUnreachable })
    return {
      transport: (payload) => sender.enqueue(payload),
      flush: () => sender.flush(),
      stop: () => sender.stop(),
      state: 'nowhere',
      reason: null,
    }
  }

  // THE TRIPWIRE, BEFORE ANYTHING IS SENT ANYWHERE. A key that can read must
  // never reach a client, and the moment to find out is the build, not the
  // incident.
  const refusal = assertWriteOnlyShape(endpoint.key)
  if (refusal !== null) {
    // No sender at all — not a sender with no endpoint. There is nothing to
    // queue for, and queueing would imply this is recoverable at runtime.
    return {
      transport: () => {},
      flush: async () => {},
      stop: () => {},
      state: 'refused',
      reason: refusal,
    }
  }

  const post = deps.postFn ?? postBatch
  const sender: TelemetrySender = make({
    post: (batch) => post(endpoint.url, endpoint.key, batch),
    onUnreachable: deps.onUnreachable,
  })
  return {
    transport: (payload) => sender.enqueue(payload),
    flush: () => sender.flush(),
    stop: () => sender.stop(),
    state: 'configured',
    reason: null,
  }
}
