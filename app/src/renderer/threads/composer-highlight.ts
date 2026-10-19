/**
 * The composer's highlight backdrop — commands and `@` files coloured WHILE
 * typing, without giving up the textarea.
 *
 * The textarea stays the input and the source of truth: caret, selection, IME,
 * undo, paste, autosize and every key binding are the native field's. Behind
 * it sits a mirror — a div with the same font, padding, line height, width and
 * wrapping, holding the same text as tokens (message-tokens.ts, the same
 * tokenizer the feed uses). While there is something to highlight, the
 * textarea's own glyphs go transparent (the caret keeps its colour) and the
 * mirror's glyphs are what you see; with nothing to highlight, or while an IME
 * composition is open, the mirror steps aside and the field draws itself.
 *
 * Alignment is the whole contract, so the mirror's tokens keep the field's
 * font (the code font would change glyph widths and put the caret in the
 * wrong place); the pill is drawn with a box-shadow, which takes no layout
 * space. The sent message, which has no caret to line up with, uses the full
 * code-font pill.
 *
 * Every way the text can change reaches `sync`: user edits and execCommand
 * insertions fire `input`; the composer's direct `textarea.value = …`
 * assignments are caught by an instance-level `value` setter that forwards to
 * the native one; size changes (autogrow, window width, a scrollbar appearing)
 * by a ResizeObserver; scrolling by `scroll`; a command list arriving by the
 * command-names subscription.
 */

import { onCommandNamesChanged, isKnownCommand } from './command-names'
import { renderMessageTokens } from './message-token-view'
import { hasHighlights, tokenizeMessage } from './message-tokens'
import { highlightBoxWork, type HighlightTrigger } from './composer-highlight-model'

/** Computed properties the mirror copies so its text lays out like the field's. */
const MIRRORED_PROPERTIES = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-stretch',
  'font-variant',
  'font-feature-settings',
  'font-variation-settings',
  'font-kerning',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'text-transform',
  'text-indent',
  'text-align',
  'tab-size',
  'direction',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
] as const

export class ComposerHighlight {
  readonly element: HTMLDivElement
  #content: HTMLDivElement
  #textarea: HTMLTextAreaElement
  #wrap: HTMLElement
  #composing = false
  #lastText: string | null = null
  #unsubscribe: () => void
  #resizeObserver: ResizeObserver | null = null
  #styleObserver: MutationObserver | null = null
  #onFontsLoaded = (): void => this.#catchUp('style')
  /** Whether the mirror was drawing the text at the last sync. */
  #active = false

