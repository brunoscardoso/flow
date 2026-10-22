/**
 * Composer reference chips — pure state + serialization logic for the
 * Board→Chat bridge (Blueprint attach affordance → composer chips).
 *
 * A chip is a lightweight reference to a blueprint node (or ghost/proposal)
 * the user attached from the Blueprint board via the
 * `flow:blueprint-selected` document event. Chips are RENDERER-ONLY sugar:
 * on send they serialize into the message CONTENT as a compact single-line
 * prefix — the sendMessage IPC shape ({ threadId, content }) is untouched.
 *
 * Serialization contract (Phase 6 documents it for skills/agents to parse):
 *   [blueprint: <nodeId> — <label>]            one line per node chip
 *   [blueprint proposal: <nodeId> — <label>]   one line per ghost chip
 *   [browser: <captureKind> — <label>]         one line per browser capture chip
 * Lines appear in chip insertion order, prepended above the user's text
 * with a blank line separating prefix and text. No chips → text unchanged.
 *
 * Everything here is pure (no DOM) so it stays unit-testable under the
 * node test environment — the Composer class owns the DOM rendering.
 */

/** One attached blueprint reference (detail of `flow:blueprint-selected`). */
export interface BlueprintChipRef {
  /** Graph node id — or the proposal's predictedNodeId for ghosts. */
  nodeId: string
  label: string
  kind: string
  /** True when the chip references a ghost card (an undecided proposal). */
  proposal?: boolean
  /** Story step reference (Phase 7 composer chips). */
  story?: {
    plan: string
    stepId: string
    title: string
  }
  /**
   * Embedded-browser capture reference (Phase 6). Present → the chip serializes
   * as `[browser: <captureKind> — <label>]` instead of a `[blueprint: …]` line.
   * `nodeId` carries the stable capture identity (component path / capture id),
   * used for dedup + the pill tooltip; the serialized line uses `captureKind`
   * and the human `label` (the component path, for an element).
   */
  browser?: {
    /** The capture kind — 'element' | 'console' | 'network'. */
    captureKind: string
  }
}

/**
 * Add a chip, deduplicating by nodeId — attaching the same node twice is a
 * no-op that returns the ORIGINAL array (stable reference = nothing to
 * re-render). Otherwise returns a new array with the chip appended, so
 * insertion order is preserved for serialization.
 */
export function addChip(
  chips: readonly BlueprintChipRef[],
  chip: BlueprintChipRef,
): readonly BlueprintChipRef[] {
  if (chips.some((existing) => existing.nodeId === chip.nodeId)) {
    return chips
  }
  return [...chips, chip]
}

/** Remove the chip with the given nodeId (missing id = original array). */
export function dismissChip(
  chips: readonly BlueprintChipRef[],
  nodeId: string,
): readonly BlueprintChipRef[] {
  if (!chips.some((existing) => existing.nodeId === nodeId)) {
    return chips
  }
  return chips.filter((existing) => existing.nodeId !== nodeId)
}

/** All chips gone (post-send reset). */
export function clearChips(): readonly BlueprintChipRef[] {
  return []
}

/**
 * Sanitize a label/id so it can't break the single-line serialization contract.
 * Two hazards, both neutralized here:
 *   - whitespace (a newline would split the one-line-per-chip contract), and
 *   - the em-dash `—`, which is the id/label DELIMITER (` — `). A label like
 *     "Auth — Manager" otherwise makes the greedy `(.+) — (.+)` parser mis-split
 *     the id from the label (it captures "<id> — Auth" as the id). Downgrading the
 *     em-dash to a hyphen leaves exactly ONE ` — ` on the line — the real
 *     delimiter — so the round-trip is unambiguous.
 */
function sanitizeLabel(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/—/g, '-').trim()
}

/** The exact serialized line for one chip — the parseable contract. */
export function chipLine(chip: BlueprintChipRef): string {
  if (chip.browser !== undefined) {
    // Browser capture chip: [browser: <captureKind> — <label>]. The label
    // carries the stable identity for an element (its component path); id/label
    // are sanitized like every other form so a value can't break the line.
    const captureKind = sanitizeLabel(chip.browser.captureKind)
    const label = sanitizeLabel(chip.label)
    return `[browser: ${captureKind} — ${label}]`
  }
  if (chip.story !== undefined) {
    // Story chip: [blueprint story: <plan>/<stepId> — <title>]
    const sanitizedPlan = sanitizeLabel(chip.story.plan)
    const sanitizedStepId = sanitizeLabel(chip.story.stepId)
    const sanitizedTitle = sanitizeLabel(chip.story.title)
    return `[blueprint story: ${sanitizedPlan}/${sanitizedStepId} — ${sanitizedTitle}]`
  }
  // Sanitize the free-text label (and, defensively, the id) so a newline in a node
  // label can't split the line and break the one-line-per-chip contract agents
  // parse — the story path already does this; the node/proposal path must too.
  const id = sanitizeLabel(chip.nodeId)
  const label = sanitizeLabel(chip.label)
  return chip.proposal === true
    ? `[blueprint proposal: ${id} — ${label}]`
    : `[blueprint: ${id} — ${label}]`
}

/**
 * Fold the chips into the outgoing message content: one `[blueprint: …]`
 * line per chip (insertion order), a blank line, then the user's text.
 *
 *   - no chips → userText unchanged (exact same string)
 *   - empty userText → just the chip lines (no dangling separator)
 */
export function serializeChips(
  chips: readonly BlueprintChipRef[],
  userText: string,
): string {
  if (chips.length === 0) {
    return userText
  }
  const head = chips.map(chipLine).join('\n')
  return userText.length === 0 ? head : `${head}\n\n${userText}`
}

// ── Subtask target chip (plan_mid-run-subtasks FR-13) ──────────────────────

/**
 * The subtask a message is steered to. Set by the panel's Steer
 * (`flow:steer-subtask`); while set, the next send goes to that subtask, and
 * removing it sends to the main agent again.
 */
export interface SubtaskTargetRef {
  threadId: string
  ticket: string
  title: string
}

/** The line under the chip — what the tag does, in the person's terms. */
export const SUBTASK_TARGET_HINT = 'Goes to this subtask only. Remove the tag to talk to the main agent.'

/**
 * A Steer event's detail as a target for THIS thread, or null. A press from
 * another thread's panel never steers this composer.
 */
export function subtaskTargetFrom(detail: unknown, threadId: string | null): SubtaskTargetRef | null {
  if (threadId === null || typeof detail !== 'object' || detail === null) return null
  const record = detail as Record<string, unknown>
  if (record.threadId !== threadId) return null
  const ticket = typeof record.ticket === 'string' ? record.ticket.trim() : ''
  const title = typeof record.title === 'string' ? sanitizeLabel(record.title) : ''
  if (ticket === '') return null
  return { threadId, ticket, title: title === '' ? ticket : title }
}

/**
 * The message as the agent receives it: `To subtask <ticket> (“<title>”): …`.
 * The agent forwards it to that sub-agent (its tool description says so). No
 * target → the content unchanged.
 */
export function serializeSubtaskTarget(target: SubtaskTargetRef | null, content: string): string {
  if (target === null) return content
  return `To subtask ${target.ticket} (“${target.title}”): ${content}`
}
