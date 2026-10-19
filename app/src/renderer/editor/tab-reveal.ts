/**
 * Map an absolute editor-tab id (tab ids ARE absolute file paths) to the
 * { rootPath, relPath } pair the guarded `project:revealPath` channel expects
 * (#1063).
 *
 * Returns null when the path lies outside every known project root — the
 * caller then hides/skips the reveal rather than handing main an absolute path
 * it would reject (R-2). Pure and separator-normalizing so it unit-tests on any
 * platform. When roots nest, the innermost (longest) match wins.
 */

interface RootLike {
  rootPath: string
}

function normalizeSep(p: string): string {
  return p.replace(/\\/g, '/')
}

export function splitProjectPath(
  absPath: string,
  roots: readonly RootLike[],
): { rootPath: string; relPath: string } | null {
  const target = normalizeSep(absPath)
  let best: { rootPath: string; relPath: string; rootLen: number } | null = null

  for (const { rootPath } of roots) {
    const root = normalizeSep(rootPath).replace(/\/+$/, '')
    let candidate: { rootPath: string; relPath: string } | null = null
    if (target === root) {
      candidate = { rootPath, relPath: '' }
    } else if (target.startsWith(`${root}/`)) {
      candidate = { rootPath, relPath: target.slice(root.length + 1) }
    }
    if (candidate && (!best || root.length > best.rootLen)) {
      best = { ...candidate, rootLen: root.length }
    }
  }

  return best ? { rootPath: best.rootPath, relPath: best.relPath } : null
}
