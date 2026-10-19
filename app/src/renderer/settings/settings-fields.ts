// settings-fields — the ONE way a settings field is drawn.
//
// A field on these panels is never just a control: it is a label, a line of
// help, sometimes a note about what a switch does NOT do, a message about a
// value that was typed, and — for anything resolved through layers — a chip
// saying where the value came from and a way to take it over or hand it back.
// That is six decisions per row, and the project panel and the global defaults
// panel have to make all six the same way, or the same setting reads as two
// different settings depending on which surface you opened.
//
// VALUES IN, CHANGES OUT. Nothing here reads a project, a store or an IPC
// channel; a caller passes the value and the provenance it already has and gets
// back a row plus an `update` that patches it in place. That is what lets the
// global panel — which has no project at all — render the identical row.
//
// PATCHED, NEVER REBUILT (#1032). `update` writes onto the nodes it already
// made, because a rebuild between a field's change event (fired on blur) and
// the mouseup of the click that caused it eats the next click and any text
// still being typed.
//
// Typed against MINIMAL STRUCTURAL INTERFACES rather than lib.dom — the
// established idiom for renderer modules here (see project-accent.ts's
// MinimalDocument and input-carry.ts's CarryField): the app's jest config omits
// the DOM lib, so a module that names `HTMLElement` cannot be unit-tested at
// all. The real `document` is handed in with one cast at the call site.

import {
  chipActionLabel,
  fieldConfigString,
  inheritActionLabel,
  isInheritedValue,
  joinSelectValue,
  provenanceChipText,
  resolveNumberInput,
  splitSelectValue,
  type FieldDef,
  type FieldValidation,
  type FieldValue,
  type SettingsLayer,
} from './flow-settings-model'
import type { WorktreeSettingSource } from '../../shared/ipc-contract'

/** The sliver of an element these builders touch. */
export interface FieldNode {
  className: string
  textContent: string | null
  hidden: boolean
  disabled: boolean
  type: string
  value: string
  placeholder: string
  min: string
  max: string
  dataset: Record<string, string | undefined>
  appendChild(child: FieldNode): void
  setAttribute(name: string, value: string): void
  addEventListener(type: string, listener: () => void): void
}

/** The sliver of a document these builders need. */
export interface FieldDocument {
  createElement(tag: string): FieldNode
}

/** Everything about a row that can change without the row being rebuilt. */
export interface FieldRowState {
  /** The value in effect, in the units the control shows. */
  value: FieldValue
  /** Disabled by a dependency between values (never by provenance — see below). */
  disabled?: boolean
  /**
   * Which layer supplied the value. Absent for a field that has only one layer.
   *
   * An inherited field's control is READ-ONLY on purpose: there is no project
   * value to edit yet, and letting someone type into one would leave them
   * unsure whether they had just created one. Taking it over is a deliberate
   * press, which is also what keeps its opposite — handing it back, which
   * DELETES the project's key — from ever happening by accident
   * (forbidden-pattern #15).
   */
  source?: WorktreeSettingSource
  /**
   * Which layer this row's panel writes. Defaults to the project's.
   *
   * The same source means different things to the two panels — a value marked
   * `global` is inherited by a project and OWNED by the defaults panel — so the
   * chip, the switch label and whether the control is editable are all read
   * through this rather than from the source alone.
   */
  layer?: SettingsLayer
  /** What the last typed value was: fine, worth saying, or not written. */
  validation?: FieldValidation | null
  /** A sentence about what the current state does, e.g. an off switch. */
  note?: string | null
}

/** What a row does when a person changes something. */
export interface FieldRowHandlers {
  onChange(value: FieldValue): void
  /**
   * The inherit switch: `true` = take this value over as the project's own,
   * `false` = hand it back and inherit again. Only ever called from a press.
   */
  onInherit?(useProjectValue: boolean): void
  /**
   * The small action beside the provenance chip, when the chip leads somewhere.
   *
   * Today that is exactly one case: a project row reading a default the same
   * person set, whose door is the panel that holds it. The row never decides
   * WHERE it leads — it renders a label and calls back.
   */
  onChipAction?(): void
}

