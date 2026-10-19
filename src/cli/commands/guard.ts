/**
 * Guard CLI command — `planflow-ai guard classify`.
 *
 * The single code path (allowed-pattern #14) the autonomous `/execute-plan`
 * skill calls before crossing a dangerous seam: a `GuardAction` JSON goes in,
 * a deterministic `GuardDecision` JSON comes out. The model consult for
 * `consult` verdicts lives in the skill — this verb never calls a model.
 *
 * Contract (mirrors `permissions suggest` / `plan compile` conventions):
 *
 *   - Input: the action JSON from `--action <json>`, else all of stdin.
 *   - Success: the decision JSON via `process.stdout.write`, exit 0.
 *   - Refusal: ONE `guard refused: <reason>` line via the repo logger (which
 *     routes through console.log — allowed-pattern #15), exit code 1, nothing
 *     else written. Empty/unreadable input, malformed JSON, and unknown action
 *     kinds all refuse.
 *   - Deterministic: the decision is a pure function of the input action.
 */

import { error as logError } from '../utils/logger.js';
import { classifyGuardAction } from '../state/guard-classifier.js';
import type { GuardAction } from '../state/guard-types.js';

/** Prefix every refusal line carries — never doubled. */
const GUARD_REFUSED_PREFIX = 'guard refused:';

/** The action kinds the classifier understands. */
const KNOWN_ACTION_KINDS = ['push', 'pr-create', 'commit', 'delete', 'bash'] as const;

/**
 * Normalize any thrown error into a single `guard refused: <reason>` line.
 * Errors already carrying the prefix pass through untouched.
 */
function toRefusalLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(GUARD_REFUSED_PREFIX)) {
    return message;
  }
  return `${GUARD_REFUSED_PREFIX} ${message}`;
}

/** Read all of stdin as UTF-8 text (fail-soft: empty string when nothing piped). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse + minimally validate the raw action JSON into a `GuardAction`. Throws
 * a plain-message Error (folded into the refusal line by the caller) on empty
 * input, malformed JSON, non-object shapes, or an unknown/absent `kind`.
 */
function parseAction(raw: string): GuardAction {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('missing action — pass --action <json> or pipe it on stdin');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('malformed action JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('action must be a JSON object');
  }

  const kind = (parsed as { kind?: unknown }).kind;
  if (typeof kind !== 'string') {
    throw new Error('missing action kind');
  }
  if (!(KNOWN_ACTION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown action kind "${kind}"`);
  }

  return parsed as GuardAction;
}

/**
 * `guard classify [--action <json>]` — classify one dangerous action into a
 * deterministic decision. The action JSON comes from `--action` or stdin; the
 * decision JSON is written to stdout (exit 0). On any failure: one
 * `guard refused:` line, exit 1, nothing else written.
 */
export async function runGuardClassify(options: { action?: string }): Promise<void> {
  try {
    const raw = options.action ?? (await readStdin());
    const action = parseAction(raw);
    const decision = classifyGuardAction(action);
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch (error) {
    logError(toRefusalLine(error));
    process.exitCode = 1;
  }
}
