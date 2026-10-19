/**
 * Curated feature view — the SHAPE of a generated artifact, PURE, no DOM.
 *
 * WHY A SECOND MODEL
 * ==================
 * `brief-view-model.ts` decorates cards the DERIVED MAP already drew: it takes
 * a delta and paints classes and badges onto boxes that exist because an
 * extractor found a directory. That is exactly the picture the curated view was
 * built to replace, so a curated view cannot ride on it — there is no derived
 * card called "Agent core engine" to decorate.
 *
 * So this module owns WHAT a curated level contains: which components exist,
 * what every wire between them SAYS, and how that maps onto the delta
 * vocabulary the brief already speaks (`curatedToDelta`) — one delta
 * vocabulary, two sources of geometry.
 *
 * ITS GEOMETRY IS TERRITORY'S. The column diagram this module used to compute
 * (`layoutCuratedLevel` and its label ladder) was retired with the ring: a
 * curated level is drawn as a territory sheet now (`territory-level.ts`), and
 * the only geometry left here is the label truncation the canvas still needs.
 */
import type {
  BriefDeltaInput,
  BriefDeltaNode,
  BriefDeltaWire,
  BriefNodeKind,
  BriefWireDelta,
} from './brief-view-model'

/** The curated artifact, as the renderer receives it over IPC. */
export interface CuratedCode {
  file: string
  from: number
  to: number
  note: string
  noteSrc?: string
  text: string
  /**
   * The CLI's verdict on this excerpt, computed at brief time AFTER its
   * self-heal pass ran: 'shifted' survives only when the heal could not write.
   * ABSENCE means verified-fresh — the excerpt was checked against the file
   * and still sits where it says it does.
   */
  freshness?: 'shifted' | 'gone' | 'unknown'
}

export interface CuratedNode {
  id: string
  kind: string
  title: string
  sub?: string
  delta: BriefNodeKind
  phases?: number[]
  doc?: string
  now?: string
  next?: string
  view?: string
  code?: CuratedCode
  refs?: Array<[string, string]>
}

export interface CuratedEdge {
  from: string
  to: string
  label: string
  labelNext?: string
  delta: BriefWireDelta
}

export interface CuratedLevel {
  title: string
  kicker?: string
  summary?: string
  nodes: CuratedNode[]
  edges: CuratedEdge[]
}

export interface CuratedView {
  feature: string
  provenance: string
  generatedAt: string
  meta: { title: string; sub?: string }
  brief?: Record<string, unknown>
  views: Record<string, CuratedLevel>
}

/**
 * Split a component's headline into a title and a secondary line.
 *
 * The generator is asked for a short `title` plus an optional `sub`, and it
 * routinely answers with everything in `title`, separated by its own middle
 * dots: "Gateway BFF · streamTurn · /api/chat/*". Rendered whole, that
 * puts a file path on the card face — the exact thing the curated view exists
 * to stop — and overflows a fixed-width box besides.
 *
 * So the split happens here, on the model's OWN separator. This is a
 * presentation decision, not a correction: every word it wrote is kept, the
 * first segment leads and the rest become the detail line. An explicit `sub`
 * always wins, and a headline with no dot is left exactly as written.
 */
export function splitHeadline(title: string, sub?: string): { title: string; sub: string | null } {
  const parts = title.split('·').map((part) => part.trim()).filter((part) => part.length > 0)
  if (parts.length <= 1) return { title: title.trim(), sub: sub ?? null }
  const rest = parts.slice(1).join(' · ')
  return { title: parts[0], sub: sub !== undefined && sub.length > 0 ? `${sub} · ${rest}` : rest }
}

/**
 * Longest wire label drawn on the canvas.
 *
 * A generated label runs long ("send message (POST /api/chat/stream) + chat CRUD
 * via GraphQL") and at full length it runs straight through the cards it
 * connects — measured live, not guessed: at 38 characters it still overlapped.
 * Truncated here, with the full text kept for the hover title — so the canvas
 * stays readable and nothing the generator said is lost.
 */
export const WIRE_LABEL_MAX = 26

export function shortLabel(label: string): string {
  return label.length <= WIRE_LABEL_MAX ? label : `${label.slice(0, WIRE_LABEL_MAX - 1).trimEnd()}…`
}

/**
 * Map the curated level onto the delta vocabulary the brief already speaks.
 *
 * This is what lets a curated view use the settled Today ⇄ After rules — a
 * `new` component is absent today, a `removed` wire is struck after — without
 * restating any of them. The geometry is this module's; the SEMANTICS stay in
 * one place.
 */
export function curatedToDelta(level: CuratedLevel): Pick<BriefDeltaInput, 'nodes' | 'wires'> {
  const nodes: BriefDeltaNode[] = level.nodes.map((node) => ({
    nodeId: node.id,
    kind: node.delta,
    existsToday: node.delta !== 'new',
    label: node.title,
  }))
  const wires: BriefDeltaWire[] = level.edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    delta: edge.delta,
    labelBefore: edge.label,
    labelAfter: edge.labelNext ?? edge.label,
    drawnToday: edge.delta !== 'added',
  }))
  return { nodes, wires }
}

/**
 * True when this view is worth switching Today ⇄ After for.
 *
 * A view where nothing changes has one world, and offering a switch between two
 * identical pictures invites the reader to hunt for a difference that is not
 * there.
 */
export function curatedHasDelta(level: CuratedLevel): boolean {
  return (
    level.nodes.some((node) => node.delta !== 'stable') ||
    level.edges.some((edge) => edge.delta !== 'kept' || edge.labelNext !== undefined)
  )
}

/** The level to open. `root` by contract; null when the view is unusable. */
export function rootLevel(view: CuratedView | null): CuratedLevel | null {
  if (view === null) return null
  const root = view.views['root']
  return root === undefined || root.nodes.length === 0 ? null : root
}
