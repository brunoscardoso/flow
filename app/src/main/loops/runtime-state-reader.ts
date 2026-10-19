// THE RUNTIME HALF OF A LOOPS SNAPSHOT — the pauses in `flow/loops/state.json`.
//
// WHY THIS EXISTS, and it is a bug's whole story. `directive-reader.ts` reads
// the DIRECTIVE half, and its header says so plainly: "A loop's pause, locks and
// last outcome live in flow/loops/state.json … neither is read here." The
// handler built on it filled the gap by hard-coding `pause: null`, which was
// harmless while nothing in the app wrote a state pause and became a lie the
// moment something did:
//
//   · the board's stop writes one (a person stopping for the afternoon should
//     not turn up in `git log`), so pressing pause did nothing visible — the
//     write landed, the read could not see it, and the button stayed on "Stop";
//   · the gate's own switch-off writes one too (`loop next --stop-when-empty`),
//     so "Off — nothing left in the list" could never appear at all.
//
// SO IT IS READ. It is one small local JSON file beside the directives that were
// just listed — no subprocess, no network, and async like everything else on
// main (allowed-pattern #19).
//
// FAIL-SOFT, LIKE ITS SIBLING. A missing file is the normal case (nothing has
// ever been paused) and reads as no pauses. A corrupt one also reads as no
// pauses rather than refusing: a board that will not draw because a local cache
// is malformed is worse than a board that draws what the committed directives
// say. The CLI is the authority and refuses for itself.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Where the CLI keeps it — `LOOP_STATE_FILENAME` in src/cli/loop/loop-state.ts. */
export const LOOP_STATE_FILENAME = 'state.json'

/** One pause in force. Its PRESENCE is the pause; there is no `paused: false`. */
export interface RuntimePause {
  /** Why it was set. Never empty — a pause with no reason reads as "paused". */
  reason: string
  /** ISO instant it was set at. Empty when the file did not say. */
  since: string
  /** ISO instant it self-expires at, when it has one. */
  until: string | null
}

/** Every pause a project has in force right now. */
export interface RuntimeStateSnapshot {
  /** The pause covering every loop, or null. */
  globalPause: RuntimePause | null
  /** Per-loop pauses, keyed by loop name. Absent means not paused. */
  pauses: Record<string, RuntimePause>
}

/** Nothing paused — the shape a missing or unreadable file reads as. */
export function emptyRuntimeState(): RuntimeStateSnapshot {
  return { globalPause: null, pauses: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One pause record, or null.
 *
 * AN EXPIRED PAUSE IS NOT A PAUSE. The CLI's own reader drops one whose `until`
 * has passed, and a board that went on showing it would report a loop as
 * stopped while the next run walks straight past it. A MALFORMED `until` is
 * treated as no expiry — the same conservative reading the CLI makes, because
 * dropping a pause nobody can date would restart loops nobody re-authorized.
 */
function parsePause(raw: unknown, now: number): RuntimePause | null {
  if (!isRecord(raw)) return null
  const reason = typeof raw['reason'] === 'string' ? raw['reason'].trim() : ''
  const since = typeof raw['since'] === 'string' ? raw['since'] : ''
  const untilRaw = raw['until']
  const until = typeof untilRaw === 'string' ? untilRaw : null
  if (until !== null) {
    const at = Date.parse(until)
    if (!Number.isNaN(at) && at <= now) return null
  }
  return { reason: reason.length === 0 ? 'paused' : reason, since, until }
}

/**
 * Read a project's loop pauses.
 *
 * `flowDir` is the project's `flow/` directory — the same place the CLI writes.
 */
export async function readRuntimeState(
  flowDir: string,
  now: number,
  read: (path: string) => Promise<string> = (path) => readFile(path, 'utf-8'),
): Promise<RuntimeStateSnapshot> {
  let raw: unknown
  try {
    raw = JSON.parse(await read(join(flowDir, 'loops', LOOP_STATE_FILENAME)))
  } catch {
    return emptyRuntimeState()
  }
  if (!isRecord(raw)) return emptyRuntimeState()
  const loops = isRecord(raw['loops']) ? raw['loops'] : {}
  const pauses: Record<string, RuntimePause> = {}
  for (const [loop, record] of Object.entries(loops)) {
    if (!isRecord(record)) continue
    const pause = parsePause(record['pause'], now)
    if (pause !== null) pauses[loop] = pause
  }
  return { globalPause: parsePause(raw['globalPause'], now), pauses }
}
