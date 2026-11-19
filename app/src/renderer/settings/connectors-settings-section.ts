/**
 * Settings → Connectors, the view (plan_connectors Phase 7, FR-10..14).
 *
 * A VIEW, NOT A MODEL. Every sentence, section, pill and action comes from
 * `connectors-settings-model.ts`; every read and write goes through
 * `window.flow.connectors`, i.e. main's connector service — the renderer never
 * reads a config file (allowed-pattern #14).
 *
 * ONE INSTANCE PER SETTINGS PAGE, like the Workspaces section: the page
 * re-renders its body for unrelated reasons (an account change, a runtime
 * switch), and an open add form or a waiting sign-in must survive that.
 *
 * PAYS ONLY WHILE ON SCREEN (allowed-pattern #17). Listing asks main for the
 * connectors' status, which opens a runtime query; so the list is read when
 * the group is shown, and on `connectors:changed` for the shown project only
 * while the section is visible. A change that arrives off screen is left
 * alone; the list is read again on the way back in.
 *
 * Destructive writes (Remove, Sign out) are sent only from an in-page
 * confirmation, with the literal `confirmed: true` (forbidden-pattern #15).
 */
import type {
  ConnectorChangeEvent,
  ConnectorEntry,
  ConnectorListAnswer,
  ConnectorScope,
  ConnectorSuggestion,
} from '../../shared/connectors'
import { projectLabel } from '../project-label'
import { getEffectiveTheme } from '../theme/theme-controller'
import { connectorIconLoader, createConnectorIcon, type ConnectorIconLoader } from '../threads/connector-icon'
import {
  ACTION_LABELS,
  ADD_CONNECTOR_LABEL,
  ADD_LABEL,
  ADDING_LABEL,
  ASK_FIRST_LABEL,
  AVAILABILITY_LABELS,
  CANCEL_LABEL,
  CONFIRM_REMOVE_LABEL,
  CONFIRM_SIGN_OUT_LABEL,
  CONNECTORS_DESCRIPTION,
  CONNECTORS_TITLE,
  EMPTY_LINE,
  FINISH_ON_CLAUDE_AI_LINE,
  FORM_LABELS,
  LIST_FAILED_LINE,
  LOADING_LINE,
  NOT_NOW_LABEL,
  NO_PROJECT_LINE,
  NO_TOOLS_LINE,
  SHOWING_FOR_LABEL,
  STATUS_UNREAD_LINE,
  TOOLS_LABEL,
  UNAVAILABLE_LINE,
  WAITING_SIGN_IN_LINE,
  WORKING_LABEL,
  accountLabelOf,
  connectorSections,
  removeConfirmText,
  removeLabel,
  signInOutcomeLine,
  signOutConfirmText,
  suggestedSection,
  validateAddForm,
  type AddFormInput,
  type ConnectorAvailability,
  type ConnectorRow,
  type ConnectsBy,
  type SectionContext,
  type SuggestedSection,
} from './connectors-settings-model'

/** A sign-in this section started and is still waiting on. */
type SignInWait = 'browser' | 'claudeai'

interface ProjectChoice {
  rootPath: string
  label: string
}

const STYLE_ID = 'fl-connectors-settings-styles'

export class ConnectorsSettingsSection {
  readonly element: HTMLElement
  #body: HTMLElement
  #picker: HTMLSelectElement
  #addButton: HTMLButtonElement
  #form: HTMLElement | null = null
  #formOpen = false
  #formBusy = false
  #formProblem: string | null = null
  #formInput: AddFormInput = emptyForm()

  /** The project the page is on (the app's active one). */
  #defaultRoot: string | null = null
  /** The project a person picked here; null = follow the page's. */
  #chosenRoot: string | null = null
  #projects: ProjectChoice[] = []
  #accountLabel = accountLabelOf(null)

  #answer: ConnectorListAnswer | null = null
  #answerRoot: string | null = null
  #loading = false
  #failed = false
  #seq = 0

  /** The row that is open. */
  #openRow: string | null = null
  #confirm: { name: string; kind: 'remove' | 'sign-out' } | null = null
  #busy = new Set<string>()
  #signIns = new Map<string, SignInWait>()
  /** A sentence under one row: a refusal, or how a sign-in ended. */
  #notices = new Map<string, string>()
  #icons = new Map<string, Promise<string | null>>()

  /** "Suggested for <project>": main's answer for `#suggestRoot`. */
  #suggestions: ConnectorSuggestion[] = []
  #suggestRoot: string | null = null
  /** Fingerprints a "Not now" here hid, per project, until main's next answer carries the dismissal. */
  #hiddenSuggestions = new Map<string, Set<string>>()

  #unsubscribe: Array<() => void> = []
  #disposed = false

