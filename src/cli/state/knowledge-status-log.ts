/**
 * WHETHER A PIECE OF KNOWLEDGE IS DRAFT, SOLID, STALE OR ABANDONED.
 *
 * Status lives BESIDE the content, in an append-only log at
 * `flow/brain/.structure/knowledge-status.jsonl` — never in the feature file,
 * because two machines promoting the same item would then conflict on it
 * (discovery `workspace_knowledge_draft_solid`, FR-2, FR-6). The path is
 * classed `append-only` by `knowledge-classes.ts` (`brain/.structure/*.jsonl`),
 * so it syncs and merges by union.
 *
 * ── ONE WRITER ─────────────────────────────────────────────────────────────
 *
 * `appendKnowledgeStatus` is the only writer (forbidden-pattern #18: if a gate
 * reads it, a verb writes it). It validates the vocabulary and refuses
 * anything else, writing nothing.
 *
 * ── THE TIMESTAMP RULE: THE EVIDENCE'S TIME, NEVER THE CLOCK'S ─────────────
 *
 * Two machines that promote the same item must write the SAME BYTES, so the
 * union merge leaves one line instead of two. A wall-clock field would differ
 * on every machine, so the writer adds none. `ts` is required from the caller
 * and is the time of the EVIDENCE: for a promotion, the committer date of the
 * default-branch commit that proved it (`commit`); for an abandonment, the
 * time the deciding fact was observed by the host, when one is known, else the
 * newest commit date considered. The writer normalises it to
 * `Date#toISOString()`, so two spellings of one instant are one line, and
 * writes keys in one fixed order. Same evidence ⇒ same line, on any machine.
 *
 * `reason` is a short code (`ancestor`, `hashes-match`, `pr-merged`, …), not a
 * sentence, for the same reason: prose drifts between builds, codes do not.
 *
 * ── THE FOLD IS ORDER-FREE ─────────────────────────────────────────────────
 *
 * The union merge writes "ours first, then theirs", which is not chronological
 * and differs between machines, so last-line-wins would give two machines two
 * answers. `foldKnowledgeStatus` ranks instead: `solid`, `stale` and
 * `abandoned` outrank `draft`; among the outranking lines the newest `ts`
 * wins, and an exact tie breaks on the line's bytes. A winning `stale` reads
 * as solid with `stale: true` — merged, but with later changes, so it is
 * re-learned. Any permutation of the same lines folds to the same answer.
 *
 * ── ITEM IDS ───────────────────────────────────────────────────────────────
 *
 * `knowledgeItemId` = first 16 hex of SHA-256 over
 * `kind \0 scope \0 text \0 learnedAt`, where per kind:
 *
 *   learning       scope = feature slug                 text = the learning
 *   part-learning  scope = `<feature slug>/<part slug>` text = the learning
 *   note           scope = ''                           text = investigationFingerprint(note)
 *   view           scope = feature slug                 text = ''
 *
 * `learnedAt` (the provenance reference, see `knowledge-provenance.ts`)
 * carries the commit and the cited hashes, so the same sentence re-learned on
 * another commit is another item with its own status. Dates, pins and
 * supersede reasons are NOT in the id: superseding a learning must not orphan
 * its status.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BLUEPRINT_DIRNAME, hashFileContent } from '../blueprint/store.js';
import {
  foldKnowledgeStatus,
  knowledgeItemIdInput,
  knowledgeStatusLine,
  type FoldedKnowledgeStatus,
  type KnowledgeItemKind,
  type KnowledgeStatusEntry,
} from './knowledge-status-fold.js';

// The pure rules (vocabulary, fold, resolver) live in `knowledge-status-fold.ts`
// so the app compiles the SAME code; they are re-exported here so every CLI
// caller keeps one import.
export {
  KNOWLEDGE_ITEM_KINDS,
  KNOWLEDGE_STATUSES,
  KnowledgeStatusRefusal,
  foldKnowledgeStatus,
  itemStampOf,
  knowledgeStatusLine,
  resolveItemStatus,
  type FoldedKnowledgeStatus,
  type ItemStamp,
  type KnowledgeItemKind,
  type KnowledgeStatusEntry,
  type KnowledgeStatusValue,
  type ResolvedItemStatus,
} from './knowledge-status-fold.js';

export const KNOWLEDGE_STATUS_FILENAME = 'knowledge-status.jsonl';

/** The stable id of one item. See the module header for what goes in. */
export function knowledgeItemId(input: {
  kind: KnowledgeItemKind;
  scope: string;
  text: string;
  learnedAt?: string | null;
}): string {
  return hashFileContent(knowledgeItemIdInput(input)).slice(0, 16);
}

function knowledgeStatusPath(flowDir: string): string {
  return join(flowDir, BLUEPRINT_DIRNAME, KNOWLEDGE_STATUS_FILENAME);
}

/**
 * Append one status line. The ONLY writer. Throws `KnowledgeStatusRefusal`
 * (nothing written) for an entry outside the vocabulary. A line already in the
 * log is not written again — identical promotions stay one line locally, and
 * the union merge does the same across machines.
 */
export function appendKnowledgeStatus(flowDir: string, entry: KnowledgeStatusEntry): void {
  const line = knowledgeStatusLine(entry);
  const filePath = knowledgeStatusPath(flowDir);
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8').split('\n');
    if (existing.includes(line)) return;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${line}\n`, 'utf-8');
}

/** Read and fold the log. A missing or unreadable log folds to nothing. */
export function readKnowledgeStatus(flowDir: string): Map<string, FoldedKnowledgeStatus> {
  const filePath = knowledgeStatusPath(flowDir);
  if (!existsSync(filePath)) return new Map();
  try {
    return foldKnowledgeStatus(readFileSync(filePath, 'utf-8').split('\n'));
  } catch {
    return new Map();
  }
}
