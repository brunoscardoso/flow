/**
 * THE LAUNCHPAD'S SCRIPT EDITOR — a monospace textarea with a line-number
 * gutter and light shell colouring, no dependency: a coloured `pre` sits
 * behind a transparent textarea that takes the typing (the approved mockup's
 * shape). It grows with the script up to a limit, then scrolls; the gutter
 * and the colouring follow the textarea's scroll. Tab inserts two spaces.
 *
 * A third layer, behind the colouring, marks lines (the agent's changed
 * lines): one block per marked line, 20px tall, at the same padding, moved
 * with the textarea's scroll — so the marks stay on their lines exactly.
 *
 * The colouring is written as text nodes, never HTML (see `script-highlight.ts`).
 * Styles live with the Launchpad's other styles in `run-group-view.ts`.
 */
import { scriptChatText } from './run-setup-model'
import { highlightShell, type ShellTokenKind } from './script-highlight'

/** Pixel height of one line — matches the CSS line-height. */
export const SCRIPT_LINE_PX = 20
/** The editor grows to this many lines, then scrolls. */
export const SCRIPT_MAX_LINES = 18
const PADDING_PX = 16

const CLASS_OF: Record<ShellTokenKind, string | null> = {
  plain: null,
  comment: 'fl-run-sh-comment',
  string: 'fl-run-sh-string',
  keyword: 'fl-run-sh-keyword',
  program: 'fl-run-sh-program',
  variable: 'fl-run-sh-variable',
}

/** Writes `text` into `target` as coloured shell text nodes (never HTML). */
export function paintShell(target: HTMLElement, text: string): void {
  target.textContent = ''
  for (const token of highlightShell(text)) {
    const cls = CLASS_OF[token.kind]
    if (cls === null) {
      target.appendChild(document.createTextNode(token.text))
    } else {
      const span = document.createElement('span')
      span.className = cls
      span.textContent = token.text
      target.appendChild(span)
    }
  }
}

/**
 * A script shown read-only, as the editor shows it: line numbers and the same
 * colouring — the ask before a script runs (2026-11-18).
 */
export function createScriptView(text: string, label: string): HTMLElement {
  const view = document.createElement('div')
  view.className = 'fl-run-script-view'
  view.tabIndex = 0
  view.setAttribute('role', 'region')
  view.setAttribute('aria-label', label)
  const lines = text.replace(/\n$/, '').split('\n')
  const gutter = document.createElement('div')
  gutter.className = 'fl-run-script-view-gutter'
  gutter.setAttribute('aria-hidden', 'true')
  gutter.textContent = lines.map((_, i) => String(i + 1)).join('\n')
  const code = document.createElement('pre')
  code.className = 'fl-run-script-view-code'
  paintShell(code, lines.join('\n'))
  view.append(gutter, code)
  return view
}

export interface ScriptEditor {
  element: HTMLElement
  textarea: HTMLTextAreaElement
  /** Mark these lines (0-based); an empty list clears the marks. */
  setMarks(lines: readonly number[]): void
}

export function createScriptEditor(options: {
  value: string
  label: string
  onInput(value: string): void
  /** The context chip's name when ⌘L adds the script to the conversation. */
  chatLabel?(): string
  /** Lines to mark from the start (0-based). */
  marks?: readonly number[]
  /** Shown but not editable (the agent is writing it). */
  readOnly?: boolean
}): ScriptEditor {
  const element = document.createElement('div')
  element.className = 'fl-run-editor'
  const gutter = document.createElement('div')
  gutter.className = 'fl-run-editor-gutter'
  gutter.setAttribute('aria-hidden', 'true')
  const code = document.createElement('div')
  code.className = 'fl-run-editor-code'
  const marks = document.createElement('div')
  marks.className = 'fl-run-editor-marks'
  marks.setAttribute('aria-hidden', 'true')
  const pre = document.createElement('pre')
  pre.className = 'fl-run-editor-colour'
  pre.setAttribute('aria-hidden', 'true')
  const textarea = document.createElement('textarea')
  textarea.className = 'fl-run-editor-input'
  textarea.spellcheck = false
  textarea.wrap = 'off'
  textarea.setAttribute('autocapitalize', 'off')
  textarea.setAttribute('autocomplete', 'off')
  textarea.setAttribute('aria-label', options.label)
  textarea.value = options.value
  if (options.readOnly === true) {
    textarea.readOnly = true
    element.classList.add('read-only')
  }
  code.append(marks, pre, textarea)
  element.append(gutter, code)

  const setMarks = (lines: readonly number[]): void => {
    marks.textContent = ''
    element.classList.toggle('marked', lines.length > 0)
    for (const line of lines) {
      const mark = document.createElement('div')
      mark.className = 'fl-run-editor-mark'
      mark.style.top = `${PADDING_PX / 2 + line * SCRIPT_LINE_PX}px`
      marks.appendChild(mark)
    }
  }

  const syncScroll = (): void => {
    marks.style.transform = `translate(0, ${-textarea.scrollTop}px)`
    pre.scrollTop = textarea.scrollTop
    pre.scrollLeft = textarea.scrollLeft
    gutter.scrollTop = textarea.scrollTop
  }

  const paint = (): void => {
    const text = textarea.value
    paintShell(pre, text)
    // A trailing newline still shows its empty last line.
    pre.appendChild(document.createTextNode('\n'))
    const lines = Math.max(1, text.split('\n').length)
    gutter.textContent = Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n')
    const shown = Math.min(lines, SCRIPT_MAX_LINES)
    code.style.height = `${shown * SCRIPT_LINE_PX + PADDING_PX}px`
    gutter.style.height = code.style.height
    syncScroll()
  }

  textarea.addEventListener('input', () => {
    paint()
    options.onInput(textarea.value)
  })
  textarea.addEventListener('scroll', syncScroll)
  // ⌘L: the selection — or the whole script when nothing is selected — goes to
  // the conversation as a context chip, the same event the terminal and the
  // code editor send (#152, #462).
  textarea.addEventListener('keydown', (event) => {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== 'l') return
    const text = scriptChatText(textarea.value, textarea.selectionStart, textarea.selectionEnd)
    if (text === null) return
    event.preventDefault()
    event.stopPropagation()
    document.dispatchEvent(
      new CustomEvent('flow:add-to-chat', {
        detail: { source: 'file', text, label: options.chatLabel?.() ?? options.label },
      }),
    )
  })
  textarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  setMarks(options.marks ?? [])
  paint()
  return { element, textarea, setMarks }
}

