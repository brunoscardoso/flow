/**
 * verify-doc session (doc-verification Phase 2, app half).
 *
 * Runs a CAGED read-only agent (the learn-session executor) against ONE
 * Tier-2 doc: extract its discrete claims, verify each against the code the
 * agent actually reads, and return per-claim verdicts. The session's results
 * are recorded through the ONE verdict write path — the bundled CLI's
 * `blueprint adjudicate --claims-json --provenance verify-agent` — and the
 * deterministic aftermath (brain promotion + contradiction observations)
 * runs via `blueprint promote-doc` (#14: the app never writes stores).
 *
 * Fail-soft: malformed agent output is salvaged once (JSON-substring), a
 * failed run leaves any previous verdict untouched, and every refusal is a
 * one-line reason.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  runBundledCliCapturing,
  runCagedSession,
  type CliRunResult,
} from './learn-session'
import type { BundledCli } from '../blueprint/derive-runner'

/** Caps: claims per doc, witnesses per claim, doc bytes fed to the prompt. */
export const MAX_CLAIMS_PER_DOC = 8
export const MAX_WITNESSES_PER_CLAIM = 4
const MAX_DOC_BYTES = 24_000

export interface VerifyClaim {
  claim: string
  outcome: 'corroborated' | 'contradicted' | 'unverifiable'
  witnesses: string[]
  note?: string
}

export interface VerifyDocResult {
  ok: boolean
  reason?: string
  verdict?: 'corroborated' | 'contradicted' | 'unverifiable'
  claims?: VerifyClaim[]
  promoted?: number
  observations?: number
}

/** The rollup rule — mirrors the CLI's (recordVerdict re-enforces it). */
export function rollupOutcome(claims: readonly VerifyClaim[]): 'corroborated' | 'contradicted' | 'unverifiable' {
  if (claims.some((claim) => claim.outcome === 'contradicted')) return 'contradicted'
  if (claims.some((claim) => claim.outcome === 'unverifiable')) return 'unverifiable'
  return 'corroborated'
}

/** Build the claim-verification prompt for the caged session. */
export function buildVerifyPrompt(input: { docPath: string; docContent: string }): string {
  return [
    `You are verifying a DOCUMENTATION file against the actual codebase.`,
    `Doc (trust tier: CLAIM — an unverified statement about the code): ${input.docPath}`,
    '',
    'Doc content:',
    '"""',
    input.docContent,
    '"""',
    '',
    `Extract up to ${MAX_CLAIMS_PER_DOC} DISCRETE, CHECKABLE claims this doc makes about the system`,
    '(behavior, architecture, endpoints, config, business rules — skip prose that asserts nothing).',
    'For EACH claim, read the relevant code (you have read-only access to the repo) and judge:',
    '  - "corroborated": the code demonstrably does what the claim says',
    '  - "contradicted": the code demonstrably does something ELSE (name what)',
    '  - "unverifiable": you could not find code that settles it (an honest outcome — never guess)',
    `Name up to ${MAX_WITNESSES_PER_CLAIM} repo-relative WITNESS files per claim — only files you actually read.`,
    '',
    'Respond with ONLY this JSON (no markdown fences, no commentary):',
    '{"claims":[{"claim":"<assertion>","outcome":"corroborated|contradicted|unverifiable","witnesses":["path"],"note":"<one-line evidence>"}]}',
  ].join('\n')
}

/** Strict parse of the session's final text; null when malformed. */
export function parseVerifyOutput(raw: string): VerifyClaim[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const claims = (parsed as { claims?: unknown }).claims
  if (!Array.isArray(claims) || claims.length === 0) return null
  const valid: VerifyClaim[] = []
  for (const candidate of claims.slice(0, MAX_CLAIMS_PER_DOC)) {
    const claim = candidate as Partial<VerifyClaim>
    if (typeof claim.claim !== 'string' || claim.claim.trim().length === 0) return null
    if (claim.outcome !== 'corroborated' && claim.outcome !== 'contradicted' && claim.outcome !== 'unverifiable') return null
    if (!Array.isArray(claim.witnesses) || claim.witnesses.some((witness) => typeof witness !== 'string')) return null
    valid.push({
      claim: claim.claim.trim(),
      outcome: claim.outcome,
      witnesses: (claim.witnesses as string[]).slice(0, MAX_WITNESSES_PER_CLAIM),
      ...(typeof claim.note === 'string' && claim.note.length > 0 ? { note: claim.note } : {}),
    })
  }
  return valid
}

