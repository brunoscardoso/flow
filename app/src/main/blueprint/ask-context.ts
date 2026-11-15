// What an answer is given before anyone reads code (Ask the Blueprint, Phase 2).
//
// FOUR KINDS OF KNOWLEDGE, NONE OF IT TOOL OUTPUT.
//   · brain search hits for the question (the Workspace when the project is in
//     one — the same corpus `brain:query` searches, widened);
//   · the feature graph slice for the tags: the tagged features and parts,
//     their summaries, their parts and the features they touch;
//   · recent investigation notes — what earlier learn passes recorded;
//   · the person's tagged conversations, condensed by `condenseThreadForAsk`:
//     what the person said, the answers that ended each turn, which files
//     changed and which plan or discovery was involved. Never tool output, so a
//     12 MB grep result never becomes prompt, and never conversation text in a
//     shared store (the orchestrator records only THAT one was used).
//
// UNMERGED WORK IS CONTEXT, NEVER A FACT. A tagged conversation's worktree
// branch is checked against its base with async git (allowed-pattern #19);
// `merged: false` makes the orchestrator say "in progress on branch X" and
// keeps that work out of the facts it writes.
//
// Every read is injected, so the whole module tests without a repository, a
// database or a spawned process.

import type { BlueprintFeatureEdge, BlueprintFeatureNode } from '../../shared/ipc-contract'
import { isFileChangeTool } from '../../shared/tool-file-changes'
import type { MessageRecord, ThreadRecord } from '../store/thread-store'
import type { RunResult } from '../worktree/thread-worktree'

// ── Limits (what one prompt may carry) ──────────────────────────────────────

/** The person's messages kept per conversation — the most recent ones. */
const MAX_PERSON_MESSAGES = 12
/** Turn-ending answers kept per conversation — the most recent ones. */
const MAX_ANSWERS = 8
const MAX_PERSON_MESSAGE_CHARS = 1_200
const MAX_ANSWER_CHARS = 2_000
const MAX_FILES_CHANGED = 40
/** Brain hits handed to the fast pass. */
const MAX_BRAIN_HITS = 8
/** Investigation notes handed to the fast pass. */
const MAX_NOTES = 15
/** Untagged features listed when nothing is tagged, so the model can name one. */
const MAX_UNTAGGED_FEATURES = 60
const MAX_SUMMARY_CHARS = 240

/** A plan or discovery document a conversation touched or named. */
const LINKED_DOC_PATTERN = /flow\/(?:plans|discovery)\/[A-Za-z0-9._-]+\.md/g

// ── Conversations ───────────────────────────────────────────────────────────

/** What a tagged conversation gives an answer. Never tool output. */
export interface CondensedThread {
  threadId: string
  title: string
  /** The checkout the conversation worked in (its worktree, else its project). */
  checkout: string
  /** What the person wrote, most recent last. */
  personMessages: string[]
  /** The assistant messages that ended a turn, most recent last. */
  answers: string[]
  /** Paths the conversation's file-changing tools named. */
  filesChanged: string[]
  /** Plan or discovery documents it touched or named. */
  linkedDocs: string[]
  /** The worktree branch, or null when it worked on the project's own checkout. */
  branch: string | null
  /** The ref that branch was cut from, when known. */
  base: string | null
  /** Whether `branch` is merged into `base`. Null = unknown (no branch, no base, or git could not say). */
  merged: boolean | null
}

/** The reads `condenseThreadForAsk` needs — a ThreadStore satisfies it. */
export type AskThreadReader = {
  getThread(id: string): ThreadRecord | null
  listMessages(threadId: string, options?: { limit?: number }): MessageRecord[]
  listToolCallPaths(threadId: string): Array<{ toolName: string; filePath: string | null }>
}

