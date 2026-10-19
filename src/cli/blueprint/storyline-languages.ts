/**
 * CODE STORYLINE — every language that is not TypeScript or JavaScript, read
 * through tree-sitter (plan `story-any-language` phases 1–2).
 *
 * One extractor, a TABLE per language (NFR-2). A table is data: the grammar to
 * load, a few tree-sitter queries, an import resolver and a few naming rules
 * (`./storyline-languages/contract.ts` documents every field and hook; the
 * tables live beside it, one file per language). Adding a language is adding a
 * table — `extractWithTreeSitter` has no per-language code path. It produces
 * the very `StorylineAnswer` the TypeScript reader does (`storyline.ts`), so
 * the view, Today ⇄ After, hover/pin and the editor highlight need nothing new.
 *
 * PURE once the grammar is loaded: text in, answer out. The caller starts the
 * engine and loads the grammars it needs (`prepareStorylineLanguages`, the one
 * asynchronous step — WebAssembly), says which project files exist (and,
 * optionally, how to read one or list a directory), and the read itself is
 * synchronous, like the TypeScript one.
 *
 * The trust model is the TypeScript reader's: a call becomes an arrow only
 * when the file's own definitions or an import that resolves to a project file
 * name the target; a call into a package is dropped; anything else is kept as
 * an `unresolvedName` for the reader to see as plain text — never guessed.
 *
 * The query contract — captures every table's queries use:
 *
 *   definitions  `@definition.<kind>` the piece's span (kind: function | class
 *                | interface | type | enum), `@name`, optionally `@body` (the
 *                block its calls are read from) and `@parameters`. Several
 *                matches on one `@name` node are ONE definition: the widest
 *                span wins (a decorator is part of the piece) and a
 *                data-structure kind beats `class`, which beats `function`
 *                (`interface`/`enum` beat a generic `type`).
 *                A `function` directly inside a class-like definition is a
 *                method; one nested deeper is part of its enclosing piece.
 *                `@owner` — a function declared OUTSIDE its type (Go's
 *                receiver, Rust's `impl`, C++'s `A::f`) is a method of the
 *                type it names; that type may live in another file.
 *                `@self` — the name this method's own object goes by (Go's
 *                receiver variable), on top of the table's `selfReceivers`.
 *   calls        `@call` with either `@callee` (a bare name) or `@receiver` +
 *                `@member` (`receiver.member(...)`, `A::m()`, `$this->m()`).
 *   imports      `@import.source` (the module specifier), optionally
 *                `@import.name` (a name imported from it) and `@import.alias`.
 *                `@import.all` marks a star import (`#include`, Ruby's
 *                `require_relative`, Bash's `source`): no binding; a name the
 *                file cannot otherwise place is searched for in its target.
 *   typeUses     `@type` — a type position; every identifier inside it (the
 *                capture included) that names one of the file's data
 *                structures is a type use.
 *   exports      `@export.name` — an explicit export list (`__all__`); when
 *                the file has one, it alone decides what is exported.
 *   declarations (optional) what another file of the language declares, for
 *                star-import and package-directory searches; `definitions`
 *                when absent.
 */

import { posix } from 'node:path';
import { collapse, unsupportedLanguageRefusal } from './storyline.js';
import type { TreeSitterEngine, TreeSitterLanguage, TreeSitterNode, TreeSitterQuery } from './storyline-treesitter.js';
import type {
  StorylineAnswer,
  StorylineCall,
  StorylineClass,
  StorylineEntry,
  StorylinePiece,
  StorylinePieceKind,
  StorylineRefusal,
  StorylineTypeUse,
} from './storyline-types.js';
import {
  isDirectoryTarget,
  DIRECTORY_TARGET_SUFFIX,
  type DefinitionKind,
  type StorylineLanguage,
  type StorylineLanguageQueries,
  type StorylineProject,
  type VisibilitySubject,
} from './storyline-languages/contract.js';
import { BASH } from './storyline-languages/bash.js';
import { CPP } from './storyline-languages/cpp.js';
import { CSHARP } from './storyline-languages/csharp.js';
import { GO } from './storyline-languages/go.js';
import { JAVA } from './storyline-languages/java.js';
import { PHP } from './storyline-languages/php.js';
import { PYTHON } from './storyline-languages/python.js';
import { RUBY } from './storyline-languages/ruby.js';
import { RUST } from './storyline-languages/rust.js';

// ── The table ────────────────────────────────────────────

export type {
  DefinitionKind,
  DocCommentRules,
  DocSubject,
  StorylineLanguage,
  StorylineLanguageQueries,
  StorylineProject,
  VisibilitySubject,
} from './storyline-languages/contract.js';
export { directoryTarget, docCommentAbove, isDirectoryTarget, lineCommentBlockAbove } from './storyline-languages/contract.js';
export { BASH } from './storyline-languages/bash.js';
export { CPP, resolveCppInclude } from './storyline-languages/cpp.js';
export { CSHARP } from './storyline-languages/csharp.js';
export { GO, resolveGoImport } from './storyline-languages/go.js';
export { JAVA, resolveJavaImport } from './storyline-languages/java.js';
export { PHP, resolvePhpImport } from './storyline-languages/php.js';
export { PYTHON, resolvePythonImport } from './storyline-languages/python.js';
export { RUBY } from './storyline-languages/ruby.js';
export { RUST, resolveRustImport } from './storyline-languages/rust.js';

