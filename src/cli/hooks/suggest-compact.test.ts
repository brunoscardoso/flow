/**
 * Tests for suggest-compact.cjs and pre-compact-save.cjs hook scripts
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
const SUGGEST_COMPACT = join(PROJECT_ROOT, 'scripts', 'hooks', 'suggest-compact.cjs');
const PRE_COMPACT_SAVE = join(PROJECT_ROOT, 'scripts', 'hooks', 'pre-compact-save.cjs');

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `plan-flow-compact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Create a transcript with a specific input_tokens count on the last assistant message.
 */
function createTranscriptWithUsage(dir: string, inputTokens: number): string {
  const transcriptPath = join(dir, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: inputTokens,
          output_tokens: 1000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }),
  ];
  writeFileSync(transcriptPath, lines.join('\n') + '\n');
  return transcriptPath;
}

/**
 * As above, but for a named model and with the context where prompt caching
 * really puts it — `input_tokens` is only the uncached remainder, so a test
 * that drove the window through `input_tokens` alone would not resemble a real
 * transcript at all.
 */
function createTranscriptForModel(dir: string, model: string, contextTokens: number): string {
  const transcriptPath = join(dir, `transcript-${model.replace(/[^a-z0-9]/gi, '-')}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model,
        usage: {
          input_tokens: 12,
          output_tokens: 1000,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: contextTokens - 12,
        },
      },
    }),
  ];
  writeFileSync(transcriptPath, lines.join('\n') + '\n');
  return transcriptPath;
}

/**
 * Create a transcript with tool_use blocks.
 */
function createTranscriptWithToolCalls(dir: string, toolCallCount: number, inputTokens = 50000): string {
  const transcriptPath = join(dir, 'transcript.jsonl');
  const lines: string[] = [];

  // Add tool_use entries
  for (let i = 0; i < toolCallCount; i++) {
    lines.push(JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: inputTokens, output_tokens: 100 },
        content: [
          { type: 'tool_use', id: `tool_${i}`, name: 'Read', input: { file_path: `/tmp/file${i}.ts` } },
        ],
      },
    }));
  }

  writeFileSync(transcriptPath, lines.join('\n') + '\n');
  return transcriptPath;
}

/**
 * Run a hook and capture stderr output.
 */
function runHookWithStderr(
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
  if (result.error || result.status !== 0) {
    return '';
  }
  return result.stdout + result.stderr;
}

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

describe('suggest-compact.cjs', () => {
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

  it('should not warn below 70% context usage', () => {
    // 100K tokens = 50% of 200K
    const transcriptPath = createTranscriptWithUsage(tempDir, 100_000);

    const output = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: 'test-no-warn',
    }, fakeHome);

    expect(output.trim()).toBe('');
  });

  it('should warn at 70% context usage (yellow)', () => {
    // 145K tokens = 72.5%
    const transcriptPath = createTranscriptWithUsage(tempDir, 145_000);

    const output = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: 'test-warn',
    }, fakeHome);

    expect(output).toContain('Context');
    expect(output).toContain('/compact');
    expect(output).toContain('soon');
  });

  it('should show critical warning at 80% context usage (red)', () => {
    // 165K tokens = 82.5%
    const transcriptPath = createTranscriptWithUsage(tempDir, 165_000);

    const output = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: 'test-critical',
    }, fakeHome);

    expect(output).toContain('Context');
    expect(output).toContain('/compact NOW');
  });

  it('should suppress duplicate warnings within 10K token growth', () => {
    const transcriptPath = createTranscriptWithUsage(tempDir, 145_000);
    const sessionId = 'test-suppress';

    // First call — should warn
    const output1 = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: sessionId,
    }, fakeHome);
    expect(output1).toContain('/compact');

    // Second call with same token count — should suppress
    const output2 = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: sessionId,
    }, fakeHome);
    expect(output2.trim()).toBe('');
  });

  it('should always show critical warnings regardless of suppression', () => {
    const sessionId = 'test-always-critical';

    // First: warn at 70%
    const transcript1 = createTranscriptWithUsage(tempDir, 145_000);
    runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcript1,
      session_id: sessionId,
    }, fakeHome);

    // Second: critical at 80% (only 20K growth, but critical should always show)
    const transcript2 = createTranscriptWithUsage(tempDir, 165_000);
    const output = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcript2,
      session_id: sessionId,
    }, fakeHome);

    expect(output).toContain('/compact NOW');
  });

  it('should suggest compact at tool call intervals', () => {
    // 55 tool calls, low context usage
    const transcriptPath = createTranscriptWithToolCalls(tempDir, 55, 50_000);

    const output = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: 'test-tools',
    }, fakeHome);

    expect(output).toContain('tool calls');
  });

  // ── THE WINDOW IS THE MODEL'S, NOT A CONSTANT (#1956) ────────────────
  // Measured before this: against a hardcoded 200K, 46.6% of 5,113 recorded
  // calls tripped the yellow line and 44.0% the red one. A critical warning
  // that fires on nearly half of all calls is wallpaper.

  it('does not warn a 1M-window model at half its window — the old constant called this critical', () => {
    // 500K is 250% of the old 200K constant, and 50% of what opus actually has.
    const transcriptPath = createTranscriptForModel(tempDir, 'claude-opus-5', 500_000);

    const output = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: 'test-1m-quiet',
    }, fakeHome);

    expect(output.trim()).toBe('');
  });

  it('warns a 1M-window model at 85% of ITS window, naming that window', () => {
    const transcriptPath = createTranscriptForModel(tempDir, 'claude-opus-5', 850_000);

    const output = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: 'test-1m-critical',
    }, fakeHome);

    expect(output).toContain('/compact NOW');
    expect(output).toContain('85%');
    // The denominator is the real one — "850K/200K" was the reported bug.
    expect(output).toContain('1.0M');
    expect(output).not.toContain('200K');
  });

  it('reads a window the model id states, for a family it has no table entry for', () => {
    const transcriptPath = createTranscriptForModel(tempDir, 'claude-zephyr-9[1m]', 300_000);

    const output = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: 'test-explicit-window',
    }, fakeHome);

    // 300K is 150% of the fallback and 30% of what the id declares.
    expect(output.trim()).toBe('');
  });

  it('never reports more than 100% full, whatever the table says', () => {
    // The exact shape of the reported defect: a model nothing identifies,
    // holding far more than the fallback. It used to print "450% full".
    const transcriptPath = createTranscriptForModel(tempDir, 'some-unknown-model', 900_000);

    const output = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: 'test-no-absurd-pct',
    }, fakeHome);

    const percent = /Context (\d+)% full/.exec(output);
    expect(percent).not.toBeNull();
    expect(Number(percent?.[1])).toBeLessThanOrEqual(100);
  });

  it('remembers an unknown model\u2019s window once it has seen it hold that much', () => {
    // Turn one: 600K on a model no table knows. Its window is at least 600K.
    runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: createTranscriptForModel(tempDir, 'mystery-model-7', 600_000),
      session_id: 'test-learned-window',
    }, fakeHome);

    // A later, SMALLER context on the same model is not an emergency: 300K is
    // 150% of the fallback, but well under what this model demonstrably holds.
    const output = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: createTranscriptForModel(tempDir, 'mystery-model-7', 300_000),
      session_id: 'test-learned-window-2',
    }, fakeHome);

    expect(output).not.toContain('/compact NOW');
  });

  it('still warns a model with no larger window at the old thresholds', () => {
    // The fallback is a floor, not a removal: sonnet-4-6 was never recorded
    // above 166K, so nothing here should have changed for it.
    const transcriptPath = createTranscriptForModel(tempDir, 'claude-sonnet-4-6', 165_000);

    const output = runHookWithStderr(SUGGEST_COMPACT, {
      transcript_path: transcriptPath,
      session_id: 'test-fallback-intact',
    }, fakeHome);

    expect(output).toContain('/compact NOW');
    expect(output).toContain('200K');
  });

  it('should handle missing transcript gracefully', () => {
    expect(() => {
      runHook(SUGGEST_COMPACT, {
        transcript_path: '/nonexistent/path.jsonl',
        session_id: 'test-missing',
      }, fakeHome);
    }).not.toThrow();
  });

  it('should handle malformed transcript gracefully', () => {
    const transcriptPath = join(tempDir, 'bad.jsonl');
    writeFileSync(transcriptPath, 'not json\nalso bad\n');

    expect(() => {
      runHook(SUGGEST_COMPACT, {
        transcript_path: transcriptPath,
        session_id: 'test-malformed',
      }, fakeHome);
    }).not.toThrow();
  });
});

describe('pre-compact-save.cjs', () => {
  let tempDir: string;
  let fakeHome: string;
  let fakeCwd: string;

  beforeEach(() => {
    tempDir = createTempDir();
    fakeHome = join(tempDir, 'home');
    fakeCwd = join(tempDir, 'project');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeCwd, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should save state file with correct structure', () => {
    const transcriptPath = createTranscriptWithUsage(tempDir, 100_000);

    runHook(PRE_COMPACT_SAVE, {
      transcript_path: transcriptPath,
      session_id: 'sess-123',
      trigger: 'auto',
      cwd: fakeCwd,
    }, fakeHome);

    const stateFile = join(fakeHome, '.claude', 'metrics', 'precompact-sess-123.md');
    expect(existsSync(stateFile)).toBe(true);

    const content = readFileSync(stateFile, 'utf-8');
    expect(content).toContain('# Pre-Compact State');
    expect(content).toContain('sess-123');
    expect(content).toContain('auto');
  });

  it('should extract in-progress tasklist items', () => {
    const transcriptPath = createTranscriptWithUsage(tempDir, 100_000);

    // Create tasklist
    mkdirSync(join(fakeCwd, 'flow'), { recursive: true });
    writeFileSync(join(fakeCwd, 'flow', 'tasklist.md'), [
      '# Tasklist',
      '',
      '## In Progress',
      '',
      '- [ ] Execute: my_feature — started 2026-03-10',
      '- [ ] Review: other_feature — started 2026-03-10',
      '',
      '## Done',
      '',
      '- [x] Discovery: my_feature',
    ].join('\n'));

    runHook(PRE_COMPACT_SAVE, {
      transcript_path: transcriptPath,
      session_id: 'sess-tasks',
      trigger: 'manual',
      cwd: fakeCwd,
    }, fakeHome);

    const stateFile = join(fakeHome, '.claude', 'metrics', 'precompact-sess-tasks.md');
    const content = readFileSync(stateFile, 'utf-8');

    expect(content).toContain('In-Progress Tasks');
    expect(content).toContain('Execute: my_feature');
    expect(content).toContain('Review: other_feature');
    expect(content).not.toContain('Discovery: my_feature');
  });

  it('should extract modified files from transcript tool_use entries', () => {
    const transcriptPath = join(tempDir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100000, output_tokens: 1000 },
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/project/src/index.ts' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 100000, output_tokens: 1000 },
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/project/src/new-file.ts' } },
          ],
        },
      }),
    ];
    writeFileSync(transcriptPath, lines.join('\n') + '\n');

    runHook(PRE_COMPACT_SAVE, {
      transcript_path: transcriptPath,
      session_id: 'sess-files',
      trigger: 'auto',
      cwd: fakeCwd,
    }, fakeHome);

    const stateFile = join(fakeHome, '.claude', 'metrics', 'precompact-sess-files.md');
    const content = readFileSync(stateFile, 'utf-8');

    expect(content).toContain('Files Modified');
    expect(content).toContain('/project/src/index.ts');
    expect(content).toContain('/project/src/new-file.ts');
  });

  it('should handle missing tasklist gracefully', () => {
    const transcriptPath = createTranscriptWithUsage(tempDir, 100_000);

    expect(() => {
      runHook(PRE_COMPACT_SAVE, {
        transcript_path: transcriptPath,
        session_id: 'sess-no-tasks',
        trigger: 'auto',
        cwd: fakeCwd,
      }, fakeHome);
    }).not.toThrow();

    const stateFile = join(fakeHome, '.claude', 'metrics', 'precompact-sess-no-tasks.md');
    expect(existsSync(stateFile)).toBe(true);
  });

  it('should handle missing transcript gracefully', () => {
    expect(() => {
      runHook(PRE_COMPACT_SAVE, {
        transcript_path: '/nonexistent/path.jsonl',
        session_id: 'sess-no-transcript',
        trigger: 'auto',
        cwd: fakeCwd,
      }, fakeHome);
    }).not.toThrow();
  });

  it('should include custom instructions when manual trigger', () => {
    const transcriptPath = createTranscriptWithUsage(tempDir, 100_000);

    runHook(PRE_COMPACT_SAVE, {
      transcript_path: transcriptPath,
      session_id: 'sess-manual',
      trigger: 'manual',
      custom_instructions: 'Focus on the API changes',
      cwd: fakeCwd,
    }, fakeHome);

    const stateFile = join(fakeHome, '.claude', 'metrics', 'precompact-sess-manual.md');
    const content = readFileSync(stateFile, 'utf-8');

    expect(content).toContain('manual');
    expect(content).toContain('Focus on the API changes');
  });
});
