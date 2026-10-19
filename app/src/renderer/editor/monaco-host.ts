/**
 * Monaco host — lazy-loaded Monaco editor restyled to Stark.
 *
 * Monaco is heavy, so nothing from `monaco-editor` is imported statically:
 * the namespace, its CSS, and the workers all arrive via dynamic import the
 * first time a file opens, keeping cold start fast. Workers use Vite's
 * `?worker` pattern (see vite-worker.d.ts) so every asset stays self-hosted
 * under the strict CSP.
 *
 * One editor instance; one text model per absolute file path. Dirty state is
 * tracked per model via alternative version ids. Later phases attach to the
 * same instance: LSP providers via `monacoNamespace()`, inline diffs via the
 * shared models.
 */
import type * as Monaco from 'monaco-editor'

import {
  DARK_THEME_DATA,
  EDITOR_THEME_DARK,
  EDITOR_THEME_LIGHT,
  LIGHT_THEME_DATA,
  colorModeFromDataTheme,
  resolveEditorThemeName,
} from './monaco-themes'
import { fileChatLabel, sendableSelection } from './editor-selection-chat'
import { contentHash, isMonacoCancellation } from './buffer-baseline'

type MonacoNamespace = typeof Monaco

const FONT_FAMILY =
  "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
const FONT_SIZE = 13

const BINARY_PLACEHOLDER_TEXT = '(binary file — contents not shown)'
const TOO_LARGE_PLACEHOLDER_TEXT = '(file too large to preview)'

declare global {
  interface Window {
    MonacoEnvironment?: Monaco.Environment
  }
}

let monacoPromise: Promise<MonacoNamespace> | null = null

/** Identifies this renderer's models apart from any earlier run's. */
const MODEL_SESSION = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
let modelCounter = 0

/**
 * Load (once) and configure the Monaco namespace: worker environment plus the
 * Stark theme. Exported so later phases (LSP providers, inline diff widgets)
 * attach to the exact same configured instance.
 */
export function monacoNamespace(): Promise<MonacoNamespace> {
  if (!monacoPromise) {
    monacoPromise = loadMonaco()
  }
  return monacoPromise
}

async function loadMonaco(): Promise<MonacoNamespace> {
  // The worker environment must exist before the first editor/model is
  // created. Workers are themselves lazy: each language service loads only
  // when a file of that kind first needs it.
  self.MonacoEnvironment = {
    getWorker: async (_workerId: string, label: string): Promise<Worker> => {
      if (label === 'json') {
        const { default: JsonWorker } = await import(
          'monaco-editor/esm/vs/language/json/json.worker?worker'
        )
        return new JsonWorker({ name: 'monaco-json' })
      }
      if (label === 'typescript' || label === 'javascript') {
        const { default: TsWorker } = await import(
          'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
        )
        return new TsWorker({ name: 'monaco-typescript' })
      }
      const { default: EditorWorker } = await import(
        'monaco-editor/esm/vs/editor/editor.worker?worker'
      )
      return new EditorWorker({ name: 'monaco-editor' })
    },
  }

  ignoreMonacoCancellations()
  const monaco = await import('monaco-editor')
  defineEditorThemes(monaco)
  deferLanguageFeaturesToLsp(monaco)
  return monaco
}

/**
 * Swallow Monaco's own cancellation rejections — and nothing else.
 *
 * Swapping or disposing a model cancels the editor's in-flight async features
 * (WordHighlighter, hovers, code lens). Some of those promises reject with a
 * `CancellationError` that no one awaits, so it surfaces as an unhandled
 * rejection: an uncaught "Canceled" page error on every conversation switch,
 * which is when models are swapped and disposed in bulk. VS Code's own
 * `onUnexpectedError` ignores exactly this error; so does this. Every other
 * rejection still reaches the console untouched.
 */
