/**
 * Merge-conflict CodeLens (#66; reworked for the inline per-hunk resolver,
 * conflict-UX Phase 4).
 *
 * Over every conflict hunk in the active file, this emits inline controls as
 * CodeLens links, left-to-right:
 *
 *   Accept Current   Accept Incoming   Accept Both   Compare   ✨ Resolve with AI
 *
 * The three Accept lenses (conflict-UX v2 wording — Current → ours stage,
 * Incoming → theirs stage, Both → both) resolve ONLY their hunk via
 * `git:resolveConflictHunk` (through the shared `resolveHunkAndRecord`), then
 * refresh the buffer from disk so sibling hunks and the remaining count stay live
 * — the same disk-truth refresh the inline-diff review uses. The action words are
 * disambiguated by Phase 1's per-side identity annotation on each marker line, so
 * the labels no longer interpolate a branch name. The "Compare" lens opens a
 * read-only two-side Monaco diff of the hunk's two sides as an editor tab
 * (renderer-only). The "Resolve with AI" lens still fires the decoupled
 * `flow:resolve-conflict` event (the AI orchestration owns the picker + prefill).
 *
 * The Keep lenses need the file's (rootId, repo-relative path), resolved once per
 * file from the project roots and cached; until that resolves (or when it
 * can't), only the AI lens shows. Non-`file:` models (e.g. the dedicated
 * resolver's own read-only buffer, which floats its own control bars) are skipped.
 *
 * Registered globally (`'*'`) so it coexists with the LSP CodeLens/diagnostic
 * providers on their own owners. The provider re-runs on model content change, so
 * lenses appear/disappear as conflicts are introduced or resolved.
 */
import type * as Monaco from 'monaco-editor'

import type { ConflictHunkChoice, ConflictHunkOrder } from '../../shared/conflict-hunks'
import type { FlowNotificationLevel } from '../../shared/ipc-contract'
import type { SideIdentity } from '../../shared/side-identity'
import { parseConflicts, modelHasConflictMarker, type ConflictBlock } from './conflict-parser'
import { hunkControlSpecs } from './conflict-hunk-controls'
import { resolveHunkAndRecord } from './conflict-hunk-actions'
import {
  CONFLICT_SIDE_DECORATION_CSS,
  sideDecorationRanges,
} from './conflict-decorations'
import { conflictAnnotationText } from './conflict-annotation'
import { openHunkCompare, type HunkCompareRequest } from './conflict-compare-view'
import { onThemeChanged } from '../theme/theme-controller'
import type { EditorApi } from './index'

export const RESOLVE_CONFLICT_EVENT = 'flow:resolve-conflict'

/** Inline class for the dimmed per-side marker-line identity annotation. */
const ANNOTATION_CLASS = 'fl-conflict-annotation'

export interface ResolveConflictDetail {
  /** The model's file path (uri.path) — advisory context for the glue. */
  filePath: string
}

/** The (root, repo-relative path) a file resolves to, plus a side-B branch
 *  fallback from merge state and the two sides' resolved identities. `null` means
 *  the file could not be mapped to a project root — only the AI lens is offered
 *  then. Identities are best-effort: absent when `readConflicted` fails or omits
 *  them, and their absence never blocks the Keep lenses or the decorations. */
interface FileContext {
  rootId: string
  filePath: string
  incomingBranch?: string
  oursIdentity?: SideIdentity
  theirsIdentity?: SideIdentity
}

/** A live identity-annotation content widget, keyed by its stable id suffix, with
 *  the line + text it was last rendered for. Used to reconcile (add/remove/update)
 *  widgets across refreshes instead of tearing every one down each keystroke. */
interface AnnotationEntry {
  widget: Monaco.editor.IContentWidget
  line: number
  text: string
}

/** The desired state of one annotation for a refresh — the reconcile target. */
interface DesiredAnnotation {
  /** Stable id suffix, e.g. `${hunkId}-a`. Doubles as the reconcile map key. */
  id: string
  line: number
  text: string
}

