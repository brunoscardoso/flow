// Change-brief delta feed (change-brief).
//
// Runs the bundled CLI `blueprint brief --plan <plan> --json` for a project
// and parses its stdout into a BlueprintBriefResult the board can paint.
// Mirrors reconcile-runner: captures STDOUT (the CLI emits the delta there),
// and is FAIL-SOFT — any spawn/parse failure, or the CLI's `brief refused: …`
// line, yields `available: false` with a one-line reason so the board simply
// does not enter brief mode. It never throws and never blocks a board read.
import { spawn } from 'child_process'

import type { BundledCli } from './derive-runner'
import type {
  BlueprintBriefAnchor,
  BlueprintBriefNode,
  BlueprintBriefProposal,
  BlueprintBriefProposals,
  BlueprintBriefProvenance,
  BlueprintBriefResult,
  BlueprintBriefStep,
  BlueprintBriefTouch,
  BlueprintBriefWire,
  BlueprintProposalDocKind,
  BlueprintProposalSource,
} from '../../shared/ipc-contract'

const BRIEF_TIMEOUT_MS = 30_000

function unavailable(reason: string): BlueprintBriefResult {
  return { available: false, reason, nodes: [], wires: [], fails: [], anchors: [], steps: [] }
}

const NODE_KINDS = new Set(['stable', 'modify', 'new', 'remove'])
const WIRE_DELTAS = new Set(['kept', 'added', 'removed'])
const NODE_SOURCES = new Set(['graph', 'story', 'proposal'])
const DOC_KINDS = new Set(['plan', 'discovery', 'brainstorm', 'none'])

/**
 * The document behind a proposal. A malformed one becomes an UNBACKED source
 * (`doc: null`, `kind: 'none'`) rather than being dropped: losing the source
 * would leave a predicted node on the board with nothing naming where the
 * claim came from, which is the one thing the provenance band exists to
 * prevent.
 */
function parseSource(raw: unknown): BlueprintProposalSource | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  if (typeof source.plan !== 'string' || source.plan.length === 0) return null
  return {
    plan: source.plan,
    doc: typeof source.doc === 'string' && source.doc.length > 0 ? source.doc : null,
    kind: (typeof source.kind === 'string' && DOC_KINDS.has(source.kind)
      ? source.kind
      : 'none') as BlueprintProposalDocKind,
  }
}

/**
 * One claim. DROPPED when it names no source or no label — a mark whose origin
 * or subject is unreadable cannot be presented honestly, and half a claim on
 * screen is worse than one fewer.
 */
function parseProposal(raw: unknown): BlueprintBriefProposal | null {
  if (typeof raw !== 'object' || raw === null) return null
  const p = raw as Record<string, unknown>
  if (typeof p.fingerprint !== 'string' || p.fingerprint.length === 0) return null
  if (typeof p.label !== 'string' || p.label.length === 0) return null
  const source = parseSource(p.source)
  if (source === null) return null
  return {
    fingerprint: p.fingerprint,
    label: p.label,
    ...(typeof p.detail === 'string' && p.detail.length > 0 ? { detail: p.detail } : {}),
    // Anything but the two known words is read as `changed`: it is the weaker
    // claim (this thing already exists) and cannot invent a node.
    change: p.change === 'new' ? 'new' : 'changed',
    state: typeof p.state === 'string' ? p.state : 'proposed',
    kind: typeof p.kind === 'string' ? p.kind : 'module',
    resolvedAnchors: Array.isArray(p.resolvedAnchors)
      ? p.resolvedAnchors.filter((a): a is string => typeof a === 'string')
      : [],
    ...(Array.isArray(p.anchors)
      ? { anchors: p.anchors.filter((a): a is string => typeof a === 'string') }
      : {}),
    ...(typeof p.phase === 'number' && Number.isInteger(p.phase) && p.phase > 0 ? { phase: p.phase } : {}),
    source,
  }
}

/**
 * A node's provenance. Absent/malformed ⇒ `undefined`, which the renderer
 * reads as "this payload says nothing about prediction" and decorates nothing
 * — never as "not predicted", which would be a claim the CLI did not make.
 */
