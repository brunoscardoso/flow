/**
 * Knowledge status (draft / solid / stale / abandoned) — re-exported from the
 * CLI so the app's readers fold the status log and resolve an item with the
 * SAME rules the CLI's readers use (allowed-pattern #14). Same precedent as
 * `understood.ts`: a pure module with no imports, compiled by both. Hashing is
 * injected by the caller (`main/blueprint/knowledge-status-read.ts`).
 */
export {
  KNOWLEDGE_STATUSES,
  branchDisplayName,
  foldKnowledgeStatus,
  itemStampOf,
  knowledgeItemIdInput,
  knowledgeStatusReaderFrom,
  nodeKnowledgeStatus,
  parseProvenanceRecords,
  resolveItemStatus,
  type FoldedKnowledgeStatus,
  type KnowledgeItemRef,
  type KnowledgeProvenance,
  type KnowledgeStatusReader,
  type ResolvedItemStatus,
} from '../../../src/cli/state/knowledge-status-fold'