/** The command payload an Accept lens carries (all JSON-serializable). */
interface HunkResolvePayload {
  rootId: string
  filePath: string
  absPath: string
  hunkId: string
  choice: ConflictHunkChoice
  order?: ConflictHunkOrder
}

/** The command payload a Compare lens carries (all JSON-serializable). */
interface HunkComparePayload {
  absPath: string
  hunkId: string
  currentText: string
  incomingText: string
}

/**
 * Register the conflict CodeLens provider on the shared Monaco instance. Safe to
 * call once after initEditor; returns a disposer.
 */
export async function initConflictCodeLens(editorApi: EditorApi): Promise<() => void> {
  const monaco = await editorApi.monaco()
  const editor = await editorApi.editor()

  // Per-file (root, path) resolution cache: undefined = not started,
  // 'pending' = in flight, null = unresolvable, FileContext = ready.
  const contextByPath = new Map<string, FileContext | 'pending' | null>()

  const onDidChange = new monaco.Emitter<Monaco.languages.CodeLensProvider>()

  // The AI lens command — dispatches the decoupled document event.
  const aiCommandId = editor.addCommand(0, (_accessor, filePath: unknown) => {
    document.dispatchEvent(
      new CustomEvent<ResolveConflictDetail>(RESOLVE_CONFLICT_EVENT, {
        detail: { filePath: typeof filePath === 'string' ? filePath : '' },
      }),
    )
  })

  // The Accept-Current/Incoming/Both command — resolves one hunk, then refreshes disk.
  const hunkCommandId = editor.addCommand(0, (_accessor, payload: unknown) => {
    if (isHunkPayload(payload)) void handleHunkResolve(editorApi, editor, payload)
  })

  // The Compare command — opens a read-only two-side diff of the hunk's two sides
  // as an editor tab. Renderer-only; no hunk resolution, no disk write.
  const compareCommandId = editor.addCommand(0, (_accessor, payload: unknown) => {
    if (isComparePayload(payload)) void handleCompare(editorApi, payload)
  })

  const provider: Monaco.languages.CodeLensProvider = {
    onDidChange: onDidChange.event,
    provideCodeLenses(model) {
      // Only real files carry resolvable conflicts; skip the resolver's own
      // buffer + any non-file model so its floating bars aren't duplicated.
      if (model.uri.scheme !== 'file') return { lenses: [], dispose: () => {} }

      // Cheap no-conflict gate (#1784): probe the model for a marker before any
      // full-buffer work — a marker-free file pays neither the getValue copy nor
      // the parse on the per-keystroke refresh cycle.
      if (!modelHasConflictMarker(model)) return { lenses: [], dispose: () => {} }

      const blocks = parseConflicts(model.getValue())
      if (blocks.length === 0) return { lenses: [], dispose: () => {} }

      const context = resolveContext(model.uri.path)
      const lenses: Monaco.languages.CodeLens[] = []
      // Row order: Accept Current | Accept Incoming | Accept Both | Compare | ✨ Resolve with AI.
      // The Accept lenses need a resolved file context (root + repo path); Compare
      // and the AI lens are renderer-only and always render.
      blocks.forEach((block, index) => {
        if (context) {
          lenses.push(...keepLenses(monaco, block, index, hunkCommandId, context, model.uri.path))
        }
        lenses.push(compareLens(monaco, block, index, compareCommandId, model.uri.path))
        lenses.push(aiLens(monaco, block, index, aiCommandId, model.uri.path))
      })
      return { lenses, dispose: () => {} }
    },
    resolveCodeLens(_model, lens) {
      return lens
    },
  }

  const registration = monaco.languages.registerCodeLensProvider('*', provider)

  // Colored side tint + per-side identity annotation in the REAL editor (not the
  // merge tab). The tint is a decoration collection; the annotation is a set of
  // Monaco content widgets anchored just after each marker line (injected-text
  // `after` decorations do NOT render in this standalone Monaco build, so the
  // annotation uses the proven content-widget mechanism instead — same as the
  // merge tab's floating bars). Both refresh on every content/model change and once
  // identities load.
  injectEditorConflictStyles()
  const sideDecorations = editor.createDecorationsCollection([])
  // Live annotation widgets, keyed by id suffix, reconciled across refreshes.
  const annotationWidgets = new Map<string, AnnotationEntry>()
  // Dedup guard: the last (model uri, versionId) a refresh actually recomputed for.
  let lastRefresh: { uri: string; versionId: number } | null = null
  // The canvas ruler colour, resolved once (getComputedStyle) and refreshed only on
  // a theme flip — never per keystroke.
  let cachedRulerColor: string | null = null

  /** Remove every rendered identity-annotation content widget. */
  function clearAnnotationWidgets(): void {
    for (const entry of annotationWidgets.values()) {
      editor.removeContentWidget(entry.widget)
    }
    annotationWidgets.clear()
  }

  const contentSub = editor.onDidChangeModelContent(() => {
    onDidChange.fire(provider)
    refreshDecorations()
  })
  const modelSub = editor.onDidChangeModel(() => {
    onDidChange.fire(provider)
    refreshDecorations()
  })
  // Re-resolve the canvas ruler colour when the theme flips (light to dark) and
  // force a refresh past the version guard (the version id is unchanged on a flip).
  const themeSub = onThemeChanged(() => {
    cachedRulerColor = resolveConflictRulerColor()
    refreshDecorations(true)
  })

  /** Return a ready FileContext, or null while pending/unresolvable. Kicks off
   *  a one-time async resolution on first sight of a path. */
  function resolveContext(absPath: string): FileContext | null {
    const cached = contextByPath.get(absPath)
    if (cached === 'pending') return null
    if (cached === null) return null
    if (cached) return cached

    contextByPath.set(absPath, 'pending')
    void resolveFileContext(absPath)
      .then((context) => {
        contextByPath.set(absPath, context)
        onDidChange.fire(provider) // re-provide now that Keep lenses are available
        // Force past the version guard: the buffer is unchanged but the newly
        // resolved per-side identities must now render.
        refreshDecorations(true) // re-tint now that per-side identities are known
      })
      .catch((error: unknown) => {
        console.warn('flow: failed to resolve conflict file context', { absPath, error })
        contextByPath.set(absPath, null)
      })
    return null
  }

  /** Recompute the side tint + annotation decorations for the active model. Clears
   *  when the model is not a real file or holds no conflicts. Never throws.
   *
   *  Fast paths, cheapest first: (1) a version guard skips the whole refresh when the
   *  model's (uri, versionId) is unchanged since the last recompute — deduping the
   *  content/model/identity/theme triggers that fire for one state; `force` bypasses
   *  it for identity-load and theme flips, which change the render without touching
   *  the buffer. (2) A no-conflict gate probes the model for a `<<<<<<<` marker
   *  (findMatches, limit 1) and returns before any text materialization or parse.
   *  (3) Otherwise the parsed blocks are shared with
   *  the tint/marker/annotation computation, and the annotation widgets are
   *  reconciled (add/remove/update) rather than torn down and rebuilt. */
  function refreshDecorations(force = false): void {
    const model = editor.getModel()
    if (!model || model.uri.scheme !== 'file') {
      clearAnnotationWidgets()
      sideDecorations.set([])
      lastRefresh = null
      return
    }

    const uri = model.uri.toString()
    const versionId = model.getVersionId()
    if (!force && lastRefresh && lastRefresh.uri === uri && lastRefresh.versionId === versionId) {
      return
    }
    lastRefresh = { uri, versionId }

    // Cheap no-conflict gate — probe the model instead of materializing the text
    // (#1784), so a marker-free buffer is rejected without an O(document) copy.
    // Marker-free also means any prior merge on this path is done, so drop its
    // cached identity (L6) too.
    if (!modelHasConflictMarker(model)) {
      clearAnnotationWidgets()
      sideDecorations.set([])
      contextByPath.delete(model.uri.path)
      return
    }

    const blocks = parseConflicts(model.getValue())
    if (blocks.length === 0) {
      clearAnnotationWidgets()
      sideDecorations.set([])
      return
    }

    const context = resolveContext(model.uri.path)
    // Overview-ruler marker colour is canvas-rendered (CSS vars don't resolve there),
    // so read the concrete `--fl-color-warning` value once and cache it; a theme
    // switch (themeSub) re-resolves it before a forced refresh.
    if (cachedRulerColor === null) cachedRulerColor = resolveConflictRulerColor()
    const rulerColor = cachedRulerColor
    const decos: Monaco.editor.IModelDeltaDecoration[] = []
    const desired: DesiredAnnotation[] = []
    for (const block of blocks) {
      pushSideTint(monaco, decos, block)
      pushOverviewMarker(monaco, decos, block, rulerColor)
      collectSideAnnotations(desired, block, context)
    }
    reconcileAnnotationWidgets(model, desired)
    sideDecorations.set(decos)
  }

  /** Collect the desired per-side identity annotations for one block: side A on the
   *  `<<<<<<<` line, side B on the `>>>>>>>` line. Identity is best-effort — absent
   *  context still yields the marker-label / branch fallback via
   *  {@link conflictAnnotationText}. */
  function collectSideAnnotations(
    out: DesiredAnnotation[],
    block: ConflictBlock,
    context: FileContext | null,
  ): void {
    const aText = conflictAnnotationText(context?.oursIdentity, {
      side: 'a',
      fallbackLabel: block.oursLabel,
    })
    out.push({ id: `${block.hunkId}-a`, line: block.startLine, text: aText })

    const bText = conflictAnnotationText(context?.theirsIdentity, {
      side: 'b',
      fallbackLabel: block.theirsLabel ?? context?.incomingBranch,
    })
    out.push({ id: `${block.hunkId}-b`, line: block.endLine, text: bText })
  }

  /** Reconcile the mounted annotation widgets to the desired set: remove widgets no
   *  longer desired, add new ones, and re-mount only those whose line or text
   *  changed. Unchanged widgets are left in place — no full teardown when the hunk
   *  set is stable. */
  function reconcileAnnotationWidgets(
    model: Monaco.editor.ITextModel,
    desired: DesiredAnnotation[],
  ): void {
    const desiredIds = new Set(desired.map((entry) => entry.id))
    for (const [id, entry] of annotationWidgets) {
      if (!desiredIds.has(id)) {
        editor.removeContentWidget(entry.widget)
        annotationWidgets.delete(id)
      }
    }
    for (const target of desired) {
      const existing = annotationWidgets.get(target.id)
      if (existing && existing.line === target.line && existing.text === target.text) {
        continue // unchanged — leave the mounted widget in place
      }
      if (existing) {
        editor.removeContentWidget(existing.widget)
        annotationWidgets.delete(target.id)
      }
      const widget = createAnnotationWidget(model, target.line, target.text, target.id)
      editor.addContentWidget(widget)
      annotationWidgets.set(target.id, { widget, line: target.line, text: target.text })
    }
  }

  /** Build one identity-annotation content widget anchored just after `line`'s last
   *  column (an end-of-line look), carrying the {@link ANNOTATION_CLASS} so existing
   *  selectors match. Mounting + tracking is the reconciler's job. */
  function createAnnotationWidget(
    model: Monaco.editor.ITextModel,
    line: number,
    text: string,
    idSuffix: string,
  ): Monaco.editor.IContentWidget {
    const column = model.getLineMaxColumn(line)
    const node = document.createElement('span')
    node.className = ANNOTATION_CLASS
    node.textContent = `    ${text}`
    return {
      getId: () => `fl-conflict-annotation-${idSuffix}`,
      getDomNode: () => node,
      getPosition: () => ({
        position: { lineNumber: line, column },
        preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
      }),
    }
  }

  refreshDecorations()

  return () => {
    contentSub.dispose()
    modelSub.dispose()
    themeSub()
    registration.dispose()
    onDidChange.dispose()
    sideDecorations.clear()
    clearAnnotationWidgets()
  }
}

