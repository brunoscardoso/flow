/**
 * `planflow-ai flow <verb>` — THE WRITE DOOR onto `flow/.flowconfig`.
 *
 * In-process against a REAL temp project (the `worktree.test.ts` shape, layer
 * two), because everything worth proving here is about a file on disk: that a
 * refused batch left it BYTE-IDENTICAL, that a set is one atomic write with no
 * temp file beside it, that `unset` removes exactly what it was told and
 * nothing else.
 *
 * Refusals are asserted on the COMBINED transcript — stdout plus everything the
 * logger wrote (allowed-pattern #15: this repo's logger routes `error()`
 * through `console.log`, so a stderr-only assertion passes vacuously).
 *
 * NOTHING HERE TOUCHES THIS REPOSITORY: every case runs in its own `mkdtemp`
 * project, removed afterwards.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runFlow, FLOW_KEYS, FLOW_VERBS, isFlowVerb, specFor, invalidValueReason } = await import(
  './flow.js'
);

type FlowOptions = Parameters<typeof runFlow>[2];

interface Invocation {
  stdout: string;
  /** Everything the logger wrote. */
  logged: string[];
  /** stdout + the logger, which is what a person actually sees. */
  transcript: string;
  /** Just the refusal lines. */
  refusals: string[];
  exitCode: number;
  json: Record<string, unknown> | null;
}

type StdoutLike = { write: (chunk: unknown) => boolean };

/** Call a verb in-process, capturing stdout, the logger and the exit code. */
function invoke(verb: string, args: string[], options: Partial<FlowOptions> = {}): Invocation {
  const chunks: string[] = [];
  const logged: string[] = [];
  const stdout = process.stdout as unknown as StdoutLike;
  const realWrite = stdout.write;
  const realLog = console.log;
  stdout.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  console.log = (...args_: unknown[]): void => {
    logged.push(args_.map((arg) => String(arg)).join(' '));
  };

  const previousExit = process.exitCode;
  process.exitCode = 0;
  try {
    runFlow(verb, args, { target: tempProject, json: true, ...options } as FlowOptions);
  } finally {
    stdout.write = realWrite;
    console.log = realLog;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = previousExit;

  const text = chunks.join('');
  let json: Record<string, unknown> | null = null;
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text.trim()) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return {
    stdout: text,
    logged,
    transcript: [text, ...logged].join('\n'),
    refusals: logged.filter((line) => line.includes('flow refused:')),
    exitCode,
    json,
  };
}

let tempProject: string;

function flowDir(): string {
  return join(tempProject, 'flow');
}

function configPath(): string {
  return join(flowDir(), '.flowconfig');
}

/** Seed the project's config with exactly this text. */
function seed(text: string): void {
  mkdirSync(flowDir(), { recursive: true });
  writeFileSync(configPath(), text, 'utf-8');
}

function configText(): string {
  return existsSync(configPath()) ? readFileSync(configPath(), 'utf-8') : '';
}

/** Every file sitting in `flow/` — a leftover temp file is a failed atomic write. */
function flowFiles(): string[] {
  return existsSync(flowDir()) ? readdirSync(flowDir()).sort() : [];
}

beforeEach(() => {
  tempProject = mkdtempSync(join(tmpdir(), 'plan-flow-flow-verb-'));
});

afterEach(() => {
  rmSync(tempProject, { recursive: true, force: true });
});

describe('the verb family', () => {
  it('answers to exactly set, unset, show and stage', () => {
    // `stage` is the odd one out and belongs here anyway: it is a READER of the
    // workflow ladder rather than a writer of the config, and it joined the
    // family because it is subject to the same refusal contract. Its own cases
    // live in `flow-stage.test.ts`.
    expect([...FLOW_VERBS]).toEqual([
      'set',
      'unset',
      'show',
      'stage',
      'risk',
      'pushed-through',
      'run-start',
    ]);
    expect(isFlowVerb('set')).toBe(true);
    expect(isFlowVerb('toggle')).toBe(false);
  });

  it('refuses an unknown verb on the combined transcript, and writes nothing', () => {
    seed('autopilot: true\n');
    const result = invoke('toggle', ['autopilot=false']);
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('flow refused:');
    expect(result.transcript).toContain("unknown verb 'toggle'");
    expect(result.transcript).toContain('set|unset|show|stage');
    expect(configText()).toBe('autopilot: true\n');
  });

  it('carries the refusal prefix exactly once', () => {
    const result = invoke('set', ['nope=1']);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0].match(/flow refused:/g)).toHaveLength(1);
  });
});

