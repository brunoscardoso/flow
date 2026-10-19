/**
 * Tests for cost-tracker.cjs and session-summary.cjs hook scripts
 *
 * These tests spawn the hook scripts as child processes with mock stdin data
 * and verify the JSONL output written to a temp metrics file.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');
const COST_TRACKER = join(PROJECT_ROOT, 'scripts', 'hooks', 'cost-tracker.cjs');
const COST_DISPLAY = join(PROJECT_ROOT, 'scripts', 'hooks', 'cost-display.cjs');
const SESSION_SUMMARY = join(PROJECT_ROOT, 'scripts', 'hooks', 'session-summary.cjs');
const SUGGEST_COMPACT = join(PROJECT_ROOT, 'scripts', 'hooks', 'suggest-compact.cjs');

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `plan-flow-hooks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Create a fake transcript JSONL file with an assistant entry containing usage data.
 */
function createTranscript(
  dir: string,
  usage: Record<string, number>,
  model = 'claude-sonnet-4-6'
): string {
  const transcriptPath = join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model,
        usage: {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_tokens || 0,
          cache_read_input_tokens: usage.cache_read_tokens || 0,
        },
      },
    }),
  ];
  writeFileSync(transcriptPath, lines.join('\n') + '\n');
  return transcriptPath;
}

/**
 * Run a hook script with given stdin JSON, using a custom HOME to control metrics path.
 */
function runHook(
  script: string,
  stdinData: Record<string, unknown>,
  homeDir: string
): void {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(stdinData),
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    timeout: 5000,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`hook exited ${result.status}: ${result.stderr}`);
  }
}

/**
 * Run a hook and return its combined output — cost-display writes its line
 * to stderr, so the assertion needs the merged transcript.
 */
