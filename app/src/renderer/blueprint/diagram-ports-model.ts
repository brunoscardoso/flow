/**
 * DIAGRAM PORTS — where a curated diagram meets the rest of the system (plan
 * `diagram-entry-exit` phase 4, discovery FR-1..FR-10).
 *
 * A pure model: given the laid-out diagram (its component rectangles and its
 * extent, exactly as `layoutFlow` placed them) and the feature's ports (the one
 * CLI read, `blueprint features ports`), it answers where every port stands and
 * how its wire runs. The board turns the answer into elements and nothing else.
 *
 *   ┌ Comes in ┐               ┌ Goes out ┐
 *   │ [port]───┼──▶ [node] ───▶│──▶[port] │
 *   │ [port]───┼──▶            │          │
 *   └──────────┘   the flow    └──────────┘
 *        Linked: [port] [port]
 *
 * THE FLOW NEVER MOVES RELATIVE TO ITSELF. The columns are added OUTSIDE it:
 * the whole flow is offset right by the "in" column (`flowX`), and every
 * component keeps its place against every other — no wire is re-routed.
 *
 * A PORT STANDS BESIDE WHAT IT TOUCHES. Each one wants the vertical centre of
 * its internal component; ports that touch nothing named (`internalNode`
 * null, or a component this level does not draw) are spread around the edge's
 * centre and wired to the diagram's EDGE — never to a guessed component.
 * Overlaps are resolved top-down with a minimum gap; a column taller than the
 * flow makes the canvas taller rather than squeezing.
 *
 * COUNTS WHEN SMALL (FR-9): below `PORTS_FULL_MIN_SCALE` a port's two lines of
 * caption are unreadable, so each side collapses to a count chip — "3 in",
 * "2 out", "+N more" when the CLI capped the list.
 *
 * NOTHING WHEN NONE (FR-10): no ports → no columns, no offset, no chips.
 */

import type { FeaturePort, FeaturePorts, PortFarEnd, PortTrust } from '../../shared/ipc-contract'

// ── GEOMETRY ────────────────────────────────────────────────────────────────

/** A full port card's width. */
export const PORT_W = 196
/** The lane between a port column and the flow — where its wires run. */
export const PORT_LANE_W = 64
/** Room for the column's own heading ("Comes in" / "Goes out"). */
export const PORT_HEAD_H = 26
/** Inner padding of a port card, top + bottom together. */
export const PORT_PAD_Y = 14
/** The crossing pill's line. */
export const PORT_CROSS_H = 20
/** One caption line. */
export const PORT_LINE_H = 14
/** The "suggested by Flow" note's line. */
export const PORT_NOTE_H = 13
/** Least vertical room between two ports in a column. */
export const PORT_GAP = 10
/** The "+N more" line under a capped column. */
export const PORT_MORE_H = 18
/** Room above the linked row, below the flow and the columns. */
export const LINKED_GAP = 34
/**
 * A count chip's size, in counts mode. Large in canvas units on purpose: a
 * counts drawing is by definition one shown SMALL (a preview at ~0.5), and the
 * chip has to survive that scale.
 */
export const COUNT_W = 96
export const COUNT_H = 58
/** The lane beside a count chip. */
export const COUNT_LANE_W = 18
/** Below this drawn scale a full port is unreadable: counts instead. */
export const PORTS_FULL_MIN_SCALE = 0.62

/** How a side is drawn. */
export type PortsMode = 'full' | 'counts'

export type PortSide = 'in' | 'out' | 'linked'

/** A component's rectangle, in the flow's own coordinates. */
export interface PortNodeRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface PortRect {
  x: number
  y: number
  w: number
  h: number
}

/** The two caption lines of a port's far end (FR-3). Either may be null. */
export interface PortCaption {
  /** `project › feature` — the project omitted when local. */
  place: string | null
  /** `part`, or `file · symbol` (mono), or the raw anchor. */
  detail: string | null
}

/** Where pressing a port goes (FR-8), or why it goes nowhere. */
export type PortPress =
  | { kind: 'file'; file: string; symbol: string | null }
  | { kind: 'part'; part: string; partName: string }
  | { kind: 'feature'; project: string | null; featureId: string; featureName: string }
  | { kind: 'none' }

export interface PlacedPort {
  side: PortSide
  port: FeaturePort
  rect: PortRect
  caption: PortCaption
  /** The wire, in canvas coordinates. Null when it has nothing to join. */
  wire: string | null
  /** True when the wire ends on a component (false: on the diagram's edge). */
  wired: boolean
  /** `fb-port-trust-code | -declared | -model`. */
  trustClass: string
  /** Model trust: dashed and labelled "suggested by Flow" (FR-7). */
  suggested: boolean
  press: PortPress
}

