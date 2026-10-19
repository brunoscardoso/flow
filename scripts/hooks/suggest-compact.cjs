#!/usr/bin/env node
'use strict';

/**
 * Suggest Compact — Stop Hook (synchronous)
 *
 * Fires after every Claude response. Reads the transcript to check
 * context window usage on the last assistant message. Under prompt
 * caching the context sits almost entirely in cache_read/cache_creation
 * tokens — input_tokens is only the uncached remainder — so usage is the
 * SUM of all three (#1699). When it exceeds thresholds, prints a warning
 * to stderr suggesting the user run /compact before auto-compaction
 * kicks in.
 *
 * Thresholds are a FRACTION of the answering model's own context window
 * (#1956), not of a constant. The window used to be hardcoded at 200K while
 * the models in use run to ~1M: measured over 5,113 recorded calls, 46.6% of
 * them tripped the yellow line and 44.0% the red "run /compact NOW" line, so
 * the one compaction signal in the system was wallpaper. At a genuine 90% of a
 * 1M window it printed "Context 450% full (900K/200K)".
 *
 * Thresholds:
 *   - 70% of the window: yellow warning
 *   - 80% of the window: red critical warning
 *   - Every ~50 tool calls: dim suggestion (if below 70%)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const WARN_THRESHOLD = 0.70;
const CRIT_THRESHOLD = 0.80;
const TOOL_CALL_INTERVAL = 50;
const MIN_TOKEN_GROWTH = 10_000;

/**
 * The window for a model nothing else identifies. Kept at the old constant so
 * a model this hook has never seen behaves exactly as before — but it is a
 * FLOOR, raised by both of the rules below, never a ceiling.
 */
const CONTEXT_WINDOW_FALLBACK = 200_000;

/**
 * Windows this machine's own recorded calls demonstrate, by model family.
 *
 * These are not published figures — they are the largest context the sibling
 * cost-tracker hook actually logged for each family, which is a LOWER bound on
 * the real window, rounded to the tier it obviously belongs to:
 *
 *   claude-opus-4-8   999,689 over 1,107 calls
 *   claude-opus-5     996,388 over   935 calls
 *   claude-opus-5-5   964,964 over   438 calls
 *   claude-fable-5    997,054 over   389 calls
 *
 * Sonnet is deliberately absent even though `claude-sonnet-5` was recorded at
 * 224,517 — above the fallback, so its window is provably not 200K, but 433
 * calls never came close enough to say which tier it is. Guessing it here
 * would be inventing a number; `learnedWindow` below reaches the truth from
 * use instead, and until it does the only cost is a warning that fires early.
 */
const FAMILY_WINDOWS = [
  [/(^|[^a-z])opus([^a-z]|$)/, 1_000_000],
  [/(^|[^a-z])fable([^a-z]|$)/, 1_000_000],
];

/** A model id may name its own window, as `claude-opus-5[1m]` does. */
const EXPLICIT_WINDOW = /\[(\d+)m\]|-(\d+)m($|[^a-z0-9])/;

/** Windows come in tiers; an observation is rounded up to the one it fits. */
const WINDOW_TIERS = [200_000, 500_000, 1_000_000];

const STATE_DIR = path.join(os.homedir(), '.claude', 'metrics');
const STATE_FILE = path.join(STATE_DIR, 'compact-state.json');
/** model id → the largest context ever observed for it on this machine. */
const WINDOWS_FILE = path.join(STATE_DIR, 'model-windows.json');

/** The smallest tier that holds `tokens`, or `tokens` rounded up to 100K. */
function tierFor(tokens) {
  for (const tier of WINDOW_TIERS) {
    if (tokens <= tier) return tier;
  }
  return Math.ceil(tokens / 100_000) * 100_000;
}

