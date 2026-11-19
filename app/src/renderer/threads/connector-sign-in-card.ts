/**
 * Connector sign-in card — inline (never modal) card shown when a session
 * reports that a connector needs sign-in (plan_connectors, Phase 5).
 *
 * Icon (an element the caller builds — the connector's icon or its initial),
 * "<Connector> needs you to sign in", one line of body, and two buttons:
 * "Sign in to <Connector>" and "Skip for this chat". The caller owns the
 * work: `onSignIn` starts the sign-in and says how it went, `onSkip` turns
 * the connector off for the chat. The card only shows the state it is told:
 *
 *   ask      → the two buttons
 *   waiting  → "Finish signing in in your browser"
 *   error    → the sentence, and Retry
 *   done     → a muted resolution line, kept as a record in the transcript
 *
 * Stark: <fl-card> with the accent left border, like the permission card.
 */
import '../components'
import type { ConnectorSignInAnswer } from '../../shared/connectors'

/** What a sign-in attempt came to — the `connectors:signIn` answer. */
export type ConnectorSignInResult = ConnectorSignInAnswer

export interface ConnectorSignInCardOptions {
  /** The connector's display name. */
  connectorName: string
  /** The icon element (the connector's icon, or its initial on a hue square). */
  icon: HTMLElement
  onSignIn: () => Promise<ConnectorSignInResult>
  onSkip: () => Promise<void>
  /** Shown for `finish-in-browser`: the person says they are back. */
  onFinished?: () => Promise<ConnectorSignInResult>
}

type CardState = 'ask' | 'waiting' | 'finish-in-browser' | 'error' | 'done'

export class ConnectorSignInCard {
  readonly element: HTMLElement
  readonly #options: ConnectorSignInCardOptions
  readonly #body: HTMLDivElement
  readonly #actions: HTMLDivElement
  readonly #status: HTMLDivElement
  #state: CardState = 'ask'
  #busy = false

  constructor(options: ConnectorSignInCardOptions) {
    injectConnectorSignInCardStyles()
    this.#options = options

    const card = document.createElement('fl-card')
    card.setAttribute('tone', 'accent')
    card.setAttribute('dense', '')
    card.className = 'fl-connector-signin-card'
    this.element = card

    // ── Header ───────────────────────────────────────────────────────────
    const header = document.createElement('div')
    header.slot = 'header'
    header.className = 'fl-connector-signin-head'
    const iconSlot = document.createElement('span')
    iconSlot.className = 'fl-connector-signin-icon'
    iconSlot.appendChild(options.icon)
    const title = document.createElement('span')
    title.textContent = `${options.connectorName} needs you to sign in`
    header.appendChild(iconSlot)
    header.appendChild(title)
    card.appendChild(header)

    // ── Body ─────────────────────────────────────────────────────────────
    this.#body = document.createElement('div')
    this.#body.className = 'fl-connector-signin-body'
    card.appendChild(this.#body)

    this.#actions = document.createElement('div')
    this.#actions.className = 'fl-connector-signin-actions'
    card.appendChild(this.#actions)

    this.#status = document.createElement('div')
    this.#status.className = 'fl-connector-signin-status'
    this.#status.hidden = true
    card.appendChild(this.#status)

    this.#render('ask')
  }

  get state(): CardState {
    return this.#state
  }

  /** The sign-in finished elsewhere (the connector now reports connected). */
  markConnected(): void {
    this.#render('done', `Signed in to ${this.#options.connectorName}`)
  }

  /** A watched sign-in ended without connecting (timed out, say). */
  markFailed(reason: string): void {
    this.#render('error', reason)
  }

  /** The connector was turned off for this chat from another surface. */
  markSkipped(): void {
    this.#render('done', `${this.#options.connectorName} is off for this chat`)
  }

  #render(state: CardState, message?: string): void {
    this.#state = state
    const name = this.#options.connectorName
    this.#actions.replaceChildren()
    this.#status.hidden = true
    this.#status.classList.remove('fl-connector-signin-status--error')
    this.#body.hidden = false

    switch (state) {
      case 'ask':
        this.#body.textContent = `Sign in so the agent can use ${name} in this chat.`
        this.#actions.appendChild(this.#button(`Sign in to ${name}`, () => this.#signIn(), 'primary'))
        this.#actions.appendChild(this.#button('Skip for this chat', () => this.#skip()))
        break
      case 'waiting':
        this.#body.textContent = 'Finish signing in in your browser.'
        this.#actions.appendChild(this.#button('Skip for this chat', () => this.#skip()))
        break
      case 'finish-in-browser':
        this.#body.textContent = `Finish signing in to ${name} in your browser, then come back here.`
        if (this.#options.onFinished !== undefined) {
          const finished = this.#options.onFinished
          this.#actions.appendChild(this.#button("I've signed in", () => this.#attempt(finished), 'primary'))
        }
        this.#actions.appendChild(this.#button('Skip for this chat', () => this.#skip()))
        break
      case 'error':
        this.#body.hidden = true
        this.#status.hidden = false
        this.#status.classList.add('fl-connector-signin-status--error')
        this.#status.textContent = message ?? `Signing in to ${name} did not finish.`
        this.#actions.appendChild(this.#button('Retry', () => this.#signIn(), 'primary'))
        this.#actions.appendChild(this.#button('Skip for this chat', () => this.#skip()))
        break
      case 'done':
        this.#body.hidden = true
        this.#actions.hidden = true
        this.#status.hidden = false
        this.#status.textContent = message ?? ''
        return
    }
    this.#actions.hidden = false
  }

  #button(label: string, onClick: () => Promise<void>, variant?: string): HTMLElement {
    const button = document.createElement('fl-button')
    button.setAttribute('small', '')
    if (variant) {
      button.setAttribute('variant', variant)
    }
    const text = document.createElement('span')
    text.textContent = label
    button.appendChild(text)
    button.addEventListener('click', () => {
      void onClick()
    })
    return button
  }

  #setBusy(busy: boolean): void {
    this.#busy = busy
    for (const button of this.#actions.querySelectorAll('fl-button')) {
      if (busy) button.setAttribute('disabled', '')
      else button.removeAttribute('disabled')
    }
  }

