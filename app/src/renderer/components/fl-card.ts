/**
 * <fl-card> — Stark card: 1px border, no shadow, Surface Raised background.
 *
 * Used for tool-call cards, permission cards, notifications. Optional header
 * via the "header" slot; default slot is the body.
 *
 * Attributes:
 *   tone: "accent" | "success" | "error" | "warning" — colors the left edge
 *   flat: render on Surface instead of Surface Raised
 */
export class FlCard extends HTMLElement {
  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      :host {
        display: block;
        background: var(--fl-color-surface-raised);
        border: var(--fl-border-width) solid var(--fl-color-border);
        border-radius: var(--fl-radius-md);
        overflow: hidden;
      }
      :host([flat]) { background: var(--fl-color-surface); }
      :host([tone='accent'])  { border-left: 2px solid var(--fl-color-accent); }
      :host([tone='success']) { border-left: 2px solid var(--fl-color-success); }
      :host([tone='error'])   { border-left: 2px solid var(--fl-color-error); }
      :host([tone='warning']) { border-left: 2px solid var(--fl-color-warning); }
      .header {
        display: flex;
        align-items: center;
        gap: var(--fl-space-sm);
        padding: var(--fl-space-sm) var(--fl-space-md);
        border-bottom: var(--fl-border-width) solid var(--fl-color-border);
        color: var(--fl-color-text);
        font-weight: var(--fl-text-ui-weight-medium);
      }
      .header.empty { display: none; }
      .body { padding: var(--fl-space-md); }
      :host([dense]) .body { padding: var(--fl-space-sm) var(--fl-space-md); }
    `

    const header = document.createElement('div')
    header.className = 'header empty'
    const headerSlot = document.createElement('slot')
    headerSlot.name = 'header'
    headerSlot.addEventListener('slotchange', () => {
      header.classList.toggle('empty', headerSlot.assignedNodes().length === 0)
    })
    header.appendChild(headerSlot)

    const body = document.createElement('div')
    body.className = 'body'
    body.appendChild(document.createElement('slot'))

    root.appendChild(style)
    root.appendChild(header)
    root.appendChild(body)
  }
}

customElements.define('fl-card', FlCard)

declare global {
  interface HTMLElementTagNameMap {
    'fl-card': FlCard
  }
}
