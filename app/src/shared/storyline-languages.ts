/**
 * Which files open as a code story, and what each story language is called —
 * re-exported from the CLI so the board and the reader share ONE list
 * (allowed-pattern #14). Same precedent as `understood.ts`: a pure module with
 * no imports, compiled by both; the CLI's test keeps it in step with the
 * readers it actually has.
 */
export {
  isStorylineExtensionPath,
  MIXED_STORYLINE_LANGUAGE,
  STORYLINE_LANGUAGE_LABELS,
  storylineLanguageBadge,
  type StorylineLanguageLabel,
} from '../../../src/cli/blueprint/storyline-language-labels'
