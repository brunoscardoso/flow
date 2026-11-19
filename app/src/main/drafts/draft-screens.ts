/**
 * Draft screens in a plan — re-exported from the CLI so `plan screens` and the
 * artifact's "Changed since the plan" badge share ONE strip, hash and block
 * shape (allowed-pattern #14). Same precedent as `shared/understood.ts`.
 */
export {
  DRAFT_SCREENS_HEADING,
  DRAFT_SLOT_ATTRIBUTE,
  draftScreensOf,
  findDraftSlots,
  hashDraftScreen,
  newestPlanFor,
  parseDraftScreensBlock,
  parseSlotTarget,
  renderDraftScreensBlock,
  screenChangedSincePlan,
  stripDraftIds,
  upsertDraftScreensBlock,
  type DraftScreenRecord,
  type DraftSlot,
} from '../../../../src/cli/state/draft-screens'
