/**
 * WHAT A PART'S LEVEL SHOWS (plan_feature-parts-as-nodes_v1, Phase 3) — PURE,
 * no DOM, no IPC.
 *
 * THE NODE THAT HAD NOWHERE TO GO
 * ===============================
 * A part is now a node on the ring (Phase 1 emits it, Phase 2 stops mislabelling
 * a change record as one), and `activationOf` already sends its body click to
 * `open` rather than to a drill. Until this module there was nothing behind that
 * control: `resolveLevel` only knew how to ask the CLI for a FEATURE's brief,
 * and `feature:chats/sse-events-endpoint` resolves to no feature at all.
 *
 * So the part's level is built HERE, out of material the brief already ships:
 * the owner feature's `parts` array (name, summary, anchors, learnings) and the
 * owner's curated view. Both arrive in the same response — the CLI has been
 * emitting `parts` alongside `view` for exactly this since the drawer needed it.
 *
 * ONE NAME, ONE IDENTITY
 * ======================
 * A part and a curated component are the SAME THING under two spellings: the
 * parts pass derives its names from the components the drawing named, so
 * `"SSE events endpoint"` is both the part's `name` and the component's `title`.
 * `curated-drawer.ts` already matches them on exactly that key
 * (`part.name.trim() === node.title.trim()`), and `matchCuratedComponent` below
 * repeats that rule rather than inventing a looser one — a second identity for
 * one thing is how two surfaces start disagreeing about which part a component
 * belongs to. `part-level.test.ts` holds the two matchers together against the
 * same fixture.
 *
 * TWO SOURCES, IN A FIXED ORDER
 * =============================
 *   1. THE CURATED SLICE — the part's own component plus the components it is
 *      actually wired to in the owner's view, with those wires and their
 *      labels. This is the picture the reader came for: what this piece talks
 *      to, in the drawing's own words.
 *   2. THE FILES IT NAMES — when no component carries the part's name (the
 *      owner has no curated view, or the drawing was regenerated without it),
 *      the part's own anchors are the level: one card per file, hanging off a
 *      card for the part itself.
 *
 * Neither is invented. When there is no component AND no anchor there is no
 * level, `buildPartLevel` returns null, and `level-resolve.ts` says why — with
 * the CLI's own refusal sentence when the reason is that the part anchors
 * nothing.
 *
 * IT IS ARTIFACT-SHAPED AND NEVER CLAIMS TO BE AN ARTIFACT
 * ========================================================
 * Same discipline as `derived-level.ts`: the result carries a `CuratedView` so
 * the existing `curated-*` pipeline draws it with no changes, and that view
 * says `provenance: 'part'` with an empty `generatedAt`, because no generation
 * pass wrote it and no validator has ever seen it (`validated: false`).
 *
 * SUPERSEDED LEARNINGS ARE NOT SHOWN AS CURRENT
 * =============================================
 * A part's `learnings` carry the same supersede lifecycle `## Learned` does: a
 * replaced entry is RETAINED with a `supersededReason` rather than deleted. The
 * level shows what is current and counts what was replaced — dropping the count
 * silently would make a part that has been re-learned four times look identical
 * to one learned once.
 */

import type { PartKnowledge } from './curated-drawer'
import type { CuratedEdge, CuratedLevel, CuratedNode, CuratedView } from './curated-view'
import { partNoAnchorRefusal } from './understand-action'

/** What a part level's view says it came from. Never a plan name. */
export const PART_PROVENANCE = 'part'

/** The feature a part belongs to. */
export interface PartOwner {
  /** The owner's feature id or slug — whatever the brief was fetched with. */
  id: string
  name: string
}

/** One anchor of a part, with the verdict on whether anything confirmed it. */
export interface PartAnchorStatus {
  ref: string
  /**
   * True only when one of the OWNER's resolved anchors contains this path.
   *
   * This is containment against a verdict the CLI already reached, not an
   * independent lookup — a part anchors FILES (`src/app/api/chat/[chatId]/
   * events/route.ts`) while the feature anchors DIRECTORIES
   * (`module:src/app/api/chat`), and the graph has a node for the directory,
   * not the file. Saying `true` on containment is the strongest claim the data
   * supports; claiming a file resolves to its own node would be a fabrication,
   * and claiming every part anchor is unresolved would read as a broken part.
   */
  resolved: boolean
}

/** Where a part level's picture came from. */
export type PartLevelSource =
  /** The part's component in the owner's curated view, plus what it wires to. */
  | 'curated'
  /** The files the part names, because no component carries its name. */
  | 'anchors'

