/**
 * WHERE ON THE BOARD A CONVERSATION WAS — the pure half of the blueprint's
 * place in a tab set.
 *
 * There is one board per window, but each conversation has its own tab set, and
 * the board is one view in it. What differs between two conversations' boards
 * is where the reader stood: the depth they had drilled to on the Territory,
 * and the feature brief open on it, and how deep into it.
 *
 * A tab set stores a view's state as a flat record of primitives
 * (`OpenViewRef['state']`), so the structured parts ride as JSON strings.
 * Retired views leave keys behind that are ignored: a row that still carries
 * the old code map's `codeMap` flag, or a document (`doc`, `path`) from the
 * board's discovery view (retired 2026-10-08), lands on its drill with nothing
 * open. DOM-free; `blueprint-board.ts` reads and applies it.
 */
import type { OpenViewRef } from '../../shared/ipc-contract'
import type { FocusNode, FocusNodeKind } from './focus-stack'

export interface BoardNavState {
  /** A feature brief open on the board, or null. */
  feature: string | null
  /** How deep into that brief's curated view, level ids from its root. */
  trail: string[]
  /** The Territory drill — the levels walked into, root first. */
  stack: FocusNode[]
}

/** The plain root board: what a conversation that never opened it gets. */
export const ROOT_BOARD_NAV: BoardNavState = {
  feature: null,
  trail: [],
  stack: [],
}

export function encodeBoardNav(nav: BoardNavState): OpenViewRef['state'] {
  return {
    feature: nav.feature,
    trail: nav.trail.length > 0 ? JSON.stringify(nav.trail) : null,
    stack: nav.stack.length > 0 ? JSON.stringify(nav.stack) : null,
  }
}

/** Read a saved state back. Anything unreadable falls back to the root. */
export function decodeBoardNav(state: OpenViewRef['state']): BoardNavState {
  // A row saved while a document was open (the retired discovery view) keeps
  // its drill and nothing else: the document had the stage, not a brief.
  const doc = nonEmpty(state['doc'])
  return {
    feature: doc === null ? nonEmpty(state['feature']) : null,
    trail: doc === null ? parseJson(state['trail'], isStringArray) ?? [] : [],
    stack: parseJson(state['stack'], isFocusStack) ?? [],
  }
}

/** Whether two places on the board are the same place. */
export function sameBoardNav(a: BoardNavState, b: BoardNavState): boolean {
  return (
    a.feature === b.feature &&
    a.trail.join('\u0000') === b.trail.join('\u0000') &&
    a.stack.map((node) => node.id).join('\u0000') === b.stack.map((node) => node.id).join('\u0000')
  )
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parseJson<T>(value: unknown, guard: (parsed: unknown) => parsed is T): T | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return guard(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

const FOCUS_KINDS: ReadonlySet<FocusNodeKind> = new Set<FocusNodeKind>(['domain', 'feature', 'part', 'change'])

function isFocusStack(value: unknown): value is FocusNode[] {
  return Array.isArray(value) && value.every(isFocusNode)
}

function isFocusNode(value: unknown): value is FocusNode {
  if (value === null || typeof value !== 'object') return false
  const node = value as Record<string, unknown>
  return (
    typeof node['kind'] === 'string' &&
    FOCUS_KINDS.has(node['kind'] as FocusNodeKind) &&
    typeof node['id'] === 'string' &&
    typeof node['name'] === 'string' &&
    typeof node['kicker'] === 'string' &&
    typeof node['drillable'] === 'boolean' &&
    typeof node['canDrill'] === 'boolean' &&
    typeof node['childCount'] === 'number'
  )
}