describe('flow set', () => {
  it('writes a key into a project that had no config at all', () => {
    const result = invoke('set', ['autopilot=true']);
    expect(result.exitCode).toBe(0);
    expect(configText()).toBe('autopilot: true\n');
    expect(result.json?.set).toEqual({ autopilot: 'true' });
  });

  it('writes a whole batch in ONE merge, in place, leaving the file otherwise alone', () => {
    seed(['# mine', '', 'autopilot: true', 'push: false', ''].join('\n'));
    const result = invoke('set', ['push=true', 'branch=develop']);
    expect(result.exitCode).toBe(0);
    expect(configText()).toBe(
      ['# mine', '', 'autopilot: true', 'push: true', 'branch: develop', ''].join('\n'),
    );
  });

  it('leaves no temp file behind — the write is atomic', () => {
    invoke('set', ['autopilot=true']);
    expect(flowFiles()).toEqual(['.flowconfig']);
  });

  it('splits at the FIRST equals, so a value may carry its own', () => {
    const result = invoke('set', ['commands.lint=npm run lint -- --fix']);
    expect(result.exitCode).toBe(0);
    expect(configText()).toBe('commands.lint: npm run lint -- --fix\n');
  });

  it('accepts the engine family by shape, not by a list of names', () => {
    expect(invoke('set', ['engines.lavish=enabled']).exitCode).toBe(0);
    expect(configText()).toContain('engines.lavish: enabled');
    expect(specFor('engines.anything-new')).not.toBeNull();
  });

  it('sets each worktree key the settings panel writes', () => {
    const result = invoke('set', [
      'thread_worktrees=false',
      'remote=upstream',
      'remote_branch_pattern=feature/{ticket}-{slug}',
      'branch=develop',
      'worktree_start=branch:release/2.0',
      'base_refresh=false',
      'base_refresh_timeout_ms=3000',
    ]);
    expect(result.exitCode).toBe(0);
    const raw = result.json?.raw as Record<string, string>;
    expect(raw.thread_worktrees).toBe('false');
    expect(raw.remote).toBe('upstream');
    expect(raw.remote_branch_pattern).toBe('feature/{ticket}-{slug}');
    expect(raw.branch).toBe('develop');
    expect(raw.worktree_start).toBe('branch:release/2.0');
    expect(raw.base_refresh).toBe('false');
    expect(raw.base_refresh_timeout_ms).toBe('3000');
  });

  it('does NOT cascade — pr does not quietly write push and commit', () => {
    // `parseFlowConfig` applies the implication on every read; writing the
    // implied keys here would be a second place that has to agree with it.
    invoke('set', ['pr=true']);
    expect(configText()).toBe('pr: true\n');
  });
});

describe('flow set — refusals leave the file byte-identical', () => {
  const BEFORE = ['# do not lose me', '', 'autopilot: true', 'remote: origin', ''].join('\n');

  function refuse(args: string[]): Invocation {
    seed(BEFORE);
    const result = invoke('set', args);
    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(configText()).toBe(BEFORE); // byte-identical
    expect(flowFiles()).toEqual(['.flowconfig']); // and no half-written temp
    return result;
  }

  it('refuses an unknown key', () => {
    expect(refuse(['nonesuch=1']).transcript).toContain("unknown key 'nonesuch'");
  });

  it('refuses a boolean that is not one of the two words', () => {
    expect(refuse(['commit=yes']).transcript).toContain('not a valid boolean');
  });

  it('refuses a number outside its bounds, and one that is not a number', () => {
    expect(refuse(['base_refresh_timeout_ms=600000']).transcript).toContain(
      'between 1000 and 30000',
    );
    expect(refuse(['base_refresh_timeout_ms=soon']).transcript).toContain('not a valid number');
    expect(refuse(['max_verify_retries=9']).transcript).toContain('between 1 and 5');
  });

  it('refuses a worktree start that is not one of the three', () => {
    const result = refuse(['worktree_start=sideways']);
    expect(result.transcript).toContain('worktree start');
    expect(result.transcript).toContain('here, trunk, or branch:<name>');
    // The kind that cannot be shared is not offered as the thing every thread does.
    refuse(['worktree_start=checkout:dev']);
    refuse(['worktree_start=branch:']);
    // The old spelling is held to the same rule — an alias is not a back door.
    refuse(['workspace_start=sideways']);
  });

  it('refuses a naming pattern with a placeholder nothing can fill', () => {
    const result = refuse(['remote_branch_pattern=feature/{sprint}']);
    expect(result.transcript).toContain('{sprint}');
    expect(result.transcript).toContain('{ticket}');
  });

  it('refuses a remote and a branch git could not carry', () => {
    expect(refuse(['remote=my remote']).transcript).toContain('remote name');
    expect(refuse(['remote=team/fork']).transcript).toContain('remote name');
    expect(refuse(['branch=has spaces']).transcript).toContain('branch name');
    expect(refuse(['branch=a..b']).transcript).toContain('branch name');
  });

  it('refuses an argument that is not a key=value pair at all', () => {
    expect(refuse(['autopilot']).transcript).toContain('is not a key=value pair');
    expect(refuse(['=true']).transcript).toContain('is not a key=value pair');
  });

  it('refuses a set with nothing to set', () => {
    expect(refuse([]).transcript).toContain('at least one key=value pair');
  });

  it('points a blank value at the verb that means it', () => {
    // Blank is not "the default" — absence is, and there is a verb for it.
    const result = refuse(['branch=']);
    expect(result.transcript).toContain('needs a value');
    expect(result.transcript).toContain('unset branch');
  });

  it('validates the WHOLE batch before writing a single byte', () => {
    // The good key in this batch must not land.
    const result = refuse(['commit=true', 'push=banana']);
    expect(result.transcript).toContain('not a valid boolean');
    expect(configText()).not.toContain('commit: true');
  });
});