  constructor() {
    injectStyles()
    const section = document.createElement('div')
    section.className = 'fl-settings-section fl-cns'

    const head = document.createElement('div')
    head.className = 'fl-cns-head'
    const titles = document.createElement('div')
    titles.className = 'fl-cns-titles'
    const title = document.createElement('div')
    title.className = 'fl-cns-title'
    title.textContent = CONNECTORS_TITLE
    const description = document.createElement('div')
    description.className = 'fl-settings-hint fl-cns-description'
    description.textContent = CONNECTORS_DESCRIPTION
    titles.append(title, description)
    this.#addButton = document.createElement('button')
    this.#addButton.type = 'button'
    this.#addButton.className = 'fl-cns-btn fl-cns-btn--primary'
    this.#addButton.textContent = ADD_CONNECTOR_LABEL
    this.#addButton.addEventListener('click', () => this.#openForm())
    head.append(titles, this.#addButton)

    const showing = document.createElement('label')
    showing.className = 'fl-cns-showing'
    const showingText = document.createElement('span')
    showingText.textContent = SHOWING_FOR_LABEL
    this.#picker = document.createElement('select')
    this.#picker.className = 'fl-settings-select fl-cns-picker'
    this.#picker.addEventListener('change', () => {
      this.#chosenRoot = this.#picker.value === '' ? null : this.#picker.value
      this.#resetRowState()
      void this.refresh()
    })
    showing.append(showingText, this.#picker)

    this.#body = document.createElement('div')
    this.#body.className = 'fl-cns-body'
    section.append(head, showing, this.#body)
    this.element = section

    const api = window.flow.connectors
    if (api !== undefined) {
      this.#unsubscribe.push(api.onChanged((event) => this.#onChanged(event)))
    }
  }

  /** The project the page is on; the section follows it until one is picked here. */
  setDefaultProject(rootPath: string | null): void {
    this.#defaultRoot = rootPath
  }

  /** The group was shown (selected, or the page opened): read the list. */
  shown(): void {
    if (this.#disposed) return
    void this.refresh()
  }

  dispose(): void {
    this.#disposed = true
    for (const unsubscribe of this.#unsubscribe) unsubscribe()
    this.#unsubscribe = []
  }

  /** On screen: in the page AND not inside a hidden group or a closed tab. */
  #onScreen(): boolean {
    return this.element.isConnected && this.element.getClientRects().length > 0
  }

  #root(): string | null {
    const chosen = this.#chosenRoot
    if (chosen !== null && this.#projects.some((project) => project.rootPath === chosen)) return chosen
    return this.#defaultRoot ?? this.#projects[0]?.rootPath ?? null
  }

  #context(): SectionContext {
    const root = this.#root()
    const projectName = this.#projects.find((project) => project.rootPath === root)?.label ?? 'This project'
    return { accountLabel: this.#accountLabel, projectName }
  }

  #onChanged(event: ConnectorChangeEvent): void {
    if (this.#disposed) return
    if (event.signIn !== undefined) {
      const { name, outcome } = event.signIn
      if (this.#signIns.delete(name)) {
        const line = signInOutcomeLine(outcome)
        if (line !== null) this.#notices.set(name, line)
        else this.#notices.delete(name)
      }
    }
    const root = this.#root()
    // A chat's own change (threadId, no project) is not this list's business.
    const ours = event.projectRoot === undefined ? event.threadId === undefined : event.projectRoot === root
    if (!ours && event.signIn === undefined) return
    // Off screen it waits: `shown()` reads the list on the way back in.
    if (!this.#onScreen()) return
    void this.refresh()
  }

  /** Re-read the projects, the account and the list, then paint. */
  async refresh(): Promise<void> {
    if (this.#disposed) return
    const api = window.flow
    if (api.connectors === undefined) {
      this.#paint()
      return
    }
    const seq = ++this.#seq
    const roots = (await api.project.list().catch(() => [])).map((root) => root.rootPath)
    if (this.#defaultRoot !== null && !roots.includes(this.#defaultRoot)) roots.unshift(this.#defaultRoot)
    this.#projects = roots.map((rootPath) => ({ rootPath, label: projectLabel(rootPath, roots) }))
    const root = this.#root()
    if (root !== this.#answerRoot) {
      this.#answer = null
      this.#icons.clear()
    }
    this.#loading = true
    this.#paint()
    if (root === null) {
      this.#loading = false
      this.#paint()
      return
    }
    const [resolution, answer] = await Promise.all([
      api.accounts.activeForProject({ rootPath: root }).catch(() => null),
      api.connectors.list({ projectRoot: root }).catch(() => null),
    ])
    if (seq !== this.#seq || this.#disposed) return
    this.#accountLabel = accountLabelOf(resolution)
    this.#loading = false
    this.#failed = answer === null
    if (answer !== null) {
      this.#answer = answer
      this.#answerRoot = root
    }
    this.#paint()
    if (answer !== null) await this.#readSuggestions(root, seq)
  }

  /**
   * Ask main for this project's suggestions — after the list, so main picks
   * from the list it just built (no second status query). Asked only from
   * `refresh()`, which runs while the section is on screen; never polled.
   */
  async #readSuggestions(root: string, seq: number): Promise<void> {
    const api = window.flow.connectors
    if (api === undefined || typeof api.suggest !== 'function') return
    const answer = await api.suggest({ projectRoot: root }).catch(() => null)
    if (seq !== this.#seq || this.#disposed) return
    this.#suggestions = answer?.suggestions ?? []
    this.#suggestRoot = root
    this.#paint()
  }

  #resetRowState(): void {
    this.#openRow = null
    this.#confirm = null
    this.#notices.clear()
  }

  // ── Painting ────────────────────────────────────────────────────────────

  #paint(): void {
    if (this.#disposed) return
    this.#paintPicker()
    const api = window.flow.connectors
    this.#addButton.hidden = api === undefined || this.#root() === null
    this.#addButton.disabled = this.#formOpen
    const nodes: HTMLElement[] = []
    if (api === undefined) {
      nodes.push(line(UNAVAILABLE_LINE, 'fl-settings-empty'))
      this.#body.replaceChildren(...nodes)
      return
    }
    const root = this.#root()
    if (root === null) {
      nodes.push(line(NO_PROJECT_LINE, 'fl-settings-empty'))
      this.#body.replaceChildren(...nodes)
      return
    }
    if (this.#formOpen) nodes.push(this.#formElement())
    if (this.#answer === null) {
      nodes.push(line(this.#loading ? LOADING_LINE : this.#failed ? LIST_FAILED_LINE : LOADING_LINE, 'fl-settings-empty'))
      this.#body.replaceChildren(...nodes)
      return
    }
    if (this.#failed) nodes.push(line(LIST_FAILED_LINE, 'fl-cns-notice'))
    if (this.#answer.error !== undefined) nodes.push(line(STATUS_UNREAD_LINE, 'fl-cns-notice'))
    const suggested = this.#suggestedModel(root)
    if (suggested !== null) nodes.push(this.#suggestedElement(suggested, root))
    const sections = connectorSections(this.#answer.entries, this.#context())
    if (sections.length === 0) nodes.push(line(EMPTY_LINE, 'fl-settings-empty'))
    for (const section of sections) {
      const block = document.createElement('div')
      block.className = 'fl-cns-group'
      block.dataset['section'] = section.key
      const heading = document.createElement('div')
      heading.className = 'fl-settings-heading fl-cns-group-heading'
      heading.textContent = section.heading
      block.appendChild(heading)
      for (const row of section.rows) block.appendChild(this.#rowElement(row, root))
      nodes.push(block)
    }
    this.#body.replaceChildren(...nodes)
  }

  #suggestedModel(root: string): SuggestedSection | null {
    if (this.#suggestRoot !== root) return null
    const entries = this.#answer?.entries ?? []
    return suggestedSection(
      this.#suggestions,
      this.#context().projectName,
      this.#hiddenSuggestions.get(root),
      (name) => entries.some((entry) => entry.name === name && entry.status === 'needs-auth'),
    )
  }

  #suggestedElement(model: SuggestedSection, root: string): HTMLElement {
    const block = document.createElement('div')
    block.className = 'fl-cns-group fl-cns-suggested'
    block.dataset['section'] = 'suggested'
    const head = document.createElement('div')
    head.className = 'fl-cns-suggested-head'
    const titles = document.createElement('div')
    titles.className = 'fl-cns-titles'
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading fl-cns-group-heading'
    heading.textContent = model.heading
    const subtext = document.createElement('div')
    subtext.className = 'fl-cns-quiet'
    subtext.textContent = model.subtext
    titles.append(heading, subtext)
    const notNow = button(NOT_NOW_LABEL, false, () => void this.#dismissSuggestions(root, model.fingerprints))
    notNow.dataset['role'] = 'not-now'
    head.append(titles, notNow)
    block.appendChild(head)
    for (const row of model.rows) {
      const wrap = document.createElement('div')
      wrap.className = 'fl-cns-row-wrap'
      wrap.dataset['suggestion'] = row.name
      const line_ = document.createElement('div')
      line_.className = 'fl-cns-row fl-cns-row--static'
      const icon = createConnectorIcon({
        name: row.name,
        displayName: row.displayName,
        size: 30,
        load: this.#iconLoader(root),
      })
      const text = document.createElement('div')
      text.className = 'fl-cns-row-text'
      const name = document.createElement('div')
      name.className = 'fl-cns-row-name'
      name.textContent = row.displayName
      const reason = document.createElement('div')
      reason.className = 'fl-cns-row-detail'
      reason.textContent = row.reason
      text.append(name, reason)
      line_.append(icon, text)
      const waiting = this.#signIns.get(row.name)
      if (waiting === undefined) {
        const busy = this.#busy.has(row.name)
        const signIn = button(busy ? WORKING_LABEL : ACTION_LABELS['sign-in'], true, () => void this.#signIn(row.name, root))
        signIn.disabled = busy
        line_.appendChild(signIn)
      }
      wrap.appendChild(line_)
      if (waiting === 'browser') {
        const bar = document.createElement('div')
        bar.className = 'fl-cns-inline'
        bar.appendChild(line(WAITING_SIGN_IN_LINE, 'fl-cns-inline-text'))
        bar.appendChild(
          button(CANCEL_LABEL, false, () => {
            this.#signIns.delete(row.name)
            this.#paint()
            void window.flow.connectors?.cancelSignIn({ projectRoot: root, name: row.name }).catch(() => undefined)
          }),
        )
        wrap.appendChild(bar)
      } else if (waiting === 'claudeai') {
        wrap.appendChild(line(FINISH_ON_CLAUDE_AI_LINE, 'fl-cns-inline-note'))
      } else {
        const notice = this.#notices.get(row.name)
        if (notice !== undefined) wrap.appendChild(line(notice, 'fl-cns-inline-note fl-cns-inline-note--error'))
      }
      block.appendChild(wrap)
    }
    return block
  }

  /** "Not now": hide the section for this project at once, then keep the dismissal in main. */
  async #dismissSuggestions(root: string, fingerprints: readonly string[]): Promise<void> {
    if (fingerprints.length === 0) return
    const hidden = this.#hiddenSuggestions.get(root) ?? new Set<string>()
    for (const fingerprint of fingerprints) hidden.add(fingerprint)
    this.#hiddenSuggestions.set(root, hidden)
    this.#paint()
    const api = window.flow.connectors
    if (api === undefined || typeof api.dismissSuggestions !== 'function') return
    await api.dismissSuggestions({ projectRoot: root, fingerprints: [...fingerprints] }).catch(() => undefined)
  }

  #paintPicker(): void {
    const root = this.#root()
    const wanted = this.#projects.map((project) => `${project.rootPath}\u0000${project.label}`).join('\u0001')
    if (this.#picker.dataset['options'] !== wanted) {
      this.#picker.replaceChildren(
        ...this.#projects.map((project) => {
          const option = document.createElement('option')
          option.value = project.rootPath
          option.textContent = project.label
          return option
        }),
      )
      this.#picker.dataset['options'] = wanted
    }
    if (root !== null) this.#picker.value = root
    this.#picker.disabled = this.#projects.length < 2
    const label = this.#picker.parentElement
    if (label !== null) label.hidden = root === null
  }

  #iconLoader(root: string): ConnectorIconLoader {
    const shared = connectorIconLoader()
    if (shared !== undefined) return shared
    return (name: string) => {
      const cached = this.#icons.get(name)
      if (cached !== undefined) return cached
      const api = window.flow.connectors
      const read =
        api === undefined
          ? Promise.resolve(null)
          : api
              .icon({ projectRoot: root, name, theme: getEffectiveTheme() })
              .then((answer) => answer.dataUri)
              .catch(() => null)
      this.#icons.set(name, read)
      return read
    }
  }

  #rowElement(row: ConnectorRow, root: string): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'fl-cns-row-wrap'
    wrap.dataset['connector'] = row.name
    const open = this.#openRow === row.name

    const head = document.createElement('div')
    head.className = 'fl-cns-row'
    head.setAttribute('role', 'button')
    head.tabIndex = 0
    head.setAttribute('aria-expanded', open ? 'true' : 'false')
    const toggle = (): void => {
      this.#openRow = open ? null : row.name
      if (this.#confirm?.name === row.name && this.#confirm.kind === 'remove') this.#confirm = null
      this.#paint()
    }
    head.addEventListener('click', toggle)
    head.addEventListener('keydown', (event) => {
      if (event.target !== head) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })

    const icon = createConnectorIcon({
      name: row.name,
      displayName: row.displayName,
      size: 30,
      load: this.#iconLoader(root),
    })
    const text = document.createElement('div')
    text.className = 'fl-cns-row-text'
    const name = document.createElement('div')
    name.className = 'fl-cns-row-name'
    name.textContent = row.displayName
    if (row.tag !== undefined) {
      const tag = document.createElement('span')
      tag.className = 'fl-cns-tag'
      tag.textContent = row.tag
      name.appendChild(tag)
    }
    const detail = document.createElement('div')
    detail.className = 'fl-cns-row-detail'
    detail.textContent = row.detail
    text.append(name, detail)

    const pill = document.createElement('span')
    pill.className = 'fl-cns-pill'
    pill.dataset['tone'] = row.pill.tone
    const dot = document.createElement('span')
    dot.className = 'fl-cns-dot'
    const word = document.createElement('span')
    word.textContent = row.pill.label
    pill.append(dot, word)

    head.append(icon, text, pill)
    const action = this.#actionElement(row, root)
    if (action !== null) head.appendChild(action)
    wrap.appendChild(head)

    const below = this.#belowRow(row, root)
    if (below !== null) wrap.appendChild(below)
    if (open) wrap.appendChild(this.#detailsElement(row, root))
    return wrap
  }

  #actionElement(row: ConnectorRow, root: string): HTMLElement | null {
    const waiting = this.#signIns.get(row.name)
    if (waiting === 'browser') return null
    const action = waiting === 'claudeai' ? 'retry' : row.action
    if (action === null) return null
    if (action === 'sign-out' && this.#confirm?.name === row.name && this.#confirm.kind === 'sign-out') return null
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-cns-btn'
    const busy = this.#busy.has(row.name)
    button.textContent = busy ? WORKING_LABEL : ACTION_LABELS[action]
    button.disabled = busy
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      if (action === 'sign-in') void this.#signIn(row.name, root)
      else if (action === 'retry') void this.#retry(row.name, root)
      else {
        this.#confirm = { name: row.name, kind: 'sign-out' }
        this.#paint()
      }
    })
    button.addEventListener('keydown', (event) => event.stopPropagation())
    return button
  }

  /** What sits under a row's head: a waiting sign-in, a confirmation, a notice. */
  #belowRow(row: ConnectorRow, root: string): HTMLElement | null {
    const waiting = this.#signIns.get(row.name)
    if (waiting === 'browser') {
      const bar = document.createElement('div')
      bar.className = 'fl-cns-inline'
      bar.appendChild(line(WAITING_SIGN_IN_LINE, 'fl-cns-inline-text'))
      bar.appendChild(
        button(CANCEL_LABEL, false, () => {
          this.#signIns.delete(row.name)
          this.#paint()
          void window.flow.connectors?.cancelSignIn({ projectRoot: root, name: row.name }).catch(() => undefined)
        }),
      )
      return bar
    }
    if (waiting === 'claudeai') return line(FINISH_ON_CLAUDE_AI_LINE, 'fl-cns-inline-note')
    if (this.#confirm?.name === row.name && this.#confirm.kind === 'sign-out') {
      return this.#confirmBar(signOutConfirmText(row.displayName), CONFIRM_SIGN_OUT_LABEL, () =>
        this.#signOut(row.name, root),
      )
    }
    const notice = this.#notices.get(row.name)
    if (notice !== undefined) return line(notice, 'fl-cns-inline-note fl-cns-inline-note--error')
    return null
  }

  #confirmBar(text: string, confirmLabel: string, onConfirm: () => Promise<void>): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'fl-cns-inline fl-cns-confirm'
    bar.appendChild(line(text, 'fl-cns-inline-text'))
    const cancel = button(CANCEL_LABEL, false, () => {
      this.#confirm = null
      this.#paint()
    })
    const confirm = button(confirmLabel, false, () => {
      confirm.disabled = true
      cancel.disabled = true
      void onConfirm()
    })
    confirm.classList.add('fl-cns-btn--danger')
    bar.append(cancel, confirm)
    return bar
  }

  #detailsElement(row: ConnectorRow, root: string): HTMLElement {
    const box = document.createElement('div')
    box.className = 'fl-cns-details'

    const toolsHeading = document.createElement('div')
    toolsHeading.className = 'fl-cns-sub'
    toolsHeading.textContent = TOOLS_LABEL
    box.appendChild(toolsHeading)
    if (row.tools.length === 0) {
      box.appendChild(line(NO_TOOLS_LINE, 'fl-cns-quiet'))
    } else {
      const chips = document.createElement('div')
      chips.className = 'fl-cns-tools'
      for (const tool of row.tools) chips.appendChild(this.#toolChip(row, tool.name, tool.askFirst, root))
      box.appendChild(chips)
    }

    const facts = document.createElement('ul')
    facts.className = 'fl-cns-facts'
    for (const fact of row.facts) {
      const item = document.createElement('li')
      item.textContent = fact
      facts.appendChild(item)
    }
    box.appendChild(facts)

    if (row.managedElsewhere !== undefined) box.appendChild(line(row.managedElsewhere, 'fl-cns-quiet'))
    if (row.removable && row.scope !== undefined) {
      const scope = row.scope
      if (this.#confirm?.name === row.name && this.#confirm.kind === 'remove') {
        box.appendChild(
          this.#confirmBar(removeConfirmText(row.displayName), CONFIRM_REMOVE_LABEL, () =>
            this.#remove(row.name, scope, root),
          ),
        )
      } else {
        const remove = button(removeLabel(row.displayName), false, () => {
          this.#confirm = { name: row.name, kind: 'remove' }
          this.#paint()
        })
        remove.classList.add('fl-cns-btn--danger-text')
        const actions = document.createElement('div')
        actions.className = 'fl-cns-details-actions'
        actions.appendChild(remove)
        box.appendChild(actions)
      }
    }
    return box
  }

  #toolChip(row: ConnectorRow, tool: string, askFirst: boolean, root: string): HTMLElement {
    const chip = document.createElement('div')
    chip.className = 'fl-cns-tool'
    const name = document.createElement('span')
    name.className = 'fl-cns-tool-name'
    name.textContent = tool
    const label = document.createElement('span')
    label.className = 'fl-cns-tool-ask'
    label.textContent = ASK_FIRST_LABEL
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-label', `${ASK_FIRST_LABEL}: ${tool}`)
    const knob = document.createElement('span')
    knob.className = 'fl-fs-knob'
    toggle.appendChild(knob)
    const apply = (on: boolean): void => {
      toggle.className = `fl-fs-toggle fl-cns-switch${on ? ' on' : ''}`
      toggle.setAttribute('aria-checked', on ? 'true' : 'false')
    }
    apply(askFirst)
    let on = askFirst
    toggle.addEventListener('click', () => {
      const next = !on
      on = next
      apply(next)
      toggle.disabled = true
      const api = window.flow.connectors
      if (api === undefined) return
      void api
        .setAskFirst({ projectRoot: root, name: row.name, tool, on: next })
        .catch((error: unknown) => ({ ok: false as const, reason: sentenceOf(error) }))
        .then((answer) => {
          toggle.disabled = false
          if (answer.ok) {
            this.#notices.delete(row.name)
            this.#patchAskFirst(row.name, tool, next)
            return
          }
          on = !next
          apply(!next)
          this.#notices.set(row.name, answer.reason)
          this.#paint()
        })
    })
    chip.append(name, label, toggle)
    return chip
  }

  /** Keep the held answer in step with a write that succeeded (no repaint needed). */
  #patchAskFirst(name: string, tool: string, on: boolean): void {
    const entry = this.#answer?.entries.find((candidate) => candidate.name === name)
    if (entry === undefined) return
    const set = new Set(entry.askFirst)
    if (on) set.add(tool)
    else set.delete(tool)
    entry.askFirst = [...set]
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  async #signIn(name: string, root: string): Promise<void> {
    const api = window.flow.connectors
    if (api === undefined) return
    this.#busy.add(name)
    this.#notices.delete(name)
    this.#paint()
    const answer = await api
      .signIn({ projectRoot: root, name })
      .catch((error: unknown) => ({ ok: false as const, reason: sentenceOf(error) }))
    this.#busy.delete(name)
    if (!answer.ok) this.#notices.set(name, answer.reason)
    else if (answer.state === 'waiting') this.#signIns.set(name, 'browser')
    else if (answer.state === 'finish-in-browser') this.#signIns.set(name, 'claudeai')
    this.#paint()
    if (answer.ok && answer.state === 'connected') void this.refresh()
  }

  async #retry(name: string, root: string): Promise<void> {
    const api = window.flow.connectors
    if (api === undefined) return
    this.#busy.add(name)
    this.#notices.delete(name)
    this.#signIns.delete(name)
    this.#paint()
    const answer = await api
      .reconnect({ projectRoot: root, name })
      .catch((error: unknown) => ({ ok: false as const, reason: sentenceOf(error) }))
    this.#busy.delete(name)
    if (!answer.ok) this.#notices.set(name, answer.reason)
    this.#paint()
    if (answer.ok) void this.refresh()
  }

