// WHETHER AUTOPILOT IS ON — one resolution, read everywhere.
//
// The answer has two sources and always has: the `autopilot` key in a project's
// `flow/.flowconfig`, and a legacy marker file kept for projects set up before
// the key existed. The key WINS whenever it is present, including when it says
// `false` — a project that has switched autopilot off must not have a stale
// marker file switch it back on.
//
// This lived inline in `flow-observer.ts`, which was fine while exactly one
// thing asked. Now the chain driver asks too, and two copies of a two-branch
// rule are two copies that can disagree the day somebody adds a third source
// (allowed-pattern #14). The observer calls this; so does the driver; there is
// no third spelling.
//
// THE KEY NAME IS INTERNAL. It appears here and in the config writer, never in
// anything a person reads (forbidden-pattern #12) — the user turns autopilot on
// with a labelled control, not by being told to type a key into a file.

/** The `flow/.flowconfig` key. Internal — never rendered. */
export const AUTOPILOT_KEY = 'autopilot'

/** The pre-key marker file, relative to the flow directory. Internal. */
export const LEGACY_AUTOPILOT_FILE = '.autopilot'

/**
 * Is autopilot on for a project, given its parsed config and whether the legacy
 * marker exists?
 *
 * Split from any file reading so both callers can answer from whatever they
 * already hold open — the observer has the config text in hand from its watch,
 * and a test has neither a project nor a disk.
 */
export function autopilotEnabledIn(
  flowconfig: Record<string, string>,
  legacyMarkerExists: boolean,
): boolean {
  const configured = flowconfig[AUTOPILOT_KEY]
  if (configured !== undefined) return configured.trim() === 'true'
  return legacyMarkerExists
}
