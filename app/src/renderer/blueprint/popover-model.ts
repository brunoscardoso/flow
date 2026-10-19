/**
 * Node-popover content model — pure assembly (no DOM), consumed by the board's
 * NodePopover (node-popover.ts). Turns a displayed FlowNode plus its underlying
 * graph node(s), annotations, plan-feature list, and rolled-up must-review items
 * into a flat, escaped-at-render content object: kind eyebrow, label + mono id,
 * capped annotation lines, feature membership, ghost/plan badge, review reason
 * lines, and action availability. Deterministic — same inputs, same output.
 *
 * FEATURE MEMBERSHIP SOURCE: the `blueprint:features` channel (BlueprintFeature[],
 * read by main from plan files — CLI-INDEPENDENT, so it works on the basic board
 * too), matched by FILE CONTAINMENT against the node's sourceFile. Chosen over
 * graph node meta, which carries no feature attribution at all.
 */
import type {
  BlueprintAnnotation,
  BlueprintAnnotationType,
  BlueprintFeature,
  BlueprintInvestigation,
  BlueprintLearningEntry,
  BlueprintLearningStatus,
  BlueprintMustReviewItem,
  BlueprintNode,
  BlueprintNodeKind,
  BlueprintProposalState,
} from '../../shared/ipc-contract'
import { annotationsForNodes, fileMatchesNode } from './annotation-matching'
import { ignoreSource } from '../../shared/learn-ignore'
import { moduleOfPath } from './territory-layout'
import type { FlowNode } from './flow-model'
import { firstAnchorPeekPath } from './peek-anchor'

/** Max annotation lines shown in the popover; the rest fold into '…and K more'. */
export const MAX_POPOVER_ANNOTATIONS = 4

/** Inputs to the popover's ONE tab-selection decision (#1029). */
export interface TabSelectionInput {
  /** Selectable tab keys, in tab-bar order (an empty panel's tab is hidden). */
  visible: readonly string[]
  /** The tab showing right now — carried across a same-node refresh. */
  active: string | null
  /** `active` was chosen by the USER (a tab click), not by an automatic rule. */
  userSelected: boolean
  /** The tab an automatic rule wants to lead with (Changes while the changeset
   *  is engaged, #898; Overview for a routes/peer card), or null. */
  lead: string | null
}

/**
 * Which tab the popover should show after a (re)render — the single decision
 * every automatic refresh and every lead-with rule runs through.
 *
 * The ordering IS the fix for #1029: an EXPLICIT user selection outranks any
 * automatic re-activation, so a background working-tree change refreshes the
 * Changes tab's contents without yanking the reader off the Review tab they
 * chose. Automatic leads still win on a fresh open (nothing was selected yet),
 * and a selection whose tab has since disappeared falls back gracefully.
 *
 * Pure — no DOM, no popover state.
 */
export function resolveActiveTab(input: TabSelectionInput): string | null {
  const visible = input.visible
  const isVisible = (key: string | null): key is string => key !== null && visible.includes(key)
  if (input.userSelected && isVisible(input.active)) return input.active
  if (isVisible(input.lead)) return input.lead
  if (isVisible(input.active)) return input.active
  return visible.length > 0 ? visible[0] : null
}

const MODULE_ID_PREFIX = 'module:'

/** Learn-action affordance surfaced by the Understanding section / dot. */
export type LearningAction = 'learn' | 'relearn'

/**
 * ONE learning vocabulary, read by every surface. The panel row, the
 * popover's Understanding section, and the card-dot tooltip used to state the
 * same fact in three dialects — `none` / "Not yet learned" / "Understanding:
 * none" — and named the same act "Update" on a row but "Re-learn" in the
 * popover. The words live here (DOM-free, already every surface's model
 * import) so the dialects cannot come back one file at a time.
 */
export const LEARN_STATUS_LABEL: Record<BlueprintLearningStatus | 'none', string> = {
  none: 'Not yet learned',
  queued: 'Queued to learn…',
  learning: 'Learning…',
  learned: 'Learned',
  stale: 'Understanding may be stale',
}

/** The act's one name per affordance: a first learn is "Learn", a refresh of
 *  drifted understanding is "Update". */
export const LEARN_ACTION_LABEL: Record<LearningAction, string> = {
  learn: 'Learn',
  relearn: 'Update',
}

/**
 * Progressive-learning info for ONE module (#513 phase 7). Derived purely from
 * `snapshot.learning` + `snapshot.investigations` — the board reads `.status`
 * for the corner dot; the popover renders the full object as the "Understanding"
 * section. `status: null` means the module was never learned.
 */
