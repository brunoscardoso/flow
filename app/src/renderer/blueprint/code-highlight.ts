/**
 * SYNTAX FOR THE DRAWER'S CODE EXCERPT.
 *
 * The excerpt was drawn as one flat colour of monospace — the board's own ink
 * on the board's own card — so a TypeScript route handler read as a wall of
 * blue text. Every other place this app shows code (the peek drawer, the
 * editor tabs) is Monaco, which is already bundled, so the excerpt was the one
 * surface presenting code in a vocabulary the rest of the product does not use.
 *
 * `editor.colorize` RATHER THAN AN EDITOR. Monaco can tokenise a string to HTML
 * without instantiating anything: no model, no view, no worker, no disposal to
 * get wrong. A six-line excerpt does not need a text editor — it needs the same
 * colours as one.
 *
 * FAIL-SOFT, ALWAYS. Monaco loads lazily and its chunk is 7 MB; if the load
 * fails, or the language is one it does not know, the excerpt stays exactly as
 * it was — plain, correct, readable. Code that renders uncoloured is a
 * cosmetic loss; code that fails to render is the loss of the evidence the
 * section exists to show.
 */

/** The extension → Monaco language id map, and nothing else. */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  cs: 'csharp',
  php: 'php',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  prisma: 'graphql',
  graphql: 'graphql',
  gql: 'graphql',
}

/**
 * The Monaco language for a path, or `plaintext`.
 *
 * MATCHED ON THE EXTENSION ALONE. Guessing a language from the CONTENT is how
 * a JSON blob gets highlighted as JavaScript and a reader is told, in colour,
 * something the file never claimed. An unknown extension gets `plaintext`,
 * which colours nothing and lies about nothing.
 *
 * A dotfile with no extension (`.eslintrc`) has no dot to split on and is
 * plaintext too — its own name is not a language.
 */
export function languageForPath(path: string): string {
  const tail = path.slice(path.lastIndexOf('/') + 1)
  const dot = tail.lastIndexOf('.')
  if (dot <= 0) return 'plaintext'
  const ext = tail.slice(dot + 1).toLowerCase()
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext'
}
