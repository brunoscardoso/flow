/**
 * LSP ↔ Monaco bindings — bridges the main-process LSP (over the contract's
 * editor:* IPC channels) into Monaco providers.
 *
 * The coordinator calls `initLsp(editorApi)` once after `initEditor(...)`:
 *   - Hover / Definition / Completion providers for typescript + javascript,
 *     each delegating to `window.flow.editor.*`
 *   - editor:diagnostics events → `monaco.editor.setModelMarkers` on the
 *     model addressed by Uri.file(rootPath + filePath); diagnostics arriving
 *     before the model exists are stashed and applied on model creation
 *   - an editor opener so cross-file go-to-definition opens the target file
 *     through EditorApi.openFile instead of failing silently
 *
 * DOCUMENT SYNC: buffer state is pushed over the contract's
 * editor:didOpen / editor:didChange / editor:didClose channels — didOpen on
 * Monaco model creation (spawns the server for the root on first use and
 * triggers diagnostics), didChange debounced ~300ms on buffer edits, and
 * didClose on model dispose. Diagnostics are therefore buffer-accurate;
 * the main-side project file watcher still covers out-of-editor file changes.
 *
 * Monaco arrives ONLY via editorApi.monaco() — never a static value import.
 */
import type * as Monaco from 'monaco-editor'

import type {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticsEvent,
  TextPosition,
  TextRange,
} from '../../shared/ipc-contract'
import type { EditorApi } from './index'

/** Monaco language ids served by the main-process TypeScript server. */
const LSP_LANGUAGES = ['typescript', 'javascript'] as const

/** Marker owner key — keeps LSP markers separate from Monaco's built-ins. */
const MARKER_OWNER = 'flow-lsp'

const COMPLETION_TRIGGER_CHARACTERS = ['.', '"', "'", '`', '/', '@', '<']

/** Quiet window after buffer edits before pushing editor:didChange. */
const DID_CHANGE_DEBOUNCE_MS = 300

/** A model resolved to its project root + root-relative path. */
interface DocumentAddress {
  /** Absolute project root path (the contract's rootId). */
  rootId: string
  /** Root-relative path with '/' separators. */
  filePath: string
}

