/**
 * Pure, DOM-free model for the in-thread StoryCard (blueprint-v2 Phase 4).
 *
 * Everything here is deterministic and side-effect-free so it can be unit
 * tested under the app's node-env ts-jest (renderer components can't import
 * under that runtime — see the CLAUDE memory note "App jest is CJS ts-jest").
 * The StoryCard view (story-card.ts) owns all DOM; this owns:
 *   - step-index state + clamping
 *   - chip-group capping (cap N, with a trailing "…and K more" overflow entry)
 *   - a stable story identity (plan + step ids + bodies) used to key the
 *     per-(thread, story) minimize memory
 *   - the auto-expand decision: a NEW story identity expands + resets memory,
 *     the SAME identity honors the user's remembered minimize choice.
 */
import type { BlueprintAnchor, BlueprintStory } from '../../shared/ipc-contract'

/** Default max chips rendered per group before overflow collapses the rest. */
export const CHIP_CAP = 6

/** One entry in a capped chip group. `overflow` marks the "…and K more" tail. */
export interface CappedChip {
  text: string
  overflow: boolean
}

/**
 * Clamp a (possibly out-of-range or non-finite) step index into [0, count-1].
 * An empty story (count 0) clamps to 0 so callers have a stable sentinel.
 */
export function clampStep(index: number, count: number): number {
  if (count <= 0) return 0
  if (!Number.isFinite(index)) return 0
  const floored = Math.floor(index)
  if (floored < 0) return 0
  if (floored > count - 1) return count - 1
  return floored
}

/**
 * Cap a chip group at `cap` rendered entries. When the source has more than
 * `cap` items, the first `cap - 1` are shown followed by a single
 * "…and K more" overflow entry, so the group never renders more than `cap`
 * chips. At or under the cap, every item passes through unchanged.
 */
export function capChips(items: readonly string[], cap: number = CHIP_CAP): CappedChip[] {
  const effectiveCap = cap < 1 ? 1 : cap
  if (items.length <= effectiveCap) {
    return items.map((text) => ({ text, overflow: false }))
  }
  const visibleCount = effectiveCap - 1
  const shown: CappedChip[] = items
    .slice(0, visibleCount)
    .map((text) => ({ text, overflow: false }))
  const remaining = items.length - visibleCount
  shown.push({ text: `…and ${remaining} more`, overflow: true })
  return shown
}

/**
 * The repo-relative path a step anchor names, or null when the
 * anchor kind doesn't identify one concrete file (module/table/endpoint, or a
 * symbol anchor with no `file` scope) — a `file`-kind anchor's `ref` IS the
 * path; a `symbol`-kind anchor's optional `file` scopes it the same way.
 *
 * This is the one rule for "does this anchor name a file", so `anchorPrimaryAction`
 * asks it rather than deciding again — a kind that gains a path must not start
 * opening in one reader and attaching in the other.
 *
 * Mirrors blueprint/peek-anchor.ts's `anchorPeekPath` — duplicated, not
 * imported, because the StoryCard is deliberately import-free from the
 * blueprint board (see story-card.ts's header comment); keep the two in sync.
 */
export function anchorPeekPath(anchor: BlueprintAnchor): string | null {
  if (anchor.kind === 'file') return anchor.ref
  if (anchor.kind === 'symbol' && anchor.file !== undefined) return anchor.file
  return null
}

/**
 * What a click on a step anchor's own chip does.
 *
 * An anchor that names one concrete file OPENS it (user call 2026-10-14):
 * the anchors are how a reader gets from the story to the code, and the chip
 * is the thing they aim at. Attaching the reference to the composer — what the
 * chip used to do — moves to a secondary control beside it, because wanting to
 * READ the file is the common case and wanting to TALK about it is the rare
 * one.
 *
 * An anchor that names no file (module/table/endpoint, or a symbol with no
 * `file` scope) has nothing to open, so its chip still attaches. That is not a
 * fallback for a failed open: the kind is known before the click, so the chip
 * can say which of the two it is in its own tooltip.
 */
