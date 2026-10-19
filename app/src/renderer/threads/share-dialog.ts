// The Share dialog, on screen — and the revoke confirmation beside it.
//
// The DOM half of `share-dialog-model.ts`: every rule (what an email is, why a
// public mail provider can't be a company domain, what will be sent, the
// request's shape) and every sentence lives there, where a test can hold it.
// This file owns the overlay, the keyboard, the fields and the promise.
//
// Same shape as `remote-binding-dialog.ts` on purpose — two questions asked by
// the same application should not look like two applications asking. Existing
// tokens only; no emoji; no paths, commands or config keys in any text
// (forbidden-pattern #12). A file NAME is shown under "What will be sent"
// because it is what leaves the machine; where it lives is not.
//
// NOTHING IS SENT UNTIL THE PERSON PRESSES THE BUTTON. Escape, the backdrop and
// Cancel all close without a request. A refusal keeps the dialog open with the
// refusal's own sentence, shown as main wrote it — and when main says the files
// changed after they were reviewed, the "What will be sent" block is redrawn
// from the fresh facts, so the next press confirms what is really there.

import { markModalOverlay } from '../modal-overlay'
import type { ShareLocalFacts } from '../../shared/ipc-contract'
import type { ShareSummary } from '../../shared/share-contract'
import { SHARE_CHECK_BUSY_LABEL, SHARE_CHECK_LABEL, SHARE_CHECK_TITLE } from './share-state-model'
import {
  REVOKE_BODY,
  REVOKE_BUSY_LABEL,
  REVOKE_CONFIRM_LABEL,
  REVOKE_TITLE,
  SHARE_BUSY_PUBLISH_LABEL,
  SHARE_BUSY_SAVE_LABEL,
  SHARE_CANCEL_LABEL,
  SHARE_DIALOG_MANAGE_BODY,
  SHARE_DIALOG_MANAGE_TITLE,
  SHARE_DIALOG_PUBLISH_BODY,
  SHARE_DIALOG_PUBLISH_TITLE,
  SHARE_DOMAIN_HINT,
  SHARE_DOMAIN_LABEL,
  SHARE_DOMAIN_PLACEHOLDER,
  SHARE_EXPIRY_LABEL,
  SHARE_NOTIFY_LABEL,
  SHARE_PEOPLE_LABEL,
  SHARE_PEOPLE_PLACEHOLDER,
  SHARE_PUBLISH_LABEL,
  SHARE_SAVE_LABEL,
  SHARE_SENT_LABEL,
  SHARE_SENT_NOTE,
  addEntries,
  expiryOptions,
  initialForm,
  removeEntry,
  sendSummary,
  type ExpiryChoice,
  type ShareDialogForm,
  type ShareDialogMode,
} from './share-dialog-model'

/** What the caller's submit answered: done, or a sentence to show and stay open. */
export type ShareDialogOutcome =
  | { ok: true }
  | { ok: false; message: string; /** Fresh facts to redraw "What will be sent" from. */ local?: ShareLocalFacts }

export interface ShareDialogOptions {
  mode: ShareDialogMode
  /** The share as main last reported it — null when never shared. */
  share: ShareSummary | null
  /** What would be sent. Required to publish; unused when managing. */
  local: ShareLocalFacts | null
  /** Sends the form. The dialog stays open, busy, until it answers. */
  submit(form: ShareDialogForm): Promise<ShareDialogOutcome>
  /**
   * "Check sharing status" — offered when publishing. Asks the share host
   * whether this page is already shared (from another computer, say). Answers
   * `close` when it found a share and the caller has taken over, or a sentence
   * to show while the dialog stays open.
   */
  checkStatus?: () => Promise<ShareCheckOutcome>
}

/** What a "Check sharing status" press answered. */
export type ShareCheckOutcome = { close: true } | { close: false; message: string }

/**
 * Open the Share dialog. Resolves true when the submit succeeded, false when
 * the person closed it. Resolves exactly once; the overlay is always removed.
 */
