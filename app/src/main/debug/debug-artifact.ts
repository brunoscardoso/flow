/**
 * WRITING THE SESSION DOWN.
 *
 * A debug session ends with two things: a bounded summary a person reads in
 * the thread, and this — everything, on disk, for the moment the summary is not
 * enough (allowed-pattern #18).
 *
 * WHERE IT GOES, AND WHY IT MOVED. This first wrote to userData, reasoning that
 * dropping untracked megabytes into somebody's working tree is not a side
 * effect of pressing a button. That was true and it made the artifact useless:
 * `flow:open-file-path` resolves against the project and a thread's checkouts,
 * so a file in Application Support cannot be opened in the editor at all, and
 * nobody browses there. A 2.8 MB record nobody can reach is not a record
 * (user, 2026-09-21: "still not md file generated").
 *
 * It lives under the project's own `flow/.debug-sessions/`, beside the
 * `flow/.evidence/` precedent — openable, and referenceable by a relative path
 * an agent can use. The working-tree objection is answered where it belongs: the
 * directory carries a `.gitignore` that ignores itself, so nothing appears in
 * `git status` and no repo needs editing to make that true.
 *
 * NOTHING HERE BLOCKS MAIN (NFR-4, allowed-pattern #19). Every call is the
 * promise API; a session's records can be megabytes and main answers every IPC
 * call in the app.
 *
 * FAILING TO WRITE IS NOT FAILING THE SESSION. The summary is the part a person
 * reads, and it reaches the thread whether or not this worked — so every path
 * here returns null rather than throwing, and the summary says so.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { BrowserNetworkPayload } from '../../shared/browser-capture-types'
import type { DebugSessionResult } from '../../shared/debug-session-types'
import { narrativeText, summaryText, timelineText } from '../../shared/debug-timeline'
import { writeHar } from '../../shared/har-write'
import { MAX_BODY_CHARS } from '../../shared/browser-capture-boundary'

/** Where the session's files are, and how to name them to a reader. */
export interface DebugArtifact {
  /** The directory holding this session's files. */
  dir: string
  /** The SHORT version a person reads — what to open, relative to the project. */
  summaryRelPath: string
  /** The full correlated record, absolute. */
  timelinePath: string
  /** The same, relative to the project — the source of truth the summary cites. */
  timelineRelPath: string
  /** The project the paths above are relative to. */
  projectRoot: string
  /** The HAR, when the session saw any network at all. */
  harPath: string | null
  /** The bounded summary, already rendered. */
  summary: string
}

/**
 * The folder a session's files go in, under the project.
 *
 * NOT A DOT-DIRECTORY. `flow/.debug-sessions` was the obvious name — it matches
 * `flow/.evidence` — and it made the file unreachable: dot-directories are
 * skipped by the file-ref resolution the editor opens through, and hidden from
 * the explorer. A record you cannot see or open is the thing this whole move
 * was fixing. It is visible, and the `.gitignore` written inside it keeps it
 * out of `git status` all the same.
 */
export const DEBUG_ARTIFACT_DIR = join('flow', 'debug-sessions')

/** The network payloads a session retained, for the HAR. */
function networkPayloads(result: DebugSessionResult): BrowserNetworkPayload[] {
  const out: BrowserNetworkPayload[] = []
  for (const record of result.records) {
    if (record.source !== 'browser') continue
    if (record.capture.kind !== 'network') continue
    out.push(record.capture.payload as BrowserNetworkPayload)
  }
  return out
}

/**
 * Write one session's files under `root`.
 *
 * Returns null when nothing could be written — the caller still has a summary
 * to post, and `summaryText(result, null)` says the record is all there is.
 */
export async function writeDebugArtifact(
  result: DebugSessionResult,
  root: string,
): Promise<DebugArtifact | null> {
  const base = join(root, DEBUG_ARTIFACT_DIR)
  const dir = join(base, result.id)
  try {
    await mkdir(dir, { recursive: true })
    // A SELF-IGNORING DIRECTORY. The alternative is editing the project's own
    // .gitignore, which is the user's file and not ours to rewrite because they
    // pressed a button.
    await writeFile(
      join(base, '.gitignore'),
      '# Debug session records — local evidence, never committed.\n*\n',
      'utf8',
    )
    const timelinePath = join(dir, 'timeline.md')

    const network = networkPayloads(result)
    let harPath: string | null = null
    if (network.length > 0) {
      harPath = join(dir, 'network.har')
      await writeFile(
        harPath,
        writeHar(network, {
          startedAt: result.startedAt,
          endedAt: result.endedAt,
          evicted: result.browserEvicted,
          bodyCapBytes: MAX_BODY_CHARS,
        }),
        'utf8',
      )
    }

    // The timeline names the HAR beside it, so a reader who opens one finds the
    // other — the two halves of one recording, and neither says everything.
    const header =
      harPath === null
        ? ''
        : `A HAR of this window's network is beside this file, in network.har.\nIt records what the capture RETAINED — read its creator comment first.\n\n`
    await writeFile(timelinePath, header + timelineText(result), 'utf8')

    // TWO FILES, AND THE SHORT ONE IS THE ONE THAT OPENS.
    //
    // The timeline holds everything and is 4,500 lines of it — the source of
    // truth, and the wrong thing to hand somebody who wants to know what broke
    // (user, 2026-09-21). The summary tells the story of the reproduction and
    // cites the timeline for the rest. Neither replaces the other.
    const summaryPath = join(dir, 'summary.md')
    // The timeline link is PROJECT-relative, which is what the markdown surface
    // resolves against — a sibling path rendered fine and opened nothing.
    await writeFile(
      summaryPath,
      narrativeText(result, { timeline: relative(root, timelinePath) }),
      'utf8',
    )

    const timelineRelPath = relative(root, timelinePath)
    const summaryRelPath = relative(root, summaryPath)
    return {
      dir,
      summaryRelPath,
      timelinePath,
      timelineRelPath,
      projectRoot: root,
      harPath,
      // The chip cites the SHORT file: it is what a reader opens, and it names
      // the timeline itself for anything the short version leaves out.
      summary: summaryText(result, summaryRelPath),
    }
  } catch {
    // Deliberately quiet about the cause: the summary is what the person reads,
    // and it will say the record could not be written.
    return null
  }
}