  #signIn(): Promise<void> {
    return this.#attempt(this.#options.onSignIn)
  }

  async #attempt(run: () => Promise<ConnectorSignInResult>): Promise<void> {
    if (this.#busy || this.#state === 'done') {
      return
    }
    this.#setBusy(true)
    let result: ConnectorSignInResult
    try {
      result = await run()
    } catch (error) {
      console.error('flow: connector sign-in failed', error)
      result = { ok: false, reason: `Signing in to ${this.#options.connectorName} could not be started. Try again.` }
    }
    this.#busy = false
    // Marked done elsewhere (connected, or skipped) while the call ran.
    if (this.state === 'done') {
      return
    }
    if (!result.ok) {
      this.#render('error', result.reason)
      return
    }
    if (result.state === 'connected') {
      this.markConnected()
      return
    }
    this.#render(result.state)
  }

  async #skip(): Promise<void> {
    if (this.#busy || this.#state === 'done') {
      return
    }
    this.#setBusy(true)
    try {
      await this.#options.onSkip()
      this.#busy = false
      this.markSkipped()
    } catch (error) {
      console.error('flow: skipping a connector failed', error)
      this.#setBusy(false)
      this.#status.hidden = false
      this.#status.classList.add('fl-connector-signin-status--error')
      this.#status.textContent = `${this.#options.connectorName} could not be turned off for this chat. Try again.`
    }
  }
}

// ── Styles (light DOM) ─────────────────────────────────────────────────────

let connectorSignInCardStylesInjected = false

function injectConnectorSignInCardStyles(): void {
  if (connectorSignInCardStylesInjected) {
    return
  }
  connectorSignInCardStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-connector-signin-head {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      font-size: var(--fl-text-ui-size);
    }
    .fl-connector-signin-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: none;
    }
    .fl-connector-signin-body {
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text);
    }
    .fl-connector-signin-actions {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      margin-top: var(--fl-space-md);
    }
    .fl-connector-signin-status {
      margin-top: var(--fl-space-sm);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .fl-connector-signin-status--error {
      color: var(--fl-color-error);
      font-size: var(--fl-text-ui-size);
    }
  `
  document.head.appendChild(style)
}
