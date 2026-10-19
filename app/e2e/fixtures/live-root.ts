/**
 * WHERE A REAL CHECKOUT LIVES IS NOT A FACT THIS REPOSITORY CARRIES.
 *
 * A live probe drives an actual project on the machine that runs it — real
 * history, real size, real knowledge — which is the whole point of it and the
 * reason a seeded fixture cannot stand in. WHICH project belongs to whoever
 * runs the probe, so it is named by the environment rather than written down
 * here:
 *
 *   FLOW_LIVE_PROJECT=/path/to/app \
 *   FLOW_LIVE_SIBLING=/path/to/library \
 *   FLOW_LIVE_REAL_CHECKOUT=1 npx playwright test e2e/live-multi-project-probe.spec.ts
 *
 * Unset, blank, relative or absent reads as "no live project on this machine"
 * and the probe skips — exactly what each one already did when the directory
 * it named was missing. The empty string is that answer: a path a probe must
 * not act on, and the reason every caller tests for it in a `test.skip` before
 * the first use.
 */
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const LIVE_PROJECT_VAR = 'FLOW_LIVE_PROJECT'
export const LIVE_SIBLING_VAR = 'FLOW_LIVE_SIBLING'

export function liveRoot(variable: string = LIVE_PROJECT_VAR): string {
  const value = process.env[variable]
  if (value === undefined) return ''
  const path = value.trim()
  // A relative path would resolve against whatever directory the runner was
  // started in, which is not a project anybody chose.
  if (path === '' || !isAbsolute(path)) return ''
  return existsSync(path) ? path : ''
}

/** The sentence a probe skips with, naming the variable to set. */
export function noLiveProject(variable: string = LIVE_PROJECT_VAR): string {
  return `no live project: set ${variable} to a real checkout`
}