export type AnchorPrimaryAction = { kind: 'open'; path: string } | { kind: 'attach' }

export function anchorPrimaryAction(anchor: BlueprintAnchor): AnchorPrimaryAction {
  const path = anchorPeekPath(anchor)
  return path === null ? { kind: 'attach' } : { kind: 'open', path }
}

/** FNV-1a over the input, returned as an 8-char lowercase hex string. */
function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    // 32-bit FNV prime multiply via shifts to stay in the safe-integer range.
    hash = Math.imul(hash, 0x01000193)
  }
  // >>> 0 coerces to an unsigned 32-bit int before hex-formatting.
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * A stable identity for a compiled story: two stories with the same plan and
 * the same ordered (step id, body) pairs hash identically. Editing a step's
 * body, reordering steps, adding/removing a step, or renaming the plan all
 * change the identity — which is exactly when the card should re-expand.
 * Kicker/title/anchors are intentionally excluded: they don't change what the
 * user is reading enough to warrant re-expanding a minimized card.
 */
export function storyIdentity(story: BlueprintStory): string {
  // NUL separators keep field boundaries unambiguous (they can't appear in
  // plan names / ids / bodies), so distinct inputs can't alias to one string.
  const canonical = [
    story.plan,
    ...story.steps.map((step) => `${step.id}\x00${step.body}`),
  ].join('\x00\x00')
  return `${fnv1aHex(canonical)}:${story.steps.length}`
}

/** Remembered minimize state for one (thread, story identity). */
export interface StoryMinimizeState {
  identity: string
  minimized: boolean
}

/**
 * Decide whether the card should mount EXPANDED. A missing memory entry or a
 * changed identity is a new story → expand. The same identity honors the
 * user's last choice → expand only when it wasn't left minimized.
 */
export function shouldAutoExpand(
  memory: StoryMinimizeState | undefined,
  identity: string,
): boolean {
  if (!memory || memory.identity !== identity) return true
  return !memory.minimized
}

/**
 * Per-(thread, story) minimize memory. The conversation pane keeps one
 * instance and keys it by threadId; the story identity guards against a stale
 * minimize choice leaking onto a different story shown in the same thread.
 */
export class StoryMinimizeMemory {
  readonly #byThread = new Map<string, StoryMinimizeState>()

  /**
   * Resolve the mount state for `(threadId, identity)`. A new/changed identity
   * RESETS the thread's memory to expanded and returns true; the same identity
   * returns the remembered expand state without mutating anything.
   */
  resolveAutoExpand(threadId: string, identity: string): boolean {
    const current = this.#byThread.get(threadId)
    const expand = shouldAutoExpand(current, identity)
    if (!current || current.identity !== identity) {
      this.#byThread.set(threadId, { identity, minimized: false })
    }
    return expand
  }

  /** Record the user's minimize/expand choice for the active (thread, story). */
  setMinimized(threadId: string, identity: string, minimized: boolean): void {
    this.#byThread.set(threadId, { identity, minimized })
  }

  /** Read a thread's remembered state (undefined when none). */
  peek(threadId: string): StoryMinimizeState | undefined {
    return this.#byThread.get(threadId)
  }

  /** Drop a thread's memory (thread switch / story clear). */
  clear(threadId: string): void {
    this.#byThread.delete(threadId)
  }
}

/**
 * Persisted map of which THREAD owns each project's compiled story. A story is
 * a project-level artifact, but it belongs to the thread that authored it (the
 * thread active when it was narrated) — so the in-thread card shows ONLY in
 * that thread, never in unrelated or brand-new ones. Keyed by (rootId, plan):
 * a plan's owner is stable across step edits / re-narrates in the same thread.
 * Serializable so the ownership survives an app relaunch (localStorage).
 *
 * `anchorAt` (ISO timestamp) pins the in-thread card at the feed position where
 * the plan was created (the claim moment), instead of chasing the feed end on
 * every turn. Legacy string-only records (pre-anchor) parse with no anchor and
 * are backfilled on first render.
 */
