/**
 * Workflow-aware next-step suggestion (pure — no DOM, unit-testable).
 *
 * plan-flow skills run in a recommended order; after one skill runs, the
 * composer surfaces a one-click button for the next (e.g. /discovery-plan
 * after /brainstorm). This module owns the ordering map and the logic that
 * reads a thread's history to pick the suggestion.
 */
import type { SlashCommand } from '../../shared/ipc-contract'

/** First-token slash command of a message (e.g. "/brainstorm foo" → "brainstorm"). */
export const LEADING_COMMAND_RE = /^\/([\w-]+)/

/**
 * plan-flow workflow order — running one skill suggests the next. Only steps
 * with a defined successor produce a suggestion; terminal steps (review-*)
 * intentionally have none.
 */
export const WORKFLOW_NEXT_STEP: Readonly<Record<string, string>> = {
  setup: 'discovery-plan',
  brainstorm: 'discovery-plan',
  'discovery-plan': 'create-plan',
  // A discovery's artifact (its walkthrough page) is written on request after
  // the discovery; the step after it is still the plan.
  artifact: 'create-plan',
  'create-plan': 'execute-plan',
  'execute-plan': 'review-code',
}

/**
 * The recommended next skill, keyed strictly off the LAST user message. The
 * suggestion is meant to appear only at the moment a workflow command finishes
 * executing — so if the most recent user message isn't itself a workflow
 * command (it was ordinary chat, or an earlier command buried under later
 * messages), there is nothing to suggest. Returns the resolved SlashCommand
 * (so callers get its description) or null when there is nothing to suggest /
 * the skill is not installed in this project.
 */
export function computeNextStepCommand(
  messages: ReadonlyArray<{ role: string; content: string }>,
  commands: ReadonlyArray<SlashCommand>,
): SlashCommand | null {
  let lastUser: { role: string; content: string } | null = null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message && message.role === 'user') {
      lastUser = message
      break
    }
  }
  if (!lastUser) return null
  const match = LEADING_COMMAND_RE.exec(lastUser.content.trim())
  if (!match) return null
  const next = WORKFLOW_NEXT_STEP[match[1] ?? '']
  if (!next) return null
  return commands.find((command) => command.name === next) ?? null
}

/**
 * Is the next-step button shown? Only once the step it follows has FINISHED:
 * a suggestion exists, a thread is open, no turn is running, and the thread
 * has no background work running or queued. A turn can end while the skill's
 * own work goes on — `/execute-plan` hands phases to background sub-agents and
 * replies "Phase 4 is still running" — and offering `/review-code` then
 * recommends a step whose input does not exist yet.
 */
export function nextStepVisible(state: {
  hasSuggestion: boolean
  hasThread: boolean
  status: string
  backgroundBusy: boolean
}): boolean {
  return state.hasSuggestion && state.hasThread && state.status !== 'working' && !state.backgroundBusy
}
