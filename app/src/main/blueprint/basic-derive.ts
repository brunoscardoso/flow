// Basic blueprint derivation — the NEVER-DEAD-END fallback. When the full
// `planflow-ai blueprint derive` fails (or no CLI is resolvable at all),
// main generates a BASIC graph itself from cheap project signals: the
// nested source-folder tree (same shape as the CLI's folder spine — module
// nodes + `contains` edges), and a curated SDK/datastore map over
// package.json. No CLI, no parsing of source files — well under 200ms.
//
// The result is IN-MEMORY ONLY: it is never written to flow/.blueprint/
// (the CLI-derived graph.json on disk stays the single source of truth).
// It is served exclusively through the `blueprint:readBasic` channel, which
// the renderer calls only after a failed derive — and the graph carries
// `basic: true` so the view can show its fallback banner. A later full
// derive lands on disk, blueprint:changed fires, and the basic graph is
// simply no longer consulted.

import { promises as fsPromises } from 'fs'
import { join } from 'path'

import type { BlueprintEdge, BlueprintGraph, BlueprintNode } from '../../shared/ipc-contract'

/** Injectable fs surface so the derivation is unit-testable. */
export interface BasicDeriveFs {
  /** File content, or null when unreadable/missing. */
  readFile(path: string): Promise<string | null>
  /** Directory entries with kind, or [] when unreadable/missing. */
  listDir(path: string): Promise<BasicDirEntry[]>
}

export interface BasicDirEntry {
  name: string
  isDirectory: boolean
  isFile: boolean
}

const defaultFs: BasicDeriveFs = {
  readFile: async (path) => {
    try {
      return await fsPromises.readFile(path, 'utf-8')
    } catch {
      return null
    }
  },
  listDir: async (path) => {
    try {
      const entries = await fsPromises.readdir(path, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }))
    } catch {
      return []
    }
  },
}

/** Source-file extensions that make a root dir count as a module. */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.rb',
  '.swift',
  '.kt',
  '.cs',
])

/** Root dirs that are never modules (artifacts, deps, hidden handled apart). */
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', 'target'])

/**
 * Maximum folder-tree depth for module nodes (1 = top-level source dir).
 * Directories deeper than this roll up into their depth-cap ancestor
 * (`meta.rolledUp: true`, files counted in `meta.fileCount`). Duplicated
 * from the CLI's `MODULE_TREE_DEPTH_CAP`
 * (src/cli/blueprint/extractors/modules.ts) — same id/label conventions and
 * cap so the basic fallback emits the SAME tree shape as the full derive;
 * keep the two in sync.
 */
const MODULE_TREE_DEPTH_CAP = 4

/**
 * Curated SDK map: package.json dependency (exact name or scope prefix) →
 * integration name. Order matters only for readability; ids dedupe.
 */
const INTEGRATION_DEPS: ReadonlyArray<{ match: string; prefix?: boolean; name: string }> = [
  { match: 'stripe', name: 'stripe' },
  { match: 'openai', name: 'openai' },
  { match: '@anthropic-ai/', prefix: true, name: 'anthropic' },
  { match: '@slack/', prefix: true, name: 'slack' },
  { match: 'twilio', name: 'twilio' },
  { match: '@sendgrid/', prefix: true, name: 'sendgrid' },
  { match: 'aws-sdk', name: 'aws' },
  { match: '@aws-sdk/', prefix: true, name: 'aws' },
  { match: 'firebase', name: 'firebase' },
  { match: 'firebase-admin', name: 'firebase' },
  { match: 'supabase', name: 'supabase' },
  { match: '@supabase/', prefix: true, name: 'supabase' },
]

/** Curated datastore client map: dependency → datastore name. */
const DATASTORE_DEPS: ReadonlyArray<{ match: string; prefix?: boolean; name: string }> = [
  { match: 'better-sqlite3', name: 'sqlite' },
  { match: 'sqlite3', name: 'sqlite' },
  { match: 'pg', name: 'postgres' },
  { match: 'postgres', name: 'postgres' },
  { match: 'mysql2', name: 'mysql' },
  { match: 'mongodb', name: 'mongodb' },
  { match: 'mongoose', name: 'mongodb' },
  { match: 'redis', name: 'redis' },
  { match: 'ioredis', name: 'redis' },
  { match: 'prisma', name: 'prisma' },
  { match: '@prisma/', prefix: true, name: 'prisma' },
  { match: 'drizzle-orm', name: 'drizzle' },
  { match: 'knex', name: 'knex' },
]

