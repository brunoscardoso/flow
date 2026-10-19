// The "keep looking" control, drawn once and mounted on both surfaces that
// create work: the board's New task modal and the chat column's New thread page.
//
// ONE CONTROL, TWO HOSTS, because it is one decision. A hunt started from a task
// and a hunt started from a thread differ in what they are pointed at, not in
// how they end — and two hand-written copies of a three-way picker is how the
// two surfaces start offering different hours.
//
// IT IS CLOSED UNTIL IT IS ASKED FOR. The toggle is one line; everything below
// it appears only when the loop is on, because "the user needs to configure the
// loop" is a consequence of switching it on, not a permanent tax on the form
// that every person creating an ordinary task has to read past.
//
// The model beside it (hunt-config.ts) owns every word and the one refusal;
// this file owns the elements and the events, and holds no rules of its own.

import {
  HUNT_STOP_CHOICES,
  emptyHuntConfig,
  huntConfigNote,
  huntConfigRefusal,
  huntTargetFor,
  MAX_HUNT_FINDINGS,
  type HuntConfig,
  type HuntStopKind,
  type HuntTarget,
} from './hunt-config'
import { HUNT_STOP_HOURS, MAX_HUNT_RULE_LENGTH } from './hunt-limits'
import type { LoopsSnapshot } from '../../shared/ipc-contract'

/** How the switch itself is drawn. */
export type HuntConfigVariant = 'checkbox' | 'chip'

/** A mounted control: its elements, what it currently says, and a change signal. */
export interface HuntConfigControl {
  /** The switch and its configuration, stacked — for a host that wants one node. */
  element: HTMLElement
  /**
   * The switch alone, and the configuration alone.
   *
   * EXPOSED SEPARATELY because on the New-thread page the switch belongs in the
   * settings ROW, beside "On the task board" — the user's own grouping:
   * "everything related to task should be there together" — while its
   * configuration needs the full width underneath. A host that places them
   * itself must not also get them inside `element`, so `element` is left empty
   * in that case rather than holding a second copy.
   */
  toggleEl: HTMLElement
  panelEl: HTMLElement
  /** Show or hide the whole control, and switch the hunt off when hiding it. */
  setAvailable(available: boolean): void
  /** What the person has set right now. A copy — mutating it changes nothing. */
  read(): HuntConfig
  /** Restore a previously-read configuration (a preserved draft). */
  write(config: HuntConfig): void
  /**
   * Tell the control which loops this project has.
   *
   * CALLED WHENEVER THE ANSWER CHANGES, including with `null` for "not read
   * yet" — the control renders those three states differently on purpose, and a
   * host that only called it on success would show "no loop that looks for
   * work" for as long as the read took.
   */
  setLoops(loops: LoopsSnapshot | null): void
  /**
   * Which loop a hunt would run as, or null when the loop is off or no single
   * one is settled. Read at submit time, beside `read()`.
   */
  targetLoop(): string | null
  /** Why a create cannot proceed, or null. Mirrors `huntConfigRefusal`. */
  refusal(): string | null
}

/**
 * Build the control.
 *
 * `onChange` fires on every edit so a host can re-sync its own submit button:
 * a custom rule with nothing typed in it is a real refusal, and a form whose
 * Create button stays live over one is a dead click waiting to happen.
 */
