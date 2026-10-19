// Disambiguated editor tab labels (#991).
//
// Two open files with the same basename (`src/index.ts` and `tests/index.ts`)
// rendered as two identical `index.ts` tabs — same label, no tooltip, nothing on
// any channel to tell them apart. Basenames are only unique by accident, and
// index/mod/page files make collisions the NORM in real projects.
//
// The rule: a basename that is unique among the open files keeps its bare name
// (the common case stays clean); a colliding one grows the shortest suffix of
// its path that distinguishes it from the others it collides with. Every tab
// also carries its project-relative path as a tooltip, collision or not.
//
// Pure and DOM-free so it is unit-tested under the app's node-env jest.

/** One open file, as the tab strip knows it. */
export interface TabPathInfo {
  /** Tab id — the absolute path in the editor's map (opaque here). */
  id: string
  /** Root-relative path, e.g. `src/index.ts`. */
  relPath: string
  /**
   * The project root the file belongs to (#1482). In a multi-project thread
   * two repos routinely hold the SAME relative path — `src/index.ts`,
   * `README.md`, `package.json` — and the root is then the only thing that
   * tells the two tabs apart. Growing the path tail cannot help: the tails are
   * identical all the way up. Optional, so single-root callers are unchanged.
   */
  rootPath?: string
}

/** The label + tooltip a tab should show. */
export interface TabLabel {
  id: string
  label: string
  /** The unambiguous channel: the relative path, or the ABSOLUTE one when two
   *  roots hold that same relative path (#1482) — a bare `src/index.ts` read in
   *  the current project names a different file that also exists. */
  tooltip: string
}

/** The last segment of a root path — `/Users/me/code/beta` → `beta`. */
function rootName(rootPath: string): string {
  const parts = segments(rootPath)
  return parts.length === 0 ? rootPath : (parts[parts.length - 1] as string)
}

/**
 * Ids whose relative path is shared with a file from a DIFFERENT root (#1482).
 *
 * Exported because two surfaces have to agree about it: the label (which
 * qualifies by root) and the accent/tooltip pass (which must keep showing the
 * absolute path even when the thread scope no longer marks the root as
 * secondary — that scope-driven fallback is what turned the one unambiguous
 * channel into a path naming the wrong file).
 */
export function ambiguousAcrossRoots(files: readonly TabPathInfo[]): Set<string> {
  const rootsByRelPath = new Map<string, Set<string>>()
  for (const file of files) {
    if (file.rootPath === undefined) continue
    const roots = rootsByRelPath.get(file.relPath) ?? new Set<string>()
    roots.add(file.rootPath)
    rootsByRelPath.set(file.relPath, roots)
  }
  const ambiguous = new Set<string>()
  for (const file of files) {
    if (file.rootPath === undefined) continue
    if ((rootsByRelPath.get(file.relPath)?.size ?? 0) > 1) ambiguous.add(file.id)
  }
  return ambiguous
}

function segments(relPath: string): string[] {
  return relPath.split('/').filter((part) => part !== '')
}

/** The last `count` segments of a path, joined — `index.ts`, `src/index.ts`, … */
function tailOf(parts: readonly string[], count: number): string {
  return parts.slice(Math.max(0, parts.length - count)).join('/')
}

/**
 * Label every open tab, expanding ONLY the ones whose basename collides.
 * Deterministic and order-independent: the same open set always yields the same
 * labels. Files whose paths are identical (same file opened twice — shouldn't
 * happen, but total anyway) simply share a label.
 */
export function disambiguateTabLabels(files: readonly TabPathInfo[]): TabLabel[] {
  const ambiguous = ambiguousAcrossRoots(files)
  const byBasename = new Map<string, TabPathInfo[]>()
  for (const file of files) {
    const parts = segments(file.relPath)
    const base = parts.length === 0 ? file.relPath : parts[parts.length - 1]
    const bucket = byBasename.get(base)
    if (bucket === undefined) byBasename.set(base, [file])
    else bucket.push(file)
  }

  const labels: TabLabel[] = []
  for (const file of files) {
    const parts = segments(file.relPath)
    const base = parts.length === 0 ? file.relPath : parts[parts.length - 1]
    const collisions = byBasename.get(base) ?? [file]
    if (collisions.length === 1) {
      labels.push({ id: file.id, label: base, tooltip: file.relPath })
      continue
    }
    // Same relPath under two roots: no tail can separate them, so the root does.
    if (ambiguous.has(file.id) && file.rootPath !== undefined) {
      labels.push({
        id: file.id,
        label: `${rootName(file.rootPath)} ▸ ${file.relPath}`,
        tooltip: file.id,
      })
      continue
    }
    // Grow the tail until it differs from every other colliding path, capped at
    // the full path (identical paths can never be told apart — accept the tie).
    const others = collisions.filter((other) => other !== file).map((other) => segments(other.relPath))
    let depth = 2
    let label = tailOf(parts, depth)
    while (depth <= parts.length && others.some((other) => tailOf(other, depth) === label)) {
      depth += 1
      label = tailOf(parts, depth)
    }
    labels.push({ id: file.id, label, tooltip: file.relPath })
  }
  return labels
}
