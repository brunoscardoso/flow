/**
 * A FEATURE'S TYPE, AS THE BOARD DRAWS IT (plan feature-type-icons, Phase 5).
 * PURE, no DOM — the board's builders only spell what this returns.
 *
 * WHAT IT OWNS
 * ============
 * - which glyph and which colour token draw each role;
 * - the tooltip — "API · learned", "User interface · set by you",
 *   "Data · guessed from its files" (FR-11);
 * - the guessed look: a guess is the same glyph in the dim ink (FR-9);
 * - the size rule — the icon shows on the full-name tier only (FR-8);
 * - an opened feature's box: which role it draws (Task 5.4);
 * - the one-time classify offer: what the bar says, if anything (FR-10).
 *
 * WHAT IT DOES NOT OWN
 * ====================
 * The precedence person → learn → guess. That is resolved ONCE, in the CLI's
 * graph build, and arrives as `role` + `roleSource` on every node; nothing here
 * re-derives a feature's role. The one guess made here is for a BOX of an
 * opened feature, which the graph does not carry: a component's kind, or its
 * file, through the CLI's own `guessFeatureRole`.
 *
 * The words are "type", never "role": that is what the person reads.
 */

import {
  FEATURE_ROLE_LABELS,
  guessFeatureRole,
  isFeatureRole,
  type FeatureRole,
  type FeatureRoleSource,
} from '../../shared/feature-role'
import type { IconName } from '../components/icon-paths'

/** The icon-table entry each role draws. */
export const ROLE_GLYPHS: Readonly<Record<FeatureRole, IconName>> = Object.freeze({
  ui: 'role-ui',
  api: 'role-api',
  logic: 'role-logic',
  data: 'role-data',
  config: 'role-config',
  jobs: 'role-jobs',
  integration: 'role-integration',
  service: 'role-service',
  function: 'role-function',
  mobile: 'role-mobile',
  neutral: 'role-neutral',
})

/** The colour token a role is drawn in — declared once per theme in the board's stylesheet. */
export function roleToken(role: FeatureRole): string {
  return `--fb-role-${role}`
}

/** Where the type came from, in the tooltip's words. */
const SOURCE_WORDS: Readonly<Record<FeatureRoleSource, string>> = Object.freeze({
  learn: 'learned',
  person: 'set by you',
  guess: 'guessed from its files',
})

export function isRoleSource(value: unknown): value is FeatureRoleSource {
  return value === 'person' || value === 'learn' || value === 'guess'
}

/** "API · learned" — the icon's tooltip. */
export function roleTooltip(role: FeatureRole, source: FeatureRoleSource): string {
  return `${FEATURE_ROLE_LABELS[role]} · ${SOURCE_WORDS[source]}`
}

/** Everything the DOM needs to draw one icon. */
export interface RoleMark {
  role: FeatureRole
  source: FeatureRoleSource
  glyph: IconName
  /** True for a guess: the same glyph, in the dim ink rather than its colour. */
  guessed: boolean
  /** The classes the icon wears — its colour, or the guessed ink. */
  className: string
  title: string
}

/**
 * The mark for a role and its source, or null when there is nothing honest to
 * draw: no role (a change record, an older bundle) or a value off the list.
 * A missing or unknown SOURCE with a valid role reads as a guess — the
 * cautious claim, never "set by you" on a word nobody can vouch for.
 */
export function roleMarkFor(role: unknown, source?: unknown): RoleMark | null {
  if (!isFeatureRole(role)) return null
  const from: FeatureRoleSource = isRoleSource(source) ? source : 'guess'
  const guessed = from === 'guess'
  return {
    role,
    source: from,
    glyph: ROLE_GLYPHS[role],
    guessed,
    className: `fb-role-icon fb-role-${role}${guessed ? ' fb-role-guessed' : ''}`,
    title: roleTooltip(role, from),
  }
}

/**
 * THE ICON NEVER TAKES LETTERS FROM A NAME (FR-8): it shows only on a cell that
 * prints its full name — `cellLabelClass` answers `''` for exactly that — and
 * is hidden on the tiny, dot and blank tiers. One rule, read by the cell model
 * at build and by the board when a hover re-tiers a cell.
 */
export function roleIconShownAt(labelClass: string): boolean {
  return labelClass === ''
}

// ── An opened feature's boxes ───────────────────────────────────────────────

/** What a box of an opened feature carries that says what kind of thing it is. */
export interface RoleBoxInput {
  role?: string
  kind: string
  code?: { file?: string }
}

/** A part's resolved type, as the graph carries it. */
export interface PartRole {
  role: FeatureRole
  source: FeatureRoleSource
}

/** A component's kind, read as a type. A module says nothing on its own. */
const KIND_ROLES: Readonly<Record<string, FeatureRole>> = Object.freeze({
  endpoint: 'api',
  datastore: 'data',
  integration: 'integration',
  function: 'function',
  project: 'service',
})

