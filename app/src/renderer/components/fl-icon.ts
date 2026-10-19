/**
 * <fl-icon> — inline SVG icon.
 *
 * Stark style: 16x16 viewBox, stroke-based, currentColor. Icons inherit
 * text color from their context; set `color` on a parent to tint.
 *
 * Usage: <fl-icon name="chevron-right"></fl-icon>
 */

import { ICON_FILL_PATHS, ICON_PATHS } from './icon-paths'

export { ICON_FILL_PATHS, ICON_PATHS }
export type { IconName } from './icon-paths'

const SVG_NS = 'http://www.w3.org/2000/svg'

export class FlIcon extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['name', 'size', 'spin']
  }

  #root: ShadowRoot

  constructor() {
    super()
    this.#root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--fl-icon-size, 16px);
        height: var(--fl-icon-size, 16px);
        flex: none;
        color: inherit;
      }
      svg { width: 100%; height: 100%; display: block; }
      :host([spin]) svg { animation: fl-icon-spin 0.9s linear infinite; }
      @keyframes fl-icon-spin { to { transform: rotate(360deg); } }
      /* Reduced motion: the icon must still READ as busy, so rotation
         downgrades to an opacity pulse rather than stopping (the git panel's
         documented rule — removing it entirely reads as stalled). */
      @media (prefers-reduced-motion: reduce) {
        :host([spin]) svg { animation: fl-icon-pulse 1.2s ease-in-out infinite; }
      }
      @keyframes fl-icon-pulse { 50% { opacity: 0.25; } }
    `
    this.#root.appendChild(style)
  }

  connectedCallback(): void {
    this.#render()
  }

  attributeChangedCallback(): void {
    this.#render()
  }

  #render(): void {
    const name = this.getAttribute('name') ?? ''
    const path = (ICON_PATHS as Record<string, string>)[name]
    const size = this.getAttribute('size')
    if (size) {
      this.style.setProperty('--fl-icon-size', `${parseInt(size, 10)}px`)
    }

    const existing = this.#root.querySelector('svg')
    if (existing) {
      existing.remove()
    }
    if (!path) {
      return
    }

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('aria-hidden', 'true')
    const pathEl = document.createElementNS(SVG_NS, 'path')
    pathEl.setAttribute('d', path)
    pathEl.setAttribute('stroke', 'currentColor')
    pathEl.setAttribute('stroke-width', '1.2')
    pathEl.setAttribute('stroke-linecap', 'round')
    pathEl.setAttribute('stroke-linejoin', 'round')
    svg.appendChild(pathEl)
    // A solid sub-mark, for the few glyphs that are filled by definition.
    const filled = ICON_FILL_PATHS[name as keyof typeof ICON_PATHS]
    if (filled !== undefined) {
      const fillEl = document.createElementNS(SVG_NS, 'path')
      fillEl.setAttribute('d', filled)
      fillEl.setAttribute('fill', 'currentColor')
      fillEl.setAttribute('stroke', 'none')
      svg.appendChild(fillEl)
    }
    this.#root.appendChild(svg)
  }
}

customElements.define('fl-icon', FlIcon)

declare global {
  interface HTMLElementTagNameMap {
    'fl-icon': FlIcon
  }
}
