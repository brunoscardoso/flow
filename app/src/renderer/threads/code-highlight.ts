/**
 * Syntax colour for the chat's fenced code blocks.
 *
 * Reported 2026-09-09 with a side-by-side: our code blocks render as one flat
 * colour while the reference shows keywords, strings and types apart. A wall of
 * monochrome code is the same failure as a wall of tool cards — everything is
 * present and nothing stands out.
 *
 * THE TOKENIZER IS ALREADY IN THE APP. Monaco ships with this Electron build
 * for the editor, and it already knows every language a fence is likely to
 * name. Adding a second highlighter would mean a second grammar for the same
 * languages, a second set of colours, and two answers to "what colour is a
 * TypeScript keyword" — so this asks Monaco, through the same
 * `EditorApi.monaco()` door the editor uses. That door is dynamic-import-only
 * by rule, and nothing here breaks it: the import happens on the first fence
 * that names a language, never at module load, so a session that only ever
 * reads prose pays nothing.
 *
 * NO innerHTML. Monaco offers `colorize()`, which returns an HTML string and
 * would be one assignment — and `code-highlight-view.ts` builds spans with
 * `textContent` instead, because the markdown renderer's stated invariant is
 * that everything is parsed safely through text nodes. `tokenize()` returns
 * offsets, which is all a span needs, and keeps that invariant whole.
 *
 * THIS FILE HOLDS THE DECISIONS AND NO DOM. The app's jest runs
 * `testEnvironment: 'node'` with no DOM lib, so a module that so much as names
 * `HTMLElement` cannot be imported by a test. Everything that can be WRONG —
 * which language a fence means, which scope earns a class, where one token
 * ends and the next begins — lives here where it is checkable; the painting
 * and the Monaco call live in the view beside it.
 *
 * THE COLOURS ARE THE EDITOR'S. `monaco-themes.ts` already maps token scopes to
 * VS Code Dark+ / Light+ values for both modes; the CSS below is those same
 * values under the app's `data-theme` switch, so a snippet in the chat and the
 * same code in a tab are the same colour rather than two dialects of it.
 */
/** Fence tag → Monaco language id, for the tags people actually type. */
const LANGUAGE_IDS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  python: 'python',
  rb: 'ruby',
  ruby: 'ruby',
  go: 'go',
  rs: 'rust',
  rust: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
}

/**
 * The Monaco language for a fence tag, or null when we should leave it alone.
 *
 * An unknown tag is NOT a reason to guess. `diff`, `text`, a made-up word, or
 * no tag at all render exactly as they do today — plain, and correct — because
 * highlighting the wrong grammar is worse than not highlighting: it colours
 * arbitrary words and tells the reader something untrue about the code.
 */
export function monacoLanguageFor(fenceTag: string): string | null {
  return LANGUAGE_IDS[fenceTag.trim().toLowerCase()] ?? null
}

/**
 * The CSS class for one Monaco token type.
 *
 * Monaco's scopes are dotted and language-suffixed — `keyword.ts`,
 * `string.quote.js`, `type.identifier.ts`. The FIRST segment carries the part
 * a reader distinguishes by, so that is what becomes the class; everything
 * finer collapses into it rather than growing a rule per language per scope.
 * An empty type (plain text between tokens) gets no class and no span.
 */
export function tokenClass(monacoType: string): string | null {
  const head = monacoType.split('.')[0]?.trim() ?? ''
  if (head === '' || head === 'source' || head === 'identifier' || head === 'white') return null
  return `fl-tok-${head}`
}

/**
 * One run of source text and the class it should wear — the whole decision,
 * with no DOM in it.
 *
 * SEPARATE FROM THE PAINTING because the app's jest runs `testEnvironment:
 * 'node'` with no DOM lib, so a test that touches `document` does not compile.
 * The part that can be wrong — offsets, line joins, which runs get a class —
 * is therefore all here, where it is checkable; `paintTokens` below is the
 * mechanical half that turns this list into nodes.
 */
export interface CodeSpan {
  text: string
  className: string | null
}

/**
 * Cut the source into classified runs.
 *
 * The property that must never break: concatenating every `text` reproduces
 * `body` exactly. Colour is presentation, and a highlighter that drops or
 * reorders a character has corrupted the code somebody is about to copy.
 */
export function planCodeSpans(
  body: string,
  lines: ReadonlyArray<ReadonlyArray<{ offset: number; type: string }>>,
): CodeSpan[] {
  const spans: CodeSpan[] = []
  const push = (text: string, className: string | null): void => {
    if (text === '') return
    spans.push({ text, className })
  }
  body.split('\n').forEach((lineText, index) => {
    if (index > 0) push('\n', null)
    const tokens = lines[index]
    if (tokens === undefined || tokens.length === 0) {
      push(lineText, null)
      return
    }
    // A token that starts past 0 leaves a gap the tokenizer did not claim.
    push(lineText.slice(0, tokens[0]?.offset ?? 0), null)
    tokens.forEach((token, tokenIndex) => {
      const end = tokens[tokenIndex + 1]?.offset ?? lineText.length
      push(lineText.slice(token.offset, end), tokenClass(token.type))
    })
  })
  return spans
}

