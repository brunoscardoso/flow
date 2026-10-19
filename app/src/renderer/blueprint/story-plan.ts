/**
 * WHICH PLAN A CODE STORY IS READ AGAINST (story-today-after) — pure, no DOM.
 *
 * A story carries a plan's Today ⇄ After when a plan is in flight for it. That
 * plan used to come from the review a story was opened from — the board's
 * discovery view, retired on 2026-10-08. It now comes from the plan narrated
 * on the board: `/create-plan` compiles its plan's `## Story` into the
 * project's story, and archiving the plan clears it, so the compiled story
 * names the plan in flight or nothing.
 *
 * The board asks the CLI for every story in that plan's context, and keeps the
 * comparison only when the plan touches the story on screen: a story the plan
 * says nothing about gets no Today ⇄ After at all, exactly as a story outside
 * any plan never had one.
 */
import type { StorylineAnswer, StorylineCompare } from '../../shared/ipc-contract'

/**
 * THE PLAN A STORY IS READ AGAINST (plan `plan_change_review`): the plan
 * whose change notes are being reviewed — named by the review request, which
 * came from the plan's own card — wins. Without a review, a plan WITHOUT notes
 * still comes from the compiled story, exactly as before (FR-21): plans with
 * notes stop authoring a Story, so the compiled story never names one.
 */
export function storyPlanFor(review: { plan: string } | null | undefined, story: { plan?: string | null } | null | undefined): string | null {
  const reviewed = review?.plan
  if (typeof reviewed === 'string' && reviewed.trim().length > 0) return reviewed
  return storyPlanOf(story)
}

/** The plan in flight on this board — the compiled story's — or null. */
export function storyPlanOf(story: { plan?: string | null } | null | undefined): string | null {
  const plan = story?.plan
  return typeof plan === 'string' && plan.trim().length > 0 ? plan : null
}

/** Whether a plan's comparison says anything about the story it came with. */
export function compareTouchesStory(compare: StorylineCompare): boolean {
  const { changed, added, removed, predicted, planned } = compare.summary
  return changed + added + removed + predicted + planned > 0
}

/** The answer as the board shows it: a comparison that touches nothing is dropped. A plan with change notes always touches its review. */
export function withTouchingCompare(answer: StorylineAnswer): StorylineAnswer {
  if (!answer.ok || answer.compare === undefined || compareTouchesStory(answer.compare)) return answer
  if (answer.compare.predicted.some((prediction) => prediction.kind.startsWith('note-'))) return answer
  const { compare: _untouched, ...rest } = answer
  return rest
}
