/**
 * The same-topic collision card — what a paused Workspace sync is waiting on,
 * and the person's choice for each item.
 *
 * Opened by `flow:open-workspace-sync` — the paused notification's button and
 * the Workspace settings' "Review the changes" — with an optional
 * `detail.slug`; without one it opens on the first paused Workspace.
 *
 * A VIEW. Every word and every choice comes from `collision-card-model.ts`.
 * Each choice calls `workspaces.resolve`; the card then repaints from the
 * answer and from `workspaces:syncChanged` for its own Workspace only.
 *
 * "LET FLOW ADAPT IT" NEVER SETTLES ANYTHING ON ITS OWN. It opens a new
 * conversation in the Workspace asking an agent for one merged text; the
 * person brings the draft back here, can edit it, and only "Use this version"
 * resolves (`take: 'text'`). The draft state lives outside the card, keyed by
 * the item's id, so closing the card to read the conversation loses nothing.
 */
import { markModalOverlay } from '../modal-overlay'
import type { WorkspaceListing, WorkspaceSyncStatus } from '../../shared/workspaces-contract'
import {
  ADAPT_STARTED,
  ALL_SETTLED,
  CLOSE_LABEL,
  COLLISION_TITLE,
  DISCARD_DRAFT,
  DRAFT_HEADING,
  EMPTY_DRAFT,
  NO_DRAFT_YET,
  NO_PROJECT_FOR_AGENT,
  NOTHING_WAITING,
  READ_FAILED,
  RECORDED_LINE,
  RESOLVE_FAILED,
  SAVING_LABEL,
  THREAD_FAILED,
  TRUNCATED_LINE,
  USE_DRAFT_LABEL,
  USE_THIS_VERSION,
  WORKSPACE_SYNC_EVENT,
  adaptPrompt,
  adaptThreadTitle,
  collisionItems,
  collisionThreadMessage,
  recordChange,
  extractDraft,
  introLine,
  recordPrompt,
  recordThreadTitle,
  takeOf,
  threadProjectFor,
  type ChoiceView,
  type CollisionItemView,
} from './collision-card-model'

/** One item's "Let Flow adapt it" progress — kept across card closes. */
interface AdaptState {
  threadId: string
  /** The draft being edited; null until brought in. */
  draft: string | null
  noDraftYet: boolean
}

const adapting = new Map<string, AdaptState>()