function loadLearnedWindows() {
  try {
    const data = JSON.parse(fs.readFileSync(WINDOWS_FILE, 'utf-8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveLearnedWindows(windows) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(WINDOWS_FILE, JSON.stringify(windows), 'utf-8');
  } catch { /* ignore */ }
}

/**
 * The context window to measure `contextTokens` against.
 *
 * Four sources, strongest first, and the result is the LARGEST of them — every
 * one of them is evidence that the window is at least this big, and none is
 * evidence that it is smaller:
 *
 *   1. the id saying so (`claude-opus-5[1m]`)
 *   2. a family this machine has recorded running to a known tier
 *   3. the largest context previously seen for this exact model
 *   4. this turn's own context — a model that is holding 900K tokens has a
 *      window of at least 900K, whatever any table says
 *
 * (4) is what makes the number honest when the table is stale, which it will
 * be: the percentage can never exceed 100, so the absurd "450% full" that
 * started this is unreachable by construction rather than by maintenance.
 */
function resolveContextWindow(model, contextTokens, learned) {
  let window = CONTEXT_WINDOW_FALLBACK;
  const id = (model || '').toLowerCase();

  const explicit = EXPLICIT_WINDOW.exec(id);
  if (explicit) {
    const millions = Number(explicit[1] || explicit[2]);
    if (Number.isFinite(millions) && millions > 0) {
      window = Math.max(window, millions * 1_000_000);
    }
  }

  for (const [pattern, size] of FAMILY_WINDOWS) {
    if (pattern.test(id)) window = Math.max(window, size);
  }

  const seen = learned[id];
  if (typeof seen === 'number' && seen > 0) window = Math.max(window, tierFor(seen));

  return Math.max(window, tierFor(contextTokens));
}

function loadState(sessionId) {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (data.session_id === sessionId) return data;
    }
  } catch { /* ignore */ }
  return {
    session_id: sessionId,
    last_suggested_at: 0,
    tool_calls_at_last_suggest: 0,
    transcript_offset: 0,
    tool_calls_total: 0,
  };
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8');
  } catch { /* ignore */ }
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return String(n);
}

// The transcript only grows and the last assistant entry lives at the END —
// read a bounded tail instead of the whole file (#1670, ported here by
// #1700). Keep in sync with cost-tracker.cjs / cost-display.cjs.
const TAIL_BYTES = 256 * 1024;

function readSlice(filePath, start, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function countLineToolCalls(line) {
  try {
    const entry = JSON.parse(line);
    if (entry.type === 'assistant' && entry.message && entry.message.content) {
      const blocks = Array.isArray(entry.message.content)
        ? entry.message.content
        : [entry.message.content];
      let count = 0;
      for (const block of blocks) {
        if (block.type === 'tool_use') count++;
      }
      return count;
    }
  } catch { /* skip */ }
  return 0;
}

/**
 * Running tool-call total: parse only the bytes appended since the offset
 * saved in compact-state.json, never the whole transcript (#1700). Only
 * complete lines advance the offset — the file may end mid-write — and a
 * transcript smaller than the offset (rewritten, e.g. by compaction)
 * resets the count.
 */
function countToolCalls(transcriptPath, state) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;

  try {
    const size = fs.statSync(transcriptPath).size;
    let offset = state.transcript_offset || 0;
    let total = state.tool_calls_total || 0;

    if (size < offset) {
      offset = 0;
      total = 0;
    }

    if (size > offset) {
      const buf = readSlice(transcriptPath, offset, size - offset);
      const lastNewline = buf.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        const text = buf.toString('utf-8', 0, lastNewline);
        for (const line of text.split('\n')) {
          total += countLineToolCalls(line);
        }
        offset += lastNewline + 1;
      }
    }

    state.transcript_offset = offset;
    state.tool_calls_total = total;
    return total;
  } catch {
    return state.tool_calls_total || 0;
  }
}

