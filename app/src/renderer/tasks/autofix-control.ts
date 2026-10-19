// "LET THE LOOP WORK THIS" — the one control, on both surfaces that ask it.
//
// The tick started on the task detail, where a card already exists and the
// answer can be written straight to it. The user then asked for it on the
// remote ticket too, and gave the reason: "when I add that to todo, I already
// wanna that information there". Deciding it at the moment you take work on is
// one gesture; opening the card afterwards to tick a box is two, and the second
// one is the one people forget.
//
// THE TWO SURFACES DIFFER IN WHEN THE ANSWER LANDS, and in nothing else. On a
// task the write is immediate — there is a record to patch. On a remote ticket
// there is no record yet, so the answer is held and handed to the create. That
// difference is the caller's; everything a reader SEES is here, so the two
// cannot drift into saying different things about the same switch (the lesson
// the ticket chrome learned the hard way).

/** What the line under the box says, in each state. */
export interface AutoFixWording {
  /** When the box is ticked. */
  on: string
  /** When it is not. */
  off: string
}

/** What pressing play will do to a card that already sits on the board. */
export const AUTOFIX_ON_BOARD: AutoFixWording = {
  on: 'Pressing ▶ on Todo will work this card in its own chat.',
  off: 'Pressing ▶ on Todo will skip this card.',
}

/**
 * What it will mean for a ticket that is about to become a card.
 *
 * SAID IN THE FUTURE TENSE, because that is what is true: this ticket is on
 * somebody else's tracker and nothing here has happened to it yet. Telling a
 * reader "▶ will work this card" over an item that is not on the board would be
 * the control describing a state it has not reached.
 */
export const AUTOFIX_ON_IMPORT: AutoFixWording = {
  on: 'It will be added ready to work — ▶ on Todo will pick it up.',
  off: 'It will be added as a note. ▶ on Todo will skip it.',
}

export interface AutoFixControl {
  /** The row and its explanation, to append into a ticket section. */
  nodes: HTMLElement[]
  /** What the box currently says. */
  value(): boolean
  /** Put the box back — for a write that did not land. */
  reset(value: boolean): void
}

/**
 * Build the tick.
 *
 * `onChange` is told what the reader asked for. It may reject the change by
 * calling `reset` — which is how the task surface puts the box back when the
 * store refused, rather than leaving the app claiming a card is offered to the
 * loop when it is not.
 */
export function createAutoFixControl(
  initial: boolean,
  wording: AutoFixWording,
  onChange?: (value: boolean, control: AutoFixControl) => void,
): AutoFixControl {
  const row = document.createElement('label')
  row.className = 'fl-board-autofix'
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = initial
  const label = document.createElement('span')
  label.textContent = 'Let the loop work this'
  const why = document.createElement('span')
  why.className = 'fl-board-autofix-why'
  why.textContent = initial ? wording.on : wording.off
  row.append(box, label)

  const control: AutoFixControl = {
    nodes: [row, why],
    value: () => box.checked,
    reset: (value: boolean) => {
      box.checked = value
      box.disabled = false
      why.textContent = value ? wording.on : wording.off
    },
  }
  box.addEventListener('change', () => {
    why.textContent = box.checked ? wording.on : wording.off
    onChange?.(box.checked, control)
  })
  return control
}
