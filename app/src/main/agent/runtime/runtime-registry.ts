// Runtime selection + the admission gate (multi_runtime_support, Phase 3).
//
// This is the connective tissue between the `provider` config (a string) and a
// concrete AgentRuntime (Claude / Codex / …). Two responsibilities, both pure:
//
//   1. RESOLVE which provider a thread runs under — a per-project `.flowconfig`
//      `provider` override wins, then the global default, then legacy 'claude'.
//      The same `override ?? default ?? legacy` precedence the AccountResolver
//      uses; an unknown provider is a config error, surfaced (fail-closed),
//      never silently coerced to Claude.
//   2. ADMIT a runtime — a runtime runs ONLY when it is driveable (headless +
//      parseable) AND safe (containment present). A runtime that can be neither
//      natively contained nor sandboxed is REJECTED; it never runs. This is the
//      capability contract's hard gate, in ONE code path (allowed-pattern #14).
//
// Construction is decoupled: each runtime has different deps (Claude needs the
// SDK query + translator, Codex needs a spawner), so the coordinator supplies a
// thunk per provider and the factory only selects + admits.

import type { AgentRuntime, RuntimeCapabilities } from './agent-runtime'

/** The providers plan-flow knows how to build a runtime for. */
export const KNOWN_PROVIDERS = ['claude', 'codex', 'copilot'] as const
export type ProviderId = (typeof KNOWN_PROVIDERS)[number]

/** The legacy provider — what every existing project runs today. */
export const DEFAULT_PROVIDER: ProviderId = 'claude'

/** How the resolved provider was chosen — for diagnostics and the UI. */
export type ProviderSource = 'project-override' | 'global-default' | 'legacy-default'

export interface ResolvedProvider {
  provider: ProviderId
  source: ProviderSource
}

/** True for a string that names a provider plan-flow knows. */
export function isKnownProvider(value: string): value is ProviderId {
  return (KNOWN_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Resolve which provider a thread runs under: per-project override ?? global
 * default ?? legacy 'claude'. A present-but-unknown provider string throws
 * (fail-closed) rather than silently falling back — a typo'd `provider: coddex`
 * must be a loud error, not a surprise Claude session. An ABSENT value at a
 * level is skipped, not an error.
 */
export function resolveProvider(input: {
  projectProvider?: string | null
  globalDefault?: string | null
}): ResolvedProvider {
  const fromProject = pick(input.projectProvider, 'project override')
  if (fromProject) return { provider: fromProject, source: 'project-override' }
  const fromGlobal = pick(input.globalDefault, 'global default')
  if (fromGlobal) return { provider: fromGlobal, source: 'global-default' }
  return { provider: DEFAULT_PROVIDER, source: 'legacy-default' }
}

/** Validate one configured level: absent → null (skip), known → the id, unknown
 *  → throw naming the offending level and the valid set. */
function pick(value: string | null | undefined, level: string): ProviderId | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (!isKnownProvider(trimmed)) {
    throw new Error(
      `unknown provider '${trimmed}' (${level}) — valid providers: ${KNOWN_PROVIDERS.join(', ')}`,
    )
  }
  return trimmed
}

/**
 * The admission gate. A runtime is admitted ONLY when it declares the
 * native-required capabilities (headless drive + parseable stream) AND a
 * containment strategy (native veto/sandbox, or a plan-flow OS sandbox). A
 * runtime that satisfies neither containment path is REJECTED — it never runs,
 * because plan-flow cannot promise the safety floor for it. Throws with a
 * specific reason; returns nothing on success.
 */
export function assertAdmissible(id: string, capabilities: RuntimeCapabilities): void {
  const failures: string[] = []
  if (!capabilities.driveHeadless) failures.push('cannot be driven headless')
  if (!capabilities.parseableStream) failures.push('emits no parseable event stream')
  if (capabilities.containment !== 'native' && capabilities.containment !== 'sandbox') {
    failures.push('has no containment strategy (neither native nor sandbox)')
  }
  if (failures.length > 0) {
    throw new Error(`runtime '${id}' is not admissible: ${failures.join('; ')}`)
  }
}

/** A per-provider constructor thunk. Absent ⇒ that provider is not available in
 *  this build/host (e.g. its CLI is not installed). */
export type RuntimeFactoryDeps = Partial<Record<ProviderId, () => AgentRuntime>>

/**
 * Build the runtime for a resolved provider: construct it from the coordinator's
 * thunk, then run it through the admission gate before handing it back. An
 * unconfigured provider (no thunk) is an explicit, actionable error rather than
 * a silent Claude fallback.
 */
export function createRuntime(provider: ProviderId, deps: RuntimeFactoryDeps): AgentRuntime {
  const make = deps[provider]
  if (!make) {
    throw new Error(
      `runtime unavailable: no '${provider}' runtime is configured for this project ` +
        `(is its CLI installed?)`,
    )
  }
  const runtime = make()
  assertAdmissible(runtime.id, runtime.capabilities)
  return runtime
}

/**
 * The whole path in one call: resolve the provider from config, then build +
 * admit its runtime. Returns the runtime and how the provider was chosen (for
 * the UI/diagnostics). Throws on an unknown provider, an unconfigured one, or
 * an inadmissible one.
 */
export function selectRuntime(
  config: { projectProvider?: string | null; globalDefault?: string | null },
  deps: RuntimeFactoryDeps,
): { runtime: AgentRuntime; resolved: ResolvedProvider } {
  const resolved = resolveProvider(config)
  const runtime = createRuntime(resolved.provider, deps)
  return { runtime, resolved }
}
