/**
 * Pure, DOM-free model for the in-thread ArtifactCard (blueprint-interaction
 * Phase 2, #563). Given a flow/ artifact change event, the doc's text, and the
 * active project's compiled story, it derives everything the card renders:
 * kind, title, feature name, an mtime label, the doc's story status, and which
 * narrate action (if any) the card should offer.
 *
 * Everything here is deterministic and side-effect-free so it can be unit
 * tested under the app's node-env ts-jest — renderer components can't import
 * under that runtime (see the CLAUDE memory note "App jest is CJS ts-jest").
 * The ArtifactCard view (artifact-card.ts) owns all DOM; this owns the pure
 * derivation + the per-kind latest-wins dedupe.
 */
import type {
  BlueprintStory,
  FlowArtifactChangedEvent,
  FlowArtifactKind,
  PlanNoteCounts,
} from '../../shared/ipc-contract'
import { isWalkthroughBeingWritten, walkthroughPathFor } from '../../shared/walkthrough-page'
import { quoteMentionPath } from './mention-quoting'

/**
 * The doc's `## Story` state relative to the compiled story.json:
 *   - `compiled`   — the doc has a `## Story` section AND story.json's plan
 *                    matches this doc's derived feature name (it's live).
 *   - `uncompiled` — the doc has a `## Story` section but no matching compiled
 *                    story exists yet (never narrated, or narrated for a
 *                    different doc/plan).
 *   - `missing`    — the doc has no `## Story` section (nothing to compile).
 */
export type ArtifactStoryStatus = 'compiled' | 'uncompiled' | 'missing'

/**
 * The action the card offers for the doc's story status:
 *   - `narrate`   — uncompiled: run `learn:narrate` to compile the section.
 *   - `ask-agent` — missing: prefill the composer to author a `## Story`.
 *   - `null`      — compiled: nothing to do.
 */
export type ArtifactNarrateAction = 'narrate' | 'ask-agent' | null

/** The derived, render-ready view of one flow/ artifact. */
export interface ArtifactCardModel {
  kind: FlowArtifactKind
  /** Repo-relative doc path, e.g. "flow/plans/plan_foo_v1.md". */
  path: string
  /** File basename, e.g. "plan_foo_v1.md". */
  name: string
  /** First `# ` heading of the doc, or the file name when there is none. */
  title: string
  /** Feature name derived from the filename convention, or null when it
   *  doesn't follow `<kind>_<feature>_vN.md`. */
  feature: string | null
  /** Raw mtime (ms since epoch) — kept for latest-wins comparison. */
  mtime: number
  /** Human-readable relative mtime, e.g. "just now", "5m ago", "2026-07-16". */
  mtimeLabel: string
  storyStatus: ArtifactStoryStatus
  narrateAction: ArtifactNarrateAction
  /** The doc's artifact door (generate / writing / open), or null when the
   *  doc is not a discovery. See `deriveFeatureViewAction`. */
  featureViewAction: ArtifactFeatureViewAction | null
  /** A plan's description for the card — its Overview's first paragraph (or
   *  its Intent goal), as plain text; null for other kinds or when the plan
   *  has neither. See `planSummary`. */
  summary: string | null
}

/**
 * `plan_<name>_vN.md` / `discovery_<name>_vN.md` / `brainstorm_<name>_vN.md`.
 * Mirrors the CLI's `derivePlanName` convention (source of truth:
 * `src/cli/blueprint/story-compile.ts`) — the app is a separate npm workspace
 * so the pattern is duplicated on purpose. `narrate` compares story.json's
 * plan against exactly this derivation, so the card must too.
 */
const DERIVED_FEATURE_PATTERN = /^(?:plan|discovery|brainstorm)_(.+?)(?:_v\d+)?$/

/**
 * Feature name from a doc filename, mirroring the CLI `derivePlanName`. Strips
 * any leading directory and the `.md` suffix, then applies the naming pattern.
 * Returns null when the name doesn't follow the convention.
 */