let cancellationHandlerInstalled = false
function ignoreMonacoCancellations(): void {
  if (cancellationHandlerInstalled) return
  cancellationHandlerInstalled = true
  window.addEventListener('unhandledrejection', (event) => {
    if (isMonacoCancellation(event.reason)) event.preventDefault()
  })
}

/**
 * The semantic language features Flow's LSP owns exclusively, switched OFF on
 * Monaco's built-in TS/JS worker. The purely SYNTACTIC ones stay on: they are
 * computed from the open buffer's own text, need no filesystem, and the LSP
 * bridge does not provide them (`lsp-bindings.ts` registers hover, definition
 * and completion only) — turning them off would lose the outline/breadcrumbs
 * and formatting for nothing.
 */
const LSP_OWNED_MODE_CONFIGURATION = {
  completionItems: false,
  hovers: false,
  definitions: false,
  references: false,
  documentHighlights: false,
  rename: false,
  diagnostics: false,
  signatureHelp: false,
  codeActions: false,
  inlayHints: false,
  // Syntactic-only — no project knowledge required, so they stay Monaco's.
  documentSymbols: true,
  documentRangeFormattingEdits: true,
  onTypeFormattingEdits: true,
} as const

/**
 * Make the main-process LSP the SINGLE provider of TypeScript/JavaScript
 * language intelligence, by switching Monaco's built-in in-browser TS worker
 * out of every semantic feature.
 *
 * That worker runs with NO filesystem access: it never loads the project's
 * tsconfig (`paths`, `baseUrl`, `moduleResolution`) and cannot see
 * `node_modules`, so every answer it gives about an imported symbol is a guess.
 * #37 established that verdict and disabled its DIAGNOSTICS — it was flagging
 * every non-relative import as "Cannot find module … (2792)". But only its
 * diagnostics: its hover, definition and completion providers stayed
 * registered, so the noise simply moved from squiggles to the three features a
 * user invokes by hand (#1022). Both providers answering meant F12 on an
 * imported symbol opened a `Definitions (2)` peek — the LSP's real target plus
 * the built-in worker's phantom (the import line in the file you are already
 * in), with the phantom preselected — so Go to Definition never navigated.
 * Hover and autocomplete printed every symbol twice for the same reason.
 *
 * Monaco resolves ties between equal providers by showing all of them, so there
 * is no "preferred provider" knob: one of the two has to go, and the LSP is the
 * one that can read the real tsconfig and node_modules.
 */
function deferLanguageFeaturesToLsp(monaco: MonacoNamespace): void {
  // monaco 0.55 types the top-level `languages.typescript` as a deprecated
  // stub ({ deprecated: true }), but the ESM bundle still populates the real
  // language-service defaults on it at runtime. Reach them through a minimal
  // typed view, guarded so a monaco version without them is a silent no-op.
  interface LanguageServiceDefaults {
    setDiagnosticsOptions(options: {
      noSemanticValidation?: boolean
      noSyntaxValidation?: boolean
      noSuggestionDiagnostics?: boolean
    }): void
    setModeConfiguration?(configuration: Record<string, boolean>): void
  }
  const tsApi = monaco.languages.typescript as unknown as
    | {
        typescriptDefaults?: LanguageServiceDefaults
        javascriptDefaults?: LanguageServiceDefaults
      }
    | undefined
  const options = {
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  }
  for (const defaults of [tsApi?.typescriptDefaults, tsApi?.javascriptDefaults]) {
    // Diagnostics are also silenced at their own switch (#37): setModeConfiguration
    // unregisters the diagnostics ADAPTER, while setDiagnosticsOptions is what a
    // monaco build lacking mode configuration still honours.
    defaults?.setDiagnosticsOptions(options)
    defaults?.setModeConfiguration?.({ ...LSP_OWNED_MODE_CONFIGURATION })
  }
}

/** Define the VS Code Dark+/Light+ themes and apply the one matching the app's
 *  color mode, re-applying when the app flips <html data-theme> (#126). */
