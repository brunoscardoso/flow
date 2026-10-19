// The Workspace map feed (decision workspace-blueprint, 2026-10-06).
//
// Runs the bundled CLI `blueprint workspace graph --target <root> --json` and
// narrows its stdout into the contract shape. The CLI is the ONE source of the
// combined map (allowed-pattern #14): main derives no Workspace path and merges
// nothing — it spawns, waits (async, never blocking the process every window
// waits on — allowed-pattern #19) and narrows.
//
// FAIL-SOFT on every path, like its sibling `feature-runner.ts`: a missing CLI,
// a refusal (the project is in no Workspace), a timeout or unparseable output
// all yield `available: false` with a reason, and the board then draws the
// project on its own exactly as it always has.
import { spawn } from 'child_process'
import { realpath } from 'fs/promises'

import type { BundledCli } from './derive-runner'
import { narrowFeatureEdges, narrowFeatureNodes } from './feature-runner'
import type {
  BlueprintConnectionsLearning,
  BlueprintWorkspaceGraph,
  BlueprintWorkspaceLink,
  BlueprintWorkspaceLinkEnd,
  BlueprintWorkspaceLinkKind,
  BlueprintWorkspaceProject,
} from '../../shared/ipc-contract'

/** Measuring every local project walks every checkout — slower than one graph. */
const WORKSPACE_GRAPH_TIMEOUT_MS = 90_000

const LINK_KINDS = new Set<BlueprintWorkspaceLinkKind>(['calls', 'exposes', 'consumes', 'relates'])
const STATES = new Set(['local', 'remote', 'unreadable'])
const SIZE_SOURCES = new Set(['measured', 'last-known', 'none'])

function unavailable(reason: string): BlueprintWorkspaceGraph {
  return { available: false, reason, workspace: null, projects: [], links: null, linksError: null }
}

function record(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

function count(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
}

function fraction(raw: unknown): { done: number; total: number } | null {
  const obj = record(raw)
  if (obj === null) return null
  const done = count(obj.done)
  const total = count(obj.total)
  return done === null || total === null || total === 0 ? null : { done, total }
}

function narrowProject(raw: unknown): BlueprintWorkspaceProject | null {
  const p = record(raw)
  if (p === null) return null
  if (typeof p.id !== 'string' || typeof p.slug !== 'string' || typeof p.name !== 'string') return null
  const state = typeof p.state === 'string' && STATES.has(p.state) ? (p.state as BlueprintWorkspaceProject['state']) : 'unreadable'
  const size = record(p.size)
  const totals = record(p.totals) ?? {}
  const graph = record(p.graph)
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: typeof p.description === 'string' && p.description.trim() !== '' ? p.description : null,
    colorIndex: count(p.colorIndex) ?? 0,
    current: p.current === true,
    local: typeof p.local === 'string' && p.local !== '' ? p.local : null,
    state,
    error: typeof p.error === 'string' ? p.error : null,
    sizeSource:
      size !== null && typeof size.source === 'string' && SIZE_SOURCES.has(size.source)
        ? (size.source as BlueprintWorkspaceProject['sizeSource'])
        : 'none',
    // THE SAME NARROWING THE BOARD'S OWN READ USES — a node means one thing.
    graph: graph === null ? null : { nodes: narrowFeatureNodes(graph.nodes), edges: narrowFeatureEdges(graph.edges) },
    totals: {
      features: count(totals.features) ?? 0,
      lines: count(totals.lines),
      understood: fraction(totals.understood),
    },
    connections: count(p.connections) ?? 0,
  }
}

function narrowEnd(raw: unknown): BlueprintWorkspaceLinkEnd | null {
  const e = record(raw)
  if (e === null) return null
  if (typeof e.address !== 'string' || typeof e.project !== 'string' || typeof e.ref !== 'string') return null
  return {
    address: e.address,
    project: e.project,
    ref: e.ref,
    type: e.type === 'anchor' ? 'anchor' : 'feature',
    features: (Array.isArray(e.features) ? e.features : []).filter((id): id is string => typeof id === 'string'),
  }
}

function narrowLink(raw: unknown): BlueprintWorkspaceLink | null {
  const l = record(raw)
  if (l === null || typeof l.kind !== 'string' || !LINK_KINDS.has(l.kind as BlueprintWorkspaceLinkKind)) return null
  const from = narrowEnd(l.from)
  const to = narrowEnd(l.to)
  if (from === null || to === null) return null
  return {
    kind: l.kind as BlueprintWorkspaceLinkKind,
    ...(typeof l.note === 'string' && l.note.trim() !== '' ? { note: l.note } : {}),
    ...(l.source === 'learned' && (l.evidence === 'code' || l.evidence === 'model') ? { learned: l.evidence } : {}),
    from,
    to,
  }
}

