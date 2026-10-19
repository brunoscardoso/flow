/**
 * END-TO-END SEAMS — the two things a hidden Playwright run may stand in for
 * from main, and nothing else.
 *
 * A Workspace thread's first message asks the fast model which projects it
 * needs, then spawns an agent runtime with those projects as its folders. Both
 * reach the network (a real model, a real CLI), so an end-to-end run cannot
 * let either happen — and both are deep inside closures `app.evaluate` cannot
 * reach. A spec sets them on `globalThis.__flowE2ESeams` from main instead:
 *
 *   · `askFastModel` — answers the context gate's model call deterministically
 *                      (and connections learning's — a hidden run learns
 *                      connections on its own only once a spec set it);
 *   · `runtime`      — builds the agent runtime every thread session uses, so a
 *                      spec can record the folders a session was started with
 *                      and finish its turns without any CLI.
 *   · `basicDiscovery` — runs one project's basic discovery (learn/
 *                      basic-discovery.ts) instead of the learn orchestrator's
 *                      agent passes, so a spec decides when it ends and how.
 *
 * Basic discovery is the one seam whose ABSENCE also means something: a hidden
 * run that has not set it never sweeps a project automatically and never holds
 * a message for one (`automaticBasicDiscovery`), so every other spec keeps
 * sending exactly as it did and no learn pass reaches a model.
 *
 * FAIL-CLOSED OUTSIDE A HIDDEN RUN (forbidden-pattern #15): read only when the
 * process was started with `FLOW_E2E=1`, which only the e2e harness sets. With
 * it unset this answers null whatever `globalThis` holds, and every caller
 * takes its ordinary path.
 */

import type { FastModelCall } from './agent/context-gate'
import type { AgentRuntime } from './agent/runtime/agent-runtime'
import type { BasicDiscoveryRunOutcome } from './project/learn-orchestrator'

export interface E2ESeams {
  /** Stands in for the context gate's fast-model call. */
  askFastModel?: FastModelCall
  /** Stands in for the agent runtime of every thread session started from now on. */
  runtime?: () => AgentRuntime
  /** Stands in for one project's basic discovery (the learn orchestrator's sweep). */
  basicDiscovery?: (root: string) => Promise<BasicDiscoveryRunOutcome>
}

const GLOBAL_KEY = '__flowE2ESeams'

/** The seams a hidden end-to-end run set, or null — always null outside one. */
export function e2eSeams(env: NodeJS.ProcessEnv = process.env): E2ESeams | null {
  if (env['FLOW_E2E'] !== '1') return null
  const value = (globalThis as Record<string, unknown>)[GLOBAL_KEY]
  if (typeof value !== 'object' || value === null) return null
  return value as E2ESeams
}

/**
 * Does the app sweep Workspace projects (and hold first messages) on its own?
 * Always outside a hidden run; inside one, only once a spec has stood in for
 * the sweep — no hidden run may start real learn passes by itself.
 */
export function automaticConnectionsLearning(env: NodeJS.ProcessEnv = process.env): boolean {
  // Same rule: a hidden run learns connections on its own only once a spec
  // stood in for the fast model, so no hidden run ever reaches a real one.
  if (env['FLOW_E2E'] !== '1') return true
  return e2eSeams(env)?.askFastModel !== undefined
}

export function automaticBasicDiscovery(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['FLOW_E2E'] !== '1') return true
  return e2eSeams(env)?.basicDiscovery !== undefined
}

/**
 * The renderer's own "this is a hidden end-to-end run" flag, handed to the
 * preload on its argv (`webPreferences.additionalArguments`).
 *
 * The preload used to read `process.env.FLOW_E2E` itself. A SANDBOXED preload's
 * `process` is a polyfill, so whether that variable reaches it depends on the
 * Electron version rather than on anything this app decides — and a spec that
 * reached the board's hook through `?.` could not tell a missing hook from a
 * call that did nothing. Main decides, once, from its real environment.
 *
 * FAIL-CLOSED (forbidden-pattern #15): only `FLOW_E2E=1`, and never in a
 * packaged app — a shipped Flow.app hands its renderer nothing whatever the
 * environment holds. Both inputs are required, so no caller gets the e2e branch
 * by default.
 */
export const E2E_RENDERER_ARG = '--flow-e2e'

export function e2eRendererArguments(env: NodeJS.ProcessEnv, isPackaged: boolean): string[] {
  if (isPackaged) return []
  return env['FLOW_E2E'] === '1' ? [E2E_RENDERER_ARG] : []
}
