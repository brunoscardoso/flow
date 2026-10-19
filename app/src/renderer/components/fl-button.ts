/**
 * <fl-button> — Stark button.
 *
 * Variants (attribute `variant`):
 *   - "default": Surface Raised background, 1px border
 *   - "primary": accent-tinted, for the single most important action
 *   - "ghost":   borderless, icon/toolbar buttons; hover = Surface Raised
 *
 * Attributes: variant, disabled, small (compact 22px height for toolbars),
 * pressed (a toggle that is on — accent-tinted; set aria-pressed alongside),
 * icon (square: width tracks height, so a lone glyph is centred rather than
 * letterboxed in the horizontal padding a text label needs).
 * Emits regular `click` events (suppressed when disabled).
 */
export class FlButton extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['disabled']
  }

  #button: HTMLButtonElement

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open', delegatesFocus: true })
    const style = document.createElement('style')
    style.textContent = `
      :host { display: inline-flex; }
      button {
        display: inline-flex;
        align-items: center;
        gap: var(--fl-space-xs);
        height: 26px;
        padding: 0 var(--fl-space-sm);
        border: var(--fl-border-width) solid var(--fl-color-border);
        border-radius: var(--fl-radius-sm);
        background: var(--fl-color-surface-raised);
        color: var(--fl-color-text);
        font-family: var(--fl-font-ui);
        font-size: var(--fl-text-ui-size);
        font-weight: var(--fl-text-ui-weight-medium);
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
        transition: background-color var(--fl-transition-fast),
          border-color var(--fl-transition-fast);
      }
      button:hover { border-color: var(--fl-color-text-secondary); }
      button:active { background: var(--fl-color-surface); }
      button:disabled {
        opacity: 0.45;
        cursor: default;
        pointer-events: none;
      }
      :host([variant='primary']) button {
        background: var(--fl-color-accent-muted);
        border-color: var(--fl-color-accent);
        color: var(--fl-color-accent);
      }
      :host([variant='primary']) button:hover {
        background: var(--fl-color-accent);
        color: var(--fl-color-bg);
      }
      :host([variant='ghost']) button {
        background: transparent;
        border-color: transparent;
        color: var(--fl-color-text-secondary);
        padding: 0 var(--fl-space-xs);
      }
      :host([variant='ghost']) button:hover {
        background: var(--fl-color-surface-raised);
        color: var(--fl-color-text);
      }
      :host([small]) button { height: 22px; font-size: var(--fl-text-caption-size); }
      /* A TOGGLE THAT IS ON — the same ground a hover gives, kept, and the
         accent ink, so on and off read apart at a glance (the pressed attribute). */
      :host([pressed]) button {
        background: var(--fl-color-accent-muted);
        border-color: transparent;
        color: var(--fl-color-accent);
      }
      :host([pressed]) button:hover { color: var(--fl-color-accent); }
      /* A button holding one icon and no label. Its padding is sized for text
         it does not have, so the glyph sits in a wide short box that reads as
         a stray mark next to any full-height control beside it. Square it, and
         the hit area matches what the eye sees. */
      :host([icon]) button {
        width: 26px;
        padding: 0;
        justify-content: center;
      }
      :host([icon][small]) button { width: 22px; }
    `
    this.#button = document.createElement('button')
    this.#button.type = 'button'
    const slot = document.createElement('slot')
    this.#button.appendChild(slot)
    root.appendChild(style)
    root.appendChild(this.#button)
  }

  connectedCallback(): void {
    this.#syncDisabled()
  }

  attributeChangedCallback(): void {
    this.#syncDisabled()
  }

  get disabled(): boolean {
    return this.hasAttribute('disabled')
  }

  set disabled(value: boolean) {
    this.toggleAttribute('disabled', value)
  }

  #syncDisabled(): void {
    this.#button.disabled = this.hasAttribute('disabled')
  }
}

customElements.define('fl-button', FlButton)

declare global {
  interface HTMLElementTagNameMap {
    'fl-button': FlButton
  }
}
