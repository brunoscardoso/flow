/**
 * Must-review acknowledgment store (#910 follow-up) — append-only
 * `flow/brain/.structure/mustreview-acks.jsonl`, one `{ts, title}` line per
 * acknowledged item. `computeMustReview` output is filtered by acked TITLE
 * (the item's stable identity across derives): "Mark reviewed" in the app
 * appends here, and the item never resurfaces — independent of graph.prev
 * rotation timing, which previously made acknowledgment a no-op whenever the
 * delta window had already closed or never re-derived.
 *
 * Tolerant reader (per-line fail-soft, same discipline as every .structure
 * store); the file is derived-adjacent but PRECIOUS-lite: never rewritten,
 * only appended.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MUSTREVIEW_ACKS_FILENAME = 'mustreview-acks.jsonl';

/** Acked item titles from the store (deduped); missing/corrupt → empty. */
export function readMustReviewAcks(structureDir: string): Set<string> {
  const path = join(structureDir, MUSTREVIEW_ACKS_FILENAME);
  const acked = new Set<string>();
  if (!existsSync(path)) return acked;
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return acked;
  }
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as { title?: unknown };
      if (typeof parsed.title === 'string' && parsed.title.length > 0) acked.add(parsed.title);
    } catch {
      // corrupt line — skip
    }
  }
  return acked;
}
