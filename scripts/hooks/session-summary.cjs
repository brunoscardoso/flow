#!/usr/bin/env node
'use strict';

/**
 * Session Summary — SessionEnd Hook
 *
 * Fires when a Claude session ends. Reads ~/.claude/metrics/costs.jsonl,
 * aggregates all entries for the current session, and appends a summary entry.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const COSTS_FILE = path.join(os.homedir(), '.claude', 'metrics', 'costs.jsonl');

async function main() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString());

    const sessionId = input.session_id || 'unknown';

    if (!fs.existsSync(COSTS_FILE)) {
      process.exit(0);
      return;
    }

    const content = fs.readFileSync(COSTS_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Filter entries for this session (exclude existing summaries)
    const sessionEntries = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.session_id === sessionId && entry.type !== 'session_summary') {
          sessionEntries.push(entry);
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (sessionEntries.length === 0) {
      process.exit(0);
      return;
    }

    // Aggregate totals
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCost = 0;
    const models = new Set();

    for (const entry of sessionEntries) {
      totalInputTokens += entry.input_tokens || 0;
      totalOutputTokens += entry.output_tokens || 0;
      totalCacheCreationTokens += entry.cache_creation_tokens || 0;
      totalCacheReadTokens += entry.cache_read_tokens || 0;
      totalCost += entry.estimated_cost_usd || 0;
      if (entry.model) models.add(entry.model);
    }

    // Calculate duration from first to last entry
    const timestamps = sessionEntries
      .map(e => new Date(e.timestamp).getTime())
      .filter(t => !isNaN(t));

    let durationMinutes = 0;
    if (timestamps.length >= 2) {
      const earliest = Math.min(...timestamps);
      const latest = Math.max(...timestamps);
      durationMinutes = Math.round((latest - earliest) / 60_000);
    }

    const summary = {
      type: 'session_summary',
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      project: sessionEntries[0].project || 'unknown',
      models: Array.from(models),
      response_count: sessionEntries.length,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      total_cache_creation_tokens: totalCacheCreationTokens,
      total_cache_read_tokens: totalCacheReadTokens,
      total_cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
      duration_minutes: durationMinutes,
      hook_version: '1.0.0',
    };

    fs.appendFileSync(COSTS_FILE, JSON.stringify(summary) + '\n');
  } catch {
    // Never fail
  }

  process.exit(0);
}

main();
