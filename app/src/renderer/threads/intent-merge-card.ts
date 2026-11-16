/**
 * "See both" and "Undo" for a document Flow merged (FR-12).
 *
 * The notification "Flow merged two edits to …" carries two buttons. "Undo"
 * puts back this computer's versions; "See both" opens this view: per
 * document, three panes — Yours, the teammate's, Merged — and "Keep yours",
 * "Keep <Name>'s", "Keep merged". Every choice is one `workspaces.keepIntent`
 * call: main puts the text back as a new commit through the CLI and syncs.
 * The renderer never spawns anything and never names a file.
 *
 * A VIEW over `intent-merge-card-model.ts`, drawn in the collision card's
 * surface and classes (no new colours).
 */
import { markModalOverlay } from '../modal-overlay'
import type { IntentMergeKeep, WorkspaceIntentMergeSet } from '../../shared/workspaces-contract'
import type { FlowNotification } from '../../shared/ipc-contract'
import { injectStyles } from './collision-card'
import {
  CLOSE_LABEL,
  KEEP_FAILED,
  SAVING_LABEL,
  SET_GONE,
  UNDONE_TITLE,
  UNDO_FAILED_TITLE,
  WORKSPACE_INTENT_SEE_BOTH_EVENT,
  WORKSPACE_INTENT_UNDO_EVENT,
  intentCardTitle,
  intentDocumentView,
  intentEventDetail,
} from './intent-merge-card-model'

