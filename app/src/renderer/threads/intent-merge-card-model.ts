/**
 * "Flow merged two edits" — every word the See both view and the Undo button
 * show, and the panes they draw. Pure (no DOM), so the copy is testable: no
 * path, command or setting name ever reaches it (forbidden-pattern #12).
 *
 * The two event names mirror main's pause-notice.ts (a test pins them).
 */
import type {
  IntentMergeKeep,
  WorkspaceIntentMergeDocument,
  WorkspaceIntentMergeSet,
} from '../../shared/workspaces-contract'

/** The notification's "Undo" — mirrors WORKSPACE_INTENT_UNDO_EVENT in main. */
export const WORKSPACE_INTENT_UNDO_EVENT = 'flow:workspace-intent-undo'
/** The notification's "See both" — mirrors WORKSPACE_INTENT_SEE_BOTH_EVENT in main. */
export const WORKSPACE_INTENT_SEE_BOTH_EVENT = 'flow:workspace-intent-see-both'

export const UNNAMED_TEAMMATE = 'a teammate'
export const CLOSE_LABEL = 'Close'
export const SAVING_LABEL = 'Saving…'
export const SET_GONE = 'Flow no longer has this merge on this computer.'
export const KEEP_FAILED = "Flow couldn't change this document just now. Try again in a moment."
export const UNDO_FAILED_TITLE = "Flow couldn't undo the merge"
export const UNDONE_TITLE = 'Merge undone'

/** The heading of the view. */
export function intentCardTitle(set: WorkspaceIntentMergeSet): string {
  const [only] = set.documents
  return set.documents.length === 1 && only !== undefined
    ? `Two edits to "${only.title}"`
    : `Two edits to ${set.documents.length} documents`
}

/** "Bea's" — or "Your teammate's" when git did not name them. */
function possessive(name: string | null): string {
  return name === null ? "Your teammate's" : `${name}'s`
}

export interface IntentPaneView {
  keep: IntentMergeKeep
  heading: string
  text: string
  inUse: boolean
}

export interface IntentChoiceView {
  keep: IntentMergeKeep
  label: string
  primary: boolean
  /** Already the text in use: nothing to do. */
  disabled: boolean
}

export interface IntentDocumentView {
  id: string
  title: string
  intro: string
  panes: IntentPaneView[]
  choices: IntentChoiceView[]
}

/** The three panes and three choices of one document, in the approved order. */
export function intentDocumentView(document: WorkspaceIntentMergeDocument): IntentDocumentView {
  const who = document.theirName ?? UNNAMED_TEAMMATE
  const theirs = possessive(document.theirName)
  const label = (heading: string, keep: IntentMergeKeep): string => (document.current === keep ? `${heading} (in use)` : heading)
  return {
    id: document.id,
    title: document.title,
    intro: `You and ${who} both changed this ${document.kind}. Flow combined them into one version and kept both originals.`,
    panes: [
      { keep: 'ours', heading: label('Yours', 'ours'), text: document.ours, inUse: document.current === 'ours' },
      { keep: 'theirs', heading: label(theirs, 'theirs'), text: document.theirs, inUse: document.current === 'theirs' },
      { keep: 'merged', heading: label('Merged', 'merged'), text: document.merged, inUse: document.current === 'merged' },
    ],
    choices: [
      { keep: 'ours', label: 'Keep yours', primary: false, disabled: document.current === 'ours' },
      {
        keep: 'theirs',
        label: `Keep ${document.theirName === null ? "your teammate's" : theirs}`,
        primary: false,
        disabled: document.current === 'theirs',
      },
      { keep: 'merged', label: 'Keep merged', primary: true, disabled: document.current === 'merged' },
    ],
  }
}

/** The `{ slug, mergeId }` an Undo / See both event carries, or null when it carries something else. */
export function intentEventDetail(detail: unknown): { slug: string; mergeId: string } | null {
  if (typeof detail !== 'object' || detail === null) return null
  const slug = (detail as Record<string, unknown>)['slug']
  const mergeId = (detail as Record<string, unknown>)['mergeId']
  return typeof slug === 'string' && slug !== '' && typeof mergeId === 'string' && mergeId !== '' ? { slug, mergeId } : null
}
