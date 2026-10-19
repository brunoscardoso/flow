// Slash-command expansion for runtimes that do not read `.claude/commands`.
//
// Claude Code turns `/discovery-plan <args>` into the contents of
// `.claude/commands/discovery-plan.md` before the model sees anything. The
// external runtimes do not: Copilot and Codex received the literal text, and
// Copilot's own skill tool answered "Skill not found: discovery-plan". Measured
// on a real thread: four regenerations of one discovery, each written by
// imitating the previous version on disk — none of them ever saw a rule the
// command or its skill added (the feature walkthrough, the Design Context gate,
// the declared flow). Every plan-flow command on those runtimes was improvised.
//
// So Flow expands the command itself, the way Claude Code does, before the turn
// is handed to the runtime.

import { readFile } from 'fs/promises'
import { join } from 'path'

/** `/name rest…` — the name is the command, the rest its arguments. */
const SLASH_COMMAND_PATTERN = /^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i
/** A command file's YAML frontmatter block, which is metadata, not prompt. */
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/
/** Claude Code's argument placeholder. */
const ARGUMENTS_PLACEHOLDER = '$ARGUMENTS'

export interface SlashCommand {
  name: string
  args: string
}

/** The command a message starts with, or null when it is not a command. */
export function parseSlashCommand(text: string): SlashCommand | null {
  const match = SLASH_COMMAND_PATTERN.exec(text.trim())
  if (match === null) return null
  return { name: match[1], args: (match[2] ?? '').trim() }
}

/**
 * A command file's body with its arguments applied, as Claude Code does it:
 * `$ARGUMENTS` is replaced where the file names it, and otherwise the arguments
 * follow the body on an `ARGUMENTS:` line.
 */
export function expandCommandBody(file: string, args: string): string {
  const body = file.replace(FRONTMATTER_PATTERN, '').trim()
  if (body.includes(ARGUMENTS_PLACEHOLDER)) return body.split(ARGUMENTS_PLACEHOLDER).join(args)
  return args.length === 0 ? body : `${body}\n\nARGUMENTS: ${args}`
}

/** `plugin:skill` lives at `plugin/skill.md`, the way Claude Code nests them. */
function commandPath(root: string, name: string): string {
  return join(root, '.claude', 'commands', ...name.split(':')) + '.md'
}

/**
 * Expand a leading slash command from the first root that has it. A message
 * that is not a command, or names one no root defines, is returned unchanged —
 * the runtime then sees exactly what the person typed.
 */
export async function expandSlashCommand(
  text: string,
  roots: readonly string[],
  read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<string> {
  const command = parseSlashCommand(text)
  if (command === null) return text
  for (const root of [...new Set(roots)]) {
    try {
      return expandCommandBody(await read(commandPath(root, command.name)), command.args)
    } catch {
      // Not defined in this root; the next one may define it. A command no
      // root defines falls through to the text as typed, below.
    }
  }
  return text
}