class IntentMergeCard {
  readonly #overlay: HTMLDivElement
  readonly #body: HTMLDivElement
  readonly #title: HTMLHeadingElement
  readonly #slug: string
  readonly #mergeId: string
  #set: WorkspaceIntentMergeSet | null = null
  #loaded = false
  #busy: string | null = null
  #errors = new Map<string, string>()
  #notice: string | null = null
  #closed = false
  readonly #onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      this.close()
    }
  }

  constructor(slug: string, mergeId: string) {
    injectStyles()
    this.#slug = slug
    this.#mergeId = mergeId
    this.#overlay = document.createElement('div')
    this.#overlay.className = 'fl-collision-overlay'
    markModalOverlay(this.#overlay)
    const dialog = document.createElement('div')
    dialog.className = 'fl-collision fl-intent-merge'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.tabIndex = -1
    const header = document.createElement('div')
    header.className = 'fl-collision-header'
    this.#title = document.createElement('h2')
    this.#title.className = 'fl-collision-title'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'fl-collision-btn'
    close.textContent = CLOSE_LABEL
    close.addEventListener('click', () => this.close())
    header.append(this.#title, close)
    this.#body = document.createElement('div')
    this.#body.className = 'fl-collision-body'
    dialog.append(header, this.#body)
    this.#overlay.appendChild(dialog)
    this.#overlay.addEventListener('mousedown', (event) => {
      if (event.target === this.#overlay) this.close()
    })
    document.addEventListener('keydown', this.#onKey, true)
    document.body.appendChild(this.#overlay)
    dialog.focus()
    void this.#load()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    document.removeEventListener('keydown', this.#onKey, true)
    this.#overlay.remove()
    if (current === this) current = null
  }

  async #load(): Promise<void> {
    try {
      this.#set = (await window.flow.workspaces?.intentMerges({ slug: this.#slug, mergeId: this.#mergeId })) ?? null
    } catch (error) {
      console.error('flow: could not read the merged documents', error)
      this.#set = null
    }
    this.#loaded = true
    this.#render()
  }

  async #keep(documentId: string, keep: IntentMergeKeep): Promise<void> {
    const api = window.flow.workspaces
    if (api === undefined || this.#busy !== null) return
    this.#busy = documentId
    this.#errors.delete(documentId)
    this.#render()
    try {
      const result = await api.keepIntent({ slug: this.#slug, mergeId: this.#mergeId, documentId, keep })
      if (result.ok) {
        this.#set = result.set
        this.#notice = result.detail
      } else {
        this.#errors.set(documentId, result.detail)
      }
    } catch (error) {
      console.error('flow: could not change the merged document', error)
      this.#errors.set(documentId, KEEP_FAILED)
    }
    this.#busy = null
    if (!this.#closed) this.#render()
  }

  #render(): void {
    this.#body.textContent = ''
    const set = this.#set
    this.#title.textContent = set === null ? '' : intentCardTitle(set)
    if (!this.#loaded) return
    if (set === null) {
      this.#body.appendChild(line(SET_GONE, 'fl-collision-intro'))
      return
    }
    if (this.#notice !== null) this.#body.appendChild(line(this.#notice, 'fl-collision-notice'))
    for (const document of set.documents) {
      const view = intentDocumentView(document)
      const item = window.document.createElement('div')
      item.className = 'fl-collision-item'
      item.dataset['part'] = 'intent-document'
      if (set.documents.length > 1) item.appendChild(line(view.title, 'fl-collision-topic'))
      item.appendChild(line(view.intro, 'fl-collision-intro'))
      const sides = window.document.createElement('div')
      sides.className = 'fl-collision-sides'
      for (const pane of view.panes) {
        const side = window.document.createElement('div')
        side.className = 'fl-collision-side'
        side.dataset['pane'] = pane.keep
        side.appendChild(line(pane.heading, 'fl-collision-side-heading'))
        const text = window.document.createElement('pre')
        text.className = 'fl-collision-text'
        text.textContent = pane.text
        side.appendChild(text)
        sides.appendChild(side)
      }
      item.appendChild(sides)
      const error = this.#errors.get(view.id)
      if (error !== undefined) item.appendChild(line(error, 'fl-collision-error'))
      const actions = window.document.createElement('div')
      actions.className = 'fl-collision-actions'
      const busy = this.#busy === view.id
      for (const choice of view.choices) {
        const button = window.document.createElement('fl-button')
        if (choice.primary) button.setAttribute('variant', 'primary')
        button.setAttribute('small', '')
        button.dataset['keep'] = choice.keep
        button.textContent = busy && !choice.disabled ? SAVING_LABEL : choice.label
        if (choice.disabled || this.#busy !== null) button.setAttribute('disabled', '')
        button.addEventListener('click', () => void this.#keep(view.id, choice.keep))
        actions.appendChild(button)
      }
      item.appendChild(actions)
      this.#body.appendChild(item)
    }
  }
}

function line(text: string, className: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  return el
}

let current: IntentMergeCard | null = null

/** Open "See both" for one merge set. One at a time. */
export function openIntentMergeCard(slug: string, mergeId: string): void {
  current?.close()
  current = new IntentMergeCard(slug, mergeId)
}

function toast(slug: string, title: string, body: string, level: FlowNotification['level']): void {
  document.dispatchEvent(
    new CustomEvent<FlowNotification>('flow:notify', {
      detail: { kind: 'state-change', rootId: `workspace:${slug}`, label: 'Workspace', title, body, timestamp: new Date().toISOString(), level },
    }),
  )
}

/** "Undo": put back this computer's versions of every document the merge settled. */
async function undo(slug: string, mergeId: string): Promise<void> {
  const api = window.flow.workspaces
  if (api === undefined) return
  try {
    const result = await api.keepIntent({ slug, mergeId, keep: 'ours' })
    toast(slug, result.ok ? UNDONE_TITLE : UNDO_FAILED_TITLE, result.detail, result.ok ? 'info' : 'warn')
  } catch (error) {
    console.error('flow: could not undo the merge', error)
    toast(slug, UNDO_FAILED_TITLE, KEEP_FAILED, 'warn')
  }
}

let initialized = false

/** Answer the notification's "Undo" and "See both". Call once at startup. */
export function initIntentMergeCard(): void {
  if (initialized || window.flow?.workspaces === undefined) return
  initialized = true
  document.addEventListener(WORKSPACE_INTENT_SEE_BOTH_EVENT, (event) => {
    const detail = intentEventDetail((event as CustomEvent<unknown>).detail)
    if (detail !== null) openIntentMergeCard(detail.slug, detail.mergeId)
  })
  document.addEventListener(WORKSPACE_INTENT_UNDO_EVENT, (event) => {
    const detail = intentEventDetail((event as CustomEvent<unknown>).detail)
    if (detail !== null) void undo(detail.slug, detail.mergeId)
  })
}
