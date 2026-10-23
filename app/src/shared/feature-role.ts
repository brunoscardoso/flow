/**
 * A feature's role — re-exported from the CLI so the board and the graph share
 * ONE vocabulary and ONE guess (allowed-pattern #14). Same precedent as
 * `understood.ts`: a pure module with no imports, compiled by both.
 */
export {
  FEATURE_ROLES,
  FEATURE_ROLE_LABELS,
  guessFeatureRole,
  isFeatureRole,
  resolveFeatureRole,
  type FeatureRole,
  type FeatureRoleSource,
} from '../../../src/cli/blueprint/feature-role'