function runHookCapture(
  script: string,
  stdinData: Record<string, unknown>,
  homeDir: string
): string {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(stdinData),
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    timeout: 5000,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`hook exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout + result.stderr;
}

describe('cost-tracker.cjs', () => {
  let tempDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fakeHome = join(tempDir, 'home');
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should log token usage from transcript to costs.jsonl', () => {
    const transcriptPath = createTranscript(tempDir, {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_tokens: 200,
      cache_read_tokens: 100,
    });

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: 'test-session-1',
      cwd: '/home/user/my-project',
    }, fakeHome);

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    expect(existsSync(costsFile)).toBe(true);

    const content = readFileSync(costsFile, 'utf-8').trim();
    const entry = JSON.parse(content);

    expect(entry.session_id).toBe('test-session-1');
    expect(entry.project).toBe('my-project');
    expect(entry.model).toBe('claude-sonnet-4-6');
    expect(entry.input_tokens).toBe(1000);
    expect(entry.output_tokens).toBe(500);
    expect(entry.cache_creation_tokens).toBe(200);
    expect(entry.cache_read_tokens).toBe(100);
    expect(entry.estimated_cost_usd).toBeGreaterThan(0);
    expect(entry.hook_version).toBe('1.2.0');
    // Exact table hit — no fallback marker.
    expect(entry.pricing_fallback).toBeUndefined();
    expect(entry.priced_as).toBeUndefined();
  });

  it('should calculate cost correctly for Opus model', () => {
    const transcriptPath = createTranscript(
      tempDir,
      { input_tokens: 1000000, output_tokens: 100000 },
      'claude-opus-4-6'
    );

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: 'opus-test',
      cwd: '/tmp/test',
    }, fakeHome);

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    const entry = JSON.parse(readFileSync(costsFile, 'utf-8').trim());

    // Opus 4.6: input $5/M, output $25/M
    // 1M input = $5, 100K output = $2.50
    const expectedCost = 5.0 + 2.5;
    expect(entry.estimated_cost_usd).toBeCloseTo(expectedCost, 2);
  });

  it('prices current-generation models from the table, with no fallback marker', () => {
    const transcriptPath = createTranscript(
      tempDir,
      { input_tokens: 1000000, output_tokens: 1000000 },
      'claude-fable-5'
    );

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: 'fable-test',
      cwd: '/tmp/test',
    }, fakeHome);

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    const entry = JSON.parse(readFileSync(costsFile, 'utf-8').trim());

    // Fable 5: input $10/M, output $50/M
    expect(entry.estimated_cost_usd).toBeCloseTo(60.0, 2);
    expect(entry.pricing_fallback).toBeUndefined();
    expect(entry.priced_as).toBeUndefined();
  });

  it('prices Opus 5.5 at its own current rate, exactly', () => {
    const transcriptPath = createTranscript(
      tempDir,
      { input_tokens: 1000000, output_tokens: 1000000 },
      'claude-opus-5-5'
    );

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: 'opus-55-test',
      cwd: '/tmp/test',
    }, fakeHome);

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    const entry = JSON.parse(readFileSync(costsFile, 'utf-8').trim());

    // Opus 5.5: input $4/M, output $20/M — a direct table hit, not a guess.
    expect(entry.estimated_cost_usd).toBeCloseTo(4.0 + 20.0, 2);
    expect(entry.pricing_fallback).toBeUndefined();
    expect(entry.priced_as).toBeUndefined();
  });

  it('marks an unknown model as a guessed price (#1669)', () => {
    const transcriptPath = createTranscript(
      tempDir,
      { input_tokens: 1000000, output_tokens: 1000000 },
      'claude-nova-9000'
    );

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: 'unknown-model-test',
      cwd: '/tmp/test',
    }, fakeHome);

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    const entry = JSON.parse(readFileSync(costsFile, 'utf-8').trim());

    // Unknown model falls back to the latest sonnet rates — and SAYS so.
    expect(entry.pricing_fallback).toBe(true);
    expect(entry.priced_as).toBe('claude-sonnet-5-5');
    expect(entry.estimated_cost_usd).toBeCloseTo(2.0 + 10.0, 2);
  });

  it('marks a dated variant of a known model as priced by substring match', () => {
    const transcriptPath = createTranscript(
      tempDir,
      { input_tokens: 1000000, output_tokens: 1000000 },
      'claude-opus-5-20260901'
    );

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: 'variant-test',
      cwd: '/tmp/test',
    }, fakeHome);

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    const entry = JSON.parse(readFileSync(costsFile, 'utf-8').trim());

    // Substring match onto claude-opus-5 — priced right, but still marked
    // as non-exact so consumers can tell.
    expect(entry.pricing_fallback).toBe(true);
    expect(entry.priced_as).toBe('claude-opus-5');
    expect(entry.estimated_cost_usd).toBeCloseTo(5.0 + 25.0, 2);
  });

  it('should calculate cost correctly for Haiku model', () => {
    const transcriptPath = createTranscript(
      tempDir,
      { input_tokens: 1000000, output_tokens: 1000000 },
      'claude-haiku-4-5-20251001'
    );

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: 'haiku-test',
      cwd: '/tmp/test',
    }, fakeHome);

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    const entry = JSON.parse(readFileSync(costsFile, 'utf-8').trim());

    // Haiku 4.5: input $1.00/M, output $5.00/M
    const expectedCost = 1.00 + 5.00;
    expect(entry.estimated_cost_usd).toBeCloseTo(expectedCost, 2);
  });

  it('should handle missing transcript gracefully', () => {
    // No transcript file — should exit cleanly
    expect(() => {
      runHook(COST_TRACKER, {
        transcript_path: '/nonexistent/path.jsonl',
        session_id: 'missing-transcript',
        cwd: '/tmp/test',
      }, fakeHome);
    }).not.toThrow();

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    expect(existsSync(costsFile)).toBe(false);
  });

  it('finds the last assistant entry with a bounded tail read on a large transcript (#1670)', () => {
    // Build a transcript much larger than the 256 KB tail window, with the
    // assistant entry at the end — the hook must still find it.
    const transcriptPath = join(tempDir, 'big-transcript.jsonl');
    const noiseLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'x'.repeat(1024) },
    });
    const lines = Array.from({ length: 2000 }, () => noiseLine); // ~2 MB
    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1234, output_tokens: 56 },
        },
      })
    );
    writeFileSync(transcriptPath, lines.join('\n') + '\n');

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: 'big-transcript-test',
      cwd: '/tmp/test',
    }, fakeHome);

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    const entry = JSON.parse(readFileSync(costsFile, 'utf-8').trim());
    expect(entry.input_tokens).toBe(1234);
    expect(entry.output_tokens).toBe(56);
  });

  it('grows the tail window when the last 256 KB holds no assistant line (#1670)', () => {
    // Assistant entry near the start, followed by >256 KB of non-assistant
    // lines — the first window misses, the widened one must find it.
    const transcriptPath = join(tempDir, 'buried-transcript.jsonl');
    const noiseLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'y'.repeat(1024) },
    });
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 777, output_tokens: 88 },
        },
      }),
      ...Array.from({ length: 400 }, () => noiseLine), // ~400 KB after it
    ];
    writeFileSync(transcriptPath, lines.join('\n') + '\n');

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: 'buried-transcript-test',
      cwd: '/tmp/test',
    }, fakeHome);

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    const entry = JSON.parse(readFileSync(costsFile, 'utf-8').trim());
    expect(entry.input_tokens).toBe(777);
    expect(entry.output_tokens).toBe(88);
  });

  it('should handle malformed transcript gracefully', () => {
    const transcriptPath = join(tempDir, 'bad-transcript.jsonl');
    writeFileSync(transcriptPath, 'not valid json\nalso bad\n');

    expect(() => {
      runHook(COST_TRACKER, {
        transcript_path: transcriptPath,
        session_id: 'bad-transcript',
        cwd: '/tmp/test',
      }, fakeHome);
    }).not.toThrow();

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    expect(existsSync(costsFile)).toBe(false);
  });

  it('should include cache read discount in cost calculation', () => {
    const transcriptPath = createTranscript(tempDir, {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 1000000,
    }, 'claude-sonnet-4-6');

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: 'cache-test',
      cwd: '/tmp/test',
    }, fakeHome);

    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    const entry = JSON.parse(readFileSync(costsFile, 'utf-8').trim());

    // Sonnet cache read: $3.00/M * 0.1 = $0.30/M for 1M tokens
    expect(entry.estimated_cost_usd).toBeCloseTo(0.30, 2);
  });
});

describe('cost-tracker.cjs session sidecar (#1698)', () => {
  let tempDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fakeHome = join(tempDir, 'home');
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('maintains a per-session running total across turns', () => {
    const transcriptPath = createTranscript(tempDir, {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
    });

    const stdin = {
      transcript_path: transcriptPath,
      session_id: 'sidecar-sess',
      cwd: '/tmp/test',
    };
    runHook(COST_TRACKER, stdin, fakeHome);
    runHook(COST_TRACKER, stdin, fakeHome);

    const sidecarFile = join(fakeHome, '.claude', 'metrics', 'sessions', 'sidecar-sess.json');
    expect(existsSync(sidecarFile)).toBe(true);

    const sidecar = JSON.parse(readFileSync(sidecarFile, 'utf-8'));
    expect(sidecar.session_id).toBe('sidecar-sess');
    expect(sidecar.count).toBe(2);
    // Sonnet 4.6: 1M input = $3, 100K output = $1.50 → $4.50/turn
    expect(sidecar.total_cost_usd).toBeCloseTo(9.0, 2);
  });

  it('flattens path-hostile session ids into safe filenames', () => {
    const transcriptPath = createTranscript(tempDir, {
      input_tokens: 100,
      output_tokens: 50,
    });

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: '../evil/sess:1',
      cwd: '/tmp/test',
    }, fakeHome);

    const sessionsDir = join(fakeHome, '.claude', 'metrics', 'sessions');
    expect(existsSync(join(sessionsDir, '.._evil_sess_1.json'))).toBe(true);
  });
});

describe('cost-display.cjs session total (#1698)', () => {
  let tempDir: string;
  let fakeHome: string;
  let metricsDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fakeHome = join(tempDir, 'home');
    metricsDir = join(fakeHome, '.claude', 'metrics');
    mkdirSync(join(metricsDir, 'sessions'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  function writeSidecar(sessionId: string, totalCost: number, count: number): void {
    writeFileSync(
      join(metricsDir, 'sessions', `${sessionId}.json`),
      JSON.stringify({ session_id: sessionId, total_cost_usd: totalCost, count }) + '\n'
    );
  }

  it('reads the sidecar, not costs.jsonl — the total survives rotation', () => {
    // A rotated-away history: costs.jsonl holds NONE of this session's
    // entries, only the sidecar remembers them. The old implementation
    // summed costs.jsonl and would show $0.02 here (#1698).
    writeFileSync(
      join(metricsDir, 'costs.jsonl'),
      JSON.stringify({ session_id: 'disp-sess', estimated_cost_usd: 0.02 }) + '\n'
    );
    writeSidecar('disp-sess', 12.34, 5);

    const transcriptPath = createTranscript(tempDir, {
      input_tokens: 1000,
      output_tokens: 500,
    });

    const out = runHookCapture(COST_DISPLAY, {
      transcript_path: transcriptPath,
      session_id: 'disp-sess',
    }, fakeHome);

    expect(out).toContain('(session: $12.34)');
  });

  it('shows no session total when the sidecar is absent — never scans costs.jsonl', () => {
    // History alone must not produce a session line: the per-turn scan is
    // exactly what #1698 removed.
    writeFileSync(
      join(metricsDir, 'costs.jsonl'),
      Array.from({ length: 3 }, () =>
        JSON.stringify({ session_id: 'no-sidecar-sess', estimated_cost_usd: 1.0 })
      ).join('\n') + '\n'
    );

    const transcriptPath = createTranscript(tempDir, {
      input_tokens: 1000,
      output_tokens: 500,
    });

    const out = runHookCapture(COST_DISPLAY, {
      transcript_path: transcriptPath,
      session_id: 'no-sidecar-sess',
    }, fakeHome);

    expect(out).not.toContain('session:');
  });

  it('keeps the single-turn quiet rule — count 1 shows no session total', () => {
    writeSidecar('one-turn-sess', 0.05, 1);

    const transcriptPath = createTranscript(tempDir, {
      input_tokens: 1000,
      output_tokens: 500,
    });

    const out = runHookCapture(COST_DISPLAY, {
      transcript_path: transcriptPath,
      session_id: 'one-turn-sess',
    }, fakeHome);

    expect(out).not.toContain('session:');
  });
});

describe('session-summary.cjs', () => {
  let tempDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fakeHome = join(tempDir, 'home');
    mkdirSync(join(fakeHome, '.claude', 'metrics'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should aggregate session entries and write summary', () => {
    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    const entries = [
      {
        timestamp: '2026-03-09T10:00:00.000Z',
        session_id: 'sess-1',
        project: 'test-project',
        model: 'claude-sonnet-4-6',
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        estimated_cost_usd: 0.01,
      },
      {
        timestamp: '2026-03-09T10:30:00.000Z',
        session_id: 'sess-1',
        project: 'test-project',
        model: 'claude-sonnet-4-6',
        input_tokens: 2000,
        output_tokens: 1000,
        cache_creation_tokens: 100,
        cache_read_tokens: 50,
        estimated_cost_usd: 0.02,
      },
      {
        timestamp: '2026-03-09T11:00:00.000Z',
        session_id: 'other-session',
        project: 'other-project',
        model: 'claude-opus-4-6',
        input_tokens: 5000,
        output_tokens: 2000,
        estimated_cost_usd: 0.05,
      },
    ];

    writeFileSync(costsFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    runHook(SESSION_SUMMARY, { session_id: 'sess-1' }, fakeHome);

    const content = readFileSync(costsFile, 'utf-8').trim();
    const lines = content.split('\n');

    // Should have 4 lines: 3 original + 1 summary
    expect(lines.length).toBe(4);

    const summary = JSON.parse(lines[3]);
    expect(summary.type).toBe('session_summary');
    expect(summary.session_id).toBe('sess-1');
    expect(summary.response_count).toBe(2);
    expect(summary.total_input_tokens).toBe(3000);
    expect(summary.total_output_tokens).toBe(1500);
    expect(summary.total_cache_creation_tokens).toBe(100);
    expect(summary.total_cache_read_tokens).toBe(50);
    expect(summary.total_cost_usd).toBeCloseTo(0.03, 4);
    expect(summary.duration_minutes).toBe(30);
  });

  it('should handle empty session gracefully', () => {
    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    writeFileSync(costsFile, JSON.stringify({
      session_id: 'other-session',
      input_tokens: 100,
      output_tokens: 50,
      estimated_cost_usd: 0.01,
    }) + '\n');

    expect(() => {
      runHook(SESSION_SUMMARY, { session_id: 'nonexistent-session' }, fakeHome);
    }).not.toThrow();

    // Should not add a summary line
    const lines = readFileSync(costsFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
  });

  it('should handle missing costs file gracefully', () => {
    // Delete the metrics dir contents
    rmSync(join(fakeHome, '.claude', 'metrics', 'costs.jsonl'), { force: true });

    expect(() => {
      runHook(SESSION_SUMMARY, { session_id: 'test' }, fakeHome);
    }).not.toThrow();
  });

  it('should exclude existing summaries from aggregation', () => {
    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    const entries = [
      {
        session_id: 'sess-1',
        input_tokens: 1000,
        output_tokens: 500,
        estimated_cost_usd: 0.01,
        timestamp: '2026-03-09T10:00:00.000Z',
      },
      {
        type: 'session_summary',
        session_id: 'sess-1',
        total_input_tokens: 1000,
        total_output_tokens: 500,
        total_cost_usd: 0.01,
        timestamp: '2026-03-09T10:05:00.000Z',
      },
      {
        session_id: 'sess-1',
        input_tokens: 2000,
        output_tokens: 1000,
        estimated_cost_usd: 0.02,
        timestamp: '2026-03-09T10:10:00.000Z',
      },
    ];

    writeFileSync(costsFile, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

    runHook(SESSION_SUMMARY, { session_id: 'sess-1' }, fakeHome);

    const lines = readFileSync(costsFile, 'utf-8').trim().split('\n');
    const lastLine = JSON.parse(lines[lines.length - 1]);

    // Summary should only count the 2 non-summary entries
    expect(lastLine.type).toBe('session_summary');
    expect(lastLine.response_count).toBe(2);
    expect(lastLine.total_input_tokens).toBe(3000);
  });
});

describe('suggest-compact.cjs context ratio (#1699)', () => {
  let tempDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fakeHome = join(tempDir, 'home');
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  /**
   * The model here is load-bearing, which it did not use to be: the hook now
   * measures against the ANSWERING MODEL's window (#1956), so these fixtures
   * name one that sits on the 200K fallback. They were written against fable,
   * whose real window is ~1M — at which 163K is a quiet 16%, and every
   * assertion below would be testing nothing. The subject is still the #1699
   * ratio: that cached context counts toward the window at all.
   */
  function runSuggest(usage: Record<string, number>, sessionId: string): string {
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-sonnet-4-6', usage },
      }) + '\n'
    );
    return runHookCapture(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: sessionId,
    }, fakeHome);
  }

  it('fires the critical warning when cached context crosses 80%', () => {
    // Under prompt caching the window lives in cache_read/cache_creation —
    // counting input_tokens alone kept this at 0% forever (#1699).
    const out = runSuggest({
      input_tokens: 2,
      cache_creation_input_tokens: 1704,
      cache_read_input_tokens: 163_000,
      output_tokens: 500,
    }, 'crit-sess');

    expect(out).toContain('run /compact NOW');
    expect(out).toContain('82%');
  });

  it('fires the soft warning between 70% and 80% combined context', () => {
    const out = runSuggest({
      input_tokens: 100,
      cache_read_input_tokens: 144_000,
      output_tokens: 500,
    }, 'warn-sess');

    expect(out).toContain('consider running /compact soon');
    expect(out).toContain('72%');
  });

  it('stays silent when combined context is small', () => {
    const out = runSuggest({
      input_tokens: 2,
      cache_read_input_tokens: 50_000,
      output_tokens: 500,
    }, 'quiet-sess');

    expect(out.trim()).toBe('');
  });
});

describe('suggest-compact.cjs incremental transcript reads (#1700)', () => {
  let tempDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fakeHome = join(tempDir, 'home');
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  const toolUseLine = (id: string, cacheRead = 50_000): string =>
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', id, name: 'Bash', input: {} }],
        usage: { input_tokens: 5, cache_read_input_tokens: cacheRead, output_tokens: 10 },
      },
    });

  function stateFile(): string {
    return join(fakeHome, '.claude', 'metrics', 'compact-state.json');
  }

  it('counts tool calls incrementally — only appended bytes are parsed', () => {
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    const lines = Array.from({ length: 60 }, (_, i) => toolUseLine(`t${i}`));
    writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const stdin = { transcript_path: transcriptPath, session_id: 'inc-sess' };
    const first = runHookCapture(SUGGEST_COMPACT, stdin, fakeHome);
    expect(first).toContain('60 tool calls');

    const afterFirst = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(afterFirst.tool_calls_total).toBe(60);
    expect(afterFirst.transcript_offset).toBeGreaterThan(0);

    // Append 50 more — the next run must count the delta on top, not
    // rescan. Grown context clears the MIN_TOKEN_GROWTH re-suggest gate.
    const more = Array.from({ length: 50 }, (_, i) => toolUseLine(`u${i}`, 65_000));
    writeFileSync(transcriptPath, lines.concat(more).join('\n') + '\n');

    const second = runHookCapture(SUGGEST_COMPACT, stdin, fakeHome);
    expect(second).toContain('110 tool calls');

    const afterSecond = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(afterSecond.tool_calls_total).toBe(110);
    expect(afterSecond.transcript_offset).toBeGreaterThan(afterFirst.transcript_offset);
  });

  it('advances the offset on quiet turns too', () => {
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    writeFileSync(transcriptPath, toolUseLine('t0') + '\n');

    const stdin = { transcript_path: transcriptPath, session_id: 'quiet-sess' };
    const out = runHookCapture(SUGGEST_COMPACT, stdin, fakeHome);
    expect(out.trim()).toBe(''); // 1 tool call, 25% context — nothing fires

    const state = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(state.tool_calls_total).toBe(1);
    expect(state.transcript_offset).toBeGreaterThan(0);
  });

  it('resets the count when the transcript shrinks (rewritten by compaction)', () => {
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    const lines = Array.from({ length: 60 }, (_, i) => toolUseLine(`t${i}`));
    writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const stdin = { transcript_path: transcriptPath, session_id: 'shrink-sess' };
    runHookCapture(SUGGEST_COMPACT, stdin, fakeHome);

    // Compaction rewrote the transcript far smaller than the saved offset
    writeFileSync(transcriptPath, toolUseLine('fresh') + '\n');
    runHookCapture(SUGGEST_COMPACT, stdin, fakeHome);

    const state = JSON.parse(readFileSync(stateFile(), 'utf-8'));
    expect(state.tool_calls_total).toBe(1);
  });

  it('finds last usage through a bounded tail on a transcript larger than the window', () => {
    // >256 KB of noise, then the assistant entry at 82% cached context —
    // the tail read must still find it and fire the critical warning.
    const transcriptPath = join(tempDir, 'big.jsonl');
    const noise = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'z'.repeat(1024) },
    });
    const lines = Array.from({ length: 400 }, () => noise);
    lines.push(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 2, cache_read_input_tokens: 163_000, output_tokens: 10 },
      },
    }));
    writeFileSync(transcriptPath, lines.join('\n') + '\n');

    const out = runHookCapture(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: 'big-sess',
    }, fakeHome);

    expect(out).toContain('run /compact NOW');
  });
});

describe('cost-tracker.cjs rotation', () => {
  let tempDir: string;
  let fakeHome: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fakeHome = join(tempDir, 'home');
    mkdirSync(join(fakeHome, '.claude', 'metrics'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should not rotate when under the size threshold', () => {
    const costsFile = join(fakeHome, '.claude', 'metrics', 'costs.jsonl');
    // Write 100 lines
    const lines = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ session_id: 'test', input_tokens: i, timestamp: new Date().toISOString() })
    );
    writeFileSync(costsFile, lines.join('\n') + '\n');

    const transcriptPath = createTranscript(tempDir, {
      input_tokens: 100,
      output_tokens: 50,
    });

    runHook(COST_TRACKER, {
      transcript_path: transcriptPath,
      session_id: 'rotation-test',
      cwd: '/tmp/test',
    }, fakeHome);

    // Should still have the original file with one more line
    expect(existsSync(costsFile)).toBe(true);
    const resultLines = readFileSync(costsFile, 'utf-8').trim().split('\n');
    expect(resultLines.length).toBe(101);
  });
});
