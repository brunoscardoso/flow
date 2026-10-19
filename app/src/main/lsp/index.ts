// LSP IPC registration — implements the contract's editor:hover /
// editor:definition / editor:completions invoke channels and broadcasts
// editor:diagnostics events, translating between LSP wire types and the
// shared contract types.
//
// The coordinator wires this after boot:
//   const lspManager = createDefaultLspManager()
//   const disposeLsp = registerLspChannels({ lspManager, projectRegistry })
//
// DOCUMENT SYNC: the contract's editor:didOpen / editor:didChange /
// editor:didClose invoke channels carry full buffer text from the renderer
// (see renderer/editor/lsp-bindings.ts — didOpen on model create, didChange
// debounced on edit, didClose on model dispose), so diagnostics are
// buffer-accurate. Defensive fallbacks remain:
//   - any document request (hover/definition/completions) still lazily
//     didOpens the file FROM DISK on first touch
//   - the project file watcher drives didChange on save for open docs and
//     didClose on unlink, covering out-of-editor modifications
//
// `rootId` interpretation: the project domain addresses roots by absolute
// rootPath (see project-registry.ts), so rootId here accepts the absolute
// rootPath — and, defensively, a RegisteredProject.id. Diagnostics events emit
// rootId = rootPath.

import { promises as fsPromises } from 'fs'
import { timed } from '../ipc/slow-handler'
import { isAbsolute, join, relative, resolve } from 'path'
import { BrowserWindow, ipcMain } from 'electron'

import type {
  CompletionItem,
  DefinitionLocation,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticsEvent,
  HoverResult,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  TextRange,
} from '../../shared/ipc-contract'
import { MAX_FILE_SIZE_BYTES } from '../project/files'
import { realPathStaysInsideRoot } from '../project/paths'
import {
  PROJECT_FILES_CHANGED_EVENT,
  PROJECT_LIST_CHANGED_EVENT,
  type ProjectFilesChangedEvent,
  type ProjectRegistry,
  type RegisteredProject,
} from '../project/project-registry'
import {
  LSP_DIAGNOSTICS_EVENT,
  LspManager,
  lspUriToPath,
  type LspCompletionItem,
  type LspDiagnostic,
  type LspDiagnosticsEvent,
  type LspHover,
  type LspLocation,
} from './lsp-manager'
import { createTypeScriptServerConfig } from './tsserver-adapter'

export interface LspChannelDependencies {
  lspManager: LspManager
  projectRegistry: ProjectRegistry
}

/** LspManager with the built-in server registry (typescript) applied. */
export function createDefaultLspManager(): LspManager {
  const manager = new LspManager()
  manager.registerServer(createTypeScriptServerConfig())
  return manager
}

/**
 * Register the editor LSP invoke handlers and wire diagnostics/watch events.
 * Returns an async dispose function that unregisters everything and resolves
 * once every language-server child has been shut down (SIGTERM → SIGKILL) —
 * the quit lifecycle awaits it so no tsserver children outlive the app.
 */
