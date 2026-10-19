// The where-should-this-publish question, on screen.
//
// The DOM half of `remote-binding-ask.ts` — every word it renders comes from
// that module, which is where the copy is decided and tested. This file owns
// the overlay, the keyboard, the two fields and the promise, and nothing else.
// Same shape as `worktree-start-dialog.ts` on purpose: two questions asked by
// the same application should not look like two different applications asking.
//
// DISMISSING IS AN ANSWER, and it is the one that changes nothing: Escape, a
// click on the backdrop, or Cancel all resolve to null, and a null answer means
// the caller sends nothing at all (forbidden-pattern #15). Nothing was pushed
// when this opened, so nothing needs undoing when it closes.
//
// AND THE HALF THAT IS NOT COPY: what a person TYPES is validated here and
// refused in place (allowed-pattern #22). A blank destination or a blank name
// keeps the dialog open with a line saying so — it is never completed from the
// project's default, because a feature that exists to stop a silent guess must
// not put the guess one layer below where anybody would look for it.
//
// Existing tokens only — no new design language.

import { markModalOverlay } from '../modal-overlay'
import type { RemoteBindingQuestion } from './remote-binding-ask'

/** What a confirmed answer is: both halves, stated, with nothing inferred. */
export interface RemoteBindingAnswer {
  remote: string
  remoteBranch: string
}

/**
 * Ask where this branch publishes and resolve with the answer, or null when the
 * person answered nothing. Resolves exactly once; the overlay is always removed.
 */
export function askRemoteBinding(
  question: RemoteBindingQuestion,
): Promise<RemoteBindingAnswer | null> {
  injectBindingStyles()
  return new Promise<RemoteBindingAnswer | null>((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'fl-remote-binding-overlay'
    markModalOverlay(overlay)

    const dialog = document.createElement('div')
    dialog.className = 'fl-remote-binding'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.tabIndex = -1

    const title = document.createElement('h2')
    title.className = 'fl-remote-binding-title'
    title.textContent = question.title
    const body = document.createElement('p')
    body.className = 'fl-remote-binding-body'
    body.textContent = question.body
    dialog.append(title, body)

    // ── Where it goes ───────────────────────────────────────────────────────
    // A picker when this repository has destinations to choose between, a field
    // when it has none. The empty case is still an answerable question; the one
    // thing it must not become is a control that cannot be answered.
    const remoteField = document.createElement('div')
    remoteField.className = 'fl-remote-binding-field'
    const remoteLabel = document.createElement('label')
    remoteLabel.className = 'fl-remote-binding-label'
    remoteLabel.htmlFor = 'fl-remote-binding-remote'
    remoteLabel.textContent = question.remoteLabel

    const remoteInput: HTMLSelectElement | HTMLInputElement = question.remoteIsTyped
      ? createTextInput('fl-remote-binding-remote', question.remotePreset, question.remotePlaceholder)
      : createRemoteSelect(question)
    remoteField.append(remoteLabel, remoteInput)

    // ── What it is called when it gets there ────────────────────────────────
    const branchField = document.createElement('div')
    branchField.className = 'fl-remote-binding-field'
    const branchLabel = document.createElement('label')
    branchLabel.className = 'fl-remote-binding-label'
    branchLabel.htmlFor = 'fl-remote-binding-branch'
    branchLabel.textContent = question.branchLabel
    // The proposal arrives EXACTLY as it was made — this field shows what was
    // suggested, so anything we cleaned on the way in would become the reader's
    // answer the moment they accepted without looking.
    const branchInput = createTextInput('fl-remote-binding-branch', question.branchPreset, '')
    branchInput.classList.add('fl-remote-binding-branch')
    const provenance = document.createElement('p')
    provenance.className = 'fl-remote-binding-provenance'
    provenance.textContent = question.provenance
    branchField.append(branchLabel, branchInput, provenance)

    // The refusal's own line. It exists from the start (empty) so that filling
    // it in never moves the buttons out from under a finger already travelling.
    const message = document.createElement('p')
    message.className = 'fl-remote-binding-message'
    message.setAttribute('role', 'alert')
    message.textContent = ''

    const actions = document.createElement('div')
    actions.className = 'fl-remote-binding-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-remote-binding-cancel'
    cancel.textContent = question.cancelLabel
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'fl-remote-binding-confirm'
    confirm.textContent = question.confirmLabel
    actions.append(cancel, confirm)

    dialog.append(remoteField, branchField, message, actions)

    let settled = false
    const answer = (value: RemoteBindingAnswer | null): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      resolve(value)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        answer(null)
      }
    }

    const submit = (): void => {
      // Trimming the edges is not rewriting the name — surrounding whitespace
      // is not part of one, and what stays is what the person actually wrote.
      const remote = remoteInput.value.trim()
      const remoteBranch = branchInput.value.trim()
      if (remote === '') {
        message.textContent = question.blankRemoteMessage
        remoteInput.focus()
        return
      }
      if (remoteBranch === '') {
        message.textContent = question.blankBranchMessage
        branchInput.focus()
        return
      }
      answer({ remote, remoteBranch })
    }

    confirm.addEventListener('click', submit)
    cancel.addEventListener('click', () => answer(null))
    // Enter from either field is the same press as the button — a two-field
    // question answered from the keyboard should not need a trip to the mouse.
    // Typed as elements, not as the union of a select and an input: the two
    // listeners below want only the keyboard, and a union of element types
    // widens `addEventListener` back to a bare `Event`.
    const fields: HTMLElement[] = [remoteInput, branchInput]
    for (const field of fields) {
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          submit()
        }
      })
      // The refusal is about a field that was blank a moment ago; the moment it
      // stops being blank the line has nothing left to say.
      field.addEventListener('input', () => {
        message.textContent = ''
      })
      field.addEventListener('change', () => {
        message.textContent = ''
      })
    }

    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) answer(null)
    })
    // Capture phase: this dialog owns the keyboard while it is open, so its
    // Escape must not be eaten by a panel shortcut on the way down.
    document.addEventListener('keydown', onKey, true)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    // Open on the blank, when there is one — the reader lands on the part of
    // the question that still has no answer rather than on the part that does.
    if (remoteInput.value === '') remoteInput.focus()
    else {
      branchInput.focus()
      // Caret at the end, not a selection: the proposal is usually accepted or
      // amended, and a fully-selected name is one keystroke from being lost.
      const end = branchInput.value.length
      branchInput.setSelectionRange(end, end)
    }
  })
}

