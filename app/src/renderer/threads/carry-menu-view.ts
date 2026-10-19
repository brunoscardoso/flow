/**
 * THE CARRY QUESTION, IN THE MENU RATHER THAN OVER IT.
 *
 * `threads:prepareWorktree` answers `needs-choice` when the project's tree is
 * dirty: main refuses to decide what happens to somebody's uncommitted work,
 * and that refusal is right and stays. What changed is where the asking
 * happens. It used to be a centred modal with a backdrop, arriving after the
 * person had already pressed something — a scene change to ask one question
 * about three files. Now it opens on the control they pressed, in the same
 * place the rest of that control's menu appears, because it is the same
 * decision continued rather than a new event.
 *
 * EVERY WORD COMES FROM `new-thread-branch.ts`. This file owns an element, a
 * promise and nothing else — the three options, their order, the sentence above
 * them and what a dismissal means are all decided (and tested) there.
 *
 * DISMISSING MAKES NOTHING. Escape, a click anywhere else, or the anchor
 * leaving the screen all resolve null, and `prepare-worktree-flow.ts` turns
 * that into no second call at all. A person who moved their mouse has not
 * consented to a branch being cut.
 */

import { injectAnchoredMenuStyles, openAnchoredPopover } from './anchored-popover'
import type { CarryAnswer, CarryQuestion } from './new-thread-branch'

export interface CarryMenuAnchor {
  /** The control the question opens on. */
  anchor: HTMLElement
  /**
   * The element whose disappearance closes it, when that is not the anchor —
   * a chip its owner rebuilds on every update must be watched by its host.
   */
  watch?: HTMLElement
}

/** Ask the carry question on `anchor` and resolve with the press, or null. */
export function askCarryInline(
  where: CarryMenuAnchor,
  question: CarryQuestion,
): Promise<CarryAnswer> {
  injectAnchoredMenuStyles()
  return new Promise<CarryAnswer>((resolve) => {
    let answer: CarryAnswer = null
    const popover = openAnchoredPopover({
      anchor: where.anchor,
      ...(where.watch === undefined ? {} : { watch: where.watch }),
      className: 'fl-fmenu',
      ariaLabel: question.title,
      // ONE SETTLEMENT, WHATEVER HAPPENED. A press sets `answer` and then
      // closes; every other exit leaves it null. Resolving from the close
      // handler rather than from the press is what makes "dismissed" and
      // "answered" impossible to both happen.
      onClose: () => resolve(answer),
    })

    const title = document.createElement('div')
    title.className = 'fl-fmenu-title'
    title.textContent = question.title

    const body = document.createElement('p')
    body.className = 'fl-fmenu-body'
    body.textContent = question.body

    popover.panel.append(title, body)

    for (const rung of question.rungs) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'fl-fmenu-item'

      const head = document.createElement('span')
      head.className = 'fl-fmenu-item-head'
      const label = document.createElement('span')
      label.className = 'fl-fmenu-item-label'
      label.textContent = rung.label
      head.appendChild(label)

      const detail = document.createElement('span')
      detail.className = 'fl-fmenu-item-detail'
      detail.textContent = rung.detail

      item.append(head, detail)
      item.addEventListener('click', () => {
        answer = rung.id
        popover.close()
      })
      popover.panel.appendChild(item)
    }

    // Measured after the rows are in, or the flip-above test runs against an
    // empty box and the menu hangs off the bottom of a short window.
    popover.reposition()
    popover.panel.focus()
  })
}