export async function initLsp(editorApi: EditorApi): Promise<void> {
  const monaco = await editorApi.monaco()

  // ── Project roots (longest-prefix matching for model → root) ─────────
  let rootPaths: string[] = []
  const applyRoots = (paths: string[]): void => {
    rootPaths = [...paths].sort((a, b) => b.length - a.length)
  }
  applyRoots((await window.flow.project.list()).map((root) => root.rootPath))
  window.flow.project.onListChanged((roots) => {
    applyRoots(roots.map((root) => root.rootPath))
  })

  function addressForPath(path: string): DocumentAddress | null {
    for (const rootPath of rootPaths) {
      if (path === rootPath) {
        continue
      }
      if (path.startsWith(rootPath.endsWith('/') ? rootPath : `${rootPath}/`)) {
        return { rootId: rootPath, filePath: path.slice(rootPath.length + 1) }
      }
    }
    return null
  }

  function addressForModel(model: Monaco.editor.ITextModel): DocumentAddress | null {
    if (model.uri.scheme !== 'file') {
      return null
    }
    return addressForPath(model.uri.path)
  }

  // ── Providers ───────────────────────────────────────────────────────────

  for (const language of LSP_LANGUAGES) {
    monaco.languages.registerHoverProvider(language, {
      provideHover: async (model, position) => {
        const address = addressForModel(model)
        if (!address) {
          return null
        }
        const result = await window.flow.editor
          .hover({ ...address, position: toContractPosition(position) })
          .catch((error) => {
            console.warn('flow: lsp hover failed', { path: model.uri.path, error })
            return null
          })
        if (!result) {
          return null
        }
        return {
          contents: [{ value: result.contents }],
          ...(result.range ? { range: toMonacoRange(monaco, result.range) } : {}),
        }
      },
    })

    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: async (model, position) => {
        const address = addressForModel(model)
        if (!address) {
          return null
        }
        const locations = await window.flow.editor
          .definition({ ...address, position: toContractPosition(position) })
          .catch((error) => {
            console.warn('flow: lsp definition failed', { path: model.uri.path, error })
            return []
          })
        return locations.map((location) => ({
          uri: monaco.Uri.file(joinPath(location.rootId, location.filePath)),
          range: toMonacoRange(monaco, location.range),
        }))
      },
    })

    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: COMPLETION_TRIGGER_CHARACTERS,
      provideCompletionItems: async (model, position) => {
        const address = addressForModel(model)
        if (!address) {
          return { suggestions: [] }
        }
        const items = await window.flow.editor
          .completions({ ...address, position: toContractPosition(position) })
          .catch((error) => {
            console.warn('flow: lsp completions failed', { path: model.uri.path, error })
            return []
          })
        const word = model.getWordUntilPosition(position)
        const range = new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn,
        )
        return {
          suggestions: items.map((item) => ({
            label: item.label,
            kind: completionKind(monaco, item.kind),
            insertText: item.insertText,
            range,
            ...(item.detail ? { detail: item.detail } : {}),
            ...(item.documentation ? { documentation: item.documentation } : {}),
          })),
        }
      },
    })
  }

  // Cross-file go-to-definition: standalone Monaco cannot resolve models it
  // has never seen, so open the target through the editor surface instead.
  monaco.editor.registerEditorOpener({
    openCodeEditor: (_source, resource, selectionOrPosition) => {
      const address = resource.scheme === 'file' ? addressForPath(resource.path) : null
      if (!address) {
        return false
      }
      void (async () => {
        await editorApi.openFile(address.rootId, address.filePath)
        if (!selectionOrPosition) {
          return
        }
        const editor = await editorApi.editor()
        const range: Monaco.IRange =
          'startLineNumber' in selectionOrPosition
            ? selectionOrPosition
            : new monaco.Range(
                selectionOrPosition.lineNumber,
                selectionOrPosition.column,
                selectionOrPosition.lineNumber,
                selectionOrPosition.column,
              )
        editor.setSelection(range)
        editor.revealRangeInCenterIfOutsideViewport(range)
      })().catch((error) => {
        console.error('flow: failed to open definition target', { resource: resource.path, error })
      })
      return true
    },
  })

  // ── Diagnostics → model markers ─────────────────────────────────────────

  /** Diagnostics that arrived before their model existed, keyed by URI.
   *  Bounded (LRU by insertion order) so diagnostics for files that are
   *  never opened cannot grow the map without limit. */
  const pendingMarkers = new Map<string, Monaco.editor.IMarkerData[]>()
  const MAX_PENDING_MARKER_ENTRIES = 200

  window.flow.editor.onDiagnostics((event: DiagnosticsEvent) => {
    const uri = monaco.Uri.file(joinPath(event.rootId, event.filePath))
    const markers = event.diagnostics.map((diagnostic) => toMarker(monaco, diagnostic))
    const model = monaco.editor.getModel(uri)
    if (model) {
      monaco.editor.setModelMarkers(model, MARKER_OWNER, markers)
    } else {
      const key = uri.toString()
      pendingMarkers.delete(key) // re-insert so recency is insertion order
      pendingMarkers.set(key, markers)
      while (pendingMarkers.size > MAX_PENDING_MARKER_ENTRIES) {
        const oldest = pendingMarkers.keys().next().value
        if (oldest === undefined) {
          break
        }
        pendingMarkers.delete(oldest)
      }
    }
  })

  // ── Model lifecycle: apply stashed markers + document sync ──────────────

  /** Per-model didChange debounce timers, keyed by model URI. */
  const changeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function isLspModel(model: Monaco.editor.ITextModel): boolean {
    return (LSP_LANGUAGES as readonly string[]).includes(model.getLanguageId())
  }

  function clearChangeTimer(key: string): void {
    const timer = changeTimers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      changeTimers.delete(key)
    }
  }

  function onModelCreated(model: Monaco.editor.ITextModel): void {
    const stashed = pendingMarkers.get(model.uri.toString())
    if (stashed) {
      pendingMarkers.delete(model.uri.toString())
      monaco.editor.setModelMarkers(model, MARKER_OWNER, stashed)
    }
    if (!isLspModel(model)) {
      return
    }
    const address = addressForModel(model)
    if (!address) {
      return
    }

    // didOpen carries the live buffer text; the main side spawns the server
    // for this root on first use, which also triggers publishDiagnostics.
    void window.flow.editor.didOpen({ ...address, content: model.getValue() }).catch((error) => {
      console.warn('flow: editor didOpen failed', { path: model.uri.path, error })
    })

    const key = model.uri.toString()
    model.onDidChangeContent(() => {
      clearChangeTimer(key)
      changeTimers.set(
        key,
        setTimeout(() => {
          changeTimers.delete(key)
          if (model.isDisposed()) {
            return
          }
          void window.flow.editor
            .didChange({ ...address, content: model.getValue() })
            .catch(() => {
              // Best-effort; the next edit (or the save watcher) catches up.
            })
        }, DID_CHANGE_DEBOUNCE_MS),
      )
    })
  }

  monaco.editor.onDidCreateModel(onModelCreated)
  monaco.editor.onWillDisposeModel((model) => {
    const key = model.uri.toString()
    pendingMarkers.delete(key)
    clearChangeTimer(key)
    if (!isLspModel(model)) {
      return
    }
    const address = addressForModel(model)
    if (address) {
      void window.flow.editor.didClose(address).catch(() => {
        // Server-side close is best-effort; disposal must not throw.
      })
    }
  })
  for (const model of monaco.editor.getModels()) {
    onModelCreated(model)
  }
}

