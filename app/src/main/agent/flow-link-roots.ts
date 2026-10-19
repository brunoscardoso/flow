// Where a project's `flow/` link really lives, and how Codex is told about it.
//
// `<repo>/flow` is the interface every agent, skill and command writes through.
// It is usually a SYMLINK — into the plan-flow vault today, into a Workspace
// project folder once Workspaces land — and its real target sits OUTSIDE the
// repository. A runtime whose sandbox resolves links (Codex's `workspace-write`
// confines writes to `-C <cwd>`) therefore refuses every write into `flow/`:
// proven on codex 0.19, "Operation not permitted" without the target as a
// writable root, the write succeeds with it.
//
// This module answers two questions and nothing else:
//   • which directories those links resolve to (async — it runs in main, where
//     a synchronous stat stalls every window; allowed-pattern #19), and
//   • how to spell them as the one Codex override that grants them
//     (`sandbox_workspace_write.writable_roots`), TOML-escaped.
//
// `flow-artifacts.ts` keeps its synchronous resolver for the SDK session, which
// is built synchronously; this is the async counterpart for the runtime path.

import { lstat, realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, relative, resolve } from 'path'

import { trustedFlowLinkBases } from '../project/flow-folder'

/** The filesystem calls the resolver needs — injectable for tests. */
export interface FlowLinkFs {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isDirectory(): boolean }>
}

const defaultFs: FlowLinkFs = { lstat, realpath, stat }

/**
 * Where a `flow` link may legitimately land. A link is a file any agent in the
 * repository can repoint (`ln -sfn / flow`), and what it resolves to becomes a
 * folder the runtime may WRITE — so the destination is validated, never the
 * link (the same rule as paths.ts's #94 guard).
 */
export interface FlowLinkPolicy {
  /** A target must sit strictly inside one of these (after realpath). */
  bases: readonly string[]
  /** The home folder — never granted, whatever a base says. */
  home: string
}

/** `<Flow folder>/workspaces` and the vault, by the CLI's own resolution rule. */
export function defaultFlowLinkPolicy(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): FlowLinkPolicy {
  return { bases: trustedFlowLinkBases(env, home), home }
}

/** The Codex config key that widens its `workspace-write` sandbox. */
export const CODEX_WRITABLE_ROOTS_KEY = 'sandbox_workspace_write.writable_roots'