/** A rendered row, plus the patch that keeps it current. */
export interface FieldRow {
  row: FieldNode
  control: FieldNode
  /** The name a composite choice carries (the branch a start names), if any. */
  companion: FieldNode | null
  /**
   * Reflect a new state onto the nodes already on screen.
   *
   * `keepControlValue` is how the caller says "the user is typing in this one" —
   * writing the stored value over a half-typed word is the same bug as a
   * rebuild, only quieter.
   */
  update(state: FieldRowState, options?: { keepControlValue?: boolean }): void
}

/** Whether a value comes from a layer below the one this panel writes. */
function isInherited(state: FieldRowState): boolean {
  return state.source !== undefined && isInheritedValue(state.source, state.layer)
}

/** The message text and its severity class, or null when there is nothing to say. */
function messageOf(validation: FieldValidation | null | undefined): {
  text: string
  className: string
} | null {
  if (validation === null || validation === undefined) return null
  if ('refusal' in validation) {
    return { text: validation.refusal, className: 'fl-fs-message refusal' }
  }
  if ('warning' in validation) {
    return { text: validation.warning, className: 'fl-fs-message warning' }
  }
  return null
}

/** The value a control currently shows, as the field's typed value. */
function controlValue(field: FieldDef, raw: string, current: FieldValue): FieldValue {
  if (field.type === 'number') {
    return resolveNumberInput(field, raw, typeof current === 'number' ? current : undefined)
  }
  return raw.trim()
}

/**
 * Build one field row.
 *
 * The row is complete on return — including the parts that are currently empty
 * (chip, note, message), which are created hidden rather than added later, so
 * `update` never has to touch the tree's SHAPE and a row that gains a warning
 * cannot shuffle the rows below it.
 */
export function renderFieldRow(
  doc: FieldDocument,
  field: FieldDef,
  state: FieldRowState,
  handlers: FieldRowHandlers,
): FieldRow {
  const row = doc.createElement('div')
  const label = doc.createElement('div')
  label.className = 'fl-fs-label'

  const nameLine = doc.createElement('div')
  nameLine.className = 'fl-fs-name-line'
  const name = doc.createElement('div')
  name.className = 'fl-fs-name'
  name.textContent = field.label
  nameLine.appendChild(name)

  const chip = doc.createElement('span')
  chip.className = 'fl-fs-chip'
  nameLine.appendChild(chip)

  // The chip's door, built hidden like every other optional part of the row —
  // the shape of the tree never changes, only what is shown (see #1032 above).
  let chipAction: FieldNode | null = null
  if (handlers.onChipAction !== undefined) {
    const onChipAction = handlers.onChipAction
    const action = doc.createElement('button')
    action.type = 'button'
    action.className = 'fl-fs-chip-action'
    action.addEventListener('click', () => onChipAction())
    nameLine.appendChild(action)
    chipAction = action
  }
  label.appendChild(nameLine)

  if (field.help !== undefined) {
    const help = doc.createElement('div')
    help.className = 'fl-fs-help'
    help.textContent = field.help
    label.appendChild(help)
  }

  const note = doc.createElement('div')
  note.className = 'fl-fs-note'
  label.appendChild(note)

  const message = doc.createElement('div')
  message.className = 'fl-fs-message'
  message.setAttribute('role', 'status')
  label.appendChild(message)

  row.appendChild(label)

  const controls = doc.createElement('div')
  controls.className = 'fl-fs-controls'
  const built = buildControl(doc, field, state, handlers)
  controls.appendChild(built.control)
  if (built.companion !== null) controls.appendChild(built.companion)

  let inheritButton: FieldNode | null = null
  if (state.source !== undefined && handlers.onInherit !== undefined) {
    const onInherit = handlers.onInherit
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = 'fl-fs-inherit'
    button.addEventListener('click', () => {
      // The press means "take this over" while the value is inherited, and
      // "hand it back" once it is owned — which layer decides that is the
      // panel's business, not this button's.
      onInherit(current.source !== undefined && isInheritedValue(current.source, current.layer))
    })
    controls.appendChild(button)
    inheritButton = button
  }
  row.appendChild(controls)

  // The state the row is currently showing — read by the inherit press (which
  // has to know which direction it is going) and by the patch.
  let current: FieldRowState = state

  const update = (next: FieldRowState, options?: { keepControlValue?: boolean }): void => {
    current = next
    const inherited = isInherited(next)
    const disabled = next.disabled === true || inherited
    row.className = `fl-fs-row${next.disabled === true ? ' disabled' : ''}${inherited ? ' inherited' : ''}`

    built.control.disabled = disabled
    if (built.companion !== null) built.companion.disabled = disabled

    // `keepControlValue` protects an IN-PROGRESS edit from a patch that lands
    // mid-gesture — but only text/number fields have one: their change fires on
    // BLUR, so a patch between keystrokes must not overwrite the half-typed
    // word (#1032). A toggle or select commits on the click/change itself and
    // carries no pending value, so its visual must ALWAYS track the model.
    // Honouring keepControlValue for a toggle left it showing the OLD state
    // after its own click — the click became `document.activeElement`, the
    // patch skipped `apply`, and the switch stayed off though `pr: true` was
    // already written (the "can't check Auto-create PR" bug on the Settings
    // page's Git & PR rows).
    const editableInProgress = field.type === 'text' || field.type === 'number'
    if (!(options?.keepControlValue === true && editableInProgress)) built.apply(next.value)

    const chipText = next.source === undefined ? null : provenanceChipText(next.source, next.layer)
    chip.textContent = chipText ?? ''
    chip.hidden = chipText === null

    if (inheritButton !== null && next.source !== undefined) {
      inheritButton.textContent = inheritActionLabel(next.source, next.layer)
    }

    if (chipAction !== null) {
      const actionText = next.source === undefined ? null : chipActionLabel(next.source, next.layer)
      chipAction.textContent = actionText ?? ''
      chipAction.hidden = actionText === null
    }

    note.textContent = next.note ?? ''
    note.hidden = next.note === null || next.note === undefined || next.note === ''

    const shown = messageOf(next.validation)
    message.textContent = shown?.text ?? ''
    message.className = shown?.className ?? 'fl-fs-message'
    message.hidden = shown === null
  }

  update(state)
  return { row, control: built.control, companion: built.companion, update }
}