// ── The registry ─────────────────────────────────────────

/** Every language read through tree-sitter. TypeScript and JavaScript are not here: the compiler reads them. */
export const STORYLINE_LANGUAGES: readonly StorylineLanguage[] = [PYTHON, GO, RUST, JAVA, CSHARP, RUBY, PHP, CPP, BASH];

const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, StorylineLanguage> = new Map(
  STORYLINE_LANGUAGES.flatMap((language) => language.extensions.map((extension) => [extension, language] as const)),
);

/** The table a file is read with, or null when no table covers its extension. */
export function storylineTableFor(file: string): StorylineLanguage | null {
  return LANGUAGE_BY_EXTENSION.get(posix.extname(file).toLowerCase()) ?? null;
}

/**
 * Load the grammars `files` need (once each; the engine caches them). The one
 * asynchronous step: after it, `extractWithTreeSitter` reads synchronously.
 */
export async function prepareStorylineLanguages(engine: TreeSitterEngine, files: readonly string[]): Promise<void> {
  const grammars = new Set<string>();
  for (const file of files) {
    const table = storylineTableFor(file);
    if (table !== null) grammars.add(table.grammar);
  }
  await Promise.all([...grammars].map((grammar) => engine.grammar(grammar)));
}

// ── Entry ────────────────────────────────────────────────

export interface ExtractWithTreeSitterInput {
  /** A started engine whose grammar for this file was loaded (`prepareStorylineLanguages`). */
  engine: TreeSitterEngine;
  /** Project-relative, forward slashes. */
  file: string;
  text: string;
  /** Whether a project-relative path names a file — used to resolve imports. */
  fileExists: (relPath: string) => boolean;
  /** Optional: another project file's text — lets a star import or a package directory be searched. */
  readFile?: (relPath: string) => string | null;
  /** Optional: the project-relative files directly inside a directory — lets a package directory be searched. */
  listDirectory?: (relDir: string) => readonly string[];
}

export function extractWithTreeSitter(input: ExtractWithTreeSitterInput): StorylineAnswer {
  const { engine, file, text } = input;
  const table = storylineTableFor(file);
  if (table === null) return unsupportedLanguageRefusal(file, text);

  const grammar = engine.loadedGrammar(table.grammar);
  if (grammar === null) return noTreeSitterReader(table, file, text);
  const queries = compileQueries(engine, table, grammar);
  if (queries === null) return noTreeSitterReader(table, file, text);

  const tree = engine.parse(grammar, text);
  if (tree === null) return noTreeSitterReader(table, file, text);
  try {
    const syntaxRefusal = refuseOnSyntaxError(tree.rootNode, file, text);
    if (syntaxRefusal !== null) return syntaxRefusal;
    const project: StorylineProject = { fileExists: input.fileExists };
    if (input.readFile !== undefined) project.readFile = input.readFile;
    if (input.listDirectory !== undefined) project.listDirectory = input.listDirectory;
    const reader = new TreeReader({ engine, grammar, table, queries, root: tree.rootNode, file, text, project });
    reader.read();
    return {
      ok: true,
      scope: 'file',
      files: [file],
      language: table.id,
      pieces: reader.pieces,
      calls: reader.calls,
      typeUses: reader.typeUses,
      entries: reader.entries,
      classes: reader.classes,
    };
  } finally {
    tree.delete();
  }
}

// ── Imports, for the import index and the ranking ────────

/** One import statement of a file, as its table's imports query reads it. */
export interface TreeSitterImport {
  /** The module specifier as written. */
  source: string;
  /** A name imported from it; null when the module itself is bound. */
  name: string | null;
  alias: string | null;
  /** A star import (`#include`, `require_relative`, `source`). */
  all: boolean;
}

/**
 * A file's imports, read with its table's imports query — null when the file
 * has no table or its grammar was not loaded (`prepareStorylineLanguages`).
 * A file that does not parse still has its imports read: ranking is an
 * ordering, and a half-written importer still imports.
 */
export function readTreeSitterImports(engine: TreeSitterEngine, file: string, text: string): TreeSitterImport[] | null {
  const table = storylineTableFor(file);
  if (table === null) return null;
  const grammar = engine.loadedGrammar(table.grammar);
  if (grammar === null) return null;
  const query = engine.query(`${table.id}:imports`, grammar, table.queries.imports);
  if (query === null) return null;
  const tree = engine.parse(grammar, text);
  if (tree === null) return null;
  try {
    const imports: TreeSitterImport[] = [];
    for (const match of query.matches(tree.rootNode)) {
      const source = captureOf(match.captures, 'import.source')?.text;
      if (source === undefined) continue;
      imports.push({
        source,
        name: captureOf(match.captures, 'import.name')?.text ?? null,
        alias: captureOf(match.captures, 'import.alias')?.text ?? null,
        all: captureOf(match.captures, 'import.all') !== null,
      });
    }
    return imports;
  } finally {
    tree.delete();
  }
}