export interface PortCount {
  side: 'in' | 'out'
  rect: PortRect
  /** "3 in" / "2 out". */
  text: string
  /** "+N more" when capped, else null. */
  more: string | null
}

export interface PortMore {
  side: PortSide
  rect: PortRect
  text: string
}

export interface PortsLayout {
  mode: PortsMode
  /** Where the flow's own origin lands on the canvas. */
  flowX: number
  flowY: number
  width: number
  height: number
  /** Column headings, full mode only. */
  heads: Array<{ side: PortSide; text: string; x: number; y: number }>
  ports: PlacedPort[]
  mores: PortMore[]
  counts: PortCount[]
  /** True when there is anything to draw at all. */
  any: boolean
}

export interface PortsLayoutInput {
  nodes: readonly PortNodeRect[]
  /** The flow's extent. */
  width: number
  height: number
  ports: FeaturePorts | null
  mode: PortsMode
}

/** Column headings — the reader's words, never the vocabulary's. */
export const PORT_HEADINGS: Record<PortSide, string> = { in: 'Comes in', out: 'Goes out', linked: 'Linked' }

/** The note a model-only port carries — the Workspace map's own words. */
export const SUGGESTED_NOTE = 'suggested by Flow'

/** Which mode a drawn scale allows. */
export function portsModeFor(scale: number): PortsMode {
  return scale >= PORTS_FULL_MIN_SCALE ? 'full' : 'counts'
}

/** True when a ports answer holds anything to draw. */
export function hasPorts(ports: FeaturePorts | null | undefined): ports is FeaturePorts {
  if (ports === null || ports === undefined) return false
  return ports.in.length + ports.out.length + ports.linked.length > 0
}

/** The style class of a trust level. */
export function trustClass(trust: PortTrust): string {
  return `fb-port-trust-${trust}`
}

/**
 * The far end's caption (FR-3): only the grain that is known, never a guess.
 * Line one is where — `project › feature`, the project left off when it is
 * this one; line two is what — the part, else `file · symbol`, else the
 * anchor's own reference.
 */
export function portCaption(far: PortFarEnd): PortCaption {
  const project = far.local ? null : (far.projectName ?? far.project ?? null)
  const feature = far.featureName ?? far.feature ?? null
  const placeBits = [project, feature].filter((bit): bit is string => bit !== null && bit.length > 0)
  const place = placeBits.length > 0 ? placeBits.join(' › ') : null
  return { place, detail: portDetail(far) }
}

function portDetail(far: PortFarEnd): string | null {
  if (far.file !== undefined) return far.symbol === undefined ? far.file : `${far.file} · ${far.symbol}`
  if (far.partName !== undefined) return far.partName
  if (far.anchor !== undefined) return anchorRef(far.anchor)
  return null
}

/** `endpoint:POST /api/x` → `POST /api/x`: the kind is the vocabulary's, the ref is the reader's. */
function anchorRef(anchor: string): string {
  const colon = anchor.indexOf(':')
  return colon > 0 ? anchor.slice(colon + 1) : anchor
}

/**
 * Where pressing a port goes (FR-8). In THIS project the finest grain wins — a
 * file's story at its function, else a part's story. Another project's file
 * or part is read from that project's own checkout, so the press goes to its
 * feature (switching project) instead; with no feature known it goes nowhere.
 */
export function portPress(far: PortFarEnd): PortPress {
  if (far.local && far.file !== undefined) return { kind: 'file', file: far.file, symbol: far.symbol ?? null }
  if (far.local && far.part !== undefined) return { kind: 'part', part: far.part, partName: far.partName ?? far.part }
  if (far.featureId !== undefined) {
    return {
      kind: 'feature',
      project: far.local ? null : (far.project ?? null),
      featureId: far.featureId,
      featureName: far.featureName ?? far.feature ?? far.featureId,
    }
  }
  return { kind: 'none' }
}

/** A port card's height: the crossing pill, the caption lines, the note. */
export function portHeight(port: FeaturePort): number {
  const caption = portCaption(port.far)
  const lines = (caption.place === null ? 0 : 1) + (caption.detail === null ? 0 : 1)
  return PORT_PAD_Y + PORT_CROSS_H + lines * PORT_LINE_H + (port.trust === 'model' ? PORT_NOTE_H : 0)
}

/**
 * Stack items in a column: each as near its wanted top as it can be, none
 * above `top`, none overlapping, `gap` apart. Order by wanted centre so a
 * port never crosses its neighbour's wire.
 */
