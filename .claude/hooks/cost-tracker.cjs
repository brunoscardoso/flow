#!/usr/bin/env node
'use strict';

/**
 * Cost Tracker — Stop Hook
 *
 * Fires after every Claude response. Reads the transcript JSONL to extract
 * token usage from the last assistant message and appends a cost entry
 * to ~/.claude/metrics/costs.jsonl.
 *
 * Configured as async: true so it never blocks the response display.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_VERSION = '1.2.0';

// Pricing per 1M tokens (USD) — update when Anthropic changes pricing.
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

// Cache read tokens are 10% of input cost
const CACHE_READ_DISCOUNT = 0.1;

const METRICS_DIR = path.join(os.homedir(), '.claude', 'metrics');
const COSTS_FILE = path.join(METRICS_DIR, 'costs.jsonl');
// Rotation threshold by SIZE, not line count — checking lines meant reading
// the whole costs file on every turn (#1670). ~4 MB ≈ 10,000 typical entries.
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_ROTATED = 3;
// Per-session running totals live OUTSIDE costs.jsonl so the display hook
// reads one tiny file per turn instead of scanning history, and the total
// survives rotation (#1698). Keep path + shape in sync with cost-display.cjs.
const SESSIONS_DIR = path.join(METRICS_DIR, 'sessions');
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function getProjectName(cwd) {
  if (!cwd) return 'unknown';
  return path.basename(cwd);
}

/**
 * Resolve a model id to a pricing row AND say how it was resolved: `exact`
 * is true only for a direct table hit. Every other path — substring match,
 * family fallback, default — is a guess, and the caller marks the written
 * entry so a consumer can always tell a looked-up price from a guessed one.
 */
function findModelPricing(model) {
  // Exact match
  if (model && PRICING[model]) {
    return { pricing: PRICING[model], pricedAs: model, exact: true };
  }

  // Partial match (e.g., a dated variant of a known model)
  const modelLower = (model || '').toLowerCase();
  if (modelLower) {
    for (const [key, value] of Object.entries(PRICING)) {
      if (modelLower.includes(key) || key.includes(modelLower)) {
        return { pricing: value, pricedAs: key, exact: false };
      }
    }
  }

  // Fallback by family
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

// The last assistant entry lives at the END of the transcript, and the file
// only grows — so read a bounded tail instead of the whole file (#1670).
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
      } catch {
        // Skip malformed lines
      }
    }

    if (start === 0) return null; // whole file scanned
  }
}

// Session ids come from hook stdin — flatten anything path-hostile before
// using one as a filename. Keep in sync with cost-display.cjs.
function sessionTotalPath(sessionId) {
  return path.join(SESSIONS_DIR, sessionId.replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
}

function updateSessionTotal(sessionId, cost) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const file = sessionTotalPath(sessionId);

    let total = 0;
    let count = 0;
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf-8'));
      total = prev.total_cost_usd || 0;
      count = prev.count || 0;
    } catch { /* first entry for this session */ }

    const next = {
      session_id: sessionId,
      total_cost_usd: Math.round((total + cost) * 1_000_000) / 1_000_000,
      count: count + 1,
      updated_at: new Date().toISOString(),
    };

    // Write-then-rename so the synchronous display hook never reads a
    // half-written file.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next) + '\n');
    fs.renameSync(tmp, file);
  } catch {
    // Non-fatal — a missed sidecar update costs one turn of session display
  }
}

function pruneSessionTotals() {
  try {
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      const p = path.join(SESSIONS_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch { /* skip */ }
    }
  } catch {
    // Non-fatal — nothing to prune, or the directory does not exist yet
  }
}

function rotateIfNeeded() {
  if (!fs.existsSync(COSTS_FILE)) return;

  try {
    // stat, not a full read — the size check costs the same on turn 10,000
    // as on turn 1 (#1670).
    if (fs.statSync(COSTS_FILE).size < MAX_BYTES) return;

    // Rotate: rename current file with date suffix
    const date = new Date().toISOString().slice(0, 10);
    const rotatedPath = path.join(METRICS_DIR, `costs.${date}.jsonl`);
    fs.renameSync(COSTS_FILE, rotatedPath);

    // Clean old rotated files — keep last N
    const files = fs.readdirSync(METRICS_DIR)
      .filter(f => f.startsWith('costs.') && f.endsWith('.jsonl') && f !== 'costs.jsonl')
      .sort()
      .reverse();

    for (let i = KEEP_ROTATED; i < files.length; i++) {
      fs.unlinkSync(path.join(METRICS_DIR, files[i]));
    }

    // Same rare moment cleans the session sidecars — a per-turn readdir
    // would put a directory scan back on the path #1670 cleared.
    pruneSessionTotals();
  } catch {
    // Non-fatal — rotation failure shouldn't block tracking
  }
}

async function main() {
  try {
    // Read stdin JSON
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString());

    const transcriptPath = input.transcript_path;
    const sessionId = input.session_id || 'unknown';
    const cwd = input.cwd || process.cwd();

    // Find last assistant message with usage data
    const entry = findLastAssistantEntry(transcriptPath);
    if (!entry) {
      process.exit(0);
      return;
    }

    const usage = entry.message.usage;
    const model = entry.message.model || 'unknown';
    const { pricing, pricedAs, exact } = findModelPricing(model);
    const cost = calculateCost(usage, pricing);

    const logEntry = {
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      project: getProjectName(cwd),
      model: model,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_creation_tokens: usage.cache_creation_input_tokens || 0,
      cache_read_tokens: usage.cache_read_input_tokens || 0,
      estimated_cost_usd: Math.round(cost * 1_000_000) / 1_000_000,
      // A guessed price carries the row it was priced as, so downstream
      // displays can label the number as an estimate (#1669).
      ...(exact ? {} : { priced_as: pricedAs, pricing_fallback: true }),
      hook_version: HOOK_VERSION,
    };

    // Ensure metrics directory exists
    fs.mkdirSync(METRICS_DIR, { recursive: true });

    // Rotate if needed
    rotateIfNeeded();

    // Append to JSONL
    fs.appendFileSync(COSTS_FILE, JSON.stringify(logEntry) + '\n');

    // Keep the per-session running total the display hook reads (#1698)
    updateSessionTotal(sessionId, cost);
  } catch {
    // Never fail — always exit 0
  }

  process.exit(0);
}

main();