/** Every specifier an import may name a project file by: its source, and `source.name` when the table says a name may be a module. */
export function importSpecifiersOf(table: StorylineLanguage, imports: readonly TreeSitterImport[]): string[] {
  const specifiers = new Set<string>();
  for (const entry of imports) {
    specifiers.add(entry.source);
    if (entry.name !== null && table.submoduleSpecifier !== undefined) {
      specifiers.add(table.submoduleSpecifier(entry.source, entry.name));
    }
  }
  return [...specifiers];
}

// ── Refusals ─────────────────────────────────────────────

/** The refusal for a file whose language has a table but no loaded reader (no engine, no grammar). */
export function noTreeSitterReader(table: StorylineLanguage, file: string, text: string): StorylineRefusal {
  return {
    ok: false,
    reason: 'no-compiler',
    sentence: `Flow couldn't load its ${table.displayName} reader, so this file opens as plain code.`,
    text,
    file,
  };
}

/** A syntax error's own text is cut here in the sentence. */
const ERROR_SNIPPET_MAX_CHARS = 40;

/** The first ERROR or MISSING node, depth first — only subtrees that carry an error are entered. */
function firstSyntaxError(node: TreeSitterNode): TreeSitterNode | null {
  if (node.isError || node.isMissing) return node;
  if (!node.hasError) return null;
  for (const child of node.children) {
    if (child === null) continue;
    const found = firstSyntaxError(child);
    if (found !== null) return found;
  }
  return null;
}

function refuseOnSyntaxError(root: TreeSitterNode, file: string, text: string): StorylineRefusal | null {
  if (!root.hasError) return null;
  const error = firstSyntaxError(root) ?? root;
  const line = error.startPosition.row + 1;
  let detail: string;
  if (error.isMissing) {
    detail = `missing "${error.type}"`;
  } else {
    const snippet = collapse(error.text.split('\n')[0] ?? '');
    detail = snippet === '' ? 'unexpected end' : `unexpected "${snippet.slice(0, ERROR_SNIPPET_MAX_CHARS)}"`;
  }
  return {
    ok: false,
    reason: 'syntax-error',
    sentence: `This file can't be read as a story yet: line ${line} doesn't parse (${detail}).`,
    text,
    file,
  };
}

// ── Queries ──────────────────────────────────────────────

interface CompiledQueries {
  definitions: TreeSitterQuery;
  calls: TreeSitterQuery;
  imports: TreeSitterQuery;
  typeUses: TreeSitterQuery | null;
  exports: TreeSitterQuery | null;
  /** What other files declare — `definitions` when the table has no `declarations`. */
  declarations: TreeSitterQuery;
}

function compileQueries(
  engine: TreeSitterEngine,
  table: StorylineLanguage,
  grammar: TreeSitterLanguage,
): CompiledQueries | null {
  const compile = (name: keyof StorylineLanguageQueries): TreeSitterQuery | null => {
    const source = table.queries[name];
    return source === undefined ? null : engine.query(`${table.id}:${name}`, grammar, source);
  };
  const definitions = compile('definitions');
  const calls = compile('calls');
  const imports = compile('imports');
  if (definitions === null || calls === null || imports === null) return null;
  const typeUses = compile('typeUses');
  const exports = compile('exports');
  const declarations = compile('declarations');
  // A table that declares an optional query that does not compile is as broken as a missing required one.
  if (table.queries.typeUses !== undefined && typeUses === null) return null;
  if (table.queries.exports !== undefined && exports === null) return null;
  if (table.queries.declarations !== undefined && declarations === null) return null;
  return { definitions, calls, imports, typeUses, exports, declarations: declarations ?? definitions };
}

type Captures = ReadonlyArray<{ name: string; node: TreeSitterNode }>;

/** The node a capture named `name` holds in a match, or null. */
function captureOf(captures: Captures, name: string): TreeSitterNode | null {
  return captures.find((capture) => capture.name === name)?.node ?? null;
}

// ── Definitions, shared by the file and the files it searches ──

const DEFINITION_PREFIX = 'definition.';

/** Higher wins when several matches describe one definition. */
const KIND_PRIORITY: Readonly<Record<DefinitionKind, number>> = {
  function: 0,
  class: 1,
  type: 2,
  // The specific data-structure kinds beat the generic `type` a broader pattern also gives the same name.
  interface: 3,
  enum: 3,
};

const DATA_STRUCTURE_KINDS: ReadonlySet<StorylinePieceKind> = new Set(['interface', 'type', 'enum']);

/** Kinds whose public methods a story may open on. */
const ENTRY_OWNER_KINDS: ReadonlySet<StorylinePieceKind> = new Set(['class', 'type']);

function isClassLike(kind: DefinitionKind): boolean {
  return kind !== 'function';
}