export interface PopoverLearning {
  /** Latest learning-state for the module, or null when never learned. */
  status: BlueprintLearningStatus | null
  /** Active investigation-note summary for the module (a stale note preferred). */
  noteSummary?: string
  /** Conventional module doc path (learned/stale only — the doc exists by then). */
  docHint?: string
  /** `notedAt` of the learning-state entry (present once an entry exists). */
  learnedAt?: string
  /** Button affordance: 'learn' (never learned) | 'relearn' (learned/stale) |
   *  null (a learn pass is in flight — no button while `learning`). */
  action: LearningAction | null
}

/* ── THE GROUND A FEATURE STANDS ON (Phase 8) ───────────────────────────────*/

/** One module under a feature, with the status pill the panel already uses. */
export interface PopoverGroundModule {
  module: string
  status: BlueprintLearningStatus | 'none'
}

/**
 * The Ground block: WHAT THIS CAPABILITY IS BUILT ON, and how much of it has
 * been read.
 *
 * A feature's own understanding and a module's learning state are two claims,
 * and the board keeps them apart everywhere else. This is the third thing a
 * reader wants and neither surface said: not "is this feature understood" but
 * "what code is under it, and does anyone here know that code yet". The block
 * answers it with names, so the next act — learning the unread modules — has
 * something to point at.
 */
export interface PopoverGround {
  modules: PopoverGroundModule[]
  /** The modules the *Learn ground* action would enqueue: never learned or
   *  drifted. In-flight and learned ones are already spoken for. */
  unlearned: string[]
  /** Said when the feature anchors nothing learnable — an empty list with no
   *  sentence reads as a broken panel rather than as an answer. */
  emptyNote: string | null
}

/**
 * Build the Ground block from a feature's file set.
 *
 * ONE JOIN AND ONE IGNORE MATCHER, both shared: `moduleOfPath` decides which
 * module a file lives in (the same rule the coverage line measures through) and
 * `ignoreSource` decides what does not count (the same rule the Learning panel
 * counts through). Neither is restated here (allowed-pattern #14).
 *
 * Deterministic: modules sorted by path, so the block does not reshuffle
 * between two renders of the same feature.
 */
export function groundForFeature(
  files: readonly string[],
  learning: readonly BlueprintLearningEntry[] = [],
  ignoreExtras: readonly string[] = [],
): PopoverGround {
  const status = new Map<string, BlueprintLearningStatus>()
  for (const entry of learning) status.set(normalizeModuleRef(entry.module), entry.status)
  const paths = new Set<string>()
  for (const file of files) {
    const module = moduleOfPath(file)
    if (module === null) continue
    if (ignoreSource(module, ignoreExtras) !== null) continue
    paths.add(module)
  }
  const modules = [...paths]
    .sort((a, b) => a.localeCompare(b))
    .map((module) => ({ module, status: status.get(module) ?? ('none' as const) }))
  return {
    modules,
    unlearned: modules
      .filter((row) => row.status === 'none' || row.status === 'stale')
      .map((row) => row.module),
    emptyNote:
      modules.length === 0 ? 'No ground yet — this feature anchors nothing learnable' : null,
  }
}

/** Human label for the node-kind eyebrow. */
const KIND_LABEL: Record<BlueprintNodeKind, string> = {
  module: 'module',
  integration: 'integration',
  datastore: 'data store',
  endpoint: 'endpoint',
  project: 'project',
}

export interface PopoverAnnotationLine {
  type: BlueprintAnnotationType
  text: string
  /** True for annotations whose anchors no longer resolve (effective status). */
  stale: boolean
  /** Repo-relative path the annotation's first file-bearing anchor names, or
   *  null when none of its anchors identify a concrete file (Phase 5, #568) —
   *  the popover renders a peek affordance only when this is non-null. */
  peekPath: string | null
}

/** Detail payload for the Attach-to-chat action (the flow:blueprint-selected shape). */
export interface PopoverAttach {
  nodeId: string
  label: string
  kind: string
  proposal: boolean
}

