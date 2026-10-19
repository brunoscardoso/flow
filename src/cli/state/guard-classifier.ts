/**
 * The guarded-autopilot decision core (#653).
 *
 * `classifyGuardAction` judges one dangerous seam by irreversibility and blast
 * radius into a deterministic `GuardDecision`. Pure and table-free-of-I/O: no
 * model call, no fs, no environment probing — the haiku `consult` lives in the
 * skill, not here. Every verdict/category/reason string is stable and derived
 * only from the input, so the same action always yields the same decision.
 * (`delete` does lexical path math on the root the caller states — `resolve` /
 * `relative` only, still no fs and still pure.)
 *
 * The bash kind reuses the permissions-hygiene vocabulary (allowed-pattern
 * #14, one source of truth): the command is normalized to a family via
 * `normalizeBashFamily`, then classified with the SAME `isAutoAllowed` /
 * `isMutatingFamily` / `isWildcardRunner` predicates the suggest hygiene gate
 * uses — the dangerous-family lists are never duplicated here.
 *
 * `userRequested` is applied last: when the current plan/task explicitly named
 * this exact destructive action, an `ask` downgrades to `allow`. It never
 * touches an `allow` (already permitted) or a `consult` (still undecided).
 */

import { isAbsolute, relative, resolve } from 'node:path';

import {
  isAutoAllowed,
  isMutatingFamily,
  isWildcardRunner,
} from './permissions-hygiene.js';
import { normalizeBashFamily } from './permissions-normalize.js';
import type { DeleteGuardAction, GuardAction, GuardDecision } from './guard-types.js';

/** Human label for a remote target, e.g. `origin/main` or a sensible default. */
function remoteTarget(remote?: string, branch?: string): string {
  return `${remote ?? 'the remote'}/${branch ?? 'the current branch'}`;
}

/** Classify a bash command by its permissions-hygiene family. */
function classifyBash(command: string): GuardDecision {
  const family = normalizeBashFamily(command);
  if (family === null) {
    return {
      verdict: 'ask',
      category: 'unparseable-bash',
      reason: 'shell-chained or unparseable — cannot verify safety',
    };
  }
  if (isAutoAllowed(family)) {
    return {
      verdict: 'allow',
      category: 'auto-allowed',
      reason: `read-only family "${family}" — already auto-allowed by the harness`,
    };
  }
  if (isMutatingFamily(family)) {
    return {
      verdict: 'ask',
      category: 'mutating-bash',
      reason: `mutating family "${family}" — changes state, not auto-allowed`,
    };
  }
  if (isWildcardRunner(family)) {
    return {
      verdict: 'ask',
      category: 'wildcard-runner',
      reason: `runner "${family}" is wildcard-equivalent — arbitrary code execution`,
    };
  }
  return {
    verdict: 'consult',
    category: 'ambiguous-bash',
    reason: 'not classifiable deterministically — defer to the classifier',
  };
}

/**
 * Classify a deletion by whether it lands inside the checkout the caller named.
 *
 * The containment test is LEXICAL — `resolve` + `relative`, no `fs`, no symlink
 * following — so the decision stays a pure function of the action. That is also
 * why the root is the caller's to state: a thread's worktree is the path the
 * `worktree` CLI returned (git's own spelling), and re-deriving it here would
 * disagree the moment a root is reached through a symlink.
 *
 * The worktree root ITSELF is never "inside": deleting the checkout takes every
 * untracked and ignored file in it with it, which is exactly the unrecoverable
 * outcome the ask exists for.
 */
function classifyDelete(action: DeleteGuardAction): GuardDecision {
  const root = action.worktreeRoot;
  if (typeof root === 'string' && root.length > 0) {
    const rel = relative(resolve(root), resolve(root, action.path));
    if (rel.length === 0) {
      return {
        verdict: 'ask',
        category: 'irreversible-delete',
        reason: `deletes the worktree "${root}" itself — takes every untracked file in it, not recoverable from git`,
      };
    }
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        verdict: 'ask',
        category: 'irreversible-delete',
        reason: `deletes "${action.path}" outside the worktree "${root}" — not recoverable from git`,
      };
    }
    return {
      verdict: 'allow',
      category: 'reversible-local',
      reason: `deletion inside the worktree "${root}" — recoverable from git`,
    };
  }

  if (typeof action.insideWorktree === 'boolean') {
    return action.insideWorktree
      ? {
          verdict: 'allow',
          category: 'reversible-local',
          reason: 'deletion inside the worktree — recoverable from git',
        }
      : {
          verdict: 'ask',
          category: 'irreversible-delete',
          reason: `deletes "${action.path}" outside the worktree — not recoverable from git`,
        };
  }

  // Neither field: containment is unknown, and "unknown" is not "recoverable".
  return {
    verdict: 'ask',
    category: 'unresolved-delete',
    reason: `cannot tell whether "${action.path}" is inside a checkout — no worktree root or containment stated`,
  };
}

/**
 * The deterministic base decision for an action, before the `userRequested`
 * downgrade is applied.
 */
function baseDecision(action: GuardAction): GuardDecision {
  switch (action.kind) {
    case 'push':
      return {
        verdict: 'ask',
        category: 'irreversible-remote',
        reason: `pushes to ${remoteTarget(action.remote, action.branch)} — visible to others, not locally reversible`,
      };
    case 'pr-create':
      return {
        verdict: 'ask',
        category: 'irreversible-remote',
        reason: `opens a pull request on ${remoteTarget(action.remote, action.branch)} — visible to others, not locally reversible`,
      };
    case 'commit':
      return {
        verdict: 'allow',
        category: 'reversible-local',
        reason: 'local commit — amendable/revertible',
      };
    case 'delete':
      return classifyDelete(action);
    case 'bash':
      return classifyBash(action.command);
  }
}

/**
 * Judge a dangerous seam into a deterministic decision.
 *
 * The base verdict comes from the action's kind (bash defers to the
 * permissions-hygiene families). Then, if the action was explicitly requested
 * by the current plan/task and the base verdict is `ask`, it downgrades to
 * `allow` — an explicit request removes the surprise the ask guards against.
 * `allow` and `consult` are never changed by `userRequested`.
 */
export function classifyGuardAction(action: GuardAction): GuardDecision {
  const base = baseDecision(action);

  if (action.userRequested === true && base.verdict === 'ask') {
    return {
      verdict: 'allow',
      category: 'user-requested',
      reason: `explicitly requested by the current plan/task — ${base.reason}`,
    };
  }

  return base;
}
