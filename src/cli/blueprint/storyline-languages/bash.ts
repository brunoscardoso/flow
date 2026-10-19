/**
 * CODE STORYLINE — Bash's table (plan `story-any-language` phase 2).
 *
 * Functions (`f() {…}` and `function f {…}`) and the commands that call them.
 * A command the file cannot name is a program (`grep`, `git`), not code: it is
 * dropped rather than kept plain. `source x.sh` / `. x.sh` of a literal path
 * is a star import, searched for the function when the project can be read.
 * Every function is exported; docs are the `#` block above.
 */

import { posix } from 'node:path';
import { docCommentAbove, projectPath, type StorylineLanguage, type StorylineProject } from './contract.js';

const BASH_DEFINITIONS = `
(function_definition name: (word) @name body: (_) @body) @definition.function
`;

const BASH_CALLS = `
(command name: (command_name (word) @callee)) @call
`;

const BASH_SOURCE_COMMANDS = '"source" "."';

const BASH_IMPORTS = `
(command name: (command_name (word) @_source) argument: (word) @import.source (#any-of? @_source ${BASH_SOURCE_COMMANDS})) @import.all
(command name: (command_name (word) @_source) argument: (string (string_content) @import.source) (#any-of? @_source ${BASH_SOURCE_COMMANDS})) @import.all
(command name: (command_name (word) @_source) argument: (raw_string) @import.source (#any-of? @_source ${BASH_SOURCE_COMMANDS})) @import.all
`;

/** Builtins that are statements, not calls into the story. */
const BASH_BUILT_INS: ReadonlySet<string> = new Set(['source', '.', 'local', 'export', 'return', 'set', 'shift']);

/** `source ./lib.sh` → `lib.sh` beside the script (quotes dropped); a path with an expansion names nothing certain. */
export function resolveBashSource(fromFile: string, specifier: string, project: StorylineProject): string | null {
  const path = specifier.replace(/^['"]|['"]$/g, '');
  if (path === '' || path.includes('$') || posix.isAbsolute(path)) return null;
  const candidate = projectPath(posix.dirname(fromFile), path);
  return candidate !== null && project.fileExists(candidate) ? candidate : null;
}

export const BASH: StorylineLanguage = {
  id: 'bash',
  displayName: 'Bash',
  extensions: ['.sh', '.bash'],
  grammar: 'bash',
  queries: { definitions: BASH_DEFINITIONS, calls: BASH_CALLS, imports: BASH_IMPORTS },
  typeIdentifierTypes: [],
  selfReceivers: [],
  isConstructor: () => false,
  classCallConstructs: false,
  builtIns: BASH_BUILT_INS,
  dropUnknownCalls: true,
  resolveImport: resolveBashSource,
  isLocalSpecifier: () => true,
  isExportedName: () => true,
  isPublicMember: () => true,
  docOf: ({ span, lines }) => docCommentAbove(lines, span.startPosition.row, { lineMarkers: ['#'], block: false }),
};