export interface PopoverContent {
  /** Kind eyebrow, e.g. `module` or `module · proposal` for a ghost. */
  eyebrow: string
  label: string
  /** Mono id line; null for ghosts (the board never shows a ghost's id). */
  id: string | null
  ghost: boolean
  ghostState: BlueprintProposalState | null
  /** Ghost plan-name badge; null when the node is not a ghost. */
  planBadge: string | null
  /** Up to MAX_POPOVER_ANNOTATIONS annotation lines. */
  annotations: PopoverAnnotationLine[]
  /** Count of annotations beyond the cap ('…and K more'); 0 when none. */
  moreAnnotations: number
  /** Features this node belongs to, each with its plan-doc path (empty → the
   *  board omits the row). Clicking a feature pill peeks its plan doc. */
  features: PopoverFeature[]
  /** Must-review reason lines — only populated when the node is badged.
   *  NOTE: BlueprintMustReviewItem carries no anchors (only an optional
   *  `nodeId`), so these lines never get a peek affordance — only
   *  Annotations (which DO carry anchors) can. */
  reviewReasons: string[]
  /** Rich Review-tab rows (#910): severity + title + detail per item. */
  reviewRows: Array<{ severity: string; title: string; detail: string }>
  /** The module's directory, for the Files section — non-null only for a
   *  non-ghost module node with a resolvable underlying graph node. The board
   *  fetches `project:listDir` against this async and patches the section
   *  into the already-open popover (Phase 5, #568) — deliberately NOT part of
   *  this pure content object, which never performs IO. */
  sourceDir: string | null
  /** Drill action available (modules with child modules only). */
  canDrill: boolean
  /** Attach action is always available. */
  attach: PopoverAttach
  /** Progressive-learning info — null for ghosts and non-module nodes (no
   *  learning affordance on integrations / datastores / endpoints / ghosts). */
  learning: PopoverLearning | null
  /** The Ground block (Phase 8) — the modules a FEATURE stands on. Null unless
   *  the caller supplied that feature's file set (`groundFiles`); a module node
   *  has no ground of its own, it IS ground. */
  ground: PopoverGround | null
}

export interface PopoverInput {
  node: FlowNode
  /** Underlying graph node(s): 1 for a normal node, N for the rolled-up CLI
   *  surface, 0 for a ghost (predicted, no derived node yet). */
  graphNodes: BlueprintNode[]
  annotations: BlueprintAnnotation[]
  features: BlueprintFeature[]
  /** Must-review items rolled onto this displayed node (the board pre-filters). */
  reviewItems: BlueprintMustReviewItem[]
  /** Deduped learning-state records (snapshot.learning) — defaults to none. */
  learning?: readonly BlueprintLearningEntry[]
  /** Active investigation notes (snapshot.investigations) — defaults to none. */
  investigations?: readonly BlueprintInvestigation[]
  /**
   * The FILES this node stands on, when the node is a feature and the caller
   * already holds them (the lens's ground cache). Omitted → no Ground block.
   *
   * Passed in rather than fetched: this module is pure and performs no IO, the
   * same discipline `sourceDir` records for the Files section.
   */
  groundFiles?: readonly string[]
  /** Extra learning ignores (`learn_ignore`), so the Ground block counts what
   *  the Learning panel counts. */
  ignoreExtras?: readonly string[]
}

/** A feature a node belongs to, plus the path to peek to "remember what was
 *  implemented" — its plan doc (flow/plans or flow/archive for a done feature). */
export interface PopoverFeature {
  slug: string
  /** Project-relative path of the feature's plan doc; clicking the pill peeks it. */
  docPath: string
}

/** Plan-doc path for a feature — `flow/archive/` once the feature is completed
 *  (the plan is archived on execute-plan finish), else `flow/plans/`. */
function featurePlanPath(feature: BlueprintFeature): string {
  return `flow/${feature.archived ? 'archive' : 'plans'}/${feature.plan}`
}

/**
 * Feature membership for a set of underlying graph nodes: a node belongs to a
 * feature when its `sourceFile` matches (via fileMatchesNode — exact file, or a
 * file under a module node's directory) any concrete file token declared by any
 * of the feature's phases. Returns unique features (by slug) each carrying its
 * plan-doc path, sorted by slug. Pure.
 */
export function featuresForNode(
  graphNodes: BlueprintNode[],
  features: BlueprintFeature[],
): PopoverFeature[] {
  if (graphNodes.length === 0) return []
  const bySlug = new Map<string, PopoverFeature>()
  for (const feature of features) {
    const matched = feature.phases.some((phase) =>
      phase.files.some((file) => graphNodes.some((node) => fileMatchesNode(file, node))),
    )
    if (matched && !bySlug.has(feature.feature)) {
      bySlug.set(feature.feature, { slug: feature.feature, docPath: featurePlanPath(feature) })
    }
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug))
}

/** Strip a leading `module:` so path/id forms compare equal. */
function normalizeModuleRef(ref: string): string {
  return ref.startsWith(MODULE_ID_PREFIX) ? ref.slice(MODULE_ID_PREFIX.length) : ref
}

/**
 * Conventional module doc path — mirrors the main-side writer
 * (`flow/brain/modules/<slug>.md`, kebab slug of the module path). Kept as a
 * local slug (renderer cannot import the main-process slugify) that matches its
 * core transform for the ASCII module paths the board deals in. Display hint
 * only — never resolved as a filesystem path here.
 */
