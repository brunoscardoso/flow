/**
 * HOW CONNECTIONS ARE DRAWN on the Workspace sheet — PURE, no DOM.
 *
 * The first cut drew one line per link from cell centre to cell centre: a web
 * across every cell between two projects, which the user rejected ("those
 * edges are not good"). The agreed shape (mockup v3):
 *
 *  • AT THE ROOT, NOTHING SELECTED — ONE RIBBON PER PAIR OF PROJECTS, drawn
 *    between the FACING EDGES of their two countries (so it runs through the
 *    gutter, never across cells), as thick as the number of links between them,
 *    with that number in a small pill at its middle.
 *  • A FEATURE SELECTED — short curves from THAT cell's edge to the edge of each
 *    feature it connects to; an end that names no feature on the map runs to its
 *    project's country instead. Every other line steps back.
 *  • ZOOMED INTO ONE PROJECT — its links to other projects run OFF THE EDGE of
 *    the sheet, each labelled with the other project's name.
 *
 * Every decision is here, with tests; the board only turns these into SVG.
 */

import type { BlueprintWorkspaceLink, BlueprintWorkspaceLinkEnd } from '../../shared/ipc-contract'
import type { Rect } from './territory-layout'

/** A point on a rectangle's border, and the outward direction it leaves in. */
export interface EdgePoint {
  x: number
  y: number
  /** Outward unit normal — one of (±1, 0) or (0, ±1). */
  nx: number
  ny: number
}

/** How far in from a corner a facing point is kept, when the rects do not overlap. */
const CORNER_CLEARANCE = 12

/**
 * The point on `a`'s border that faces `b`, and its outward normal.
 *
 * Side-to-side when the two are mostly beside each other, top-to-bottom when
 * they are mostly stacked (normalised by their sizes, so a wide country beside
 * a tall one picks the side that actually faces). Along that side the point
 * sits in the middle of the span the two rectangles SHARE, so two neighbours
 * are joined straight across the gutter between them; with no shared span it
 * is the point nearest the other's centre, kept clear of the corner.
 */
export function facingPoint(a: Rect, b: Rect): EdgePoint {
  const acx = a.x + a.w / 2
  const acy = a.y + a.h / 2
  const bcx = b.x + b.w / 2
  const bcy = b.y + b.h / 2
  const dx = bcx - acx
  const dy = bcy - acy
  const horizontal = Math.abs(dx) / Math.max(1, a.w + b.w) >= Math.abs(dy) / Math.max(1, a.h + b.h)
  const clamp = (value: number, lo: number, hi: number): number => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, value)))
  if (horizontal) {
    const lo = Math.max(a.y, b.y)
    const hi = Math.min(a.y + a.h, b.y + b.h)
    const y = lo < hi ? (lo + hi) / 2 : clamp(bcy, a.y + CORNER_CLEARANCE, a.y + a.h - CORNER_CLEARANCE)
    return dx >= 0 ? { x: a.x + a.w, y, nx: 1, ny: 0 } : { x: a.x, y, nx: -1, ny: 0 }
  }
  const lo = Math.max(a.x, b.x)
  const hi = Math.min(a.x + a.w, b.x + b.w)
  const x = lo < hi ? (lo + hi) / 2 : clamp(bcx, a.x + CORNER_CLEARANCE, a.x + a.w - CORNER_CLEARANCE)
  return dy >= 0 ? { x, y: a.y + a.h, nx: 0, ny: 1 } : { x, y: a.y, nx: 0, ny: -1 }
}

/** A cubic from `p` to `q` leaving and arriving along their normals. */
export function curvePath(p: EdgePoint, q: EdgePoint, reach: number): string {
  const r = (value: number): string => String(Math.round(value * 10) / 10)
  return (
    `M${r(p.x)},${r(p.y)} ` +
    `C${r(p.x + p.nx * reach)},${r(p.y + p.ny * reach)} ` +
    `${r(q.x + q.nx * reach)},${r(q.y + q.ny * reach)} ` +
    `${r(q.x)},${r(q.y)}`
  )
}

