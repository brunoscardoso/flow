// classify-roles — the one-time classify pass (plan `feature-type-icons`,
// FR-10, NFR-4, Task 3.3).
//
// Features learned before roles existed have no `learnedRole`, so the board can
// only guess them. This pass asks the SMALLEST model, in batches, what each one
// is — from its name, its summary and its part names, NEVER its code — and
// writes every answer through the one learnedRole writer (`blueprint features
// role`), which validates it again (allowed-pattern #14).
//
// It is offered, never run silently: a person presses the board's button, which
// calls `learn:classifyRoles`. It is stoppable (an AbortSignal reaches both the
// model call and the loop), reports progress per batch, and never blocks main —
// every step is an awaited child or model call (allowed-pattern #19).
//
// Pure halves (prompt, reply parser, batching) are exported for tests; the job
// takes every side effect as a dependency.

import { FEATURE_ROLES, type FeatureRole } from '../../shared/feature-role'
import {
  selectRoleClassifyCandidates,
  type RoleClassifyCandidate,
  type RoleClassifyNode,
} from '../../shared/role-classify'
import { featureRolePromptLines, normaliseFeatureRole } from '../agent/feature-role-prompt'

/** How many features one model call classifies. */
export const CLASSIFY_BATCH_SIZE = 20

/** Longest summary sent — one or two sentences is all a role needs. */
export const CLASSIFY_SUMMARY_MAX_CHARS = 240

/** Most part names sent per feature. */
export const CLASSIFY_PART_NAMES_MAX = 12