export function createHuntConfig(
  onChange: () => void = () => undefined,
  variant: HuntConfigVariant = 'checkbox',
): HuntConfigControl {
  const state: HuntConfig = emptyHuntConfig()
  let available = true
  // Starts as "not read yet", which is the truth before a host says otherwise —
  // never as "this project has none", which would be a claim nobody measured.
  let target: HuntTarget = huntTargetFor(null)

  const element = document.createElement('div')
  element.className = 'fl-hunt'

  // ── the switch ───────────────────────────────────────
  // A CHECKBOX IN A FORM, A CHIP IN A ROW. Both write the same one boolean;
  // what differs is only what the surrounding surface is made of — the board's
  // modal is a column of labelled fields, the New-thread page's settings row is
  // a row of pressable chips, and a checkbox dropped into that row reads as a
  // stray form control.
  const toggle = document.createElement(variant === 'chip' ? 'button' : 'label')
  toggle.className = variant === 'chip' ? 'fl-newthread-chip fl-hunt-chip' : 'fl-hunt-toggle'
  const check = document.createElement('input')
  check.type = 'checkbox'
  const toggleText = document.createElement('span')
  toggleText.className = 'fl-hunt-toggle-text'
  const toggleHint = document.createElement('div')
  toggleHint.className = 'fl-hunt-toggle-hint'
  toggleHint.textContent = 'Runs as a loop and files what it finds.'

  if (variant === 'chip') {
    ;(toggle as HTMLButtonElement).type = 'button'
    toggle.append(toggleText)
    toggle.addEventListener('click', () => {
      state.on = !state.on
      check.checked = state.on
      sync()
      if (state.on) findingsInput.focus()
    })
  } else {
    toggle.append(check, toggleText)
    element.appendChild(toggle)
    // ON ITS OWN LINE, not trailing the label. Beside it, the label wrapped and
    // the hint wrapped with it, so the one-line switch became four lines of
    // ragged text.
    element.appendChild(toggleHint)
  }

  // ── the rule, revealed ───────────────────────────────
  const panel = document.createElement('div')
  panel.className = 'fl-hunt-panel'
  panel.hidden = true

  const kindRow = document.createElement('div')
  kindRow.className = 'fl-hunt-row'
  const kindLabel = document.createElement('span')
  kindLabel.className = 'fl-hunt-label'
  kindLabel.textContent = 'Stop after'
  const kindTabs = document.createElement('div')
  kindTabs.className = 'fl-hunt-kinds'
  kindTabs.setAttribute('role', 'radiogroup')
  kindTabs.setAttribute('aria-label', 'What stops this loop')
  const kindButtons = new Map<HuntStopKind, HTMLButtonElement>()
  for (const choice of HUNT_STOP_CHOICES) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-hunt-kind'
    button.setAttribute('role', 'radio')
    button.textContent = choice.label
    button.addEventListener('click', () => {
      state.kind = choice.kind
      sync()
      // Put the caret where the person now has to answer. Switching to a rule
      // and being left with nothing focused is how a required field gets
      // missed.
      if (choice.kind === 'custom') ruleInput.focus()
    })
    kindTabs.appendChild(button)
    kindButtons.set(choice.kind, button)
  }
  kindRow.append(kindLabel, kindTabs)
  panel.appendChild(kindRow)

  // findings — ON THE SAME ROW as the picker it belongs to. A number and a
  // dropdown are each one control wide; giving them a line of their own put
  // three lines of chrome above the box somebody came here to type in.
  const findingsWrap = document.createElement('span')
  findingsWrap.className = 'fl-hunt-value'
  const findingsInput = document.createElement('input')
  findingsInput.type = 'number'
  findingsInput.className = 'fl-hunt-number'
  findingsInput.min = '1'
  findingsInput.max = String(MAX_HUNT_FINDINGS)
  findingsInput.setAttribute('aria-label', 'Findings before it stops')
  findingsInput.addEventListener('input', () => {
    const parsed = Number.parseInt(findingsInput.value, 10)
    state.findings = Number.isInteger(parsed) ? parsed : 0
    sync()
  })
  const findingsUnit = document.createElement('span')
  findingsUnit.className = 'fl-hunt-unit'
  findingsUnit.textContent = 'findings'
  findingsWrap.append(findingsInput, findingsUnit)
  kindRow.appendChild(findingsWrap)

  // time — same row, same reason.
  const hoursSelect = document.createElement('select')
  hoursSelect.className = 'fl-hunt-select'
  hoursSelect.setAttribute('aria-label', 'How long it runs for')
  for (const hours of HUNT_STOP_HOURS) {
    const option = document.createElement('option')
    option.value = String(hours)
    option.textContent = hours === 1 ? '1 hour' : `${String(hours)} hours`
    hoursSelect.appendChild(option)
  }
  hoursSelect.addEventListener('change', () => {
    state.hours = Number.parseInt(hoursSelect.value, 10)
    sync()
  })
  kindRow.appendChild(hoursSelect)

  // A RULE KEEPS ITS OWN LINE, and it is the one that has to: the others are a
  // number and a choice from seven, and this is a sentence somebody types.
  const ruleRow = document.createElement('div')
  ruleRow.className = 'fl-hunt-row fl-hunt-value'
  const ruleInput = document.createElement('input')
  ruleInput.type = 'text'
  ruleInput.className = 'fl-hunt-rule'
  ruleInput.maxLength = MAX_HUNT_RULE_LENGTH
  ruleInput.placeholder = 'if you find the same bug in a second place, stop'
  ruleInput.setAttribute('aria-label', 'What makes it stop')
  ruleInput.addEventListener('input', () => {
    state.rule = ruleInput.value
    sync()
  })
  ruleRow.append(ruleInput)
  panel.appendChild(ruleRow)

  // WHICH LOOP, only when there is a question. One producer needs no picker and
  // must not grow one; several is a question the person creating the work is the
  // one who can answer (see `huntTargetFor`).
  const loopRow = document.createElement('div')
  loopRow.className = 'fl-hunt-row fl-hunt-value'
  loopRow.hidden = true
  const loopLabel = document.createElement('span')
  loopLabel.className = 'fl-hunt-label'
  loopLabel.textContent = 'Run as'
  const loopSelect = document.createElement('select')
  loopSelect.className = 'fl-hunt-select'
  loopSelect.setAttribute('aria-label', 'Which loop looks for this')
  loopSelect.addEventListener('change', () => sync())
  loopRow.append(loopLabel, loopSelect)
  panel.appendChild(loopRow)

  // What will happen, in a sentence — or why it cannot yet.
  const note = document.createElement('div')
  note.className = 'fl-hunt-note'
  panel.appendChild(note)
  if (variant !== 'chip') element.appendChild(panel)

  /**
   * The loop a hunt would run as right now.
   *
   * The picker's own value wins when there IS a picker, because the person
   * chose it; otherwise the single producer, resolved from the snapshot.
   */
  function resolvedLoop(): string | null {
    if (!loopRow.hidden && loopSelect.value.length > 0) return loopSelect.value
    return target.ok ? target.loop : null
  }

  /**
   * Repaint, and tell the host.
   *
   * `notify` EXISTS BECAUSE OF A BOOT CRASH. The first paint used to call
   * `onChange` like every other one, and both hosts write
   * `const hunt = createHuntConfig(() => syncSubmit())` where `syncSubmit`
   * reads `hunt` — so the handler ran while `hunt` was still in its temporal
   * dead zone and threw `Cannot access 'hunt' before initialization`. In the
   * New-thread page that throw happened during `initThreads`, which took the
   * whole threads sidebar down with it: an empty panel, no error on screen,
   * nothing to click.
   *
   * Nobody needed that call. A host paints its own submit state immediately
   * after building the control; the notification is for EDITS. So the first
   * paint is silent, and the trap is gone for every host written after this
   * one rather than worked around in each of them.
   */
  function sync(notify = true): void {
    // The chip says its own state, the way every chip on that row does — and
    // SHORT, because it shares one row with the source picker and the board
    // chip. "Keep looking for more like this" is the right sentence for a form
    // and wraps the row onto a second line here; the sentence moves to the
    // hover, where a chip's explanation belongs.
    toggleText.textContent =
      variant !== 'chip' ? 'Keep looking for more like this' : state.on ? 'Loop on' : 'Loop off'
    if (variant === 'chip') {
      toggle.classList.toggle('is-on', state.on)
      toggle.setAttribute('aria-pressed', String(state.on))
      toggle.setAttribute('aria-label', 'Keep looking for more like this')
      if (toggle.title.length === 0 || !toggle.classList.contains('disabled')) {
        toggle.title = state.on
          ? 'Keeps looking for more like this and files what it finds — press to stop'
          : 'Keep looking for more like this: runs as a loop and files what it finds'
      }
    }
    panel.hidden = !state.on || !available
    for (const [kind, button] of kindButtons) {
      const active = kind === state.kind
      button.classList.toggle('active', active)
      button.setAttribute('aria-checked', active ? 'true' : 'false')
    }
    findingsWrap.hidden = state.kind !== 'findings'
    hoursSelect.hidden = state.kind !== 'duration'
    ruleRow.hidden = state.kind !== 'custom'
    // THE REFUSAL WINS THE LINE. When something is missing, the sentence under
    // the control has to be the thing to do about it — not a description of a
    // hunt that cannot start. A missing LOOP outranks a missing rule: there is
    // no point saying what would stop a hunt that has nothing to run as.
    const refusal =
      state.on && resolvedLoop() === null && !target.ok ? target.reason : huntConfigRefusal(state)
    const said = refusal ?? huntConfigNote(state)
    note.textContent = said ?? ''
    // A note with nothing to say takes no room: the row above it is usually the
    // whole sentence (see `huntConfigNote`).
    note.hidden = said === null
    note.classList.toggle('refusal', refusal !== null)
    if (notify) onChange()
  }

  check.addEventListener('change', () => {
    state.on = check.checked
    sync()
    if (state.on) findingsInput.focus()
  })

  function paintInputs(): void {
    check.checked = state.on
    findingsInput.value = String(state.findings)
    hoursSelect.value = String(state.hours)
    ruleInput.value = state.rule
  }

  paintInputs()
  sync(false)

  return {
    element,
    read: () => ({ ...state }),
    write: (config) => {
      state.on = config.on
      state.kind = config.kind
      state.findings = config.findings
      state.hours = config.hours
      state.rule = config.rule
      paintInputs()
      sync()
    },
    toggleEl: toggle,
    panelEl: panel,
    setAvailable: (next) => {
      available = next
      toggle.hidden = !available
      // SWITCHED OFF ON THE WAY OUT. A hidden control that still said "on"
      // would start a hunt nobody could see they had asked for.
      if (!available && state.on) {
        state.on = false
        check.checked = false
      }
      sync()
    },
    setLoops: (loops) => {
      target = huntTargetFor(loops)
      const choices = target.ok ? [] : (target.loops ?? [])
      loopRow.hidden = choices.length === 0
      // Rebuilt rather than diffed, and the SELECTION IS KEPT when the name is
      // still there: a background re-read must not silently re-point a hunt the
      // person already chose a loop for.
      const chosen = loopSelect.value
      loopSelect.textContent = ''
      for (const name of choices) {
        const option = document.createElement('option')
        option.value = name
        option.textContent = name
        loopSelect.appendChild(option)
      }
      if (choices.includes(chosen)) loopSelect.value = chosen
      // A project with nothing to hunt with gets a switch that says so rather
      // than one that fails on press (forbidden-pattern #12).
      const usable = target.ok || choices.length > 0
      check.disabled = !usable
      if (variant === 'chip') (toggle as HTMLButtonElement).disabled = !usable
      toggle.classList.toggle('disabled', !usable)
      toggle.title = usable || target.ok ? '' : target.reason
      if (!usable && state.on) {
        state.on = false
        check.checked = false
      }
      sync()
    },
    targetLoop: () => (state.on ? resolvedLoop() : null),
    refusal: () => {
      if (!state.on) return null
      if (resolvedLoop() === null) return target.ok ? null : target.reason
      return huntConfigRefusal(state)
    },
  }
}

