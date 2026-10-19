// Technical-brief affordance gating (#362). generateTaskBrief (main) short-circuits
// to 'idle' when a task has no description and no external issue key — so a manual
// title-only task's "Generate technical brief" button was a DEAD CLICK: no brief, no
// error, no feedback. The board should only offer the action when it can succeed;
// otherwise it shows a hint. This pure predicate mirrors main's taskHasBriefContent
// so the two stay consistent; the board renders from it. Unit-testable (no DOM).
import type { TaskSummary } from '../../shared/ipc-contract'

/** Whether a task has enough content to generate a technical brief — a non-empty
 *  description or an external issue key (mirrors main's taskHasBriefContent). */
export function canGenerateBrief(
  task: Pick<TaskSummary, 'description' | 'externalKey'>,
): boolean {
  return Boolean((task.description && task.description.trim()) || task.externalKey)
}
