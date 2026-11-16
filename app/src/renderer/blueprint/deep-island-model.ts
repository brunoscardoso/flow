// THE DEEP LEVELS' TWO ISLANDS (user, 2026-11-15: "the same rule at every
// depth"). A feature's diagram wears the same glass bars as the map: the top
// one for where you are, how you look at it and what you can ask; the bottom
// one for what is known about it — the brief's tabs, the known issue as one
// line, and Knowledge with this feature's figures.
//
// Pressing a tab grows the bottom island upward into a sheet holding that
// tab; pressing the open tab again (or Escape) folds it.
//
// DOM-free so it runs under the CJS node jest.

import { understoodPercent } from '../../shared/understood'

/** Which tab's sheet is open after a press: the pressed one, or none when it was already open. */
export function toggleSheet(open: string | null, pressed: string): string | null {
  return open === pressed ? null : pressed
}

/** The field's placeholder on a deep level: the question is about this thing. */
export function askAboutPlaceholder(name: string): string {
  return `Ask about ${name}…`
}

export interface DeepKnowledgeInput {
  /** This level's understood share, as the dial and the map's cell count it. */
  understood: { done: number; total: number } | null
  /** Files this feature stands on, when known. */
  files: number | null
  /** Parts inside it, when it has any. */
  parts: number | null
}

export interface DeepKnowledgeView {
  ring: number
  line1: string
  line2: string | null
  title: string
}

const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 's'}`

/** "89% understood" and "62 files · 9 parts" — one line in the island. */
export function deepKnowledgeView(input: DeepKnowledgeInput): DeepKnowledgeView {
  const percent = understoodPercent(input.understood)
  const ring = input.understood === null || input.understood.total === 0 ? 0 : Math.min(1, input.understood.done / input.understood.total)
  const facts = [
    input.files !== null && input.files > 0 ? plural(input.files, 'file') : null,
    input.parts !== null && input.parts > 0 ? plural(input.parts, 'part') : null,
  ].filter((part): part is string => part !== null)
  const line1 = percent === null ? 'Nothing learned yet' : `${String(percent)}% understood`
  const counted = input.understood === null ? null : `${String(input.understood.done)} of ${String(input.understood.total)} understood`
  return {
    ring,
    line1,
    line2: facts.length === 0 ? null : facts.join(' · '),
    title: [counted, 'Open the Learning panel'].filter((part): part is string => part !== null).join('\n'),
  }
}

/** Files among a brief's anchors (`file:` refs), or null when it names none. */
export function filesAmong(anchors: ReadonlyArray<{ ref: string }>): number | null {
  const files = anchors.filter((anchor) => anchor.ref.startsWith('file:')).length
  return files > 0 ? files : null
}
