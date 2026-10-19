// Structured prompt builder for AI conflict resolution (#66, #295; Phase 4).
// Pure and deterministic — lists each conflicted file (with its conflict blocks
// and any reachable intent context) and instructs the agent to reply with a
// fenced ```conflict-proposals JSON array (one element per block) matching the
// ConflictProposal shape. The agent still reads the live markers from the
// working tree, so no side content is inlined — only block identifiers.
//
// #295: conflicts are gathered across EVERY project root, so a file is only
// uniquely addressable as (rootPath, filePath). The builder de-dupes on
// (root, file) and, in a multi-project window, groups the list by root
// (basename + absolute path). A single-project window renders a bare list.
//
// #337: root qualification keys on whether the WINDOW holds several projects
// (`multiRoot`), NOT on how many roots currently have conflicts — the
// resolution session may be rooted in a different project than the conflict.

import { CONFLICT_PROPOSALS_FENCE } from './conflict-proposal'

/** One conflict block within a file, as surfaced to the agent for reference. */
export interface ConflictBlockInfo {
  /** Stable identifier the agent echoes back in its proposal (block index). */
  blockId: number
  /** 1-based line of the opening `<<<<<<<` marker. */
  startLine: number
  /** 1-based line of the closing `>>>>>>>` marker. */
  endLine: number
}

export interface ConflictFile {
  /** Absolute project root path the conflicted file lives under. */
  rootPath: string
  /** Root-relative path (with '/' separators). */
  filePath: string
  /** Conflict blocks in the file, when known (omitted → the agent inspects). */
  blocks?: readonly ConflictBlockInfo[]
  /** Best-effort intent context (which plan/feature each side came from). */
  context?: string | null
}

/** Last path segment of an absolute root path, for a readable group header. */
function rootLabel(rootPath: string): string {
  const trimmed = rootPath.replace(/[/\\]+$/, '')
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/** The instruction block — deterministic, so identical inputs yield identical
 *  prompts. Explains the expected fenced JSON reply and the choice semantics. */
const INSTRUCTIONS = [
  'Read the live conflict markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`) in each file above.',
  'For EACH conflict block, prefer keeping or COMBINING the existing sides over writing new code.',
  'Only when neither side (nor a combination) is correct should you write new code — mark that as `synthesized`.',
  '',
  'Reply with a single fenced code block tagged `' +
    CONFLICT_PROPOSALS_FENCE +
    '` containing a JSON array. One element per conflict block:',
  '```' + CONFLICT_PROPOSALS_FENCE,
  '[',
  '  {',
  '    "file": "<root-relative path exactly as listed>",',
  '    "blockId": <the block id listed above>,',
  '    "choice": "ours" | "theirs" | "both" | "synthesized",',
  '    "resolvedContent": "<FULL resolved file text — required for both/synthesized>",',
  '    "risk": "safe" | "risky",',
  '    "confidence": 0.0,',
  '    "why": "<why this conflict happened / what each side intended>",',
  '    "how": "<how this resolution reconciles them>"',
  '  }',
  ']',
  '```',
  'Use `safe` only for mechanical, no-behavior-change resolutions; anything touching logic is `risky`.',
  'Mark any newly-written code as `choice: "synthesized"` — it will always be held for human review.',
  '',
  // #1135: the reply IS the deliverable. The engineer reviews each proposal and
  // applies it from the review card; an agent that finishes the merge itself
  // takes that decision away (the permission broker also blocks it in code).
  'PROPOSE ONLY — do not act on the conflicts yourself. Do NOT edit or write the conflicted files, do NOT `git add`/stage anything, do NOT commit, and do NOT run `git merge --continue`/`--abort` (or the rebase/cherry-pick equivalents).',
  'The user reviews each proposal and applies it themselves. Finish your turn with the fenced block and nothing else.',
].join('\n')

/** Render one file's block list (and context) as prompt lines. */
function renderFile(file: ConflictFile): string {
  const lines: string[] = [`- ${file.filePath}`]
  if (file.context) {
    lines.push(`    context: ${file.context}`)
  }
  for (const block of file.blocks ?? []) {
    lines.push(`    block ${block.blockId}: lines ${block.startLine}–${block.endLine}`)
  }
  return lines.join('\n')
}

/**
 * Build the structured resolution prompt for the given conflicted files.
 * Returns null when there are none. Deterministic. De-dupes on (root, file).
 *
 * @param options.multiRoot Whether the window has 2+ project roots. When true every
 *   file is qualified with its root (basename + absolute path) even if only one
 *   root currently has conflicts (#337).
 */
export function buildConflictResolutionPrompt(
  files: readonly ConflictFile[],
  options: { multiRoot: boolean } = { multiRoot: false },
): string | null {
  const seen = new Set<string>()
  const unique: ConflictFile[] = []
  for (const file of files) {
    const filePath = file.filePath.trim()
    if (filePath.length === 0) continue
    const key = `${file.rootPath} ${filePath}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push({ ...file, filePath })
  }
  if (unique.length === 0) return null

  const roots = [...new Set(unique.map((f) => f.rootPath))]
  let list: string
  if (!options.multiRoot) {
    // Single-project window — no ambiguity, keep the plain list.
    list = unique.map(renderFile).join('\n')
  } else {
    // Multi-project window — group by root so every file is uniquely addressable.
    list = roots
      .map((rootPath) => {
        const header = `In ${rootLabel(rootPath)} (${rootPath}):`
        const rows = unique
          .filter((f) => f.rootPath === rootPath)
          .map(renderFile)
          .join('\n')
        return `${header}\n${rows}`
      })
      .join('\n')
  }

  return `Resolve the merge conflicts in these files:\n${list}\n\n${INSTRUCTIONS}`
}
