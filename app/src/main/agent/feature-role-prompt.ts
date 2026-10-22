// feature-role-prompt — how a model is ASKED for a feature's role, and how its
// answer is read (plan `feature-type-icons`, FR-3, FR-5, FR-10).
//
// Shared by the feature learn prompt, the feature-view prompt and the classify
// pass, so all three choose from the same words with the same guidance. Pure
// and dependency-free (beyond the shared vocabulary) so the classify pass's
// tests need none of the learn session's runtime.
//
// The model is told the list; the CLI verb is what actually checks a value
// (allowed-pattern #14). `normaliseFeatureRole` only decides whether an answer
// is worth sending at all.

import { FEATURE_ROLES, isFeatureRole, type FeatureRole } from '../../shared/feature-role'

/** What each role means, in the words a model can choose by. Prompt text only. */
const ROLE_HINTS: Readonly<Record<FeatureRole, string>> = {
  ui: 'screens and components a person sees and clicks',
  api: 'a surface other code calls — routes, endpoints, IPC handlers, commands',
  logic: 'rules and decisions — the domain code in the middle',
  data: 'storage — a database, a store, a schema, files kept on disk',
  config: 'settings, and the code that reads and applies them',
  jobs: 'work that runs in the background or on a schedule',
  integration: 'a connection to an outside service or tool',
  service: 'a long-running process, or a part that coordinates others',
  function: 'small shared helpers and utilities',
  mobile: 'an iOS or Android app',
  neutral: 'none of these fits, or you are not sure',
}

/**
 * The prompt lines that ask for a role. Shared by the feature learn prompt, the
 * feature-view prompt and the classify pass, so all three choose from the same
 * words with the same guidance.
 */
export function featureRolePromptLines(subject: string): string[] {
  return [
    `"role" — ONE word for what kind of thing ${subject} is, copied exactly from this list:`,
    ...FEATURE_ROLES.map((role) => `- ${role}: ${ROLE_HINTS[role]}`),
    'Choose by what it IS for the person who uses it or works on it, not by the language it is written in.',
    'If no single word fits, or you are unsure, answer "neutral" — a wrong role is worse than none.',
  ]
}

/** Read one role value: trimmed, lower-cased, and only when it is on the list. */
export function normaliseFeatureRole(value: unknown): FeatureRole | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim().toLowerCase()
  return isFeatureRole(candidate) ? candidate : null
}
