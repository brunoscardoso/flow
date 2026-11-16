// Ask the Blueprint — suggested tags and the @ picker (plan
// `ask_the_blueprint`, Phase 3, FR-2 / FR-3).
//
// LOCAL AND CHEAP. Pasted text is matched against the names and summaries the
// board already holds — no model call, no IPC. A name said in the text is a
// strong signal; summary words in common are a weak one and need more than
// one to count. Ranked, and capped small: a row of twelve chips is a list to
// read, not a suggestion.

import { linkTagId, type AskSuggestion, type AskTag } from './ask-panel-model'

/** What the suggester reads of one feature or part. A `FeatureGraphNodeInput` fits. */
export interface SuggestNode {
  /** `feature:<slug>[/<part>]`, or qualified `feature:<project>::<slug>[/<part>]` on the Workspace. */
  id: string
  name: string
  kind: 'core' | 'child' | 'part'
  summary?: string
  /** For a part: its feature's slug (project-local). */
  partOf?: string
  /** On the Workspace: the project slug the node is in. */
  project?: string
}

/** `feature:<p>::<slug>/<part>` → `<slug>/<part>`; `feature:<slug>` → `<slug>`. */
function localSlug(id: string): string {
  const bare = id.replace(/^feature:/, '')
  const cut = bare.indexOf('::')
  return cut === -1 ? bare : bare.slice(cut + 2)
}

/** A node's feature, by project — two projects' same slug are two features. */
function ownerKey(node: SuggestNode): string {
  const owner = node.partOf ?? localSlug(node.id).split('/')[0] ?? ''
  return `${node.project ?? ''}::${owner}`
}

/** How many suggestions one paste offers. */
export const MAX_SUGGESTIONS = 5
/** How many rows the @ picker shows. */
export const MAX_PICKER_ROWS = 8

