/**
 * CODE STORYLINE — the table contract every tree-sitter language fills in, and
 * the small helpers tables share (plan `story-any-language`).
 *
 * It lives apart from the extractor (`../storyline-languages.ts`) so the
 * per-language tables (`./<language>.ts`) can import it without importing the
 * extractor that imports them. Read the extractor's header for the query
 * capture contract; this file holds the table's TYPE and its documented hooks.
 */

import { posix } from 'node:path';
import { firstSentence } from '../storyline.js';
import type { TreeSitterNode } from '../storyline-treesitter.js';
import type { StorylinePieceKind } from '../storyline-types.js';

/** What a definition query may call a piece; `method` is derived from nesting or `@owner`. */
export type DefinitionKind = Exclude<StorylinePieceKind, 'method' | 'excerpt'>;

export interface StorylineLanguageQueries {
  definitions: string;
  calls: string;
  imports: string;
  typeUses?: string;
  exports?: string;
  /**
   * What ANOTHER file of this language declares for this one to call — read
   * only when a star import or a package directory is searched for a name.
   * Defaults to `definitions`; a language whose headers hold prototypes (C++)
   * adds them here.
   */
  declarations?: string;
}

/**
 * What the reader may learn about the project beyond the file. Only
 * `fileExists` is required; without the other two, a call whose target can only
 * be found by reading another file (a Go package, a C header, a Ruby
 * `require_relative`) stays plain — never guessed.
 */
export interface StorylineProject {
  /** Whether a project-relative path names a file. */
  fileExists: (relPath: string) => boolean;
  /** A project file's text, or null when it cannot be read. */
  readFile?: (relPath: string) => string | null;
  /** The project-relative paths of the files directly inside `relDir` (`.` is the root). */
  listDirectory?: (relDir: string) => readonly string[];
}

/**
 * A resolved import target that is a DIRECTORY (a Go package), not a file:
 * its path followed by this suffix. A member of it is the file in that
 * directory whose declarations name it.
 */
export const DIRECTORY_TARGET_SUFFIX = '/';

export function directoryTarget(relDir: string): string {
  return `${relDir}${DIRECTORY_TARGET_SUFFIX}`;
}

export function isDirectoryTarget(target: string): boolean {
  return target.endsWith(DIRECTORY_TARGET_SUFFIX);
}

/** What `isPublicDefinition` sees of a definition. */
export interface VisibilitySubject {
  /** The definition's widest span. */
  span: TreeSitterNode;
  name: string;
  /** The type it is a member of; `kind` is null when that type is declared in another file. */
  owner: { name: string; kind: DefinitionKind | null } | null;
}

export interface StorylineLanguage {
  /** The answer's `language` (`python`). */
  id: string;
  /** For sentences and the story header (`Python`). */
  displayName: string;
  /** Lower-case, with the dot. */
  extensions: readonly string[];
  /** The grammar file: `tree-sitter-<grammar>.wasm`. */
  grammar: string;
  queries: StorylineLanguageQueries;
  /** Node types inside a `@type` capture that name a type (the capture itself counts). */
  typeIdentifierTypes: readonly string[];
  /** Receivers meaning "this object" inside a method (`self`, `this`). A definition's `@self` adds its own. */
  selfReceivers: readonly string[];
  /** Whether a member named `member` of type `className` is its constructor (`__init__`, the class's own name). */
  isConstructor: (member: string, className: string) => boolean;
  /** Whether calling a class by name constructs it (`Order(...)`, `new Order()`) — a certain call to the class. */
  classCallConstructs: boolean;
  /** `Order.new` — the member that constructs when called on a class (Ruby). */
  constructsVia?: string;
  /** A bare call inside a method may be a call to its own type's member (`record()` meaning `this.record()`). */
  implicitSelfCalls?: boolean;
  /** Bare calls that are the language's own — neither the story nor unresolved. */
  builtIns: ReadonlySet<string>;
  /** A bare call the file cannot name is a program, not code (Bash): dropped rather than kept plain. */
  dropUnknownCalls?: boolean;
  /**
   * A module specifier written in `fromFile` → the project file it names (or a
   * `directoryTarget`), or null (a package, a path that leaves the project,
   * nothing on disk).
   */
  resolveImport: (fromFile: string, specifier: string, project: StorylineProject) => string | null;
  /** A specifier that can only mean a project file (`.x`) — unresolved when it names none. */
  isLocalSpecifier: (specifier: string) => boolean;
  /** `from <source> import <name>` may name a module: its own specifier, tried first. */
  submoduleSpecifier?: (source: string, name: string) => string;
  /**
   * The name an unaliased module import binds (Go `"a/b/pricing"` → `pricing`,
   * Java `a.b.Pricing` → `Pricing`). Default: the whole specifier (Python).
   */
  moduleBindingName?: (source: string) => string;
  /**
   * A type the file uses without importing, by naming convention (Java's
   * same-package `Pricing` → `Pricing.java` beside it), or null.
   */
  typeFileFor?: (fromFile: string, name: string, fileExists: (relPath: string) => boolean) => string | null;
  /**
   * Targets whose top-level names the file sees without importing them (Go:
   * the other files of its package directory). Searched like a star import.
   */
  implicitImports?: (fromFile: string) => readonly string[];
  /** Exported by naming convention, when the file has no explicit export list and no `isPublicDefinition`. */
  isExportedName: (name: string) => boolean;
  /** A method a caller from outside may use, by name, when there is no `isPublicDefinition`. */
  isPublicMember: (name: string) => boolean;
  /**
   * Visibility read from the definition itself (`pub`, `public`, a Ruby
   * `private` section) — replaces `isExportedName`/`isPublicMember` for the
   * definitions this file declares. An explicit export list still wins.
   */
  isPublicDefinition?: (subject: VisibilitySubject) => boolean;
  /** The first sentence of the definition's documentation, or null. */
  docOf: (definition: DocSubject) => string | null;
}

