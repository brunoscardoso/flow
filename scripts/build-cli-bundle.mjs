// Bundle the planflow-ai CLI into the Flow IDE app so a packaged build derives
// blueprints (and runs init) out of the box — no npm, no PATH, no system node.
//
// Output: app/resources/cli/
//   planflow-ai.mjs   ESM bundle of src/cli (commander inlined; native/notifier
//                     deps kept external — they're lazy-loaded and not needed by
//                     the blueprint/init paths the IDE drives)
//   package.json      minimal { name: planflow-ai, type: module } so the CLI's
//                     findPackageRoot() resolves assets from THIS directory
//   .claude/ templates/ rules/ skills/   distributable assets `init` installs
//
// The app spawns it via ELECTRON_RUN_AS_NODE (the bundled Electron binary as
// Node) — the CLI is pure JS, so there is no native-ABI step. See
// app/src/main/blueprint/derive-runner.ts (the 'bundled' candidate) and
// electron-builder.yml (extraResources: resources/cli).

import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'app', 'resources', 'cli')

/** Native / binary-shipping deps the CLI lazy-loads — kept external so the
 *  bundle stays pure-JS. The blueprint + init paths never touch them.
 *
 *  `typescript` is external for size, not nativeness: `blueprint storyline`
 *  loads the compiler at run time, and the app hands it its OWN copy by path
 *  (FLOW_TYPESCRIPT_PATH). The require id in storyline-compiler.ts is already
 *  dynamic; naming it here makes "never inline ~9 MB of compiler" explicit.
 *
 *  `@vscode/tree-sitter-wasm` likewise (plan `story-any-language`): the
 *  runtime plus ~20 MB of grammars, read by path at run time — the app hands
 *  the CLI its own package directory (FLOW_TREESITTER_PATH). */
const EXTERNAL = ['better-sqlite3', 'node-pty', 'node-notifier', 'typescript', '@vscode/tree-sitter-wasm']

/**
 * Distributable asset dirs, copied to the same path inside the bundle.
 *
 * WHOLE DIRECTORIES, so a new `.claude/<subdir>` ships without anyone
 * remembering to add it here — an invariant `prompt-assets.test.ts` states in
 * its own name ("so new subdirectories ship for free") and which an allowlist
 * of the subdirectories known TODAY quietly breaks. It caught exactly that when
 * this listed them individually.
 *
 * `scripts/hooks` is here because it was MISSING: `init --refresh-owned` reads
 * hooks from that path in the CLI's package root (OWNED_ASSET_PATHS), and the
 * bundle never shipped it, so an IDE-managed project had nothing to refresh
 * from.
 */
const ASSET_DIRS = ['.claude', 'templates', 'scripts/hooks']

/**
 * Never descended into, wherever they appear — which is what makes copying
 * whole directories safe.
 *
 * `.claude/worktrees/` is the IDE's per-thread repo checkouts, and each one
 * links `node_modules` back to the repo root. With `dereference: true` that is
 * a cycle: cpSync walked it until the process died with a stack overflow —
 * Windows 0xC0000409, exit 3221226505, and not one line of output. The rule is
 * not "list the assets" but "never follow a link out of the tree you are
 * copying".
 */
const NEVER_COPY = new Set([
  'node_modules',
  '.git',
  'worktrees',
  // Gitignored and personal: one developer's permission allowlist, complete
  // with absolute paths under their home directory. Copying `.claude` whole is
  // what put it in a bundle every user installs — the price of shipping a
  // directory rather than a manifest, and the reason this list exists.
  'settings.local.json',
])

async function main() {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  await build({
    entryPoints: [join(repoRoot, 'src', 'cli', 'index.ts')],
    outfile: join(outDir, 'planflow-ai.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    external: EXTERNAL,
    // The CLI is ESM but bundled modules may `require()` — expose it under ESM.
    banner: {
      js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
    },
    logLevel: 'error',
  })

  for (const dir of ASSET_DIRS) {
    const segments = dir.split('/')
    const from = join(repoRoot, ...segments)
    if (!existsSync(from)) throw new Error(`missing distributable asset: ${dir}`)
    cpSync(from, join(outDir, ...segments), {
      recursive: true,
      dereference: true,
      filter: (src) => !NEVER_COPY.has(basename(src)),
    })
  }

  // A minimal package.json so the CLI's findPackageRoot() (walks up from the
  // bundle's dir) resolves the co-located assets as its package root. Written
  // AFTER the copy, because it carries a hash of what was copied.
  //
  // `assetsHash` IS HOW A SKILL EDIT REACHES A PROJECT. The IDE refreshes a
  // project's owned assets when its stamp differs from the bundle's, and the
  // stamp used to be the version alone — so every skill or command change made
  // without a version bump stayed in the bundle and never reached a project
  // already stamped at that version. Hashing the copied bytes makes the stamp
  // change exactly when the assets do.
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  writeFileSync(
    join(outDir, 'package.json'),
    JSON.stringify(
      { name: pkg.name, version: pkg.version, type: 'module', assetsHash: hashAssets(outDir, ASSET_DIRS) },
      null,
      2,
    ) + '\n',
  )

  console.log(`[build-cli-bundle] wrote ${outDir}`)
}

/** Hex length of the stamp's hash: short enough to read, long enough never to collide by accident. */
const ASSETS_HASH_LENGTH = 16

/**
 * A content hash of the copied asset trees: every file's relative path and
 * bytes, in sorted order, so the same assets always hash the same whatever the
 * filesystem's listing order.
 */
function hashAssets(root, dirs) {
  const files = []
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) files.push(child)
    }
  }
  for (const dir of dirs) walk(dir)
  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(join(root, ...file.split('/'))))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, ASSETS_HASH_LENGTH)
}

main().catch((error) => {
  console.error('[build-cli-bundle] failed:', error)
  process.exit(1)
})
