// How a changed file is drawn in Source Control: name first, folder after
// (list view), or nested under its folders (tree view), with a file-type mark.
// Pure and DOM-free; git-panel.ts renders what this returns.

/** A path split the way the row prints it: the name, then its folder dimmed. */
export interface PathParts {
  name: string
  /** The folder, '' at the project root. Never ends in '/'. */
  dir: string
}

/**
 * `app/src/a.ts` → { name: 'a.ts', dir: 'app/src' }. A rolled-up untracked
 * folder (`app/new/`) is named after itself, so it reads `new  app` rather
 * than an empty name.
 */
export function splitPath(path: string): PathParts {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const slash = trimmed.lastIndexOf('/')
  if (slash === -1) return { name: trimmed, dir: '' }
  return { name: trimmed.slice(slash + 1), dir: trimmed.slice(0, slash) }
}

export type FileIconTone = 'ts' | 'js' | 'test' | 'md' | 'json' | 'css' | 'html' | 'py' | 'img' | 'folder' | 'plain'

export interface FileIcon {
  /** Two or three characters, drawn as a small mark — the file type, not an emoji. */
  label: string
  tone: FileIconTone
}

/** The small type mark before a file name (VS Code's file icon, in text). */
export function fileIconFor(path: string): FileIcon {
  if (path.endsWith('/')) return { label: '', tone: 'folder' }
  const name = splitPath(path).name.toLowerCase()
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) {
    return { label: /\.[cm]?jsx?$/.test(name) ? 'JS' : 'TS', tone: 'test' }
  }
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return { label: 'TS', tone: 'ts' }
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return { label: 'JS', tone: 'js' }
    case 'md':
    case 'mdx':
      return { label: 'MD', tone: 'md' }
    case 'json':
    case 'jsonc':
      return { label: '{}', tone: 'json' }
    case 'css':
    case 'scss':
    case 'less':
      return { label: '#', tone: 'css' }
    case 'html':
    case 'htm':
      return { label: '<>', tone: 'html' }
    case 'py':
      return { label: 'PY', tone: 'py' }
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
      return { label: 'IMG', tone: 'img' }
    default:
      return { label: '', tone: 'plain' }
  }
}

/** One row of a section in tree view: a folder, or one of the section's items. */
export type TreeRow<T> =
  | { kind: 'folder'; path: string; label: string; depth: number; collapsed: boolean; count: number }
  | { kind: 'item'; item: T; depth: number }

interface FolderNode<T> {
  name: string
  path: string
  folders: Map<string, FolderNode<T>>
  items: T[]
  count: number
}

/**
 * Nest a section's items under their folders, VS Code style: folders first,
 * alphabetical; a chain of single-child folders compacts into one row
 * (`app/src/renderer`); a collapsed folder hides what is under it.
 *
 * `pathOf` says where an item lives; `childrenOf` returns rows that must follow
 * an item one level deeper (an expanded untracked folder's files) — they are
 * not placed in the tree themselves.
 */
export function buildTreeRows<T>(
  items: readonly T[],
  pathOf: (item: T) => string,
  collapsed: ReadonlySet<string>,
  childrenOf: (item: T) => readonly T[] = () => [],
): Array<TreeRow<T>> {
  const root: FolderNode<T> = { name: '', path: '', folders: new Map(), items: [], count: 0 }
  for (const item of items) {
    const { dir } = splitPath(pathOf(item))
    let node = root
    node.count += 1
    if (dir !== '') {
      let walked = ''
      for (const segment of dir.split('/')) {
        walked = walked === '' ? segment : `${walked}/${segment}`
        let next = node.folders.get(segment)
        if (next === undefined) {
          next = { name: segment, path: walked, folders: new Map(), items: [], count: 0 }
          node.folders.set(segment, next)
        }
        next.count += 1
        node = next
      }
    }
    node.items.push(item)
  }

  const rows: Array<TreeRow<T>> = []
  const emitItems = (node: FolderNode<T>, depth: number): void => {
    const sorted = [...node.items].sort((a, b) =>
      splitPath(pathOf(a)).name.localeCompare(splitPath(pathOf(b)).name),
    )
    for (const item of sorted) {
      rows.push({ kind: 'item', item, depth })
      for (const child of childrenOf(item)) rows.push({ kind: 'item', item: child, depth: depth + 1 })
    }
  }
  const walk = (node: FolderNode<T>, depth: number): void => {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))
    for (const folder of folders) {
      // Compact single-child chains: a folder holding only one folder and no
      // files is not worth a row of its own.
      let current = folder
      let label = folder.name
      while (current.items.length === 0 && current.folders.size === 1) {
        const only = [...current.folders.values()][0]
        if (only === undefined) break
        current = only
        label = `${label}/${only.name}`
      }
      const isCollapsed = collapsed.has(current.path)
      rows.push({ kind: 'folder', path: current.path, label, depth, collapsed: isCollapsed, count: current.count })
      if (!isCollapsed) walk(current, depth + 1)
    }
    emitItems(node, depth)
  }
  walk(root, 0)
  return rows
}

/** The persisted list/tree choice. */
export type ChangesViewMode = 'list' | 'tree'
export const VIEW_MODE_KEY = 'flow.git.viewMode.v1'

export function parseViewMode(raw: string | null): ChangesViewMode {
  return raw === 'tree' ? 'tree' : 'list'
}
