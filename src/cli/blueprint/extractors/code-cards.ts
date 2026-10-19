/**
 * Code-card extractor (brain-first-retrieval Phase 1) — the EAGER per-file
 * code-knowledge layer. Over `walkRepo`'s file list it extracts, per code
 * file, the top-level symbols, the import specifiers, and a mechanical
 * one-liner — zero model calls, syntactic regex heuristics like every native
 * extractor. TWO outputs (eager structure, tiered semantics — pattern #13):
 *
 * 1. **Code cards** (semantic layer): one deterministic markdown card per
 *    module at `flow/brain/code/<module-slug>.md` — frontmatter
 *    (`type: code`, `module: <dir>`), then one H2 section per member file
 *    with the one-liner, a symbols list, an imports line, and the file's
 *    content hash. They are part of the searched markdown corpus; per-file H2
 *    sections give the chunker per-file chunks.
 * 2. **Symbol sidecar** (structural layer):
 *    `flow/brain/.structure/symbols.jsonl` — one JSON row per symbol for
 *    exact/prefix NAME lookup with no embeddings.
 *
 * Both outputs are DERIVED/DISPOSABLE — rebuilt by derive, deletable at zero
 * cost. Hash-gated through `hashFileContent` (the ONE hashing algorithm,
 * allowed-pattern #14 — same digest `hashRepoFile` produces): each card
 * records its member files' hashes, and a file whose current hash matches
 * its recorded card hash is REUSED from the parsed card instead of re-read
 * and re-extracted — the card is its own cache. A stamp hint whose stat
 * still matches can prove the hash without any read (see
 * `EmitCodeCardsOptions.stampHints`). Cards are rewritten only when their
 * rendered bytes change, so an unchanged repo regenerates nothing. The
 * sidecar file is rewritten in full (atomically, temp+rename) but from
 * cached extraction wherever hashes match.
 *
 * Symbol heuristics are line-anchored (`^…` per line) and doc examples in
 * THIS file stay inside ` * `-prefixed comment lines, so the extractor can
 * never match its own documentation (forbidden-pattern #9) — e.g. a line
 * like ` * «exportKW» function name(…)` is placeholder syntax, not code.
 *
 * Deterministic: sorted files, line-ordered symbols, sorted-unique imports —
 * byte-identical output for identical inputs. Fail-soft: unreadable files
 * are skipped and counted; the derive caller wraps the whole pass.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashFileContent, statRepoFile, type RepoFileHashHint } from '../store.js';
import { MODULE_TREE_DEPTH_CAP } from './modules.js';
import { discoverSpineRoots, isCodeFile, readFileBytesSafe, readFileSafe, walkRepo, type RepoScan } from './scan.js';

/** Directory (under `flow/`) holding the per-module code cards. */
export const CODE_CARDS_DIRNAME = join('brain', 'code');

/** Sidecar filename (under `flow/brain/.structure/`). */
export const SYMBOLS_FILENAME = 'symbols.jsonl';

/** Display path of the cards directory in coverage notes. */
const CODE_CARDS_DISPLAY_PATH = 'flow/brain/code/';

/** Display path of the symbol sidecar in coverage notes. */
const SYMBOLS_DISPLAY_PATH = 'flow/brain/.structure/symbols.jsonl';

/** One-liners are single lines — hard cap so a card line stays a line. */
const ONE_LINER_MAX_CHARS = 200;

/** Symbol names shown in a fallback `exports:` one-liner. */
const ONE_LINER_SYMBOL_CAP = 3;

/** The symbol kinds the heuristics can produce. */
export type CodeSymbolKind =
  | 'function'
  | 'class'
  | 'const'
  | 'let'
  | 'var'
  | 'interface'
  | 'type'
  | 'enum'
  | 'default';

/** One extracted top-level symbol. */
export interface CodeSymbol {
  name: string;
  kind: CodeSymbolKind;
  /** 1-based line of the declaration. */
  line: number;
}

/** Everything extracted (or cached) for one code file. */
export interface FileFacts {
  /** Repo-relative posix path. */
  path: string;
  /** Language tag derived from the extension (`typescript`, `python`, …). */
  language: string;
  /** Mechanical one-liner — first doc line, else `exports: …`, else ''. */
  oneLiner: string;
  symbols: CodeSymbol[];
  /** Sorted-unique raw import specifiers (no alias resolution — search fodder). */
  imports: string[];
  /** SHA-256 content hash via `hashRepoFile` — the gate and the cache key. */
  hash: string;
}