/** One definition of a file, merged across the matches that describe it. */
interface Definition {
  name: string;
  kind: DefinitionKind;
  span: TreeSitterNode;
  body: TreeSitterNode | null;
  parameters: TreeSitterNode | null;
  /** `@owner`: the type a function declared outside it belongs to. */
  ownerName: string | null;
  /** `@self`: this method's own receiver name. */
  selfName: string | null;
  /** Its piece — null for a definition nested inside a function (part of that piece). */
  piece: StorylinePiece | null;
  /** The class-like definition of THIS file it is a member of. */
  owner: Definition | null;
  /** The type it is a member of, here or elsewhere (`owner.name`, or `ownerName`). */
  memberOf: string | null;
}

/** Every definition `query` finds under `root`, merged per `@name` node, in file order, plus a span → definition map. */
function collectDefinitions(
  query: TreeSitterQuery,
  root: TreeSitterNode,
): { definitions: Definition[]; byNode: Map<number, Definition> } {
  const byName = new Map<number, Definition>();
  const byNode = new Map<number, Definition>();
  for (const match of query.matches(root)) {
    const nameNode = captureOf(match.captures, 'name');
    const spanCapture = match.captures.find((capture) => capture.name.startsWith(DEFINITION_PREFIX));
    if (nameNode === null || spanCapture === undefined) continue;
    const kind = spanCapture.name.slice(DEFINITION_PREFIX.length) as DefinitionKind;
    if (KIND_PRIORITY[kind] === undefined) continue;
    const span = spanCapture.node;
    const found: Omit<Definition, 'name' | 'kind' | 'span' | 'piece' | 'owner' | 'memberOf'> = {
      body: captureOf(match.captures, 'body'),
      parameters: captureOf(match.captures, 'parameters'),
      ownerName: captureOf(match.captures, 'owner')?.text ?? null,
      selfName: captureOf(match.captures, 'self')?.text ?? null,
    };
    byNode.set(span.id, mergeDefinition(byName, nameNode, kind, span, found));
  }
  const definitions = [...byName.values()].sort((left, right) => left.span.startIndex - right.span.startIndex);
  return { definitions, byNode };
}

function mergeDefinition(
  byName: Map<number, Definition>,
  nameNode: TreeSitterNode,
  kind: DefinitionKind,
  span: TreeSitterNode,
  found: Pick<Definition, 'body' | 'parameters' | 'ownerName' | 'selfName'>,
): Definition {
  const existing = byName.get(nameNode.id);
  if (existing === undefined) {
    const created: Definition = { name: nameNode.text, kind, span, ...found, piece: null, owner: null, memberOf: null };
    byName.set(nameNode.id, created);
    return created;
  }
  if (KIND_PRIORITY[kind] > KIND_PRIORITY[existing.kind]) existing.kind = kind;
  if (span.endIndex - span.startIndex > existing.span.endIndex - existing.span.startIndex) existing.span = span;
  existing.body = existing.body ?? found.body;
  existing.parameters = existing.parameters ?? found.parameters;
  existing.ownerName = existing.ownerName ?? found.ownerName;
  existing.selfName = existing.selfName ?? found.selfName;
  return existing;
}

/** The nearest definition strictly enclosing `node`, or null at the top level. */
function enclosingDefinition(
  byNode: ReadonlyMap<number, Definition>,
  node: TreeSitterNode,
  self: Definition | null,
): Definition | null {
  let current = node.parent;
  while (current !== null) {
    const found = byNode.get(current.id);
    if (found !== undefined && found !== self) return found;
    current = current.parent;
  }
  return null;
}

// ── The reader ───────────────────────────────────────────

/** How a name entered the file through an import. */
interface ImportBinding {
  /** Project-relative target (a file, or a directory target); null for a package or an unresolvable path. */
  file: string | null;
  /** A specifier that names (or can only name) a project file. */
  local: boolean;
  /** The imported name; null when the binding is the module itself. */
  importedName: string | null;
  /** For a module binding: the name the target declares it under (`Order` for `use …\Order as O`). */
  moduleName: string;
}

type CallTarget = Pick<StorylineCall, 'to' | 'external' | 'unresolvedName'>;

interface TreeReaderInit {
  engine: TreeSitterEngine;
  grammar: TreeSitterLanguage;
  table: StorylineLanguage;
  queries: CompiledQueries;
  root: TreeSitterNode;
  file: string;
  text: string;
  project: StorylineProject;
}

class TreeReader {
  readonly pieces: StorylinePiece[] = [];
  readonly calls: StorylineCall[] = [];
  readonly typeUses: StorylineTypeUse[] = [];
  readonly entries: StorylineEntry[] = [];
  readonly classes: StorylineClass[] = [];

