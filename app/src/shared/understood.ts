/**
 * "% understood" — re-exported from the CLI so the board and the Workspace map
 * share ONE arithmetic (allowed-pattern #14). The CLI computes each project's
 * and the Workspace's figure with it; the renderer's title strip, domain rows
 * and Workspace sheet count with the very same function. Same precedent as
 * `flowconfig-merge.ts`: a pure module with no imports, compiled by both.
 */
export {
  featuresUnderstood,
  rollUpUnderstood,
  understoodPercent,
  type UnderstoodFraction,
  type UnderstoodNode,
} from '../../../src/cli/blueprint/understood'
