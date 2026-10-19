/**
 * Artifact-marker rows — the durable trace of WHERE in a conversation a flow/
 * doc (discovery / plan / brainstorm) was first observed (#1056).
 *
 * Artifact cards used to be session-only: the pane tracked the latest doc per
 * kind in memory and re-appended its card at the FEED END on every history
 * rebuild, so reopening a thread piled every doc preview at the bottom of the
 * transcript regardless of where the doc was actually created. Main now
 * persists a compact `system` marker row at observation time — the artifact
 * watcher's event, recorded once per (thread, docPath) into the thread that
 * was active — and the renderer's history builder recognizes those rows,
 * rendering the SAME ArtifactCard inline at that transcript position.
 *
 * Writer (main, artifact-observer.ts) and reader (renderer,
 * conversation-pane.ts) share this ONE classification so the two can never
 * drift — the same shared-classifier shape as turn-failure.ts (#1048).
 */
import type { FlowArtifactKind } from './ipc-contract'

/** Machine-parseable prefix of a persisted artifact-marker system row. */
export const ARTIFACT_MARKER_PREFIX = '[artifact]'

/** A parsed marker: which doc appeared at this transcript position. */
export interface ArtifactMarker {
  kind: FlowArtifactKind
  /** Root-relative posix doc path, e.g. "flow/plans/plan_foo_v1.md". */
  path: string
  /**
   * The project root the doc lives in, when it is NOT the thread's own project
   * — a doc the agent wrote into a project attached to the thread. Absent
   * means the thread's primary project, which is every marker written before
   * attached roots were attributed (2026-10-09), so old rows parse unchanged.
   */
  root?: string
}

/** Separates a marker's path from its optional root: `<path> @<root>`. */
const ROOT_SEPARATOR = ' @'

/** The separator as the parser finds it: followed by an ABSOLUTE root (posix
 *  or a Windows drive), so a doc named `my @idea.md` stays one path. */
const ROOT_SEPARATOR_PATTERN = / @(?=\/|[A-Za-z]:[\\/])/

const MARKER_KINDS: ReadonlySet<string> = new Set<FlowArtifactKind>([
  'discovery',
  'plan',
  'brainstorm',
])

/**
 * Serialize a marker row's content: `[artifact] <kind> <path>`, plus
 * ` @<root>` for a doc in a project other than the thread's own. The root is
 * appended ONLY then, so a doc in the thread's own project keeps the exact
 * content it always had — the once-per-(thread, docPath) dedupe compares
 * content, and a new spelling would re-mark every doc an old row already holds.
 */
export function formatArtifactMarker(kind: FlowArtifactKind, path: string, root?: string): string {
  const base = `${ARTIFACT_MARKER_PREFIX} ${kind} ${path}`
  return root === undefined || root === '' ? base : `${base}${ROOT_SEPARATOR}${root}`
}

/**
 * Parse a persisted system row back into a marker, or null when the row is not
 * a marker (any other system note) or is malformed (unknown kind, no path —
 * such rows fall back to rendering as plain system lines, never crash).
 */
export function parseArtifactMarker(content: string): ArtifactMarker | null {
  if (!content.startsWith(`${ARTIFACT_MARKER_PREFIX} `)) return null
  const rest = content.slice(ARTIFACT_MARKER_PREFIX.length + 1).trim()
  const separator = rest.indexOf(' ')
  if (separator <= 0) return null
  const kind = rest.slice(0, separator)
  const tail = rest.slice(separator + 1).trim()
  // A doc path is root-relative; a root is absolute and may hold spaces
  // ("Application Support"), so the split is the first " @" before an
  // absolute path.
  const at = tail.search(ROOT_SEPARATOR_PATTERN)
  const path = (at === -1 ? tail : tail.slice(0, at)).trim()
  const root = at === -1 ? '' : tail.slice(at + ROOT_SEPARATOR.length).trim()
  if (!MARKER_KINDS.has(kind) || path.length === 0) return null
  return root.length > 0 ? { kind: kind as FlowArtifactKind, path, root } : { kind: kind as FlowArtifactKind, path }
}