export function registerLspChannels(deps: LspChannelDependencies): () => Promise<void> {
  const { lspManager, projectRegistry } = deps
  const registered: string[] = []

  // Main-side registry of OPEN editor documents — every tab, not just files a
  // language server handles (lspManager tracks only server-backed docs). The
  // renderer sends editor:didOpen/didClose for every model create/dispose, so
  // this ref-counted map (multi-window: the same file can be open twice) is
  // the authority the project file watcher consults to exempt an open flow/ doc
  // from its batch filter (see ProjectRegistry.setOpenDocumentFilter).
  const openEditorDocs = new Map<string, number>()
  projectRegistry.setOpenDocumentFilter((path) => openEditorDocs.has(path))

  /** Contract-typed ipcMain.handle — compile error on channel/shape drift. */
  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  /** Locate the file and lazily didOpen it from disk. False → no server. */
  async function ensureOpen(rootId: string, filePath: string) {
    const root = resolveRoot(projectRegistry, rootId)
    const path = await resolveInsideRoot(root.rootPath, filePath)
    if (!lspManager.isOpen(root.rootPath, path)) {
      const text = await readDocumentFromDisk(path)
      if (text === null) {
        return { root, path, available: false }
      }
      const available = await lspManager.didOpen(root.rootPath, path, text)
      return { root, path, available }
    }
    return { root, path, available: true }
  }

  // ── Contract channels ──────────────────────────────────────────────────

  handle('editor:hover', async ({ rootId, filePath, position }) => {
    const { root, path, available } = await ensureOpen(rootId, filePath)
    if (!available) {
      return null
    }
    const hover = await lspManager.hover(root.rootPath, path, position)
    return hover ? toHoverResult(hover) : null
  })

  handle('editor:definition', async ({ rootId, filePath, position }) => {
    const { root, path, available } = await ensureOpen(rootId, filePath)
    if (!available) {
      return []
    }
    const locations = await lspManager.definition(root.rootPath, path, position)
    return toDefinitionLocations(locations, projectRegistry.getRoots())
  })

  handle('editor:completions', async ({ rootId, filePath, position }) => {
    const { root, path, available } = await ensureOpen(rootId, filePath)
    if (!available) {
      return []
    }
    const items = await lspManager.completions(root.rootPath, path, position)
    return items.map(toCompletionItem)
  })

  // ── Doc-sync channels (contract-typed since the didOpen/didChange/didClose
  // adoption — the renderer pushes buffer state on model create/change/close).

  handle('editor:didOpen', async ({ rootId, filePath, content }) => {
    const root = resolveRoot(projectRegistry, rootId)
    const path = await resolveInsideRoot(root.rootPath, filePath)
    openEditorDocs.set(path, (openEditorDocs.get(path) ?? 0) + 1)
    await lspManager.didOpen(root.rootPath, path, content)
  })
  handle('editor:didChange', async ({ rootId, filePath, content }) => {
    const root = resolveRoot(projectRegistry, rootId)
    const path = await resolveInsideRoot(root.rootPath, filePath)
    await lspManager.didChange(root.rootPath, path, content)
  })
  handle('editor:didClose', async ({ rootId, filePath }) => {
    const root = resolveRoot(projectRegistry, rootId)
    const path = await resolveInsideRoot(root.rootPath, filePath)
    const openCount = openEditorDocs.get(path) ?? 0
    if (openCount <= 1) openEditorDocs.delete(path)
    else openEditorDocs.set(path, openCount - 1)
    lspManager.didClose(root.rootPath, path)
  })

  // ── Diagnostics broadcast ──────────────────────────────────────────────

  const onDiagnostics = (event: LspDiagnosticsEvent): void => {
    const filePath = relative(event.rootPath, event.path)
    if (filePath.startsWith('..') || isAbsolute(filePath)) {
      // Outside the project root (e.g. a lib.d.ts) — nothing to mark.
      return
    }
    const payload: DiagnosticsEvent = {
      rootId: event.rootPath,
      filePath,
      diagnostics: event.diagnostics.map(toDiagnostic),
    }
    broadcast('editor:diagnostics', payload)
  }
  lspManager.on(LSP_DIAGNOSTICS_EVENT, onDiagnostics)

  // ── Watcher-driven doc sync (save-accurate; see header) ────────────────

  const onFilesChanged = (event: ProjectFilesChangedEvent): void => {
    for (const change of event.changes) {
      if (change.type === 'deleted') {
        lspManager.didClose(event.rootPath, change.path)
        continue
      }
      if (change.type === 'changed' && lspManager.isOpen(event.rootPath, change.path)) {
        void readDocumentFromDisk(change.path)
          .then((text) => {
            if (text !== null) {
              return lspManager.didChange(event.rootPath, change.path, text)
            }
            return undefined
          })
          .catch((error) => {
            console.error('[LSP] Failed to sync changed file', { path: change.path, error })
          })
      }
    }
  }
  projectRegistry.on(PROJECT_FILES_CHANGED_EVENT, onFilesChanged)

  // Shut down servers for roots that get removed from the app.
  let knownRootPaths = new Set(projectRegistry.getRoots().map((root) => root.rootPath))
  const onRootsChanged = (roots: RegisteredProject[]): void => {
    const nextRootPaths = new Set(roots.map((root) => root.rootPath))
    for (const rootPath of knownRootPaths) {
      if (!nextRootPaths.has(rootPath)) {
        void lspManager.disposeRoot(rootPath).catch((error) => {
          console.error('[LSP] Failed to dispose servers for removed root', { rootPath, error })
        })
      }
    }
    knownRootPaths = nextRootPaths
  }
  projectRegistry.on(PROJECT_LIST_CHANGED_EVENT, onRootsChanged)

  return async function disposeLspChannels(): Promise<void> {
    for (const channel of registered) {
      ipcMain.removeHandler(channel)
    }
    registered.length = 0
    lspManager.off(LSP_DIAGNOSTICS_EVENT, onDiagnostics)
    projectRegistry.off(PROJECT_FILES_CHANGED_EVENT, onFilesChanged)
    projectRegistry.off(PROJECT_LIST_CHANGED_EVENT, onRootsChanged)
    projectRegistry.setOpenDocumentFilter(null)
    openEditorDocs.clear()
    try {
      await lspManager.dispose()
    } catch (error) {
      console.error('[LSP] Failed to dispose LSP manager', error)
    }
  }
}

// ── Root / path resolution (renderer input is untrusted) ──────────────────

function resolveRoot(projectRegistry: ProjectRegistry, rootId: string): RegisteredProject {
  const roots = projectRegistry.getRoots()
  const byPath = roots.find((root) => root.rootPath === resolve(rootId))
  if (byPath) {
    return byPath
  }
  const byId = roots.find((root) => root.id === rootId)
  if (byId) {
    return byId
  }
  throw new Error(`[LSP] Unknown project: ${rootId}`)
}