  constructor(textarea: HTMLTextAreaElement, wrap: HTMLElement) {
    injectHighlightStyles()
    this.#textarea = textarea
    this.#wrap = wrap
    this.element = document.createElement('div')
    this.element.className = 'fl-composer-highlight'
    this.element.setAttribute('aria-hidden', 'true')
    this.#content = document.createElement('div')
    this.#content.className = 'fl-composer-highlight-content'
    this.element.appendChild(this.#content)
    // Before the field in DOM order: both are positioned, so the field paints
    // on top and keeps every pointer and keyboard event.
    wrap.insertBefore(this.element, textarea)

    this.#interceptValueSetter()
    textarea.addEventListener('input', () => this.sync())
    // Size: autogrow, the window's width, a scrollbar appearing, the wrap's
    // own layout moving the field. Style: a font finishing loading, the theme
    // or the root's style changing. Typing pays for neither.
    textarea.addEventListener('scroll', () => this.#syncScroll())
    textarea.addEventListener('compositionstart', () => {
      this.#composing = true
      this.sync()
    })
    textarea.addEventListener('compositionend', () => {
      this.#composing = false
      this.sync()
    })
    if (typeof ResizeObserver === 'function') {
      this.#resizeObserver = new ResizeObserver(() => this.#catchUp('resize'))
      this.#resizeObserver.observe(textarea)
      this.#resizeObserver.observe(wrap)
    }
    if (typeof MutationObserver === 'function') {
      this.#styleObserver = new MutationObserver(() => this.#catchUp('style'))
      this.#styleObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'style', 'class'],
      })
    }
    document.fonts?.addEventListener('loadingdone', this.#onFontsLoaded)
    this.#unsubscribe = onCommandNamesChanged(() => {
      this.#lastText = null
      this.sync()
    })
    this.sync()
  }

  /** Re-render from the field's current text. Cheap when nothing changed. */
  sync(): void {
    const text = this.#textarea.value
    const tokens = this.#composing ? [] : tokenizeMessage(text, isKnownCommand)
    const active = hasHighlights(tokens)
    const turnedOn = active && !this.#active
    this.#active = active
    this.#wrap.classList.toggle('fl-composer-highlighting', active)
    if (!active) {
      if (this.#lastText !== '') this.#content.replaceChildren()
      this.#lastText = ''
      return
    }
    if (text !== this.#lastText) {
      // A trailing newline is an empty last line in the field but nothing in
      // a div; a zero-width space keeps the two the same height for scrolling.
      renderMessageTokens(this.#content, text.endsWith('\n') ? [...tokens, { kind: 'text', text: '​' }] : tokens)
      this.#lastText = text
    }
    // Per keystroke only the content (above) and the scroll; the box is
    // copied when highlighting turns on, and kept by the observers after that.
    this.#applyBoxWork('input', turnedOn)
    this.#syncScroll()
  }

  destroy(): void {
    this.#unsubscribe()
    this.#resizeObserver?.disconnect()
    this.#styleObserver?.disconnect()
    document.fonts?.removeEventListener('loadingdone', this.#onFontsLoaded)
    this.element.remove()
  }

  /** An observer fired: redo what its trigger calls for (`highlightBoxWork`). */
  #catchUp(trigger: HighlightTrigger): void {
    this.#applyBoxWork(trigger, false)
  }

  #applyBoxWork(trigger: HighlightTrigger, turnedOn: boolean): void {
    const work = highlightBoxWork(trigger, this.#active, turnedOn)
    if (work.copyStyle) this.#copyStyle()
    if (work.place) {
      this.#place()
      this.#syncScroll()
    }
  }

  /** Copy the field's font, padding and borders onto the mirror. */
  #copyStyle(): void {
    const computed = getComputedStyle(this.#textarea)
    for (const property of MIRRORED_PROPERTIES) {
      this.element.style.setProperty(property, computed.getPropertyValue(property))
    }
    this.#borderX = parseFloat(computed.borderLeftWidth || '0') + parseFloat(computed.borderRightWidth || '0')
    this.#borderY = parseFloat(computed.borderTopWidth || '0') + parseFloat(computed.borderBottomWidth || '0')
  }

  #borderX = 0
  #borderY = 0

  /** Size and place the mirror over the field's text box. */
  #place(): void {
    const field = this.#textarea
    // clientWidth leaves out a vertical scrollbar, so the mirror wraps at the
    // same width as the field's text even once it scrolls.
    this.element.style.top = `${field.offsetTop}px`
    this.element.style.left = `${field.offsetLeft}px`
    this.element.style.width = `${field.clientWidth + this.#borderX}px`
    this.element.style.height = `${field.clientHeight + this.#borderY}px`
  }

  #syncScroll(): void {
    this.#content.style.transform = `translateY(${-this.#textarea.scrollTop}px)`
  }

  /** Catch `textarea.value = …`, which fires no `input` event. */
  #interceptValueSetter(): void {
    const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    if (native?.get === undefined || native.set === undefined) return
    const getter = native.get
    const setter = native.set
    const onSet = (): void => this.sync()
    Object.defineProperty(this.#textarea, 'value', {
      configurable: true,
      enumerable: native.enumerable ?? true,
      get(this: HTMLTextAreaElement): string {
        return getter.call(this) as string
      },
      set(this: HTMLTextAreaElement, next: string): void {
        setter.call(this, next)
        onSet()
      },
    })
  }
}

let highlightStylesInjected = false

function injectHighlightStyles(): void {
  if (highlightStylesInjected) return
  highlightStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-composer-highlight {
      position: absolute;
      box-sizing: border-box;
      border-style: solid;
      border-color: transparent;
      overflow: hidden;
      pointer-events: none;
      white-space: pre-wrap;
      overflow-wrap: break-word;
      word-break: normal;
      color: var(--fl-color-text);
      visibility: hidden;
    }
    .fl-composer-highlighting .fl-composer-highlight { visibility: visible; }
    .fl-composer-input:has(textarea:disabled) .fl-composer-highlight { opacity: 0.5; }
    /* The mirror's tokens keep the field's font and take no layout space, so
       every glyph sits exactly under the field's own (transparent) glyph. */
    .fl-composer-highlight .fl-token {
      font: inherit;
      padding: 0;
      border-radius: 3px;
      box-shadow: 0 0 0 2px var(--fl-token-ground);
      background: var(--fl-token-ground);
    }
    .fl-composer-highlight .fl-token-command { --fl-token-ground: var(--fl-color-accent-soft); }
    .fl-composer-highlight .fl-token-file { --fl-token-ground: var(--fl-color-mention-soft); }
    /* While the mirror draws the text the field draws only its caret and its
       selection ground. */
    .fl-composer-input textarea { position: relative; }
    .fl-composer-input.fl-composer-highlighting textarea {
      color: transparent;
      caret-color: var(--fl-color-text);
    }
    .fl-composer-input.fl-composer-highlighting textarea::selection {
      color: transparent;
      background: var(--fl-color-accent-muted);
    }
  `
  document.head.appendChild(style)
}