  readonly #init: TreeReaderInit;
  readonly #table: StorylineLanguage;
  readonly #file: string;
  readonly #lines: readonly string[];
  #definitions: Definition[] = [];
  /** Every captured span node (wrapper and core) → its definition. */
  #definitionByNode = new Map<number, Definition>();
  readonly #topLevel = new Map<string, Definition>();
  readonly #dataStructures = new Map<string, string>();
  readonly #classMembers = new Map<string, Map<string, string>>();
  readonly #imports = new Map<string, ImportBinding>();
  /** Star imports and implicit imports: targets searched for names the file cannot otherwise place. */
  readonly #starTargets: string[] = [];
  readonly #usedIds = new Set<string>();
  readonly #pieceStart = new Map<string, number>();
  readonly #publicMembers = new Set<string>();
  /** Types declared in another file that this file adds methods to, by whether they are exported. */
  readonly #foreignOwners = new Map<string, boolean>();
  /** Another file's top-level names, read once (null: unreadable). */
  readonly #declaredNames = new Map<string, ReadonlySet<string> | null>();
  #exportList: Set<string> | null = null;

  constructor(init: TreeReaderInit) {
    this.#init = init;
    this.#table = init.table;
    this.#file = init.file;
    this.#lines = init.text.split('\n');
  }