export interface StoryOwnershipRecord {
  threadId: string
  anchorAt?: string
}
export type StoryOwnershipState = Record<string, Record<string, string | StoryOwnershipRecord>>

export class StoryOwnership {
  readonly #byRoot = new Map<string, Map<string, StoryOwnershipRecord>>()

  /** Hydrate from a persisted snapshot, skipping malformed entries. */
  constructor(initial?: StoryOwnershipState | null) {
    if (!initial || typeof initial !== 'object') return
    for (const [rootId, plans] of Object.entries(initial)) {
      if (!plans || typeof plans !== 'object') continue
      const owned = new Map<string, StoryOwnershipRecord>()
      for (const [plan, value] of Object.entries(plans)) {
        if (typeof value === 'string' && value.length > 0) {
          owned.set(plan, { threadId: value })
        } else if (value && typeof value === 'object' && typeof value.threadId === 'string' && value.threadId.length > 0) {
          owned.set(plan, {
            threadId: value.threadId,
            ...(typeof value.anchorAt === 'string' ? { anchorAt: value.anchorAt } : {}),
          })
        }
      }
      if (owned.size > 0) this.#byRoot.set(rootId, owned)
    }
  }

  /** The thread that owns `plan` in `rootId`, or undefined when unclaimed. */
  ownerOf(rootId: string | null, plan: string): string | undefined {
    if (!rootId) return undefined
    return this.#byRoot.get(rootId)?.get(plan)?.threadId
  }

  /** The feed-position anchor for `plan`, or undefined (legacy / unclaimed). */
  anchorOf(rootId: string | null, plan: string): string | undefined {
    if (!rootId) return undefined
    return this.#byRoot.get(rootId)?.get(plan)?.anchorAt
  }

  /**
   * Claim `plan` in `rootId` for `threadId`, anchoring the card at `anchorAt`.
   * Returns true when the stored owner changed (the caller should persist),
   * false when `threadId` already owned it (existing anchor kept — a re-narrate
   * in the owning thread must not move the card).
   */
  claim(rootId: string, plan: string, threadId: string, anchorAt?: string): boolean {
    let owned = this.#byRoot.get(rootId)
    if (owned?.get(plan)?.threadId === threadId) return false
    if (!owned) {
      owned = new Map<string, StoryOwnershipRecord>()
      this.#byRoot.set(rootId, owned)
    }
    owned.set(plan, { threadId, ...(anchorAt !== undefined ? { anchorAt } : {}) })
    return true
  }

  /**
   * Backfill the anchor on a legacy record that has none. Returns true when a
   * value was written (persist), false when absent-record or already anchored.
   */
  setAnchor(rootId: string | null, plan: string, anchorAt: string): boolean {
    if (!rootId) return false
    const record = this.#byRoot.get(rootId)?.get(plan)
    if (!record || record.anchorAt !== undefined) return false
    record.anchorAt = anchorAt
    return true
  }

  /** A plain serializable snapshot for persistence. */
  toJSON(): StoryOwnershipState {
    const out: StoryOwnershipState = {}
    for (const [rootId, owned] of this.#byRoot) {
      out[rootId] = Object.fromEntries(owned)
    }
    return out
  }
}

/**
 * Whether the story card should render in the current thread: ONLY when that
 * thread owns the story. An unclaimed story (no owner recorded yet — e.g. one
 * narrated before ownership tracking existed) renders in no thread until its
 * authoring thread re-claims it on the next narrate, rather than leaking onto
 * an unrelated thread.
 */
export function shouldRenderStory(owner: string | undefined, threadId: string | null): boolean {
  return owner !== undefined && owner === threadId
}