describe('flow unset', () => {
  it('removes the key and leaves every other line alone', () => {
    seed(['# keep', 'autopilot: true', 'branch: develop', 'push: false', ''].join('\n'));
    const result = invoke('unset', ['branch']);
    expect(result.exitCode).toBe(0);
    expect(configText()).toBe(['# keep', 'autopilot: true', 'push: false', ''].join('\n'));
    expect(result.json?.unset).toEqual(['branch']);
    expect(result.json?.absent).toEqual([]);
  });

  it('REPORTS a key the file never had, rather than refusing it', () => {
    // The end state the caller asked for is the state they get.
    seed('autopilot: true\n');
    const result = invoke('unset', ['branch']);
    expect(result.exitCode).toBe(0);
    expect(result.refusals).toHaveLength(0);
    expect(result.json?.unset).toEqual([]);
    expect(result.json?.absent).toEqual(['branch']);
    expect(configText()).toBe('autopilot: true\n');
  });

  it('is a no-op against a project with no config, creating none', () => {
    const result = invoke('unset', ['branch']);
    expect(result.exitCode).toBe(0);
    expect(existsSync(configPath())).toBe(false);
  });

  it('removes several keys in one write', () => {
    seed(['autopilot: true', 'branch: develop', 'remote: upstream', ''].join('\n'));
    const result = invoke('unset', ['branch', 'remote']);
    expect(configText()).toBe('autopilot: true\n');
    expect(result.json?.unset).toEqual(['branch', 'remote']);
  });

  it('refuses a key with a value attached — unset takes keys alone', () => {
    seed('branch: develop\n');
    const result = invoke('unset', ['branch=develop']);
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('names a value');
    expect(configText()).toBe('branch: develop\n');
  });

  it('refuses an unknown key, and an empty call', () => {
    seed('branch: develop\n');
    expect(invoke('unset', ['nonesuch']).transcript).toContain("unknown key 'nonesuch'");
    expect(invoke('unset', []).transcript).toContain('at least one key');
    expect(configText()).toBe('branch: develop\n');
  });
});

describe('flow show', () => {
  it('reports what the project SET, not what it resolves to', () => {
    // `config` cannot tell a project that set `commit: false` from one that
    // never mentioned it; `raw` is the half that can, and it is what
    // provenance is built on.
    seed('commit: false\n');
    const result = invoke('show', []);
    expect(result.exitCode).toBe(0);
    expect(result.json?.raw).toEqual({ commit: 'false' });
    expect((result.json?.config as Record<string, unknown>).commit).toBe(false);
    expect((result.json?.config as Record<string, unknown>).remote).toBe('origin');
  });

  it('reports an untouched project as setting nothing', () => {
    const result = invoke('show', []);
    expect(result.json?.raw).toEqual({});
    expect(result.exitCode).toBe(0);
  });

  it('writes nothing at all', () => {
    invoke('show', []);
    expect(existsSync(configPath())).toBe(false);
  });

  it('renders human lines without --json, and never a raw JSON object', () => {
    seed('remote: upstream\n');
    const result = invoke('show', [], { json: false });
    expect(result.stdout).toContain('flow: 1 setting(s) set by this project');
    expect(result.stdout).toContain('remote: upstream');
    expect(result.stdout.trim().startsWith('{')).toBe(false);
  });

  it('says so plainly when the project sets nothing', () => {
    const result = invoke('show', [], { json: false });
    expect(result.stdout).toContain('every setting is at its default');
  });

  it('shows a key written blank as blank, not as missing', () => {
    seed('branch:\n');
    const result = invoke('show', [], { json: false });
    expect(result.stdout).toContain('branch: (blank)');
    expect((invoke('show', []).json?.raw as Record<string, string>).branch).toBe('');
  });
});

