/**
 * Flowconfig Merge
 *
 * THE ONE ALGORITHM that turns `flow/.flowconfig` text plus a set of key
 * changes into new text (allowed-pattern #14). Two writers had grown their own
 * copy of it — the CLI's `upsertFlowconfigKey` and the IDE's in-process
 * `mergeFlowconfig` — and two upserts that must both agree with one parser is
 * exactly the drift this repo has been bitten by. This module is that
 * algorithm; both writers import it, neither owns it.
 *
 * Pure by design: text in, text out, no filesystem. The atomic write lives in
 * `flowconfig-writer.ts` (CLI) and `app/src/main/flow/flowconfig-writer.ts`
 * (IDE), so the same merge can be applied by a process that already holds the
 * file open and by one that does not.
 *
 * The file is HAND-EDITABLE and co-owned — a person edits it in a terminal,
 * the `/flow` skill writes keys into it, the heartbeat daemon reads it. So the
 * merge touches only the lines it was asked about: comments, blank lines, and
 * every key not named in `updates` survive byte-for-byte, in their original
 * order.
 */

/**
 * A key line, matched the way the PARSER matches it: the key starts at column
 * zero and runs to its colon.
 *
 * Two properties this buys, both of which a looser pattern loses:
 *
 *   - `remote` cannot match `remote_branch_pattern:` — the key token is
 *     captured whole, so a prefix is not a key (the same care forbidden-pattern
 *     #16 took on the read side).
 *   - An indented line is not a key. `flow/.flowconfig` has no nesting (dotted
 *     keys are flat), and `parseFlowConfig` anchors every extractor at `^key:`,
 *     so a line the parser cannot see must not be a line the writer rewrites —
 *     otherwise `flow set remote=x` would report success over a value nothing
 *     ever reads.
 *
 * Comment lines (`#`) never match: `#` is outside the key character class.
 */
const KEY_LINE = /^([A-Za-z0-9_.-]+):/;

/** The key a line declares, or `null` when the line declares none. */
function keyOf(line: string): string | null {
  const match = KEY_LINE.exec(line);
  return match === null ? null : match[1];
}

/**
 * Every key literally written in `.flowconfig` text, mapped to its raw value.
 *
 * PRESENCE, not value — this is what lets a caller tell "the project set this
 * to true" from "the default happens to be true", which is the whole basis of
 * provenance. `parseFlowConfig` cannot answer that question: it returns a
 * fully-defaulted object in which both look identical.
 *
 * Same line grammar as the merge above, so a key the writer would rewrite is
 * exactly a key this reports (allowed-pattern #14). Later duplicates lose to
 * the first, matching the parser's first-match extractors.
 */
export function parseFlowconfigKeys(text: string): Record<string, string> {
  // Prototype-less: a config key literally named `__proto__` must land as a
  // plain entry rather than reaching the prototype setter.
  const keys: Record<string, string> = Object.create(null);
  for (const line of text.split('\n')) {
    const key = keyOf(line);
    if (key === null || key in keys) continue;
    keys[key] = line.slice(key.length + 1).trim();
  }
  return keys;
}

/**
 * Apply `updates` to `.flowconfig` text.
 *
 * A string value UPSERTS: the key's first existing line is replaced in place
 * (so its position in the file is kept), and the key is appended at the end
 * when it has no line yet. A `null` value DELETES the key's line — which is
 * how "inherit the default again" is expressed, and why deletion had to be a
 * value of this function rather than a second function that could disagree
 * with it.
 *
 * Later duplicate lines for a touched key are DROPPED, both on upsert and on
 * delete. The parser reads the first line for a key, so a leftover duplicate
 * would pin the value the writer just changed — one canonical line per key is
 * the only state in which writer and parser cannot disagree. Duplicates of
 * keys nobody named are left exactly where they are.
 *
 * The result ends in exactly one newline, or is empty when nothing is left.
 */
export function mergeFlowconfig(text: string, updates: Record<string, string | null>): string {
  const pending = new Map(Object.entries(updates));
  if (pending.size === 0) return text;

  const lines = text.length > 0 ? text.split('\n') : [];
  // The final '' of a trailing newline is an artifact of the split, not a
  // blank line in the file; the join below re-adds the newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const handled = new Set<string>();
  const merged: string[] = [];
  for (const line of lines) {
    const key = keyOf(line);
    if (key === null || !pending.has(key)) {
      merged.push(line);
      continue;
    }
    if (handled.has(key)) continue; // later duplicate of a touched key — dropped
    handled.add(key);
    const value = pending.get(key) as string | null;
    if (value === null) continue; // deleted
    merged.push(`${key}: ${value}`);
  }

  const appended: string[] = [];
  for (const [key, value] of pending) {
    if (value === null || handled.has(key)) continue;
    appended.push(`${key}: ${value}`);
  }

  if (appended.length > 0) {
    // Trim trailing blank lines so a new key lands under the last real one
    // rather than after a gap that grows by one on every append.
    while (merged.length > 0 && merged[merged.length - 1].trim() === '') merged.pop();
    merged.push(...appended);
  }

  const body = merged.join('\n').replace(/\n*$/, '');
  return body.length === 0 ? '' : `${body}\n`;
}