/** One control, plus how to write a value onto it. */
interface BuiltControl {
  control: FieldNode
  companion: FieldNode | null
  apply(value: FieldValue): void
}

function buildControl(
  doc: FieldDocument,
  field: FieldDef,
  state: FieldRowState,
  handlers: FieldRowHandlers,
): BuiltControl {
  if (field.type === 'toggle') return buildToggle(doc, field, state, handlers)
  if (field.type === 'select') return buildSelect(doc, field, state, handlers)
  if (field.type === 'number') return buildNumber(doc, field, state, handlers)
  return buildText(doc, field, handlers)
}

function buildToggle(
  doc: FieldDocument,
  field: FieldDef,
  state: FieldRowState,
  handlers: FieldRowHandlers,
): BuiltControl {
  const button = doc.createElement('button')
  button.type = 'button'
  button.setAttribute('role', 'switch')
  button.dataset.fieldKey = field.key
  const knob = doc.createElement('span')
  knob.className = 'fl-fs-knob'
  button.appendChild(knob)
  let on = state.value === true
  button.addEventListener('click', () => handlers.onChange(!on))
  return {
    control: button,
    companion: null,
    apply: (value) => {
      on = value === true
      button.className = `fl-fs-toggle${on ? ' on' : ''}`
      button.setAttribute('aria-checked', on ? 'true' : 'false')
    },
  }
}

