/**
 * Permission card — inline (never modal) card for `threads:permissionRequest`
 * events: tool name, summary, sanitized input preview, and the three verdict
 * buttons (Allow once / Always allow / Deny → threads:respondPermission).
 *
 * Stark: <fl-card> with the accent left border (tone="accent"). After a
 * verdict the buttons collapse into a muted resolution line so the card stays
 * in the transcript as a record of what was decided.
 */
import '../components'
import type { PermissionRequest, PermissionVerdict } from '../../shared/ipc-contract'

export type RespondPermissionFn = (
  requestId: string,
  verdict: PermissionVerdict,
) => Promise<void>

const VERDICT_LABELS: Record<PermissionVerdict, string> = {
  'allow-once': 'Allowed once',
  'allow-always': 'Always allowed',
  deny: 'Denied',
}

export class PermissionCard {
  readonly element: HTMLElement
  readonly request: PermissionRequest
  #actions: HTMLDivElement
  #resolution: HTMLDivElement
  #respond: RespondPermissionFn
  #resolved = false

  constructor(request: PermissionRequest, respond: RespondPermissionFn) {
    injectPermissionCardStyles()
    this.request = request
    this.#respond = respond

    const card = document.createElement('fl-card')
    card.setAttribute('tone', 'accent')
    card.setAttribute('dense', '')
    card.className = 'fl-permission-card'
    this.element = card

    // ── Header ───────────────────────────────────────────────────────────
    const header = document.createElement('div')
    header.slot = 'header'
    header.className = 'fl-permission-head'
    const icon = document.createElement('fl-icon')
    icon.setAttribute('name', 'warning')
    icon.setAttribute('size', '14')
    icon.style.color = 'var(--fl-color-accent)'
    const title = document.createElement('span')
    title.textContent = `${request.toolName} — permission required`
    header.appendChild(icon)
    header.appendChild(title)
    card.appendChild(header)

    // ── Body ─────────────────────────────────────────────────────────────
    const summary = document.createElement('div')
    summary.className = 'fl-permission-summary'
    summary.textContent = request.summary
    card.appendChild(summary)

    if (request.inputPreview) {
      const preview = document.createElement('pre')
      preview.className = 'fl-permission-preview'
      preview.textContent = request.inputPreview
      card.appendChild(preview)
    }

    this.#actions = document.createElement('div')
    this.#actions.className = 'fl-permission-actions'
    this.#actions.appendChild(this.#button('Allow once', 'allow-once', 'primary'))
    this.#actions.appendChild(this.#button('Always allow', 'allow-always'))
    this.#actions.appendChild(this.#button('Deny', 'deny', undefined, true))
    card.appendChild(this.#actions)

    this.#resolution = document.createElement('div')
    this.#resolution.className = 'fl-permission-resolution'
    this.#resolution.hidden = true
    card.appendChild(this.#resolution)
  }

  get resolved(): boolean {
    return this.#resolved
  }

  /** Mark resolved without responding (e.g. resolved from another surface). */
  markResolved(verdict: PermissionVerdict): void {
    this.#showResolution(VERDICT_LABELS[verdict])
  }

  #button(
    label: string,
    verdict: PermissionVerdict,
    variant?: string,
    danger = false,
  ): HTMLElement {
    const button = document.createElement('fl-button')
    button.setAttribute('small', '')
    if (variant) {
      button.setAttribute('variant', variant)
    }
    if (danger) {
      button.style.color = 'var(--fl-color-error)'
    }
    const text = document.createElement('span')
    text.textContent = label
    button.appendChild(text)
    button.addEventListener('click', () => {
      void this.#resolve(verdict)
    })
    return button
  }

  async #resolve(verdict: PermissionVerdict): Promise<void> {
    if (this.#resolved) {
      return
    }
    this.#resolved = true
    for (const button of this.#actions.querySelectorAll('fl-button')) {
      button.setAttribute('disabled', '')
    }
    try {
      await this.#respond(this.request.requestId, verdict)
      this.#showResolution(VERDICT_LABELS[verdict])
    } catch (error) {
      console.error('flow: failed to respond to permission request', error)
      this.#resolved = false
      for (const button of this.#actions.querySelectorAll('fl-button')) {
        button.removeAttribute('disabled')
      }
      // Render the failure inline WITHOUT #showResolution — that would set
      // #resolved=true and make the retry buttons dead.
      this.#resolution.hidden = false
      this.#resolution.textContent = 'Failed to send verdict — try again'
      this.#resolution.style.color = 'var(--fl-color-error)'
      this.#actions.hidden = false
      return
    }
  }

  #showResolution(text: string): void {
    this.#resolved = true
    this.#actions.hidden = true
    this.#resolution.hidden = false
    this.#resolution.style.color = ''
    this.#resolution.textContent = text
  }
}

// ── Styles (light DOM) ─────────────────────────────────────────────────────

let permissionCardStylesInjected = false

function injectPermissionCardStyles(): void {
  if (permissionCardStylesInjected) {
    return
  }
  permissionCardStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-permission-head {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      font-size: var(--fl-text-ui-size);
    }
    .fl-permission-summary {
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text);
    }
    .fl-permission-preview {
      margin: var(--fl-space-sm) 0 0;
      padding: var(--fl-space-sm);
      max-height: 160px;
      overflow: auto;
      background: var(--fl-color-bg);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-mono-size);
      line-height: var(--fl-line-height-dense);
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--fl-color-text-secondary);
    }
    .fl-permission-actions {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      margin-top: var(--fl-space-md);
    }
    .fl-permission-resolution {
      margin-top: var(--fl-space-sm);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
  `
  document.head.appendChild(style)
}
