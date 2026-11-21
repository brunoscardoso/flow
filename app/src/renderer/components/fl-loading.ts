/**
 * <fl-loading> — Flow's loading mark: the app icon's slash and two chevrons,
 * with a wave of light running through them left to right. Drawn in the text
 * colour, so it fits both themes.
 *
 * Two uses:
 *   - `size="large"`: centred on a surface that has nothing to show yet (a
 *     page loading, a conversation opening). The label sits under the mark.
 *   - default (small): beside a line of text inside a panel. The label sits
 *     to its right.
 *
 * Attributes:
 *   size:  "large" | "small" (default small)
 *   label: the text beside the mark; also its accessible name
 *
 * The mark takes the host's `color` (the text colour by default, the accent
 * where a caller sets it) and its width from `--fl-loading-size`.
 *
 * `workingMark()` is the bare mark, for a spot that already says what is
 * happening in its own words (a running tool, the chat's "Working…").
 *
 * Buttons that wait keep their spinner (button-wait.ts): a button keeps its
 * size, and this mark is wider than a ring.
 */
const MARK_SVG = `<svg class="mark" viewBox="20 28 56 44" aria-hidden="true">
  <path class="p0" d="M26 66 L37 34"/>
  <path class="p1" d="M48 37 L58 50 L48 63"/>
  <path class="p2" d="M60 37 L70 50 L60 63"/>
</svg>`

export class FlLoading extends HTMLElement {
  static observedAttributes = ['label']

  #label: HTMLSpanElement

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      :host {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--fl-color-text);
        font-family: var(--fl-font-ui);
        font-size: var(--fl-text-ui-size);
      }
      :host([size='large']) {
        flex-direction: column;
        gap: 12px;
        text-align: center;
      }
      .mark { display: block; flex: none; width: var(--fl-loading-size, 16px); aspect-ratio: 56 / 44; overflow: visible; }
      :host([size='large']) .mark { width: var(--fl-loading-size, 44px); }
      path {
        fill: none;
        stroke: currentColor;
        stroke-width: 8;
        stroke-linecap: round;
        stroke-linejoin: round;
        opacity: 0.25;
        animation: fl-loading-wave 1.2s ease-in-out infinite;
      }
      .p0 { animation-delay: -0.2s; }
      .p2 { animation-delay: 0.2s; }
      @keyframes fl-loading-wave { 0%, 100% { opacity: 0.25 } 40% { opacity: 1 } }
      @media (prefers-reduced-motion: reduce) {
        path { animation: fl-loading-breathe 2.4s ease-in-out infinite; }
        .p0, .p2 { animation-delay: 0s; }
        @keyframes fl-loading-breathe { 0%, 100% { opacity: 0.45 } 50% { opacity: 1 } }
      }
      .label:empty { display: none; }
      .label { color: var(--fl-color-text-secondary); }
      :host([size='large']) .label { color: var(--fl-color-text); }
    `
    const holder = document.createElement('template')
    holder.innerHTML = MARK_SVG
    this.#label = document.createElement('span')
    this.#label.className = 'label'
    root.append(style, holder.content, this.#label)
  }

  attributeChangedCallback(): void {
    this.#label.textContent = this.getAttribute('label') ?? ''
    if (this.isConnected) this.#applyRole()
  }

  // Attributes are set here, never in the constructor: an element made with
  // createElement may not carry attributes before it is returned.
  connectedCallback(): void {
    this.#applyRole()
  }

  #applyRole(): void {
    if (this.hasAttribute('decorative')) {
      this.setAttribute('aria-hidden', 'true')
      return
    }
    this.setAttribute('role', 'status')
    if ((this.getAttribute('label') ?? '') === '') this.setAttribute('aria-label', 'Loading')
    else this.removeAttribute('aria-label')
  }
}

/** A loading mark with a label, ready to append. */
export function loadingMark(label: string, size: 'large' | 'small' = 'small'): FlLoading {
  const mark = document.createElement('fl-loading')
  if (size === 'large') mark.setAttribute('size', 'large')
  mark.setAttribute('label', label)
  return mark
}

/** The bare mark, `px` wide, hidden from assistive tech: the words beside it
 *  already say what is happening. */
export function workingMark(px = 16): FlLoading {
  const mark = document.createElement('fl-loading')
  mark.setAttribute('decorative', '')
  mark.style.setProperty('--fl-loading-size', `${String(px)}px`)
  mark.style.flex = 'none'
  return mark
}

customElements.define('fl-loading', FlLoading)

declare global {
  interface HTMLElementTagNameMap {
    'fl-loading': FlLoading
  }
}