class CollisionCard {
  readonly #overlay: HTMLDivElement
  readonly #dialog: HTMLDivElement
  readonly #body: HTMLDivElement
  #slug: string | null
  #workspace: WorkspaceListing | null = null
  #openRoots: string[] = []
  #status: WorkspaceSyncStatus | null = null
  #wasPaused = false
  #readFailed = false
  #notice: string | null = null
  #busy = new Set<string>()
  #errors = new Map<string, string>()
  #unsubscribe: (() => void) | null = null
  #closed = false
  readonly #onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      this.close()
    }
  }

  constructor(slug: string | null) {
    injectStyles()
    this.#slug = slug
    this.#overlay = document.createElement('div')
    this.#overlay.className = 'fl-collision-overlay'
    markModalOverlay(this.#overlay)
    this.#dialog = document.createElement('div')
    this.#dialog.className = 'fl-collision'
    this.#dialog.setAttribute('role', 'dialog')
    this.#dialog.setAttribute('aria-modal', 'true')
    this.#dialog.setAttribute('aria-label', COLLISION_TITLE)
    this.#dialog.tabIndex = -1
    const header = document.createElement('div')
    header.className = 'fl-collision-header'
    const title = document.createElement('h2')
    title.className = 'fl-collision-title'
    title.textContent = COLLISION_TITLE
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'fl-collision-btn'
    close.textContent = CLOSE_LABEL
    close.addEventListener('click', () => this.close())
    header.append(title, close)
    this.#body = document.createElement('div')
    this.#body.className = 'fl-collision-body'
    this.#dialog.append(header, this.#body)
    this.#overlay.appendChild(this.#dialog)
    this.#overlay.addEventListener('mousedown', (event) => {
      if (event.target === this.#overlay) this.close()
    })
    document.addEventListener('keydown', this.#onKey, true)
    document.body.appendChild(this.#overlay)
    this.#dialog.focus()

    const api = window.flow.workspaces
    if (api !== undefined) {
      this.#unsubscribe = api.onSyncChanged((event) => {
        if (this.#closed || event.slug !== this.#slug) return
        this.#setStatus(event.status)
        this.#render()
      })
    }
    void this.#load()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#unsubscribe?.()
    document.removeEventListener('keydown', this.#onKey, true)
    this.#overlay.remove()
    if (current === this) current = null
  }

  async #load(): Promise<void> {
    const api = window.flow.workspaces
    if (api === undefined) return
    const [list, roots] = await Promise.all([
      api.list().catch(() => null),
      window.flow.project.list().catch(() => []),
    ])
    this.#openRoots = roots.map((root) => root.rootPath)
    if (list === null || !list.ok) {
      this.#readFailed = true
      this.#render()
      return
    }
    if (this.#slug === null) {
      // No Workspace named: the first one that is waiting on a person.
      for (const workspace of list.workspaces) {
        const status = await api.syncStatus({ slug: workspace.slug }).catch(() => null)
        if (status?.state === 'paused') {
          this.#slug = workspace.slug
          this.#workspace = workspace
          this.#setStatus(status)
          break
        }
      }
    } else {
      this.#workspace = list.workspaces.find((workspace) => workspace.slug === this.#slug) ?? null
      const status = await api.syncStatus({ slug: this.#slug }).catch(() => null)
      if (status === null) this.#readFailed = true
      else this.#setStatus(status)
    }
    this.#render()
  }

  #setStatus(status: WorkspaceSyncStatus): void {
    if (status.state === 'paused') this.#wasPaused = true
    this.#status = status
  }

  #render(): void {
    if (this.#closed) return
    this.#body.replaceChildren()
    if (this.#readFailed) {
      this.#body.appendChild(line(READ_FAILED, 'fl-collision-muted'))
      return
    }
    const items = collisionItems(this.#status)
    // The Workspace's name — never its folder slug, which nobody chose to read.
    const name = this.#workspace?.name ?? 'This Workspace'
    if (this.#notice !== null) this.#body.appendChild(line(this.#notice, 'fl-collision-notice'))
    if (items.length === 0) {
      this.#body.appendChild(line(this.#wasPaused ? ALL_SETTLED : NOTHING_WAITING, 'fl-collision-muted'))
      return
    }
    this.#body.appendChild(line(introLine(name, items.length), 'fl-collision-intro'))
    for (const item of items) this.#body.appendChild(this.#item(item))
  }

  #item(item: CollisionItemView): HTMLElement {
    const card = document.createElement('section')
    card.className = `fl-collision-item${item.isDecision ? ' decision' : ''}`
    card.dataset['itemId'] = item.id
    card.appendChild(line(item.heading, 'fl-collision-kind'))
    card.appendChild(line(item.topic, 'fl-collision-topic'))
    const sides = document.createElement('div')
    sides.className = 'fl-collision-sides'
    for (const side of item.sides) {
      const block = document.createElement('div')
      block.className = 'fl-collision-side'
      const text = document.createElement('pre')
      text.className = 'fl-collision-text'
      text.textContent = side.text
      block.append(line(side.heading, 'fl-collision-side-heading'), text)
      sides.appendChild(block)
    }
    card.appendChild(sides)
    if (item.truncated) card.appendChild(line(TRUNCATED_LINE, 'fl-collision-muted'))

    const adapt = adapting.get(item.id)
    if (adapt !== undefined) card.appendChild(this.#adaptBlock(item, adapt))

    const busy = this.#busy.has(item.id)
    const threadRoot = this.#threadRoot()
    const actions = document.createElement('div')
    actions.className = 'fl-collision-actions'
    for (const choice of item.choices) {
      if (choice.choice === 'adapt' && adapt !== undefined) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'fl-collision-btn'
      button.dataset['choice'] = choice.choice
      button.textContent = busy ? SAVING_LABEL : choice.label
      button.disabled = busy || (choice.needsThread && threadRoot === null)
      button.addEventListener('click', () => void this.#choose(item, choice))
      actions.appendChild(button)
    }
    card.appendChild(actions)
    if (threadRoot === null && item.choices.some((choice) => choice.needsThread)) {
      card.appendChild(line(NO_PROJECT_FOR_AGENT, 'fl-collision-muted'))
    }
    const error = this.#errors.get(item.id)
    if (error !== undefined) card.appendChild(line(error, 'fl-collision-error'))
    return card
  }

  #adaptBlock(item: CollisionItemView, adapt: AdaptState): HTMLElement {
    const block = document.createElement('div')
    block.className = 'fl-collision-adapt'
    if (adapt.draft === null) {
      block.appendChild(line(adapt.noDraftYet ? NO_DRAFT_YET : ADAPT_STARTED, 'fl-collision-muted'))
      const row = document.createElement('div')
      row.className = 'fl-collision-actions'
      row.append(
        button(USE_DRAFT_LABEL, () => void this.#bringDraft(adapt), 'use-draft'),
        button(DISCARD_DRAFT, () => {
          adapting.delete(item.id)
          this.#render()
        }),
      )
      block.appendChild(row)
      return block
    }
    block.appendChild(line(DRAFT_HEADING, 'fl-collision-side-heading'))
    const editor = document.createElement('textarea')
    editor.className = 'fl-collision-draft'
    editor.value = adapt.draft
    editor.rows = 8
    editor.addEventListener('input', () => {
      adapt.draft = editor.value
    })
    block.appendChild(editor)
    const row = document.createElement('div')
    row.className = 'fl-collision-actions'
    row.append(
      button(USE_THIS_VERSION, () => void this.#useDraft(item, adapt), 'use-this-version'),
      button(DISCARD_DRAFT, () => {
        adapting.delete(item.id)
        this.#render()
      }),
    )
    block.appendChild(row)
    return block
  }

  #threadRoot(): string | null {
    const projects = this.#workspace?.projects ?? []
    return threadProjectFor(projects.map((project) => project.localPath), this.#openRoots)
  }

  async #choose(item: CollisionItemView, choice: ChoiceView): Promise<void> {
    const take = takeOf(choice.choice)
    if (take !== null) {
      await this.#resolve(item, { take })
      return
    }
    if (choice.choice === 'adapt') {
      const threadId = await this.#startThread(
        adaptThreadTitle(item.topic),
        adaptPrompt({ workspaceName: this.#workspace?.name ?? '', item }),
      )
      if (threadId === null) {
        this.#errors.set(item.id, THREAD_FAILED)
      } else {
        this.#errors.delete(item.id)
        adapting.set(item.id, { threadId, draft: null, noDraftYet: false })
      }
      this.#render()
      return
    }
    // Record a change: the conversation FIRST, then keep the Workspace's, then
    // write the change as a new decision (recordChange says why that order).
    const message = recordPrompt({ workspaceName: this.#workspace?.name ?? '', item })
    const outcome = await recordChange({
      createThread: () => this.#createThread(recordThreadTitle(item.topic)),
      keepTheirs: () => this.#resolve(item, { take: 'theirs' }),
      send: async (threadId) => {
        await window.flow.threads.sendMessage(collisionThreadMessage(threadId, message))
      },
      discardThread: async (threadId) => {
        await window.flow.threads.delete({ threadId }).catch((error: unknown) => {
          console.warn('flow: could not remove the unused conversation', error)
        })
      },
    }).catch((error: unknown) => {
      console.error('flow: could not record the change', error)
      return { kind: 'thread-failed' as const }
    })
    if (outcome.kind === 'not-resolved') return
    if (outcome.kind === 'thread-failed') {
      this.#errors.set(item.id, THREAD_FAILED)
      this.#render()
      return
    }
    this.#notice = RECORDED_LINE
    this.close()
    document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: outcome.threadId } }))
  }

  async #resolve(
    item: CollisionItemView,
    request: { take: 'ours' | 'theirs' | 'merged' } | { take: 'text'; text: string },
  ): Promise<boolean> {
    const api = window.flow.workspaces
    if (api === undefined || this.#slug === null) return false
    this.#busy.add(item.id)
    this.#errors.delete(item.id)
    this.#render()
    // The item's id: the CLI decides exactly what the person is looking at.
    const answer = await api.resolve({ slug: this.#slug, id: item.id, path: item.path, ...request }).catch(() => null)
    this.#busy.delete(item.id)
    if (answer === null) {
      this.#errors.set(item.id, RESOLVE_FAILED)
      this.#render()
      return false
    }
    this.#setStatus(answer.status)
    if (!answer.ok && answer.reason === 'stale') {
      // It changed since the person looked: the card now shows what is
      // waiting, and says why it asks again.
      adapting.delete(item.id)
      this.#notice = answer.detail
      this.#render()
      return false
    }
    if (!answer.ok) {
      this.#errors.set(item.id, answer.detail === '' ? RESOLVE_FAILED : answer.detail)
      this.#render()
      return false
    }
    adapting.delete(item.id)
    this.#render()
    return true
  }

  /** A new conversation in the Workspace's open project, or null. */
  async #createThread(title: string): Promise<string | null> {
    const projectRoot = this.#threadRoot()
    if (projectRoot === null) return null
    try {
      const thread = await window.flow.threads.create({ projectRoot, title })
      return thread.id
    } catch (error) {
      console.error('flow: could not start the Workspace conversation', error)
      return null
    }
  }

  async #startThread(title: string, message: string): Promise<string | null> {
    const threadId = await this.#createThread(title)
    if (threadId === null) return null
    try {
      await window.flow.threads.sendMessage(collisionThreadMessage(threadId, message))
      return threadId
    } catch (error) {
      console.error('flow: could not start the Workspace conversation', error)
      return null
    }
  }

  async #bringDraft(adapt: AdaptState): Promise<void> {
    const messages = await window.flow.messages.list({ threadId: adapt.threadId }).catch(() => [])
    const draft = extractDraft(messages)
    adapt.noDraftYet = draft === null
    if (draft !== null) adapt.draft = draft
    this.#render()
  }

  async #useDraft(item: CollisionItemView, adapt: AdaptState): Promise<void> {
    const text = adapt.draft ?? ''
    if (text.trim() === '') {
      this.#errors.set(item.id, EMPTY_DRAFT)
      this.#render()
      return
    }
    await this.#resolve(item, { take: 'text', text })
  }
}

function line(text: string, className: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  return el
}

function button(label: string, onClick: () => void, part?: string): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'fl-collision-btn'
  el.textContent = label
  if (part !== undefined) el.dataset['part'] = part
  el.addEventListener('click', onClick)
  return el
}

