/**
 * Hunk-scoped Compare view (conflict-UX v2, Phase 2 Task 2) — opens a read-only
 * TWO-SIDE Monaco diff of ONE conflict hunk's two sides (side A `oursText` on the
 * left, side B `theirsText` on the right) as an editor-area VIEW tab, reusing the
 * editor's `openView` surface (the same stacked-tab mechanism Blueprint and the
 * merge editor use).
 *
 * Renderer-only, no IPC: both texts arrive already parsed from the ConflictBlock,
 * so nothing hits disk or the git bridge — this is a pure comparison surface, not
 * a resolver. Resolution stays with the Accept lenses (conflict-codelens.ts).
 *
 * Monaco arrives only through the injected loader (EditorApi.monaco()), so the
 * dynamic-import-only rule holds — nothing here imports monaco-editor statically
 * (types only). Compare tabs are keyed per (file, hunk); reopening the same hunk
 * re-activates the existing tab and refreshes its two sides rather than leaking a
 * second diff editor. Models use a private `flow-conflict:` URI scheme (never a
 * real file model) while carrying the file extension for language colorization.
 */
import type * as Monaco from 'monaco-editor'

import { diffEditorThemeName } from './monaco-themes'
import type { EditorApi } from './index'

type MonacoNamespace = typeof Monaco

/** Everything needed to open (or refresh) a hunk Compare tab. */
export interface HunkCompareRequest {
  /** Absolute path of the conflicted file the hunk belongs to (tab-id scope). */
  absPath: string
  /** Stable, content-derived hunk id (tab-id scope). */
  hunkId: string
  /** Side A body — the ours stage ("Current"), shown on the left. */
  currentText: string
  /** Side B body — the theirs stage ("Incoming"), shown on the right. */
  incomingText: string
  /** Path used for language inference (extension → colorization); optional. */
  languagePath?: string
}

const FONT_FAMILY =
  "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
const FONT_SIZE = 13

/** A live Compare tab: its container element, diff editor, and current models. */
interface CompareEntry {
  container: HTMLElement
  diffEditor: Monaco.editor.IStandaloneDiffEditor
  models: { original: Monaco.editor.ITextModel; modified: Monaco.editor.ITextModel } | null
}

// One entry per open Compare tab (keyed by view id). The editor's openView keeps
// the element mounted after a tab close, so reopening the same hunk reuses this.
const entries = new Map<string, CompareEntry>()

// Monotonic counter guaranteeing globally-unique model URIs (Monaco refuses two
// models on the same URI). Never reset — collisions must be impossible.
let modelSeq = 0

/**
 * Open (or refresh + focus) the two-side Compare tab for one hunk. Builds the diff
 * editor lazily on first open for that hunk, then sets fresh models each call so a
 * reopen reflects the current hunk text. Never throws for a missing icon or empty
 * side — an empty side simply renders as a blank pane.
 */
export async function openHunkCompare(
  editorApi: EditorApi,
  request: HunkCompareRequest,
): Promise<void> {
  const monaco = await editorApi.monaco()
  const viewId = compareViewId(request.absPath, request.hunkId)

  let entry = entries.get(viewId)
  if (!entry) {
    entry = createEntry(monaco)
    entries.set(viewId, entry)
  }

  applyModels(monaco, entry, request)

  // Mount (or re-activate) the tab. The element is retained across closes, so a
  // second open of the same hunk re-shows this exact diff editor.
  editorApi.openView({
    id: viewId,
    label: `Compare — ${baseName(request.absPath)}`,
    icon: 'git-merge',
    element: entry.container,
  })
}

/** Build a fresh, read-only two-side diff editor inside a stretch container. */
function createEntry(monaco: MonacoNamespace): CompareEntry {
  const container = document.createElement('div')
  container.style.cssText = 'height:100%;width:100%;min-height:0;'
  const diffEditor = monaco.editor.createDiffEditor(container, {
    // Monaco's theme is a global singleton — reuse the app's current editor theme
    // (the monaco-host data-theme observer re-themes every editor together after).
    theme: diffEditorThemeName(document.documentElement.dataset['theme']),
    readOnly: true,
    originalEditable: false,
    // Two-side comparison — the whole point of Compare (vs the inline review diff).
    renderSideBySide: true,
    automaticLayout: true,
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    fontLigatures: true,
    lineHeight: 1.5,
    minimap: { enabled: false },
    scrollbar: {
      verticalScrollbarSize: 8,
      horizontalScrollbarSize: 8,
      useShadows: false,
    },
    renderOverviewRuler: false,
    scrollBeyondLastLine: false,
    stickyScroll: { enabled: false },
    padding: { top: 8, bottom: 8 },
  })
  return { container, diffEditor, models: null }
}

/** Swap in fresh models for the two sides, disposing the previous pair. */
function applyModels(
  monaco: MonacoNamespace,
  entry: CompareEntry,
  request: HunkCompareRequest,
): void {
  const suffix = request.languagePath ? `/${extensionSuffix(request.languagePath)}` : '/hunk.txt'
  const previous = entry.models
  const original = monaco.editor.createModel(
    request.currentText,
    undefined,
    monaco.Uri.from({ scheme: 'flow-conflict', authority: 'current', path: `/${++modelSeq}${suffix}` }),
  )
  const modified = monaco.editor.createModel(
    request.incomingText,
    undefined,
    monaco.Uri.from({ scheme: 'flow-conflict', authority: 'incoming', path: `/${++modelSeq}${suffix}` }),
  )
  entry.models = { original, modified }
  entry.diffEditor.setModel({ original, modified })
  previous?.original.dispose()
  previous?.modified.dispose()
}

/** Stable per-(file, hunk) view id — a non-path `flow://` id the tab strip owns. */
function compareViewId(absPath: string, hunkId: string): string {
  return `flow://conflict-compare/${absPath}#${hunkId}`
}

/** The trailing `<name>.<ext>` of a path, so the model URI keeps the extension
 *  (drives Monaco language colorization) without leaking the full path. */
function extensionSuffix(languagePath: string): string {
  const slash = languagePath.lastIndexOf('/')
  return slash === -1 ? languagePath : languagePath.slice(slash + 1)
}

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash === -1 ? filePath : filePath.slice(slash + 1)
}
