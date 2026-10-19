/**
 * The ENTRIES AND EXITS half of the feature-view prompt — re-exported from the
 * CLI so the app's generation prompt and the CLI's validator state ONE set of
 * rules (allowed-pattern #14): the cap the prompt asks for is the cap
 * `validateFeatureView` refuses past. Same precedent as `understood.ts`: a pure
 * module with no imports, compiled by both.
 */
export {
  PORTS_EXAMPLE_LINE,
  VIEW_PORT_CROSSES_MAX,
  viewPortsPromptLines,
} from '../../../src/cli/blueprint/feature-view-ports-prompt'