describe('the result object is one computation with two formatters', () => {
  it('carries the verb, the resolved target, and both views on every verb', () => {
    seed('autopilot: true\n');
    for (const [verb, args] of [
      ['set', ['commit=true']],
      ['unset', ['commit']],
      ['show', []],
    ] as const) {
      const result = invoke(verb, [...args]);
      expect(result.json?.verb).toBe(verb);
      expect(typeof result.json?.target).toBe('string');
      expect(result.json?.config).toBeDefined();
      expect(result.json?.raw).toBeDefined();
    }
  });

  it('reports the file as it stands AFTER the write', () => {
    seed('remote: origin\n');
    const result = invoke('set', ['remote=upstream']);
    expect((result.json?.raw as Record<string, string>).remote).toBe('upstream');
    expect((result.json?.config as Record<string, unknown>).remote).toBe('upstream');
  });
});

describe('share is routed through the applier that owns its second half', () => {
  it('persists the key AND regenerates the ignore block, in one code path', () => {
    // Writing the key alone would leave the generated block stating a mode the
    // project no longer has.
    const result = invoke('set', ['share=shared']);
    expect(result.exitCode).toBe(0);
    expect(configText()).toContain('share: shared');
    expect(existsSync(join(tempProject, '.gitignore'))).toBe(true);
  });

  it('refuses a mode that is not one of the two', () => {
    const result = invoke('set', ['share=everyone']);
    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('not a valid value');
    expect(existsSync(configPath())).toBe(false);
  });
});

describe('renamed keys — the old workspace_* names', () => {
  it('lists only the new names, and resolves the old ones to the same spec', () => {
    for (const [current, legacy] of [
      ['worktree_start', 'workspace_start'],
      ['worktree_cap', 'workspace_cap'],
      ['worktree_setup', 'workspace_setup'],
      ['worktree_setup_timeout_ms', 'workspace_setup_timeout_ms'],
    ]) {
      expect(Object.keys(FLOW_KEYS)).toContain(current);
      expect(Object.keys(FLOW_KEYS)).not.toContain(legacy);
      expect(specFor(legacy)).toBe(specFor(current));
    }
  });

  it('writes the NEW key AND the old one with the same value (transitional dual-write)', () => {
    seed(['# keep me', 'workspace_start: trunk', 'commit: true', ''].join('\n'));
    const result = invoke('set', ['worktree_start=here']);
    expect(result.exitCode).toBe(0);
    expect(configText()).toBe(
      ['# keep me', 'workspace_start: here', 'commit: true', 'worktree_start: here', ''].join('\n'),
    );
    expect(result.json?.set).toEqual({ worktree_start: 'here' });
  });

  it('accepts the OLD name as input and writes both spellings', () => {
    seed(['workspace_cap: 4', ''].join('\n'));
    const result = invoke('set', ['workspace_cap=12']);
    expect(result.exitCode).toBe(0);
    expect(configText()).toBe('workspace_cap: 12\nworktree_cap: 12\n');
    // Reported under the name that was written, so nobody is told about a key the file does not hold.
    expect(result.json?.set).toEqual({ worktree_cap: '12' });
  });

  it('dual-writes ONLY the setting being set — every other old key stays put', () => {
    const before = [
      'workspace_start: trunk',
      'workspace_setup: uv sync',
      'workspace_setup_timeout_ms: 60000',
      'workspace_cap: 4',
      '',
    ].join('\n');
    seed(before);
    expect(invoke('set', ['worktree_setup=npm ci']).exitCode).toBe(0);
    expect(configText()).toBe(
      [
        'workspace_start: trunk',
        'workspace_setup: npm ci',
        'workspace_setup_timeout_ms: 60000',
        'workspace_cap: 4',
        'worktree_setup: npm ci',
        '',
      ].join('\n'),
    );
  });

  it('a set of a key nobody renamed never touches an old key', () => {
    seed(['workspace_start: trunk', ''].join('\n'));
    expect(invoke('set', ['commit=true']).exitCode).toBe(0);
    expect(configText()).toBe(['workspace_start: trunk', 'commit: true', ''].join('\n'));
  });

  it('replaces the new key in place when the file already holds it, adding the old one', () => {
    seed(['worktree_start: trunk', 'commit: true', ''].join('\n'));
    expect(invoke('set', ['worktree_start=here']).exitCode).toBe(0);
    expect(configText()).toBe(
      ['worktree_start: here', 'commit: true', 'workspace_start: here', ''].join('\n'),
    );
  });

  it('unset takes the setting back to its default by removing BOTH spellings', () => {
    seed(['workspace_cap: 4', 'worktree_cap: 8', 'workspace_start: trunk', ''].join('\n'));
    const result = invoke('unset', ['workspace_cap']);
    expect(result.exitCode).toBe(0);
    expect(configText()).toBe('workspace_start: trunk\n');
    expect(result.json?.unset).toEqual(['worktree_cap']);
  });

  it('unset of a renamed key the file holds only under its old name reports it removed', () => {
    seed(['workspace_start: trunk', ''].join('\n'));
    const result = invoke('unset', ['worktree_start']);
    expect(result.json?.unset).toEqual(['worktree_start']);
    expect(result.json?.absent).toEqual([]);
    expect(configText()).toBe('');
  });

  it('reads an old key as the setting it was renamed to', () => {
    seed(['workspace_start: branch:release/2.0', ''].join('\n'));
    const result = invoke('show', []);
    expect((result.json?.config as Record<string, unknown>).worktree_start).toBe('branch:release/2.0');
  });
});

