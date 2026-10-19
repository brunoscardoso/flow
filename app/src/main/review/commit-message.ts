// AI commit-message generation for manual Review mode (#67). The ✨ wand asks
// the agent to write a Conventional Commits message for the approved files.
// Main-side (runs next to the git diff + agent call); the prompt/diff shaping is
// pure and unit-tested, only the generate() call is not.

const MAX_DIFF_CHARS = 4000

/** What summarizeDiff emits when a file's staged diff carries no content —
 *  the marker the empty-source guard keys on (#1285). */
export const NO_TEXTUAL_CHANGE = '(no textual change)'

/** A compact diff string from before/after content, for the prompt. */
export function summarizeDiff(before: string, after: string): string {
  if (before === after) return NO_TEXTUAL_CHANGE
  // Include the new file's content, like the modified branch — otherwise a
  // new-files-only changeset (the common commit) gives the AI only a line count
  // and it writes a blind, generic message (#143).
  if (before.length === 0)
    return `(new file, ${after.split('\n').length} lines)\n${after.slice(0, MAX_DIFF_CHARS)}`
  if (after.length === 0) return '(deleted file)'
  const beforeLines = before.split('\n').length
  const afterLines = after.split('\n').length
  return `(modified: ${beforeLines} → ${afterLines} lines)\n${after.slice(0, MAX_DIFF_CHARS)}`
}

/** Build the prompt sent to generate the commit message. Deterministic. */
export function buildCommitMessagePrompt(
  files: ReadonlyArray<{ path: string; diff: string }>,
): string {
  const body = files
    .map((file) => `### ${file.path}\n${file.diff.slice(0, MAX_DIFF_CHARS)}`)
    .join('\n\n')
  return (
    'Write a single, concise Conventional Commits subject line (e.g. ' +
    '"feat(scope): summary") for the following staged changes. ' +
    'Keep it short and imperative — ONE line, no body, and NO emoji or icons. ' +
    'Reply with ONLY the commit message — no preamble, no code fences.\n\n' +
    body
  )
}

export interface CommitMessageDeps {
  /** STAGED (index-vs-HEAD) before/after content for one file — the message must
   *  describe exactly what the commit will contain, not the working tree (#694). */
  getDiff: (rootPath: string, filePath: string) => Promise<{ beforeContent: string; afterContent: string }>
  /** One-shot AI text generation (e.g. AgentManager.generateBrief). */
  generate: (projectRoot: string, prompt: string) => Promise<string | null>
}

/**
 * Generate a commit message for `filePaths` under `rootPath`. Returns null when
 * no files are given or the AI produced nothing. Best-effort per file — a diff
 * that can't be read still contributes its path.
 */
export async function generateCommitMessage(
  deps: CommitMessageDeps,
  rootPath: string,
  filePaths: readonly string[],
): Promise<string | null> {
  if (filePaths.length === 0) return null
  const files: Array<{ path: string; diff: string }> = []
  for (const filePath of filePaths) {
    const diff = await deps.getDiff(rootPath, filePath).catch(() => null)
    files.push({
      path: filePath,
      diff: diff ? summarizeDiff(diff.beforeContent, diff.afterContent) : '(diff unavailable)',
    })
  }
  // #1285: never describe an empty diff. With nothing staged, every file
  // summarizes to `(no textual change)` and the model writes a message from
  // the file NAMES alone — observed live as "chore(logger): touch file with no
  // functional changes" over a full rewrite, which then commits verbatim.
  // A guess about content nobody showed the model is worse than no suggestion.
  if (files.every((file) => file.diff === NO_TEXTUAL_CHANGE)) return null
  const message = await deps.generate(rootPath, buildCommitMessagePrompt(files))
  return message?.trim() || null
}
