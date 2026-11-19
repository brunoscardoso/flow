/**
 * The connector icon (plan_connectors, FR-5): the connector's own image in a
 * rounded square at 16, 22 or 30px, or its initial on a hue ground while no
 * image is known. One element everywhere a connector appears.
 *
 * Images cross IPC as `data:` URIs (the renderer CSP is `img-src 'self'
 * data:`), so the loader is INJECTED: this module never reaches for the
 * preload itself. The coordinator sets the app-wide loader and display names
 * once (`setConnectorIconLoader`, `setConnectorDisplayNames`); until then a
 * connector shows its initial and the name read from its tool name.
 */
import { slotPaint } from '../project-accent'
import { connectorHueSlot, connectorInitial, toolNameForm, type ConnectorLabelOptions } from './connector-label'

export type ConnectorIconSize = 16 | 22 | 30

/** Resolves a connector's icon as a `data:` image, or null for none. */
export type ConnectorIconLoader = (name: string) => Promise<string | null>

export interface ConnectorIconOptions {
  /** The connector's name — what the loader is asked for, and the hue's key
   *  (hashed in its tool-name form, so `claude.ai Linear` and
   *  `claude_ai_Linear` share a colour). */
  name: string
  displayName: string
  size: ConnectorIconSize
  load?: ConnectorIconLoader
}

let appLoader: ConnectorIconLoader | null = null
let appDisplayNames: ReadonlyMap<string, string> | undefined

/** Set the app-wide icon loader. Null = initials only. */
export function setConnectorIconLoader(load: ConnectorIconLoader | null): void {
  appLoader = load
}

/** The app-wide icon loader, or undefined when none is set. */
export function connectorIconLoader(): ConnectorIconLoader | undefined {
  return appLoader ?? undefined
}

/** Set the connector list's display names (keyed by configured name). */
export function setConnectorDisplayNames(names: ReadonlyMap<string, string> | undefined): void {
  appDisplayNames = names
}

/** The options every chat surface passes to the label function. */
export function connectorLabelOptions(): ConnectorLabelOptions {
  return appDisplayNames === undefined ? {} : { displayNames: appDisplayNames }
}

/**
 * A connector icon element. The initial is drawn at once; a loaded image
 * replaces it when the loader answers one. A loader that fails or answers
 * nothing leaves the initial in place.
 */
export function createConnectorIcon(options: ConnectorIconOptions): HTMLElement {
  injectConnectorIconStyles()
  const box = document.createElement('span')
  box.className = 'fl-connector-icon'
  box.dataset['size'] = String(options.size)
  box.setAttribute('aria-hidden', 'true')
  box.style.setProperty('--fl-connector-icon-ground', slotPaint(connectorHueSlot(toolNameForm(options.name))))
  box.textContent = connectorInitial(options.displayName)

  const load = options.load
  if (load !== undefined) {
    load(options.name)
      .then((src) => {
        if (src === null || !src.startsWith('data:image/')) return
        const img = document.createElement('img')
        img.alt = ''
        img.src = src
        img.draggable = false
        box.textContent = ''
        box.classList.add('has-image')
        box.appendChild(img)
      })
      .catch(() => {
        // The initial stays: an icon is never load-bearing.
      })
  }
  return box
}

let connectorIconStylesInjected = false

function injectConnectorIconStyles(): void {
  if (connectorIconStylesInjected) return
  connectorIconStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-connector-icon {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      overflow: hidden;
      background: var(--fl-connector-icon-ground, var(--fl-color-surface-selected));
      color: var(--fl-color-bg);
      font-family: var(--fl-font-ui);
      font-size: 12px;
      font-weight: var(--fl-text-ui-weight-medium);
      line-height: 1;
      user-select: none;
    }
    .fl-connector-icon[data-size='16'] { width: 16px; height: 16px; border-radius: 4px; font-size: 10px; }
    .fl-connector-icon[data-size='30'] { width: 30px; height: 30px; font-size: 15px; }
    .fl-connector-icon.has-image { background: var(--fl-color-surface-raised); }
    .fl-connector-icon img { width: 100%; height: 100%; object-fit: contain; display: block; }
  `
  document.head.appendChild(style)
}