/** The concrete colour for the scrollbar overview-ruler conflict markers, resolved
 *  from the `--fl-color-warning` token (the overview ruler is canvas-rendered, so a
 *  CSS `var()` cannot be used directly). Falls back to a fixed amber. */
function resolveConflictRulerColor(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--fl-color-warning')
    .trim()
  return value || '#cca700'
}

/** One overview-ruler marker per conflict hunk (full lane), so the scrollbar shows
 *  where every conflict is and clicking a mark scrolls to it. One mark per hunk (not
 *  per side) — two colours at ruler scale would just read as noise. */
function pushOverviewMarker(
  monaco: typeof Monaco,
  decos: Monaco.editor.IModelDeltaDecoration[],
  block: ConflictBlock,
  color: string,
): void {
  decos.push({
    range: new monaco.Range(block.startLine, 1, block.endLine, 1),
    options: {
      overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Full },
    },
  })
}

/** Push the whole-line + gutter tint for both sides of one block, from the shared
 *  decoration recipe (conflict-decorations). Base regions stay neutral. */
function pushSideTint(
  monaco: typeof Monaco,
  decos: Monaco.editor.IModelDeltaDecoration[],
  block: ConflictBlock,
): void {
  for (const range of sideDecorationRanges(block)) {
    decos.push({
      range: new monaco.Range(range.startLine, 1, range.endLine, 1),
      options: {
        isWholeLine: true,
        className: range.lineClassName,
        linesDecorationsClassName: range.gutterClassName,
      },
    })
  }
}