/** Split a list into batches of `size`. */
export function batchCandidates<T>(items: readonly T[], size: number = CLASSIFY_BATCH_SIZE): T[][] {
  const step = Math.max(1, Math.trunc(size))
  const out: T[][] = []
  for (let index = 0; index < items.length; index += step) out.push(items.slice(index, index + step))
  return out
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * The prompt for one batch. Names, summaries and part names only — the
 * candidate type carries nothing else, so no code can reach it.
 */
export function buildClassifyPrompt(batch: readonly RoleClassifyCandidate[]): string {
  const items = batch.map((candidate) => {
    const lines = [`- id: ${candidate.id}`]
    lines.push(
      candidate.kind === 'part' && candidate.featureName !== undefined
        ? `  name: ${candidate.name} (a part of "${candidate.featureName}")`
        : `  name: ${candidate.name}`,
    )
    if (candidate.summary.length > 0) lines.push(`  summary: ${oneLine(candidate.summary, CLASSIFY_SUMMARY_MAX_CHARS)}`)
    const parts = candidate.partNames.slice(0, CLASSIFY_PART_NAMES_MAX)
    if (parts.length > 0) lines.push(`  parts: ${parts.map((name) => oneLine(name, 60)).join(', ')}`)
    return lines.join('\n')
  })
  return [
    'You are labelling the features of a software project by what kind of thing each one is.',
    'You get each feature\'s name, a short summary and the names of its parts. You do not get its code, and you need none.',
    '',
    ...featureRolePromptLines('each feature'),
    '',
    'Features:',
    ...items,
    '',
    'Reply with ONLY a single JSON object — no prose, no code fence — mapping every id above to one role:',
    '{ "roles": { "<id>": "<one word from the role list>" } }',
    `Copy each id exactly. Use only: ${FEATURE_ROLES.join(', ')}.`,
  ].join('\n')
}

/** The first `{` to the last `}` — a reply wrapped in prose or a fence still reads. */
function jsonObjectOf(raw: string): unknown {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Read a batch reply: the roles it gave, ONLY for ids that were asked about and
 * only when on the list. Anything else is dropped — an id the model invented is
 * never written. Accepts `{ "roles": {…} }` and a bare `{ id: role }` map.
 */
export function parseClassifyReply(raw: string | null, askedIds: readonly string[]): Map<string, FeatureRole> {
  const out = new Map<string, FeatureRole>()
  if (raw === null) return out
  const parsed = jsonObjectOf(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out
  const wrapped = (parsed as Record<string, unknown>)['roles']
  const map =
    typeof wrapped === 'object' && wrapped !== null && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : (parsed as Record<string, unknown>)
  const asked = new Set(askedIds)
  for (const [id, value] of Object.entries(map)) {
    if (!asked.has(id)) continue
    const role = normaliseFeatureRole(value)
    if (role !== null) out.set(id, role)
  }
  return out
}

/** What a pass did. Every candidate lands in exactly one count. */
export interface ClassifyRolesResult {
  /** Roles written through the verb. */
  written: number
  /** Candidates the model gave no usable role for — nothing written. */
  skipped: number
  /** Roles the verb refused, or batches whose model call failed. */
  failed: number
  /** How many the pass set out to classify. */
  total: number
  /** The pass was stopped before it finished. */
  stopped: boolean
}

export interface ClassifyRolesDeps {
  /** The project's feature graph nodes (`blueprint features graph`). */
  readNodes: () => Promise<readonly RoleClassifyNode[]>
  /** One call to the smallest model; null when it gave nothing. */
  askModel: (prompt: string, signal: AbortSignal) => Promise<string | null>
  /** Write one learned role through the verb; false when refused. */
  writeRole: (id: string, role: FeatureRole) => Promise<boolean>
  signal: AbortSignal
  /** After each batch: how many candidates have been settled so far. */
  onProgress?: (progress: { done: number; total: number; written: number }) => void
  batchSize?: number
}

/** Run the pass. Never throws — a failure is a count, never an exception. */
export async function classifyRoles(deps: ClassifyRolesDeps): Promise<ClassifyRolesResult> {
  const result: ClassifyRolesResult = { written: 0, skipped: 0, failed: 0, total: 0, stopped: false }
  let nodes: readonly RoleClassifyNode[]
  try {
    nodes = await deps.readNodes()
  } catch {
    return result
  }
  const candidates = selectRoleClassifyCandidates(nodes)
  result.total = candidates.length
  let done = 0
  for (const batch of batchCandidates(candidates, deps.batchSize)) {
    if (deps.signal.aborted) {
      result.stopped = true
      break
    }
    let reply: string | null
    try {
      reply = await deps.askModel(buildClassifyPrompt(batch), deps.signal)
    } catch {
      if (deps.signal.aborted) {
        result.stopped = true
        break
      }
      result.failed += batch.length
      done += batch.length
      deps.onProgress?.({ done, total: result.total, written: result.written })
      continue
    }
    if (deps.signal.aborted) {
      result.stopped = true
      break
    }
    const roles = parseClassifyReply(reply, batch.map((candidate) => candidate.id))
    for (const candidate of batch) {
      const role = roles.get(candidate.id)
      if (role === undefined) {
        result.skipped += 1
        continue
      }
      let ok = false
      try {
        ok = await deps.writeRole(candidate.id, role)
      } catch {
        ok = false
      }
      if (ok) result.written += 1
      else result.failed += 1
    }
    done += batch.length
    deps.onProgress?.({ done, total: result.total, written: result.written })
  }
  return result
}

/** What `learn:classifyRoles` answers. */
export interface ClassifyRolesResponse extends ClassifyRolesResult {
  ok: boolean
  /** Why it did not run — a sentence for a person, never a command (forbidden-pattern #12). */
  reason?: string
}

/** The per-project side effects a classifier needs. */
export interface RoleClassifierDeps {
  readNodes: (rootPath: string) => Promise<readonly RoleClassifyNode[]>
  askModel: (rootPath: string, prompt: string, signal: AbortSignal) => Promise<string | null>
  writeRole: (rootPath: string, id: string, role: FeatureRole) => Promise<boolean>
  onProgress?: (rootPath: string, progress: { done: number; total: number; written: number }) => void
}

/**
 * One classifier for the app: at most one pass per project, each stoppable.
 * `run(root, { stop: true })` aborts that project's pass and answers at once;
 * the pass's own call then resolves with `stopped: true`.
 */
export function createRoleClassifier(deps: RoleClassifierDeps): {
  run: (rootPath: string, options: { stop: boolean }) => Promise<ClassifyRolesResponse>
  isRunning: (rootPath: string) => boolean
} {
  const running = new Map<string, AbortController>()
  const empty = (): ClassifyRolesResult => ({ written: 0, skipped: 0, failed: 0, total: 0, stopped: false })
  return {
    isRunning: (rootPath) => running.has(rootPath),
    run: async (rootPath, options) => {
      const active = running.get(rootPath)
      if (options.stop) {
        if (active === undefined) return { ok: true, ...empty() }
        active.abort()
        return { ok: true, ...empty(), stopped: true }
      }
      if (active !== undefined) {
        return { ok: false, ...empty(), reason: 'Roles are already being classified for this project.' }
      }
      const controller = new AbortController()
      running.set(rootPath, controller)
      try {
        const result = await classifyRoles({
          readNodes: () => deps.readNodes(rootPath),
          askModel: (prompt, signal) => deps.askModel(rootPath, prompt, signal),
          writeRole: (id, role) => deps.writeRole(rootPath, id, role),
          signal: controller.signal,
          ...(deps.onProgress !== undefined
            ? { onProgress: (progress: { done: number; total: number; written: number }) => deps.onProgress?.(rootPath, progress) }
            : {}),
        })
        return { ok: true, ...result }
      } finally {
        if (running.get(rootPath) === controller) running.delete(rootPath)
      }
    },
  }
}
