/**
 * One-time recovery for findings stranded by the per-worktree ledger fork
 * (#loop-ledger-shared-root).
 *
 * Before the store was canonicalized, `flow/loops/queue.jsonl` was git-tracked
 * and copied into every worktree, so a `loop file` run appended to its own
 * worktree's copy. The board reads the main checkout, so those filings never
 * appeared — and because each worktree derived its next id from its OWN copy,
 * several runs independently minted the same id from one baseline (the id
 * sequence FORKED). This module folds the divergent copies back onto the
 * canonical ledger.
 *
 * PURE PLAN, IMPERATIVE SHELL. `planSalvage` is a pure function of the ledger
 * text and the source texts — no fs, no clock, no git — so idempotency and the
 * renumbering rule are unit-testable without touching a real ledger. The thin
 * script (`scripts/salvage-loop-findings.mjs`) reads files, calls this, stamps a
 * timestamp, and appends.
 *
 * APPEND-ONLY, LIKE THE STORE IT WRITES. Recovery never rewrites a line; it only
 * appends new `filed` events, so re-running it is safe (a fingerprint already on
 * the canonical ledger is skipped — NFR-4) and the 18-item baseline and its
 * history are preserved untouched (NFR-5).
 */

/** A parsed queue event — only the fields recovery reads. */
interface QueueEvent {
  id?: string;
  event?: string;
  loop?: string;
  title?: string;
  fingerprint?: string;
  [key: string]: unknown;
}

/** One source worktree's queue, named for reporting. */
export interface SalvageSource {
  /** A label for the report — usually the worktree path. */
  label: string;
  /** The raw JSONL lines of that worktree's `queue.jsonl`. */
  lines: readonly string[];
}

/** A finding recovery will append, with its origin and assigned id. */
export interface SalvagedFinding {
  /** The new id assigned on the canonical ledger (live max + n). */
  id: string;
  /** The id it carried in its source worktree (the forked one). */
  sourceId: string;
  /** Which source it came from. */
  source: string;
  fingerprint: string;
  title: string;
  /** The full original `filed` payload, minus the fields recovery overrides. */
  payload: QueueEvent;
}

/** What recovery would do — inspected in `--dry-run`, applied otherwise. */
export interface SalvagePlan {
  /** New findings to append, in source order, with assigned ids. */
  append: SalvagedFinding[];
  /** Findings skipped because the canonical ledger already has the fingerprint. */
  alreadyPresent: { source: string; sourceId: string; fingerprint: string; title: string }[];
  /** The highest numeric id seen on the canonical ledger before recovery. */
  baselineMaxId: number;
}

/** Parse JSONL fail-soft, one event per line — a corrupt line is skipped, never fatal. */
function parseEvents(lines: readonly string[]): QueueEvent[] {
  const events: QueueEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'object' && parsed !== null) events.push(parsed as QueueEvent);
    } catch {
      // Fail-soft per line, exactly as the ledger backend reads it.
    }
  }
  return events;
}

/** Every fingerprint the canonical ledger has ever carried (open OR closed). */
function knownFingerprints(events: readonly QueueEvent[]): Set<string> {
  const seen = new Set<string>();
  for (const event of events) {
    const fp = typeof event.fingerprint === 'string' ? event.fingerprint.trim() : '';
    if (fp.length > 0) seen.add(fp);
  }
  return seen;
}

/** The highest numeric id across every event, or 0 when the ledger is empty. */
function maxNumericId(events: readonly QueueEvent[]): number {
  let max = 0;
  for (const event of events) {
    const id = typeof event.id === 'string' ? Number.parseInt(event.id, 10) : Number.NaN;
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

/**
 * Plan the recovery: which stranded `filed` events to append to the canonical
 * ledger, and the id each gets.
 *
 * DEDUP AGAINST THE CANONICAL LEDGER *AND* WITHIN THE RUN. A fingerprint already
 * on the ledger is `alreadyPresent` (idempotent re-runs append nothing new); a
 * fingerprint seen twice across sources is appended once (the baseline copy that
 * every worktree shares is the common case, so most source `filed` events are
 * already-present duplicates and only the genuinely divergent ones survive).
 *
 * IDS ARE ASSIGNED FROM LIVE MAX + 1, never hardcoded: if a canonical write has
 * already reached #19 by the time recovery runs, the stranded findings take
 * #20, #21, … instead of colliding (R-3).
 */
export function planSalvage(canonicalLedger: readonly string[], sources: readonly SalvageSource[]): SalvagePlan {
  const canonical = parseEvents(canonicalLedger);
  const known = knownFingerprints(canonical);
  const baselineMaxId = maxNumericId(canonical);

  const append: SalvagedFinding[] = [];
  const alreadyPresent: SalvagePlan['alreadyPresent'] = [];
  let nextId = baselineMaxId;

  for (const source of sources) {
    for (const event of parseEvents(source.lines)) {
      if (event.event !== 'filed') continue;
      const fp = typeof event.fingerprint === 'string' ? event.fingerprint.trim() : '';
      const sourceId = typeof event.id === 'string' ? event.id : '';
      const title = typeof event.title === 'string' ? event.title : '';
      if (fp.length === 0) continue; // a hand-filed item with no fingerprint is not ours to renumber
      if (known.has(fp)) {
        alreadyPresent.push({ source: source.label, sourceId, fingerprint: fp, title });
        continue;
      }
      known.add(fp); // within-run dedup: never append one fingerprint twice
      nextId += 1;
      append.push({ id: String(nextId), sourceId, source: source.label, fingerprint: fp, title, payload: event });
    }
  }

  return { append, alreadyPresent, baselineMaxId };
}

/**
 * Render one planned finding as the JSONL `filed` line to append.
 *
 * The original payload is preserved verbatim except for the three fields
 * recovery owns: the new `id`, a fresh `ts`, and a `provenance` that records
 * this was recovered and from where. `ts` is injected (not read from a clock
 * here) so the caller controls it and the render stays pure/testable.
 */
export function renderSalvagedLine(finding: SalvagedFinding, ts: string): string {
  const line = {
    ...finding.payload,
    id: finding.id,
    event: 'filed',
    ts,
    provenance: `cli:loop file (salvaged from ${finding.source} #${finding.sourceId})`,
  };
  return JSON.stringify(line);
}
