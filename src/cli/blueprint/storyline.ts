/**
 * CODE STORYLINE — one file read as a story (discovery `code-storyline`,
 * plan `code-storyline` phase 2).
 *
 * PURE: text in, answer out. The caller loads the compiler
 * (`storyline-compiler.ts`), reads the file, and says which project files
 * exist; nothing here touches the filesystem, so the same function serves the
 * CLI verb, its cache and the tests.
 *
 * Syntax only — `createSourceFile`, never a type-checker program. That is the
 * whole trust model: a call becomes an arrow only when the file's own
 * declarations or its RELATIVE imports name the target. Everything else is
 * either dropped (package imports, method calls on values) or kept as an
 * `unresolvedName` for the reader to see as plain text — never guessed.
 *
 * What is drawn:
 *   • pieces — top-level functions (declared, or `const x = () => …`), classes
 *     and their methods / accessors / constructor / arrow-valued fields,
 *     interfaces, type aliases and enums;
 *   • calls — made inside a function or method body, including nested
 *     callbacks (`.finally(() => this.loop())` belongs to the enclosing piece);
 *   • typeUses — a piece naming one of this file's data structures;
 *   • classes — the frame a class's methods sit in;
 *   • entries — the exported ways in, in file order (ranked later, by the
 *     caller that can count importers).
 */

import { posix } from 'node:path';
import type * as TS from 'typescript';
import type { TsModule } from './storyline-compiler.js';
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

export interface ExtractStorylineInput {
  ts: TsModule;
  /** Project-relative, forward slashes. */
  file: string;
  text: string;
  /** Whether a project-relative path names a file — used to resolve relative imports. */
  fileExists: (relPath: string) => boolean;
}

/** A doc comment's first sentence is cut here, so one comment cannot flood a box. */
const DOC_MAX_CHARS = 200;

/** A comment is "directly above" a declaration when at most this many line breaks separate them. */
const MAX_LINE_BREAKS_BETWEEN_DOC_AND_DECLARATION = 1;

type Language = 'typescript' | 'javascript';

interface LanguageInfo {
  language: Language;
  scriptKind: 'TS' | 'TSX' | 'JS' | 'JSX';
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, LanguageInfo>> = {
  '.ts': { language: 'typescript', scriptKind: 'TS' },
  '.mts': { language: 'typescript', scriptKind: 'TS' },
  '.cts': { language: 'typescript', scriptKind: 'TS' },
  '.tsx': { language: 'typescript', scriptKind: 'TSX' },
  '.js': { language: 'javascript', scriptKind: 'JS' },
  '.mjs': { language: 'javascript', scriptKind: 'JS' },
  '.cjs': { language: 'javascript', scriptKind: 'JS' },
  '.jsx': { language: 'javascript', scriptKind: 'JSX' },
};

/** A compiled-output specifier (`./x.js`) names a source file with one of these. */
const SOURCE_EXTENSIONS_FOR_OUTPUT: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** Tried in order on an extensionless specifier, and on `<dir>/index`. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * Language built-ins called as bare identifiers. They are not the file's story
 * and not unresolved either — recording them would bury the calls that are.
 */
const BUILT_IN_CALLS: ReadonlySet<string> = new Set([
  'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
  'queueMicrotask', 'structuredClone', 'require', 'fetch',
  'Number', 'String', 'Boolean', 'Symbol', 'BigInt', 'Array', 'Object', 'Date', 'RegExp', 'Error',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
]);

// ── Shared with the verb ─────────────────────────────────

/** The language a file is read as, or null when it cannot be read as a story. */
export function storylineLanguageOf(file: string): Language | null {
  return LANGUAGE_BY_EXTENSION[posix.extname(file).toLowerCase()]?.language ?? null;
}

/**
 * Resolve a RELATIVE import specifier (`./x.js`, `../y`) written in `fromFile`
 * the way a TypeScript project means it, against `fileExists`. Null for a
 * package specifier, a path that leaves the project, or nothing on disk.
 *
 * Exported so the verb's importer count resolves an import by EXACTLY the
 * rules the story's arrows do (allowed-pattern #14) — two resolvers would let
 * the ranking and the drawing disagree about which file an import names.
 */
export function resolveRelativeImport(
  fromFile: string,
  specifier: string,
  fileExists: (relPath: string) => boolean,
): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  if (joined.startsWith('../') || joined === '..') return null;
  const candidates: string[] = [];
  const extension = posix.extname(joined);
  if (extension !== '') {
    candidates.push(joined);
    const stem = joined.slice(0, -extension.length);
    for (const sourceExtension of SOURCE_EXTENSIONS_FOR_OUTPUT[extension] ?? []) {
      candidates.push(stem + sourceExtension);
    }
  }
  for (const resolveExtension of RESOLVE_EXTENSIONS) candidates.push(joined + resolveExtension);
  for (const resolveExtension of RESOLVE_EXTENSIONS) candidates.push(`${joined}/index${resolveExtension}`);
  return candidates.find((candidate) => fileExists(candidate)) ?? null;
}