export function stackColumn(
  items: ReadonlyArray<{ want: number; h: number }>,
  top: number,
  gap: number,
): number[] {
  const order = items.map((item, index) => ({ ...item, index })).sort((a, b) => a.want - b.want || a.index - b.index)
  const tops = new Array<number>(items.length).fill(top)
  let floor = top
  for (const item of order) {
    const y = Math.max(floor, item.want - item.h / 2)
    tops[item.index] = y
    floor = y + item.h + gap
  }
  return tops
}

/** A horizontal S-curve from (x1,y1) to (x2,y2). */
function sCurve(x1: number, y1: number, x2: number, y2: number): string {
  const mid = (x1 + x2) / 2
  return `M ${fmt(x1)} ${fmt(y1)} C ${fmt(mid)} ${fmt(y1)}, ${fmt(mid)} ${fmt(y2)}, ${fmt(x2)} ${fmt(y2)}`
}

/** A vertical S-curve from (x1,y1) down/up to (x2,y2). */
function vCurve(x1: number, y1: number, x2: number, y2: number): string {
  const mid = (y1 + y2) / 2
  return `M ${fmt(x1)} ${fmt(y1)} C ${fmt(x1)} ${fmt(mid)}, ${fmt(x2)} ${fmt(mid)}, ${fmt(x2)} ${fmt(y2)}`
}

function fmt(value: number): string {
  return value.toFixed(1)
}

function emptyLayout(input: PortsLayoutInput): PortsLayout {
  return {
    mode: input.mode,
    flowX: 0,
    flowY: 0,
    width: input.width,
    height: input.height,
    heads: [],
    ports: [],
    mores: [],
    counts: [],
    any: false,
  }
}

function countText(count: number, side: 'in' | 'out'): string {
  return `${String(count)} ${side}`
}

function moreText(count: number): string {
  return `+${String(count)} more`
}

/** Lay out a diagram's ports around its flow. */
export function layoutPorts(input: PortsLayoutInput): PortsLayout {
  const ports = input.ports
  if (!hasPorts(ports)) return emptyLayout(input)
  return input.mode === 'counts' ? layoutCounts(input, ports) : layoutFull(input, ports)
}

function layoutCounts(input: PortsLayoutInput, ports: FeaturePorts): PortsLayout {
  const inCount = ports.in.length + ports.more.in
  const outCount = ports.out.length + ports.more.out
  const colW = COUNT_W + COUNT_LANE_W
  const flowX = inCount > 0 ? colW : 0
  const width = flowX + input.width + (outCount > 0 ? colW : 0)
  const y = Math.max(0, input.height / 2 - COUNT_H / 2)
  const counts: PortCount[] = []
  if (inCount > 0) {
    counts.push({
      side: 'in',
      rect: { x: 0, y, w: COUNT_W, h: COUNT_H },
      text: countText(inCount, 'in'),
      more: ports.more.in > 0 ? moreText(ports.more.in) : null,
    })
  }
  if (outCount > 0) {
    counts.push({
      side: 'out',
      rect: { x: flowX + input.width + COUNT_LANE_W, y, w: COUNT_W, h: COUNT_H },
      text: countText(outCount, 'out'),
      more: ports.more.out > 0 ? moreText(ports.more.out) : null,
    })
  }
  return {
    mode: 'counts',
    flowX,
    flowY: 0,
    width,
    height: Math.max(input.height, COUNT_H),
    heads: [],
    ports: [],
    mores: [],
    counts,
    any: counts.length > 0,
  }
}