// ── Coordinate translation (Monaco is 1-based, the contract 0-based) ──────

function toContractPosition(position: Monaco.Position): TextPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

function toMonacoRange(monaco: typeof Monaco, range: TextRange): Monaco.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1,
  )
}

// ── Contract → Monaco mappers ──────────────────────────────────────────────

function toMarker(monaco: typeof Monaco, diagnostic: Diagnostic): Monaco.editor.IMarkerData {
  return {
    severity: markerSeverity(monaco, diagnostic.severity),
    message: diagnostic.message,
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.code ? { code: diagnostic.code } : {}),
  }
}

function markerSeverity(
  monaco: typeof Monaco,
  severity: DiagnosticSeverity,
): Monaco.MarkerSeverity {
  switch (severity) {
    case 'error':
      return monaco.MarkerSeverity.Error
    case 'warning':
      return monaco.MarkerSeverity.Warning
    case 'hint':
      return monaco.MarkerSeverity.Hint
    case 'info':
      return monaco.MarkerSeverity.Info
  }
}

function completionKind(
  monaco: typeof Monaco,
  kind: string,
): Monaco.languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind
  const byName: Record<string, Monaco.languages.CompletionItemKind> = {
    text: kinds.Text,
    method: kinds.Method,
    function: kinds.Function,
    constructor: kinds.Constructor,
    field: kinds.Field,
    variable: kinds.Variable,
    class: kinds.Class,
    interface: kinds.Interface,
    module: kinds.Module,
    property: kinds.Property,
    unit: kinds.Unit,
    value: kinds.Value,
    enum: kinds.Enum,
    keyword: kinds.Keyword,
    snippet: kinds.Snippet,
    color: kinds.Color,
    file: kinds.File,
    reference: kinds.Reference,
    folder: kinds.Folder,
    enumMember: kinds.EnumMember,
    constant: kinds.Constant,
    struct: kinds.Struct,
    event: kinds.Event,
    operator: kinds.Operator,
    typeParameter: kinds.TypeParameter,
  }
  return byName[kind] ?? kinds.Text
}

// ── Path helpers (renderer has no Node path module) ────────────────────────

function joinPath(rootPath: string, relPath: string): string {
  const base = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  return `${base}/${relPath}`
}
