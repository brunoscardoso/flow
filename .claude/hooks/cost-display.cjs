#!/usr/bin/env node
'use strict';

/**
 * Cost Display — Stop Hook (synchronous)
 *
 * Fires after every Claude response. Reads the transcript to extract
 * token usage from the last assistant message and prints a compact
 * cost summary line to stderr.
 *
 * Configured as synchronous (no async flag) so it displays immediately.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Pricing per 1M tokens (USD) — keep in sync with cost-tracker.cjs.
// Rates from the Anthropic models overview (cached 2026-06-24). Iteration
// order matters for substring matching: newer models first, so a dated
// variant of a current model matches its own generation's row.
const PRICING = {
  'claude-fable-5-1': { input: 10.00, output: 50.00 },
  'claude-mythos-5-1': { input: 10.00, output: 50.00 },
  'claude-fable-5': { input: 10.00, output: 50.00 },
  'claude-mythos-5': { input: 10.00, output: 50.00 },
  'claude-opus-5-5': { input: 4.00, output: 20.00 },
  'claude-opus-5': { input: 5.00, output: 25.00 },
  'claude-opus-4-8': { input: 5.00, output: 25.00 },
  'claude-opus-4-7': { input: 5.00, output: 25.00 },
  'claude-opus-4-6': { input: 5.00, output: 25.00 },
  'claude-sonnet-5-5': { input: 2.00, output: 10.00 },
  'claude-sonnet-5': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-5-20250514': { input: 3.00, output: 15.00 },
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
};

const CACHE_READ_DISCOUNT = 0.1;
// Per-session running totals maintained by cost-tracker.cjs (#1698) — one
// tiny file per session, so this synchronous hook never scans costs.jsonl
// and the total survives its rotation. Keep path + shape in sync.
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'metrics', 'sessions');

/**
 * Resolve a model id to a pricing row AND say how it was resolved: `exact`
 * is true only for a direct table hit — anything else is a guess, shown
 * with a `~` so the user can tell a looked-up price from an estimate.
 */
function findModelPricing(model) {
  if (model && PRICING[model]) {
    return { pricing: PRICING[model], pricedAs: model, exact: true };
  }

  const modelLower = (model || '').toLowerCase();
  if (modelLower) {
    for (const [key, value] of Object.entries(PRICING)) {
      if (modelLower.includes(key) || key.includes(modelLower)) {
        return { pricing: value, pricedAs: key, exact: false };
      }
    }
  }

  let key = 'claude-sonnet-5-5';
  if (modelLower.includes('fable') || modelLower.includes('mythos')) key = 'claude-fable-5-1';
  else if (modelLower.includes('haiku')) key = 'claude-haiku-5-5';
  else if (modelLower.includes('opus')) key = 'claude-opus-5-5';
  return { pricing: PRICING[key], pricedAs: key, exact: false };
}

function calculateCost(usage, pricing) {
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage.cache_read_input_tokens || 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheCreationCost = (cacheCreationTokens / 1_000_000) * pricing.input;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.input * CACHE_READ_DISCOUNT;

  return inputCost + outputCost + cacheCreationCost + cacheReadCost;
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function getModelShort(model) {
  if (!model) return '?';
  if (model.includes('haiku')) return 'haiku';
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('fable')) return 'fable';
  if (model.includes('mythos')) return 'mythos';
  return model.split('-').slice(-1)[0];
}

function getSessionTotal(sessionId) {
  if (!sessionId) return null;

  // Read the sidecar cost-tracker maintains instead of summing costs.jsonl —
  // the scan #1670 removed from the transcript path had survived here, a
  // full-file read and parse on every synchronous Stop firing (#1698).
  try {
    const file = path.join(SESSIONS_DIR, sessionId.replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
    const entry = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const totalCost = entry.total_cost_usd || 0;
    const count = entry.count || 0;
    return count > 0 ? { totalCost, count } : null;
  } catch {
    return null;
  }
}

// The last assistant entry lives at the END of the transcript, and the file
// only grows — so read a bounded tail instead of the whole file (#1670).
// Keep in sync with cost-tracker.cjs.
const TAIL_BYTES = 256 * 1024;

function readTail(filePath, start, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf-8', 0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function findLastAssistantEntry(transcriptPath) {
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
      text = readTail(transcriptPath, start, size - start);
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
          return entry;
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

    const transcriptPath = input.transcript_path;
    const sessionId = input.session_id;

    const entry = findLastAssistantEntry(transcriptPath);
    if (!entry) {
      process.exit(0);
      return;
    }

    const usage = entry.message.usage;
    const model = entry.message.model || 'unknown';
    const { pricing, exact } = findModelPricing(model);
    const cost = calculateCost(usage, pricing);

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;

    // Build compact display line. A `~` marks a cost computed from a
    // guessed pricing row (model not in the table) — see #1669.
    const modelName = getModelShort(model);
    const estimateMark = exact ? '' : '~';
    const costStr = estimateMark + (cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`);

    let line = `\x1b[2m⟐ ${modelName} · in:${formatTokens(inputTokens)} out:${formatTokens(outputTokens)}`;
    if (cacheReadTokens > 0) {
      line += ` cache:${formatTokens(cacheReadTokens)}`;
    }
    line += ` · ${costStr}`;

    // Add session total if available
    const session = getSessionTotal(sessionId);
    if (session && session.count > 1) {
      const sessionCostStr = session.totalCost < 0.01
        ? `$${session.totalCost.toFixed(4)}`
        : `$${session.totalCost.toFixed(2)}`;
      line += ` (session: ${sessionCostStr})`;
    }

    line += '\x1b[0m';

    process.stderr.write(line + '\n');
  } catch {
    // Never fail
  }

  process.exit(0);
}

main();