const STOPWORDS = new Set(
  (
    'about above after again against also because been before being below between both but can cannot could does doing down during each ' +
    'from further have having here into just more most need only other ought over same should some such than that their them then ' +
    'there these they this those through under until very want were what when where which while will with would your yours ' +
    'customers customer someone somebody else keep asking thing things make made using used like how hard build'
  ).split(' '),
)

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word))
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True when `name` appears in `text` as a whole word (or its plural). */
function namesIt(text: string, name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length < 3) return false
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(trimmed.toLowerCase())}(e?s)?([^a-z0-9]|$)`).test(text)
}

/** A feature's name by slug, so a part's chip reads "Feature · Part". */
function featureNames(nodes: readonly SuggestNode[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const node of nodes) {
    if (node.kind !== 'core') continue
    out.set(`${node.project ?? ''}::${localSlug(node.id)}`, node.name)
  }
  return out
}

/** The chip label for a node: a feature's name, or "Feature · Part" for a part. */
export function suggestLabel(node: SuggestNode, names: ReadonlyMap<string, string>): string {
  if (node.kind !== 'part') return node.name
  const ownerName = names.get(ownerKey(node))
  return ownerName === undefined ? node.name : `${ownerName} · ${node.name}`
}

/**
 * The features and parts `text` names, best first, at most `limit`.
 * Changes are never suggested — they are not on the map.
 */
export function suggestTags(
  text: string,
  nodes: readonly SuggestNode[],
  options: { exclude?: ReadonlySet<string>; limit?: number } = {},
): AskSuggestion[] {
  const lower = text.toLowerCase()
  if (lower.trim() === '') return []
  const textWords = new Set(words(text))
  const names = featureNames(nodes)
  const scored: Array<{ suggestion: AskSuggestion; score: number }> = []
  for (const node of nodes) {
    if (node.kind === 'child') continue
    if (options.exclude?.has(node.id) === true) continue
    let score = 0
    if (namesIt(lower, node.name)) score += 10 + Math.min(node.name.length, 20) / 10
    // A part said together with its feature is the most specific match there is.
    if (score > 0 && node.kind === 'part') {
      const ownerName = names.get(ownerKey(node))
      if (ownerName !== undefined && namesIt(lower, ownerName)) score += 4
    }
    if (node.summary !== undefined && node.summary !== '') {
      const shared = new Set(words(node.summary).filter((word) => textWords.has(word)))
      if (shared.size >= 2) score += shared.size
    }
    if (score === 0) continue
    scored.push({
      suggestion: {
        id: node.id,
        kind: node.kind === 'part' ? 'part' : 'feature',
        label: suggestLabel(node, names),
        ...(node.project !== undefined ? { project: node.project } : {}),
      },
      score,
    })
  }
  scored.sort((a, b) => b.score - a.score || a.suggestion.label.localeCompare(b.suggestion.label))
  return scored.slice(0, options.limit ?? MAX_SUGGESTIONS).map((entry) => entry.suggestion)
}

/** One row the @ picker can offer. */
export interface PickerCandidate extends AskTag {
  /** A second line: a summary, or when a conversation was last active. */
  hint?: string
}

/** The @ picker's candidates from the graph's features and parts. */
export function graphCandidates(nodes: readonly SuggestNode[]): PickerCandidate[] {
  const names = featureNames(nodes)
  const out: PickerCandidate[] = []
  for (const node of nodes) {
    if (node.kind === 'child') continue
    out.push({
      id: node.id,
      kind: node.kind === 'part' ? 'part' : 'feature',
      label: suggestLabel(node, names),
      ...(node.project !== undefined ? { project: node.project } : {}),
      ...(node.summary !== undefined && node.summary !== '' ? { hint: node.summary } : {}),
    })
  }
  return out
}

/** A Workspace's projects and the connections between them, as the picker's other rows. */
export function workspaceCandidates(
  projects: ReadonlyArray<{ slug: string; name: string; description?: string | null }>,
  links: ReadonlyArray<{ from: { project: string }; to: { project: string } }> | null,
): PickerCandidate[] {
  const out: PickerCandidate[] = projects.map((project) => ({
    id: `project:${project.slug}`,
    kind: 'project' as const,
    label: project.name,
    project: project.slug,
    ...(project.description !== undefined && project.description !== null && project.description !== '' ? { hint: project.description } : {}),
  }))
  const names = new Map(projects.map((project) => [project.slug, project.name]))
  const counts = new Map<string, number>()
  for (const link of links ?? []) {
    if (link.from.project === link.to.project) continue
    const id = linkTagId(link.from.project, link.to.project)
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  for (const [id, count] of counts) {
    const [a, b] = id.slice('link:'.length).split('::')
    out.push({
      id,
      kind: 'connection',
      label: `${names.get(a ?? '') ?? a ?? ''} ↔ ${names.get(b ?? '') ?? b ?? ''}`,
      hint: `${String(count)} connection${count === 1 ? '' : 's'} recorded`,
    })
  }
  return out
}

/**
 * Filter the picker's candidates by what follows the @. Prefix matches on a
 * word beat matches inside one; an empty query shows projects, features,
 * connections, conversations, then parts — the order a reader narrows by.
 * Project scope has no projects or connections, so it reads as before:
 * features, then conversations, then parts. Already-tagged ids are left out.
 */
export function pickerMatches(
  query: string,
  candidates: readonly PickerCandidate[],
  options: { exclude?: ReadonlySet<string>; limit?: number } = {},
): PickerCandidate[] {
  const q = query.trim().toLowerCase()
  const order: Record<AskTag['kind'], number> = { project: 0, feature: 1, connection: 2, conversation: 3, part: 4 }
  const scored: Array<{ candidate: PickerCandidate; score: number }> = []
  for (const candidate of candidates) {
    if (options.exclude?.has(candidate.id) === true) continue
    const label = candidate.label.toLowerCase()
    let score: number
    if (q === '') score = 1
    else if (label.startsWith(q)) score = 4
    else if (label.split(/[^a-z0-9]+/).some((word) => word.startsWith(q))) score = 3
    else if (label.includes(q)) score = 2
    else continue
    scored.push({ candidate, score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      order[a.candidate.kind] - order[b.candidate.kind] ||
      a.candidate.label.localeCompare(b.candidate.label),
  )
  return scored.slice(0, options.limit ?? MAX_PICKER_ROWS).map((entry) => entry.candidate)
}

/**
 * The @ being typed at the caret, or null. `start` is where the @ is, so the
 * view can cut "@conn" out of the text when a row is picked.
 */
export function activeMention(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([^\s@]*)$/.exec(before)
  if (match === null) return null
  return { query: match[2] ?? '', start: before.length - (match[2] ?? '').length - 1 }
}