function buildNumber(
  doc: FieldDocument,
  field: FieldDef,
  state: FieldRowState,
  handlers: FieldRowHandlers,
): BuiltControl {
  const input = doc.createElement('input')
  input.type = 'number'
  input.className = 'fl-settings-input fl-fs-number'
  input.dataset.fieldKey = field.key
  if (field.min !== undefined) input.min = String(field.min)
  if (field.max !== undefined) input.max = String(field.max)
  if (field.default !== undefined) input.placeholder = String(field.default)
  let shown: FieldValue = state.value
  input.addEventListener('change', () => {
    // An empty or out-of-range entry reverts and clamps (#369), and the field is
    // written back immediately so it can never sit there blank.
    const resolved = controlValue(field, input.value, shown)
    input.value = String(resolved)
    handlers.onChange(resolved)
  })
  return {
    control: input,
    companion: null,
    apply: (value) => {
      shown = value
      input.value = value === undefined || value === null ? '' : String(value)
    },
  }
}

function buildText(doc: FieldDocument, field: FieldDef, handlers: FieldRowHandlers): BuiltControl {
  const input = doc.createElement('input')
  input.type = 'text'
  input.className = 'fl-settings-input fl-fs-text'
  input.dataset.fieldKey = field.key
  // What a blank field falls back to, shown where the blank is (never written).
  if (field.builtin !== undefined) input.placeholder = field.builtin
  input.addEventListener('change', () => handlers.onChange(input.value.trim()))
  return {
    control: input,
    companion: null,
    apply: (value) => {
      input.value = value === undefined || value === null ? '' : String(value)
    },
  }
}

/**
 * A choice, and the name it may carry.
 *
 * The two write ONE value (`joinSelectValue`), because they are one setting:
 * "start from a branch I name" is not a decision plus a separate key, and
 * storing it as two would let a file hold a named start with no name.
 */
function buildSelect(
  doc: FieldDocument,
  field: FieldDef,
  state: FieldRowState,
  handlers: FieldRowHandlers,
): BuiltControl {
  const select = doc.createElement('select')
  select.className = 'fl-settings-select fl-fs-select'
  select.dataset.fieldKey = field.key
  for (const option of field.options ?? []) {
    const node = doc.createElement('option')
    node.value = option.value
    node.textContent = option.label
    select.appendChild(node)
  }

  const companion = doc.createElement('input')
  companion.type = 'text'
  companion.className = 'fl-settings-input fl-fs-companion'
  companion.dataset.fieldKey = `${field.key}:companion`

  let split = splitSelectValue(field, String(state.value ?? ''))
  const companionOf = (option: string): { placeholder: string } | undefined =>
    (field.options ?? []).find((candidate) => candidate.value === option)?.companion

  select.addEventListener('change', () => {
    split = { option: select.value, companion: split.companion }
    handlers.onChange(joinSelectValue(field, split.option, split.companion))
  })
  companion.addEventListener('change', () => {
    split = { option: split.option, companion: companion.value.trim() }
    handlers.onChange(joinSelectValue(field, split.option, split.companion))
  })

  return {
    control: select,
    companion,
    apply: (value) => {
      split = splitSelectValue(field, String(value ?? ''))
      select.value = split.option
      const carries = companionOf(split.option)
      companion.hidden = carries === undefined
      companion.placeholder = carries?.placeholder ?? ''
      companion.value = split.companion
    },
  }
}

/**
 * The resolver's warnings, verbatim, above the fields they are about.
 *
 * VERBATIM IS THE CONTRACT: these are finished sentences written where the
 * value was read, in a person's words. Re-wording them here would put the same
 * sentence in two places and let them drift; summarising them would drop the
 * only explanation of why a value on screen is not the value being used.
 */
export function renderWarnings(doc: FieldDocument, warnings: readonly string[]): FieldNode | null {
  if (warnings.length === 0) return null
  const box = doc.createElement('div')
  box.className = 'fl-fs-warnings'
  box.setAttribute('role', 'status')
  for (const warning of warnings) {
    const line = doc.createElement('div')
    line.className = 'fl-fs-warning'
    line.textContent = warning
    box.appendChild(line)
  }
  return box
}

/**
 * The string a field's value writes, re-exported so a caller that has to write
 * a value it did not change (taking an inherited one over) has one import.
 */
export { fieldConfigString }

