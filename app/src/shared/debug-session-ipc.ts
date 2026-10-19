/**
 * What the renderer is told about a debug session.
 *
 * SMALL ON PURPOSE. A live session holds megabytes; the status bar needs to
 * draw a dot and a count, and the thread needs a sentence. Nothing here carries
 * a record (allowed-pattern #18) — the artifact on disk does that.
 */

/** A live session, as a control can draw it. */
export interface DebugSessionSummary {
  id: string
  threadId: string | null
  startedAt: number
  /** What it is listening to, by the names a person uses. */
  terminals: string[]
  /** How much it has taken so far — a number that should be seen moving. */
  records: number
}

/**
 * What came back from Finish.
 *
 * THE RENDERER DECIDES WHAT TO DO WITH IT. Main writes the file and renders the
 * summary; attaching it as context and opening it in the editor are renderer
 * events (`flow:add-to-chat`, `flow:open-file-path`) that main cannot dispatch.
 */
export interface DebugStopResult {
  /** Where the full record was written, or null when it could not be. */
  artifactDir: string | null
  /** The timeline, relative to the project — what to open and what to name. */
  timelinePath: string | null
  /** The project those paths are relative to. */
  projectRoot: string | null
  /** The bounded summary — the chip's payload, not a document. */
  summary: string
  /** How many records the window held. */
  records: number
  /** Whether a person finished it or it stopped itself. */
  end: 'finished' | 'capped' | 'abandoned'
}
