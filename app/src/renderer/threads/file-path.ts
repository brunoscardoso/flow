// Pure file-reference detection — DOM-free so it unit-tests under the node test
// env (its consumer, markdown-renderer, pulls in `document`).

/** File extensions we treat a code span as a clickable file reference for. */
const FILE_EXT =
  /\.(tsx?|jsx?|mjs|cjs|md|mdx|json5?|jsonc|ya?ml|toml|ini|env|css|scss|less|html?|xml|svg|txt|csv|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|lua|dart|sh|bash|zsh|sql|vue|svelte|astro|gradle|proto|graphql|prisma|lock|cfg|conf)$/i

/**
 * Well-known `<Brand>.js` runtime/framework names (#656). Written BARE in
 * prose (`Node.js`, `Vue.js`) they're brands, not files — treating them as
 * file refs hands the user a clickable chip that can only error "File not
 * found". Lowercased stems (the part before `.js`); a real file reference to
 * one of these still matches when it carries a path (`vendor/three.js`).
 */
const KNOWN_JS_BRAND_STEMS = new Set([
  'node',
  'deno',
  'vue',
  'next',
  'nuxt',
  'react',
  'angular',
  'ember',
  'backbone',
  'three',
  'd3',
  'chart',
  'moment',
  'day',
  'express',
  'nest',
  'alpine',
  'preact',
  'knockout',
  'meteor',
  'discord',
  'p5',
  'anime',
  'video',
])

/**
 * Heuristic: does a code span name a file? Requires a recognized extension so
 * symbols like `window.opener`, `useAuth()`, or `MAX = 8192` are never matched.
 * URLs, directories, whitespace-bearing spans, and bare framework brand names
 * (`Node.js`, `Vue.js` — #656) are excluded.
 */
export function looksLikeFilePath(text: string): boolean {
  const value = text.trim()
  if (!value || value.length > 240) return false
  if (/\s/.test(value)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false // URLs (http://, file://…)
  if (value.endsWith('/')) return false // a directory, not a file
  if (!FILE_EXT.test(value)) return false
  if (!value.includes('/')) {
    const stem = /^(.+)\.js$/i.exec(value)
    if (stem && KNOWN_JS_BRAND_STEMS.has(stem[1].toLowerCase())) return false
  }
  return true
}

/**
 * Extensions the embedded browser is a better destination for than the editor.
 *
 * A GENERATED PAGE IS MEANT TO BE LOOKED AT. An agent that writes
 * `docs/playbook-output-contract.html` and says "open it directly in a browser"
 * is describing a rendered page; clicking the name gave a tab of `<!DOCTYPE
 * html>` instead (user, 2026-09-18). The source is still one modifier away —
 * the point is which one is the DEFAULT.
 *
 * Deliberately short. Markdown has a preview of its own, SVG and images have
 * viewers, and a list that grew to "anything a browser can display" would start
 * taking files people open to edit.
 */
const BROWSABLE_EXTENSIONS = ['.html', '.htm']

/** Whether clicking this path should open the embedded browser. */
export function opensInBrowser(path: string): boolean {
  const clean = path.trim().split(/[?#]/)[0] ?? ''
  const lower = clean.toLowerCase()
  return BROWSABLE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * A `file://` URL for a path inside a project, for the browser to load.
 *
 * ENCODED SEGMENT BY SEGMENT. A project path holds spaces, `#` and `?` on real
 * machines, and every one of them means something else in a URL — a folder
 * called `design #2` would truncate at the `#` and load the parent directory.
 * The separators must survive, so this encodes the parts and not the joins.
 */
export function fileUrl(rootPath: string, relPath: string): string {
  const root = rootPath.replace(/\/+$/, '')
  const rel = relPath.replace(/^\/+/, '')
  const encode = (part: string): string => part.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  const absolute = `${encode(root)}/${encode(rel)}`
  return `file:///${absolute}`
}