describe('the key table', () => {
  it('holds every key the settings panel and the skills write', () => {
    for (const key of [
      'autopilot',
      'commit',
      'push',
      'pr',
      'pr_draft',
      'guarded_autopilot',
      'branch',
      'remote',
      'remote_branch_pattern',
      'thread_worktrees',
      'worktree_start',
      'base_refresh',
      'base_refresh_timeout_ms',
      // THE THREE THIS LIST CLAIMED TO HOLD AND DID NOT. The settings panel has
      // had rows for them for as long as they have existed and `flow set`
      // answered "unknown key" for every one — while the test above them said
      // it held "every key the settings panel and the skills write". A list
      // that names its own subjects cannot catch the one nobody added to it, so
      // the count below is the half that fails when they drift apart
      // (2026-09-18).
      'worktree_setup',
      'worktree_setup_timeout_ms',
      'worktree_cap',
      'model_routing',
      'phase_isolation',
      'wave_execution',
      'max_verify_retries',
      'walkthrough_model',
      'learn_auto',
      'learn_ignore',
      'share',
      'webhook_url',
      'telegram_bot_token',
      'telegram_chat_id',
      'commands.lint',
    ]) {
      expect(specFor(key)).not.toBeNull();
    }
    expect(Object.keys(FLOW_KEYS)).toHaveLength(28);
  });

  it('describes each key in the setting’s own words, never the key’s spelling', () => {
    // The help is what a person reads, so it says what the setting DOES.
    // "branch" is an English word and stays; `remote_branch_pattern` is a
    // key's spelling and does not — nor does the file it lives in.
    for (const [key, spec] of Object.entries(FLOW_KEYS)) {
      expect(spec.help.length).toBeGreaterThan(0);
      if (key.includes('_') || key.includes('.')) expect(spec.help).not.toContain(key);
      expect(spec.help).not.toContain('.flowconfig');
      expect(spec.help).not.toContain('planflow-ai');
      expect(spec.help).not.toContain('`');
    }
  });

  it('accepts nothing outside the family shape', () => {
    expect(specFor('engines.lavish')).not.toBeNull();
    expect(specFor('engines.Lavish')).toBeNull();
    expect(specFor('engines.')).toBeNull();
    expect(specFor('__proto__')).toBeNull();
  });

  it('names the key and the value in every refusal reason', () => {
    const spec = specFor('commit')!;
    expect(invalidValueReason('commit', spec, 'yes')).toContain("'yes'");
    expect(invalidValueReason('commit', spec, 'yes')).toContain('commit');
    expect(invalidValueReason('commit', spec, 'true')).toBeNull();
  });
});
