// Pure completeness helpers for the AskUserQuestion carousel (#414). The
// carousel (#400) hides all but the current question, so a disabled Submit gave
// no cue about WHICH hidden question is still unanswered. These derive the
// progress + the first gap from per-question answered flags. DOM-free.

/** Index of the first unanswered question, or -1 when all are answered. */
export function firstUnansweredIndex(answered: readonly boolean[]): number {
  return answered.findIndex((isAnswered) => !isAnswered)
}

/** How many questions are answered. */
export function answeredCount(answered: readonly boolean[]): number {
  return answered.reduce((total, isAnswered) => total + (isAnswered ? 1 : 0), 0)
}