/** Datastore config files probed at fixed root-relative locations. */
const DATASTORE_CONFIG_PREFIXES: ReadonlyArray<{ prefix: string; name: string }> = [
  { prefix: 'schema.prisma', name: 'prisma' },
  { prefix: 'drizzle.config.', name: 'drizzle' },
  { prefix: 'knexfile.', name: 'knex' },
]

function matchCurated(
  dep: string,
  map: ReadonlyArray<{ match: string; prefix?: boolean; name: string }>,
): string | null {
  for (const entry of map) {
    if (entry.prefix ? dep.startsWith(entry.match) : dep === entry.match) {
      return entry.name
    }
  }
  return null
}

/** True when a filename has a recognized source-file extension. Exported so
 *  the learn orchestrator's module-file enumerator reuses the SAME extension
 *  set (single source of truth for "what counts as a source file"). */
export function isSourceFileName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && SOURCE_EXTENSIONS.has(name.slice(dot))
}

/** True when a directory entry should be descended into (not hidden, not an
 *  artifact/deps dir). Exported for reuse by the learn orchestrator's walker. */
export function isCandidateDir(entry: BasicDirEntry): boolean {
  return entry.isDirectory && !entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name)
}

/**
 * Recursively collect root-relative posix paths of source files, skipping
 * hidden and ignored directories. The walk mirrors what the CLI's
 * `walkRepo` feeds the modules extractor (structure only — no file reads).
 */