function moduleDocPath(modulePath: string): string {
  const slug = modulePath
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return `flow/brain/modules/${slug}.md`
}

/** Button affordance for a learning status (null while a pass is in flight). */
function learningAction(status: BlueprintLearningStatus | null): LearningAction | null {
  if (status === null) return 'learn'
  if (status === 'learned' || status === 'stale') return 'relearn'
  return null // 'learning' — no button while the pass runs
}

/**
 * Derive the progressive-learning info for one module (#513 phase 7). Pure.
 *
 * Module matching is deliberately simple:
 *  - a learning entry matches when its `module` equals the module path (either
 *    `module:<path>` or bare `<path>` form);
 *  - an investigation note matches when any of its anchor refs equals
 *    `module:<path>` OR resolves UNDER the module path (`<path>/…`).
 * When several notes match, a `stale` note's summary is preferred (it is the
 * signal the module drifted). `docHint` is surfaced only once a doc exists
 * (status `learned` or `stale`).
 *
 * @param moduleRef  the module id or path (`module:app/src/main` or `app/src/main`)
 */
export function learningForModule(
  moduleRef: string,
  learning: readonly BlueprintLearningEntry[] = [],
  investigations: readonly BlueprintInvestigation[] = [],
): PopoverLearning {
  const modulePath = normalizeModuleRef(moduleRef)
  const entry = learning.find((e) => normalizeModuleRef(e.module) === modulePath)
  const status = entry?.status ?? null

  const matches = investigations.filter((note) =>
    note.anchorRefs.some((ref) => {
      const path = normalizeModuleRef(ref)
      return path === modulePath || path.startsWith(`${modulePath}/`)
    }),
  )
  const preferred = matches.find((note) => note.stale === true) ?? matches[0]

  const info: PopoverLearning = { status, action: learningAction(status) }
  if (preferred !== undefined) info.noteSummary = preferred.summary
  if (entry !== undefined) info.learnedAt = entry.notedAt
  if (status === 'learned' || status === 'stale') info.docHint = moduleDocPath(modulePath)
  return info
}

/** Assemble the popover content object for a clicked node. Pure. */
export function buildPopoverContent(input: PopoverInput): PopoverContent {
  const { node, graphNodes, annotations, features, reviewItems } = input
  const ghost = node.ghost === true

  const matched = graphNodes.length > 0 ? annotationsForNodes(annotations, graphNodes) : []
  const annotationLines: PopoverAnnotationLine[] = matched
    .slice(0, MAX_POPOVER_ANNOTATIONS)
    .map((entry) => ({
      type: entry.type,
      text: entry.text,
      stale: entry.status === 'stale',
      peekPath: firstAnchorPeekPath(entry.anchors),
    }))
  const moreAnnotations = Math.max(0, matched.length - annotationLines.length)

  // Reason lines are shown only when the node actually carries a must-review
  // badge; dedup the underlying item titles, preserving first-seen order.
  const reviewReasons = node.mustReview ? [...new Set(reviewItems.map((item) => item.title))] : []
  // Full items for the Review tab's rich rows (#910): severity + title +
  // detail, first-seen order, deduped by title+detail.
  const seenReviewRows = new Set<string>()
  const reviewRows = !node.mustReview
    ? []
    : reviewItems.flatMap((item) => {
        const key = `${item.title}\u0000${item.detail}`
        if (seenReviewRows.has(key)) return []
        seenReviewRows.add(key)
        return [{ severity: item.severity, title: item.title, detail: item.detail }]
      })

  // Learning affordance is module-only (never ghosts / integrations / datastores).
  const learning =
    !ghost && node.kind === 'module'
      ? learningForModule(node.id, input.learning ?? [], input.investigations ?? [])
      : null

  return {
    eyebrow: ghost ? `${KIND_LABEL[node.kind]} · proposal` : KIND_LABEL[node.kind],
    label: node.label,
    id: ghost ? null : node.id,
    ghost,
    ghostState: node.ghostState ?? null,
    planBadge: ghost ? (node.sublabel ?? null) : null,
    annotations: annotationLines,
    moreAnnotations,
    features: featuresForNode(graphNodes, features),
    reviewReasons,
    reviewRows,
    canDrill: !ghost && node.kind === 'module' && (node.childCount ?? 0) > 0,
    attach: { nodeId: node.id, label: node.label, kind: node.kind, proposal: ghost },
    learning,
    ground:
      input.groundFiles === undefined
        ? null
        : groundForFeature(input.groundFiles, input.learning ?? [], input.ignoreExtras ?? []),
    sourceDir: !ghost && node.kind === 'module' ? (graphNodes[0]?.sourceFile ?? null) : null,
  }
}