/**
 * The control's styles.
 *
 * A STRING RATHER THAN A STYLESHEET because both hosts already inject their own
 * light-DOM CSS the same way, and a control that carries its own rules cannot be
 * mounted somewhere that forgot to import them.
 *
 * NO BACKTICKS ANYWHERE IN HERE, comments included — this is a template literal
 * and one backtick ends it, with a TypeScript error pointing somewhere else
 * entirely.
 */
export const HUNT_CONFIG_STYLES = `
  .fl-hunt { display: flex; flex-direction: column; gap: var(--fl-space-xs); }
  .fl-hunt-toggle {
    display: flex; align-items: center; gap: var(--fl-space-xs);
    cursor: pointer; user-select: none;
    font-size: var(--fl-text-ui-size); color: var(--fl-color-text);
  }
  .fl-hunt-toggle input { margin: 0; flex: none; }
  .fl-hunt-toggle-text { white-space: nowrap; }
  .fl-hunt-toggle.disabled { cursor: default; color: var(--fl-color-text-secondary); opacity: 0.6; }
  .fl-hunt-toggle-hint {
    padding-left: 22px; color: var(--fl-color-text-secondary);
    font-size: var(--fl-text-caption-size);
  }
  /* Indented under its own switch: everything here is a consequence of the line
     above it, and a flat stack reads as four unrelated fields. */
  .fl-hunt-panel {
    display: flex; flex-direction: column; gap: var(--fl-space-xs);
    padding: var(--fl-space-xs) 0 0 22px;
  }
  .fl-hunt-panel[hidden] { display: none; }
  /* WRAPS RATHER THAN CLIPS. The row is one line in a card of normal width;
     in a narrow one the value drops below the picker instead of the picker
     losing its last choice off the edge. */
  .fl-hunt-row { display: flex; align-items: center; gap: var(--fl-space-sm); flex-wrap: wrap; }
  .fl-hunt-row[hidden] { display: none; }
  .fl-hunt-label {
    color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size);
    white-space: nowrap;
  }
  .fl-hunt-kinds {
    display: inline-flex; flex: none; border-radius: var(--fl-radius-sm); overflow: hidden;
    background: var(--fl-color-bg);
  }
  .fl-hunt-kind {
    border: none; background: transparent; cursor: pointer; white-space: nowrap;
    padding: 3px 10px; font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
    color: var(--fl-color-text-secondary);
  }
  .fl-hunt-kind:hover { color: var(--fl-color-text); }
  .fl-hunt-kind.active { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
  .fl-hunt-number, .fl-hunt-select, .fl-hunt-rule {
    background: var(--fl-color-bg); color: var(--fl-color-text);
    border: var(--fl-border-width) solid transparent; border-radius: var(--fl-radius-sm);
    padding: 4px 8px; font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
  }
  .fl-hunt-number:focus, .fl-hunt-select:focus, .fl-hunt-rule:focus {
    outline: none; border-color: var(--fl-color-focus-ring);
  }
  .fl-hunt-value { display: inline-flex; align-items: center; gap: var(--fl-space-xs); }
  .fl-hunt-value[hidden], .fl-hunt-select[hidden] { display: none; }
  .fl-hunt-number { width: 56px; }
  .fl-hunt-rule { flex: 1; min-width: 0; }
  .fl-hunt-unit { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
  .fl-hunt-note { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
  .fl-hunt-note[hidden] { display: none; }
  .fl-hunt-note.refusal { color: var(--fl-color-warning, #d9a441); }
  /* The chip form borrows the settings row's own chip styling (the host's
     .fl-newthread-chip); all this adds is the indent its panel does NOT want,
     because in that form the panel is placed by the host, not under a label. */
  .fl-hunt-chip[hidden] { display: none; }
  .fl-hunt-chip + .fl-hunt-panel, .fl-newthread-hunt .fl-hunt-panel { padding-left: 0; }
`