// ─── The root: one ribbon per pair of projects ──────────────────────────────

/** The thinnest ribbon, and how much each further link adds. */
export const RIBBON_BASE = 3
export const RIBBON_STEP = 2.5
/** No ribbon is thicker than this — twenty links must not become a wall. */
export const RIBBON_MAX = 18
/** How far a ribbon bulges out of each country before turning. */
export const RIBBON_REACH = 34

export function ribbonWidth(count: number): number {
  return Math.min(RIBBON_MAX, RIBBON_BASE + Math.max(1, count) * RIBBON_STEP)
}

export interface Ribbon {
  /** `a~b`, the two slugs sorted — one ribbon per unordered pair. */
  key: string
  a: string
  b: string
  count: number
  width: number
  from: EdgePoint
  to: EdgePoint
  path: string
  /** Where the count pill sits — the ribbon's middle, nudged off the curve. */
  pill: { x: number; y: number }
  /**
   * NEIGHBOURS ARE BRIDGED, NOT CURVED. When the two blocks face each other
   * across a narrow gutter, a curve has nowhere to go and only its pill showed
   * (live, 2026-10-06). Then the ribbon is a band filling the gutter along the
   * shared edge, as long as the pair has links — null for a real curve.
   */
  bridge: { x: number; y: number; w: number; h: number } | null
}

/** A gutter this narrow (or narrower) is bridged rather than curved. */
export const BRIDGE_MAX_GAP = 48
/** A bridge's length along the shared edge: a base plus a step per link. */
export const BRIDGE_BASE = 28
export const BRIDGE_STEP = 18

/**
 * The band across a narrow gutter between two facing points, or null when the
 * two do not face each other straight across it (opposite normals on the same
 * axis, within BRIDGE_MAX_GAP).
 */
export function bridgeBetween(
  from: EdgePoint,
  to: EdgePoint,
  count: number,
  shared: number,
): { x: number; y: number; w: number; h: number } | null {
  const length = Math.max(12, Math.min(shared - 8, BRIDGE_BASE + Math.max(1, count) * BRIDGE_STEP))
  if (from.nx !== 0 && from.nx === -to.nx) {
    const gap = Math.abs(to.x - from.x)
    if (gap > BRIDGE_MAX_GAP) return null
    return { x: Math.min(from.x, to.x), y: from.y - length / 2, w: gap, h: length }
  }
  if (from.ny !== 0 && from.ny === -to.ny) {
    const gap = Math.abs(to.y - from.y)
    if (gap > BRIDGE_MAX_GAP) return null
    return { x: from.x - length / 2, y: Math.min(from.y, to.y), w: length, h: gap }
  }
  return null
}

/** How much of their facing sides two rectangles share (0 when none). */
function sharedSpan(a: Rect, b: Rect, horizontal: boolean): number {
  return horizontal
    ? Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
    : Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
}

/** The unordered pair key of two project slugs. */
export function pairKey(a: string, b: string): string {
  return a <= b ? `${a}~${b}` : `${b}~${a}`
}

/**
 * One ribbon per pair of projects that have links between them. A link with
 * an end in a project that is not drawn (it left the Workspace) is not a pair
 * on this sheet; a link inside one project cannot be recorded, and is skipped
 * if it ever appears.
 */
