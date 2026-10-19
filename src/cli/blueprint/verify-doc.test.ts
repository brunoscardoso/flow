import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordVerdict, writeFileTiers, type FileTierStore } from './file-tiers.js';
import { promoteDoc } from './verify-doc.js';

describe('verify-doc promotion', () => {
  let repoRoot: string;
  let flowDir: string;

  const seed = (): void => {
    mkdirSync(join(repoRoot, 'docs'), { recursive: true });
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
    writeFileSync(join(repoRoot, 'docs', 'api.md'), '# API\nAuth uses JWT.\nRate limit is 100/min.\n');
    writeFileSync(join(repoRoot, 'src', 'auth.ts'), 'export const auth = "session"');
    const store: FileTierStore = {
      derivedAt: '2026-07-25T00:00:00Z',
      entries: [
        { path: 'docs/api.md', tier: 'claim' },
        { path: 'src/auth.ts', tier: 'code' },
      ],
    };
    writeFileTiers(flowDir, store);
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'pf-verifydoc-'));
    flowDir = join(repoRoot, 'flow');
    mkdirSync(flowDir, { recursive: true });
    seed();
  });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  const recordClaims = (): void => {
    const result = recordVerdict(
      repoRoot,
      flowDir,
      {
        path: 'docs/api.md',
        verdict: 'contradicted', // rollup: one contradicted claim below
        against: ['src/auth.ts'],
        provenance: 'verify-agent',
        claims: [
          { claim: 'Rate limit is 100/min', outcome: 'corroborated', witnesses: ['src/auth.ts'], note: 'limiter constant matches' },
          { claim: 'Auth uses JWT', outcome: 'contradicted', witnesses: ['src/auth.ts'], note: 'code uses sessions' },
        ],
      },
      new Date('2026-07-25T12:00:00.000Z'),
    );
    expect(result).toEqual({ ok: true });
  };

  it('promotes corroborated claims into the brain with provenance + witness hashes; contradictions become observations', () => {
    recordClaims();
    const promoted = promoteDoc(repoRoot, 'docs/api.md', new Date('2026-07-25T12:01:00.000Z'));
    expect(promoted.ok).toBe(true);
    expect(promoted.promotedClaims).toBe(1);
    expect(promoted.contradictedObservations).toBe(1);
    const brain = readFileSync(promoted.brainFile as string, 'utf-8');
    expect(brain).toContain('## Rate limit is 100/min');
    expect(brain).toContain('limiter constant matches');
    expect(brain).toContain('`src/auth.ts`');
    expect(brain).toContain('verify-agent');
    expect(brain).not.toContain('Auth uses JWT'); // contradicted never promotes
    const observations = readFileSync(join(flowDir, 'brain', '.structure', 'investigations.jsonl'), 'utf-8');
    expect(observations).toContain('doc contradicted by code:');
    expect(observations).toContain('Auth uses JWT');
    expect(observations).toContain('"status":"contradicted"');
  });

  it('refuses without a per-claim verdict; removes the brain file when nothing corroborates', () => {
    expect(promoteDoc(repoRoot, 'docs/api.md').ok).toBe(false); // no verdict at all
    const record = recordVerdict(repoRoot, flowDir, {
      path: 'docs/api.md',
      verdict: 'contradicted',
      against: ['src/auth.ts'],
      provenance: 'verify-agent',
      claims: [{ claim: 'Auth uses JWT', outcome: 'contradicted', witnesses: ['src/auth.ts'] }],
    });
    expect(record).toEqual({ ok: true });
    const promoted = promoteDoc(repoRoot, 'docs/api.md');
    expect(promoted.ok).toBe(true);
    expect(promoted.promotedClaims).toBe(0);
    expect(existsSync(promoted.brainFile as string)).toBe(false);
  });
});