function parseProvenance(raw: unknown): BlueprintBriefProvenance | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const p = raw as Record<string, unknown>
  if (typeof p.source !== 'string' || !NODE_SOURCES.has(p.source)) return undefined
  if (typeof p.predicted !== 'boolean') return undefined
  const proposals: BlueprintBriefProposal[] = []
  for (const entry of Array.isArray(p.proposals) ? p.proposals : []) {
    const proposal = parseProposal(entry)
    if (proposal !== null) proposals.push(proposal)
  }
  return {
    source: p.source as BlueprintBriefProvenance['source'],
    predicted: p.predicted,
    proposals,
  }
}

/**
 * The proposal layer. `undefined` when the CLI emitted none — deliberately NOT
 * synthesised as an empty layer, because "nobody asked" and "nothing is
 * proposed" are different facts and only the second is an answer the board may
 * repeat.
 */
function parseProposalLayer(raw: unknown): BlueprintBriefProposals | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const layer = raw as Record<string, unknown>
  if (typeof layer.nothingProposed !== 'boolean') return undefined
  const nodes: BlueprintBriefNode[] = []
  for (const entry of Array.isArray(layer.nodes) ? layer.nodes : []) {
    const node = parseNode(entry)
    if (node !== null) nodes.push(node)
  }
  const sources: BlueprintProposalSource[] = []
  for (const entry of Array.isArray(layer.sources) ? layer.sources : []) {
    const source = parseSource(entry)
    if (source !== null) sources.push(source)
  }
  const skipped: BlueprintBriefProposals['skipped'] = []
  for (const entry of Array.isArray(layer.skipped) ? layer.skipped : []) {
    const s = entry as Record<string, unknown>
    if (typeof s.fingerprint !== 'string' || typeof s.reason !== 'string') continue
    skipped.push({
      fingerprint: s.fingerprint,
      predictedNodeId: typeof s.predictedNodeId === 'string' ? s.predictedNodeId : '',
      reason: s.reason,
    })
  }
  return {
    nodes,
    sources,
    // A layer that CLAIMS proposals but survived parsing with no drawable node
    // is corrected to the honest reading here, so the board's door cannot open
    // onto an empty view.
    nothingProposed: layer.nothingProposed || nodes.length === 0,
    summary: typeof layer.summary === 'string' ? layer.summary : '',
    skipped,
  }
}

/** One delta node, or null when it is not one. Shared by the layer parser. */
function parseNode(raw: unknown): BlueprintBriefNode | null {
  if (typeof raw !== 'object' || raw === null) return null
  const n = raw as Record<string, unknown>
  if (
    typeof n.nodeId !== 'string' ||
    typeof n.kind !== 'string' ||
    !NODE_KINDS.has(n.kind) ||
    typeof n.existsToday !== 'boolean' ||
    typeof n.label !== 'string'
  ) {
    return null
  }
  const provenance = parseProvenance(n.provenance)
  return {
    nodeId: n.nodeId,
    kind: n.kind as BlueprintBriefNode['kind'],
    existsToday: n.existsToday,
    label: n.label,
    ...(provenance !== undefined ? { provenance } : {}),
  }
}

/**
 * Narrow the CLI's parsed JSON to the contract shape. Defensive on purpose:
 * a malformed entry is DROPPED rather than poisoning the paint, because a
 * half-understood delta rendered confidently is worse than no brief at all.
 */
