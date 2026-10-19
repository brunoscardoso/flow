// File-type icons (VS Code Seti-inspired palette). DOM-free and pure so it's
// shared across surfaces that show file rows — the file tree AND the ⌘P
// command palette — and unit-testable under node-env jest.
//
// TWO SIGNALS, NOT ONE. Colour alone was doing all the work, and it cannot:
// .ts and .css are the same blue, .js and .json the same yellow, so a column
// of files read as one repeated glyph in four tints. The types people scan a
// tree FOR now carry a short monospace badge instead of the generic glyph —
// TS, JS, {} — the way Seti and the VS Code file-icon themes draw them.
//
// The badge set is deliberately small. Every entry has to be a spelling a
// developer already reads as that language with no legend: TS, JS, {} for
// JSON, MD, PY, SH, GO, RS, RB. Anything needing a squint (YM for yaml, CS for
// css) keeps the tinted glyph, because a badge nobody can decode is worse than
// no badge — it looks like information and is not.

export const DEFAULT_FILE_COLOR = 'var(--fl-color-text-secondary)'

/** Exact filenames that get their own color regardless of extension. */
const FILE_NAME_COLORS: Record<string, string> = {
  'package.json': '#8dc149',
  'package-lock.json': '#7a7a52',
  'tsconfig.json': '#519aba',
  dockerfile: '#519aba',
  '.gitignore': '#e37933',
  '.gitattributes': '#e37933',
  'readme.md': '#519aba',
  license: '#cbcb41',
  '.env': '#dbba7f',
  makefile: '#8dc149',
}

/** Extension → tint. Grouped by the language colors VS Code's Seti uses. */
const FILE_EXT_COLORS: Record<string, string> = {
  // TypeScript / JavaScript
  ts: '#519aba', tsx: '#519aba', mts: '#519aba', cts: '#519aba',
  js: '#cbcb41', jsx: '#cbcb41', mjs: '#cbcb41', cjs: '#cbcb41',
  // Data / config
  json: '#cbcb41', jsonc: '#cbcb41',
  yml: '#cbcb41', yaml: '#cbcb41',
  toml: '#9c9c9c', ini: '#6d8086', env: '#dbba7f', lock: '#7a7a52',
  // Web
  html: '#e37933', htm: '#e37933',
  css: '#519aba', scss: '#c56395', sass: '#c56395', less: '#519aba',
  vue: '#8dc149', svelte: '#e37933',
  // Languages
  py: '#519aba', rb: '#cc3e44', php: '#a074c4', go: '#519aba', rs: '#dea584',
  java: '#cc3e44', kt: '#519aba', kts: '#519aba', swift: '#e37933', scala: '#cc3e44',
  c: '#519aba', h: '#a074c4', cpp: '#519aba', cc: '#519aba', hpp: '#a074c4', cs: '#519aba',
  sh: '#8dc149', bash: '#8dc149', zsh: '#8dc149', fish: '#8dc149',
  sql: '#f55385', graphql: '#e10098', gql: '#e10098',
  // Docs
  md: '#519aba', markdown: '#519aba', mdx: '#519aba', txt: '#6d8086', rst: '#6d8086',
  // Images / assets
  png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4',
  webp: '#a074c4', ico: '#a074c4', bmp: '#a074c4', svg: '#cbcb41',
  pdf: '#cc3e44',
  // Shell/dotfiles handled by FILE_NAME_COLORS
}

/**
 * Extension → badge text. Two characters at most, so every badge occupies the
 * same 14px cell the glyph did and the names below stay in one column.
 */
const FILE_EXT_BADGES: Record<string, string> = {
  ts: 'TS', tsx: 'TS', mts: 'TS', cts: 'TS',
  js: 'JS', jsx: 'JS', mjs: 'JS', cjs: 'JS',
  json: '{}', jsonc: '{}',
  md: 'MD', mdx: 'MD', markdown: 'MD',
  py: 'PY', sh: 'SH', bash: 'SH', zsh: 'SH', fish: 'SH',
  go: 'GO', rs: 'RS', rb: 'RB',
}

/**
 * A file's badge text, or null when it should keep the generic glyph.
 *
 * Matched on the LAST extension only, which is what makes `next-env.d.ts` and
 * `jest.config.ts` both read TS — the compound suffix is part of the name, not
 * a different language.
 */
export function fileIconBadge(name: string): string | null {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return null // dotfiles and extensionless names keep the glyph
  return FILE_EXT_BADGES[lower.slice(dot + 1)] ?? null
}

/** A file's icon tint, matched by exact name first, then extension. */
export function fileIconColor(name: string): string {
  const lower = name.toLowerCase()
  const byName = FILE_NAME_COLORS[lower]
  if (byName) {
    return byName
  }
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) {
    return DEFAULT_FILE_COLOR // dotfiles / no extension
  }
  return FILE_EXT_COLORS[lower.slice(dot + 1)] ?? DEFAULT_FILE_COLOR
}