export function openShareDialog(options: ShareDialogOptions): Promise<boolean> {
  injectShareDialogStyles()
  return new Promise<boolean>((resolve) => {
    const publishing = options.mode === 'publish'
    let form: ShareDialogForm = initialForm(options.share)
    let local = options.local

    const overlay = document.createElement('div')
    overlay.className = 'fl-share-overlay'
    markModalOverlay(overlay)

    const dialog = document.createElement('div')
    dialog.className = 'fl-share-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'fl-share-dialog-title')
    dialog.tabIndex = -1

    const title = document.createElement('h2')
    title.className = 'fl-share-title'
    title.id = 'fl-share-dialog-title'
    title.textContent = publishing ? SHARE_DIALOG_PUBLISH_TITLE : SHARE_DIALOG_MANAGE_TITLE
    const body = document.createElement('p')
    body.className = 'fl-share-body'
    body.textContent = publishing ? SHARE_DIALOG_PUBLISH_BODY : SHARE_DIALOG_MANAGE_BODY
    dialog.append(title, body)

    // The refusal's line. Present from the start (empty) so filling it in never
    // moves the buttons out from under a finger already travelling.
    const message = document.createElement('p')
    message.className = 'fl-share-message'
    message.setAttribute('role', 'alert')
    const say = (text: string | null): void => {
      message.textContent = text ?? ''
    }

    // ── People and the company domain ─────────────────────────────────────
    const people = createChipField({
      id: 'fl-share-people',
      label: SHARE_PEOPLE_LABEL,
      placeholder: SHARE_PEOPLE_PLACEHOLDER,
      kind: 'email',
      entries: () => form.emails,
      setEntries: (emails) => {
        form = { ...form, emails }
      },
      say,
    })
    const domains = createChipField({
      id: 'fl-share-domains',
      label: SHARE_DOMAIN_LABEL,
      placeholder: SHARE_DOMAIN_PLACEHOLDER,
      kind: 'domain',
      hint: SHARE_DOMAIN_HINT,
      entries: () => form.domains,
      setEntries: (list) => {
        form = { ...form, domains: list }
      },
      say,
    })

    // ── Email them, and when the link stops working ───────────────────────
    const choices = document.createElement('div')
    choices.className = 'fl-share-row'
    const notifyLabel = document.createElement('label')
    notifyLabel.className = 'fl-share-check'
    const notify = document.createElement('input')
    notify.type = 'checkbox'
    notify.checked = form.notify
    notify.addEventListener('change', () => {
      form = { ...form, notify: notify.checked }
    })
    const notifyText = document.createElement('span')
    notifyText.textContent = SHARE_NOTIFY_LABEL
    notifyLabel.append(notify, notifyText)

    const expiryField = document.createElement('label')
    expiryField.className = 'fl-share-expiry'
    const expiryText = document.createElement('span')
    expiryText.className = 'fl-share-label'
    expiryText.textContent = SHARE_EXPIRY_LABEL
    const expiry = document.createElement('select')
    expiry.className = 'fl-share-input fl-share-select'
    const liveExpiry = options.share !== null && options.share.revokedAt === null ? options.share.expiresAt : null
    for (const option of expiryOptions(liveExpiry)) {
      const element = document.createElement('option')
      element.value = option.value
      element.textContent = option.label
      expiry.appendChild(element)
    }
    expiry.value = form.expiry
    expiry.addEventListener('change', () => {
      form = { ...form, expiry: expiry.value as ExpiryChoice }
    })
    expiryField.append(expiryText, expiry)
    choices.append(notifyLabel, expiryField)

    dialog.append(people.element, domains.element, choices)

    // ── What will be sent (publishing only — managing sends no files) ─────
    const sent = document.createElement('section')
    sent.className = 'fl-share-sent'
    const drawSent = (): void => {
      sent.replaceChildren()
      if (local === null) return
      const summary = sendSummary(local)
      const heading = document.createElement('h3')
      heading.className = 'fl-share-label'
      heading.textContent = SHARE_SENT_LABEL
      const list = document.createElement('ul')
      list.className = 'fl-share-files'
      for (const row of summary.rows) {
        const item = document.createElement('li')
        const label = document.createElement('span')
        label.className = 'fl-share-file-label'
        label.textContent = row.label
        const name = document.createElement('span')
        name.className = 'fl-share-file-name'
        name.textContent = row.name
        name.title = row.name
        const size = document.createElement('span')
        size.className = 'fl-share-file-size'
        size.textContent = row.size
        item.append(label, name, size)
        list.appendChild(item)
      }
      const note = document.createElement('p')
      note.className = 'fl-share-note'
      note.textContent = `${SHARE_SENT_NOTE} ${summary.total} in total.`
      sent.append(heading, list, note)
      if (summary.overCapMessage !== null) say(summary.overCapMessage)
    }
    if (publishing) {
      drawSent()
      dialog.appendChild(sent)
    }

    const actions = document.createElement('div')
    actions.className = 'fl-share-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-share-cancel'
    cancel.textContent = SHARE_CANCEL_LABEL
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'fl-share-confirm'
    const idleLabel = publishing ? SHARE_PUBLISH_LABEL : SHARE_SAVE_LABEL
    confirm.textContent = idleLabel
    // Asking the share host is a person's choice, never the dialog opening.
    const check =
      publishing && options.checkStatus !== undefined ? document.createElement('button') : null
    if (check !== null) {
      check.type = 'button'
      check.className = 'fl-share-check-status'
      check.textContent = SHARE_CHECK_LABEL
      check.title = SHARE_CHECK_TITLE
      actions.append(check)
    }
    actions.append(cancel, confirm)
    dialog.append(message, actions)

    let settled = false
    let busy = false
    const close = (value: boolean): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      resolve(value)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation()
        close(false)
      }
    }

    const submit = async (): Promise<void> => {
      if (busy) return
      // Text still in a field is what the person meant to add — take it, and
      // stop on anything refused rather than publishing without it.
      if (!people.flush() || !domains.flush()) return
      busy = true
      confirm.disabled = true
      cancel.disabled = true
      confirm.textContent = publishing ? SHARE_BUSY_PUBLISH_LABEL : SHARE_BUSY_SAVE_LABEL
      say(null)
      let outcome: ShareDialogOutcome
      try {
        outcome = await options.submit(form)
      } catch (error) {
        console.warn('flow: share dialog submit failed', { error })
        outcome = { ok: false, message: "Flow couldn't reach the share service. Try again in a moment." }
      }
      busy = false
      confirm.disabled = false
      cancel.disabled = false
      confirm.textContent = idleLabel
      if (outcome.ok) {
        close(true)
        return
      }
      if (outcome.local !== undefined) {
        local = outcome.local
        drawSent()
      }
      say(outcome.message)
    }

    const runCheck = async (): Promise<void> => {
      if (busy || check === null || options.checkStatus === undefined) return
      busy = true
      check.disabled = true
      confirm.disabled = true
      cancel.disabled = true
      check.textContent = SHARE_CHECK_BUSY_LABEL
      say(null)
      let outcome: ShareCheckOutcome
      try {
        outcome = await options.checkStatus()
      } catch (error) {
        console.warn('flow: share status check failed', { error })
        outcome = { close: false, message: "Flow couldn't reach the share service. Try again in a moment." }
      }
      busy = false
      check.disabled = false
      confirm.disabled = false
      cancel.disabled = false
      check.textContent = SHARE_CHECK_LABEL
      if (outcome.close) {
        close(false)
        return
      }
      say(outcome.message)
    }

    check?.addEventListener('click', () => void runCheck())
    confirm.addEventListener('click', () => void submit())
    cancel.addEventListener('click', () => close(false))
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay && !busy) close(false)
    })
    // Capture phase: this dialog owns the keyboard while it is open.
    document.addEventListener('keydown', onKey, true)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    people.focus()
  })
}