function parseBriefJson(stdout: string): BlueprintBriefResult {
  const trimmed = stdout.trim()
  if (trimmed.length === 0) return unavailable('no output')
  // A refusal is printed as a plain line, not JSON.
  if (!trimmed.startsWith('{')) return unavailable(trimmed.split('\n')[0] ?? 'brief refused')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return unavailable('unparseable brief output')
  }
  const obj = parsed as Record<string, unknown>

  const nodes: BlueprintBriefNode[] = []
  for (const raw of Array.isArray(obj.nodes) ? obj.nodes : []) {
    const node = parseNode(raw)
    if (node !== null) nodes.push(node)
  }

  const wires: BlueprintBriefWire[] = []
  for (const raw of Array.isArray(obj.wires) ? obj.wires : []) {
    const w = raw as Record<string, unknown>
    if (
      typeof w.from === 'string' &&
      typeof w.to === 'string' &&
      typeof w.delta === 'string' &&
      WIRE_DELTAS.has(w.delta) &&
      typeof w.drawnToday === 'boolean'
    ) {
      wires.push({
        from: w.from,
        to: w.to,
        delta: w.delta as BlueprintBriefWire['delta'],
        labelBefore: typeof w.labelBefore === 'string' ? w.labelBefore : '',
        labelAfter: typeof w.labelAfter === 'string' ? w.labelAfter : '',
        drawnToday: w.drawnToday,
      })
    }
  }

  const anchors: BlueprintBriefAnchor[] = []
  for (const raw of Array.isArray(obj.anchors) ? obj.anchors : []) {
    const a = raw as Record<string, unknown>
    if (typeof a.ref === 'string' && typeof a.resolved === 'boolean') {
      anchors.push({ ref: a.ref, resolved: a.resolved })
    }
  }

  const steps: BlueprintBriefStep[] = []
  for (const raw of Array.isArray(obj.steps) ? obj.steps : []) {
    const s = raw as Record<string, unknown>
    if (typeof s.title !== 'string') continue
    steps.push({
      title: s.title,
      ...(typeof s.kicker === 'string' ? { kicker: s.kicker } : {}),
      body: typeof s.body === 'string' ? s.body : '',
      decisions: Array.isArray(s.decisions) ? s.decisions.filter((d): d is string => typeof d === 'string') : [],
      rejected: Array.isArray(s.rejected) ? s.rejected.filter((d): d is string => typeof d === 'string') : [],
    })
  }

  const fails = Array.isArray(obj.fails)
    ? obj.fails.filter((f): f is string => typeof f === 'string')
    : []

  // Feature identity: only a `--feature` brief carries it, and a malformed one
  // is dropped like any other entry rather than half-painted.
  const rawIdentity = obj.identity as Record<string, unknown> | undefined
  const identity =
    rawIdentity !== undefined && typeof rawIdentity.name === 'string'
      ? {
          name: rawIdentity.name,
          prose: typeof rawIdentity.prose === 'string' ? rawIdentity.prose : '',
          // Children carry ids so the brief can OPEN them. A bare string is
          // still accepted (older CLI) and kept as an un-openable label rather
          // than dropped — losing a change record is worse than not linking it.
          children: (Array.isArray(rawIdentity.children) ? rawIdentity.children : []).flatMap(
            (child): Array<{ id: string; name: string }> => {
              if (typeof child === 'string') return [{ id: '', name: child }]
              const entry = child as Record<string, unknown>
              return typeof entry.name === 'string'
                ? [{ id: typeof entry.id === 'string' ? entry.id : '', name: entry.name }]
                : []
            },
          ),
          learnings: (Array.isArray(rawIdentity.learnings) ? rawIdentity.learnings : []).flatMap(
            (raw): Array<{
              text: string
              provenance: string
              date: string
              pinned?: boolean
              supersededReason?: string
            }> => {
              const entry = raw as Record<string, unknown>
              if (typeof entry.text !== 'string' || entry.text.length === 0) return []
              return [
                {
                  text: entry.text,
                  provenance: typeof entry.provenance === 'string' ? entry.provenance : 'code',
                  date: typeof entry.date === 'string' ? entry.date : '',
                  ...(entry.pinned === true ? { pinned: true } : {}),
                  ...(typeof entry.supersededReason === 'string' && entry.supersededReason.length > 0
                    ? { supersededReason: entry.supersededReason }
                    : {}),
                },
              ]
            },
          ),
        }
      : undefined

  return {
    available: true,
    reason: null,
    nodes,
    wires,
    fails,
    anchors,
    steps,
    ...(typeof obj.unchanged === 'string' ? { unchanged: obj.unchanged } : {}),
    ...(identity !== undefined ? { identity } : {}),
    // Anything other than the two known values is dropped, so an unexpected
    // string can never be mistaken for a delta.
    ...(obj.mode === 'anatomy' || obj.mode === 'delta' ? { mode: obj.mode } : {}),
    // The proposal layer, when the CLI emitted one. Omitted rather than
    // defaulted: the board's door reads a missing layer as "no answer" and an
    // empty one as "nothing proposed", and those are not the same fact.
    ...(() => {
      const proposed = parseProposalLayer(obj.proposed)
      return proposed === undefined ? {} : { proposed }
    })(),
    // The curated view passes through UNINSPECTED. The CLI validated it before
    // writing (a dangling edge, a dead drill target and an out-of-range excerpt
    // are all refusals), so re-checking here would be a second, weaker copy of
    // the rule that already refused — and the renderer must handle a missing or
    // malformed view regardless, since a view may simply not exist yet.
    ...(typeof obj.view === 'object' && obj.view !== null && !Array.isArray(obj.view)
      ? { view: obj.view as Record<string, unknown> }
      : {}),
    // Parts pass through with the same reasoning as the view: the CLI owns and
    // validates the shape, and the renderer must handle their absence anyway.
    ...(Array.isArray(obj.parts) ? { parts: obj.parts as Array<Record<string, unknown>> } : {}),
    // The document the CLI actually described. Absent from an older CLI, which
    // is how a door that pinned a version can tell its pin was ignored.
    ...(typeof obj.docPath === 'string' && obj.docPath.length > 0 ? { docPath: obj.docPath } : {}),
    // What the document touches, best first. Malformed entries are dropped;
    // an absent field (older CLI) stays absent.
    ...(Array.isArray(obj.touches) ? { touches: parseTouches(obj.touches) } : {}),
  }
}

