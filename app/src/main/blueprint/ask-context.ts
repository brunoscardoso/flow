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
// WORKSPACE SCOPE (plan `ask_the_blueprint_workspace`, note 5). Given the
// resolved scope — every in-scope project with its feature graph (from the
// Workspace map), its checkout when it is on this computer and its knowledge
// folder — each project's graph is sliced with a SHARE of the budget, its notes
// are read and matched on its own, every id is qualified with its project
// (`feature:<project>::<slug>`), and the recorded links between in-scope
// projects are added. All per-project reads run in parallel (NFR-4). One
// project — no scope — reads exactly as before.
//
// Every read is injected, so the whole module tests without a repository, a
// database or a spawned process.

import { join } from 'node:path'

import { qualifyFeatureId, splitQualifiedFeatureId, type AskConnectionKind } from '../../shared/ask-contract'
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
/** Workspace scope: features one prompt carries across every project's slice (NFR-2). */
const MAX_WORKSPACE_FEATURES = 120
/** Workspace scope: the smallest slice and note share one project gets, however many are in scope. */
const MIN_PROJECT_FEATURES = 8
const MIN_PROJECT_NOTES = 3
/** Workspace scope: recorded links between in-scope projects handed to the prompt. */
const MAX_LINKS = 40
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
  /** Workspace scope: the project it was recorded in. */
  project?: string
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
  /** Workspace scope: the project it is in (its id is qualified with it). */
  project?: string
}

// ── Workspace scope ─────────────────────────────────────────────────────────

/** One in-scope project, as the gate resolved it. */
export interface AskScopeProject {
  slug: string
  name: string
  /** Its checkout on this computer — a root open in Flow — or null (knowledge only). */
  rootPath: string | null
  /** The folder its knowledge lives in (the checkout's `flow/`, or its shared folder); null when unknown. */
  flowDir: string | null
  /** Its feature graph from the Workspace map; null when it could not be read. */
  graph: { nodes: BlueprintFeatureNode[]; edges: BlueprintFeatureEdge[] } | null
}

/** One recorded Workspace link, ends as addresses (`<project>/<ref>`). */
export interface AskWorkspaceLink {
  kind: AskConnectionKind
  from: string
  to: string
  fromProject: string
  toProject: string
  note?: string
}

/** A Workspace ask's scope — what the gate hands every later step. */
export interface AskResolvedScope {
  workspace: { slug: string; name: string }
  /** The in-scope projects, in the Workspace's order. */
  projects: AskScopeProject[]
  /** Every project slug of the Workspace (tags may name any of them). */
  workspaceProjects: string[]
  /** Every recorded link of the Workspace (in-scope or not — suggestions are checked against all). */
  links: AskWorkspaceLink[]
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
  /** Workspace scope only: the projects and the recorded links between in-scope projects. */
  workspace?: {
    slug: string
    name: string
    projects: Array<{ slug: string; name: string; local: boolean; readable: boolean }>
    links: AskWorkspaceLink[]
  }
}