function defineEditorThemes(monaco: MonacoNamespace): void {
  monaco.editor.defineTheme(EDITOR_THEME_DARK, DARK_THEME_DATA)
  monaco.editor.defineTheme(EDITOR_THEME_LIGHT, LIGHT_THEME_DATA)
  const apply = (): void => monaco.editor.setTheme(resolveEditorThemeName(colorModeFromDataTheme(document.documentElement.dataset['theme'])))
  apply()
  // setTheme is global, so this also drives the git diff editors. The observer lets
  // the editor follow the app the moment a light chrome ships (dark-only today).
  new MutationObserver(apply).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
}

export class MonacoHost {
  #editorEl: HTMLDivElement
  #placeholder: HTMLDivElement
  #editor: Monaco.editor.IStandaloneCodeEditor | null = null
  #models = new Map<string, Monaco.editor.ITextModel>()
  #savedVersions = new Map<string, number>()
  #dirtyFlags = new Map<string, boolean>()
  #binaryPaths = new Set<string>()
  #contentSubscriptions = new Map<string, Monaco.IDisposable>()
  #viewStates = new Map<string, Monaco.editor.ICodeEditorViewState | null>()
  /**
   * Hash of the disk content each buffer was last in sync with — set when it is
   * read, reloaded or saved, and NOT moved by typing or a restored snapshot.
   * Lets a buffer that outlives its tab (one buffer per file, across
   * conversations) tell whether the disk moved on underneath it.
   */
  #baselines = new Map<string, string>()
  /**
   * One id per model INSTANCE. A snapshot of an unsaved buffer records it, so a
   * restore can tell "this snapshot came from the model still alive" (the live
   * model is newer) from "a model for this path happens to exist" (the
   * snapshot is still owed).
   */
  #modelIds = new Map<string, string>()
  #activePath: string | null = null
  #onDirtyChange: (path: string, dirty: boolean) => void

