// Availability-aware root selection (#350) — now a thin re-export of the shared
// seam in `src/shared/root-selection.ts`.
//
// #263 added the `available` flag so a persisted-but-unmounted project root renders
// greyed-out + inert in the sidebar; #350 centralized the filter across
// `src/renderer/threads/**`. The same question is asked from the MAIN process too
// (boot restore #975, the setActiveProject guard #974, the post-remove hand-off
// #1080, the live availability refresh #1118), so the helpers moved to `shared/`
// where both processes import one implementation (allowed-pattern #14). This module
// stays as the renderer-side name every thread surface already imports.
export {
  availableRoots,
  firstAvailableRoot,
  hasAvailableRoot,
  isRootAvailable,
  nextActiveRootAfterRemove,
  resolveActiveRoot,
  type ActivationDecision,
  type ActivationReason,
} from '../../shared/root-selection'