let editorConflictStylesInjected = false

/** Inject the real-editor conflict styles once: the shared two-side tint plus the
 *  dimmed annotation class. The annotation renders as a content widget span, so it
 *  must not intercept editor pointer events and must preserve its leading padding.
 *  All colors resolve to theme tokens. */
function injectEditorConflictStyles(): void {
  if (editorConflictStylesInjected) return
  editorConflictStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
${CONFLICT_SIDE_DECORATION_CSS}
    .${ANNOTATION_CLASS} {
      color: var(--fl-color-text-secondary);
      font-style: italic;
      opacity: 0.85;
      white-space: pre;
      pointer-events: none;
    }
  `
  document.head.appendChild(style)
}

/** The "✨ Resolve with AI" lens for one block. */
function aiLens(
  monaco: typeof Monaco,
  block: ConflictBlock,
  index: number,
  commandId: string | null,
  filePath: string,
): Monaco.languages.CodeLens {
  return {
    range: new monaco.Range(block.startLine, 1, block.startLine, 1),
    id: `resolve-conflict-ai-${index}`,
    command: commandId
      ? { id: commandId, title: '✨ Resolve with AI', arguments: [filePath] }
      : undefined,
  }
}

/** The Accept Current / Accept Incoming / Accept Both lenses for one block. Labels
 *  are the fixed v2 wording (identity-independent); the per-side annotation on each
 *  marker line is the disambiguator. */
function keepLenses(
  monaco: typeof Monaco,
  block: ConflictBlock,
  index: number,
  commandId: string | null,
  context: FileContext,
  absPath: string,
): Monaco.languages.CodeLens[] {
  return hunkControlSpecs().map((spec, specIndex) => {
    const payload: HunkResolvePayload = {
      rootId: context.rootId,
      filePath: context.filePath,
      absPath,
      hunkId: block.hunkId,
      choice: spec.choice,
      ...(spec.order ? { order: spec.order } : {}),
    }
    return {
      range: new monaco.Range(block.startLine, 1, block.startLine, 1),
      id: `resolve-conflict-${spec.key}-${index}-${specIndex}`,
      command: commandId ? { id: commandId, title: spec.label, arguments: [payload] } : undefined,
    }
  })
}

/** The "Compare" lens for one block — opens a read-only two-side diff of the
 *  hunk's two sides. Carries only the hunk's own text (no context needed). */
function compareLens(
  monaco: typeof Monaco,
  block: ConflictBlock,
  index: number,
  commandId: string | null,
  absPath: string,
): Monaco.languages.CodeLens {
  const payload: HunkComparePayload = {
    absPath,
    hunkId: block.hunkId,
    currentText: block.oursText,
    incomingText: block.theirsText,
  }
  return {
    range: new monaco.Range(block.startLine, 1, block.startLine, 1),
    id: `resolve-conflict-compare-${index}`,
    command: commandId ? { id: commandId, title: 'Compare', arguments: [payload] } : undefined,
  }
}

/**
 * Resolve one hunk, then refresh the active buffer from disk so the lenses
 * re-provide against the post-splice text (disk-truth, like inline-diff). Any
 * failure surfaces a toast and leaves the buffer untouched.
 */
async function handleHunkResolve(
  editorApi: EditorApi,
  editor: Monaco.editor.IStandaloneCodeEditor,
  payload: HunkResolvePayload,
): Promise<void> {
  try {
    const outcome = await resolveHunkAndRecord({
      rootId: payload.rootId,
      filePath: payload.filePath,
      hunkId: payload.hunkId,
      choice: payload.choice,
      order: payload.order,
    })
    if (!outcome.matched) {
      notify('warn', 'Nothing to resolve', 'That conflict was already resolved. Refreshing.')
    } else if (outcome.remainingConflicts === 0) {
      notify('info', 'Conflict resolved', `Resolved the last conflict in ${baseName(payload.filePath)}.`)
    }
    await refreshModelFromDisk(editorApi, editor, payload)
  } catch (error) {
    console.error('flow: failed to resolve conflict hunk', { payload, error })
    notify('error', 'Resolve failed', 'Could not resolve that conflict. Nothing was changed.')
  }
}

/**
 * Open the hunk-scoped two-side Compare diff as an editor tab. Renderer-only —
 * the two sides' text is already in-hand from the parsed block, so nothing hits
 * disk or IPC. A failure surfaces a toast and changes nothing.
 */
async function handleCompare(editorApi: EditorApi, payload: HunkComparePayload): Promise<void> {
  const request: HunkCompareRequest = {
    absPath: payload.absPath,
    hunkId: payload.hunkId,
    currentText: payload.currentText,
    incomingText: payload.incomingText,
    // The file path drives language colorization for both panes.
    languagePath: payload.absPath,
  }
  try {
    await openHunkCompare(editorApi, request)
  } catch (error) {
    console.error('flow: failed to open conflict compare', { payload, error })
    notify('error', 'Compare failed', 'Could not open the side-by-side comparison. Nothing was changed.')
  }
}

/**
 * Re-read the file and, if it is still the active model, sync the buffer to the
 * post-splice text (re-fires the lens provider).
 *
 * Routed through `EditorApi.syncBufferFromDisk` rather than editing the model
 * directly (#1097). Flow wrote this file itself and the buffer is being brought
 * INTO agreement with disk, so the tab must end clean: a bare model edit bumped
 * the version id, flipped the tab dirty for content the user never typed, and
 * the watcher event for Flow's own write then found a dirty tab and warned
 * "File changed on disk — saving will overwrite that change" in the middle of a
 * merge, with a ⌘S that asked to overwrite "the newer version". The editor api
 * owns the buffer's saved baseline, so it is the only place that can move
 * content and baseline together.
 */
async function refreshModelFromDisk(
  editorApi: EditorApi,
  editor: Monaco.editor.IStandaloneCodeEditor,
  payload: HunkResolvePayload,
): Promise<void> {
  const fresh = await window.flow.git.readConflicted({
    rootId: payload.rootId,
    filePath: payload.filePath,
  })
  if ('oversize' in fresh) return
  const model = editor.getModel()
  if (!model || model.uri.path !== payload.absPath) return
  editorApi.syncBufferFromDisk(payload.absPath, fresh.markered)
}

/** Map an absolute file path to its owning project root + repo-relative path,
 *  plus the merge-state incoming branch for a side-B fallback label. */
async function resolveFileContext(absPath: string): Promise<FileContext | null> {
  const roots = await window.flow.project.list()
  const normalizedPath = normalizePath(absPath)

  // Longest matching rootPath wins (nested roots).
  let best: { rootId: string; filePath: string } | null = null
  let bestRootLen = -1
  for (const root of roots) {
    const rootPath = normalizePath(root.rootPath).replace(/\/+$/, '')
    if (normalizedPath === rootPath || normalizedPath.startsWith(`${rootPath}/`)) {
      if (rootPath.length > bestRootLen) {
        bestRootLen = rootPath.length
        best = { rootId: root.rootPath, filePath: normalizedPath.slice(rootPath.length).replace(/^\/+/, '') }
      }
    }
  }
  if (!best) return null

  const mergeState = await window.flow.git
    .mergeState({ rootId: best.rootId })
    .catch(() => null)

  // Best-effort per-side identity for the colored annotations. A read failure or
  // an oversize file leaves the identities undefined — the lenses and the side
  // tint still render from marker labels alone.
  const identity = await readSideIdentities(best.rootId, best.filePath)

  return {
    rootId: best.rootId,
    filePath: best.filePath,
    ...(mergeState?.incomingBranch ? { incomingBranch: mergeState.incomingBranch } : {}),
    ...(identity.oursIdentity ? { oursIdentity: identity.oursIdentity } : {}),
    ...(identity.theirsIdentity ? { theirsIdentity: identity.theirsIdentity } : {}),
  }
}

/** Read the two sides' identities from `readConflicted`, degrading to an empty
 *  result on any failure or oversize file so identity absence never breaks the
 *  lenses or decorations. */
async function readSideIdentities(
  rootId: string,
  filePath: string,
): Promise<{ oursIdentity?: SideIdentity; theirsIdentity?: SideIdentity }> {
  try {
    const conflicted = await window.flow.git.readConflicted({ rootId, filePath })
    if ('oversize' in conflicted) return {}
    return {
      ...(conflicted.oursIdentity ? { oursIdentity: conflicted.oursIdentity } : {}),
      ...(conflicted.theirsIdentity ? { theirsIdentity: conflicted.theirsIdentity } : {}),
    }
  } catch (error) {
    console.warn('flow: failed to read side identities for conflict lenses', {
      rootId,
      filePath,
      error,
    })
    return {}
  }
}

/** Runtime guard for the command payload (Monaco types command args as unknown). */
function isHunkPayload(value: unknown): value is HunkResolvePayload {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.rootId === 'string' &&
    typeof record.filePath === 'string' &&
    typeof record.absPath === 'string' &&
    typeof record.hunkId === 'string' &&
    (record.choice === 'ours' || record.choice === 'theirs' || record.choice === 'both')
  )
}

/** Runtime guard for the Compare command payload (Monaco types command args as unknown). */
function isComparePayload(value: unknown): value is HunkComparePayload {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.absPath === 'string' &&
    typeof record.hunkId === 'string' &&
    typeof record.currentText === 'string' &&
    typeof record.incomingText === 'string'
  )
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function baseName(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return slash === -1 ? filePath : filePath.slice(slash + 1)
}

function notify(level: FlowNotificationLevel, title: string, body: string): void {
  document.dispatchEvent(
    new CustomEvent('flow:notify', {
      detail: {
        kind: 'state-change',
        rootId: '',
        title,
        body,
        timestamp: new Date().toISOString(),
        level,
      },
    }),
  )
}
