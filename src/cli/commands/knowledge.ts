/**
 * `planflow-ai knowledge <status|enable|disable|adopt>` — the one door onto a
 * project's own knowledge repo.
 *
 * THIN ON PURPOSE. Every decision — which shape the project is in, what each
 * conversion does, what a failure puts back — lives in
 * `handlers/knowledge-migration.ts` (allowed-pattern #14). This file parses,
 * calls, and prints.
 *
 * Contract (the `worktree` precedent):
 *
 *   - Success: the result object on stdout, exit 0. `--json` prints it as one
 *     JSON line; without it, one human line. A second formatter, never a
 *     second computation.
 *   - Refusal: the payload (`{ action, refused, detail, ... }`) as one JSON
 *     line on stdout — with or without `--json`, because every refusal here
 *     is a question the asking surface has to put (allowed-pattern #21) —
 *     then ONE `knowledge refused: <reason> — <sentence>` line via the repo
 *     logger (stdout too, allowed-pattern #15), exit 1.
 *   - Callers read the LAST parseable JSON line on stdout; the generator's own
 *     progress lines (".gitignore updated") come before it and are not JSON.
 *   - Nothing here ever pushes, or reaches the network.
 *
 * RETIRED (decision 2026-10-06, workspaces-hard-migration): per-project
 * knowledge sync is gone — knowledge syncs through the Workspace, and a project
 * that kept its own knowledge repo is migrated into one (`workspace link
 * --import` / `workspace migrate`). So `enable` and `adopt` refuse `retired`
 * (nothing changes), `status` still reports where the knowledge is and adds
 * `retired: true`, and `disable` keeps working so a person can unhook an old
 * repo. The handlers stay: the Workspace code shares their helpers.
 */

import { realpathSync } from 'node:fs';
import { error as logError } from '../utils/logger.js';
import {
  KnowledgeRefusal,
  disableKnowledgeSync,
  knowledgeStatus,
  type KnowledgeAdoptResult,
  type KnowledgeDeps,
  type KnowledgeDisableResult,
  type KnowledgeEnableResult,
  type KnowledgeStatus,
} from '../handlers/knowledge-migration.js';

/** Prefix every refusal line carries — never doubled. */
const KNOWLEDGE_REFUSED_PREFIX = 'knowledge refused:';

/** How long a refusal line may run before it is truncated. */
const REASON_MAX_LENGTH = 300;

/** Every action this command answers to. */
export const KNOWLEDGE_ACTIONS = ['status', 'enable', 'disable', 'adopt'] as const;

export type KnowledgeAction = (typeof KNOWLEDGE_ACTIONS)[number];

export function isKnowledgeAction(value: string): value is KnowledgeAction {
  return (KNOWLEDGE_ACTIONS as readonly string[]).includes(value);
}

/** Everything the actions read off the command line. */
export interface KnowledgeCommandOptions {
  /** The project root. Defaults to the current directory. */
  target: string;
  /** enable: the repository the knowledge syncs with, on any git host. */
  remote?: string;
  /** enable: the branch the knowledge repo starts on (default main). */
  branch?: string;
  /** enable: delete the copies an interrupted run left in the project root. */
  cleanLeftovers?: boolean;
  /** disable: keep | vault | shared. */
  to?: string;
  /** disable: go ahead although the remote is missing commits. */
  acceptUnpushed?: boolean;
  /** Print the result object rather than the human line. */
  json?: boolean;
}

/** Test seam — production passes none. */
export interface KnowledgeRuntime {
  deps?: Partial<KnowledgeDeps>;
}

/** `status` since the hard migration: the shape as before, plus the retirement. */
export type RetiredKnowledgeStatus = KnowledgeStatus & { retired: true };

type KnowledgeResult = RetiredKnowledgeStatus | KnowledgeEnableResult | KnowledgeDisableResult | KnowledgeAdoptResult;

/** The one sentence `enable` and `adopt` refuse with. */
export const KNOWLEDGE_RETIRED_SENTENCE =
  "knowledge now syncs through the Workspace — a project's own knowledge repository is no longer started or taken up";

function retired(action: 'enable' | 'adopt'): KnowledgeRefusal {
  return new KnowledgeRefusal('retired', KNOWLEDGE_RETIRED_SENTENCE, { retired: true, replacement: 'workspace', verb: action });
}