function layoutFull(input: PortsLayoutInput, ports: FeaturePorts): PortsLayout {
  const rectOf = new Map(input.nodes.map((node) => [node.id, node]))
  const colW = PORT_W + PORT_LANE_W
  const hasIn = ports.in.length > 0
  const hasOut = ports.out.length > 0
  const flowX = hasIn ? colW : 0
  const flowY = 0
  const placed: PlacedPort[] = []
  const mores: PortMore[] = []
  const heads: PortsLayout['heads'] = []
  let bottom = input.height

  const column = (side: 'in' | 'out', list: readonly FeaturePort[], more: number): void => {
    if (list.length === 0) return
    const x = side === 'in' ? 0 : flowX + input.width + PORT_LANE_W
    heads.push({ side, text: PORT_HEADINGS[side], x, y: 0 })
    const top = PORT_HEAD_H
    const unmatched = list.filter((port) => !matched(port, rectOf))
    const centre = Math.max(top, input.height / 2)
    // UNMATCHED PORTS SPREAD AROUND THE EDGE'S CENTRE, as one block.
    const blockH = unmatched.reduce((sum, port) => sum + portHeight(port) + PORT_GAP, 0) - PORT_GAP
    let cursor = centre - blockH / 2
    const wants = list.map((port) => {
      const h = portHeight(port)
      const node = matched(port, rectOf) ? rectOf.get(port.internalNode as string) : undefined
      if (node !== undefined) return { want: flowY + node.y + node.h / 2, h }
      const want = cursor + h / 2
      cursor += h + PORT_GAP
      return { want, h }
    })
    const tops = stackColumn(wants, top, PORT_GAP)
    list.forEach((port, index) => {
      const h = wants[index]?.h ?? portHeight(port)
      const y = tops[index] ?? top
      const rect = { x, y, w: PORT_W, h }
      placed.push(placePort(side, port, rect, rectOf, flowX, flowY, input))
      bottom = Math.max(bottom, y + h)
    })
    if (more > 0) {
      const y = Math.max(...list.map((_, index) => (tops[index] ?? top) + (wants[index]?.h ?? 0))) + PORT_GAP
      mores.push({ side, rect: { x, y, w: PORT_W, h: PORT_MORE_H }, text: moreText(more) })
      bottom = Math.max(bottom, y + PORT_MORE_H)
    }
  }
  column('in', ports.in, ports.more.in)
  column('out', ports.out, ports.more.out)

  // THE LINKED ROW — neutral, undirected, quiet, under everything (FR-4).
  const width = flowX + input.width + (hasOut ? colW : 0)
  if (ports.linked.length > 0) {
    const headY = bottom + LINKED_GAP
    heads.push({ side: 'linked', text: PORT_HEADINGS.linked, x: flowX, y: headY })
    let x = flowX
    let y = headY + PORT_HEAD_H
    let rowH = 0
    const rowRight = Math.max(flowX + PORT_W, flowX + input.width)
    for (const port of ports.linked) {
      const h = portHeight(port)
      if (x > flowX && x + PORT_W > rowRight) {
        x = flowX
        y += rowH + PORT_GAP
        rowH = 0
      }
      placed.push(placePort('linked', port, { x, y, w: PORT_W, h }, rectOf, flowX, flowY, input))
      rowH = Math.max(rowH, h)
      x += PORT_W + PORT_GAP
    }
    bottom = y + rowH
    if (ports.more.linked > 0) {
      mores.push({ side: 'linked', rect: { x: flowX, y: bottom + PORT_GAP, w: PORT_W, h: PORT_MORE_H }, text: moreText(ports.more.linked) })
      bottom += PORT_GAP + PORT_MORE_H
    }
  }
  return {
    mode: 'full',
    flowX,
    flowY,
    width: Math.max(width, flowX + PORT_W),
    height: bottom,
    heads,
    ports: placed,
    mores,
    counts: [],
    any: true,
  }
}

function matched(port: FeaturePort, rectOf: ReadonlyMap<string, PortNodeRect>): boolean {
  return port.internalNode !== null && rectOf.has(port.internalNode)
}

function placePort(
  side: PortSide,
  port: FeaturePort,
  rect: PortRect,
  rectOf: ReadonlyMap<string, PortNodeRect>,
  flowX: number,
  flowY: number,
  input: PortsLayoutInput,
): PlacedPort {
  const node = port.internalNode === null ? undefined : rectOf.get(port.internalNode)
  const cy = rect.y + rect.h / 2
  let wire: string | null
  if (side === 'in') {
    // INTO the component's left edge, or a short stub onto the diagram's edge.
    wire =
      node === undefined
        ? sCurve(rect.x + rect.w, cy, flowX, cy)
        : sCurve(rect.x + rect.w, cy, flowX + node.x, flowY + node.y + node.h / 2)
  } else if (side === 'out') {
    // OUT OF the component's right edge, into the port.
    wire =
      node === undefined
        ? sCurve(flowX + input.width, cy, rect.x, cy)
        : sCurve(flowX + node.x + node.w, flowY + node.y + node.h / 2, rect.x, cy)
  } else {
    // Linked: up from the port to the component's floor, no direction.
    wire = node === undefined ? null : vCurve(rect.x + rect.w / 2, rect.y, flowX + node.x + node.w / 2, flowY + node.y + node.h)
  }
  return {
    side,
    port,
    rect,
    caption: portCaption(port.far),
    wire,
    wired: node !== undefined,
    trustClass: trustClass(port.trust),
    suggested: port.trust === 'model',
    press: portPress(port.far),
  }
}
