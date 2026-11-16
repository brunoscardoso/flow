/**
 * THE READERS' ONE DOOR to knowledge status (discovery
 * `workspace_knowledge_draft_solid`, FR-9).
 *
 * Feature summaries, the feature graph and brain search all ask the same
 * question — "is this learning solid, draft or abandoned?" — and must get the
 * same answer, so they all build ONE reader here: the status log and the
 * provenance records are read once per call and every item is resolved through
 * `resolveItemStatus`. The app's Ask reads the same two files through the same
 * pure rules (`knowledge-status-fold.ts`, re-exported to the app).
 */
import { hashFileContent } from '../blueprint/store.js';
import { readProvenanceRecords } from './knowledge-provenance.js';
import {
  knowledgeItemIdInput,
  knowledgeStatusReaderFrom,
  type KnowledgeItemRef,
  type KnowledgeStatusReader,
  type ResolvedItemStatus,
} from './knowledge-status-fold.js';
import { readKnowledgeStatus } from './knowledge-status-log.js';

export type { KnowledgeItemRef, KnowledgeStatusReader } from './knowledge-status-fold.js';
export { nodeKnowledgeStatus, branchDisplayName } from './knowledge-status-fold.js';

/** One reader over `flowDir`'s log and records, each file read once. */
export function createKnowledgeStatusReader(flowDir: string): KnowledgeStatusReader {
  return knowledgeStatusReaderFrom(readKnowledgeStatus(flowDir), readProvenanceRecords(flowDir), (item) =>
    hashFileContent(knowledgeItemIdInput(item)).slice(0, 16),
  );
}

/** One item's status. For many items, build a reader once instead. */
export function itemStatusOf(flowDir: string, item: KnowledgeItemRef): ResolvedItemStatus {
  return createKnowledgeStatusReader(flowDir).of(item);
}

/** A reader that answers solid for everything — a caller with no store to read. */
export const ALL_SOLID_READER: KnowledgeStatusReader = {
  of: () => ({ status: 'solid', stale: false, branch: null }),
};
