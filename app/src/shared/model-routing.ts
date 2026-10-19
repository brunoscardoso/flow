// Auto-mode model routing (#129). When a thread's model is 'auto', the concrete
// model is chosen from the thread's effort via a user-editable map (suggested
// defaults below). Pure + shared so the agent (resolve) and the settings UI
// (edit) agree, and so it unit-tests without a renderer.

import type { EffortLevel } from './ipc-contract'

/**
 * Models the effort→model map can select (the composer's picker aliases).
 *
 * ONE LIST, not a type plus a guard plus a dropdown. `isRoutableModel` and the
 * settings dropdown both read `ROUTABLE_MODELS`, so a model added here appears
 * everywhere it is offered — the previous arrangement spelled the same three
 * names in three files, and a fourth model added to one of them would have been
 * offered by a control that then refused to save it.
 */
export const ROUTABLE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const

export type RoutableModel = (typeof ROUTABLE_MODELS)[number]

/** Effort → model for Auto mode. */
export type ModelRouting = Record<EffortLevel, RoutableModel>

/**
 * Suggested defaults — higher effort routes to a more capable model.
 *
 * UNCHANGED BY THE ADDITION OF A MODEL. Offering `fable` in the picker is new
 * capability; changing what Auto already picks would silently move every
 * existing thread onto a different model, which is a decision for the person
 * whose threads they are, not a side effect of widening a list.
 */
export const DEFAULT_MODEL_ROUTING: ModelRouting = {
  low: 'haiku',
  medium: 'sonnet',
  high: 'opus',
}

export function isRoutableModel(value: unknown): value is RoutableModel {
  return (ROUTABLE_MODELS as readonly unknown[]).includes(value)
}

/**
 * The Auto model for a given effort. Any missing/invalid entry falls back to the
 * suggested default for that effort, so routing always yields a valid model.
 */
export function resolveAutoModel(
  effort: EffortLevel,
  routing: Partial<ModelRouting> | null | undefined,
): RoutableModel {
  const chosen = routing?.[effort]
  return isRoutableModel(chosen) ? chosen : DEFAULT_MODEL_ROUTING[effort]
}

/**
 * Parse a stored JSON string into a fully-validated ModelRouting — every effort
 * level present and a valid model, falling back to defaults for bad/missing
 * fields or unparseable input.
 */
export function parseModelRouting(json: string | null | undefined): ModelRouting {
  let raw: Partial<Record<EffortLevel, unknown>> = {}
  if (json) {
    try {
      raw = JSON.parse(json) as Partial<Record<EffortLevel, unknown>>
    } catch {
      raw = {}
    }
  }
  return {
    low: isRoutableModel(raw.low) ? raw.low : DEFAULT_MODEL_ROUTING.low,
    medium: isRoutableModel(raw.medium) ? raw.medium : DEFAULT_MODEL_ROUTING.medium,
    high: isRoutableModel(raw.high) ? raw.high : DEFAULT_MODEL_ROUTING.high,
  }
}