export function projectRibbons(
  links: readonly BlueprintWorkspaceLink[],
  countries: ReadonlyMap<string, Rect>,
): Ribbon[] {
  const counts = new Map<string, { a: string; b: string; count: number }>()
  for (const link of links) {
    const a = link.from.project
    const b = link.to.project
    if (a === b || !countries.has(a) || !countries.has(b)) continue
    const key = pairKey(a, b)
    const entry = counts.get(key) ?? { a: a <= b ? a : b, b: a <= b ? b : a, count: 0 }
    entry.count += 1
    counts.set(key, entry)
  }
  const ribbons: Ribbon[] = []
  for (const [key, { a, b, count }] of [...counts.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const ra = countries.get(a) as Rect
    const rb = countries.get(b) as Rect
    const from = facingPoint(ra, rb)
    const to = facingPoint(rb, ra)
    const bridge = bridgeBetween(from, to, count, sharedSpan(ra, rb, from.nx !== 0))
    ribbons.push({
      key,
      a,
      b,
      count,
      width: ribbonWidth(count),
      from,
      to,
      path: curvePath(from, to, RIBBON_REACH),
      pill:
        bridge === null
          ? { x: (from.x + to.x) / 2 + (from.nx + to.nx) * 6, y: (from.y + to.y) / 2 + (from.ny + to.ny) * 6 }
          : { x: bridge.x + bridge.w / 2, y: bridge.y + bridge.h / 2 },
      bridge,
    })
  }
  return ribbons
}

// ─── A selected feature ─────────────────────────────────────────────────────

/** The reach of a feature line — short, so it reads as a hop and not a web. */
export const FEATURE_REACH = 26

/** A drawn cell, by its sheet key. */
export interface PlacedCell {
  project: string
  id: string
  rect: Rect
}

/** One line from the selected feature to a thing it connects to. */
export interface FeatureLine {
  key: string
  from: EdgePoint
  to: EdgePoint
  path: string
  /** The cell key it lands on, or null when it lands on a country or off the edge. */
  toCell: string | null
  /** The project the far end is in. */
  toProject: string
  /** True when the far end is not on this sheet. */
  offEdge: boolean
  /** The other project's name, for a line that leaves the sheet. */
  label: string | null
  /**
   * True when EVERY connection behind the line was suggested by the fast model
   * (drawn lighter). One a person recorded, or code proved, makes it solid.
   */
  suggested: boolean
}

/** A connection only the fast model vouches for. */
export function isSuggested(link: BlueprintWorkspaceLink): boolean {
  return link.learned === 'model'
}

/** Whether a link end touches the feature `id` of `project`. */
function endTouches(end: BlueprintWorkspaceLinkEnd, project: string, id: string): boolean {
  return end.project === project && end.features.includes(id)
}

/** The links one feature takes part in, each with the end that is its own. */
export function linksOfFeature(
  links: readonly BlueprintWorkspaceLink[],
  project: string,
  id: string,
): { link: BlueprintWorkspaceLink; own: BlueprintWorkspaceLinkEnd; other: BlueprintWorkspaceLinkEnd; forward: boolean }[] {
  const out: { link: BlueprintWorkspaceLink; own: BlueprintWorkspaceLinkEnd; other: BlueprintWorkspaceLinkEnd; forward: boolean }[] = []
  for (const link of links) {
    if (endTouches(link.from, project, id)) out.push({ link, own: link.from, other: link.to, forward: true })
    else if (endTouches(link.to, project, id)) out.push({ link, own: link.to, other: link.from, forward: false })
  }
  return out
}

/** Every cell key the selected feature is connected to, itself included. */
export function connectedCellKeys(
  links: readonly BlueprintWorkspaceLink[],
  project: string,
  id: string,
  keyOf: (project: string, id: string) => string,
): Set<string> {
  const out = new Set<string>([keyOf(project, id)])
  for (const { other } of linksOfFeature(links, project, id)) {
    for (const feature of other.features) out.add(keyOf(other.project, feature))
  }
  return out
}

/** Where a line leaves the sheet: a sliver just past its right edge, level with `from`. */
function offEdgeTarget(sheet: Rect, y: number): Rect {
  return { x: sheet.x + sheet.w + 2, y: y - 1, w: 1, h: 2 }
}


// ─── Zoomed into one project: links leave the sheet ─────────────────────────

/** The least vertical room between two edge labels. */
export const EDGE_LABEL_SPACING = 16

/**
 * Inside one project, every link to another project runs from the feature's
 * cell to the sheet's right edge, labelled with the other project's name. One
 * line per (feature, other project); labels are spaced so none sits on another.
 * A feature not drawn on this level (it lives one depth away) draws nothing.
 */
export function offEdgeLines(input: {
  links: readonly BlueprintWorkspaceLink[]
  project: string
  /** Cell rects on this level, by FEATURE ID. */
  cells: ReadonlyMap<string, Rect>
  sheet: Rect
  projectName: (slug: string) => string
}): FeatureLine[] {
  const wanted: { id: string; other: string; rect: Rect; suggested: boolean }[] = []
  const byKey = new Map<string, { suggested: boolean }>()
  for (const link of input.links) {
    const sides: [BlueprintWorkspaceLinkEnd, BlueprintWorkspaceLinkEnd][] = [
      [link.from, link.to],
      [link.to, link.from],
    ]
    for (const [own, other] of sides) {
      if (own.project !== input.project || other.project === input.project) continue
      for (const id of own.features) {
        const rect = input.cells.get(id)
        const key = `${id}|${other.project}`
        if (rect === undefined) continue
        const drawn = byKey.get(key)
        if (drawn !== undefined) {
          if (!isSuggested(link)) drawn.suggested = false
          continue
        }
        const entry = { id, other: other.project, rect, suggested: isSuggested(link) }
        byKey.set(key, entry)
        wanted.push(entry)
      }
    }
  }
  // Labels top to bottom, each at least EDGE_LABEL_SPACING below the last,
  // starting from where its cell is — so a label stays beside its feature.
  wanted.sort((a, b) => a.rect.y + a.rect.h / 2 - (b.rect.y + b.rect.h / 2) || a.id.localeCompare(b.id) || a.other.localeCompare(b.other))
  let lastY = -Infinity
  const top = input.sheet.y + EDGE_LABEL_SPACING / 2
  return wanted.map(({ id, other, rect, suggested }) => {
    const y = Math.max(top, rect.y + rect.h / 2, lastY + EDGE_LABEL_SPACING)
    lastY = y
    const edge = offEdgeTarget(input.sheet, y)
    const from = facingPoint(rect, { x: edge.x, y, w: 1, h: 1 })
    const to: EdgePoint = { x: edge.x, y, nx: -1, ny: 0 }
    return {
      key: `${id}|${other}`,
      from,
      to,
      path: curvePath(from, to, FEATURE_REACH),
      toCell: null,
      toProject: other,
      offEdge: true,
      label: input.projectName(other),
      suggested,
    }
  })
}

// ─── In words ───────────────────────────────────────────────────────────────

/** How a connection the fast model found is named wherever it is said. */
export const SUGGESTED_BY_FLOW = 'suggested by Flow'

/** A link's verb read from its `from` side, and from its `to` side. */
const FORWARD: Record<BlueprintWorkspaceLink['kind'], string> = {
  calls: 'calls',
  exposes: 'exposes',
  consumes: 'consumes',
  relates: 'relates to',
}
const BACKWARD: Record<BlueprintWorkspaceLink['kind'], string> = {
  calls: 'is called by',
  exposes: 'consumes',
  consumes: 'is consumed by',
  relates: 'relates to',
}

/** What an end is called: its feature's name, else the thing it names. */
function endName(end: BlueprintWorkspaceLinkEnd, featureName: (project: string, id: string) => string | undefined): string {
  for (const id of end.features) {
    const name = featureName(end.project, id)
    if (name !== undefined) return end.features.length > 1 ? `${name} (+${String(end.features.length - 1)})` : name
  }
  const colon = end.ref.indexOf(':')
  return end.type === 'anchor' && colon >= 0 ? end.ref.slice(colon + 1) : end.ref
}

/**
 * The foot's sentences for one feature — "Chats consumes Chat Engine in
 * orbit-core" — one per link, in the store's order.
 */
export function connectionSentences(input: {
  links: readonly BlueprintWorkspaceLink[]
  project: string
  id: string
  featureName: (project: string, id: string) => string | undefined
  projectName: (slug: string) => string
}): string[] {
  return linksOfFeature(input.links, input.project, input.id).map(({ link, own, other, forward }) => {
    const verb = forward ? FORWARD[link.kind] : BACKWARD[link.kind]
    const note = link.note === undefined ? '' : ` (${link.note})`
    const by = isSuggested(link) ? ` · ${SUGGESTED_BY_FLOW}` : ''
    return `${endName(own, input.featureName)} ${verb} ${endName(other, input.featureName)} in ${input.projectName(other.project)}${note}${by}`
  })
}

// ─── Every connection, feature to feature (2026-10-06) ──────────────────────

/**
 * Up to this many connections, the sheet at rest draws EACH ONE between the
 * features it joins (user, 2026-10-06: "it's not clear how the number 2 is
 * connected, connected to where?"). A count in a gutter says two projects
 * share something; a line from Tenant to Core says what. Past this many the
 * lines would cross into a tangle, and the per-pair ribbons come back.
 */
export const ALL_LINES_LIMIT = 12

export interface LinkLine {
  key: string
  from: EdgePoint
  to: EdgePoint
  path: string
  /** The cell keys the line joins (null: that end is drawn to its project). */
  fromCell: string | null
  toCell: string | null
  suggested: boolean
  /** "Tenant in orbit-app calls Core in orbit-core" — the line's hover. */
  sentence: string
}

/** Whether the sheet at rest draws every connection as its own line. */
export function drawsEveryLink(links: readonly BlueprintWorkspaceLink[]): boolean {
  return links.length > 0 && links.length <= ALL_LINES_LIMIT
}

/** Every cell a connection touches — lit on the sheet while the lines are drawn. */
export function linkedCellKeys(links: readonly BlueprintWorkspaceLink[], keyOf: (project: string, id: string) => string): Set<string> {
  const keys = new Set<string>()
  for (const link of links) for (const end of [link.from, link.to]) for (const id of end.features) keys.add(keyOf(end.project, id))
  return keys
}

/**
 * One line per connection, cell edge to cell edge. An end that touches a
 * feature drawn here lands on that cell (the first, when it touches several);
 * an end that touches none lands on its project's block. A connection whose
 * ends are both missing from the sheet draws nothing.
 */
export function allLinkLines(input: {
  links: readonly BlueprintWorkspaceLink[]
  cells: ReadonlyMap<string, PlacedCell>
  countries: ReadonlyMap<string, Rect>
  keyOf: (project: string, id: string) => string
  featureName: (project: string, id: string) => string | undefined
  projectName: (slug: string) => string
}): LinkLine[] {
  const lines: LinkLine[] = []
  const seen = new Set<string>()
  const place = (end: BlueprintWorkspaceLinkEnd): { key: string | null; rect: Rect } | null => {
    for (const id of end.features) {
      const key = input.keyOf(end.project, id)
      const cell = input.cells.get(key)
      if (cell !== undefined) return { key, rect: cell.rect }
    }
    const country = input.countries.get(end.project)
    return country === undefined ? null : { key: null, rect: country }
  }
  for (const link of input.links) {
    const a = place(link.from)
    const b = place(link.to)
    if (a === null || b === null) continue
    const key = `${a.key ?? link.from.project}|${b.key ?? link.to.project}|${link.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    const from = facingPoint(a.rect, b.rect)
    const to = facingPoint(b.rect, a.rect)
    const note = link.note === undefined ? '' : ` (${link.note})`
    lines.push({
      key,
      from,
      to,
      path: curvePath(from, to, FEATURE_REACH),
      fromCell: a.key,
      toCell: b.key,
      suggested: isSuggested(link),
      sentence:
        `${endName(link.from, input.featureName)} in ${input.projectName(link.from.project)} ${FORWARD[link.kind]} ` +
        `${endName(link.to, input.featureName)} in ${input.projectName(link.to.project)}${note}${isSuggested(link) ? ` · ${SUGGESTED_BY_FLOW}` : ''}`,
    })
  }
  return lines
}