/** The project as git spells it (macOS `/tmp` is `/private/tmp`). */
function canonicalTarget(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > REASON_MAX_LENGTH ? `${collapsed.slice(0, REASON_MAX_LENGTH - 1)}…` : collapsed;
}

function dispatch(action: KnowledgeAction, options: KnowledgeCommandOptions, runtime: KnowledgeRuntime): KnowledgeResult {
  const target = canonicalTarget(options.target);
  switch (action) {
    case 'status':
      return { ...knowledgeStatus(target, runtime.deps), retired: true };
    case 'enable':
      throw retired('enable');
    case 'disable':
      return disableKnowledgeSync(target, {
        to: options.to ?? '',
        acceptUnpushed: options.acceptUnpushed === true,
        // THE TYPED VERB IS THE CONFIRMATION (forbidden-pattern #15): the
        // handler does nothing destructive unless its caller says a person
        // asked, and a person typing `disable --to …` is exactly that.
        confirmed: true,
        ...(runtime.deps === undefined ? {} : { deps: runtime.deps }),
      });
    case 'adopt':
      throw retired('adopt');
  }
}

function renderHuman(action: KnowledgeAction, result: KnowledgeResult): string {
  if (action === 'status') {
    const status = result as RetiredKnowledgeStatus;
    const parts = [`knowledge: ${status.shape}`];
    if (status.remote !== null) parts.push(`→ ${status.remote}`);
    if (status.unpushed !== null && status.unpushed > 0) parts.push(`(${status.unpushed} unpushed)`);
    if (status.conflicted.length > 0) parts.push(`(${status.conflicted.length} conflicted)`);
    if (status.shape === 'vault-pending' && status.pointer !== null) parts.push(`(not yet taken up from ${status.pointer.url})`);
    if (status.leftovers.length > 0) parts.push(`(${status.leftovers.length} leftover cop${status.leftovers.length === 1 ? 'y' : 'ies'})`);
    parts.push('— per-project sync is retired; knowledge syncs through the Workspace');
    return parts.join(' ');
  }
  if (action === 'enable') {
    const enabled = result as KnowledgeEnableResult;
    if (enabled.status === 'unchanged') return `knowledge: already syncing with ${enabled.remote}`;
    const commitNote = enabled.codeRepo.committed
      ? `code repo committed ${enabled.codeRepo.commit?.sha.slice(0, 7) ?? ''}`
      : enabled.codeRepo.changed.length > 0
        ? `commit ${enabled.codeRepo.changed.join(', ')} in the code repo`
        : 'code repo unchanged';
    return `knowledge: sync on (from ${enabled.from}) → ${enabled.remote} on ${enabled.branch}, not pushed yet; ${commitNote}`;
  }
  if (action === 'adopt') {
    const adopted = result as KnowledgeAdoptResult;
    const beside = adopted.keptBeside.length > 0 ? `; ${adopted.keptBeside.length} differing file(s) kept beside as *.from-vault` : '';
    return `knowledge: adopted ${adopted.remote} (${adopted.copiedFromVault.length} file(s) from the vault${beside}); vault backup at ${adopted.vaultBackup}; not committed`;
  }
  const disabled = result as KnowledgeDisableResult;
  return `knowledge: sync off (${disabled.to}); history kept at ${disabled.knowledgeRepoKeptAt}`;
}

/**
 * `knowledge <action>` — on any failure: the payload line, one
 * `knowledge refused:` line, exit 1.
 */
export function runKnowledge(action: string, options: KnowledgeCommandOptions, runtime: KnowledgeRuntime = {}): void {
  try {
    if (!isKnowledgeAction(action)) {
      throw new KnowledgeRefusalLine(`unknown action '${action}' — expected ${KNOWLEDGE_ACTIONS.join('|')}`);
    }
    const result = dispatch(action, options, runtime);
    process.stdout.write(options.json === true ? `${JSON.stringify(result)}\n` : `${renderHuman(action, result)}\n`);
  } catch (error) {
    if (error instanceof KnowledgeRefusal) {
      process.stdout.write(`${JSON.stringify({ action, ...error.payload })}\n`);
      logError(`${KNOWLEDGE_REFUSED_PREFIX} ${oneLine(`${error.reason} — ${error.sentence}`)}`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logError(`${KNOWLEDGE_REFUSED_PREFIX} ${oneLine(message)}`);
    }
    process.exitCode = 1;
  }
}

/** A refusal with nothing to hand back (an unknown action). */
class KnowledgeRefusalLine extends Error {}
