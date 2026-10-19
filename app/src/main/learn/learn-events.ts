// Progressive-learning event bus (#513 phase 2).
//
// A small, decoupled main-side emitter that carries "the user asked for a basic
// discovery on this root" from the onboarding ask (and the Settings re-fire) to
// whoever orchestrates the discovery run. Phase 6's basic-discovery orchestrator
// subscribes here later; this module only DEFINES and EXPORTS the contract now,
// so the two land independently. Keeping it a standalone emitter (not an IPC
// channel) means the request never leaves the main process — the renderer only
// answers the ask; main decides what "run a basic discovery" means.

import { EventEmitter } from 'events'

/** Emitted when a basic discovery is requested for a root (payload below). */
export const BASIC_DISCOVERY_REQUESTED_EVENT = 'learn:basicDiscoveryRequested'

export interface BasicDiscoveryRequestedPayload {
  /** The project root a basic discovery was requested for. `rootId` is the
   *  absolute root path (the app-wide project addressing key). */
  rootId: string
}

/**
 * Typed wrapper over EventEmitter for the progressive-learning events. The
 * emit/subscribe helpers are the ONLY intended surface — callers never touch
 * the raw event name, so the payload shape can't drift.
 */
export class LearnEventEmitter extends EventEmitter {
  /** Request a basic discovery for `rootId` (absolute root path). */
  emitBasicDiscoveryRequested(rootId: string): void {
    const payload: BasicDiscoveryRequestedPayload = { rootId }
    this.emit(BASIC_DISCOVERY_REQUESTED_EVENT, payload)
  }

  /** Subscribe to basic-discovery requests. Returns an unsubscribe function. */
  onBasicDiscoveryRequested(
    listener: (payload: BasicDiscoveryRequestedPayload) => void,
  ): () => void {
    this.on(BASIC_DISCOVERY_REQUESTED_EVENT, listener)
    return () => {
      this.off(BASIC_DISCOVERY_REQUESTED_EVENT, listener)
    }
  }
}