// ── Entry ────────────────────────────────────────────────

export function extractStoryline(input: ExtractStorylineInput): StorylineAnswer {
  const { ts, file, text } = input;
  const extension = posix.extname(file).toLowerCase();
  const languageInfo = LANGUAGE_BY_EXTENSION[extension];
  if (languageInfo === undefined) return unsupportedLanguage(file, text, extension);

  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind[languageInfo.scriptKind],
  );
  const syntaxRefusal = refuseOnSyntaxError(ts, sourceFile, file, text);
  if (syntaxRefusal !== null) return syntaxRefusal;

  const reader = new FileReader(ts, sourceFile, file, input.fileExists);
  reader.read();
  return {
    ok: true,
    scope: 'file',
    files: [file],
    language: languageInfo.language,
    pieces: reader.pieces,
    calls: reader.calls,
    typeUses: reader.typeUses,
    entries: reader.entries,
    classes: reader.classes,
  };
}

// ── Refusals ─────────────────────────────────────────────

/** The refusal for a file no story reader covers — it names the language when the extension says which. */
export function unsupportedLanguageRefusal(file: string, text: string): StorylineRefusal {
  return unsupportedLanguage(file, text, posix.extname(file).toLowerCase());
}

/**
 * Languages Flow has no story reader for, by extension — so the refusal can
 * name what the file IS ("Flow can't read Elixir as a story yet.") instead of
 * quoting an extension at the reader. Anything else is "this kind of file".
 */
const UNREADABLE_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  '.ex': 'Elixir', '.exs': 'Elixir', '.erl': 'Erlang', '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.swift': 'Swift', '.scala': 'Scala', '.sc': 'Scala', '.dart': 'Dart', '.lua': 'Lua',
  '.r': 'R', '.jl': 'Julia', '.hs': 'Haskell', '.ml': 'OCaml', '.clj': 'Clojure',
  '.fs': 'F#', '.vb': 'Visual Basic', '.pl': 'Perl', '.groovy': 'Groovy', '.zig': 'Zig',
  '.m': 'Objective-C', '.mm': 'Objective-C', '.ps1': 'PowerShell', '.sql': 'SQL',
  '.vue': 'Vue', '.svelte': 'Svelte', '.html': 'HTML', '.css': 'CSS', '.scss': 'Sass',
  '.md': 'Markdown', '.mdx': 'MDX', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
};

/** The language a file with no story reader is written in, when its extension says, or null. */
export function unreadableLanguageName(file: string): string | null {
  return UNREADABLE_LANGUAGE_NAMES[posix.extname(file).toLowerCase()] ?? null;
}

function unsupportedLanguage(file: string, text: string, extension: string): StorylineRefusal {
  const name = UNREADABLE_LANGUAGE_NAMES[extension] ?? null;
  const what = name === null ? 'this kind of file' : name;
  return {
    ok: false,
    reason: 'unsupported-language',
    sentence: `Flow can't read ${what} as a story yet.`,
    text,
    file,
  };
}

/** `parseDiagnostics` is internal to the compiler but present on every parsed file. */
interface ParsedSourceFile {
  parseDiagnostics?: readonly TS.DiagnosticWithLocation[];
}