let current: CollisionCard | null = null

/** Open the card for a Workspace (or the first paused one). One card at a time. */
export function openCollisionCard(slug: string | null = null): void {
  current?.close()
  current = new CollisionCard(slug)
}

let initialized = false

/** Answer `flow:open-workspace-sync`. Call once at startup. */
export function initCollisionCard(): void {
  if (initialized || window.flow?.workspaces === undefined) return
  initialized = true
  document.addEventListener(WORKSPACE_SYNC_EVENT, (event) => {
    const slug = (event as CustomEvent<{ slug?: unknown } | null>).detail?.slug
    openCollisionCard(typeof slug === 'string' && slug !== '' ? slug : null)
  })
}

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-collision-overlay {
      position: fixed; inset: 0; z-index: 2100;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.45);
    }
    .fl-collision {
      width: min(720px, calc(100vw - var(--fl-space-xl)));
      max-height: 84vh; display: flex; flex-direction: column;
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-lg);
      background: var(--fl-color-surface); box-shadow: var(--fl-shadow-md);
      font-family: var(--fl-font-ui); color: var(--fl-color-text);
    }
    .fl-collision:focus { outline: none; }
    .fl-collision-header {
      display: flex; align-items: center; justify-content: space-between; gap: var(--fl-space-sm);
      padding: var(--fl-space-md) var(--fl-space-lg);
      border-bottom: var(--fl-border-width) solid var(--fl-color-separator, var(--fl-color-border));
    }
    .fl-collision-title { margin: 0; font-size: var(--fl-text-prose-size); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-collision-body { padding: var(--fl-space-lg); overflow-y: auto; display: flex; flex-direction: column; gap: var(--fl-space-md); }
    .fl-collision-intro { font-size: var(--fl-text-ui-size); color: var(--fl-color-text-secondary); }
    .fl-collision-muted { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }
    .fl-collision-error { font-size: var(--fl-text-caption-size); color: var(--fl-color-error); }
    .fl-collision-notice {
      font-size: var(--fl-text-caption-size); padding: var(--fl-space-xs) var(--fl-space-sm);
      border-radius: var(--fl-radius-sm); background: var(--fl-color-surface-raised);
    }
    .fl-collision-item {
      display: flex; flex-direction: column; gap: var(--fl-space-sm);
      padding: var(--fl-space-md); border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
    }
    .fl-collision-item.decision { border-left: 3px solid var(--fl-color-warning); }
    .fl-collision-kind { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-collision-topic { font-size: var(--fl-text-ui-size); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-collision-sides { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--fl-space-sm); }
    .fl-collision-side { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .fl-collision-side-heading { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }
    .fl-collision-text, .fl-collision-draft {
      margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word;
      padding: var(--fl-space-sm); border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface-raised); border: var(--fl-border-width) solid var(--fl-color-border);
      font-family: var(--fl-font-mono); font-size: var(--fl-text-caption-size); color: var(--fl-color-text);
    }
    .fl-collision-draft { width: 100%; box-sizing: border-box; resize: vertical; }
    .fl-collision-adapt { display: flex; flex-direction: column; gap: var(--fl-space-xs); }
    .fl-collision-actions { display: flex; flex-wrap: wrap; gap: var(--fl-space-xs); }
    .fl-collision-btn {
      padding: var(--fl-space-xs) var(--fl-space-md); border-radius: var(--fl-radius-md);
      border: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface-raised); color: var(--fl-color-text);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size); cursor: pointer;
    }
    .fl-collision-btn:hover:not(:disabled) { border-color: var(--fl-color-focus-ring); }
    .fl-collision-btn:disabled { opacity: 0.5; cursor: default; }
  `
  document.head.appendChild(style)
}