interface ChipFieldOptions {
  id: string
  label: string
  placeholder: string
  kind: 'email' | 'domain'
  hint?: string
  entries(): string[]
  setEntries(entries: string[]): void
  say(text: string | null): void
}

interface ChipField {
  element: HTMLElement
  /** Add what is still typed. False when something was refused (and said). */
  flush(): boolean
  focus(): void
}

/**
 * A list of checked entries drawn as chips, and the field that adds to it.
 * Enter, a comma or leaving the field adds what was typed; pasting several at
 * once adds each. Anything refused stays in the field, as typed, with the
 * reason on the dialog's message line.
 */
function createChipField(options: ChipFieldOptions): ChipField {
  const field = document.createElement('div')
  field.className = 'fl-share-field'
  const label = document.createElement('label')
  label.className = 'fl-share-label'
  label.htmlFor = options.id
  label.textContent = options.label
  const box = document.createElement('div')
  box.className = 'fl-share-chips'
  const chips = document.createElement('ul')
  chips.className = 'fl-share-chip-list'
  chips.setAttribute('aria-label', options.label)
  const input = document.createElement('input')
  input.type = options.kind === 'email' ? 'email' : 'text'
  input.id = options.id
  input.className = 'fl-share-chip-input'
  input.placeholder = options.placeholder
  input.spellcheck = false
  input.autocomplete = 'off'
  box.append(chips, input)
  box.addEventListener('mousedown', (event) => {
    if (event.target === box || event.target === chips) {
      event.preventDefault()
      input.focus()
    }
  })
  field.append(label, box)
  if (options.hint !== undefined) {
    const hint = document.createElement('p')
    hint.className = 'fl-share-note'
    hint.textContent = options.hint
    field.appendChild(hint)
  }

  const draw = (): void => {
    chips.replaceChildren()
    for (const entry of options.entries()) {
      const chip = document.createElement('li')
      chip.className = 'fl-share-chip'
      const text = document.createElement('span')
      text.textContent = entry
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'fl-share-chip-remove'
      remove.textContent = '×'
      remove.setAttribute('aria-label', `Remove ${entry}`)
      remove.addEventListener('click', () => {
        options.setEntries(removeEntry(options.entries(), entry))
        draw()
        input.focus()
      })
      chip.append(text, remove)
      chips.appendChild(chip)
    }
  }

  const flush = (): boolean => {
    if (input.value.trim() === '') return true
    const added = addEntries(options.entries(), input.value, options.kind)
    options.setEntries(added.entries)
    input.value = added.rejected.join(', ')
    draw()
    options.say(added.message)
    return added.rejected.length === 0
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      event.preventDefault()
      flush()
      return
    }
    // Backspace on an empty field takes back the last chip — the habit every
    // address field has taught people.
    if (event.key === 'Backspace' && input.value === '') {
      const current = options.entries()
      const last = current[current.length - 1]
      if (last !== undefined) {
        options.setEntries(removeEntry(current, last))
        draw()
      }
    }
  })
  input.addEventListener('paste', () => {
    // After the paste lands: several addresses pasted at once become chips.
    setTimeout(() => {
      if (/[\s,;]/.test(input.value.trim())) flush()
    }, 0)
  })
  input.addEventListener('blur', () => {
    flush()
  })
  input.addEventListener('input', () => options.say(null))

  draw()
  return { element: field, flush, focus: () => input.focus() }
}

