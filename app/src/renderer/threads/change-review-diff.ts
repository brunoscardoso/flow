/**
 * One file's diff, rendered INSIDE the changes list rather than over the editor.
 *
 * This is the shape the review was asked for: Cursor's Changes view is a single
 * scrolling document — a file's header row, then its diff, then the next file —
 * not a list that launches a separate viewer. Reviewing ten files there is one
 * scroll; reviewing them through an overlay is ten round trips through a modal.
 *
 * IT IS MONACO, deliberately, and so is Cursor's. The collapsed `60 unmodified
 * lines` bands in the reference screenshots are Monaco's own
 * `hideUnchangedRegions`, not a bespoke renderer — so matching the reference
 * costs a few options rather than a diff algorithm, and the syntax colours,
 * word-level highlights and folding come with it.
 *
 * IT SIZES ITSELF TO ITS CONTENT, up to a cap. A fixed-height box inside a
 * scrolling list gives you two scrollbars fighting over one wheel; a box with no
 * cap lets one 4,000-line file bury every other row in the review. So: as tall
 * as the diff needs, never taller than `MAX_HEIGHT_PX`, and only then does it
 * scroll on its own.
 */
import type * as Monaco from 'monaco-editor'

import type { GitDiff } from '../../shared/ipc-contract'

type MonacoNamespace = typeof Monaco

/** Beyond this the diff scrolls internally — one long file must not bury the list. */
const MAX_HEIGHT_PX = 460
/** Below this Monaco reports nonsense during layout; keeps a one-line diff sane. */
const MIN_HEIGHT_PX = 48

const BINARY_NOTICE = 'Binary file — no text diff to show.'

export interface InlineDiff {
  /** The element to put in the list. Already sized; grows with its content. */
  readonly element: HTMLElement
  /** Release the editor and both models. Always call it — Monaco models are
   *  global and leak for the life of the window otherwise. */
  dispose(): void
}

let seq = 0

/**
 * Mount a read-only inline diff. Resolves once Monaco has painted, so a caller
 * can await it before scrolling the row into view.
 */
export async function mountInlineDiff(
  loadMonaco: () => Promise<MonacoNamespace>,
  diff: GitDiff,
  languagePath: string,
): Promise<InlineDiff> {
  const element = document.createElement('div')
  element.className = 'flow-cr-diff'
  element.style.height = `${MIN_HEIGHT_PX}px`

  const monaco = await loadMonaco()

  // A distinct path per model pair, with the real extension kept so Monaco picks
  // the language. A binary file gets `.txt` so its notice is not tokenized as code.
  seq += 1
  const binary = diff.binary === true
  const suffix = binary ? '/binary.txt' : `/${languagePath}`
  const before = binary ? BINARY_NOTICE : diff.beforeContent
  const after = binary ? BINARY_NOTICE : diff.afterContent

  const original = monaco.editor.createModel(
    before,
    undefined,
    monaco.Uri.from({ scheme: 'flow-cr', authority: 'before', path: `/${seq}${suffix}` }),
  )
  const modified = monaco.editor.createModel(
    after,
    undefined,
    monaco.Uri.from({ scheme: 'flow-cr', authority: 'after', path: `/${seq}${suffix}` }),
  )

  const editor = monaco.editor.createDiffEditor(element, {
    // Monaco's theme is a global singleton — a dangling name flips EVERY editor
    // in the window to the light fallback (#453). Read the app's current theme.
    theme: document.documentElement.dataset['theme'] === 'light' ? 'vs' : 'vs-dark',
    readOnly: true,
    // Inline, not side by side: this box is as wide as the tab, and two columns
    // at that width show about forty characters each.
    renderSideBySide: false,
    automaticLayout: true,
    fontSize: 12,
    lineHeight: 18,
    minimap: { enabled: false },
    renderOverviewRuler: false,
    overviewRulerLanes: 0,
    scrollBeyondLastLine: false,
    stickyScroll: { enabled: false },
    lineNumbersMinChars: 3,
    folding: false,
    // The collapsed context bands of the reference — Monaco's own feature.
    hideUnchangedRegions: { enabled: true },
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
    // No occurrence highlighting in a read-only diff: Monaco's WordHighlighter
    // cancels its delayer when models swap and that surfaces as an unhandled
    // "Canceled" page error. It adds nothing to a diff you cannot edit.
    occurrencesHighlight: 'off',
    contextmenu: false,
  })
  editor.setModel({ original, modified })

  const resize = (): void => {
    const height = editor.getModifiedEditor().getContentHeight()
    element.style.height = `${Math.max(MIN_HEIGHT_PX, Math.min(MAX_HEIGHT_PX, height + 2))}px`
  }
  // Both sides matter in inline mode: deleted lines live on the ORIGINAL editor
  // and still take vertical space in the rendered result.
  const subs = [
    editor.getModifiedEditor().onDidContentSizeChange(resize),
    editor.getOriginalEditor().onDidContentSizeChange(resize),
  ]
  resize()

  return {
    element,
    dispose(): void {
      for (const sub of subs) sub.dispose()
      editor.setModel(null)
      editor.dispose()
      original.dispose()
      modified.dispose()
      element.remove()
    },
  }
}