function refuseOnSyntaxError(
  ts: TsModule,
  sourceFile: TS.SourceFile,
  file: string,
  text: string,
): StorylineRefusal | null {
  const diagnostics = (sourceFile as unknown as ParsedSourceFile).parseDiagnostics ?? [];
  const first = diagnostics[0];
  if (first === undefined) return null;
  const line = sourceFile.getLineAndCharacterOfPosition(first.start).line + 1;
  const message = ts.flattenDiagnosticMessageText(first.messageText, ' ').replace(/\.$/, '');
  return {
    ok: false,
    reason: 'syntax-error',
    sentence: `This file can't be read as a story yet: line ${line} doesn't parse (${message}).`,
    text,
    file,
  };
}

// ── The reader ───────────────────────────────────────────

type FunctionLike =
  | TS.FunctionDeclaration
  | TS.FunctionExpression
  | TS.ArrowFunction
  | TS.MethodDeclaration
  | TS.ConstructorDeclaration
  | TS.GetAccessorDeclaration
  | TS.SetAccessorDeclaration;

/** How a name entered the file through an import. */
interface ImportBinding {
  /** Project-relative target file; null for a package or an unresolvable path. */
  file: string | null;
  relative: boolean;
  /** The exported name (`default` for a default import); null for a namespace. */
  importedName: string | null;
}

interface PieceSource {
  piece: StorylinePiece;
  /** The node walked for type uses. */
  declaration: TS.Node;
  /** The body walked for calls (functions and methods only). */
  body: TS.Node | null;
}

class FileReader {
  readonly pieces: StorylinePiece[] = [];
  readonly calls: StorylineCall[] = [];
  readonly typeUses: StorylineTypeUse[] = [];
  readonly entries: StorylineEntry[] = [];
  readonly classes: StorylineClass[] = [];

  readonly #sources: PieceSource[] = [];
  readonly #topLevelFunctions = new Map<string, string>();
  readonly #dataStructures = new Map<string, string>();
  readonly #classMembers = new Map<string, Map<string, string>>();
  readonly #imports = new Map<string, ImportBinding>();
  readonly #exportedNames = new Set<string>();
  readonly #usedIds = new Set<string>();

  constructor(
    private readonly ts: TsModule,
    private readonly sourceFile: TS.SourceFile,
    private readonly file: string,
    private readonly fileExists: (relPath: string) => boolean,
  ) {}

  read(): void {
    this.#collectExportLists();
    for (const statement of this.sourceFile.statements) this.#readStatement(statement);
    for (const source of this.#sources) {
      this.#readCalls(source);
      this.#readTypeUses(source);
    }
    this.#readEntries();
  }

  // ── Exports and imports ──