/** The LAST parseable JSON object line — the family contract (allowed-pattern #24). */
function lastJsonLine(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').reverse()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      return record(JSON.parse(trimmed))
    } catch {
      continue
    }
  }
  return null
}

/** Narrow the verb's stdout. Exported for tests. */
export function parseWorkspaceGraphJson(stdout: string): BlueprintWorkspaceGraph {
  const obj = lastJsonLine(stdout)
  if (obj === null) return unavailable(stdout.trim() === '' ? 'no output' : 'unparseable Workspace map')
  if (typeof obj.refused === 'string') {
    return unavailable(typeof obj.detail === 'string' ? obj.detail : obj.refused)
  }
  const workspace = record(obj.workspace)
  if (workspace === null || typeof workspace.name !== 'string' || typeof workspace.slug !== 'string') {
    return unavailable('unparseable Workspace map')
  }
  const projects = (Array.isArray(obj.projects) ? obj.projects : [])
    .map(narrowProject)
    .filter((project): project is BlueprintWorkspaceProject => project !== null)
  const links = Array.isArray(obj.links)
    ? obj.links.map(narrowLink).filter((link): link is BlueprintWorkspaceLink => link !== null)
    : null
  return {
    available: true,
    reason: null,
    workspace: { name: workspace.name, slug: workspace.slug },
    projects,
    links,
    linksError: links === null ? (typeof obj.linksError === 'string' ? obj.linksError : 'the connections could not be read') : null,
    learning: narrowLearning(obj.learning),
  }
}

function narrowLearning(raw: unknown): BlueprintConnectionsLearning | null {
  const l = record(raw)
  if (l === null) return null
  const pairs = count(l.pairs)
  if (pairs === null) return null
  return {
    pairs,
    learned: count(l.learned) ?? 0,
    pending: count(l.pending) ?? 0,
    blocked: count(l.blocked) ?? 0,
    lastCheckedAt: typeof l.lastCheckedAt === 'string' ? l.lastCheckedAt : null,
  }
}

/**
 * Run the Workspace map for `rootPath` via the bundled CLI. Fail-soft — never
 * throws. `spawnFn` is injectable for tests.
 */
export function runWorkspaceGraph(
  bundledCli: BundledCli | null,
  rootPath: string,
  deps: { spawnFn?: typeof spawn; timeoutMs?: number } = {},
): Promise<BlueprintWorkspaceGraph> {
  if (bundledCli === null) return Promise.resolve(unavailable('bundled CLI unavailable'))
  const spawnFn = deps.spawnFn ?? spawn
  const timeoutMs = deps.timeoutMs ?? WORKSPACE_GRAPH_TIMEOUT_MS
  const args = [bundledCli.cliPath, 'blueprint', 'workspace', 'graph', '--target', rootPath, '--json']
  return new Promise<BlueprintWorkspaceGraph>((resolve) => {
    let stdout = ''
    let child: ReturnType<typeof spawnFn>
    try {
      child = spawnFn(bundledCli.execPath, args, {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    } catch (error) {
      resolve(unavailable((error as Error).message))
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(unavailable('timed out'))
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve(unavailable(error.message))
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(parseWorkspaceGraphJson(stdout))
    })
  })
}

/**
 * Name each checkout by the ROOT FLOW KNOWS IT AS.
 *
 * The CLI records a checkout by its resolved path (`/private/var/…` on macOS)
 * while Flow keeps the path a person added (`/var/…`). The renderer compares
 * the two to decide whether pressing a sibling can open it, so main — which
 * can resolve paths, asynchronously — swaps each `local` for the registered
 * root it resolves to. A checkout that is no Flow project keeps its own path.
 */
export async function alignLocalPaths(
  graph: BlueprintWorkspaceGraph,
  roots: readonly string[],
  resolvePath: (path: string) => Promise<string> = realpath,
): Promise<BlueprintWorkspaceGraph> {
  if (!graph.available || graph.projects.every((project) => project.local === null)) return graph
  const real = async (path: string): Promise<string> => {
    try {
      return await resolvePath(path)
    } catch {
      return path
    }
  }
  const byReal = new Map<string, string>()
  for (const root of roots) byReal.set(await real(root), root)
  const projects = await Promise.all(
    graph.projects.map(async (project) => {
      if (project.local === null) return project
      const registered = byReal.get(await real(project.local))
      return registered === undefined || registered === project.local ? project : { ...project, local: registered }
    }),
  )
  return { ...graph, projects }
}