/** What a table's `docOf` sees of a definition. */
export interface DocSubject {
  /** The widest span (decorators included). */
  span: TreeSitterNode;
  /** The block its statements live in, when the query captured one. */
  body: TreeSitterNode | null;
  /** The file's lines, 0-based. */
  lines: readonly string[];
}

// ── Doc comments ─────────────────────────────────────────

/**
 * The block of `marker` line comments directly above 0-based `row` (no blank
 * line between), joined — the doc rule of every language whose docs are
 * comments, and Python's fallback when a definition has no docstring.
 */
export function lineCommentBlockAbove(lines: readonly string[], row: number, marker: string): string | null {
  const block: string[] = [];
  for (let index = row - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (!line.startsWith(marker)) break;
    block.unshift(line.slice(marker.length).trim());
  }
  return block.length === 0 ? null : firstSentence(block.join(' '));
}

export interface DocCommentRules {
  /** Line-comment markers, longest first (`///` before `//`). */
  lineMarkers: readonly string[];
  /** Whether a `/* … *\/` block ending directly above counts. */
  block: boolean;
  /** Lines between the comment and the definition that do not break it (`#[derive]`, `@Override`). */
  skipLine?: RegExp;
  /** Drop `<tag>` markup (C#'s `<summary>`). */
  stripMarkup?: boolean;
}

const BLOCK_END = '*/';
const BLOCK_START = '/*';
/** A doc-tag line (`@param`, `@return`) ends a block comment's prose. */
const DOC_TAG_LINE = /^@\w/;
const MARKUP_TAG = /<\/?[A-Za-z][^>]*>/g;

/** The C-family doc rule: a `/** … *\/` block or a run of line comments directly above `row`. */
export function docCommentAbove(lines: readonly string[], row: number, rules: DocCommentRules): string | null {
  let index = row - 1;
  while (index >= 0 && rules.skipLine !== undefined && rules.skipLine.test((lines[index] ?? '').trim())) index -= 1;
  if (index < 0) return null;
  const last = (lines[index] ?? '').trim();
  let prose: string | null = null;
  if (rules.block && last.endsWith(BLOCK_END)) {
    prose = blockCommentEndingAt(lines, index);
  } else {
    const block: string[] = [];
    for (let at = index; at >= 0; at -= 1) {
      const line = (lines[at] ?? '').trim();
      const marker = rules.lineMarkers.find((candidate) => line.startsWith(candidate));
      if (marker === undefined) break;
      block.unshift(line.slice(marker.length).trim());
    }
    prose = block.length === 0 ? null : block.join(' ');
  }
  if (prose === null) return null;
  return firstSentence(rules.stripMarkup === true ? prose.replace(MARKUP_TAG, ' ') : prose);
}

function blockCommentEndingAt(lines: readonly string[], endRow: number): string | null {
  const collected: string[] = [];
  for (let at = endRow; at >= 0; at -= 1) {
    const line = (lines[at] ?? '').trim();
    collected.unshift(line);
    if (line.includes(BLOCK_START)) break;
    if (at === 0) return null;
  }
  const first = collected[0] ?? '';
  if (!first.startsWith(BLOCK_START)) return null;
  const prose: string[] = [];
  for (const raw of collected) {
    const line = raw
      .replace(/^\/\*+/, '')
      .replace(/\*+\/$/, '')
      .replace(/^\*+/, '')
      .trim();
    if (DOC_TAG_LINE.test(line)) break;
    prose.push(line);
  }
  const text = prose.join(' ').trim();
  return text === '' ? null : text;
}

// ── Paths ────────────────────────────────────────────────

/** The first existing candidate, or null. */
export function firstExisting(candidates: readonly string[], fileExists: (relPath: string) => boolean): string | null {
  return candidates.find((candidate) => fileExists(candidate)) ?? null;
}

/** `a/b/c.py` → `a/b`, `a`, `.` — the roots a module may hang from, nearest first. */
export function ancestorDirectories(file: string): string[] {
  const directories: string[] = [];
  let current = posix.dirname(file);
  while (current !== '.') {
    directories.push(current);
    current = posix.dirname(current);
  }
  directories.push('.');
  return directories;
}

/** A path joined and normalised, or null when it leaves the project. */
export function projectPath(...segments: string[]): string | null {
  const joined = posix.normalize(posix.join(...segments));
  if (joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined)) return null;
  return joined;
}

/** A query string list: `"a" "b"`. */
export function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(' ');
}

/** The last segment of a separated path (`a::b::c` → `c`). */
export function lastSegment(value: string, separator: string): string {
  const parts = value.split(separator).filter((part) => part !== '');
  return parts[parts.length - 1] ?? value;
}

/** The nearest previous named sibling of `node` whose type is one of `types`, or null. */
export function previousSiblingOfType(node: TreeSitterNode, types: readonly string[]): TreeSitterNode | null {
  let current = node.previousNamedSibling;
  while (current !== null) {
    if (types.includes(current.type)) return current;
    current = current.previousNamedSibling;
  }
  return null;
}

/** Whether a node has a direct child of `type` whose text matches `pattern`. */
export function hasChildMatching(node: TreeSitterNode, type: string, pattern: RegExp): boolean {
  return node.namedChildren.some((child) => child !== null && child.type === type && pattern.test(child.text));
}