  async #signOut(name: string, root: string): Promise<void> {
    const api = window.flow.connectors
    if (api === undefined) return
    const answer = await api
      .signOut({ projectRoot: root, name, confirmed: true })
      .catch((error: unknown) => ({ ok: false as const, reason: sentenceOf(error) }))
    this.#confirm = null
    if (!answer.ok) this.#notices.set(name, answer.reason)
    else this.#notices.delete(name)
    this.#paint()
    if (answer.ok) void this.refresh()
  }

  async #remove(name: string, scope: ConnectorScope, root: string): Promise<void> {
    const api = window.flow.connectors
    if (api === undefined) return
    const answer = await api
      .remove({ projectRoot: root, scope, name, confirmed: true })
      .catch((error: unknown) => ({ ok: false as const, reason: sentenceOf(error) }))
    this.#confirm = null
    if (!answer.ok) {
      this.#notices.set(name, answer.reason)
      this.#paint()
      return
    }
    this.#notices.delete(name)
    if (this.#openRow === name) this.#openRow = null
    this.#paint()
    void this.refresh()
  }

  // ── The add form ────────────────────────────────────────────────────────

  #openForm(): void {
    if (this.#formOpen) return
    this.#formOpen = true
    this.#formProblem = null
    this.#formInput = emptyForm()
    this.#form = null
    this.#paint()
    const built = this.#form as HTMLElement | null
    built?.querySelector<HTMLInputElement>('input')?.focus()
  }

  #closeForm(): void {
    this.#formOpen = false
    this.#formBusy = false
    this.#formProblem = null
    this.#form = null
    this.#paint()
  }

  /** The form, built once per opening so a repaint keeps what was typed and the caret. */
  #formElement(): HTMLElement {
    if (this.#form !== null) {
      this.#syncForm(this.#form)
      return this.#form
    }
    const form = document.createElement('form')
    form.className = 'fl-cns-form'
    form.noValidate = true
    const input = this.#formInput

    const nameInput = textInput(input.name, (value) => (input.name = value))
    nameInput.dataset['field'] = 'name'
    form.appendChild(field(FORM_LABELS.name, nameInput))

    const segment = document.createElement('div')
    segment.className = 'fl-cns-segment'
    segment.setAttribute('role', 'radiogroup')
    segment.setAttribute('aria-label', FORM_LABELS.connectsBy)
    const by: Array<[ConnectsBy, string]> = [
      ['web', FORM_LABELS.web],
      ['program', FORM_LABELS.program],
    ]
    for (const [value, label] of by) {
      const option = document.createElement('button')
      option.type = 'button'
      option.className = 'fl-cns-segment-option'
      option.dataset['value'] = value
      option.setAttribute('role', 'radio')
      option.textContent = label
      option.addEventListener('click', () => {
        input.connectsBy = value
        this.#formProblem = null
        this.#syncForm(form)
      })
      segment.appendChild(option)
    }
    form.appendChild(field(FORM_LABELS.connectsBy, segment))

    const address = textInput(input.address, (value) => (input.address = value))
    address.dataset['field'] = 'address'
    address.inputMode = 'url'
    const addressField = field(FORM_LABELS.address, address)
    addressField.dataset['for'] = 'web'
    form.appendChild(addressField)

    const program = textInput(input.program, (value) => (input.program = value))
    program.dataset['field'] = 'program'
    const programField = field(FORM_LABELS.programField, program)
    programField.dataset['for'] = 'program'
    form.appendChild(programField)

    const args = textInput(input.args, (value) => (input.args = value))
    args.dataset['field'] = 'args'
    const argsField = field(FORM_LABELS.args, args, FORM_LABELS.argsHint)
    argsField.dataset['for'] = 'program'
    form.appendChild(argsField)

    const availability = document.createElement('div')
    availability.className = 'fl-cns-choices'
    availability.setAttribute('role', 'radiogroup')
    availability.setAttribute('aria-label', FORM_LABELS.availableIn)
    for (const value of Object.keys(AVAILABILITY_LABELS) as ConnectorAvailability[]) {
      const label = document.createElement('label')
      label.className = 'fl-cns-choice'
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'fl-cns-available-in'
      radio.value = value
      radio.checked = input.availableIn === value
      radio.addEventListener('change', () => {
        if (radio.checked) input.availableIn = value
      })
      const text = document.createElement('span')
      text.textContent = AVAILABILITY_LABELS[value]
      label.append(radio, text)
      availability.appendChild(label)
    }
    form.appendChild(field(FORM_LABELS.availableIn, availability))

    const problem = document.createElement('div')
    problem.className = 'fl-cns-form-problem'
    problem.setAttribute('role', 'alert')
    form.appendChild(problem)

    const actions = document.createElement('div')
    actions.className = 'fl-cns-form-actions'
    const cancel = button(CANCEL_LABEL, false, () => this.#closeForm())
    cancel.dataset['role'] = 'cancel'
    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.className = 'fl-cns-btn fl-cns-btn--primary'
    submit.dataset['role'] = 'submit'
    actions.append(cancel, submit)
    form.appendChild(actions)

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void this.#submitForm()
    })
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        this.#closeForm()
      }
    })
    this.#form = form
    this.#syncForm(form)
    return form
  }

  #syncForm(form: HTMLElement): void {
    const input = this.#formInput
    for (const option of form.querySelectorAll<HTMLElement>('.fl-cns-segment-option')) {
      const on = option.dataset['value'] === input.connectsBy
      option.classList.toggle('on', on)
      option.setAttribute('aria-checked', on ? 'true' : 'false')
    }
    for (const part of form.querySelectorAll<HTMLElement>('[data-for]')) {
      part.hidden = part.dataset['for'] !== input.connectsBy
    }
    const problem = form.querySelector<HTMLElement>('.fl-cns-form-problem')
    if (problem !== null) {
      problem.textContent = this.#formProblem ?? ''
      problem.hidden = this.#formProblem === null
    }
    const submit = form.querySelector<HTMLButtonElement>('[data-role="submit"]')
    if (submit !== null) {
      submit.textContent = this.#formBusy ? ADDING_LABEL : ADD_LABEL
      submit.disabled = this.#formBusy
    }
    for (const control of form.querySelectorAll<HTMLInputElement>('input')) control.disabled = this.#formBusy
  }

  async #submitForm(): Promise<void> {
    const api = window.flow.connectors
    const root = this.#root()
    if (api === undefined || root === null || this.#formBusy || this.#form === null) return
    const existing = this.#answer?.entries.map((entry: ConnectorEntry) => entry.name) ?? []
    const result = validateAddForm(this.#formInput, existing)
    const form = this.#form
    if (!result.ok) {
      this.#formProblem = result.problem
      this.#syncForm(form)
      form.querySelector<HTMLInputElement>(`[data-field="${result.field}"]`)?.focus()
      return
    }
    this.#formBusy = true
    this.#formProblem = null
    this.#syncForm(form)
    const answer = await api
      .add({ projectRoot: root, scope: result.scope, name: result.name, config: result.config })
      .catch((error: unknown) => ({ ok: false as const, reason: sentenceOf(error) }))
    if (this.#form !== form) return
    this.#formBusy = false
    if (!answer.ok) {
      this.#formProblem = answer.reason
      this.#syncForm(form)
      return
    }
    // A new connector that asks to sign in shows its Sign in action on its row;
    // the row is opened so it is the first thing the person sees.
    this.#openRow = result.name
    this.#closeForm()
    void this.refresh()
  }
}

// ── Small builders ──────────────────────────────────────────────────────────

function emptyForm(): AddFormInput {
  return { name: '', connectsBy: 'web', address: '', program: '', args: '', availableIn: 'account' }
}

function line(text: string, className: string): HTMLElement {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  return el
}

function button(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = primary ? 'fl-cns-btn fl-cns-btn--primary' : 'fl-cns-btn'
  el.textContent = label
  el.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return el
}

function textInput(value: string, onInput: (value: string) => void): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'fl-settings-input'
  input.value = value
  input.spellcheck = false
  input.autocomplete = 'off'
  input.addEventListener('input', () => onInput(input.value))
  return input
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'fl-cns-field'
  const text = document.createElement('div')
  text.className = 'fl-cns-field-label'
  text.textContent = label
  wrap.append(text, control)
  if (control instanceof HTMLInputElement) control.setAttribute('aria-label', label)
  if (hint !== undefined) wrap.appendChild(line(hint, 'fl-cns-quiet'))
  return wrap
}