  #collectExportLists(): void {
    const { ts } = this;
    for (const statement of this.sourceFile.statements) {
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined) {
        const clause = statement.exportClause;
        if (clause !== undefined && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            this.#exportedNames.add((element.propertyName ?? element.name).text);
          }
        }
      }
      if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
        this.#exportedNames.add(statement.expression.text);
      }
    }
  }

  #readImport(statement: TS.ImportDeclaration): void {
    const { ts } = this;
    const clause = statement.importClause;
    if (clause === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) return;
    const specifier = statement.moduleSpecifier.text;
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    const target = relative ? this.#resolveRelative(specifier) : null;
    if (clause.name !== undefined) {
      this.#imports.set(clause.name.text, { file: target, relative, importedName: 'default' });
    }
    const named = clause.namedBindings;
    if (named === undefined) return;
    if (ts.isNamespaceImport(named)) {
      this.#imports.set(named.name.text, { file: target, relative, importedName: null });
      return;
    }
    for (const element of named.elements) {
      this.#imports.set(element.name.text, {
        file: target,
        relative,
        importedName: (element.propertyName ?? element.name).text,
      });
    }
  }

  #resolveRelative(specifier: string): string | null {
    return resolveRelativeImport(this.file, specifier, this.fileExists);
  }

  // ── Pieces ──

  #readStatement(statement: TS.Statement): void {
    const { ts } = this;
    if (ts.isImportDeclaration(statement)) {
      this.#readImport(statement);
      return;
    }
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? 'default';
      const piece = this.#addPiece('function', name, statement, statement, this.#isExported(statement, name));
      this.#topLevelFunctions.set(name, piece.id);
      this.#pushSource(piece, statement, statement.body ?? null);
      return;
    }
    if (ts.isVariableStatement(statement)) {
      this.#readVariableStatement(statement);
      return;
    }
    if (ts.isClassDeclaration(statement)) {
      this.#readClass(statement);
      return;
    }
    if (ts.isInterfaceDeclaration(statement)) {
      this.#addDataStructure('interface', statement);
      return;
    }
    if (ts.isTypeAliasDeclaration(statement)) {
      this.#addDataStructure('type', statement);
      return;
    }
    if (ts.isEnumDeclaration(statement)) {
      this.#addDataStructure('enum', statement);
    }
  }

  #readVariableStatement(statement: TS.VariableStatement): void {
    const { ts } = this;
    const declarations = statement.declarationList.declarations;
    for (const declaration of declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const initializer = declaration.initializer;
      if (initializer === undefined) continue;
      if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) continue;
      const name = declaration.name.text;
      // A lone declaration spans its whole statement (`export const x = …`), so
      // the box shows what a reader sees; a shared list spans just its own part.
      const spanNode: TS.Node = declarations.length === 1 ? statement : declaration;
      const piece = this.#addPiece('function', name, spanNode, statement, this.#isExported(statement, name));
      this.#topLevelFunctions.set(name, piece.id);
      this.#pushSource(piece, spanNode, initializer.body);
    }
  }

  #readClass(node: TS.ClassDeclaration): void {
    const { ts } = this;
    const className = node.name?.text ?? 'default';
    const exported = this.#isExported(node, className);
    const classPiece = this.#addPiece('class', className, node, node, exported);
    this.#pushSource(classPiece, node, null);
    const members = new Map<string, string>();
    this.#classMembers.set(className, members);

    let constructorSignature: string | undefined;
    for (const member of node.members) {
      const method = this.#methodOf(member);
      if (method === null) continue;
      const isConstructor = ts.isConstructorDeclaration(member);
      const memberName = isConstructor ? 'constructor' : this.#memberName(member);
      if (memberName === null) continue;
      if (isConstructor) {
        const params = member.parameters.map((param) => collapse(param.getText(this.sourceFile))).join(', ');
        constructorSignature = `constructor(${params})`;
      }
      const piece = this.#addPiece('method', memberName, member, member, exported, {
        className,
        isConstructor,
      });
      if (!members.has(memberName)) members.set(memberName, piece.id);
      this.#pushSource(piece, member, method.body ?? null);
    }

    const startLine = this.#lineOf(node.getStart(this.sourceFile));
    this.classes.push(
      constructorSignature === undefined
        ? { name: className, file: this.file, startLine }
        : { name: className, file: this.file, startLine, constructorSignature },
    );
  }

  /** The callable a class member holds, or null for a plain field. */
  #methodOf(member: TS.ClassElement): FunctionLike | null {
    const { ts } = this;
    if (
      ts.isMethodDeclaration(member) ||
      ts.isConstructorDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      return member;
    }
    if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
      const initializer = member.initializer;
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer;
    }
    return null;
  }

  #memberName(member: TS.ClassElement): string | null {
    const { ts } = this;
    const name = member.name;
    if (name === undefined) return null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    return null;
  }

  #addDataStructure(
    kind: StorylinePieceKind,
    node: TS.InterfaceDeclaration | TS.TypeAliasDeclaration | TS.EnumDeclaration,
  ): void {
    const name = node.name.text;
    const piece = this.#addPiece(kind, name, node, node, this.#isExported(node, name));
    this.#dataStructures.set(name, piece.id);
    this.#pushSource(piece, node, null);
  }

  #addPiece(
    kind: StorylinePieceKind,
    name: string,
    spanNode: TS.Node,
    docNode: TS.Node,
    exported: boolean,
    method?: { className: string; isConstructor: boolean },
  ): StorylinePiece {
    const start = spanNode.getStart(this.sourceFile);
    const end = spanNode.getEnd();
    const baseId = method === undefined ? `${this.file}#${name}` : `${this.file}#${method.className}.${name}`;
    const piece: StorylinePiece = {
      id: this.#uniqueId(baseId),
      kind,
      name,
      file: this.file,
      startLine: this.#lineOf(start),
      endLine: this.#lineOf(end),
      doc: this.#docOf(docNode),
      text: this.sourceFile.text.slice(start, end),
      exported,
    };
    if (method !== undefined) {
      piece.className = method.className;
      if (method.isConstructor) piece.isConstructor = true;
    }
    this.pieces.push(piece);
    return piece;
  }

  /** A getter and a setter share a name; the second keeps its own id. */
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

  #pushSource(piece: StorylinePiece, declaration: TS.Node, body: TS.Node | null): void {
    this.#sources.push({ piece, declaration, body });
  }

  #isExported(node: TS.Node, name: string): boolean {
    const { ts } = this;
    const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
    return this.#exportedNames.has(name);
  }

  // ── Docs ──

  /** The first sentence of the comment directly above `node`, or null. */
  #docOf(node: TS.Node): string | null {
    const text = this.sourceFile.text;
    const start = node.getStart(this.sourceFile);
    const ranges = this.ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
    const last = ranges[ranges.length - 1];
    if (last === undefined || !isDirectlyAbove(text, last.end, start)) return null;

    if (last.kind === this.ts.SyntaxKind.MultiLineCommentTrivia) {
      const raw = text.slice(last.pos, last.end);
      if (!raw.startsWith('/**')) return null;
      return firstSentence(jsDocBody(raw));
    }
    // A `//` block: walk upwards while each line comment sits directly on the next.
    const block: string[] = [];
    let index = ranges.length - 1;
    let below = start;
    while (index >= 0) {
      const range = ranges[index];
      if (range === undefined || range.kind !== this.ts.SyntaxKind.SingleLineCommentTrivia) break;
      if (!isDirectlyAbove(text, range.end, below)) break;
      block.unshift(text.slice(range.pos + 2, range.end).trim());
      below = range.pos;
      index -= 1;
    }
    return firstSentence(block.join(' '));
  }

  // ── Calls ──

  #readCalls(source: PieceSource): void {
    if (source.body === null) return;
    const seen = new Set<string>();
    const visit = (node: TS.Node): void => {
      // A nested class is its own story, not this piece's.
      if (this.ts.isClassDeclaration(node) || this.ts.isClassExpression(node)) return;
      if (this.ts.isCallExpression(node)) this.#recordCall(source.piece, node, seen);
      this.ts.forEachChild(node, visit);
    };
    visit(source.body);
  }

  #recordCall(from: StorylinePiece, call: TS.CallExpression, seen: Set<string>): void {
    const resolved = this.#resolveCall(from, call.expression);
    if (resolved === null) return;
    const line = this.#lineOf(call.expression.getStart(this.sourceFile));
    const entry: StorylineCall = { from: from.id, line, to: resolved.to };
    if (resolved.external !== undefined) entry.external = resolved.external;
    if (resolved.unresolvedName !== undefined) entry.unresolvedName = resolved.unresolvedName;
    const key = JSON.stringify([entry.line, entry.to, entry.external, entry.unresolvedName]);
    if (seen.has(key)) return;
    seen.add(key);
    this.calls.push(entry);
  }

  /** What a call expression names, or null when it is not worth recording. */
  #resolveCall(
    from: StorylinePiece,
    callee: TS.Expression,
  ): Pick<StorylineCall, 'to' | 'external' | 'unresolvedName'> | null {
    const { ts } = this;
    if (ts.isIdentifier(callee)) return this.#resolveBareCall(callee.text);
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const memberName = callee.name.text;
    const receiver = callee.expression;

    if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
      if (from.className === undefined) return null;
      const target = this.#classMembers.get(from.className)?.get(memberName);
      if (target !== undefined) return { to: target };
      return { to: null, unresolvedName: `this.${memberName}` };
    }
    if (ts.isIdentifier(receiver)) {
      const binding = this.#imports.get(receiver.text);
      // Only a namespace import proves what `x.foo()` calls; a named import's
      // method could be anything.
      if (binding !== undefined && binding.importedName === null && binding.file !== null) {
        return { to: null, external: { file: binding.file, name: memberName } };
      }
    }
    return null;
  }

  #resolveBareCall(name: string): Pick<StorylineCall, 'to' | 'external' | 'unresolvedName'> | null {
    const local = this.#topLevelFunctions.get(name);
    if (local !== undefined) return { to: local };
    const binding = this.#imports.get(name);
    if (binding !== undefined) {
      if (!binding.relative) return null;
      if (binding.file !== null && binding.importedName !== null) {
        return { to: null, external: { file: binding.file, name: binding.importedName } };
      }
      return { to: null, unresolvedName: name };
    }
    if (BUILT_IN_CALLS.has(name)) return null;
    return { to: null, unresolvedName: name };
  }

  // ── Type uses ──

  #readTypeUses(source: PieceSource): void {
    const { ts } = this;
    const fromId = source.piece.id;
    const targets = new Set<string>();
    const isClass = source.piece.kind === 'class';
    const visit = (node: TS.Node): void => {
      // A class's methods carry their own type uses; the class keeps its
      // heritage and fields.
      if (isClass && node !== source.declaration && ts.isClassElement(node) && this.#methodOf(node) !== null) {
        return;
      }
      const named = this.#typeNameOf(node);
      if (named !== null) {
        const target = this.#dataStructures.get(named);
        if (target !== undefined && target !== fromId) targets.add(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(source.declaration);
    for (const to of targets) {
      if (!this.typeUses.some((use) => use.from === fromId && use.to === to)) {
        this.typeUses.push({ from: fromId, to });
      }
    }
  }

  /** The leftmost name a type position refers to, or null. */
  #typeNameOf(node: TS.Node): string | null {
    const { ts } = this;
    if (ts.isTypeReferenceNode(node)) return leftmostName(ts, node.typeName);
    if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) return node.expression.text;
    return null;
  }

  // ── Entries ──

  #readEntries(): void {
    const exportedClasses = new Set(
      this.pieces.filter((piece) => piece.kind === 'class' && piece.exported).map((piece) => piece.name),
    );
    for (const source of this.#sources) {
      const { piece } = source;
      if (!piece.exported) continue;
      if (piece.kind === 'function' || piece.kind === 'class') {
        this.entries.push({ pieceId: piece.id, usedFrom: 0 });
        continue;
      }
      if (piece.kind !== 'method' || piece.isConstructor === true) continue;
      if (piece.className === undefined || !exportedClasses.has(piece.className)) continue;
      if (!this.#isPublicMember(source.declaration)) continue;
      this.entries.push({ pieceId: piece.id, usedFrom: 0 });
    }
  }

  #isPublicMember(member: TS.Node): boolean {
    const { ts } = this;
    const name = (member as TS.ClassElement).name;
    if (name !== undefined && ts.isPrivateIdentifier(name)) return false;
    const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
    return !modifiers.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    );
  }

  #lineOf(position: number): number {
    return this.sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  }
}