/** One row of `symbols.jsonl`. */
export interface SymbolRow {
  name: string;
  kind: CodeSymbolKind;
  path: string;
  line: number;
  language: string;
  fileHash: string;
}

/**
 * Import/require specifiers — mirrors `IMPORT_SPECIFIER_PATTERN` in
 * `modules.ts` (raw specifiers are enough for search; no alias resolution).
 */
const TS_IMPORT_SPECIFIER_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)[`'"]([^`'"]+)[`'"]/g;

/** Python imports, line-anchored: `import a.b` / `from a.b import x`. */
const PY_IMPORT_PATTERN = /^(?:from\s+([.\w]+)\s+import\b|import\s+([.\w]+(?:\s*,\s*[.\w]+)*))/;

/**
 * TS/JS top-level symbol patterns, checked per line IN ORDER (first match
 * wins). All anchored at column 0 so only real top-level declarations match
 * — a specifier inside an indented or ` * `-prefixed comment line never
 * does. `enum` is checked before `const` so a const-enum line is not read
 * as a const named "enum".
 */
const TS_SYMBOL_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: CodeSymbolKind }> = [
  { pattern: /^export\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?/, kind: 'function' },
  { pattern: /^export\s+default\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)?/, kind: 'class' },
  { pattern: /^export\s+default\b()/, kind: 'default' },
  { pattern: /^export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { pattern: /^export\s+type\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { pattern: /^export\s+(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  { pattern: /^export\s+(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { pattern: /^export\s+(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { pattern: /^export\s+(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)/, kind: 'const' },
  { pattern: /^export\s+(?:declare\s+)?let\s+([A-Za-z_$][\w$]*)/, kind: 'let' },
  { pattern: /^export\s+(?:declare\s+)?var\s+([A-Za-z_$][\w$]*)/, kind: 'var' },
  { pattern: /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { pattern: /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
];

/** Python top-level symbols, checked per line (column-0 anchored). */
const PY_SYMBOL_PATTERNS: ReadonlyArray<{ pattern: RegExp; kind: CodeSymbolKind }> = [
  { pattern: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
  { pattern: /^class\s+([A-Za-z_]\w*)/, kind: 'class' },
];

/** Extension → language tag for symbol rows and cards. */
export function languageOf(relPath: string): string {
  const lowered = relPath.toLowerCase();
  if (/\.tsx?$/.test(lowered)) return 'typescript';
  if (/\.(?:jsx?|mjs|cjs)$/.test(lowered)) return 'javascript';
  if (/\.pyi?$/.test(lowered)) return 'python';
  const dot = lowered.lastIndexOf('.');
  return dot === -1 ? 'other' : lowered.slice(dot + 1);
}

/** Whether a language tag gets TS/JS symbol + import heuristics. */
function isTsJsLanguage(language: string): boolean {
  return language === 'typescript' || language === 'javascript';
}

/**
 * Clamp a candidate one-liner to a single trimmed, capped line, sanitized so
 * it can never collide with the card's own markup: leading markdown heading /
 * list markers are stripped (a doc line starting `## …` would otherwise split
 * the card's H2 sections), and a leading reserved token (`symbols:` /
 * `imports:` / `hash:`) is defused so the cache parser round-trips exactly.
 */
function clampOneLiner(text: string): string {
  let single = text
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^(symbols|imports|hash):/, '$1 —')
    .trim();
  if (single.length > ONE_LINER_MAX_CHARS) {
    single = `${single.slice(0, ONE_LINER_MAX_CHARS - 1)}…`;
  }
  return single;
}

/**
 * First doc-comment line of a TS/JS file: the first non-empty text inside a
 * leading block comment, or the text of a leading line comment. Shebang
 * lines are skipped. Returns '' when the file has no leading comment.
 */
function tsJsDocFirstLine(lines: string[]): string {
  let index = 0;
  while (index < lines.length && (lines[index].trim() === '' || lines[index].startsWith('#!'))) {
    index += 1;
  }
  if (index >= lines.length) {
    return '';
  }
  const first = lines[index].trim();
  if (first.startsWith('/*')) {
    for (; index < lines.length; index += 1) {
      const text = lines[index]
        .replace(/^\s*\/\*+/, '')
        .replace(/\*+\/\s*$/, '')
        .replace(/^\s*\*+\s?/, '')
        .trim();
      if (text !== '') {
        return clampOneLiner(text);
      }
      if (lines[index].includes('*/')) {
        break;
      }
    }
    return '';
  }
  if (first.startsWith('//')) {
    return clampOneLiner(first.replace(/^\/\/+\s?/, ''));
  }
  return '';
}

/**
 * First line of a Python module docstring: the first statement must open a
 * triple-quoted string (optional r/b/u/f prefixes). Comment and blank lines
 * before it are skipped. Returns '' when there is no module docstring.
 */
function pythonDocFirstLine(lines: string[]): string {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^[rbuf]{0,2}("""|''')(.*)$/i.exec(trimmed);
    if (match === null) {
      return '';
    }
    const closer = match[1];
    const rest = match[2];
    const end = rest.indexOf(closer);
    return clampOneLiner(end === -1 ? rest : rest.slice(0, end));
  }
  return '';
}

/** Extract TS/JS top-level symbols with a light block-comment tracker. */
function extractTsJsSymbols(lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  let inBlockComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (inBlockComment) {
      if (line.includes('*/')) {
        inBlockComment = false;
      }
      continue;
    }
    for (const { pattern, kind } of TS_SYMBOL_PATTERNS) {
      const match = pattern.exec(line);
      if (match !== null) {
        const name = match[1] !== undefined && match[1] !== '' ? match[1] : 'default';
        symbols.push({ name, kind, line: index + 1 });
        break;
      }
    }
    // A block comment that opens on this line and does not close swallows
    // the following lines until its terminator.
    const withoutLineComment = line.split('//')[0];
    const lastOpen = withoutLineComment.lastIndexOf('/*');
    if (lastOpen !== -1 && withoutLineComment.indexOf('*/', lastOpen) === -1) {
      inBlockComment = true;
    }
  }
  return symbols;
}

/** Extract Python top-level symbols (column-0 def/class). */
function extractPythonSymbols(lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    for (const { pattern, kind } of PY_SYMBOL_PATTERNS) {
      const match = pattern.exec(lines[index]);
      if (match !== null) {
        symbols.push({ name: match[1], kind, line: index + 1 });
        break;
      }
    }
  }
  return symbols;
}

/** Sorted-unique TS/JS import specifiers. */
function extractTsJsImports(content: string): string[] {
  const specifiers = new Set<string>();
  for (const match of content.matchAll(TS_IMPORT_SPECIFIER_PATTERN)) {
    specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

/** Sorted-unique Python import module names. */
function extractPythonImports(lines: string[]): string[] {
  const specifiers = new Set<string>();
  for (const line of lines) {
    const match = PY_IMPORT_PATTERN.exec(line);
    if (match === null) {
      continue;
    }
    if (match[1] !== undefined) {
      specifiers.add(match[1]);
    } else if (match[2] !== undefined) {
      for (const name of match[2].split(',')) {
        const trimmed = name.trim();
        if (trimmed !== '') {
          specifiers.add(trimmed);
        }
      }
    }
  }
  return [...specifiers].sort();
}

/**
 * Extract the facts for one file — PURE (no filesystem, no hash): symbols,
 * imports, and the mechanical one-liner. Languages without heuristics get an
 * empty symbol/import set (the file still gets its card map entry).
 */
export function extractFileFacts(relPath: string, content: string): Omit<FileFacts, 'hash'> {
  const language = languageOf(relPath);
  const lines = content.split('\n');

  let symbols: CodeSymbol[] = [];
  let imports: string[] = [];
  let docLine = '';
  if (isTsJsLanguage(language)) {
    symbols = extractTsJsSymbols(lines);
    imports = extractTsJsImports(content);
    docLine = tsJsDocFirstLine(lines);
  } else if (language === 'python') {
    symbols = extractPythonSymbols(lines);
    imports = extractPythonImports(lines);
    docLine = pythonDocFirstLine(lines);
  }

  let oneLiner = docLine;
  if (oneLiner === '' && symbols.length > 0) {
    oneLiner = `exports: ${symbols.slice(0, ONE_LINER_SYMBOL_CAP).map((symbol) => symbol.name).join(', ')}`;
  }

  return { path: relPath, language, oneLiner, symbols, imports };
}

/**
 * Card filename slug for a module directory — mirrors the
 * `flow/brain/modules/<slug>.md` convention (progressive-learning):
 * the URL-safe module path, `/` → `-` (e.g. `src-cli-blueprint`).
 */
export function moduleSlugOf(moduleDir: string): string {
  return moduleDir.replace(/\//g, '-');
}

/** Render one file's card section (see `renderModuleCard` for the format). */
function renderFileSection(facts: FileFacts): string {
  const lines: string[] = [`## ${facts.path}`, ''];
  if (facts.oneLiner !== '') {
    lines.push(facts.oneLiner, '');
  }
  if (facts.symbols.length === 0) {
    lines.push('symbols: none', '');
  } else {
    lines.push('symbols:');
    for (const symbol of facts.symbols) {
      lines.push(`- ${symbol.name} (${symbol.kind}) — line ${symbol.line}`);
    }
    lines.push('');
  }
  lines.push(facts.imports.length === 0 ? 'imports: none' : `imports: ${facts.imports.join(', ')}`, '');
  lines.push(`hash: ${facts.hash}`, '');
  return lines.join('\n');
}

/**
 * Render a module's code card: frontmatter + one H2 section per member file,
 * files sorted by path. Deterministic — byte-identical for identical facts.
 */
export function renderModuleCard(moduleDir: string, allFacts: FileFacts[]): string {
  const sorted = [...allFacts].sort((a, b) => a.path.localeCompare(b.path));
  const parts = [`---\ntype: code\nmodule: ${moduleDir}\n---\n`];
  for (const facts of sorted) {
    parts.push(renderFileSection(facts));
  }
  return parts.join('\n');
}

/** Symbol list line inside a card: name (kind) — line N. */
const CARD_SYMBOL_LINE_PATTERN = /^- (.+) \(([a-z]+)\) — line (\d+)$/;

/**
 * Parse a previously written card back into per-file facts — the card IS the
 * hash-gate cache, so an unchanged file is never re-read or re-parsed.
 * Tolerant: a section that fails to parse is simply omitted (its file then
 * re-extracts — fail-soft toward correctness).
 */
export function parseModuleCard(content: string): Map<string, FileFacts> {
  const cache = new Map<string, FileFacts>();
  const sections = content.split(/^## /m).slice(1);
  for (const section of sections) {
    const lines = section.split('\n');
    const path = lines[0]?.trim() ?? '';
    const hashLine = lines.find((line) => line.startsWith('hash: '));
    const importsLine = lines.find((line) => line.startsWith('imports:'));
    if (path === '' || hashLine === undefined || importsLine === undefined) {
      continue;
    }
    const hash = hashLine.slice('hash: '.length).trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      continue;
    }

    const symbols: CodeSymbol[] = [];
    let symbolsValid = true;
    const symbolsStart = lines.findIndex((line) => line === 'symbols:');
    if (symbolsStart !== -1) {
      for (let index = symbolsStart + 1; index < lines.length && lines[index].startsWith('- '); index += 1) {
        const match = CARD_SYMBOL_LINE_PATTERN.exec(lines[index]);
        if (match === null) {
          symbolsValid = false;
          break;
        }
        symbols.push({ name: match[1], kind: match[2] as CodeSymbolKind, line: Number(match[3]) });
      }
    }
    if (!symbolsValid) {
      continue;
    }

    const importsRaw = importsLine.slice('imports:'.length).trim();
    const imports = importsRaw === 'none' || importsRaw === ''
      ? []
      : importsRaw.split(', ').map((specifier) => specifier.trim()).filter((specifier) => specifier !== '');

    // The one-liner is the first non-empty line between the path and the
    // symbols/imports block (absent when the file had none).
    let oneLiner = '';
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === 'symbols:' || line.startsWith('symbols: ') || line.startsWith('imports:')) {
        break;
      }
      if (line.trim() !== '') {
        oneLiner = line.trim();
        break;
      }
    }

    cache.set(path, { path, language: languageOf(path), oneLiner, symbols, imports, hash });
  }
  return cache;
}

/**
 * The capped OWNER module of a file: the last element of its depth-capped
 * module chain (mirrors `moduleChainOf` + the cap in `modules.ts`, so card
 * grouping matches the graph's rollup exactly). Null outside every root.
 */
function ownerModuleOf(relPath: string, spineRoots: string[]): string | null {
  const root = spineRoots.find((candidate) => relPath.startsWith(`${candidate}/`));
  if (root === undefined) {
    return null;
  }
  const chain: string[] = [root];
  const relSegments = relPath.slice(root.length + 1).split('/');
  for (let end = 1; end < relSegments.length; end += 1) {
    chain.push(`${root}/${relSegments.slice(0, end).join('/')}`);
  }
  const capped = chain.slice(0, MODULE_TREE_DEPTH_CAP);
  return capped[capped.length - 1];
}

/** Serialize the symbol rows for `symbols.jsonl` (deterministic order). */
function renderSymbolRows(allFacts: FileFacts[]): { content: string; count: number } {
  const rows: SymbolRow[] = [];
  for (const facts of allFacts) {
    for (const symbol of facts.symbols) {
      rows.push({
        name: symbol.name,
        kind: symbol.kind,
        path: facts.path,
        line: symbol.line,
        language: facts.language,
        fileHash: facts.hash,
      });
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name));
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  return { content: content === '' ? '' : `${content}\n`, count: rows.length };
}

/** Optional perf inputs for `emitCodeCards` — see the function doc. */
export interface EmitCodeCardsOptions {
  /** Pre-computed `walkRepo` result — derive walks ONCE and threads it here. */
  repoScan?: RepoScan;
  /**
   * Stored-hash hints by repo-relative path (the drift baseline's stamps,
   * `file-stamps.json`): a file whose CURRENT stat matches its hint's
   * recorded mtime+size may reuse the hint's stored hash without a read
   * (forbidden-pattern #10 discipline — any mismatch or missing hint reads
   * and hashes the content, which stays the truth).
   */
  stampHints?: ReadonlyMap<string, RepoFileHashHint>;
}

/**
 * Emit the code cards + the symbol sidecar for a repo. Called by derive
 * after the graph build; returns coverage notes (never throws for per-file
 * problems — unreadable files are counted; the caller additionally wraps the
 * whole pass fail-soft). Cards are written only when their bytes changed;
 * the sidecar is rewritten atomically (unique temp name + rename).
 *
 * Per file, cheapest sufficient evidence wins: a stat match against a stamp
 * hint whose stored hash matches the card's cached hash reuses the cached
 * facts with ZERO reads; otherwise the file is read ONCE — the same bytes
 * are hashed (`hashFileContent`, the one hashing algorithm) and, when the
 * hash misses the card cache, decoded and re-extracted.
 */
export function emitCodeCards(
  repoRoot: string,
  flowDir: string,
  options: EmitCodeCardsOptions = {},
): string[] {
  const scan = options.repoScan ?? walkRepo(repoRoot);
  const stampHints = options.stampHints;
  const spineRoots = discoverSpineRoots(repoRoot, scan);
  const codeFiles = scan.files.filter(isCodeFile);

  const filesByModule = new Map<string, string[]>();
  let outsideSpineRoots = 0;
  for (const relPath of codeFiles) {
    const owner = ownerModuleOf(relPath, spineRoots);
    if (owner === null) {
      outsideSpineRoots += 1;
      continue;
    }
    const bucket = filesByModule.get(owner);
    if (bucket === undefined) {
      filesByModule.set(owner, [relPath]);
    } else {
      bucket.push(relPath);
    }
  }

  const cardsDir = join(flowDir, CODE_CARDS_DIRNAME);
  mkdirSync(cardsDir, { recursive: true });

  let reusedFiles = 0;
  let extractedFiles = 0;
  let unreadableFiles = 0;
  let cardsRewritten = 0;
  let cardsUnchanged = 0;
  const allFacts: FileFacts[] = [];
  const liveCardNames = new Set<string>();

  for (const moduleDir of [...filesByModule.keys()].sort()) {
    const cardName = `${moduleSlugOf(moduleDir)}.md`;
    liveCardNames.add(cardName);
    const cardPath = join(cardsDir, cardName);
    const existing = existsSync(cardPath) ? readFileSafe(cardPath) : null;
    const cache = existing === null ? new Map<string, FileFacts>() : parseModuleCard(existing);

    const moduleFacts: FileFacts[] = [];
    for (const relPath of (filesByModule.get(moduleDir) as string[]).sort()) {
      // Stat pre-filter (forbidden-pattern #10 discipline): mtime+size may
      // only short-circuit toward the STAMP'S OWN stored hash, and only when
      // both match its recorded hints AND that hash matches the card cache —
      // then the cached facts are reused with no read at all. Any mismatch
      // or missing hint falls through to the content read below.
      const hint = stampHints?.get(relPath);
      const cached = cache.get(relPath);
      if (
        hint !== undefined &&
        typeof hint.mtimeMs === 'number' &&
        typeof hint.size === 'number' &&
        cached !== undefined &&
        cached.hash === hint.contentHash
      ) {
        const stat = statRepoFile(repoRoot, relPath);
        if (stat.status === 'ok' && stat.mtimeMs === hint.mtimeMs && stat.size === hint.size) {
          moduleFacts.push(cached);
          reusedFiles += 1;
          continue;
        }
      }

      // Single read: hash the same bytes that feed extraction — content is
      // the truth, and the file is never read twice.
      const bytes = readFileBytesSafe(join(repoRoot, relPath));
      if (bytes === null) {
        unreadableFiles += 1;
        continue;
      }
      const contentHash = hashFileContent(bytes);
      if (cached !== undefined && cached.hash === contentHash) {
        moduleFacts.push(cached);
        reusedFiles += 1;
        continue;
      }
      moduleFacts.push({ ...extractFileFacts(relPath, bytes.toString('utf-8')), hash: contentHash });
      extractedFiles += 1;
    }

    const rendered = renderModuleCard(moduleDir, moduleFacts);
    if (existing === rendered) {
      cardsUnchanged += 1;
    } else {
      writeFileSync(cardPath, rendered, 'utf-8');
      cardsRewritten += 1;
    }
    allFacts.push(...moduleFacts);
  }

  // Cards whose module vanished from the spine are stale derived artifacts —
  // remove them so a search can never surface a dead module's card.
  let cardsRemoved = 0;
  for (const staleName of listStaleCards(cardsDir, liveCardNames)) {
    try {
      rmSync(join(cardsDir, staleName));
      cardsRemoved += 1;
    } catch {
      // Fail-soft: a stale card that cannot be removed is regenerated over
      // or removed on a later derive — never fails the pass.
    }
  }

  // Symbol sidecar — full rewrite from (mostly cached) extraction, atomic so
  // a concurrent reader never observes a partial file.
  const { content: symbolContent, count: symbolCount } = renderSymbolRows(allFacts);
  const structureDir = join(flowDir, 'brain', '.structure');
  mkdirSync(structureDir, { recursive: true });
  const tempPath = join(
    structureDir,
    `${SYMBOLS_FILENAME}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`,
  );
  writeFileSync(tempPath, symbolContent, 'utf-8');
  renameSync(tempPath, join(structureDir, SYMBOLS_FILENAME));

  const notes = [
    `code-cards: ${filesByModule.size} card(s) → ${CODE_CARDS_DISPLAY_PATH} (${cardsRewritten} rewritten, ${cardsUnchanged} unchanged), ${symbolCount} symbol(s) → ${SYMBOLS_DISPLAY_PATH}`,
    `code-cards: ${extractedFiles} file(s) extracted, ${reusedFiles} reused from cache`,
  ];
  if (cardsRemoved > 0) {
    notes.push(`code-cards: ${cardsRemoved} stale card(s) removed`);
  }
  if (outsideSpineRoots > 0) {
    notes.push(`code-cards: ${outsideSpineRoots} code file(s) outside spine roots skipped`);
  }
  if (unreadableFiles > 0) {
    notes.push(`code-cards: ${unreadableFiles} unreadable file(s) skipped`);
  }
  return notes;
}

/** Card filenames present on disk but no longer produced by this derive. */
function listStaleCards(cardsDir: string, liveCardNames: Set<string>): string[] {
  try {
    return readdirSync(cardsDir).filter(
      (name) => name.endsWith('.md') && !liveCardNames.has(name),
    );
  } catch {
    return [];
  }
}
