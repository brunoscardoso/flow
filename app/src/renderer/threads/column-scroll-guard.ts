/**
 * THE CHAT COLUMN NEVER SCROLLS AS A WHOLE (user, 2026-10-09: "sometimes we
 * are adding that big space here on the bottom of the text input").
 *
 * The column is sized to its panel: the transcript scrolls inside itself and
 * the composer sits at the foot. But the boxes around it — the panel's body,
 * the panel, its wrapper, the split pane — clip their content and can still be
 * scrolled by code (a focus, a caret, a find, a scroll-into-view). When any of
 * them is scrolled, the whole column slides up and leaves an empty band under
 * the input, with a scrollbar beside it. Nothing a person does can scroll it
 * back, because none of those boxes shows a scrollbar it lets you drag.
 *
 * The trigger was not reproduced, so this does two things: it puts every such
 * box back at the top the moment it moves, and it reports which one moved and
 * what had focus — so the next time it happens the cause is in the log.
 */

/** The slice of an element the guard reads and writes (injectable for tests). */
export interface ScrollBox {
  scrollTop: number
  scrollLeft: number
  addEventListener(type: 'scroll', listener: () => void): void
}

/** At most this many reports a session — evidence, not a stream. */
export const MAX_COLUMN_SCROLL_REPORTS = 5

export interface ColumnScrollGuard {
  /** Watch these boxes (already-watched ones are skipped). */
  watch(boxes: ReadonlyArray<{ box: ScrollBox; name: string }>): void
}

/**
 * `report` receives one line per reset, at most MAX_COLUMN_SCROLL_REPORTS.
 * `context` names what had focus when it happened.
 */
export function createColumnScrollGuard(
  report: (line: string) => void,
  context: () => string = () => '',
): ColumnScrollGuard {
  const watched = new WeakSet<ScrollBox>()
  let reports = 0
  return {
    watch(boxes) {
      for (const { box, name } of boxes) {
        if (watched.has(box)) continue
        watched.add(box)
        box.addEventListener('scroll', () => {
          const top = box.scrollTop
          const left = box.scrollLeft
          if (top === 0 && left === 0) return
          box.scrollTop = 0
          box.scrollLeft = 0
          if (reports >= MAX_COLUMN_SCROLL_REPORTS) return
          reports += 1
          const where = context()
          report(`chat column scrolled: ${name} by ${top}px down, ${left}px across — put back${where ? `; focus: ${where}` : ''}`)
        })
      }
    },
  }
}