/** The reads `gatherAskContext` makes. All required (allowed-pattern #26). */
export interface AskContextDeps {
  /** Brain search for the question (Workspace scope when available). Fail-soft: [] on failure. */
  searchKnowledge: (rootPath: string, query: string) => Promise<AskKnowledgeHit[]>
  /** The feature graph (`blueprint features graph`). Fail-soft: no nodes on failure. */
  readFeatureGraph: (rootPath: string) => Promise<{ nodes: BlueprintFeatureNode[]; edges: BlueprintFeatureEdge[] }>
  /** Active investigation notes of the knowledge folder `flowDir` (a checkout's `flow/`), oldest first. Fail-soft: [] on failure. */
  readNotes: (flowDir: string) => Promise<AskNote[]>
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
  maxUntagged: number = MAX_UNTAGGED_FEATURES,
): { features: AskFeature[]; relations: Array<{ from: string; to: string }> } {
  const addressable = nodes.filter(isAddressable)
  const byId = new Map(addressable.map((node) => [node.id, node]))
  const tagged = new Set(tags.filter((tag) => byId.has(tag)))
  if (tagged.size === 0) {
    return {
      features: addressable
        .filter((node) => node.kind === 'core')
        .slice(0, maxUntagged)
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
function pickNotes(notes: readonly AskNote[], features: readonly AskFeature[], max: number = MAX_NOTES): AskNote[] {
  const slugs = features.filter((feature) => feature.tagged).map((feature) => feature.id.replace(/^feature:/, '').split('/')[0])
  const mentions = (note: AskNote): boolean =>
    slugs.some((slug) => note.text.includes(slug) || note.anchors.some((anchor) => anchor.includes(slug)))
  const relevant = notes.filter(mentions)
  const rest = notes.filter((note) => !mentions(note))
  return [...relevant.slice(-max), ...rest.slice(-max)].slice(0, max)
}

/** The project-local ids a Workspace tag names in `project`: its qualified feature tags, unqualified. */
function localTagsOf(tags: readonly string[], project: string): string[] {
  const out: string[] = []
  for (const tag of tags) {
    const split = splitQualifiedFeatureId(tag)
    if (split !== null && split.project === project) out.push(split.localId)
  }
  return out
}

/** One project's slice, qualified: ids, owners and relations all carry `feature:<project>::`. */
function sliceProject(
  project: AskScopeProject,
  tags: readonly string[],
  share: number,
): { features: AskFeature[]; relations: Array<{ from: string; to: string }>; knownIds: string[] } {
  if (project.graph === null) return { features: [], relations: [], knownIds: [] }
  const local = localTagsOf(tags, project.slug)
  const sliced = sliceFeatureGraph(project.graph.nodes, project.graph.edges, local, share)
  // A tagged slice is uncapped on one project; across several it gets its share, tagged first.
  const ordered = [...sliced.features.filter((f) => f.tagged), ...sliced.features.filter((f) => !f.tagged)].slice(0, Math.max(share, local.length))
  const kept = new Set(ordered.map((feature) => feature.id))
  const q = (id: string): string => qualifyFeatureId(project.slug, id)
  return {
    features: ordered.map((feature) => ({
      ...feature,
      id: q(feature.id),
      ...(feature.partOf !== undefined ? { partOf: q(feature.partOf) } : {}),
      project: project.slug,
    })),
    relations: sliced.relations
      .filter((relation) => kept.has(relation.from) || kept.has(relation.to))
      .map((relation) => ({ from: q(relation.from), to: q(relation.to) })),
    knownIds: project.graph.nodes.filter(isAddressable).map((node) => q(node.id)),
  }
}

/** Workspace scope: every in-scope project read in parallel, each with its share of the budget. */
async function gatherWorkspaceKnowledge(
  input: { rootPath: string; question: string; tags: readonly string[]; workspace: AskResolvedScope },
  deps: AskContextDeps,
): Promise<Omit<AskContext, 'threads'>> {
  const scope = input.workspace
  const inScope = new Set(scope.projects.map((project) => project.slug))
  const count = Math.max(1, scope.projects.length)
  const featureShare = Math.max(MIN_PROJECT_FEATURES, Math.floor(MAX_WORKSPACE_FEATURES / count))
  const noteShare = Math.max(MIN_PROJECT_NOTES, Math.floor(MAX_NOTES / count))
  const [hits, perProject] = await Promise.all([
    deps.searchKnowledge(input.rootPath, input.question).catch(() => [] as AskKnowledgeHit[]),
    Promise.all(
      scope.projects.map(async (project) => {
        const slice = sliceProject(project, input.tags, featureShare)
        const notes =
          project.flowDir === null ? [] : await deps.readNotes(project.flowDir).catch(() => [] as AskNote[])
        const picked = pickNotes(
          notes,
          slice.features.map((feature) => ({ ...feature, id: splitQualifiedFeatureId(feature.id)?.localId ?? feature.id })),
          noteShare,
        ).map((note) => ({ ...note, project: project.slug }))
        return { slice, notes: picked }
      }),
    ),
  ])
  const links = scope.links
    .filter((link) => inScope.has(link.fromProject) && inScope.has(link.toProject))
    .slice(0, MAX_LINKS)
  return {
    // A hit from a project outside the scope is not what was asked about.
    hits: hits.filter((hit) => hit.project === undefined || inScope.has(hit.project)).slice(0, MAX_BRAIN_HITS),
    features: perProject.flatMap((entry) => entry.slice.features),
    relations: perProject.flatMap((entry) => entry.slice.relations),
    notes: perProject.flatMap((entry) => entry.notes).slice(0, Math.max(MAX_NOTES, noteShare * count)),
    knownIds: perProject.flatMap((entry) => entry.slice.knownIds),
    workspace: {
      slug: scope.workspace.slug,
      name: scope.workspace.name,
      projects: scope.projects.map((project) => ({
        slug: project.slug,
        name: project.name,
        local: project.rootPath !== null,
        readable: project.graph !== null,
      })),
      links,
    },
  }
}

/** The tagged conversations, condensed, with their merge state. */
async function gatherThreads(conversationIds: readonly string[], deps: AskContextDeps): Promise<CondensedThread[]> {
  const threads: CondensedThread[] = []
  for (const id of conversationIds) {
    let condensed: CondensedThread | null = null
    try {
      condensed = condenseThreadForAsk(deps.threadStore, id)
    } catch {
      condensed = null // an unreadable conversation is simply not context
    }
    if (condensed === null) continue
    threads.push(await withMergeState(condensed, deps.git).catch(() => condensed as CondensedThread))
  }
  return threads
}

/** Gather an answer's knowledge. Never throws — each read is fail-soft. */
export async function gatherAskContext(
  input: {
    rootPath: string
    question: string
    tags: readonly string[]
    conversationIds: readonly string[]
    /** Workspace scope; absent = the project of `rootPath`, read as before. */
    workspace?: AskResolvedScope
  },
  deps: AskContextDeps,
): Promise<AskContext> {
  if (input.workspace !== undefined) {
    const [knowledge, threads] = await Promise.all([
      gatherWorkspaceKnowledge({ ...input, workspace: input.workspace }, deps),
      gatherThreads(input.conversationIds, deps),
    ])
    return { ...knowledge, threads }
  }
  const [hits, graph, notes] = await Promise.all([
    deps.searchKnowledge(input.rootPath, input.question).catch(() => [] as AskKnowledgeHit[]),
    deps.readFeatureGraph(input.rootPath).catch(() => ({ nodes: [], edges: [] })),
    deps.readNotes(join(input.rootPath, 'flow')).catch(() => [] as AskNote[]),
  ])
  const { features, relations } = sliceFeatureGraph(graph.nodes, graph.edges, input.tags)
  const threads = await gatherThreads(input.conversationIds, deps)
  return {
    hits: hits.slice(0, MAX_BRAIN_HITS),
    features,
    relations,
    notes: pickNotes(notes, features),
    threads,
    knownIds: graph.nodes.filter(isAddressable).map((node) => node.id),
  }
}