/**
 * Ask before revoking. Resolves true only after the person confirmed AND the
 * revoke answered; a refusal stays on screen in its own words. `revoke`
 * answers null on success or the sentence to show.
 */
export function confirmRevoke(revoke: () => Promise<string | null>): Promise<boolean> {
  injectShareDialogStyles()
  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'fl-share-overlay'
    markModalOverlay(overlay)
    const dialog = document.createElement('div')
    dialog.className = 'fl-share-dialog fl-share-dialog-narrow'
    dialog.setAttribute('role', 'alertdialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'fl-share-revoke-title')
    dialog.tabIndex = -1

    const title = document.createElement('h2')
    title.className = 'fl-share-title'
    title.id = 'fl-share-revoke-title'
    title.textContent = REVOKE_TITLE
    const body = document.createElement('p')
    body.className = 'fl-share-body'
    body.textContent = REVOKE_BODY
    const message = document.createElement('p')
    message.className = 'fl-share-message'
    message.setAttribute('role', 'alert')
    const actions = document.createElement('div')
    actions.className = 'fl-share-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-share-cancel'
    cancel.textContent = SHARE_CANCEL_LABEL
    const confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.className = 'fl-share-danger'
    confirm.textContent = REVOKE_CONFIRM_LABEL
    actions.append(cancel, confirm)
    dialog.append(title, body, message, actions)

    let settled = false
    let busy = false
    const close = (value: boolean): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      resolve(value)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) {
        event.stopPropagation()
        close(false)
      }
    }
    confirm.addEventListener('click', () => {
      if (busy) return
      busy = true
      confirm.disabled = true
      cancel.disabled = true
      confirm.textContent = REVOKE_BUSY_LABEL
      message.textContent = ''
      void revoke()
        .catch((error: unknown) => {
          console.warn('flow: share revoke failed', { error })
          return "Flow couldn't reach the share service. Try again in a moment."
        })
        .then((refused) => {
          busy = false
          confirm.disabled = false
          cancel.disabled = false
          confirm.textContent = REVOKE_CONFIRM_LABEL
          if (refused === null) close(true)
          else message.textContent = refused
        })
    })
    cancel.addEventListener('click', () => close(false))
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay && !busy) close(false)
    })
    document.addEventListener('keydown', onKey, true)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)
    // Focus lands on Cancel: the destructive answer is never the default one.
    cancel.focus()
  })
}

let stylesInjected = false

function injectShareDialogStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-share-overlay {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
    }
    .fl-share-dialog {
      width: min(520px, calc(100vw - var(--fl-space-xl)));
      max-height: calc(100vh - var(--fl-space-xl));
      overflow-y: auto;
      box-sizing: border-box;
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
    .fl-share-dialog-narrow { width: min(420px, calc(100vw - var(--fl-space-xl))); }
    .fl-share-dialog:focus { outline: none; }
    .fl-share-title {
      margin: 0;
      font-size: var(--fl-text-prose-size);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-share-body {
      margin: 0 0 var(--fl-space-xs) 0;
      font-size: var(--fl-text-ui-size);
      line-height: var(--fl-line-height);
      color: var(--fl-color-text-secondary);
    }
    .fl-share-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .fl-share-label {
      margin: 0;
      font-size: var(--fl-text-caption-size);
      font-weight: var(--fl-text-ui-weight-medium);
      color: var(--fl-color-text-secondary);
    }
    .fl-share-chips {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      min-height: 30px;
      box-sizing: border-box;
      padding: 3px var(--fl-space-xs);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      background: var(--fl-color-surface-raised);
      cursor: text;
    }
    .fl-share-chips:focus-within {
      outline: 2px solid var(--fl-color-focus-ring);
      outline-offset: 1px;
    }
    .fl-share-chip-list {
      display: contents;
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .fl-share-chip {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      max-width: 100%;
      padding: 1px 2px 1px var(--fl-space-xs);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
      font-size: var(--fl-text-caption-size);
    }
    .fl-share-chip span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fl-share-chip-remove {
      border: 0;
      background: transparent;
      color: var(--fl-color-text-secondary);
      cursor: pointer;
      padding: 0 4px;
      font-size: var(--fl-text-ui-size);
      line-height: 1;
      border-radius: var(--fl-radius-sm);
    }
    .fl-share-chip-remove:hover { color: var(--fl-color-text); background: var(--fl-color-surface-raised); }
    .fl-share-chip-remove:focus-visible { outline: 2px solid var(--fl-color-focus-ring); }
    .fl-share-chip-input {
      flex: 1 1 140px;
      min-width: 120px;
      border: 0;
      outline: none;
      padding: 2px;
      background: transparent;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    .fl-share-row {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: var(--fl-space-sm);
    }
    .fl-share-check {
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
      font-size: var(--fl-text-ui-size);
      cursor: pointer;
    }
    .fl-share-check input { accent-color: var(--fl-color-accent); margin: 0; }
    .fl-share-expiry {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .fl-share-input {
      box-sizing: border-box;
      padding: var(--fl-space-xs) var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    .fl-share-input:focus-visible {
      outline: 2px solid var(--fl-color-focus-ring);
      outline-offset: 1px;
    }
    .fl-share-sent {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding-top: var(--fl-space-xs);
      border-top: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-share-sent:empty { display: none; }
    .fl-share-files {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .fl-share-files li {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: var(--fl-space-sm);
      align-items: baseline;
      font-size: var(--fl-text-caption-size);
    }
    .fl-share-file-label { color: var(--fl-color-text-secondary); }
    /* A file name is a NAME, not a word: the mono face the app gives names. */
    .fl-share-file-name {
      font-family: var(--fl-font-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fl-share-file-size {
      font-variant-numeric: tabular-nums;
      color: var(--fl-color-text-secondary);
    }
    .fl-share-note {
      margin: 0;
      font-size: var(--fl-text-caption-size);
      line-height: var(--fl-line-height-dense);
      color: var(--fl-color-text-secondary);
    }
    .fl-share-message {
      margin: 0;
      min-height: var(--fl-text-caption-size);
      font-size: var(--fl-text-caption-size);
      line-height: var(--fl-line-height-dense);
      color: var(--fl-color-warning);
    }
    .fl-share-actions {
      display: flex;
      justify-content: flex-end;
      gap: var(--fl-space-sm);
      margin-top: var(--fl-space-xs);
    }
    .fl-share-actions button {
      padding: var(--fl-space-xs) var(--fl-space-md);
      border-radius: var(--fl-radius-md);
      border: var(--fl-border-width) solid var(--fl-color-border);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      cursor: pointer;
    }
    .fl-share-actions button:disabled { opacity: 0.6; cursor: default; }
    .fl-share-cancel {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    /* A quieter question than the two answers beside it, kept to the left. */
    .fl-share-actions .fl-share-check-status {
      margin-right: auto;
      border-color: transparent;
      background: transparent;
      color: var(--fl-color-text-secondary);
      padding-left: 0;
    }
    .fl-share-actions .fl-share-check-status:hover:not(:disabled) { color: var(--fl-color-text); }
    .fl-share-confirm, .fl-share-danger {
      border-color: transparent;
      /* Literal white, as every other filled button in this app uses. */
      color: #fff;
    }
    .fl-share-confirm { background: var(--fl-color-accent); }
    .fl-share-danger { background: var(--fl-color-danger); }
    .fl-share-actions button:focus-visible {
      outline: 2px solid var(--fl-color-focus-ring);
      outline-offset: 1px;
    }
  `
  document.head.appendChild(style)
}