// ── Helpers ──────────────────────────────────────────────

function leftmostName(ts: TsModule, name: TS.EntityName): string {
  let current: TS.EntityName = name;
  while (ts.isQualifiedName(current)) current = current.left;
  return current.text;
}

/** Runs of whitespace as one space — shared with the tree-sitter reader. */
export function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Nothing but whitespace, and no blank line, between a comment's end and what follows. */
function isDirectlyAbove(text: string, commentEnd: number, nextStart: number): boolean {
  const gap = text.slice(commentEnd, nextStart);
  if (gap.trim() !== '') return false;
  const lineBreaks = gap.split('\n').length - 1;
  return lineBreaks <= MAX_LINE_BREAKS_BETWEEN_DOC_AND_DECLARATION;
}

/** A `/** … *\/` comment's prose, without its stars or its `@tags`. */
function jsDocBody(raw: string): string {
  const inner = raw.slice('/**'.length, raw.length - '*/'.length);
  const lines = inner.split('\n').map((line) => line.replace(/^\s*\*?\s?/, ''));
  const tagAt = lines.findIndex((line) => line.trimStart().startsWith('@'));
  const prose = tagAt === -1 ? lines : lines.slice(0, tagAt);
  return prose.join(' ');
}

/** A doc's first sentence, capped — shared with the tree-sitter reader so every language's doc line reads alike. */
export function firstSentence(value: string): string | null {
  const text = collapse(value);
  if (text === '') return null;
  const stop = text.search(/[.!?](\s|$)/);
  const sentence = stop === -1 ? text : text.slice(0, stop + 1);
  if (sentence.length <= DOC_MAX_CHARS) return sentence;
  return `${sentence.slice(0, DOC_MAX_CHARS - 1).trimEnd()}…`;
}
