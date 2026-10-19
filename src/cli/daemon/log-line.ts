/**
 * The `.heartbeat.log` line contract (#1803).
 *
 * That file is LINE-ORIENTED, and every reader counts physical lines: the
 * daemon's `truncateLog` keeps the last 500 of them believing that to be ~500
 * events, and `heartbeat status` shows the last five believing those to be the
 * five most recent things the daemon did.
 *
 * Both beliefs were false. `task-runner` passes an agent's final message — 
 * markdown, many lines — into the same one-line writer, so ONE event became a
 * dozen physical lines with a timestamp on only the first. Measured on this
 * repo's own log, 374 of the last 500 lines were spilled agent prose: 75% of
 * the retention window, cutting the daemon's event history to a quarter of its
 * intended depth, in the file two `heartbeat` messages tell the user to go and
 * read when something goes wrong. And the "Recent log" block showed five
 * fragments of a table instead of five events.
 *
 * THE WRITER ENFORCES IT, not the call sites. There were four places slicing
 * agent output into `log()`, and a fifth would have been written eventually
 * (allowed-pattern #14).
 */

/** Ellipsis marking text that was cut, so a clipped line reads as clipped. */
const ELLIPSIS = '…';

/**
 * Flatten anything into exactly one physical log line.
 *
 * Newlines, carriage returns and tabs all collapse to a single space — the log
 * cannot represent them, and pretending otherwise is what broke every reader
 * that counts lines. Runs of whitespace collapse too, because a markdown table
 * flattened verbatim is mostly padding.
 */
export function oneLogLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

/**
 * Cut text to at most `max` characters, on a word boundary.
 *
 * A RAW `slice(0, 500)` SEVERS MID-TOKEN. The live artifact ended at
 * `| [#1795](https:/` — character 500 landing inside a URL, which reads as
 * corruption rather than as truncation. Cutting back to the last space and
 * marking the cut says what happened.
 *
 * The boundary is abandoned when it would throw away most of the budget: a
 * single 500-character token has no space to fall back to, and returning almost
 * nothing would be worse than a hard cut.
 */
export function clipToWord(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const lastSpace = head.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? head.slice(0, lastSpace) : head;
  return `${cut.trimEnd()}${ELLIPSIS}`;
}

/**
 * One log line built from a label and a block of captured process output.
 *
 * The single call every `task-runner` site makes, so the flattening and the
 * clipping cannot be remembered in three places and forgotten in the fourth.
 */
export function outputLogLine(label: string, output: string, max: number): string {
  return oneLogLine(`  ${label}: ${clipToWord(oneLogLine(output), max)}`);
}

/**
 * Whether a line is a daemon EVENT — one this log's writer produced.
 *
 * `heartbeat status` shows "the last five lines" as if they were the last five
 * events. Going forward every line is one; a log written before this fix still
 * holds continuation lines, and a reader asking what the daemon did should not
 * be shown the middle of an agent's markdown table because of them.
 */
export function isDaemonEvent(line: string): boolean {
  return /^\[\d{4}-\d{2}-\d{2}T/.test(line);
}