/**
 * The CSS these rows are drawn with — one copy, beside the DOM that needs it.
 *
 * It lived in the project panel's own style injector, which was fine while that
 * panel was the only surface drawing a row. It is not any more: a second panel
 * rendering the same nodes against styles the first one happens to have
 * injected is an app whose defaults screen looks right only because of the
 * order two unrelated `init` calls ran in. A STRING, not an injector, so this
 * module stays DOM-free and unit-testable; each panel injects it once.
 */
export const FIELD_ROW_STYLES = `

    .fl-fs-row {
      display: flex; align-items: center; justify-content: space-between;
      gap: var(--fl-space-md); padding: var(--fl-space-sm) 0;
      border-top: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-fs-row:first-of-type { border-top: none; }
    .fl-fs-row.disabled { opacity: 0.45; }
    .fl-fs-label { min-width: 0; }
    .fl-fs-name { color: var(--fl-color-text); font-size: var(--fl-text-ui-size); }
    .fl-fs-help { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); margin-top: 1px; }
    .fl-fs-number { flex: none; width: 64px; text-align: center; }
    .fl-settings-input.fl-fs-row-text, .fl-fs-row input[type="text"] { flex: none; width: 180px; }
    /* Toggle switch */
    .fl-fs-toggle {
      flex: none; width: 34px; height: 18px; border-radius: 9px; position: relative;
      border: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface-raised); cursor: pointer; padding: 0;
      transition: background var(--fl-transition-fast), border-color var(--fl-transition-fast);
    }
    .fl-fs-toggle .fl-fs-knob {
      position: absolute; top: 1px; left: 1px; width: 14px; height: 14px; border-radius: 50%;
      background: var(--fl-color-text-secondary); transition: transform var(--fl-transition-fast), background var(--fl-transition-fast);
    }
    .fl-fs-toggle.on { background: var(--fl-color-accent); border-color: var(--fl-color-accent); }
    .fl-fs-toggle.on .fl-fs-knob { transform: translateX(16px); background: #fff; }
    .fl-fs-toggle:disabled { cursor: default; }
    .fl-fs-toggle:not(:disabled):hover { border-color: var(--fl-color-focus-ring); }
    /* ── Conversation files: provenance, composition, validation ─────────────────── */
    .fl-fs-name-line { display: flex; align-items: center; gap: var(--fl-space-xs); flex-wrap: wrap; }
    .fl-fs-chip {
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: 999px; padding: 0 6px; line-height: 1.6;
    }
    .fl-fs-chip[hidden] { display: none; }
    /* An inherited row is quieter, but NOT dimmed like a disabled one: the
       value is real and in force — nobody here has simply taken it over yet. */
    .fl-fs-row.inherited .fl-fs-name { color: var(--fl-color-text-secondary); }
    .fl-fs-controls { display: flex; align-items: center; gap: var(--fl-space-xs); flex: none; }
    .fl-fs-inherit {
      flex: none; background: none; cursor: pointer; padding: 2px 6px;
      color: var(--fl-color-accent); font-size: var(--fl-text-caption-size);
      border: var(--fl-border-width) solid transparent; border-radius: var(--fl-radius-sm, 4px);
    }
    .fl-fs-inherit:hover { border-color: var(--fl-color-border); }
    .fl-fs-select, .fl-fs-companion { flex: none; max-width: 180px; }
    .fl-fs-companion[hidden] { display: none; }
    .fl-fs-note { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); margin-top: 2px; }
    .fl-fs-note[hidden], .fl-fs-message[hidden] { display: none; }
    .fl-fs-message { font-size: var(--fl-text-caption-size); margin-top: 2px; }
    .fl-fs-message.warning { color: var(--fl-color-warning); }
    .fl-fs-message.refusal { color: var(--fl-color-error); }
    .fl-fs-warnings { padding: var(--fl-space-sm) 0; }
    .fl-fs-warning { color: var(--fl-color-warning); font-size: var(--fl-text-caption-size); }
  
    .fl-fs-chip-action {
      background: none; border: none; cursor: pointer; padding: 0 2px;
      color: var(--fl-color-accent); font-size: var(--fl-text-caption-size);
      text-decoration: underline; text-underline-offset: 2px;
    }
    .fl-fs-chip-action[hidden] { display: none; }
`
