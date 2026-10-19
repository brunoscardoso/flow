/**
 * The "Projects for this task" picker — drawn in the remote ticket dialog and
 * in a card's "Change". Every decision is in task-projects-model.ts; this file
 * only draws it and reports what was ticked.
 */

import { ensureAccentProperty } from '../project-accent'
import {
  PROJECTS_HINT,
  PROJECTS_SECTION_LABEL,
  pickableOnly,
  pickerCount,
  pickerRows,
  togglePicked,
  type PickerProject,
} from './task-projects-model'

export interface TaskProjectsPicker {
  element: HTMLElement
  /** The ticked roots, in the order ticked (the first starts the chat). */
  picked(): string[]
}

export function createTaskProjectsPicker(options: {
  projects: readonly PickerProject[]
  /** What is ticked to begin with — nothing, for a ticket nobody has chosen for. */
  picked?: readonly string[]
  inWorkspace: boolean
  onChange?: (picked: string[]) => void
}): TaskProjectsPicker {
  let picked = pickableOnly(options.projects, options.picked ?? [])

  const element = document.createElement('div')
  element.className = 'fl-task-projects'
  element.setAttribute('role', 'group')
  element.setAttribute('aria-label', PROJECTS_SECTION_LABEL)

  const head = document.createElement('div')
  head.className = 'fl-task-projects-head'
  const label = document.createElement('div')
  label.className = 'fl-task-projects-label'
  label.textContent = PROJECTS_SECTION_LABEL
  const count = document.createElement('span')
  count.className = 'fl-task-projects-count'
  head.append(label, count)

  const hint = document.createElement('div')
  hint.className = 'fl-task-projects-hint'
  hint.textContent = PROJECTS_HINT

  const list = document.createElement('div')
  list.className = 'fl-task-projects-list'
  element.append(head, hint, list)

  // THE ROWS ARE BUILT ONCE AND UPDATED IN PLACE. Rebuilding the list on every
  // tick replaced the checkbox the person had just pressed, and keyboard focus
  // fell to the body — Space on a row, then Tab, started over from the top of
  // the dialog. `pickerRows` keeps the projects' order, so row i is always
  // project i and only its state changes.
  const rows = pickerRows(options.projects, picked).map((row) => {
    const item = document.createElement('label')
    item.className = 'fl-task-project'
    const box = document.createElement('input')
    box.type = 'checkbox'
    if (row.root !== null) box.value = row.root
    const root = row.root
    box.addEventListener('change', () => {
      if (root === null) return
      picked = togglePicked(picked, root)
      update()
      options.onChange?.([...picked])
    })
    const bar = document.createElement('span')
    bar.className = 'fl-task-project-bar'
    // The project's own colour — the one its tabs, file tree and map use.
    if (row.root !== null) bar.style.background = ensureAccentProperty(row.root)
    const name = document.createElement('span')
    name.className = 'fl-task-project-name'
    name.textContent = row.name
    const note = document.createElement('span')
    note.className = 'fl-task-project-note'
    item.append(box, bar, name, note)
    list.appendChild(item)
    return { item, box, note }
  })

  const update = (): void => {
    count.textContent = pickerCount(options.projects, picked, options.inWorkspace)
    pickerRows(options.projects, picked).forEach((row, index) => {
      const drawn = rows[index]
      if (drawn === undefined) return
      drawn.item.classList.toggle('is-disabled', row.disabled)
      drawn.item.classList.toggle('is-checked', row.checked)
      drawn.box.checked = row.checked
      drawn.box.disabled = row.disabled
      drawn.note.textContent = row.note
    })
  }
  update()

  return { element, picked: () => [...picked] }
}

/** A chip naming one project, in its colour. */
export function projectChip(root: string, name: string): HTMLElement {
  const chip = document.createElement('span')
  chip.className = 'fl-task-project-chip'
  chip.title = name
  const dot = document.createElement('i')
  dot.style.background = ensureAccentProperty(root)
  const text = document.createElement('span')
  text.textContent = name
  chip.append(dot, text)
  return chip
}

/**
 * The picker's styles. NO BACKTICKS ANYWHERE IN HERE, comments included — this
 * is a template literal and one ends it.
 */
export const TASK_PROJECTS_STYLES = `
  .fl-task-projects {
    display: flex; flex-direction: column; gap: var(--fl-space-sm);
    border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-md);
    padding: var(--fl-space-md);
  }
  .fl-task-projects-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--fl-space-sm); flex-wrap: wrap; }
  .fl-task-projects-label {
    font-size: var(--fl-text-caption-size); font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--fl-color-text-secondary);
  }
  .fl-task-projects-count { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }
  .fl-task-projects-hint {
    font-size: var(--fl-text-caption-size); color: var(--fl-color-text);
    background: var(--fl-color-accent-muted); border-radius: var(--fl-radius-sm); padding: 6px 8px;
  }
  .fl-task-projects-list { display: flex; flex-direction: column; gap: 2px; }
  .fl-task-project {
    display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: var(--fl-radius-sm);
    cursor: pointer; min-width: 0;
  }
  .fl-task-project:hover:not(.is-disabled), .fl-task-project.is-checked { background: var(--fl-color-surface-raised); }
  .fl-task-project.is-disabled { cursor: default; opacity: 0.6; }
  .fl-task-project input { margin: 0; width: 15px; height: 15px; accent-color: var(--fl-color-accent); flex: none; }
  .fl-task-project-bar { width: 3px; height: 18px; border-radius: 2px; flex: none; background: var(--fl-color-border); }
  .fl-task-project-name { font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fl-task-project-note {
    margin-left: auto; font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
    text-align: right; white-space: nowrap;
  }
  .fl-task-projects-need {
    flex-basis: 100%; text-align: right; font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
  }
  .fl-task-projects-need:empty { display: none; }
  .fl-board-new.fl-board-primary {
    background: var(--fl-color-accent); border-color: var(--fl-color-accent); color: #fff;
  }
  .fl-board-new.fl-board-primary:hover:not(:disabled) { border-color: var(--fl-color-accent); filter: brightness(1.08); }
  .fl-board-card-projects { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; min-width: 0; }
  .fl-task-project-chip {
    display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0;
    font-size: var(--fl-text-caption-size); line-height: 18px; padding: 0 7px;
    border: var(--fl-border-width) solid var(--fl-color-border); border-radius: 999px;
    background: var(--fl-color-surface); color: var(--fl-color-text);
  }
  .fl-task-project-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fl-task-project-chip i { width: 7px; height: 7px; border-radius: 50%; flex: none; display: inline-block; }
  button.fl-task-project-change {
    display: inline-flex; align-items: center; font-family: var(--fl-font-ui);
    font-size: var(--fl-text-caption-size); line-height: 18px; padding: 0 7px; cursor: pointer;
    border: var(--fl-border-width) dashed var(--fl-color-border); border-radius: 999px;
    background: transparent; color: var(--fl-color-accent);
  }
  button.fl-task-project-change:hover { border-color: var(--fl-color-accent); }
  .fl-task-projects-dialog { width: min(520px, 92vw); }
`
