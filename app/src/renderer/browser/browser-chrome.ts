/**
 * Browser toolbar (chrome) for the embedded browser tab.
 *
 * A single row above the <webview>: back / forward / reload, an editable URL
 * bar (Enter navigates), and an inspect toggle that (from Phase 4) will drive
 * element-tag mode — for now it just calls `browser.setInspect`.
 *
 * Styling reuses Flow's existing pieces, not a new visual language: `fl-button`
 * (ghost/icon toolbar buttons, allowed by fl-button.ts) and `fl-icon` for the
 * glyphs, and the row itself is laid out with the same inline design-token idiom
 * (`var(--fl-…)`) the editor's note-save bar and preview chrome use. It owns no
 * navigation logic — it reports intent through callbacks and reflects state
 * through its setters, exactly like the editor tab strip.
 */
import '../components'
import type { FlButton } from '../components'

export interface BrowserChromeCallbacks {
  onBack(): void
  onForward(): void
  onReload(): void
  /** Enter pressed in the URL bar with a non-empty, normalized URL. */
  onNavigate(url: string): void
  /** Inspect toggle flipped — `on` is the new state. */
  onToggleInspect(on: boolean): void
}

/**
 * Normalize what a user types in the URL bar into a loadable URL. A value that
 * already carries a scheme is kept; a bare `localhost:3000` / `127.0.0.1` /
 * path-only host becomes `http://…` (dev servers are plain http), everything
 * else `https://…`. Empty input returns null (nothing to navigate to).
 */
export function normalizeUrlInput(raw: string): string | null {
  const value = raw.trim()
  if (value === '') return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  const looksLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(value)
  return `${looksLocal ? 'http' : 'https'}://${value}`
}

export class BrowserChrome {
  readonly element: HTMLElement
  #urlInput: HTMLInputElement
  #backBtn: FlButton
  #forwardBtn: FlButton
  #inspectBtn: FlButton
  #inspectOn = false
  #debugBtn: FlButton
  #debugLabel: HTMLSpanElement
  #onDebugState: (event: Event) => void

  constructor(callbacks: BrowserChromeCallbacks) {
    const bar = document.createElement('div')
    bar.className = 'fl-browser-chrome'
    bar.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:var(--fl-space-xs)',
      'padding:var(--fl-space-xs) var(--fl-space-sm)',
      'border-bottom:var(--fl-border-width) solid var(--fl-color-border)',
      'background:var(--fl-color-surface)',
      'flex:none',
    ].join(';')

    this.#backBtn = iconButton('chevron-right', 'Back')
    // The back glyph is the forward chevron mirrored — one icon, both directions.
    this.#backBtn.style.transform = 'scaleX(-1)'
    this.#backBtn.addEventListener('click', () => callbacks.onBack())

    this.#forwardBtn = iconButton('chevron-right', 'Forward')
    this.#forwardBtn.addEventListener('click', () => callbacks.onForward())

    const reloadBtn = iconButton('refresh', 'Reload')
    reloadBtn.addEventListener('click', () => callbacks.onReload())

