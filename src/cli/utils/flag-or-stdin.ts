import { readFileSync } from 'node:fs';

const STDIN_SENTINEL = '-';

function isStdinSentinel(flag: string | undefined): boolean {
  return flag !== undefined && flag.trim() === STDIN_SENTINEL;
}

/** A leading byte-order mark some Windows pipelines prepend to piped text. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Read all of stdin as UTF-8 text, streamed (fail-soft: empty string when nothing piped). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return stripBom(Buffer.concat(chunks).toString('utf8'));
}

/** Read all of stdin as UTF-8 text, synchronously (fail-soft: empty string when nothing piped). */
export function readStdinSync(): string {
  try {
    return stripBom(readFileSync(0, 'utf-8'));
  } catch {
    return '';
  }
}

/**
 * A flag's value, or stdin when the flag is exactly `-`.
 *
 * The sentinel is EXPLICIT rather than "read stdin when the flag is absent"
 * (guard's rule), because a flag using this convention is often OPTIONAL — a
 * `wontfix` close carries no evidence at all — and an implicit fallback would
 * leave those calls blocked on a stdin nobody is going to write to.
 *
 * This is also the fix for a Windows-only defect (#loop-fix-6): the `.cmd`
 * shim every IDE-launched agent session runs `planflow-ai` through is invoked
 * via `cmd.exe /c`, whose command-line parser treats a literal newline inside
 * an argument as a statement separator — everything after the first line of a
 * multi-line flag value is silently dropped before the shim's own script ever
 * runs, and a handful of ordinary shell metacharacters (`<<`, parens, mixed
 * quotes) break the invocation outright. Piping the value over stdin bypasses
 * that parser entirely, which is why every flag that may carry prose or
 * multi-line text accepts `-` for "read it from stdin instead."
 */
export async function flagOrStdin(flag: string | undefined): Promise<string> {
  if (flag === undefined) return '';
  if (isStdinSentinel(flag)) return readStdin();
  return flag;
}

/** The synchronous counterpart of {@link flagOrStdin}, for call sites that cannot be async. */
export function flagOrStdinSync(flag: string | undefined): string {
  if (flag === undefined) return '';
  if (isStdinSentinel(flag)) return readStdinSync();
  return flag;
}