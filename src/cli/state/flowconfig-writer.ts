/**
 * Flowconfig Writer
 *
 * The ONE way plan-flow's own code writes a key into `flow/.flowconfig`
 * (allowed-pattern #14). Extracted from the graphify rails, which owned the
 * only copy; the share setting needs the identical semantics, and two copies
 * of an upsert that must agree with the parser is exactly the drift this repo
 * has been bitten by before.
 *
 * The MERGE itself now lives in `flowconfig-merge.ts`, shared with the IDE's
 * in-process writer — this file is the filesystem half: read, merge, write
 * atomically. The upsert semantics (replace the key's first line in place,
 * drop later duplicates, append when absent) are unchanged; they moved.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeFlowconfig } from './flowconfig-merge.js';

/** The config file every verb in this module reads and writes. */
const FLOWCONFIG_FILE = '.flowconfig';

/**
 * Apply `updates` to `<flowDir>/.flowconfig`, creating `flow/` and the file
 * when missing. A `null` value removes the key's line.
 *
 * ATOMIC (temp + rename): the file is co-edited by a person in a terminal and
 * read by the heartbeat daemon, so a reader must never catch it half-written.
 *
 * A pure-deletion write against a file that does not exist is a no-op — there
 * is nothing to remove, and creating an empty config to say so would be a
 * write nobody asked for.
 */
export function writeFlowconfigKeys(flowDir: string, updates: Record<string, string | null>): void {
  if (Object.keys(updates).length === 0) return;

  const configPath = join(flowDir, FLOWCONFIG_FILE);
  const exists = existsSync(configPath);
  const onlyDeletes = Object.values(updates).every((value) => value === null);
  if (!exists && onlyDeletes) return;

  const existing = exists ? readFileSync(configPath, 'utf-8') : '';
  const merged = mergeFlowconfig(existing, updates);

  mkdirSync(flowDir, { recursive: true });
  const tmpPath = join(flowDir, `${FLOWCONFIG_FILE}.tmp-${process.pid}`);
  writeFileSync(tmpPath, merged, 'utf-8');
  renameSync(tmpPath, configPath); // atomic replace
}

/**
 * Upsert a single `key: value` line in `flow/.flowconfig`, preserving all
 * other lines. Creates `flow/` and `.flowconfig` when missing.
 *
 * plan-flow has no central flowconfig writer today (skills edit the file
 * line-by-line); this mirrors that style: replace the key's FIRST existing
 * line in place, DROP any later duplicate lines for the same key, otherwise
 * append a new line at the end. Duplicate handling matters because the
 * parser reads one line per key — a first-line-only replace would leave a
 * stale duplicate able to pin the parsed value; after this upsert exactly one
 * canonical line per key survives, so writer and parser always agree.
 */
export function upsertFlowconfigKey(flowDir: string, key: string, value: string): void {
  writeFlowconfigKeys(flowDir, { [key]: value });
}

/**
 * Remove a key's line from `flow/.flowconfig`, leaving every other line alone.
 *
 * This is how "inherit the default again" is written: an ABSENT key is the
 * only honest way to say a project has no opinion, because a key set to the
 * default's current value silently freezes that value if the default ever
 * changes. Removal happens only when a caller names the key explicitly
 * (forbidden-pattern #15) — nothing in this module deletes on its own.
 */
export function removeFlowconfigKey(flowDir: string, key: string): void {
  writeFlowconfigKeys(flowDir, { [key]: null });
}
