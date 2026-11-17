/**
 * The pure half of the editor's breadcrumb (DOM-free, unit-tested):
 * a root-relative path split into folders, the name and its file mark.
 */

import { fileIconBadge, fileIconColor } from './file-icon-color'

export interface BreadcrumbParts {
  /** Folder names from the project root down, root-relative. */
  folders: string[]
  /** The file's own name. */
  name: string
  /** The file-tree mark for the name: a short badge, or null for the glyph. */
  badge: string | null
  color: string
}

/** Split a root-relative path into the breadcrumb's parts; null for no file. */
export function breadcrumbParts(relPath: string | null): BreadcrumbParts | null {
  if (relPath === null) return null
  const segments = relPath.split('/').filter((segment) => segment !== '')
  const name = segments.pop()
  if (name === undefined) return null
  return { folders: segments, name, badge: fileIconBadge(name), color: fileIconColor(name) }
}
