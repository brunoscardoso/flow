// Pure decision for the composer's effort <select> enablement (#332).
//
// The model picker's "Auto" value delegates to plan-flow MODEL ROUTING: the
// active routing map ({low,medium,high} → model) picks the model from the
// effort tier. Letting the user also drive effort in Auto mode meant the user
// — not the routing — was choosing the tier, so the routing was never actually
// "forcing" anything (#332). Under Auto, effort belongs to the routing, so the
// control is locked; the user pins a concrete model when they want manual
// control. Kept as a pure function (no DOM) so it's unit-testable under the
// node-env jest that can't import DOM-coupled composer code.

export interface EffortControlState {
  disabled: boolean
  /** title/tooltip explaining the control's current state. */
  title: string
}

/** The "Auto" model value — plan-flow model routing owns effort under it. */
export const AUTO_MODEL = 'auto'

/**
 * Whether the effort selector is user-editable for the given model selection.
 * Disabled when no thread is open, or when the model is Auto (routing-owned).
 */
export function effortControlState(
  model: string,
  hasThread: boolean,
  /** True when Flow's effort→model routing is what "Auto" means here — i.e.
   *  the runtime is Claude. Under Codex or Copilot, Auto means the RUNTIME
   *  picks its own model and effort is a dial Flow passes straight through, so
   *  locking it would take away the only knob those runtimes have. */
  routingOwnsAuto = true,
): EffortControlState {
  if (!hasThread) {
    return { disabled: true, title: 'Open a thread to set effort' }
  }
  if (model === AUTO_MODEL && routingOwnsAuto) {
    return {
      disabled: true,
      title: 'Effort is set by model routing in Auto mode — pin a model to choose it yourself',
    }
  }
  return { disabled: false, title: 'Effort' }
}