/**
 * THE ROLE A BOX DRAWS, in order:
 * 1. the component's own `role`, as the feature-view pass wrote it (learned);
 * 2. the role of the part that claims the box, with that part's own source;
 * 3. a guess — from the component's kind, else from its file, else neutral.
 */
export function boxRole(component: RoleBoxInput, part?: PartRole | null): PartRole {
  const own = typeof component.role === 'string' ? component.role.trim().toLowerCase() : ''
  if (isFeatureRole(own)) return { role: own, source: 'learn' }
  if (part != null) return part
  const byKind = KIND_ROLES[component.kind.trim().toLowerCase()]
  if (byKind !== undefined) return { role: byKind, source: 'guess' }
  const file = component.code?.file
  if (typeof file === 'string' && file.length > 0) return { role: guessFeatureRole([file]), source: 'guess' }
  return { role: 'neutral', source: 'guess' }
}

/** The graph-node fields `partRolesOf` reads. */
export interface PartRoleNode {
  id: string
  slug?: string
  name: string
  kind: string
  parent?: string
  partOf?: string
  role?: string
  roleSource?: string
}

/**
 * A feature's parts by NAME → their resolved type — the name is what an opened
 * feature's ground calls the part that claims a box. `featureRef` is the
 * feature's id or slug. Empty when the feature is not in `nodes` (a sibling's
 * view, a graph not loaded yet): the boxes then fall back to the guess rather
 * than borrow a part from another feature that happens to share a name.
 */
export function partRolesOf(nodes: readonly PartRoleNode[], featureRef: string | null | undefined): Map<string, PartRole> {
  const out = new Map<string, PartRole>()
  if (featureRef == null || featureRef === '') return out
  const feature = nodes.find((node) => node.kind === 'core' && (node.id === featureRef || node.slug === featureRef))
  if (feature === undefined) return out
  for (const node of nodes) {
    if (node.kind !== 'part') continue
    const mine = node.parent === feature.id || (feature.slug !== undefined && node.partOf === feature.slug)
    if (!mine || !isFeatureRole(node.role)) continue
    out.set(node.name, { role: node.role, source: isRoleSource(node.roleSource) ? node.roleSource : 'guess' })
  }
  return out
}

// ── The one-time classify offer ─────────────────────────────────────────────

/** A pass that is running, as far as the board has heard. */
export interface RoleOfferRun {
  done: number
  total: number
}

export interface RoleOfferInput {
  /** `countUnclassifiedRoles` over the nodes on screen. */
  count: number
  /** The reader said "Not now" for this project. */
  dismissed: boolean
  /** A pass ran to its end for this project in this session. */
  finished: boolean
  /** The pass in flight, or null. */
  running: RoleOfferRun | null
  /** Why the last start did not run — a sentence for a person — or null. */
  failure: string | null
}

export type RoleOfferView =
  | { kind: 'hidden' }
  | { kind: 'offer'; text: string; primary: string; secondary: string }
  | { kind: 'running'; text: string; stop: string }

export const ROLE_OFFER_PRIMARY = 'Classify types'
export const ROLE_OFFER_SECONDARY = 'Not now'
export const ROLE_OFFER_STOP = 'Stop'

/**
 * WHAT THE BAR SAYS. A running pass always shows — its Stop is the only way to
 * end it. Otherwise the offer shows only while something is left to classify,
 * the reader has not put it off, and no pass has already run to its end here.
 * A failed start keeps the offer and says why, in the sentence main sent.
 */
export function roleOfferView(input: RoleOfferInput): RoleOfferView {
  if (input.running !== null) {
    const total = Math.max(input.running.total, input.running.done)
    const text =
      total > 0
        ? `Classifying types · ${String(Math.min(input.running.done, total))} of ${String(total)}`
        : 'Classifying types…'
    return { kind: 'running', text, stop: ROLE_OFFER_STOP }
  }
  if (input.dismissed || input.finished || input.count <= 0) return { kind: 'hidden' }
  const lead =
    input.count === 1
      ? '1 learned feature has no type yet.'
      : `${String(input.count)} learned features have no type yet.`
  const them = input.count === 1 ? 'it' : 'them'
  const text =
    input.failure === null
      ? `${lead} Flow can classify ${them} from what it already learned.`
      : `${lead} The last attempt did not run: ${input.failure}`
  return { kind: 'offer', text, primary: ROLE_OFFER_PRIMARY, secondary: ROLE_OFFER_SECONDARY }
}

/** The per-viewer key a "Not now" is remembered under. */
export function roleOfferDismissKey(rootId: string): string {
  return `flow.board.roleOffer.dismissed:${rootId}`
}