export function deriveFeatureName(name: string): string | null {
  const base = name.replace(/^.*\//, '').replace(/\.md$/, '')
  const match = DERIVED_FEATURE_PATTERN.exec(base)
  return match !== null ? match[1] : null
}

/**
 * The first ATX H1 (`# Heading`) of the doc, trimmed — or null when the doc has
 * none. Requires the `#` to be followed by at least one space so an H2 like
 * `## Story` or a hashtag like `#tag` never counts as the title.
 */
export function firstHeading(text: string): string | null {
  for (const rawLine of text.split('\n')) {
    const match = /^# +(.+?)\s*$/.exec(rawLine)
    if (match !== null) {
      const title = match[1].trim()
      if (title.length > 0) return title
    }
  }
  return null
}

/**
 * Whether the doc carries a `## Story` section. The `\b` after `Story` keeps
 * `## Storyboard`/`## Story Layer`-style headings from matching while still
 * accepting `## Story` at end-of-line (`\n`/`\r` are non-word boundaries).
 */
export function hasStorySection(text: string): boolean {
  return /^## Story\b/m.test(text)
}

/** A doc path in one canonical spelling: posix separators, no leading `./`. */
function canonicalDocPath(path: string): string {
  return path.split('\\').join('/').replace(/^(\.\/)+/, '')
}

/**
 * Whether two doc paths name the same file. story.json records `sourcePath`
 * exactly as `narrate --from` was typed — `./flow/…`, `flow\…`, or an absolute
 * path — while every card carries the watcher's repo-relative `flow/…`. The
 * renderer does not know the repo root, so an absolute path matches a relative
 * one when it ENDS with it on a segment boundary.
 */
export function sameDocPath(a: string, b: string): boolean {
  const left = canonicalDocPath(a)
  const right = canonicalDocPath(b)
  if (left === right) return true
  const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\//.test(path)
  if (isAbsolute(left) && !isAbsolute(right)) return left.endsWith(`/${right}`)
  if (isAbsolute(right) && !isAbsolute(left)) return right.endsWith(`/${left}`)
  return false
}

/**
 * Derive the doc's story status. A null/absent doc body (unreadable file, a
 * name-only card) has no detectable section, so it reads as `missing`.
 *
 * `compiled` means THIS document was narrated: the story's `sourcePath` is the
 * card's path. Every version of a doc has its own card, so a feature match alone
 * would mark `plan_x_v1` compiled when only v2 was narrated and take away its
 * Narrate button. A legacy story.json with no `sourcePath` (or a caller that
 * passes no path) keeps the feature-only match it always had.
 */
export function deriveStoryStatus(
  docText: string | null,
  feature: string | null,
  story: BlueprintStory | undefined,
  path: string | null = null,
): ArtifactStoryStatus {
  if (docText === null || !hasStorySection(docText)) return 'missing'
  if (story === undefined || feature === null || story.plan !== feature) return 'uncompiled'
  const source: unknown = story.sourcePath
  if (path === null || typeof source !== 'string' || source.length === 0) return 'compiled'
  return sameDocPath(source, path) ? 'compiled' : 'uncompiled'
}

/**
 * Map a story status to the card's narrate action — PLANS ONLY. Narration is
 * the plan-review surface; discovery and brainstorm docs are working notes, so
 * their cards offer Open/View but never a Narrate/Ask-agent story action
 * (user request, 2026-07-22).
 */
export function deriveNarrateAction(
  status: ArtifactStoryStatus,
  kind: FlowArtifactKind,
): ArtifactNarrateAction {
  if (kind !== 'plan') return null
  if (status === 'uncompiled') return 'narrate'
  if (status === 'missing') return 'ask-agent'
  return null
}

/**
 * THE ARTIFACT — the app's name for a discovery's user walkthrough page (user
 * call 2026-10-08: "rename the feature view to artifact"). Only the WORDS
 * changed: the page is still `<doc>.walkthrough.html`, served from
 * `flow-page://walkthrough/…`, so every page written before the rename opens.
 */

/** The card button that opens a discovery's artifact. */
export const ARTIFACT_OPEN_LABEL = 'Open artifact'

/** The same door while its page is still being written. */
export const ARTIFACT_WRITING_LABEL = 'Writing artifact…'

/** The card button that asks the thread's agent to write the artifact. */
export const ARTIFACT_GENERATE_LABEL = 'Generate artifact'

/**
 * The message the Generate button sends into the card's thread — the
 * `/artifact` command naming the discovery by its repo-relative path, in the
 * same `@`-reference spelling the composer's own mention picker writes.
 */
export function artifactCommandFor(docPath: string): string {
  return `/artifact @${quoteMentionPath(docPath)}`
}

/**
 * Where a discovery's artifact stands:
 *   - `generate` — there is no page yet; the card offers to have one written.
 *   - `writing`  — the page exists but still carries the template's blanks.
 *   - `ready`    — the page is written; the card opens it.
 */
export type ArtifactPageState = 'generate' | 'writing' | 'ready'

/**
 * What the artifact door does: the discovery's SLUG, the repo-relative PATH of
 * its walkthrough page (`<doc>.walkthrough.html`, beside the markdown) — the
 * page of THIS version, and the tab's identity, so two versions open side by
 * side — the DOC it belongs to (what Generate names), and where the page
 * stands. The card never carries the page itself (forbidden-pattern #13) — the
 * view frames it, when someone actually opens it.
 */
export interface ArtifactFeatureViewAction {
  slug: string
  path: string
  docPath: string
  state: ArtifactPageState
}

/**
 * Whether this card offers an artifact door, and in which state.
 *
 * Discovery only. Discoveries no longer write the page by themselves (user
 * call 2026-10-08: "stop generating that automatic"), so a discovery without
 * one is offered `generate` — the person asks for it from here. A plan or a
 * brainstorm gets nothing, and neither does a doc with no slug or a path that
 * is not markdown (there is nowhere for a page to go).
 */
export function deriveFeatureViewAction(
  kind: FlowArtifactKind,
  feature: string | null,
  path: string,
  walkthrough: boolean,
  writing = false,
): ArtifactFeatureViewAction | null {
  if (kind !== 'discovery') return null
  if (feature === null || feature.trim().length === 0) return null
  const page = walkthroughPathFor(path)
  if (page === null) return null
  return { slug: feature, path: page, docPath: path, state: artifactPageState(walkthrough, writing) }
}

/** The page's state from what the watcher saw beside the doc. */
export function artifactPageState(walkthrough: boolean, writing: boolean): ArtifactPageState {
  if (!walkthrough) return 'generate'
  return writing ? 'writing' : 'ready'
}

const ONE_MINUTE_MS = 60 * 1000
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS
const ONE_DAY_MS = 24 * ONE_HOUR_MS
const ONE_WEEK_MS = 7 * ONE_DAY_MS

/**
 * A deterministic relative-time label for a doc's mtime. Under a week it reads
 * as `just now` / `Nm ago` / `Nh ago` / `Nd ago`; a week or older (or a future
 * mtime from clock skew) falls back to a UTC `YYYY-MM-DD` date, so the label is
 * stable across locales/timezones and testable with a fixed `now`.
 */
export function formatMtimeLabel(mtime: number, now: number): string {
  const delta = now - mtime
  if (delta < 0 || delta >= ONE_WEEK_MS) {
    return new Date(mtime).toISOString().slice(0, 10)
  }
  if (delta < ONE_MINUTE_MS) return 'just now'
  if (delta < ONE_HOUR_MS) return `${Math.floor(delta / ONE_MINUTE_MS)}m ago`
  if (delta < ONE_DAY_MS) return `${Math.floor(delta / ONE_HOUR_MS)}h ago`
  return `${Math.floor(delta / ONE_DAY_MS)}d ago`
}

/**
 * Build the render-ready model from a flow/ artifact event, the doc's text
 * (null when the read failed — the card degrades to a name-only view), and the
 * active project's compiled story (undefined when none). Whether the doc has a
 * walkthrough page rides on the event, not the text.
 */
export function buildArtifactModel(
  event: FlowArtifactChangedEvent,
  docText: string | null,
  story: BlueprintStory | undefined,
  now: number = Date.now(),
): ArtifactCardModel {
  const feature = deriveFeatureName(event.name)
  const heading = docText !== null ? firstHeading(docText) : null
  const storyStatus = deriveStoryStatus(docText, feature, story, event.path)
  return {
    kind: event.kind,
    path: event.path,
    name: event.name,
    title: heading ?? event.name,
    feature,
    mtime: event.mtime,
    mtimeLabel: formatMtimeLabel(event.mtime, now),
    storyStatus,
    narrateAction: deriveNarrateAction(storyStatus, event.kind),
    featureViewAction: deriveFeatureViewAction(
      event.kind,
      feature,
      event.path,
      event.walkthrough === true,
      // Re-checked against `now`, so a card rebuilt after the window closes
      // stops spinning on a page an interrupted turn left half-filled.
      isWalkthroughBeingWritten(event.walkthroughWriting === true, event.walkthroughMtime, now),
    ),
    summary: event.kind === 'plan' && docText !== null ? planSummary(docText) : null,
  }
}

/** The longest description the card prints; a longer one ends at a word with "…". */
export const PLAN_SUMMARY_MAX_CHARS = 280

/**
 * What a plan is about, in a few plain sentences, for the PLAN card (user,
 * 2026-10-09: "lets have a description of the plan that we created" instead of
 * the note counts). The first paragraph under `## Overview`; a plan without one
 * falls back to its `## Intent` goal (`**Goal** — …`). Markdown is reduced to
 * plain text — the card is a summary, not a renderer.
 */
export function planSummary(docText: string): string | null {
  const lines = docText.split('\n')
  const sectionStart = (name: string): number =>
    lines.findIndex((line) => new RegExp(`^##[ \\t]+${name}\\b`, 'i').test(line))
  const firstParagraph = (from: number): string | null => {
    const parts: string[] = []
    for (let i = from + 1; i < lines.length; i += 1) {
      const line = (lines[i] ?? '').trim()
      if (/^#{1,6}[ \t]/.test(line)) break
      if (line === '') {
        if (parts.length > 0) break
        continue
      }
      if (/^[-*][ \t]/.test(line) && parts.length === 0) continue // a list is not the description
      if (/^[-*][ \t]/.test(line)) break
      parts.push(line)
    }
    return parts.length === 0 ? null : parts.join(' ')
  }
  let raw: string | null = null
  const overview = sectionStart('Overview')
  if (overview !== -1) raw = firstParagraph(overview)
  if (raw === null) {
    const goal = lines.find((line) => /^\*\*Goal\*\*/.test(line.trim()))
    if (goal !== undefined) raw = goal.trim().replace(/^\*\*Goal\*\*[ \t]*[—–:-]?[ \t]*/, '')
  }
  if (raw === null) return null
  const plain = plainText(raw)
  if (plain.length === 0) return null
  if (plain.length <= PLAN_SUMMARY_MAX_CHARS) return plain
  const cut = plain.slice(0, PLAN_SUMMARY_MAX_CHARS)
  const atWord = cut.slice(0, Math.max(cut.lastIndexOf(' '), 1)).replace(/[\s,;:.—–-]+$/, '')
  return `${atWord}…`
}

/** Markdown inline marks reduced to their text: links, code, emphasis. */
function plainText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether `next` should replace the current card for its kind — true when there
 * is no current card or `next` is at least as recent (latest-wins per kind).
 * Ties keep the newcomer so a re-emitted event with the same mtime still
 * refreshes derived fields (e.g. a freshly-compiled story).
 */
export function supersedes(
  next: ArtifactCardModel,
  prev: ArtifactCardModel | undefined,
): boolean {
  return prev === undefined || next.mtime >= prev.mtime
}

/**
 * What #renderArtifactCard should do for a card owned by `owner` when
 * `threadId` is active (#658). An artifact card belongs to the thread that was
 * active when its doc-change event arrived — the same ownership rule the story
 * card uses — so switching chats never carries another thread's card along:
 *   - `render` — the active thread owns the card.
 *   - `adopt`  — the card is unowned (its event arrived while no thread was
 *                active); the active thread claims it and renders.
 *   - `skip`   — another thread owns it, or no thread is active.
 */
export type ArtifactRenderDecision = 'render' | 'adopt' | 'skip'

export function artifactRenderDecision(
  owner: string | null,
  threadId: string | null,
): ArtifactRenderDecision {
  if (threadId === null) return 'skip'
  if (owner === null) return 'adopt'
  return owner === threadId ? 'render' : 'skip'
}

/**
 * Collapse a list of models to the latest per kind (latest-wins by mtime), in
 * first-seen kind order. Used to render the set of known artifacts on thread
 * load — at most one card per kind.
 */
export function latestPerKind(
  models: readonly ArtifactCardModel[],
): ArtifactCardModel[] {
  const byKind = new Map<FlowArtifactKind, ArtifactCardModel>()
  for (const model of models) {
    if (supersedes(model, byKind.get(model.kind))) byKind.set(model.kind, model)
  }
  return [...byKind.values()]
}

/**
 * Index of the card that should HOST a compiled story, or -1 when none claims
 * it (the story then stands alone in the feed, as it always did).
 *
 * The match is the model's derived feature against the story's `plan` — the same
 * derivation `narrate` itself compares story.json against, so the nesting rule
 * can never drift from the compile rule.
 *
 * Several cards can share one feature: every VERSION of a discovery keeps its
 * own card (`_v7` and `_v8` side by side, user call 2026-10-01), and a plan
 * folds into one of them. The story was compiled from ONE document, so the card
 * that holds that document (`sourcePath`) hosts it — never an older version's
 * card. When the thread has no card for the source at all, the NEWEST card for
 * the feature wins, because the compiled story reflects the most recent narrate. Ties keep
 * the earlier candidate, so a rebuild that reproduces identical mtimes doesn't
 * make the story hop between cards.
 *
 * Callers pass only the models of cards actually mounted in the feed; a
 * detached card is not a host. `knownPaths` are the docs this thread has a card
 * (or a marker) for ANYWHERE, mounted or not: when the source document is one
 * of them but its card is not mounted — collapsed behind "Show earlier" — the
 * story stands alone rather than move onto another version's card, which would
 * present v7's story under v8's name. Paths compare through `sameDocPath`, so a
 * `./flow/…` or absolute `sourcePath` still finds its card.
 */
export function storyHostIndex(
  cards: readonly { feature: string | null; mtime: number; paths: readonly string[] }[],
  story: Pick<BlueprintStory, 'plan' | 'sourcePath'>,
  knownPaths: readonly string[] = [],
): number {
  const source: unknown = story.sourcePath
  const holds = (path: string): boolean => typeof source === 'string' && source.length > 0 && sameDocPath(source, path)
  const holder = cards.findIndex((card) => card.feature === story.plan && card.paths.some(holds))
  if (holder !== -1) return holder
  if (knownPaths.some(holds)) return -1
  let best = -1
  cards.forEach((card, index) => {
    if (card.feature !== story.plan) return
    if (best === -1 || card.mtime > cards[best]!.mtime) best = index
  })
  return best
}

/** The button that opens the document itself, when a click on the card does not. */
export const OPEN_DOC_LABEL = 'Open md file'

/**
 * The Open md file button's hover text — the KIND of document, never its file
 * name (forbidden-pattern #12: a file name in UI text describes how the feature
 * is stored, not what pressing the button does).
 */
export function openDocTooltip(kind: ArtifactCardModel['kind']): string {
  return `Open the ${kind} as a rendered preview`
}

/**
 * Whether the card shows an "Open md file" button. Pressing the card opens its
 * document too; the button stays on discovery and plan cards so the action
 * row reads the same as it did when the press opened the board's discovery
 * view (retired 2026-10-08). A brainstorm, or a doc with no derivable slug,
 * shows none — exactly the cards that never had it.
 */
export function showsOpenDocButton(model: Pick<ArtifactCardModel, 'kind' | 'feature'>): boolean {
  if (model.kind !== 'discovery' && model.kind !== 'plan') return false
  return model.feature !== null && model.feature.trim().length > 0
}

// ── One card per document version ─────────────────────────────────────────
//
// Every discovery, plan and brainstorm VERSION keeps its own card at the place
// in the thread where it was written: a thread that regenerated its discovery
// eight times shows eight cards, so any two can be opened and compared (user
// call 2026-10-01 — folding `_v2` … `_v8` into the first card left the chat
// with one card and seven bare "Created:" lines).
//
// The one fold that stays is ACROSS kinds (user call 2026-09-30): the plan
// written from a discovery is part of that discovery's card, so the pair reads
// as one piece of work. It folds into the MOST RECENT discovery card of its
// feature that precedes it — the version it was written from — and only while
// that card holds no plan yet. A second plan version is its own card.

/** One document folded into a card. */
export interface ArtifactDocRef {
  kind: FlowArtifactKind
  path: string
  name: string
  mtime: number
}

/** The order a feature's documents are written in, which is the order a card
 *  lists them — never the order they happened to arrive. */
const STAGE_ORDER: readonly FlowArtifactKind[] = ['brainstorm', 'discovery', 'plan']

/** The reference a card keeps for one of its documents. */
export function docRefOf(model: Pick<ArtifactCardModel, 'kind' | 'path' | 'name' | 'mtime'>): ArtifactDocRef {
  return { kind: model.kind, path: model.path, name: model.name, mtime: model.mtime }
}

/** `discovery_x_v7.md` → `v7`; a name with no version reads as null. */
export function docVersionLabel(name: string): string | null {
  const match = /_v(\d+)(?:\.md|\.walkthrough\.html)?$/i.exec(name.replace(/^.*\//, ''))
  return match === null ? null : `v${match[1]}`
}

/**
 * The card's second line: the feature, the version THIS card stands for, and
 * when it last changed — `checkout · v7 · 5m ago`. Without the version, eight
 * cards for one discovery would read identically.
 */
export function artifactSubLine(feature: string | null, name: string, mtimeLabel: string): string {
  return [feature, docVersionLabel(name), mtimeLabel].filter((part): part is string => part !== null && part !== '').join(' · ')
}

/** What the fold rule needs to know about a card already in the feed. */
export interface ArtifactCardSlot {
  /** The kind of the card's own document. */
  kind: FlowArtifactKind
  feature: string | null
  /** Every document the card stands for, its own included. */
  docs: readonly Pick<ArtifactDocRef, 'kind'>[]
}

/**
 * Which card in the feed a new document folds into, or -1 when it gets a card
 * of its own. `cards` are in FEED ORDER, and all precede the document.
 *
 * NOTHING FOLDS ANY MORE (user, 2026-10-08): "keep the component of the
 * discovery on the chat exactly the same" and give the plan "a UI component
 * like that … after the creation of the plan". A plan used to join its
 * discovery's card as a second chip, which changed the discovery's card and
 * hid the plan's own. Every document now has its own card at its own place in
 * the transcript; the rule stays a function so the fold call sites need no
 * second path.
 */
export function foldHostIndex(
  _cards: readonly ArtifactCardSlot[],
  _doc: { kind: FlowArtifactKind; feature: string | null },
): number {
  return -1
}

/**
 * For a thread's artifact markers in TRANSCRIPT order, the doc path of the card
 * that stands for each one: its own path, or the discovery it folds into.
 *
 * Decided over the WHOLE transcript before anything is built, because the feed
 * is not built in transcript order — rows behind "Show earlier" are built when
 * they are expanded — and a fold must not depend on which rows happened to be
 * built first. A path seen twice keeps its first answer.
 */
export function artifactCardHosts(markers: readonly { kind: FlowArtifactKind; path: string }[]): Map<string, string> {
  const hosts = new Map<string, string>()
  const slots: Array<ArtifactCardSlot & { path: string; docs: Array<Pick<ArtifactDocRef, 'kind'>> }> = []
  for (const marker of markers) {
    if (hosts.has(marker.path)) continue
    const feature = deriveFeatureName(marker.path)
    const index = foldHostIndex(slots, { kind: marker.kind, feature })
    const host = slots[index]
    if (host !== undefined) {
      host.docs.push({ kind: marker.kind })
      hosts.set(marker.path, host.path)
      continue
    }
    slots.push({ kind: marker.kind, feature, path: marker.path, docs: [{ kind: marker.kind }] })
    hosts.set(marker.path, marker.path)
  }
  return hosts
}

/**
 * Fold `doc` into a card's documents: the same path is replaced (a fresher
 * read of it), anything else is added, and the list is in stage order. Returns
 * a new array.
 */
export function foldDoc(docs: readonly ArtifactDocRef[], doc: ArtifactDocRef): ArtifactDocRef[] {
  const next = [...docs.filter((existing) => existing.path !== doc.path), doc]
  return STAGE_ORDER.flatMap((kind) => next.filter((ref) => ref.kind === kind))
}

/** The most recent change across a card's documents — what "updated …" reads. */
export function newestMtime(docs: readonly ArtifactDocRef[]): number {
  return docs.reduce((newest, doc) => Math.max(newest, doc.mtime), 0)
}

// ── The next step, from the card (plan `plan_change_review`, Phase 7) ──────
//
// The card runs the workflow's next step itself: a discovery offers **Create
// the plan**, a plan offers **Review the change** and **Execute the plan**.
// Only a person's press sends anything (no auto-chaining, FR-17), and every
// send is a MESSAGE into the card's thread through the composer's own send,
// exactly as Generate artifact is. The commands below are message text; no
// label, title or sentence on the card names a command, a path or a key.

/** The discovery card's button that asks the agent to plan from it. */
export const PLAN_CREATE_LABEL = 'Create the plan'

/** The plan card's button that opens its change notes for review. */
export const PLAN_REVIEW_LABEL = 'Review the change'

/** The plan card's button that asks the agent to build it. */
export const PLAN_EXECUTE_LABEL = 'Execute the plan'

/** The confirm box's three answers. */
export const EXECUTE_ANYWAY_LABEL = 'Execute anyway'
export const REVIEW_FIRST_LABEL = 'Review first'
export const CANCEL_LABEL = 'Cancel'

/** What Create the plan sends: `/create-plan @<discovery>`. */
export function planCommandFor(discoveryPath: string): string {
  return `/create-plan @${quoteMentionPath(discoveryPath)}`
}

/** What Execute the plan sends: `/execute-plan @<plan>`. */
export function executeCommandFor(planPath: string): string {
  return `/execute-plan @${quoteMentionPath(planPath)}`
}

/**
 * The plan's slug as the notes reader names it — the `<feature>` of
 * `plan_<feature>_v<N>.md`. Null for anything that is not a plan file.
 */
export function planSlugOf(path: string): string | null {
  const base = path.replace(/^.*\//, '')
  if (!/^plan_.+\.md$/.test(base)) return null
  return deriveFeatureName(base)
}

/**
 * Which of the card's documents its action row is about. A card that holds
 * one document is about it; a card that holds several follows the chip the
 * person last pressed, and before any press it is about its OWN document —
 * the discovery a plan folded into, so the card reads exactly as it did
 * before the plan arrived (its artifact door included) until someone presses
 * the Plan chip. A chosen path the card no longer holds falls back the same way.
 */
export function selectedDocOf(
  docs: readonly ArtifactDocRef[],
  chosenPath: string | null,
  ownPath: string,
): ArtifactDocRef | null {
  if (docs.length === 0) return null
  const find = (path: string | null): ArtifactDocRef | undefined =>
    path === null ? undefined : docs.find((doc) => doc.path === path)
  // Nothing pressed yet: the furthest stage is what the card is about — a held
  // plan is selected, so Execute the plan is on the card without a press.
  const plan = docs.find((doc) => doc.kind === 'plan')
  return find(chosenPath) ?? plan ?? find(ownPath) ?? docs[0] ?? null
}

/** One button in the card's action row. */
export type ArtifactRowAction = 'create-plan' | 'review-change' | 'execute-plan' | 'open-doc' | 'artifact'

export interface ArtifactRowInput {
  /** The kind of the selected document. */
  selected: FlowArtifactKind
  /** Every kind the card holds. */
  holds: readonly FlowArtifactKind[]
  /** Whether the card shows Open md file at all (`showsOpenDocButton`). */
  openDoc: boolean
  /** Whether the card's discovery has an artifact door. */
  artifact: boolean
  /** The selected plan's note counts, or null while unknown / unreadable. */
  notes: PlanNoteCounts | null
}

/**
 * The action row, in order, for the selected document.
 *
 *   - a PLAN: Review the change (only when it carries notes — there is
 *     nothing to review in a plan without them), Execute the plan, Open md file.
 *   - a DISCOVERY: Create the plan while the card holds no plan (once it does,
 *     the Plan chip already says so and the button is gone), Open md file, the
 *     artifact door.
 *   - a brainstorm: whatever it had (Open md file / artifact rules decide).
 */
export function artifactRowActions(input: ArtifactRowInput): ArtifactRowAction[] {
  if (input.selected === 'plan') {
    const row: ArtifactRowAction[] = []
    if (input.notes !== null && input.notes.total > 0) row.push('review-change')
    row.push('execute-plan')
    if (input.openDoc) row.push('open-doc')
    // The artifact belongs to the discovery the plan came from; it stays one press away.
    if (input.artifact) row.push('artifact')
    return row
  }
  const row: ArtifactRowAction[] = []
  if (input.selected === 'discovery' && !input.holds.includes('plan')) row.push('create-plan')
  if (input.openDoc) row.push('open-doc')
  if (input.selected === 'discovery' && input.artifact) row.push('artifact')
  return row
}

/** One note pill: its words and how it reads. */
export interface NotePill {
  label: string
  tone: 'neutral' | 'ok' | 'no' | 'wait'
}

/**
 * The plan card's note pills — none since 2026-10-09 (the user removed them).
 * None when the plan carries no notes (an old plan reads as it always did).
 */
export function notePills(_counts: PlanNoteCounts | null): NotePill[] {
  // NO PILLS ON THE CARD (user, 2026-10-09: "remove those two as well"). The
  // counts still drive Review the change and Execute's confirm; the card just
  // does not print them.
  return []
}

/**
 * Whether the card shows its inner STORY section. With the plan selected and
 * the plan carrying notes, the plan's review is Review the change, so the
 * concept story stays out of the way; everything else is exactly as before.
 */
export function showsInnerStory(selected: FlowArtifactKind | null, counts: PlanNoteCounts | null): boolean {
  if (selected !== 'plan') return true
  return counts === null || counts.total <= 0
}

/** Where Execute the plan stands on this card. */
export type ExecuteState = 'idle' | 'confirm' | 'running'

/**
 * What pressing Execute the plan does: ask first when any note is unreviewed
 * (it would be built as written), else go straight to running.
 */
export function executePressState(counts: PlanNoteCounts | null): Exclude<ExecuteState, 'idle'> {
  return counts !== null && counts.unreviewed > 0 ? 'confirm' : 'running'
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

/**
 * The confirm box's sentence: how many notes are unreviewed (built as written)
 * and how many rejected ones are left out. Null when nothing is unreviewed.
 */
export function executeConfirmText(counts: PlanNoteCounts | null): string | null {
  if (counts === null || counts.unreviewed <= 0) return null
  const u = counts.unreviewed
  const head = `${u} ${plural(u, 'note has', 'notes have')} not been reviewed.`
  const built = `${plural(u, 'It is', 'They are')} built as written`
  const r = counts.rejected
  const left = r > 0 ? `; the ${r} rejected ${plural(r, 'note is', 'notes are')} left out` : ''
  return `${head} ${built}${left}.`
}

/** The running line's footnote about rejected notes, or null when there are none. */
export function rejectedLeftOutText(counts: PlanNoteCounts | null): string | null {
  if (counts === null || counts.rejected <= 0) return null
  const r = counts.rejected
  return `${r} rejected ${plural(r, 'note is', 'notes are')} left out.`
}

/** The number of phases a plan declares (`### Phase N:` headings). */
export function planPhaseCount(text: string | null): number | null {
  if (text === null) return null
  const count = (text.match(/^###\s+Phase\s+\d+\b/gm) ?? []).length
  return count > 0 ? count : null
}

/**
 * Whether the run state's active plan is this plan. The execution state names
 * the plan by its slug or by its file (with or without a folder), so both are
 * accepted — and the slug is compared whole, never with a `plan_` prefix
 * stripped from it (a slug may itself begin with `plan_`).
 */
export function runIsForPlan(activePlan: string | undefined, slug: string): boolean {
  if (activePlan === undefined) return false
  const named = activePlan.trim().replace(/^.*\//, '').replace(/^@/, '')
  if (named === slug) return true
  // Only a FILE name (`.md` or a `_vN` version) is read as plan_<slug>_vN.
  if (!/\.md$|_v\d+$/.test(named)) return false
  return deriveFeatureName(named) === slug
}

/** The run state the running line reads — FlowState's fields, narrowed. */
export interface PlanRunState {
  activeSkill?: string
  activePlan?: string
  activePhase?: string
}

/** The words shown while the run has not said which phase it is on. */
export const EXECUTING_FALLBACK_LABEL = 'Executing the plan…'

/**
 * The running line: `Executing — phase 2 of 3: <name>` when the run state is
 * about THIS plan and names its phase, else the plain fallback. The phase
 * count comes from the plan itself; without it the line drops the "of N".
 */
export function runningLine(run: PlanRunState | null, slug: string, phaseCount: number | null): string {
  if (run === null || !runIsForPlan(run.activePlan, slug) || run.activePhase === undefined) {
    return EXECUTING_FALLBACK_LABEL
  }
  const match = /^(?:Phase\s+)?(\d+)\s*(?:[—–:\-]+\s*(.+))?$/i.exec(run.activePhase.trim())
  if (match === null) return EXECUTING_FALLBACK_LABEL
  const number = match[1]!
  const name = match[2]?.trim()
  const of = phaseCount !== null ? ` of ${phaseCount}` : ''
  return name !== undefined && name.length > 0
    ? `Executing — phase ${number}${of}: ${name}`
    : `Executing — phase ${number}${of}`
}

/**
 * Whether a run that was started from this card has finished: the run state
 * once named this plan under execute-plan (`seen`) and no longer does. Before
 * the run state ever names it the card keeps running — the agent may not have
 * started yet.
 */
export function runHasEnded(run: PlanRunState | null, slug: string, seen: boolean): boolean {
  return seen && run !== null && !runIsLive(run, slug)
}

/**
 * A run started from a card's Execute, as the pane tracks it until it ends.
 *
 * The run state alone cannot end every run: a queued message that was
 * cancelled, an agent that declines, or a run that ends before any state
 * broadcast never names the plan at all, and `runHasEnded` keeps an unseen run
 * going for ever — the card read "Executing the plan…" with Execute disabled
 * until the app restarted. So the run also follows the TURN that carries it.
 */
export interface CardRun {
  /** The run state has named this plan under execute-plan. */
  seen: boolean
  /** A turn has started since Execute was pressed — the one carrying the message. */
  turnStarted: boolean
  /** Since when the thread has rested with no turn carrying the message (ms), or null. */
  idleSince: number | null
}

/** How long an unseen run waits, with the thread resting, for its message's turn. */
export const UNSEEN_RUN_IDLE_LIMIT_MS = 60_000

/** What can move a card's run along. */
export type CardRunEvent =
  | { kind: 'turn-start' }
  | { kind: 'turn-end'; now: number; run: PlanRunState | null }
  | { kind: 'state'; run: PlanRunState | null }
  | { kind: 'tick'; now: number; turnLive: boolean }

/** A run just started from a card; a resting thread starts the idle clock. */
export function startCardRun(now: number, turnLive: boolean): CardRun {
  return { seen: false, turnStarted: false, idleSince: turnLive ? null : now }
}

/**
 * The run after `event`, or null once it has ended.
 *
 * - the run state names it live → seen; once seen, it ends when the state stops naming it;
 * - the turn that carried the message ends and the state does not name the plan → ended
 *   (an earlier turn ending — the message was queued behind it — only starts the idle clock);
 * - the thread rested `UNSEEN_RUN_IDLE_LIMIT_MS` with no turn carrying it (the queued
 *   message was cancelled) → ended. A seen run never ends by the clock.
 */
export function cardRunAfter(run: CardRun, event: CardRunEvent, slug: string): CardRun | null {
  switch (event.kind) {
    case 'turn-start':
      return { ...run, turnStarted: true, idleSince: null }
    case 'state':
      if (runIsLive(event.run, slug)) return { ...run, seen: true }
      return runHasEnded(event.run, slug, run.seen) ? null : run
    case 'turn-end':
      if (runIsLive(event.run, slug)) return { ...run, seen: true, idleSince: null }
      if (run.seen) return runHasEnded(event.run, slug, true) ? null : run
      if (run.turnStarted) return null
      return { ...run, idleSince: event.now }
    case 'tick':
      // A live turn may be the one carrying the message: its end decides.
      if (event.turnLive) return run.idleSince === null ? run : { ...run, idleSince: null }
      if (run.seen || run.idleSince === null) return run
      return event.now - run.idleSince >= UNSEEN_RUN_IDLE_LIMIT_MS ? null : run
  }
}

/**
 * The discoveries a thread has asked to plan from — kept by the pane, not the
 * card, because a card is rebuilt (every reconcile, every thread switch) and a
 * guard held on the card was lost with it: Create the plan was offered again
 * and pressed twice sent `/create-plan` twice. A request is recorded only when
 * the message was actually sent, and is forgotten once a plan for that
 * feature is known (the card then holds the plan and offers no Create).
 */
export class PlanRequests {
  readonly #requested = new Set<string>()

  static #key(threadId: string, discoveryPath: string): string {
    return `${threadId}\u0000${discoveryPath}`
  }

  /** Record a SENT request. */
  record(threadId: string, discoveryPath: string): void {
    this.#requested.add(PlanRequests.#key(threadId, discoveryPath))
  }

  /** Whether the thread asked for this discovery's plan and none is known yet. */
  isRequested(threadId: string | null, discoveryPath: string, planWritten: boolean): boolean {
    if (threadId === null) return false
    const key = PlanRequests.#key(threadId, discoveryPath)
    if (planWritten) {
      this.#requested.delete(key)
      return false
    }
    return this.#requested.has(key)
  }
}

/** Whether the run state shows this plan being executed. */
export function runIsLive(run: PlanRunState | null, slug: string): boolean {
  if (run === null) return false
  const skill = run.activeSkill?.trim().toLowerCase() ?? ''
  return runIsForPlan(run.activePlan, slug) && skill.includes('execute')
}

/**
 * Whether a watcher event is HISTORY rather than a write — handled exactly
 * like the startup seed: it hydrates any inline card the doc already has and
 * never pins a feed-end card.
 *
 * A `replayed` event is the watch RE-LISTING a doc after `flow/` was re-pointed
 * (a project placed in its Workspace copies its docs over, new mtimes and all).
 * Nobody wrote anything, so it belongs to the thread that wrote the doc
 * (`threadId`, when main knows it) and to nobody else — main records no marker
 * for it either. Mounting it in whatever thread is open put days-old docs at
 * the bottom of an unrelated conversation (#1056's complaint, by another door).
 * A doc this pane already saw WRITTEN this session stays live: a re-listing
 * cannot demote a real write.
 */
export function artifactEventIsHistorical(input: {
  replayed: boolean
  eventThreadId: string | null
  threadId: string | null
  priorLive: boolean
}): boolean {
  if (!input.replayed || input.priorLive) return false
  return input.eventThreadId === null || input.eventThreadId !== input.threadId
}

/**
 * Whether a NEW card for a live doc waits instead of mounting now.
 *
 * While the agent's turn is running, a doc lands in pieces: the markdown first
 * (a card with a title and buttons), its compiled story a few tool calls later
 * (the same card, grown). The reader saw a small card become a big one (user,
 * 2026-10-08: "don't show the small version"). So a card that does not exist yet
 * waits for the turn to end — the reconcile that follows mounts it once, whole.
 * Seeded docs never mount a feed-end card anyway, and a card already on screen
 * is updated in place, so only the first appearance is held.
 */
export function holdsNewArtifactCard(input: { turnRunning: boolean; seeded: boolean }): boolean {
  return input.turnRunning && !input.seeded
}

/**
 * The run state a plan's card reads, from the run states of the projects that
 * may record its run — the plan's own project first, then the thread's. A
 * plan in a project attached to the thread is executed from the thread's
 * project, so either may be the one whose run state names it: the one that
 * shows it executing wins, else the first that answered at all.
 */
export function planRunStateFor(states: readonly (PlanRunState | null)[], slug: string): PlanRunState | null {
  return states.find((state) => runIsLive(state, slug)) ?? states.find((state) => state !== null) ?? null
}

/**
 * How a card's message names a document: by its project-relative path when it
 * lives in the thread's own project (the agent's working directory), by its
 * absolute path when it lives in a project attached to the thread — where the
 * relative path names nothing.
 */
export function docMention(path: string, docRoot: string | null, activeRoot: string | null): string {
  if (docRoot === null || docRoot === '' || docRoot === activeRoot) return path
  return `${docRoot}/${path}`
}