/** True when `inner` is `outer` or nested inside it (both absolute, both real). */
function isInsideOrSame(outer: string, inner: string): boolean {
  const rel = relative(outer, inner)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** realpath, or null when the path is missing or unreadable. */
async function realOrNull(path: string, fs: FlowLinkFs): Promise<string | null> {
  try {
    return await fs.realpath(path)
  } catch {
    return null
  }
}

/**
 * The real target of `<root>/flow` for one root, or null.
 *
 * Null when `flow` is missing, is a plain directory (already inside the root),
 * resolves INSIDE the root (no widening needed), or resolves to something that
 * is not an existing directory. Never throws: a broken link must not stop a
 * turn from starting — it just grants nothing.
 *
 * AND NULL UNLESS THE DESTINATION IS ONE FLOW OWNS: strictly inside
 * `<Flow folder>/workspaces/` or the vault (`policy.bases`), and never the
 * filesystem root, the home folder, or a folder that contains the repository —
 * whatever a base says. A repointed link must not hand a runtime `/` to write.
 */
async function flowLinkTarget(root: string, fs: FlowLinkFs, policy: FlowLinkPolicy): Promise<string | null> {
  const linkPath = resolve(root, 'flow')
  try {
    if (!(await fs.lstat(linkPath)).isSymbolicLink()) return null
    const target = await fs.realpath(linkPath)
    if (!isAbsolute(target)) return null
    if (!(await fs.stat(target)).isDirectory()) return null
    // Compared real to real: on macOS a root under /var is /private/var once
    // resolved, and a lexical root makes every inside link look outside.
    const realRoot = await fs.realpath(root)
    if (isInsideOrSame(realRoot, target)) return null
    // Never the top of anything: `/`, an ancestor of the repository.
    if (target === resolve('/') || isInsideOrSame(target, realRoot)) return null
    const realBases = await Promise.all(policy.bases.map((base) => realOrNull(base, fs)))
    const realHome = await realOrNull(policy.home, fs)
    if (realHome !== null && isInsideOrSame(target, realHome)) return null
    const inABase = realBases.some(
      (base) => base !== null && base !== target && isInsideOrSame(base, target) && base !== resolve('/'),
    )
    return inABase ? target : null
  } catch {
    return null
  }
}

/**
 * The resolved `flow/` target of every root whose `flow` is a symlink pointing
 * OUTSIDE that root into a folder Flow owns — deduplicated (projects can share
 * a vault), in root order.
 */
export async function resolveFlowLinkTargets(
  roots: readonly string[],
  fs: FlowLinkFs = defaultFs,
  policy: FlowLinkPolicy = defaultFlowLinkPolicy(),
): Promise<string[]> {
  const targets = await Promise.all(roots.map((root) => flowLinkTarget(root, fs, policy)))
  return [...new Set(targets.filter((target): target is string => target !== null))]
}

/**
 * A TOML basic string — quoted, with backslashes, quotes and control
 * characters escaped. A Windows path or a folder name with a quote in it must
 * reach Codex as the same path, not as a parse error.
 */
export function tomlBasicString(value: string): string {
  let out = '"'
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\') out += '\\\\'
    else if (char === '"') out += '\\"'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else if (char === '\b') out += '\\b'
    else if (char === '\f') out += '\\f'
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`
    else out += char
  }
  return `${out}"`
}

/**
 * The `-c` value granting Codex write access to `paths`, or null when there is
 * nothing to grant. Relative paths are dropped — a writable root must name one
 * place, never "wherever the process happens to be".
 */
export function codexWritableRootsOverride(paths: readonly string[]): string | null {
  const absolute = [...new Set(paths.filter((path) => path.length > 0 && isAbsolute(path)))]
  if (absolute.length === 0) return null
  return `${CODEX_WRITABLE_ROOTS_KEY}=[${absolute.map(tomlBasicString).join(', ')}]`
}

/**
 * True when a failed Codex start refused the writable-roots override.
 *
 * Codex reports a config it cannot take before the turn begins, naming the
 * key: "Failed to deserialize overridden config: … in
 * `sandbox_workspace_write.writable_roots`" (measured on 0.19 with a bad
 * value). BOTH halves are required — the config-parse phrase AND the key — so
 * a log line that merely mentions the key (a tool printing it, a warning about
 * one of the roots) is never mistaken for the refusal. The caller adds the
 * other half of the rule: the turn must not have produced anything.
 */
export function isWritableRootsRejection(output: string): boolean {
  return (
    output.includes('Failed to deserialize overridden config') &&
    output.includes(CODEX_WRITABLE_ROOTS_KEY)
  )
}

/**
 * Which Codex executables refused the override, for the life of this app run.
 *
 * In memory on purpose: updating Codex is exactly what fixes it, and a
 * remembered refusal would outlive the update.
 */
export class CodexWritableRootsSupport {
  private readonly refused = new Set<string>()

  /** True once `execPath` has refused the override in this run. */
  refuses(execPath: string): boolean {
    return this.refused.has(execPath)
  }

  /** Record a refusal; true only the FIRST time, so the notice is said once. */
  markRefused(execPath: string): boolean {
    if (this.refused.has(execPath)) return false
    this.refused.add(execPath)
    return true
  }
}

/** The app-wide record (one per main process). */
export const codexWritableRootsSupport = new CodexWritableRootsSupport()

/** What the person reads when their Codex refuses — no paths, keys or commands. */
export const CODEX_WRITABLE_ROOTS_NOTICE =
  "This Codex version can't save knowledge outside the project folder, so notes it writes may not be kept. Updating Codex fixes this."