  read(): void {
    this.#readExportList();
    this.#readImports();
    const { definitions, byNode } = collectDefinitions(this.#init.queries.definitions, this.#init.root);
    this.#definitions = definitions;
    this.#definitionByNode = byNode;
    this.#readPieces();
    this.#readCalls();
    this.#readTypeUses();
    this.#readEntries();
  }

  // ── Exports and imports ──

  #readExportList(): void {
    const query = this.#init.queries.exports;
    if (query === null) return;
    const names = query
      .captures(this.#init.root)
      .filter((capture) => capture.name === 'export.name')
      .map((capture) => capture.node.text);
    if (names.length > 0) this.#exportList = new Set(names);
  }

  #isExportedTopLevel(definition: Definition): boolean {
    if (this.#exportList !== null) return this.#exportList.has(definition.name);
    if (this.#table.isPublicDefinition !== undefined) {
      return this.#table.isPublicDefinition({ span: definition.span, name: definition.name, owner: null });
    }
    return this.#table.isExportedName(definition.name);
  }

  #isPublicMember(definition: Definition, ownerName: string, owner: Definition | null): boolean {
    if (this.#table.isPublicDefinition === undefined) return this.#table.isPublicMember(definition.name);
    const subject: VisibilitySubject = {
      span: definition.span,
      name: definition.name,
      owner: { name: ownerName, kind: owner?.kind ?? null },
    };
    return this.#table.isPublicDefinition(subject);
  }

  #readImports(): void {
    for (const match of this.#init.queries.imports.matches(this.#init.root)) {
      const sourceNode = captureOf(match.captures, 'import.source');
      if (sourceNode === null) continue;
      const source = sourceNode.text;
      if (captureOf(match.captures, 'import.all') !== null) {
        const target = this.#resolve(source);
        if (target !== null && !this.#starTargets.includes(target)) this.#starTargets.push(target);
        continue;
      }
      const name = captureOf(match.captures, 'import.name')?.text ?? null;
      const alias = captureOf(match.captures, 'import.alias')?.text ?? null;
      const local = this.#table.isLocalSpecifier(source);
      if (name === null) {
        // The module itself, bound to its alias or (unaliased) to the name the table says it binds.
        const file = this.#resolve(source);
        const moduleName = this.#table.moduleBindingName?.(source) ?? source;
        this.#imports.set(alias ?? moduleName, { file, local: local || file !== null, importedName: null, moduleName });
        continue;
      }
      const submodule = this.#table.submoduleSpecifier?.(source, name);
      const submoduleFile = submodule === undefined ? null : this.#resolve(submodule);
      if (submoduleFile !== null) {
        this.#imports.set(alias ?? name, { file: submoduleFile, local: true, importedName: null, moduleName: name });
        continue;
      }
      const file = this.#resolve(source);
      this.#imports.set(alias ?? name, { file, local: local || file !== null, importedName: name, moduleName: name });
    }
    for (const target of this.#table.implicitImports?.(this.#file) ?? []) {
      if (!this.#starTargets.includes(target)) this.#starTargets.push(target);
    }
  }

  #resolve(specifier: string): string | null {
    return this.#table.resolveImport(this.#file, specifier, this.#init.project);
  }

  // ── Pieces ──

  #readPieces(): void {
    // Top-level pieces first, so a method declared before its type (Go, Rust,
    // C++ out of line) still finds it; then pieces go back into file order.
    const members: Array<[Definition, string]> = [];
    for (const definition of this.#definitions) {
      const parent = enclosingDefinition(this.#definitionByNode, definition.span, definition);
      if (parent === null) {
        if (definition.kind === 'function' && definition.ownerName !== null) members.push([definition, definition.ownerName]);
        else this.#addTopLevel(definition);
        continue;
      }
      // A member of a top-level class-like definition is a method; anything
      // nested deeper (a function in a function, a class in a class) is part
      // of its enclosing piece's story, not a box of its own.
      if (definition.kind !== 'function' || !isClassLike(parent.kind)) continue;
      if (enclosingDefinition(this.#definitionByNode, parent.span, parent) !== null) continue;
      members.push([definition, parent.name]);
    }
    for (const [definition, ownerName] of members) this.#addMethod(definition, ownerName);
    this.pieces.sort((left, right) => (this.#pieceStart.get(left.id) ?? 0) - (this.#pieceStart.get(right.id) ?? 0));
    for (const definition of this.#definitions) {
      if (definition.piece === null || this.#topLevel.get(definition.name) !== definition) continue;
      if (isClassLike(definition.kind)) this.#addClassFrame(definition);
    }
  }

  #addTopLevel(definition: Definition): void {
    const piece = this.#addPiece(definition, definition.kind, this.#isExportedTopLevel(definition));
    definition.piece = piece;
    this.#topLevel.set(definition.name, definition);
    if (DATA_STRUCTURE_KINDS.has(definition.kind)) this.#dataStructures.set(definition.name, piece.id);
    if (isClassLike(definition.kind) && !this.#classMembers.has(definition.name)) {
      this.#classMembers.set(definition.name, new Map());
    }
  }

  /** The top-level class-like definition of this file named `name`, or null. */
  #ownType(name: string): Definition | null {
    const found = this.#topLevel.get(name);
    return found !== undefined && isClassLike(found.kind) && found.piece !== null ? found : null;
  }

  #addMethod(definition: Definition, ownerName: string): void {
    const owner = this.#ownType(ownerName);
    const isConstructor = this.#table.isConstructor(definition.name, ownerName);
    const exported = owner?.piece?.exported ?? this.#table.isExportedName(ownerName);
    if (owner === null) this.#foreignOwners.set(ownerName, exported);
    const piece = this.#addPiece(definition, 'method', exported, { className: ownerName, isConstructor });
    definition.piece = piece;
    definition.owner = owner;
    definition.memberOf = ownerName;
    if (this.#isPublicMember(definition, ownerName, owner)) this.#publicMembers.add(piece.id);
    const members = this.#classMembers.get(ownerName) ?? new Map<string, string>();
    this.#classMembers.set(ownerName, members);
    if (!members.has(definition.name)) members.set(definition.name, piece.id);
  }

  #addClassFrame(definition: Definition): void {
    const members = this.#classMembers.get(definition.name);
    const hasMethods = members !== undefined && members.size > 0;
    if (definition.kind !== 'class' && !hasMethods) return;
    const startLine = definition.span.startPosition.row + 1;
    const frame: StorylineClass = { name: definition.name, file: this.#file, startLine };
    const constructor = this.#constructorOf(definition.name);
    if (constructor?.parameters !== null && constructor?.parameters !== undefined) {
      frame.constructorSignature = `${constructor.name}${collapse(constructor.parameters.text)}`;
    }
    this.classes.push(frame);
  }

  #constructorOf(className: string): Definition | null {
    return (
      this.#definitions.find(
        (definition) =>
          definition.memberOf === className &&
          definition.piece !== null &&
          this.#table.isConstructor(definition.name, className),
      ) ?? null
    );
  }

  #addPiece(
    definition: Definition,
    kind: StorylinePieceKind,
    exported: boolean,
    method?: { className: string; isConstructor: boolean },
  ): StorylinePiece {
    const { name, span } = definition;
    const baseId = method === undefined ? `${this.#file}#${name}` : `${this.#file}#${method.className}.${name}`;
    const piece: StorylinePiece = {
      id: this.#uniqueId(baseId),
      kind,
      name,
      file: this.#file,
      startLine: span.startPosition.row + 1,
      endLine: span.endPosition.row + 1,
      doc: this.#table.docOf({ span, body: definition.body, lines: this.#lines }),
      text: span.text,
      exported,
    };
    if (method !== undefined) {
      piece.className = method.className;
      if (method.isConstructor) piece.isConstructor = true;
    }
    this.pieces.push(piece);
    this.#pieceStart.set(piece.id, span.startIndex);
    return piece;
  }

  /** A property's getter and setter share a name; the second keeps its own id. */
  #uniqueId(baseId: string): string {
    let id = baseId;
    let suffix = 2;
    while (this.#usedIds.has(id)) {
      id = `${baseId}~${suffix}`;
      suffix += 1;
    }
    this.#usedIds.add(id);
    return id;
  }

