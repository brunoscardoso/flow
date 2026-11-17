/**
 * The editor's breadcrumb — the path of the open file, under the tabs
 * (polish, 2026-11-17: "src › components › CoworkerPanel.tsx").
 *
 * `breadcrumbParts` (breadcrumb-model.ts) is the pure half; `Breadcrumb`
 * paints it. A view tab, a scratch note or no tab hides the row, so it never
 * shows a path for something that has none.
 */

import { breadcrumbParts } from './breadcrumb-model'

export { breadcrumbParts }

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-breadcrumb {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: none;
      height: 24px;
      padding: 0 var(--fl-space-md);
      overflow: hidden;
      white-space: nowrap;
      font-size: 12px;
      color: var(--fl-color-text-secondary);
      background: var(--fl-color-surface);
      user-select: none;
    }
    .fl-breadcrumb[hidden] { display: none; }
    .fl-breadcrumb-sep { flex: none; opacity: 0.7; }
    .fl-breadcrumb-folder { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .fl-breadcrumb-mark { flex: none; font-size: 8.5px; font-weight: 700; letter-spacing: -0.02em; }
    .fl-breadcrumb-name { flex: none; color: var(--fl-color-text); }
  `
  document.head.appendChild(style)
}

export class Breadcrumb {
  readonly element: HTMLElement
  #shown: string | null | undefined

  constructor() {
    injectStyles()
    this.element = document.createElement('div')
    this.element.className = 'fl-breadcrumb'
    this.element.setAttribute('aria-label', 'File path')
    this.element.hidden = true
  }

  /** Show the path of the open file, or hide the row when there is none. */
  update(relPath: string | null): void {
    if (relPath === this.#shown) return
    this.#shown = relPath
    const parts = breadcrumbParts(relPath)
    if (parts === null) {
      this.element.hidden = true
      this.element.replaceChildren()
      return
    }
    const nodes: Node[] = []
    for (const folder of parts.folders) {
      const span = document.createElement('span')
      span.className = 'fl-breadcrumb-folder'
      span.textContent = folder
      nodes.push(span, separator())
    }
    if (parts.badge !== null) {
      const mark = document.createElement('span')
      mark.className = 'fl-breadcrumb-mark'
      mark.textContent = parts.badge
      mark.style.color = parts.color
      nodes.push(mark)
    }
    const name = document.createElement('span')
    name.className = 'fl-breadcrumb-name'
    name.textContent = parts.name
    nodes.push(name)
    this.element.replaceChildren(...nodes)
    this.element.hidden = false
  }
}

function separator(): HTMLElement {
  const icon = document.createElement('fl-icon')
  icon.className = 'fl-breadcrumb-sep'
  icon.setAttribute('name', 'chevron-right')
  icon.setAttribute('size', '10')
  icon.setAttribute('aria-hidden', 'true')
  return icon
}
