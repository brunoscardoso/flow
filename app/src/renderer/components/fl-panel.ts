/**
 * <fl-panel> — titled dock panel: header bar (label + actions slot) over a
 * scrollable body. The workhorse container for sidebar/editor/terminal areas.
 *
 * Attributes:
 *   label:       header title text
 *   collapsible: shows a chevron; clicking the header toggles `collapsed`
 *   collapsed:   body hidden (reflected; drives layout persistence)
 *   chromeless:  no header bar at all (pure scroll container)
 *
 * Slots: default (body) · "actions" (right-aligned header controls)
 * Events: "fl-panel-toggle" { collapsed: boolean }
 */
export interface PanelToggleDetail {
  collapsed: boolean
}

export class FlPanel extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['label', 'collapsed', 'collapsible', 'chromeless']
  }

  #header: HTMLDivElement
  #title: HTMLSpanElement
  #chevron: HTMLElement

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      :host {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        background: var(--fl-color-surface);
        overflow: hidden;
      }
      :host([tone='chrome']) { background: var(--fl-color-bg); }
      .header {
        display: flex;
        align-items: center;
        gap: var(--fl-space-xs);
        flex: none;
        height: var(--fl-tab-height);
        padding: 0 var(--fl-space-sm);
        border-bottom: var(--fl-border-width) solid var(--fl-color-border);
        color: var(--fl-color-text-secondary);
        font-size: var(--fl-text-caption-size);
        font-weight: var(--fl-text-ui-weight-medium);
        letter-spacing: 0.06em;
        text-transform: uppercase;
        user-select: none;
      }
      :host([collapsible]) .header { cursor: pointer; }
      :host([collapsible]) .header:hover { color: var(--fl-color-text); }
      :host([chromeless]) .header { display: none; }
      .chevron {
        display: none;
        color: inherit;
        transition: transform var(--fl-transition-fast);
      }
      :host([collapsible]) .chevron { display: inline-flex; }
      :host([collapsed]) .chevron { transform: rotate(-90deg); }
      .title {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .actions { display: inline-flex; align-items: center; gap: var(--fl-space-xs); }
      .body {
        flex: 1;
        min-height: 0;
        overflow: auto;
      }
      :host([collapsed]) .body { display: none; }
      :host([collapsed]) { flex: none !important; }
    `

    this.#chevron = document.createElement('fl-icon')
    this.#chevron.setAttribute('name', 'chevron-down')
    this.#chevron.setAttribute('size', '12')
    this.#chevron.className = 'chevron'

    this.#title = document.createElement('span')
    this.#title.className = 'title'

    const actions = document.createElement('span')
    actions.className = 'actions'
    const actionsSlot = document.createElement('slot')
    actionsSlot.name = 'actions'
    actions.appendChild(actionsSlot)
    // Clicks on header actions must not toggle collapse.
    actions.addEventListener('click', (event) => event.stopPropagation())

    this.#header = document.createElement('div')
    this.#header.className = 'header'
    this.#header.appendChild(this.#chevron)
    this.#header.appendChild(this.#title)
    this.#header.appendChild(actions)
    this.#header.addEventListener('click', () => {
      if (this.hasAttribute('collapsible')) {
        this.collapsed = !this.collapsed
      }
    })

    const body = document.createElement('div')
    body.className = 'body'
    body.appendChild(document.createElement('slot'))

    root.appendChild(style)
    root.appendChild(this.#header)
    root.appendChild(body)
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === 'label') {
      this.#title.textContent = newValue ?? ''
    }
    if (name === 'collapsed' && oldValue !== newValue) {
      this.dispatchEvent(
        new CustomEvent<PanelToggleDetail>('fl-panel-toggle', {
          detail: { collapsed: this.collapsed },
          bubbles: true,
          composed: true,
        }),
      )
    }
  }

  get collapsed(): boolean {
    return this.hasAttribute('collapsed')
  }

  set collapsed(value: boolean) {
    this.toggleAttribute('collapsed', value)
  }
}

customElements.define('fl-panel', FlPanel)

declare global {
  interface HTMLElementTagNameMap {
    'fl-panel': FlPanel
  }
}