  constructor(container: HTMLElement, onDirtyChange: (path: string, dirty: boolean) => void) {
    this.#onDirtyChange = onDirtyChange

    container.style.position = 'relative'
    container.style.minHeight = '0'

    this.#editorEl = document.createElement('div')
    this.#editorEl.style.cssText = 'position:absolute;inset:0;'
    container.appendChild(this.#editorEl)

    // Placeholder overlays (and hides) the editor until a file is shown.
    this.#placeholder = document.createElement('div')
    this.#placeholder.style.cssText = [
      'position:absolute',
      'inset:0',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:var(--fl-color-surface)',
      'color:var(--fl-color-text-secondary)',
      'font-size:var(--fl-text-ui-size)',
      'user-select:none',
    ].join(';')
    // Blank surface (no "open a file" copy) — a clean, Zed-like empty editor.
    this.#placeholder.textContent = ''
    container.appendChild(this.#placeholder)
  }

  /** The path currently shown in the editor, if any. */
  get activePath(): string | null {
    return this.#activePath
  }

  /**
   * Create (or reuse) the model for `path` and show it. `path` must be
   * absolute — it doubles as the Monaco URI and the tab id.
   */
  async open(path: string, content: string, binary: boolean, tooLarge = false): Promise<void> {
    const monaco = await monacoNamespace()
    this.#ensureEditor(monaco)

    // A too-large file is a non-editable placeholder too — treat it like binary
    // for read-only/dirty/save gating, but show an accurate message.
    const nonEditable = binary || tooLarge
    let model = this.#models.get(path)
    if (!model) {
      const uri = monaco.Uri.file(path)
      const value = tooLarge
        ? TOO_LARGE_PLACEHOLDER_TEXT
        : binary
          ? BINARY_PLACEHOLDER_TEXT
          : content
      // Language is inferred from the URI extension by Monaco itself.
      model =
        monaco.editor.getModel(uri) ??
        monaco.editor.createModel(value, nonEditable ? 'plaintext' : undefined, uri)
      this.#models.set(path, model)
      modelCounter += 1
      this.#modelIds.set(path, `${MODEL_SESSION}-${modelCounter}`)
      this.#savedVersions.set(path, model.getAlternativeVersionId())
      this.#dirtyFlags.set(path, false)
      if (nonEditable) {
        this.#binaryPaths.add(path)
      } else {
        this.#baselines.set(path, contentHash(model.getValue()))
      }
      this.#contentSubscriptions.set(
        path,
        model.onDidChangeContent(() => this.#refreshDirty(path)),
      )
    }
    this.#setModel(path, model)
  }

  /** Whether a model for `path` is alive — open in a tab, or a dirty buffer
   *  kept for a conversation that is not on screen. */
  hasModel(path: string): boolean {
    return this.#models.has(path)
  }

  /** Every path with a live model. */
  livePaths(): string[] {
    return [...this.#models.keys()]
  }

  /** Hash of the disk content `path`'s buffer was last in sync with. */
  baselineOf(path: string): string | undefined {
    return this.#baselines.get(path)
  }

  /** The id of the model instance alive for `path` (see `#modelIds`). */
  modelIdOf(path: string): string | undefined {
    return this.#modelIds.get(path)
  }

  /** Show an already-open file. Returns false if `path` was never opened. */
  show(path: string): boolean {
    const model = this.#models.get(path)
    if (!model || !this.#editor) {
      return false
    }
    this.#setModel(path, model)
    return true
  }

  /** Clear the editor (no active file) and show the placeholder. */
  showNone(): void {
    if (this.#activePath) {
      this.#viewStates.set(this.#activePath, this.#editor?.saveViewState() ?? null)
    }
    this.#editor?.setModel(null)
    this.#activePath = null
    this.#placeholder.style.display = 'flex'
  }

  /** Dispose the model and all per-file state for `path`. */
  close(path: string): void {
    if (this.#activePath === path) {
      this.showNone()
    }
    this.#contentSubscriptions.get(path)?.dispose()
    this.#contentSubscriptions.delete(path)
    this.#models.get(path)?.dispose()
    this.#models.delete(path)
    this.#savedVersions.delete(path)
    this.#dirtyFlags.delete(path)
    this.#binaryPaths.delete(path)
    this.#viewStates.delete(path)
    this.#baselines.delete(path)
    this.#modelIds.delete(path)
  }

  isDirty(path: string): boolean {
    return this.#dirtyFlags.get(path) === true
  }

  isBinary(path: string): boolean {
    return this.#binaryPaths.has(path)
  }

  /** Current buffer content for `path` (null if not open). */
  getContent(path: string): string | null {
    return this.#models.get(path)?.getValue() ?? null
  }

  /**
   * Replace a model's content with fresh disk content, preserving the editor view
   * state (cursor/scroll) and resetting the saved baseline so the tab stays clean
   * (#353). No-op — returns false — when the file isn't open, is binary, or the
   * content is unchanged (e.g. the editor's own save echoing back through the
   * watcher). Only call for a CLEAN tab; a dirty tab's edits must not be clobbered.
   */
  reloadFromDisk(path: string, content: string): boolean {
    // Never overwrite unsaved edits — enforce the "clean tab only" contract IN CODE,
    // not just by comment, so an async caller that decided cleanliness before its await
    // can't clobber a since-dirtied buffer (#357; allowed-pattern #14).
    if (this.isDirty(path)) return false
    return this.applyDiskContent(path, content)
  }

  /**
   * Apply `content` as the buffer's new CLEAN baseline — the single code path
   * for "something outside this buffer rewrote the file, and the buffer now
   * matches disk" (allowed-pattern #14). Two callers reach it: the watcher's
   * clean-tab reload above (#353), and Flow's own conflict-resolve splice
   * (`conflict-codelens.ts` → `EditorApi.syncBufferFromDisk`).
   *
   * That second caller is #1097: it used to push a bare `pushEditOperations`
   * of its own, which bumps `getAlternativeVersionId()` and therefore flipped
   * the tab DIRTY for content the user never typed. The chokidar event for
   * Flow's own write then found a dirty tab, took the #357 branch, and raised
   * "File changed on disk — saving will overwrite that change" about the app's
   * own write, mid-merge. Moving the edit and the baseline reset into one
   * method makes that combination unrepresentable.
   *
   * Returns false (a no-op) for an unopened/binary path or unchanged content.
   */
  applyDiskContent(path: string, content: string): boolean {
    const model = this.#models.get(path)
    if (!model || this.#binaryPaths.has(path)) return false
    if (model.getValue() === content) {
      // Already in sync (e.g. the watcher won the race and reloaded first, or
      // this is the editor's own save echoing back). Re-baseline anyway so an
      // earlier in-place edit can't leave a phantom dirty dot behind.
      this.markSaved(path)
      return false
    }
    const isActive = this.#activePath === path
    const viewState = isActive ? (this.#editor?.saveViewState() ?? null) : null
    // pushEditOperations, NOT setValue (#1096): setValue is a flush edit that
    // destroys the model's entire undo/redo stack — after an agent rewrote an
    // open file, ⌘Z/⌘⇧Z went dead, taking the user's own earlier history with
    // them. An undoable full-range edit (the same technique restoreDirtyContent
    // below uses, and how VS Code applies disk reloads) keeps the history:
    // undoing steps back to the pre-reload content. The stack-element pushes
    // bracket the reload as its own discrete undo unit, never merged into the
    // user's adjacent typing group.
    model.pushStackElement()
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null)
    model.pushStackElement()
    this.#baselines.set(path, contentHash(content))
    // Fresh disk content is the new clean baseline (the edit bumped the version)
    // — the tab stays clean, which is #353's contract. Undoing back past the
    // reload then reads as dirty, which is correct: the buffer differs from disk
    // again, and the #357 changed-on-disk save guard covers what follows.
    this.#savedVersions.set(path, model.getAlternativeVersionId())
    this.#refreshDirty(path)
    if (isActive && viewState) this.#editor?.restoreViewState(viewState)
    return true
  }

  /**
   * Restore previously-unsaved buffer content over a freshly-opened model,
   * KEEPING the on-disk content as the saved baseline so the tab comes back
   * dirty (#955 — a project switch must not destroy typed work). The edit is
   * pushed through the undo stack, so ⌘Z steps back to the disk version.
   *
   * Guards live in code, not caller convention (allowed-pattern #14): a
   * missing or binary model, an already-dirty buffer (never clobber live
   * edits), or identical content is a no-op returning false.
   */
  restoreDirtyContent(path: string, content: string): boolean {
    const model = this.#models.get(path)
    if (!model || this.#binaryPaths.has(path)) return false
    if (this.isDirty(path)) return false
    if (model.getValue() === content) return false
    // pushEditOperations (not setValue) so the restore is undoable; the content
    // change bumps the version id and #refreshDirty flags the tab dirty via the
    // model's onDidChangeContent subscription.
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null)
    return true
  }

  /** Record the current buffer as the saved state (clears dirty). */
  markSaved(path: string): void {
    const model = this.#models.get(path)
    if (!model) {
      return
    }
    this.#savedVersions.set(path, model.getAlternativeVersionId())
    if (!this.#binaryPaths.has(path)) this.#baselines.set(path, contentHash(model.getValue()))
    this.#refreshDirty(path)
  }

  /** The single editor instance — created on demand for LSP/diff phases. */
  async editorInstance(): Promise<Monaco.editor.IStandaloneCodeEditor> {
    const monaco = await monacoNamespace()
    return this.#ensureEditor(monaco)
  }

  dispose(): void {
    for (const subscription of this.#contentSubscriptions.values()) {
      subscription.dispose()
    }
    this.#contentSubscriptions.clear()
    for (const model of this.#models.values()) {
      model.dispose()
    }
    this.#models.clear()
    this.#savedVersions.clear()
    this.#dirtyFlags.clear()
    this.#binaryPaths.clear()
    this.#viewStates.clear()
    this.#baselines.clear()
    this.#modelIds.clear()
    this.#editor?.dispose()
    this.#editor = null
    this.#activePath = null
  }

  /**
   * Run an app-menu Edit action against this editor (#1338). Monaco owns undo
   * and select-all for its own model — Blink's edit commands cannot reach it,
   * because 0.55 focuses an EditContext div rather than a textarea.
   */
  runEditAction(action: 'undo' | 'redo' | 'selectAll'): void {
    const editor = this.#editor
    if (editor === null) return
    editor.focus()
    if (action === 'selectAll') {
      const model = editor.getModel()
      if (model !== null) editor.setSelection(model.getFullModelRange())
      return
    }
    // `undo`/`redo` are model-level operations exposed as editor triggers.
    editor.trigger('menu', action, null)
  }

  // ── Internals ──────────────────────────────────────────────────────────

  #ensureEditor(monaco: MonacoNamespace): Monaco.editor.IStandaloneCodeEditor {
    if (this.#editor) {
      return this.#editor
    }
    this.#editor = monaco.editor.create(this.#editorEl, {
      model: null,
      // #1339: Monaco's own "drop into editor" provider caught a file dragged
      // in from Finder and pasted its absolute path plus a literal `$0` (its
      // snippet terminator) INTO the source file — a drag that looks like
      // "open this" silently edited the buffer instead. Dropping a file is
      // handled at the shell level now; the editor must not also eat it.
      dropIntoEditor: { enabled: false },
      theme: resolveEditorThemeName(colorModeFromDataTheme(document.documentElement.dataset['theme'])),
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      fontLigatures: true,
      lineHeight: 1.5,
      // Stark chrome: no minimap, thin chromeless scrollbars, quiet gutter.
      minimap: { enabled: false },
      scrollbar: {
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        useShadows: false,
      },
      stickyScroll: { enabled: false },
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      padding: { top: 8, bottom: 8 },
      automaticLayout: true,
      fixedOverflowWidgets: true,
      tabSize: 2,
    })
    // "Add selection to chat" (#462) — mirrors the terminal's ⌘L: a non-empty
    // selection dispatches flow:add-to-chat with source:'file', which the composer
    // already renders as a context chip. Also on the right-click menu for discovery.
    this.#editor.addAction({
      id: 'flow.addSelectionToChat',
      label: 'Add selection to chat',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      run: (ed) => {
        const selection = ed.getSelection()
        const model = ed.getModel()
        const text = selection && model ? sendableSelection(model.getValueInRange(selection)) : null
        if (!text) return
        document.dispatchEvent(
          new CustomEvent('flow:add-to-chat', {
            detail: { source: 'file', text, label: fileChatLabel(this.#activePath) },
          }),
        )
      },
    })
    return this.#editor
  }

  #setModel(path: string, model: Monaco.editor.ITextModel): void {
    const editor = this.#editor
    if (!editor) {
      return
    }
    if (this.#activePath && this.#activePath !== path) {
      this.#viewStates.set(this.#activePath, editor.saveViewState())
    }
    editor.setModel(model)
    editor.updateOptions({ readOnly: this.#binaryPaths.has(path) })
    const viewState = this.#viewStates.get(path)
    if (viewState) {
      editor.restoreViewState(viewState)
    }
    this.#activePath = path
    this.#placeholder.style.display = 'none'
    editor.focus()
  }

  #refreshDirty(path: string): void {
    const model = this.#models.get(path)
    if (!model) {
      return
    }
    const dirty = model.getAlternativeVersionId() !== this.#savedVersions.get(path)
    if (this.#dirtyFlags.get(path) !== dirty) {
      this.#dirtyFlags.set(path, dirty)
      this.#onDirtyChange(path, dirty)
    }
  }
}
