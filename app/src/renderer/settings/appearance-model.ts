// Settings › Appearance selector metadata (#399). Pure/DOM-free so the option set
// and labels are unit-testable; settings-view.ts renders these into a <select> and
// wires it to the theme controller.
import { FEED_DENSITIES, type FeedDensity } from '../threads/feed-density'
import { THEME_MODES, type ThemeMode } from '../theme/theme-model'

export interface ThemeModeOption {
  mode: ThemeMode
  label: string
  hint: string
}

const LABELS: Record<ThemeMode, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

const HINTS: Record<ThemeMode, string> = {
  light: 'Always use the light theme.',
  dark: 'Always use the dark theme.',
  system: 'Follow your operating system, switching automatically.',
}

/** Human label for a mode. */
export function themeModeLabel(mode: ThemeMode): string {
  return LABELS[mode]
}

/** Selector options in presentation order (light, dark, system). */
export const THEME_MODE_OPTIONS: readonly ThemeModeOption[] = THEME_MODES.map((mode) => ({
  mode,
  label: LABELS[mode],
  hint: HINTS[mode],
}))

// ── Conversation density (plan_chat-feed-signal_v1, Phase 5 / Q-1) ──────────
//
// A per-USER reading preference, so it sits beside the theme rather than in
// flow/.flowconfig: that file is per project and is committed, so a person
// reading two projects would set this twice and ship their choice to the team.

export interface FeedDensityOption {
  density: FeedDensity
  label: string
  hint: string
}

const DENSITY_LABELS: Record<FeedDensity, string> = {
  compact: 'Compact',
  balanced: 'Balanced',
  detailed: 'Detailed',
}

// Each hint says what the reader will SEE, not which fold is skipped — the
// mechanism is ours, the picture is theirs.
const DENSITY_HINTS: Record<FeedDensity, string> = {
  compact: 'One row per turn saying what the agent did. Click it to open.',
  balanced: 'Group the work by activity — commands, context, edits.',
  detailed: 'Every tool call, on its own. Nothing is folded away.',
}

/** Human label for a density. */
export function feedDensityLabel(density: FeedDensity): string {
  return DENSITY_LABELS[density]
}

/** Selector options in presentation order (compact, balanced, detailed). */
export const FEED_DENSITY_OPTIONS: readonly FeedDensityOption[] = FEED_DENSITIES.map(
  (density) => ({
    density,
    label: DENSITY_LABELS[density],
    hint: DENSITY_HINTS[density],
  }),
)