function createTextInput(id: string, value: string, placeholder: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.id = id
  input.className = 'fl-remote-binding-input'
  input.value = value
  input.placeholder = placeholder
  input.spellcheck = false
  input.autocomplete = 'off'
  return input
}

function createRemoteSelect(question: RemoteBindingQuestion): HTMLSelectElement {
  const select = document.createElement('select')
  select.id = 'fl-remote-binding-remote'
  select.className = 'fl-remote-binding-input'
  // A BLANK ROW WHEN NOTHING WAS PRE-SELECTED, and it is not decoration: a
  // select with no empty option silently answers itself with its first entry,
  // which would be this app choosing a destination nobody named.
  if (question.remotePreset === '') {
    const blank = document.createElement('option')
    blank.value = ''
    blank.textContent = question.remotePlaceholder
    select.appendChild(blank)
  }
  for (const remote of question.remoteChoices) {
    const option = document.createElement('option')
    option.value = remote
    option.textContent = remote
    select.appendChild(option)
  }
  select.value = question.remotePreset
  return select
}

let stylesInjected = false

function injectBindingStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-remote-binding-overlay {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
    }
    .fl-remote-binding {
      width: min(480px, calc(100vw - var(--fl-space-xl)));
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
      padding: var(--fl-space-lg);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-lg);
      background: var(--fl-color-surface);
      box-shadow: var(--fl-shadow-md);
      font-family: var(--fl-font-ui);
      color: var(--fl-color-text);
    }
    .fl-remote-binding:focus { outline: none; }
    .fl-remote-binding-title {
      margin: 0;
      font-size: var(--fl-text-prose-size);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-remote-binding-body {
      margin: 0 0 var(--fl-space-xs) 0;
      font-size: var(--fl-text-ui-size);
      line-height: var(--fl-line-height);
      color: var(--fl-color-text-secondary);
    }
    .fl-remote-binding-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .fl-remote-binding-label {
      font-size: var(--fl-text-caption-size);
      font-weight: var(--fl-text-ui-weight-medium);
      color: var(--fl-color-text-secondary);
    }
    .fl-remote-binding-input {
      width: 100%;
      box-sizing: border-box;
      padding: var(--fl-space-xs) var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    /* The one string here that is a NAME rather than a word — it gets the
       mono face the rest of the app gives branch names. */
    input.fl-remote-binding-branch {
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-caption-size);
    }
    .fl-remote-binding-input:focus-visible {
      outline: 2px solid var(--fl-color-focus-ring);
      outline-offset: 1px;
    }
    .fl-remote-binding-provenance {
      margin: 0;
      font-size: var(--fl-text-caption-size);
      line-height: var(--fl-line-height-dense);
      color: var(--fl-color-text-secondary);
    }
    .fl-remote-binding-message {
      margin: 0;
      min-height: var(--fl-text-caption-size);
      font-size: var(--fl-text-caption-size);
      line-height: var(--fl-line-height-dense);
      color: var(--fl-color-warning);
    }
    .fl-remote-binding-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--fl-space-sm);
      margin-top: var(--fl-space-xs);
    }
    .fl-remote-binding-actions button {
      padding: var(--fl-space-xs) var(--fl-space-md);
      border-radius: var(--fl-radius-md);
      border: var(--fl-border-width) solid var(--fl-color-border);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      cursor: pointer;
    }
    .fl-remote-binding-cancel {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    .fl-remote-binding-confirm {
      background: var(--fl-color-accent);
      border-color: transparent;
      /* Literal white, as every other accent-filled button in this app uses —
         there is no contrast token to reach for, and inventing one here would
         make this dialog the only place that has one. */
      color: #fff;
    }
    .fl-remote-binding-actions button:focus-visible {
      outline: 2px solid var(--fl-color-focus-ring);
      outline-offset: 1px;
    }
  `
  document.head.appendChild(style)
}