function clip(text: string, max: number): string {
  const flat = text.trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function relativeTo(root: string, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const prefix = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
}

/**
 * Condense one conversation for an answer: the person's messages, the
 * turn-ending answers (`messages.ends_turn`; an older thread without marks
 * falls back to its last assistant message), the files its tools changed and
 * any plan or discovery involved — and its branch. NEVER tool output: tool
 * calls are read through `listToolCallPaths`, which extracts a path in SQL and
 * never loads an input or an output blob.
 *
 * Synchronous — the store is. Whether the branch is merged is a git question,
 * answered by `withMergeState`; until then `merged` is null. Null for a thread
 * that does not exist.
 */
export function condenseThreadForAsk(store: AskThreadReader, threadId: string): CondensedThread | null {
  const thread = store.getThread(threadId)
  if (thread === null) return null
  const messages = store.listMessages(threadId).filter((message) => !message.parentToolCallId)
  const personMessages = messages
    .filter((message) => message.role === 'user' && message.content.trim() !== '')
    .slice(-MAX_PERSON_MESSAGES)
    .map((message) => clip(message.content, MAX_PERSON_MESSAGE_CHARS))
  const assistant = messages.filter((message) => message.role === 'assistant' && message.content.trim() !== '')
  const marked = assistant.filter((message) => message.endsTurn === true)
  const answers = (marked.length > 0 ? marked : assistant.slice(-1))
    .slice(-MAX_ANSWERS)
    .map((message) => clip(message.content, MAX_ANSWER_CHARS))

  const checkout = thread.worktreePath ?? thread.projectRoot
  const files = new Set<string>()
  for (const call of store.listToolCallPaths(threadId)) {
    if (call.filePath === null || !isFileChangeTool(call.toolName)) continue
    files.add(relativeTo(checkout, call.filePath))
  }
  const filesChanged = [...files].slice(-MAX_FILES_CHANGED)

  const linked = new Set<string>()
  for (const file of files) for (const match of file.match(LINKED_DOC_PATTERN) ?? []) linked.add(match)
  for (const text of personMessages) for (const match of text.match(LINKED_DOC_PATTERN) ?? []) linked.add(match)

  return {
    threadId,
    title: thread.title,
    checkout,
    personMessages,
    answers,
    filesChanged,
    linkedDocs: [...linked],
    branch: thread.worktreeBranch,
    base: thread.worktreeBase ?? thread.prBase,
    merged: null,
  }
}

/** Async git, argv only — `runGitCapturing` in production. Never rejects. */
export type AskGit = (cwd: string, args: readonly string[]) => Promise<RunResult>

/**
 * Answer "is this conversation's branch merged into its base?" with async git.
 * The branch must still exist; `merge-base --is-ancestor` then exits 0 when it
 * is merged and non-zero when it is not. A missing branch or base stays null —
 * unknown is never reported as in progress, and never as a fact either.
 */
export async function withMergeState(thread: CondensedThread, git: AskGit): Promise<CondensedThread> {
  if (thread.branch === null || thread.base === null) return thread
  const exists = await git(thread.checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${thread.branch}`])
  if (!exists.ok) return thread
  const baseExists = await git(thread.checkout, ['rev-parse', '--verify', '--quiet', thread.base])
  if (!baseExists.ok) return thread
  const ancestor = await git(thread.checkout, ['merge-base', '--is-ancestor', `refs/heads/${thread.branch}`, thread.base])
  return { ...thread, merged: ancestor.ok }
}

// ── Knowledge ───────────────────────────────────────────────────────────────

/** One brain search hit, as the prompt shows it. */
export interface AskKnowledgeHit {
  file: string
  title: string
  snippet: string
  /** The Workspace project it came from, when searched across the Workspace. */
  project?: string
}

/** One recorded investigation note, newest last. */
export interface AskNote {
  ts: string
  text: string
  anchors: string[]
}

/** A feature or part in the slice the prompt carries. */
export interface AskFeature {
  id: string
  name: string
  kind: 'core' | 'part'
  summary: string
  /** For a part, the feature it belongs to. */
  partOf?: string
  tagged: boolean
}

/** Everything an answer is given before it reads code. */
export interface AskContext {
  hits: AskKnowledgeHit[]
  features: AskFeature[]
  /** Relations between features in the slice, `from → to`. */
  relations: Array<{ from: string; to: string }>
  notes: AskNote[]
  threads: CondensedThread[]
  /** Every feature or part id on the Blueprint — what a source may resolve to. Empty = no graph could be read. */
  knownIds: string[]
}

/** The reads `gatherAskContext` makes. All required (allowed-pattern #26). */
export interface AskContextDeps {
  /** Brain search for the question (Workspace scope when available). Fail-soft: [] on failure. */
  searchKnowledge: (rootPath: string, query: string) => Promise<AskKnowledgeHit[]>
  /** The feature graph (`blueprint features graph`). Fail-soft: no nodes on failure. */
  readFeatureGraph: (rootPath: string) => Promise<{ nodes: BlueprintFeatureNode[]; edges: BlueprintFeatureEdge[] }>
  /** Active investigation notes, oldest first. Fail-soft: [] on failure. */
  readNotes: (rootPath: string) => Promise<AskNote[]>
  threadStore: AskThreadReader
  git: AskGit
}

/** The id a part is addressed by — the CLI's graph already speaks `feature:<slug>/<part>`. */
function isAddressable(node: BlueprintFeatureNode): boolean {
  return node.kind !== 'child' && node.id.startsWith('feature:')
}

/** The feature a part belongs to — its `parent` id, which already carries any Workspace namespace. */
function ownerOf(node: BlueprintFeatureNode): string {
  return node.parent ?? `feature:${node.partOf ?? node.slug}`
}

function toAskFeature(node: BlueprintFeatureNode, tagged: boolean): AskFeature {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind === 'part' ? 'part' : 'core',
    summary: clip(node.summary ?? '', MAX_SUMMARY_CHARS),
    ...(node.kind === 'part' ? { partOf: ownerOf(node) } : {}),
    tagged,
  }
}

/**
 * The feature graph slice for the tags. A tagged feature brings its parts; a
 * tagged part brings its feature; both bring the features their edges touch.
 * Nothing tagged → the core features, so the answer can name one.
 */
export function sliceFeatureGraph(
  nodes: readonly BlueprintFeatureNode[],
  edges: readonly BlueprintFeatureEdge[],
  tags: readonly string[],
): { features: AskFeature[]; relations: Array<{ from: string; to: string }> } {
  const addressable = nodes.filter(isAddressable)
  const byId = new Map(addressable.map((node) => [node.id, node]))
  const tagged = new Set(tags.filter((tag) => byId.has(tag)))
  if (tagged.size === 0) {
    return {
      features: addressable
        .filter((node) => node.kind === 'core')
        .slice(0, MAX_UNTAGGED_FEATURES)
        .map((node) => toAskFeature(node, false)),
      relations: [],
    }
  }
  const picked = new Set<string>(tagged)
  for (const id of tagged) {
    const node = byId.get(id)
    if (node === undefined) continue
    if (node.kind === 'part') picked.add(ownerOf(node))
    if (node.kind === 'core') {
      for (const other of addressable) if (other.kind === 'part' && ownerOf(other) === node.id) picked.add(other.id)
    }
  }
  const relations: Array<{ from: string; to: string }> = []
  for (const edge of edges) {
    if (!tagged.has(edge.from) && !tagged.has(edge.to)) continue
    relations.push({ from: edge.from, to: edge.to })
    if (byId.has(edge.from)) picked.add(edge.from)
    if (byId.has(edge.to)) picked.add(edge.to)
  }
  const features = [...picked]
    .map((id) => byId.get(id))
    .filter((node): node is BlueprintFeatureNode => node !== undefined)
    .map((node) => toAskFeature(node, tagged.has(node.id)))
  return { features, relations }
}

/** Notes worth showing: those naming a tagged feature's slug first, then the newest. */
function pickNotes(notes: readonly AskNote[], features: readonly AskFeature[]): AskNote[] {
  const slugs = features.filter((feature) => feature.tagged).map((feature) => feature.id.replace(/^feature:/, '').split('/')[0])
  const mentions = (note: AskNote): boolean =>
    slugs.some((slug) => note.text.includes(slug) || note.anchors.some((anchor) => anchor.includes(slug)))
  const relevant = notes.filter(mentions)
  const rest = notes.filter((note) => !mentions(note))
  return [...relevant.slice(-MAX_NOTES), ...rest.slice(-MAX_NOTES)].slice(0, MAX_NOTES)
}

/** Gather an answer's knowledge. Never throws — each read is fail-soft. */
export async function gatherAskContext(
  input: { rootPath: string; question: string; tags: readonly string[]; conversationIds: readonly string[] },
  deps: AskContextDeps,
): Promise<AskContext> {
  const [hits, graph, notes] = await Promise.all([
    deps.searchKnowledge(input.rootPath, input.question).catch(() => [] as AskKnowledgeHit[]),
    deps.readFeatureGraph(input.rootPath).catch(() => ({ nodes: [], edges: [] })),
    deps.readNotes(input.rootPath).catch(() => [] as AskNote[]),
  ])
  const { features, relations } = sliceFeatureGraph(graph.nodes, graph.edges, input.tags)
  const threads: CondensedThread[] = []
  for (const id of input.conversationIds) {
    let condensed: CondensedThread | null = null
    try {
      condensed = condenseThreadForAsk(deps.threadStore, id)
    } catch {
      condensed = null // an unreadable conversation is simply not context
    }
    if (condensed === null) continue
    threads.push(await withMergeState(condensed, deps.git).catch(() => condensed as CondensedThread))
  }
  return {
    hits: hits.slice(0, MAX_BRAIN_HITS),
    features,
    relations,
    notes: pickNotes(notes, features),
    threads,
    knownIds: graph.nodes.filter(isAddressable).map((node) => node.id),
  }
}