    this.#urlInput = document.createElement('input')
    this.#urlInput.type = 'text'
    this.#urlInput.spellcheck = false
    this.#urlInput.setAttribute('aria-label', 'Address')
    this.#urlInput.placeholder = 'Enter a URL'
    this.#urlInput.style.cssText = [
      'flex:1',
      'min-width:0',
      'height:22px',
      'padding:0 var(--fl-space-sm)',
      'background:var(--fl-color-surface-raised)',
      'color:var(--fl-color-text)',
      'border:var(--fl-border-width) solid var(--fl-color-border)',
      'border-radius:var(--fl-radius-sm)',
      'font-family:var(--fl-font-mono, monospace)',
      'font-size:var(--fl-text-ui-size)',
    ].join(';')
    this.#urlInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      const url = normalizeUrlInput(this.#urlInput.value)
      if (url !== null) callbacks.onNavigate(url)
    })

    this.#inspectBtn = iconButton('inspect', 'Inspect element')
    this.#inspectBtn.addEventListener('click', () => {
      this.setInspect(!this.#inspectOn)
      callbacks.onToggleInspect(this.#inspectOn)
    })

    /*
     * DEBUG, BESIDE INSPECT.
     *
     * It records the terminals as well as this page, so it is not a browser
     * feature — but it is where a person is STANDING when they decide to record
     * something, which is what decides where a control goes. The session itself
     * is owned by a runner in the shell (`debug-session-runner.ts`); this button
     * only asks and redraws, so it can be destroyed with its tab while a session
     * carries on.
     *
     * Reachable off this tab through the command palette, because the tab you
     * are on should not decide whether you can start recording.
     */
    this.#debugBtn = iconButton('record', 'Capture a debug session')
    this.#debugBtn.classList.add('fl-debug-btn')
    // The word only appears while recording — see #setRecording. Idle, this is
    // an icon button like Inspect beside it.
    this.#debugLabel = document.createElement('span')
    this.#debugLabel.className = 'fl-debug-label'
    this.#debugLabel.hidden = true
    this.#debugBtn.appendChild(this.#debugLabel)
    this.#debugBtn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('flow:debug-toggle'))
    })
    this.#onDebugState = (event: Event): void => {
      const detail = (event as CustomEvent<{ session: { records: number } | null }>).detail
      this.#setRecording(detail?.session ?? null)
    }
    document.addEventListener('flow:debug-state', this.#onDebugState)
    // A tab opened while a session is already running must not draw itself idle.
    document.dispatchEvent(new CustomEvent('flow:debug-ask'))

    bar.append(
      this.#backBtn,
      this.#forwardBtn,
      reloadBtn,
      this.#urlInput,
      this.#debugBtn,
      this.#inspectBtn,
    )
    this.element = bar

    // Nothing loaded yet — both directions dead until the first navigation.
    this.setCanGoBack(false)
    this.setCanGoForward(false)
  }

  /** Reflect the current page URL (skips overwriting while the user is typing). */
  setUrl(url: string): void {
    if (document.activeElement === this.#urlInput) return
    this.#urlInput.value = url
  }

  setCanGoBack(can: boolean): void {
    this.#backBtn.disabled = !can
  }

  setCanGoForward(can: boolean): void {
    this.#forwardBtn.disabled = !can
  }

  /**
   * Draw the debug button for the session that is live, or none.
   *
   * RECORDING HAS TO BE UNMISTAKABLE — a session silently left running is this
   * feature's failure mode, and the ceiling that eventually stops one is a
   * backstop, not a design. So it is not a subtle tint: the button goes
   * primary, the title carries the count, and the count is a number somebody
   * can watch climb.
   */
  #setRecording(session: { records: number } | null): void {
    const on = session !== null
    this.#debugBtn.setAttribute('variant', on ? 'primary' : 'ghost')
    this.#debugBtn.setAttribute('aria-pressed', String(on))
    this.#debugBtn.classList.toggle('is-recording', on)
    // A WORD, NOT JUST A COLOUR. A pressed icon says "this toggle is on"; it
    // does not say what is on, and a session silently left running is this
    // feature's failure mode. Capturing, the button becomes a labelled tag
    // (user, 2026-09-21) — and loses its `icon` attribute, which squares a
    // button to its glyph and would letterbox the text.
    this.#debugLabel.textContent = on ? 'Capturing' : ''
    this.#debugLabel.hidden = !on
    if (on) this.#debugBtn.removeAttribute('icon')
    else this.#debugBtn.setAttribute('icon', '')
    const label = on
      ? `Capturing — ${session.records} so far. Press to finish and put the record in the chat.`
      : 'Capture a debug session'
    this.#debugBtn.title = label
    this.#debugBtn.setAttribute('aria-label', on ? 'Finish the debug session' : label)
  }

  /** Let go of the document listener when the tab holding this goes away. */
  dispose(): void {
    document.removeEventListener('flow:debug-state', this.#onDebugState)
  }

  /** Set the inspect toggle's visual pressed state (does NOT fire the callback). */
  setInspect(on: boolean): void {
    this.#inspectOn = on
    // Pressed = accent-tinted (primary); idle = borderless ghost.
    this.#inspectBtn.setAttribute('variant', on ? 'primary' : 'ghost')
    this.#inspectBtn.setAttribute('aria-pressed', String(on))
  }

  /** Focus the URL bar and select it — the browser-tab open path calls this. */
  focusUrl(): void {
    this.#urlInput.focus()
    this.#urlInput.select()
  }
}

/** A compact, borderless toolbar icon button (fl-button ghost + icon + small). */
function iconButton(icon: string, label: string): FlButton {
  const button = document.createElement('fl-button')
  button.setAttribute('variant', 'ghost')
  button.setAttribute('icon', '')
  button.setAttribute('small', '')
  button.setAttribute('aria-label', label)
  button.title = label
  const glyph = document.createElement('fl-icon')
  glyph.setAttribute('name', icon)
  glyph.setAttribute('size', '14')
  button.appendChild(glyph)
  return button
}