function findLastAssistantUsage(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return null;
  }

  // Grow the window only if the tail holds no assistant line (e.g. one
  // giant tool-result line) — the common case is a single bounded read.
  for (let window = TAIL_BYTES; ; window *= 4) {
    const start = Math.max(0, size - window);
    let text;
    try {
      text = readSlice(transcriptPath, start, size - start).toString('utf-8');
    } catch {
      return null;
    }

    const lines = text.split('\n');
    // A window that starts mid-file begins mid-line — skip that fragment.
    const first = start > 0 ? 1 : 0;
    for (let i = lines.length - 1; i >= first; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message && entry.message.usage) {
          // The MODEL comes back with the usage: the window to measure against
          // is a property of whichever model answered, and this is the only
          // place that knows which one it was (#1956).
          return { usage: entry.message.usage, model: entry.message.model || '' };
        }
      } catch { /* skip */ }
    }

    if (start === 0) return null; // whole file scanned
  }
}

async function main() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString());

    if (input.stop_hook_active) {
      process.exit(0);
      return;
    }

    const transcriptPath = input.transcript_path;
    const sessionId = input.session_id || 'unknown';

    const last = findLastAssistantUsage(transcriptPath);
    if (!last) {
      process.exit(0);
      return;
    }
    const usage = last.usage;

    const state = loadState(sessionId);
    // Tokens actually occupying the window — under prompt caching,
    // input_tokens alone is ~0 and the thresholds could never fire (#1699).
    const contextTokens = (usage.input_tokens || 0)
      + (usage.cache_read_input_tokens || 0)
      + (usage.cache_creation_input_tokens || 0);
    // Learn before resolving: this turn's own context is evidence about the
    // model's window, and the next turn should not have to rediscover it.
    const learned = loadLearnedWindows();
    const modelId = (last.model || '').toLowerCase();
    if (modelId && contextTokens > (learned[modelId] || 0)) {
      learned[modelId] = contextTokens;
      saveLearnedWindows(learned);
    }

    const contextWindow = resolveContextWindow(last.model, contextTokens, learned);
    const ratio = contextTokens / contextWindow;
    const pct = Math.round(ratio * 100);

    let shouldWarn = false;
    let message = '';

    // Check context window usage
    if (ratio >= CRIT_THRESHOLD) {
      message = `\x1b[31m⚠ Context ${pct}% full (${formatTokens(contextTokens)}/${formatTokens(contextWindow)}) — run /compact NOW before auto-compaction loses context\x1b[0m`;
      shouldWarn = true;
    } else if (ratio >= WARN_THRESHOLD) {
      message = `\x1b[33m⚠ Context ${pct}% full (${formatTokens(contextTokens)}/${formatTokens(contextWindow)}) — consider running /compact soon\x1b[0m`;
      shouldWarn = true;
    }

    // Check tool call count (secondary signal, only when below warn
    // threshold). Runs every turn — the incremental count is cheap and
    // keeps the byte offset current (#1700).
    const toolCalls = countToolCalls(transcriptPath, state);
    const toolCallsSinceLast = toolCalls - (state.tool_calls_at_last_suggest || 0);

    if (!shouldWarn && toolCallsSinceLast >= TOOL_CALL_INTERVAL) {
      message = `\x1b[2m⟐ ${toolCalls} tool calls this session (context ${pct}%) — /compact if conversation feels slow\x1b[0m`;
      shouldWarn = true;
    }

    // Suppress non-critical warnings if context hasn't grown enough
    if (shouldWarn && ratio < CRIT_THRESHOLD && state.last_suggested_at > 0) {
      const tokenGrowth = contextTokens - state.last_suggested_at;
      if (tokenGrowth < MIN_TOKEN_GROWTH) {
        shouldWarn = false;
      }
    }

    if (shouldWarn && message) {
      process.stderr.write(message + '\n');

      state.last_suggested_at = contextTokens;
      state.tool_calls_at_last_suggest = toolCalls;
    }

    // Persist every turn — the transcript offset must advance even on
    // quiet turns, or the next turn re-parses the same bytes (#1700).
    saveState(state);
  } catch {
    // Never fail
  }

  process.exit(0);
}

main();