  /**
   * The piece whose story `node` belongs to: the nearest enclosing definition
   * that has a piece, passing through nested functions; null at the top level
   * or inside a nested class (its own story, not this piece's).
   */
  #owningPiece(node: TreeSitterNode): Definition | null {
    let definition = enclosingDefinition(this.#definitionByNode, node, null);
    while (definition !== null) {
      if (definition.piece !== null) return definition;
      if (isClassLike(definition.kind)) return null;
      definition = enclosingDefinition(this.#definitionByNode, definition.span, definition);
    }
    return null;
  }

  // ── Calls ──

  #readCalls(): void {
    const byPiece = new Map<string, StorylineCall[]>();
    const seen = new Set<string>();
    for (const match of this.#init.queries.calls.matches(this.#init.root)) {
      const callNode = captureOf(match.captures, 'call');
      if (callNode === null) continue;
      const owner = this.#owningPiece(callNode);
      // Only functions and methods own calls, and only from their body (a decorator's call is not the body's).
      if (owner === null || owner.piece === null || owner.body === null) continue;
      if (owner.kind !== 'function') continue;
      if (callNode.startIndex < owner.body.startIndex || callNode.endIndex > owner.body.endIndex) continue;
      const callee = captureOf(match.captures, 'callee');
      const receiver = captureOf(match.captures, 'receiver');
      const member = captureOf(match.captures, 'member');
      const target = this.#resolveCall(owner, callee, receiver, member);
      if (target === null) continue;
      const lineNode = callee ?? receiver ?? callNode;
      const entry: StorylineCall = { from: owner.piece.id, line: lineNode.startPosition.row + 1, to: target.to };
      if (target.external !== undefined) entry.external = target.external;
      if (target.unresolvedName !== undefined) entry.unresolvedName = target.unresolvedName;
      const key = JSON.stringify([entry.from, entry.line, entry.to, entry.external, entry.unresolvedName]);
      if (seen.has(key)) continue;
      seen.add(key);
      const list = byPiece.get(entry.from) ?? [];
      list.push(entry);
      byPiece.set(entry.from, list);
    }
    // Piece order, then line order — the shape the TypeScript reader gives.
    for (const piece of this.pieces) {
      const list = byPiece.get(piece.id);
      if (list !== undefined) this.calls.push(...list.sort((left, right) => left.line - right.line));
    }
  }