async function collectSourceFiles(rootPath: string, fs: BasicDeriveFs): Promise<string[]> {
  const files: string[] = []
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    for (const entry of await fs.listDir(absDir)) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`
      if (entry.isFile && isSourceFileName(entry.name)) {
        files.push(relPath)
      } else if (isCandidateDir(entry)) {
        await walk(join(absDir, entry.name), relPath)
      }
    }
  }
  await walk(rootPath, '')
  return files
}

/**
 * The UNCAPPED chain of module directories containing a source file,
 * outermost first (last entry = the file's parent directory), or null for
 * files that belong to no module directory. Mirrors the CLI's
 * `moduleChainOf`: with a `src/` tree, files directly in `src/` yield the
 * special `['src']` chain and depth counts from `src/<child>`; without one,
 * repo-root dirs are depth 1 and loose root files have no module.
 */
function moduleChainOf(relPath: string, hasSrcTree: boolean): string[] | null {
  const segments = relPath.split('/')
  if (hasSrcTree) {
    if (segments[0] !== 'src') {
      return null // Outside the src/ tree — not a module file
    }
    if (segments.length === 2) {
      return ['src'] // Loose file directly in src/ — the special src module
    }
    const chain: string[] = []
    for (let end = 2; end < segments.length; end += 1) {
      chain.push(segments.slice(0, end).join('/'))
    }
    return chain
  }
  if (segments.length < 2) {
    return null // Loose repo-root file — no module directory to attribute
  }
  const chain: string[] = []
  for (let end = 1; end < segments.length; end += 1) {
    chain.push(segments.slice(0, end).join('/'))
  }
  return chain
}

/** A module directory in the folder tree, with its accumulated file counts. */
interface ModuleDirInfo {
  dir: string
  depth: number
  directFiles: number
  rolledUpFiles: number
}

/**
 * Build the nested folder-tree module nodes + `contains` spine from the
 * collected source files — the same shape (path-based ids `module:<dir>`,
 * basename labels, depth/childDirs/fileCount meta, depth cap with rollup)
 * the CLI's modules extractor emits.
 */
function buildModuleTree(files: string[]): { nodes: BlueprintNode[]; edges: BlueprintEdge[] } {
  const hasSrcTree = files.some((file) => file.startsWith('src/'))
  const infos = new Map<string, ModuleDirInfo>()
  for (const relPath of files) {
    const chain = moduleChainOf(relPath, hasSrcTree)
    if (chain === null) continue
    const capped = chain.slice(0, MODULE_TREE_DEPTH_CAP)
    for (let index = 0; index < capped.length; index += 1) {
      if (!infos.has(capped[index])) {
        infos.set(capped[index], {
          dir: capped[index],
          depth: index + 1,
          directFiles: 0,
          rolledUpFiles: 0,
        })
      }
    }
    const owner = infos.get(capped[capped.length - 1]) as ModuleDirInfo
    if (chain.length > MODULE_TREE_DEPTH_CAP) {
      owner.rolledUpFiles += 1 // File deeper than the cap — rolls up
    } else {
      owner.directFiles += 1
    }
  }

  const moduleDirs = [...infos.values()].sort((a, b) => a.dir.localeCompare(b.dir))
  const parentOf = (dir: string): string | null => {
    const lastSlash = dir.lastIndexOf('/')
    return lastSlash === -1 ? null : dir.slice(0, lastSlash)
  }
  const nodes: BlueprintNode[] = moduleDirs.map((info) => {
    const childDirs = moduleDirs.filter((candidate) => parentOf(candidate.dir) === info.dir).length
    const lastSlash = info.dir.lastIndexOf('/')
    const node: BlueprintNode = {
      id: `module:${info.dir}`,
      kind: 'module',
      label: lastSlash === -1 ? info.dir : info.dir.slice(lastSlash + 1),
      sourceFile: info.dir,
      meta: {
        depth: info.depth,
        childDirs,
        fileCount: info.directFiles + info.rolledUpFiles,
      },
    }
    if (info.rolledUpFiles > 0 && node.meta !== undefined) {
      node.meta.rolledUp = true
    }
    return node
  })
  const edges: BlueprintEdge[] = []
  for (const info of moduleDirs) {
    const parentDir = parentOf(info.dir)
    if (parentDir !== null && infos.has(parentDir)) {
      edges.push({
        source: `module:${parentDir}`,
        target: `module:${info.dir}`,
        relation: 'contains',
      })
    }
  }
  return { nodes, edges }
}

/**
 * Derive the basic graph for a root. Returns null when NOTHING at all was
 * found (zero nodes — e.g. an empty directory): that is the only case left
 * for the view's failure pane.
 */
export async function deriveBasicGraph(
  rootPath: string,
  fs: BasicDeriveFs = defaultFs,
): Promise<BlueprintGraph | null> {
  const nodes: BlueprintNode[] = []
  const seenIds = new Set<string>()
  const push = (node: BlueprintNode): void => {
    if (!seenIds.has(node.id)) {
      seenIds.add(node.id)
      nodes.push(node)
    }
  }

  const rootEntries = await fs.listDir(rootPath)

  // ── Modules: the nested source-folder tree + `contains` spine (same
  // shape as the CLI's folder-spine extractor — see buildModuleTree) ──────
  const sourceFiles = await collectSourceFiles(rootPath, fs)
  const tree = buildModuleTree(sourceFiles)
  for (const node of tree.nodes) {
    push(node)
  }

  // ── Integrations + datastore clients from package.json dependencies ─────
  const packageJson = await fs.readFile(join(rootPath, 'package.json'))
  if (packageJson !== null) {
    let deps: string[] = []
    try {
      const parsed = JSON.parse(packageJson) as {
        dependencies?: Record<string, unknown>
        devDependencies?: Record<string, unknown>
      }
      deps = [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ]
    } catch {
      // Corrupt package.json — no dependency-derived nodes.
    }
    for (const dep of deps) {
      const integration = matchCurated(dep, INTEGRATION_DEPS)
      if (integration !== null) {
        push({
          id: `integration:${integration}`,
          kind: 'integration',
          label: integration,
          sourceFile: 'package.json',
        })
      }
      const datastore = matchCurated(dep, DATASTORE_DEPS)
      if (datastore !== null) {
        push({
          id: `datastore:${datastore}`,
          kind: 'datastore',
          label: datastore,
          sourceFile: 'package.json',
        })
      }
    }
  }

  // ── Datastores from config files at the root (and prisma/schema.prisma) ─
  for (const entry of rootEntries) {
    if (!entry.isFile) continue
    for (const config of DATASTORE_CONFIG_PREFIXES) {
      if (entry.name === config.prefix || entry.name.startsWith(config.prefix)) {
        push({
          id: `datastore:${config.name}`,
          kind: 'datastore',
          label: config.name,
          sourceFile: entry.name,
        })
      }
    }
  }
  if ((await fs.readFile(join(rootPath, 'prisma', 'schema.prisma'))) !== null) {
    push({
      id: 'datastore:prisma',
      kind: 'datastore',
      label: 'prisma',
      sourceFile: 'prisma/schema.prisma',
    })
  }

  if (nodes.length === 0) {
    return null
  }
  return {
    version: 1,
    derivedAt: new Date().toISOString(),
    coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: ['basic'], graphifyEnriched: false },
    nodes,
    // Only the `contains` spine — the basic derivation never invents
    // attribution edges (its integrations/datastores are package.json-
    // derived and not trivially attributable to a folder, so they stay
    // unattached and the view renders them in the 'Project' group).
    edges: tree.edges,
    basic: true,
  }
}