export interface PartLevel {
  /** Artifact-SHAPED so the curated pipeline draws it unchanged. */
  view: CuratedView
  /** That view's root level — what the stage draws. */
  level: CuratedLevel
  source: PartLevelSource
  /** The part's own record, as the brief delivered it. */
  part: PartKnowledge
  owner: PartOwner
  /** The matched curated component, or null on an `anchors` level. */
  component: CuratedNode | null
  /** Components wired to it in the owner's view, in the view's own order. */
  neighbours: CuratedNode[]
  /** The part's anchors, each with the containment verdict above. */
  anchors: PartAnchorStatus[]
  /** Learnings still standing — never the superseded ones. */
  learnings: PartKnowledge['learnings']
  /** How many were replaced. Counted, never silently dropped. */
  supersededCount: number
  /** The sentence above the diagram. Also `level.summary`. */
  notice: string
  provenance: typeof PART_PROVENANCE
  /** ALWAYS FALSE, as a literal type. No validator has ever seen this level. */
  validated: false
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * `Chats’` / `Redis bus’s` — a feature's name is human-written and half of them
 * end in `s`. One helper so the sentence a reader meets is not the one place
 * this level looks machine-made.
 */
export function possessive(name: string): string {
  const trimmed = name.trim()
  return trimmed.endsWith('s') || trimmed.endsWith('S') ? `${trimmed}’` : `${trimmed}’s`
}

/**
 * Narrow the brief's `parts` array, which crosses IPC as
 * `Array<Record<string, unknown>>`.
 *
 * The CLI owns and validates the shape (`src/cli/blueprint/feature-store.ts`),
 * so this is the same narrowest-possible check `asCuratedView` performs: an
 * entry needs a non-empty `name` to be a part at all, and everything else falls
 * back rather than rejecting the record. A part with a name and nothing else is
 * still a part — it is one nobody has learned yet, which is a state the store
 * writes deliberately.
 */
export function readPartRecords(raw: unknown): PartKnowledge[] {
  if (!Array.isArray(raw)) return []
  const out: PartKnowledge[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const name = text(record.name)
    if (name.length === 0) continue
    const anchors = Array.isArray(record.anchors)
      ? record.anchors.map(text).filter((anchor) => anchor.length > 0)
      : []
    const learnings = Array.isArray(record.learnings)
      ? record.learnings.flatMap((item): PartKnowledge['learnings'] => {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
          const learning = item as Record<string, unknown>
          const body = text(learning.text)
          if (body.length === 0) return []
          const superseded = text(learning.supersededReason)
          return [
            {
              text: body,
              provenance: text(learning.provenance),
              date: text(learning.date),
              ...(superseded.length > 0 ? { supersededReason: superseded } : {}),
            },
          ]
        })
      : []
    out.push({ name, summary: text(record.summary), anchors, learnings })
  }
  return out
}

/**
 * The part with this name, or null.
 *
 * Trimmed exact match — the same key `curated-drawer.ts` uses, for the same
 * reason it gives: matching on anything looser attaches one part's knowledge to
 * a different piece of the system, which is worse than showing none.
 */
export function findPartRecord(
  parts: readonly PartKnowledge[],
  name: string,
): PartKnowledge | null {
  const wanted = name.trim()
  if (wanted.length === 0) return null
  return parts.find((part) => part.name.trim() === wanted) ?? null
}

/**
 * The curated component that IS this part, or null.
 *
 * Mirrors `buildCuratedDrawer`'s rule exactly (`part.name.trim() ===
 * node.title.trim()`). Deliberately compares against the RAW `title`, not the
 * `splitHeadline` result: the drawer splits for presentation after matching,
 * and matching on the split value would silently stop resolving any component
 * whose headline carries a middle dot.
 */
export function matchCuratedComponent(
  level: CuratedLevel | null,
  name: string,
): CuratedNode | null {
  const wanted = name.trim()
  if (level === null || wanted.length === 0) return null
  return level.nodes.find((node) => node.title.trim() === wanted) ?? null
}

/** Learnings still standing, and the ones a later pass replaced. */
export function splitPartLearnings(part: PartKnowledge): {
  current: PartKnowledge['learnings']
  superseded: PartKnowledge['learnings']
} {
  const learnings = part.learnings
  return {
    current: learnings.filter((entry) => entry.supersededReason === undefined),
    superseded: learnings.filter((entry) => entry.supersededReason !== undefined),
  }
}

/** Strip an anchor's `<kind>:` prefix, leaving the repo-relative path. */
/**
 * The PATH an anchor names — `file:src/a.ts` → `src/a.ts`.
 *
 * Exported so the part LEVEL's ground (`territory-level.ts`, drawn by the
 * board) reads an anchor the same way the part's own cards do. Two copies of
 * this is how a file cell and the card standing on it end up naming different
 * files (allowed-pattern #14).
 */
export function anchorPath(ref: string): string {
  const colon = ref.indexOf(':')
  const path = colon > 0 ? ref.slice(colon + 1) : ref
  return path.trim().replace(/\/+$/, '')
}

/**
 * Mark each of a part's anchors against what the OWNER's brief resolved.
 *
 * See `PartAnchorStatus.resolved` for why containment is the honest verdict
 * here rather than an exact match.
 */
export function partAnchorStatus(
  anchors: readonly string[],
  ownerAnchors: ReadonlyArray<{ ref: string; resolved: boolean }> = [],
): PartAnchorStatus[] {
  const resolvedDirs = ownerAnchors
    .filter((anchor) => anchor.resolved)
    .map((anchor) => anchorPath(anchor.ref).toLowerCase())
    .filter((path) => path.length > 0)
  return anchors.map((ref) => {
    const path = anchorPath(ref).toLowerCase()
    return {
      ref,
      resolved: resolvedDirs.some((dir) => path === dir || path.startsWith(`${dir}/`)),
    }
  })
}

/** Id grammar for the card that stands for the part itself on an anchors level. */
export function partCardId(name: string): string {
  return `part:${name.trim()}`
}

/** Id grammar for the card that stands for one anchored file. */
export function anchorCardId(ref: string): string {
  return `file:${anchorPath(ref)}`
}

/** What a file card is CALLED: its basename. Never blank — the path beats it. */
function fileTitle(ref: string): string {
  const path = anchorPath(ref)
  const slash = path.lastIndexOf('/')
  const tail = slash >= 0 ? path.slice(slash + 1) : path
  return tail.length > 0 ? tail : ref
}

/** How the part's own card is labelled where its file cards hang off it. */
export const ANCHOR_EDGE_LABEL = 'names'

/**
 * The components wired to this one in the owner's view, in the view's order.
 *
 * Direction is ignored: a part that is called BY the BFF and calls the engine
 * is between them, and showing only one side would present half a picture as
 * the whole one. The wires themselves keep their direction and their labels.
 */
export function componentNeighbours(level: CuratedLevel, id: string): CuratedNode[] {
  const adjacent = new Set<string>()
  for (const edge of level.edges) {
    if (edge.from === id) adjacent.add(edge.to)
    if (edge.to === id) adjacent.add(edge.from)
  }
  adjacent.delete(id)
  return level.nodes.filter((node) => adjacent.has(node.id))
}

/** The material a part's level is built from. */
export interface PartLevelInput {
  part: PartKnowledge
  owner: PartOwner
  /**
   * The owner's curated ROOT level, when it has a usable one. Null is the
   * ordinary case on a store whose features have never been drawn.
   */
  ownerLevel: CuratedLevel | null
  /** The owner's own anchors, as the brief resolved them. */
  ownerAnchors?: ReadonlyArray<{ ref: string; resolved: boolean }>
}

/**
 * The sentence above the diagram.
 *
 * Says where the picture came from and what it is NOT, in that order — the same
 * rule `derivedNotice` follows, and for the same reason: a diagram of real
 * components looks exactly like a curated view of the whole feature, and only
 * the words stop a reader taking a slice for the whole.
 */
function partNotice(
  input: PartLevelInput,
  source: PartLevelSource,
  neighbours: number,
  anchors: number,
  learnings: number,
  superseded: number,
): string {
  const head =
    source === 'curated'
      ? `${input.part.name} as ${input.owner.name} draws it — its component and ` +
        `${plural(neighbours, 'component')} it connects to.`
      : `The ${plural(anchors, 'file')} ${input.part.name} names. No component in ` +
        `${possessive(input.owner.name)} curated view carries this name, so this is the part's own anchors.`
  const known =
    learnings === 0
      ? 'Nothing has been learned about this part yet.'
      : `${plural(learnings, 'learning')} recorded about this part in its own right.`
  const replaced = superseded === 0 ? '' : ` ${plural(superseded, 'earlier learning')} superseded.`
  return `${head} ${known}${replaced}`
}

/**
 * Build a part's level (Task 3.2).
 *
 * Returns null when the part has neither a component in the owner's view nor an
 * anchor of its own — there is nothing to draw, and that case belongs to
 * `resolveLevel`'s empty verdict, which says WHY (and repeats the CLI's own
 * refusal when the reason is that the part anchors nothing).
 */
export function buildPartLevel(input: PartLevelInput): PartLevel | null {
  const component = matchCuratedComponent(input.ownerLevel, input.part.name)
  const anchors = partAnchorStatus(input.part.anchors, input.ownerAnchors)
  if (component === null && anchors.length === 0) return null

  const { current, superseded } = splitPartLearnings(input.part)
  const title = input.part.name.trim().length > 0 ? input.part.name.trim() : input.owner.name

  let source: PartLevelSource
  let neighbours: CuratedNode[]
  let nodes: CuratedNode[]
  let edges: CuratedEdge[]

  if (component !== null && input.ownerLevel !== null) {
    source = 'curated'
    neighbours = componentNeighbours(input.ownerLevel, component.id)
    const present = new Set([component.id, ...neighbours.map((node) => node.id)])
    // THE CENTRE FIRST, then the neighbours in the view's own order — so the
    // part the reader opened is the leftmost thing the layout can reach, and
    // the picture is deterministic for a given artifact.
    nodes = [component, ...neighbours]
    edges = input.ownerLevel.edges.filter(
      (edge) => present.has(edge.from) && present.has(edge.to),
    )
  } else {
    source = 'anchors'
    neighbours = []
    const centre: CuratedNode = {
      id: partCardId(input.part.name),
      kind: 'module',
      title,
      delta: 'stable',
      ...(input.part.summary.length > 0 ? { sub: input.part.summary, doc: input.part.summary } : {}),
    }
    const files: CuratedNode[] = anchors.map((anchor) => ({
      id: anchorCardId(anchor.ref),
      kind: 'module',
      title: fileTitle(anchor.ref),
      sub: anchorPath(anchor.ref),
      delta: 'stable',
    }))
    nodes = [centre, ...files]
    edges = files.map((file) => ({
      from: centre.id,
      to: file.id,
      label: ANCHOR_EDGE_LABEL,
      delta: 'kept' as const,
    }))
  }

  const notice = partNotice(
    input,
    source,
    neighbours.length,
    anchors.length,
    current.length,
    superseded.length,
  )

  const level: CuratedLevel = {
    title,
    // THE BAND IS THE PART'S OWN, and it names the owner — a slice of four
    // cards out of a twelve-card view is indistinguishable from a small
    // feature's whole view unless the kicker says which it is.
    kicker:
      source === 'curated'
        ? `Part of ${input.owner.name} · its slice of the curated view`
        : `Part of ${input.owner.name} · the files it names, not a curated view`,
    summary: notice,
    nodes,
    edges,
  }

  const view: CuratedView = {
    feature: input.owner.id,
    // NEVER A PLAN NAME. Nothing authored this level; it was sliced or built
    // out of a record, and `curated-nav` prints provenance.
    provenance: PART_PROVENANCE,
    // NOTHING GENERATED THIS.
    generatedAt: '',
    meta: {
      title,
      sub:
        input.part.summary.length > 0
          ? input.part.summary
          : `A part of ${input.owner.name}`,
    },
    // DELIBERATELY EMPTY, same as a derived level: `buildCuratedChrome`
    // renders a band only when the artifact supplies one, and synthesising a
    // `problem` here out of the part's prose would manufacture a KNOWN ISSUE
    // nobody wrote.
    brief: {},
    views: { root: level },
  }

  return {
    view,
    level,
    source,
    part: input.part,
    owner: input.owner,
    component,
    neighbours,
    anchors,
    learnings: current,
    supersededCount: superseded.length,
    notice,
    provenance: PART_PROVENANCE,
    validated: false,
  }
}

/**
 * WHY A PART'S LEVEL HAS NO PICTURE — the CLI's own words when they apply.
 *
 * Exported so `level-resolve.ts` reaches one sentence rather than two wordings
 * of one rule. A part with no anchors is the case
 * `blueprint features parts` already refuses IN PROSE, and that refusal is
 * repeated verbatim through `partNoAnchorRefusal` (which
 * `understand-action.test.ts` holds against the CLI source).
 */
export function partEmptyReason(part: PartKnowledge, owner: PartOwner, hasView: boolean): string {
  const tail = hasView
    ? `, and no component in ${possessive(owner.name)} curated view carries its name`
    : `, and ${owner.name} has no curated view to slice a component out of`
  return `${partNoAnchorRefusal(part.name)}${tail}`
}

/** One node of the feature graph, as much of it as the owner lookup reads. */
export interface PartOwnerLookupNode {
  id: string
  slug?: string
  name: string
  kind: string
  parent?: string
  partOf?: string
}

/**
 * The feature a part belongs to, read off the graph the board already loaded.
 *
 * Two links say the same thing and both are used, in this order: `parent` is
 * the owner's ID (what the CLI emits for a part) and `partOf` is the owner's
 * SLUG. Either resolves a brief — `blueprint brief --feature` accepts an id or
 * a slug — but the owner's NAME has to come from a node, so a link that points
 * at nothing yields null rather than a reference with a guessed label.
 */
export function findPartOwner(
  nodes: readonly PartOwnerLookupNode[],
  partId: string,
): PartOwner | null {
  const part = nodes.find((node) => node.id === partId)
  if (part === undefined) return null
  const byId = part.parent === undefined ? undefined : nodes.find((node) => node.id === part.parent)
  const bySlug =
    part.partOf === undefined ? undefined : nodes.find((node) => node.slug === part.partOf)
  const owner = byId ?? bySlug
  if (owner === undefined) return null
  return { id: owner.id, name: owner.name }
}