/** One salvage attempt: the outermost JSON-object substring (truncation guard). */
export function salvageVerifyOutput(raw: string): VerifyClaim[] | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  return parseVerifyOutput(raw.slice(start, end + 1))
}

export interface VerifyDocDeps {
  bundledCli: BundledCli
  /** Injectable for tests — defaults to the real caged session. */
  runSession?: (params: { cwd: string; prompt: string; model?: string; authEnv?: NodeJS.ProcessEnv }) => Promise<string>
  /** Injectable for tests — defaults to the real bundled-CLI spawn. */
  runCli?: (bundledCli: BundledCli, cwd: string, args: readonly string[]) => Promise<CliRunResult>
  model?: string
  authEnv?: NodeJS.ProcessEnv
}

/**
 * Verify one doc end-to-end: session → per-claim verdicts → adjudicate
 * (one write path) → promote. Returns a compact summary for the UI toast.
 */
export async function runVerifyDoc(
  rootPath: string,
  docPath: string,
  deps: VerifyDocDeps,
): Promise<VerifyDocResult> {
  let docContent: string
  try {
    docContent = readFileSync(join(rootPath, docPath), 'utf-8').slice(0, MAX_DOC_BYTES)
  } catch {
    return { ok: false, reason: `cannot read ${docPath}` }
  }
  if (docContent.trim().length === 0) {
    return { ok: false, reason: `${docPath} is empty — nothing to verify` }
  }

  const runSession =
    deps.runSession ??
    ((params: { cwd: string; prompt: string; model?: string; authEnv?: NodeJS.ProcessEnv }) =>
      runCagedSession({
        cwd: params.cwd,
        prompt: params.prompt,
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.authEnv !== undefined ? { authEnv: params.authEnv } : {}),
      }))
  const runCli = deps.runCli ?? runBundledCliCapturing

  let raw: string
  try {
    raw = await runSession({
      cwd: rootPath,
      prompt: buildVerifyPrompt({ docPath, docContent }),
      ...(deps.model !== undefined ? { model: deps.model } : {}),
      ...(deps.authEnv !== undefined ? { authEnv: deps.authEnv } : {}),
    })
  } catch (error) {
    return { ok: false, reason: `verify session failed: ${error instanceof Error ? error.message : String(error)}` }
  }

  const claims = parseVerifyOutput(raw) ?? salvageVerifyOutput(raw)
  if (claims === null) {
    return { ok: false, reason: 'verify session returned malformed output (after salvage)' }
  }

  const verdict = rollupOutcome(claims)
  const witnesses = [...new Set(claims.flatMap((claim) => claim.witnesses))]
  const adjudicate = await runCli(deps.bundledCli, rootPath, [
    'blueprint',
    'adjudicate',
    '--path',
    docPath,
    '--verdict',
    verdict,
    '--against',
    witnesses.join(','),
    '--claims-json',
    JSON.stringify(claims),
    '--provenance',
    'verify-agent',
  ])
  if (!adjudicate.ok) {
    return { ok: false, reason: adjudicate.error ?? 'adjudicate failed' }
  }

  const promote = await runCli(deps.bundledCli, rootPath, ['blueprint', 'promote-doc', '--path', docPath])
  const promotedMatch = /promoted: .* — (\d+) claim/.exec(promote.stdout)
  const observationsMatch = /(\d+) contradiction observation/.exec(promote.stdout)
  return {
    ok: true,
    verdict,
    claims,
    promoted: promote.ok && promotedMatch !== null ? Number(promotedMatch[1]) : 0,
    observations: promote.ok && observationsMatch !== null ? Number(observationsMatch[1]) : 0,
  }
}