/** The brief's `touches`, each entry checked; anything malformed is dropped. */
export function parseTouches(raw: unknown[]): BlueprintBriefTouch[] {
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
  const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
  return raw.flatMap((entry): BlueprintBriefTouch[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const featureId = text(record.featureId)
    if (featureId === null) return []
    const parts = (Array.isArray(record.parts) ? record.parts : []).flatMap((part): Array<{ id: string; name: string }> => {
      const p = part as Record<string, unknown> | null
      return p !== null && typeof p === 'object' && text(p.id) !== null && text(p.name) !== null
        ? [{ id: p.id as string, name: p.name as string }]
        : []
    })
    return [
      {
        project: text(record.project),
        root: text(record.root),
        featureId,
        featureName: text(record.featureName) ?? featureId,
        parts,
        anchors: count(record.anchors),
        specific: count(record.specific),
      },
    ]
  })
}

/**
 * Run the change brief for `plan` in `rootPath` via the bundled CLI. Fail-soft
 * — never throws; returns `available: false` on any failure. `spawnFn` is
 * injectable for tests.
 */
export function runBrief(
  bundledCli: BundledCli | null,
  rootPath: string,
  plan: string,
  deps: { spawnFn?: typeof spawn; timeoutMs?: number; feature?: string; doc?: string } = {},
): Promise<BlueprintBriefResult> {
  if (bundledCli === null) {
    return Promise.resolve(unavailable('bundled CLI unavailable'))
  }
  const spawnFn = deps.spawnFn ?? spawn
  const timeoutMs = deps.timeoutMs ?? BRIEF_TIMEOUT_MS
  // A feature-scoped brief needs no plan: with none in flight it is anatomy.
  const args =
    deps.feature !== undefined && deps.feature.length > 0
      ? [bundledCli.cliPath, 'blueprint', 'brief', '--feature', deps.feature, '--json']
      : [
          bundledCli.cliPath, 'blueprint', 'brief', '--plan', plan,
          // The document VERSION the door named — the CLI validates it.
          ...(deps.doc !== undefined && deps.doc.length > 0 ? ['--path', deps.doc] : []),
          '--json',
        ]
  return new Promise<BlueprintBriefResult>((resolve) => {
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
      resolve(parseBriefJson(stdout))
    })
  })
}
