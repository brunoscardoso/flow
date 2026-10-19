/**
 * RANGE HIGHLIGHT — "open this file AT this piece" (the code storyline's ↗).
 *
 * A caller of `flow:open-file` may name a range (`line` + `endLine`). The editor
 * then reveals the range centred in the viewport, puts the cursor at its start,
 * and marks it: a whole-line background at the accent's low alpha plus a thin
 * accent bar in the gutter, so the eye lands on exactly the lines it was sent to.
 *
 * WHEN IT GOES AWAY (the calm rule): the mark is a pointer, not a selection, so
 * it leaves on its own and never fights the person.
 *   - it holds for RANGE_HIGHLIGHT_HOLD_MS, then fades over
 *     RANGE_HIGHLIGHT_FADE_MS and is removed;
 *   - it clears at once when the cursor moves outside the range (a click or a
 *     keystroke elsewhere), when the buffer is edited, or when the editor shows
 *     another file;
 *   - a new highlight replaces the previous one (only one is ever on screen).
 * Moving the cursor INSIDE the range keeps it — reading the piece is the point.
 *
 * The pure parts (`normalizeHighlightRange`, `cursorLeavesRange`) live in
 * range-highlight-model.ts and are unit tested; the controller takes the editor and namespace as arguments so it
 * imports Monaco by type only.
 */
import type * as Monaco from 'monaco-editor'

import { cursorLeavesRange, type HighlightRange } from './range-highlight-model'

/** How long the mark stays at full strength before it starts to fade. */
export const RANGE_HIGHLIGHT_HOLD_MS = 4000
/** The fade-out itself — the CSS animation length, then the decoration goes. */
export const RANGE_HIGHLIGHT_FADE_MS = 400

export const RANGE_HIGHLIGHT_LINE_CLASS = 'fl-range-highlight-line'
export const RANGE_HIGHLIGHT_GUTTER_CLASS = 'fl-range-highlight-gutter'
const RANGE_HIGHLIGHT_FADING_CLASS = 'fl-range-highlight-fading'
/** Mirrors the live range on the editor's DOM node (`"12-30"`), for tests and tooling. */
export const RANGE_HIGHLIGHT_DATA_ATTRIBUTE = 'data-flow-range-highlight'

interface ActiveHighlight {
  decorations: Monaco.editor.IEditorDecorationsCollection
  subscriptions: Monaco.IDisposable[]
  timers: Array<ReturnType<typeof setTimeout>>
  node: HTMLElement | null
}

let active: ActiveHighlight | null = null

/** Remove the current highlight (if any) and everything that watches it. */
export function clearRangeHighlight(): void {
  const current = active
  if (current === null) return
  active = null
  for (const timer of current.timers) clearTimeout(timer)
  for (const subscription of current.subscriptions) subscription.dispose()
  current.decorations.clear()
  current.node?.removeAttribute(RANGE_HIGHLIGHT_DATA_ATTRIBUTE)
}

function decorationsFor(
  monaco: typeof Monaco,
  range: HighlightRange,
  fading: boolean,
): Monaco.editor.IModelDeltaDecoration[] {
  const extra = fading ? ` ${RANGE_HIGHLIGHT_FADING_CLASS}` : ''
  return [
    {
      range: new monaco.Range(range.start, 1, range.end, 1),
      options: {
        isWholeLine: true,
        className: `${RANGE_HIGHLIGHT_LINE_CLASS}${extra}`,
        linesDecorationsClassName: `${RANGE_HIGHLIGHT_GUTTER_CLASS}${extra}`,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    },
  ]
}

/**
 * Reveal `range` centred, place the cursor at its start and mark it until the
 * calm rule above clears it. The editor's current model must already be the
 * target file (the caller's model-swap wait guarantees that).
 */
export function highlightRange(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  range: HighlightRange,
): void {
  clearRangeHighlight()
  injectStyles()
  editor.setSelection(new monaco.Range(range.start, 1, range.start, 1))
  editor.revealRangeInCenter(
    new monaco.Range(range.start, 1, range.end, 1),
    monaco.editor.ScrollType.Immediate,
  )
  const markedUri = editor.getModel()?.uri.toString() ?? null
  const decorations = editor.createDecorationsCollection(decorationsFor(monaco, range, false))
  const node = editor.getDomNode()
  node?.setAttribute(RANGE_HIGHLIGHT_DATA_ATTRIBUTE, `${String(range.start)}-${String(range.end)}`)
  const current: ActiveHighlight = { decorations, subscriptions: [], timers: [], node }
  active = current
  // Listeners are attached AFTER our own setSelection, so the cursor move we
  // just made is not mistaken for the person leaving.
  current.subscriptions.push(
    editor.onDidChangeCursorPosition((event) => {
      if (cursorLeavesRange(event.position.lineNumber, range)) clearRangeHighlight()
    }),
    editor.onDidChangeModelContent(() => clearRangeHighlight()),
    // Another file on screen clears it. The swap that brought THIS file in can
    // still be dispatching when we subscribe, so the marked model is exempt.
    editor.onDidChangeModel((event) => {
      if (event.newModelUrl?.toString() !== markedUri) clearRangeHighlight()
    }),
  )
  current.timers.push(
    setTimeout(() => {
      if (active !== current) return
      current.decorations.set(decorationsFor(monaco, range, true))
      current.timers.push(setTimeout(() => {
        if (active === current) clearRangeHighlight()
      }, RANGE_HIGHLIGHT_FADE_MS))
    }, RANGE_HIGHLIGHT_HOLD_MS),
  )
}

let stylesInjected = false

/** Both themes through the app's tokens: the accent, at a low alpha. */
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .monaco-editor .${RANGE_HIGHLIGHT_LINE_CLASS} {
      background: color-mix(in srgb, var(--fl-color-accent) 12%, transparent);
    }
    .monaco-editor .${RANGE_HIGHLIGHT_GUTTER_CLASS} {
      background: var(--fl-color-accent);
      width: 3px !important;
      margin-left: 3px;
    }
    .monaco-editor .${RANGE_HIGHLIGHT_FADING_CLASS} {
      animation: fl-range-highlight-fade ${String(RANGE_HIGHLIGHT_FADE_MS)}ms ease-out forwards;
    }
    @keyframes fl-range-highlight-fade {
      from { opacity: 1; }
      to { opacity: 0; }
    }
  `
  document.head.appendChild(style)
}