/**
 * Root-relative path → contained absolute path (rejects escapes). Lexical
 * check first, then a physical one: a symlink inside the root must not
 * resolve outside it.
 */
async function resolveInsideRoot(rootPath: string, relPath: string): Promise<string> {
  const targetPath = resolve(join(rootPath, relPath))
  const relativeToRoot = relative(rootPath, targetPath)
  if (relativeToRoot === '' || relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    throw new Error(`[LSP] Path escapes the project folder: ${relPath}`)
  }
  if (!(await realPathStaysInsideRoot(rootPath, targetPath))) {
    throw new Error(`[LSP] Path escapes the project folder: ${relPath}`)
  }
  return targetPath
}

/** UTF-8 text of `path`, or null for missing/oversized/binary files. */
async function readDocumentFromDisk(path: string): Promise<string | null> {
  try {
    const stats = await fsPromises.stat(path)
    if (!stats.isFile() || stats.size > MAX_FILE_SIZE_BYTES) {
      return null
    }
    const buffer = await fsPromises.readFile(path)
    if (buffer.subarray(0, 8192).includes(0)) {
      return null
    }
    return buffer.toString('utf8')
  } catch {
    return null
  }
}

// ── LSP → contract translation ─────────────────────────────────────────────

function toHoverResult(hover: LspHover): HoverResult | null {
  const contents = normalizeHoverContents(hover.contents)
  if (!contents) {
    return null
  }
  return { contents, ...(hover.range ? { range: hover.range as TextRange } : {}) }
}

function normalizeHoverContents(contents: LspHover['contents']): string {
  if (typeof contents === 'string') {
    return contents
  }
  if (Array.isArray(contents)) {
    return contents
      .map((entry) => normalizeHoverContents(entry))
      .filter((part) => part.length > 0)
      .join('\n\n')
  }
  if ('kind' in contents) {
    return contents.value
  }
  // MarkedString { language, value } → fenced code block.
  return contents.value ? `\`\`\`${contents.language}\n${contents.value}\n\`\`\`` : ''
}

function toDefinitionLocations(
  locations: LspLocation[],
  roots: RegisteredProject[],
): DefinitionLocation[] {
  const results: DefinitionLocation[] = []
  for (const location of locations) {
    const path = lspUriToPath(location.uri)
    if (!path) {
      continue
    }
    const root = containingRoot(path, roots)
    if (!root) {
      // Definition outside every project root (global libs) — the renderer
      // has no surface to open it in v1.
      continue
    }
    results.push({
      rootId: root.rootPath,
      filePath: relative(root.rootPath, path),
      range: location.range as TextRange,
    })
  }
  return results
}

/** Longest-prefix project root containing `path`, if any. */
function containingRoot(path: string, roots: RegisteredProject[]): RegisteredProject | null {
  let best: RegisteredProject | null = null
  for (const root of roots) {
    const relativeToRoot = relative(root.rootPath, path)
    if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
      continue
    }
    if (!best || root.rootPath.length > best.rootPath.length) {
      best = root
    }
  }
  return best
}

/** LSP CompletionItemKind (1–25) → contract kind strings. */
const COMPLETION_KIND_NAMES: Record<number, string> = {
  1: 'text',
  2: 'method',
  3: 'function',
  4: 'constructor',
  5: 'field',
  6: 'variable',
  7: 'class',
  8: 'interface',
  9: 'module',
  10: 'property',
  11: 'unit',
  12: 'value',
  13: 'enum',
  14: 'keyword',
  15: 'snippet',
  16: 'color',
  17: 'file',
  18: 'reference',
  19: 'folder',
  20: 'enumMember',
  21: 'constant',
  22: 'struct',
  23: 'event',
  24: 'operator',
  25: 'typeParameter',
}

function toCompletionItem(item: LspCompletionItem): CompletionItem {
  const documentation =
    typeof item.documentation === 'string' ? item.documentation : item.documentation?.value
  return {
    label: item.label,
    kind: COMPLETION_KIND_NAMES[item.kind ?? 1] ?? 'text',
    insertText: item.insertText ?? item.label,
    ...(item.detail ? { detail: item.detail } : {}),
    ...(documentation ? { documentation } : {}),
  }
}

const DIAGNOSTIC_SEVERITIES: Record<number, DiagnosticSeverity> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
}

function toDiagnostic(diagnostic: LspDiagnostic): Diagnostic {
  return {
    range: diagnostic.range as TextRange,
    severity: DIAGNOSTIC_SEVERITIES[diagnostic.severity ?? 3] ?? 'info',
    message: diagnostic.message,
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
  }
}

/** Send a contract event to every open window (mirrors ipc/index.ts). */
function broadcast<C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventPayload<C>,
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}