/** A thrown IPC error as a sentence; main answers refusals as values, so this is rare. */
function sentenceOf(error: unknown): string {
  void error
  return 'That did not work. Try again in a moment.'
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .fl-cns-head { display: flex; align-items: flex-start; gap: var(--fl-space-md); }
    .fl-cns-titles { flex: 1; min-width: 0; }
    .fl-cns-title {
      font-size: var(--fl-text-ui-size);
      font-weight: 600;
      color: var(--fl-color-text);
      margin-bottom: 2px;
    }
    .fl-cns-description { margin-bottom: var(--fl-space-sm); line-height: 1.5; }
    .fl-cns-showing {
      display: flex; align-items: center; gap: var(--fl-space-sm);
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
      margin-bottom: var(--fl-space-md);
    }
    .fl-cns-showing[hidden] { display: none; }
    .fl-cns-picker { flex: 0 1 260px; width: auto; }
    .fl-cns-btn {
      flex: none;
      border: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
      cursor: pointer;
      padding: 3px var(--fl-space-sm);
      border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      white-space: nowrap;
    }
    .fl-cns-btn:hover { border-color: var(--fl-color-focus-ring); }
    .fl-cns-btn[disabled] { opacity: 0.5; cursor: default; }
    .fl-cns-btn[hidden] { display: none; }
    .fl-cns-btn--primary {
      background: var(--fl-color-accent);
      border-color: var(--fl-color-accent);
      color: #fff;
    }
    .fl-cns-btn--danger { color: var(--fl-color-error); }
    .fl-cns-btn--danger-text { color: var(--fl-color-error); background: none; }
    .fl-cns-group { margin-bottom: var(--fl-space-lg); }
    .fl-cns-group-heading { margin-bottom: var(--fl-space-xs); }
    .fl-cns-suggested {
      padding: var(--fl-space-sm) var(--fl-space-md);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      background: var(--fl-color-surface-raised);
    }
    .fl-cns-suggested-head { display: flex; align-items: flex-start; gap: var(--fl-space-md); margin-bottom: var(--fl-space-xs); }
    .fl-cns-suggested-head .fl-cns-group-heading { margin-bottom: 2px; }
    .fl-cns-row--static { cursor: default; }
    .fl-cns-row--static:hover { background: none; }
    .fl-cns-row-wrap { border-top: var(--fl-border-width) solid var(--fl-color-border); }
    .fl-cns-row {
      display: flex; align-items: center; gap: var(--fl-space-sm);
      padding: var(--fl-space-sm) var(--fl-space-xs);
      border-radius: var(--fl-radius-row);
      cursor: pointer;
    }
    .fl-cns-row:hover { background: var(--fl-color-surface-raised); }
    .fl-cns-row:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: -2px; }
    .fl-cns-row-text { flex: 1; min-width: 0; }
    .fl-cns-row-name {
      display: flex; align-items: center; gap: var(--fl-space-xs);
      font-size: var(--fl-text-ui-size); color: var(--fl-color-text);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fl-cns-row-detail {
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .fl-cns-tag {
      flex: none;
      font-size: 10px;
      padding: 0 6px;
      border-radius: var(--fl-radius-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      color: var(--fl-color-text-secondary);
    }
    .fl-cns-pill {
      flex: none;
      display: inline-flex; align-items: center; gap: 5px;
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
      padding: 1px 8px;
      border-radius: 999px;
      border: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-cns-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fl-color-text-secondary); }
    .fl-cns-pill[data-tone="ok"] .fl-cns-dot { background: var(--fl-color-success); }
    .fl-cns-pill[data-tone="warn"] .fl-cns-dot { background: var(--fl-color-warning); }
    .fl-cns-pill[data-tone="error"] .fl-cns-dot { background: var(--fl-color-error); }
    .fl-cns-pill[data-tone="off"] .fl-cns-dot { background: var(--fl-color-border); }
    .fl-cns-pill[data-tone="error"] { color: var(--fl-color-error); }
    .fl-cns-inline {
      display: flex; align-items: center; gap: var(--fl-space-sm);
      margin: 0 0 var(--fl-space-sm) calc(30px + var(--fl-space-sm) + var(--fl-space-xs));
    }
    .fl-cns-inline-text { flex: 1; font-size: var(--fl-text-caption-size); color: var(--fl-color-text); }
    .fl-cns-inline-note {
      margin: 0 0 var(--fl-space-sm) calc(30px + var(--fl-space-sm) + var(--fl-space-xs));
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
    }
    .fl-cns-inline-note--error { color: var(--fl-color-error); }
    .fl-cns-notice {
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
      padding: var(--fl-space-xs) var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      margin-bottom: var(--fl-space-md);
    }
    .fl-cns-details {
      margin: 0 0 var(--fl-space-md) calc(30px + var(--fl-space-sm) + var(--fl-space-xs));
      display: flex; flex-direction: column; gap: var(--fl-space-sm);
    }
    .fl-cns-sub {
      font-size: var(--fl-text-caption-size);
      font-weight: var(--fl-text-ui-weight-medium);
      color: var(--fl-color-text);
    }
    .fl-cns-quiet { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); line-height: 1.5; }
    .fl-cns-tools { display: flex; flex-wrap: wrap; gap: var(--fl-space-xs); }
    .fl-cns-tool {
      display: inline-flex; align-items: center; gap: var(--fl-space-xs);
      padding: 2px 4px 2px 8px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      background: var(--fl-color-surface-raised);
    }
    .fl-cns-tool-name { font-family: var(--fl-font-mono); font-size: var(--fl-text-caption-size); color: var(--fl-color-text); }
    .fl-cns-tool-ask { font-size: 10px; color: var(--fl-color-text-secondary); margin-left: var(--fl-space-xs); }
    .fl-cns-facts {
      margin: 0; padding-left: 1.1em;
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary);
    }
    .fl-cns-facts li { margin-bottom: 2px; }
    .fl-cns-details-actions { display: flex; }
    .fl-cns-form {
      display: flex; flex-direction: column; gap: var(--fl-space-sm);
      padding: var(--fl-space-md);
      margin-bottom: var(--fl-space-lg);
      border: var(--fl-border-width) dashed var(--fl-color-border);
      border-radius: var(--fl-radius-md);
    }
    .fl-cns-field { display: flex; flex-direction: column; gap: 4px; }
    .fl-cns-field[hidden] { display: none; }
    .fl-cns-field-label { font-size: var(--fl-text-caption-size); color: var(--fl-color-text); }
    .fl-cns-segment {
      display: inline-flex; align-self: flex-start;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      overflow: hidden;
    }
    .fl-cns-segment-option {
      border: 0; background: none; cursor: pointer;
      padding: 4px var(--fl-space-sm);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-cns-segment-option + .fl-cns-segment-option { border-left: var(--fl-border-width) solid var(--fl-color-border); }
    .fl-cns-segment-option.on { background: var(--fl-color-surface-selected); color: var(--fl-color-text); }
    .fl-cns-choices { display: flex; flex-direction: column; gap: 4px; }
    .fl-cns-choice {
      display: flex; align-items: center; gap: var(--fl-space-xs);
      font-size: var(--fl-text-caption-size); color: var(--fl-color-text); cursor: pointer;
    }
    .fl-cns-form-problem { font-size: var(--fl-text-caption-size); color: var(--fl-color-error); }
    .fl-cns-form-problem[hidden] { display: none; }
    .fl-cns-form-actions { display: flex; justify-content: flex-end; gap: var(--fl-space-xs); }
  `
  document.head.appendChild(style)
}