  #resolveCall(
    owner: Definition,
    callee: TreeSitterNode | null,
    receiver: TreeSitterNode | null,
    member: TreeSitterNode | null,
  ): CallTarget | null {
    if (callee !== null) return this.#resolveBareCall(callee.text, owner);
    if (receiver === null || member === null) return null;
    const receiverName = receiver.text;
    const memberName = member.text;
    // As written (`self.notify`, `Self::make`, `$this->save`) — what a plain call shows.
    const written = collapse(this.#init.text.slice(receiver.startIndex, member.endIndex));
    const className = owner.memberOf;
    if (this.#table.selfReceivers.includes(receiverName) || (owner.selfName !== null && receiverName === owner.selfName)) {
      if (className === null) return null;
      const target = this.#classMembers.get(className)?.get(memberName);
      if (target !== undefined) return { to: target };
      return { to: null, unresolvedName: written };
    }
    const ownClass = this.#classMembers.get(receiverName);
    if (ownClass !== undefined) {
      // `OrderService.make()` — a member of one of this file's own types.
      const target = ownClass.get(memberName);
      if (target !== undefined) return { to: target };
      if (memberName === this.#table.constructsVia) {
        const constructed = this.#constructorOf(receiverName)?.piece?.id ?? this.#ownType(receiverName)?.piece?.id;
        if (constructed !== undefined) return { to: constructed };
      }
      return { to: null, unresolvedName: written };
    }
    // What the target file declares the member as: `Pricing.new` constructs `Pricing`.
    const declaredName = (typeName: string): string => (memberName === this.#table.constructsVia ? typeName : memberName);
    const binding = this.#imports.get(receiverName);
    if (binding !== undefined) {
      // Only a module binding proves what `module.f()` calls; an imported value's method could be anything.
      if (binding.importedName !== null || binding.file === null) return null;
      return this.#external(binding.file, declaredName(binding.moduleName), written);
    }
    const typeFile = this.#table.typeFileFor?.(this.#file, receiverName, this.#init.project.fileExists) ?? null;
    if (typeFile !== null) return { to: null, external: { file: typeFile, name: declaredName(receiverName) } };
    const declaring = this.#starDeclaring(receiverName);
    if (declaring !== null) return { to: null, external: { file: declaring, name: declaredName(receiverName) } };
    return null;
  }

  #resolveBareCall(name: string, owner: Definition): CallTarget | null {
    if (this.#table.implicitSelfCalls === true && owner.memberOf !== null) {
      // `record(o)` inside a method — its own type's member first, as the language looks it up.
      const target = this.#classMembers.get(owner.memberOf)?.get(name);
      if (target !== undefined) return { to: target };
    }
    if (this.#table.classCallConstructs && owner.memberOf !== null && this.#table.selfReceivers.includes(name)) {
      // `new self()` / `new static()` — constructs the method's own type.
      const own = this.#constructorOf(owner.memberOf)?.piece?.id ?? this.#ownType(owner.memberOf)?.piece?.id;
      return own === undefined ? null : { to: own };
    }
    const local = this.#topLevel.get(name)?.piece ?? null;
    if (local !== null) {
      if (local.kind === 'function') return { to: local.id };
      if (this.#table.classCallConstructs) {
        // Calling a class constructs it: the arrow goes to its constructor, or the class when it declares none.
        return { to: this.#constructorOf(name)?.piece?.id ?? local.id };
      }
    }
    const binding = this.#imports.get(name);
    if (binding !== undefined) {
      if (!binding.local) return null;
      if (binding.file !== null && binding.importedName !== null) {
        return this.#external(binding.file, binding.importedName, name);
      }
      // `new Pricing()` on an imported class: the module binding IS the type.
      if (binding.file !== null) return this.#external(binding.file, binding.moduleName, name);
      return { to: null, unresolvedName: name };
    }
    const typeFile = this.#table.typeFileFor?.(this.#file, name, this.#init.project.fileExists) ?? null;
    if (typeFile !== null) return { to: null, external: { file: typeFile, name } };
    const declaring = this.#starDeclaring(name);
    if (declaring !== null) return { to: null, external: { file: declaring, name } };
    if (this.#table.builtIns.has(name)) return null;
    if (this.#table.dropUnknownCalls === true) return null;
    return { to: null, unresolvedName: name };
  }

  /** A call into `target`: a file is certain; a directory names the file declaring `name`, or the call stays plain. */
  #external(target: string, name: string, written: string): CallTarget {
    if (!isDirectoryTarget(target)) return { to: null, external: { file: target, name } };
    const file = this.#declaringFileIn(target, name);
    return file === null ? { to: null, unresolvedName: written } : { to: null, external: { file, name } };
  }

  /** The star-imported (or implicitly imported) file that declares `name` at its top level, or null. */
  #starDeclaring(name: string): string | null {
    for (const target of this.#starTargets) {
      const file = this.#declaringFileIn(target, name);
      if (file !== null) return file;
    }
    return null;
  }

  #declaringFileIn(target: string, name: string): string | null {
    const candidates = isDirectoryTarget(target) ? this.#filesOfDirectory(target) : [target];
    return candidates.find((candidate) => this.#declaredNamesOf(candidate)?.has(name) === true) ?? null;
  }

  /** This language's files in a directory target, this file excluded, in name order. */
  #filesOfDirectory(target: string): string[] {
    const listDirectory = this.#init.project.listDirectory;
    if (listDirectory === undefined) return [];
    const directory = target.slice(0, -DIRECTORY_TARGET_SUFFIX.length) || '.';
    return listDirectory(directory)
      .filter((file) => file !== this.#file && storylineTableFor(file) === this.#table)
      .sort();
  }

  /** Another file's top-level names, parsed with this file's grammar (cached; null when unreadable). */
  #declaredNamesOf(file: string): ReadonlySet<string> | null {
    if (this.#declaredNames.has(file)) return this.#declaredNames.get(file) ?? null;
    let names: ReadonlySet<string> | null = null;
    const text = file === this.#file ? null : (this.#init.project.readFile?.(file) ?? null);
    if (text !== null) {
      const tree = this.#init.engine.parse(this.#init.grammar, text);
      if (tree !== null) {
        try {
          const { definitions, byNode } = collectDefinitions(this.#init.queries.declarations, tree.rootNode);
          names = new Set(
            definitions
              .filter((definition) => definition.ownerName === null)
              .filter((definition) => enclosingDefinition(byNode, definition.span, definition) === null)
              .map((definition) => definition.name),
          );
        } finally {
          tree.delete();
        }
      }
    }
    this.#declaredNames.set(file, names);
    return names;
  }

  // ── Type uses ──

  #readTypeUses(): void {
    const query = this.#init.queries.typeUses;
    if (query === null) return;
    const targetsByPiece = new Map<string, Set<string>>();
    for (const capture of query.captures(this.#init.root)) {
      if (capture.name !== 'type') continue;
      // A class's header (its bases) sits inside the class, so the class owns
      // it; a parameter's hint sits inside its function.
      const owner = this.#owningPiece(capture.node);
      if (owner === null || owner.piece === null) continue;
      const fromId = owner.piece.id;
      const targets = targetsByPiece.get(fromId) ?? new Set<string>();
      for (const identifier of capture.node.descendantsOfType([...this.#table.typeIdentifierTypes])) {
        if (identifier === null) continue;
        const target = this.#dataStructures.get(identifier.text);
        if (target !== undefined && target !== fromId) targets.add(target);
      }
      targetsByPiece.set(fromId, targets);
    }
    for (const piece of this.pieces) {
      for (const to of targetsByPiece.get(piece.id) ?? []) this.typeUses.push({ from: piece.id, to });
    }
  }

  // ── Entries ──

  #readEntries(): void {
    const entryOwners = new Set(
      this.pieces
        .filter((piece) => ENTRY_OWNER_KINDS.has(piece.kind) && piece.exported && piece.className === undefined)
        .map((piece) => piece.name),
    );
    for (const [name, exported] of this.#foreignOwners) if (exported) entryOwners.add(name);
    for (const piece of this.pieces) {
      if (!piece.exported) continue;
      if (piece.kind === 'function' || piece.kind === 'class') {
        this.entries.push({ pieceId: piece.id, usedFrom: 0 });
        continue;
      }
      if (piece.kind !== 'method' || piece.isConstructor === true) continue;
      if (piece.className === undefined || !entryOwners.has(piece.className)) continue;
      if (!this.#publicMembers.has(piece.id)) continue;
      this.entries.push({ pieceId: piece.id, usedFrom: 0 });
    }
  }
}
