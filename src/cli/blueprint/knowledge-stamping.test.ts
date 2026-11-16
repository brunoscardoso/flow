/**
 * The description writers stamp where knowledge was learned
 * (`workspace_knowledge_draft_solid`, phase 1): `writeLearned`, `writeParts`,
 * `writeFeatureView`, `appendInvestigationNote`, and the verbs that call them
 * refuse a caller-supplied `learnedAt`.
 */
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  mintFeatureId,
  parseLearnings,
  readFeatures,
  readParts,
  splitLearned,
  writeFeature,
  writeLearned,
  writeParts,
  type FeatureNode,
} from './feature-store.js';
import { readFeatureView, writeFeatureView, type FeatureView } from './feature-view.js';
import { appendInvestigationNote, compactInvestigations, readInvestigations } from './investigation-store.js';
import { readProvenanceRecords } from '../state/knowledge-provenance.js';
import { runBlueprint, type BlueprintCommandOptions } from '../commands/blueprint.js';

const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_OK ? describe : describe.skip;

/** The line grammar an older build matches — copied verbatim from before this change. */
const OLD_BUILD_LINE_RE =
  /^-\s+(.*?)\s*<!--\s*learned:\s*(\S+)\s+(\d{4}-\d{2}-\d{2})(\s+pinned)?(?:\s+superseded:\s*(.*?))?\s*-->\s*$/;

function node(slug: string, extra: Partial<FeatureNode> = {}): FeatureNode {
  return {
    id: mintFeatureId(slug),
    slug,
    name: slug,
    kind: 'core',
    anchors: [],
    relates: [],
    lastFullRead: null,
    patchCount: 0,
    body: `# ${slug}\n`,
    extra: {},
    ...extra,
  };
}

describe('the ## Learned line grammar', () => {
  it('still parses a line written before stamping, with no learnedAt', () => {
    const [entry] = parseLearnings('- Orders retry twice. <!-- learned: code 2026-11-01 pinned -->');
    expect(entry).toEqual({ text: 'Orders retry twice.', provenance: 'code', date: '2026-11-01', pinned: true });
  });

  it('parses the optional learnedAt and keeps it apart from the text', () => {
    const [entry] = parseLearnings(
      '- Orders retry twice. <!-- learnedAt: 0123456789abcdef --> <!-- learned: code 2026-11-16 superseded: moved -->',
    );
    expect(entry).toEqual({
      text: 'Orders retry twice.',
      provenance: 'code',
      date: '2026-11-16',
      supersededReason: 'moved',
      learnedAt: '0123456789abcdef',
    });
  });

  it('a stamped line is still a learning line to an older build, which keeps the stamp in the text', () => {
    const line = '- Orders retry twice. <!-- learnedAt: 0123456789abcdef --> <!-- learned: code 2026-11-16 -->';
    const match = OLD_BUILD_LINE_RE.exec(line);
    expect(match).not.toBeNull();
    // The older build writes `- ${text} <!-- learned: … -->` back: byte-identical.
    expect(`- ${match?.[1]} <!-- learned: ${match?.[2]} ${match?.[3]} -->`).toBe(line);
  });
});

describeWithGit('the writers stamp from the checkout', () => {
  let repo: string;
  let flowDir: string;

  const sh = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };

  async function run(action: string, options: BlueprintCommandOptions, target?: string): Promise<string> {
    const chunks: string[] = [];
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(String(chunk));
      return true;
    });
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(String(chunk));
      return true;
    });
    const cwd = process.cwd();
    const exitCode = process.exitCode;
    process.chdir(repo);
    try {
      await runBlueprint(action, target, options);
    } finally {
      out.mockRestore();
      err.mockRestore();
      process.chdir(cwd);
      process.exitCode = exitCode;
    }
    return chunks.join('');
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'pf-stamping-'));
    flowDir = join(repo, 'flow');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'orders.ts'), 'export const orders = 1;\n');
    writeFileSync(join(repo, '.gitignore'), 'flow/\n');
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    sh('config', 'user.name', 'Test Person');
    sh('config', 'user.email', 'test@example.com');
    sh('add', '-A');
    sh('commit', '-q', '-m', 'first');
    writeFeature(flowDir, node('orders', { anchors: ['file:src/orders.ts', 'module:src'] }));
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function learnedOnDisk(): ReturnType<typeof parseLearnings> {
    const feature = readFeatures(flowDir).find((entry) => entry.slug === 'orders');
    return parseLearnings(splitLearned(feature?.body ?? '').learned);
  }

  it('stamps new learnings; ones already on disk keep their stamp — or stay unstamped', () => {
    // An unstamped learning, as every learning written before this was.
    writeFileSync(
      join(flowDir, 'brain', 'features', 'orders.md'),
      `${readFileSync(join(flowDir, 'brain', 'features', 'orders.md'), 'utf-8')}\n## Learned\n\n- Old fact. <!-- learned: code 2026-01-01 -->\n`,
    );
    sh('checkout', '-q', '-b', 'feat/retry');
    writeLearned(flowDir, 'orders', [
      { text: 'Old fact.', provenance: 'code', date: '2026-01-01' },
      // A caller's own learnedAt is never used.
      { text: 'Orders retry twice.', provenance: 'code', date: '2026-11-16', learnedAt: 'ffffffffffffffff' },
    ]);
    const learned = learnedOnDisk();
    const fresh = learned.find((entry) => entry.text === 'Orders retry twice.');
    expect(fresh?.learnedAt).toMatch(/^[0-9a-f]{16}$/);
    expect(fresh?.learnedAt).not.toBe('ffffffffffffffff');
    expect(learned.find((entry) => entry.text === 'Old fact.')?.learnedAt).toBeUndefined();

    const record = readProvenanceRecords(flowDir).get(fresh?.learnedAt as string);
    expect(record).toMatchObject({ branch: 'feat/retry', commit: sh('rev-parse', 'HEAD') });
    expect(record?.hashes.map((hash) => hash.path)).toEqual(['src/orders.ts']);

    // A rewrite that supersedes the stamped learning keeps its stamp.
    writeLearned(flowDir, 'orders', [
      { text: 'Old fact.', provenance: 'code', date: '2026-01-01' },
      { text: 'Orders retry twice.', provenance: 'code', date: '2026-11-16', supersededReason: 'now three' },
    ]);
    expect(learnedOnDisk().find((entry) => entry.text === 'Orders retry twice.')?.learnedAt).toBe(fresh?.learnedAt);
  });

  it('a line the writer stamps round-trips byte-identical through an older build', () => {
    sh('checkout', '-q', '-b', 'feat/retry');
    writeLearned(flowDir, 'orders', [
      { text: 'Orders retry twice.', provenance: 'code', date: '2026-11-16' },
      { text: 'Orders pin this.', provenance: 'test', date: '2026-11-15', pinned: true },
      { text: 'Orders moved.', provenance: 'code', date: '2026-11-14', supersededReason: 'now three' },
    ]);
    const lines = splitLearned(readFeatures(flowDir).find((entry) => entry.slug === 'orders')?.body ?? '')
      .learned.split('\n')
      .filter((line) => line.startsWith('- '));
    // Positive first: the writer really stamped every line it wrote.
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/<!-- learnedAt: [0-9a-f]{16} -->/);
      const match = OLD_BUILD_LINE_RE.exec(line);
      expect(match).not.toBeNull();
      // The older build sees the stamp as part of the text and writes it back unchanged.
      expect(match?.[1]).toMatch(/ <!-- learnedAt: [0-9a-f]{16} -->$/);
      const flags = `${match?.[4] ?? ''}${match?.[5] === undefined ? '' : ` superseded: ${match[5]}`}`;
      expect(`- ${match?.[1]} <!-- learned: ${match?.[2]} ${match?.[3]}${flags} -->`).toBe(line);
    }
  });

  it('stamps part learnings against the part anchors, and carries ## Learned stamps through', () => {
    writeLearned(flowDir, 'orders', [{ text: 'Top fact.', provenance: 'code', date: '2026-11-16' }]);
    const top = learnedOnDisk()[0].learnedAt;
    expect(top).toMatch(/^[0-9a-f]{16}$/);
    writeParts(flowDir, 'orders', [
      { name: 'Retry', summary: 's', anchors: ['src/orders.ts'], learnings: [{ text: 'Part fact.', provenance: 'code', date: '2026-11-16' }] },
    ]);
    const part = readParts(flowDir, 'orders')[0];
    expect(part.learnings[0].learnedAt).toMatch(/^[0-9a-f]{16}$/);
    expect(learnedOnDisk()[0].learnedAt).toBe(top);
    expect(readProvenanceRecords(flowDir).get(part.learnings[0].learnedAt as string)?.onDefault).toBe(true);
  });

  it('stamps a note, and the stamp survives compaction', () => {
    appendInvestigationNote(flowDir, {
      ts: '2026-11-16T00:00:00.000Z',
      runId: null,
      anchors: [{ kind: 'file', ref: 'src/orders.ts' }],
      text: 'Orders retry.',
      provenance: 'test',
      status: 'observed',
      hashStamps: [],
      learnedAt: 'ffffffffffffffff',
    });
    const stamped = readInvestigations(flowDir).notes[0].learnedAt;
    expect(stamped).toMatch(/^[0-9a-f]{16}$/);
    expect(stamped).not.toBe('ffffffffffffffff');
    compactInvestigations(flowDir);
    expect(readInvestigations(flowDir).notes[0].learnedAt).toBe(stamped);
  });

  it('stamps a written view; a heal-style write keeps the stamp it read', () => {
    const view: FeatureView = {
      feature: 'orders',
      provenance: 'code',
      generatedAt: '2026-11-16',
      meta: { title: 'Orders' },
      brief: {} as FeatureView['brief'],
      views: {
        root: {
          title: 'Orders',
          nodes: [
            {
              id: 'o',
              kind: 'module',
              title: 'Orders',
              delta: 'stable',
              code: { file: 'src/orders.ts', from: 1, to: 1, text: 'export const orders = 1;', note: 'The count.' },
            },
          ],
          edges: [],
        },
      } as unknown as FeatureView['views'],
      learnedAt: 'ffffffffffffffff',
    };
    const result = writeFeatureView(flowDir, view, repo);
    expect(result).toEqual({ ok: true, errors: [] });
    const written = readFeatureView(flowDir, 'orders');
    expect(written?.learnedAt).toMatch(/^[0-9a-f]{16}$/);
    expect(written?.learnedAt).not.toBe('ffffffffffffffff');
    expect(readProvenanceRecords(flowDir).get(written?.learnedAt as string)?.hashes.map((hash) => hash.path)).toEqual([
      'src/orders.ts',
    ]);
    writeFeatureView(flowDir, written as FeatureView, repo, { keepLearnedAt: true });
    expect(readFeatureView(flowDir, 'orders')?.learnedAt).toBe(written?.learnedAt);
  });

  it('every verb refuses a caller-supplied learnedAt and writes nothing', async () => {
    // Positive first (#28): the same verb accepts the entry without it.
    const ok = await run('features', { feature: 'orders', entry: JSON.stringify({ text: 'Fine.', provenance: 'code', date: '2026-11-16' }) }, 'learned');
    expect(ok).toContain('1 learning(s)');
    const before = readFileSync(join(flowDir, 'brain', 'features', 'orders.md'), 'utf-8');

    const learned = await run(
      'features',
      { feature: 'orders', entry: JSON.stringify({ text: 'Forged.', provenance: 'code', date: '2026-11-16', learnedAt: '0123456789abcdef' }) },
      'learned',
    );
    expect(learned).toContain('features refused: "learnedAt" is stamped by the writer');

    const parts = await run(
      'features',
      {
        feature: 'orders',
        write: JSON.stringify([
          { name: 'Retry', anchors: ['src/orders.ts'], learnings: [{ text: 'Forged.', learnedAt: '0123456789abcdef' }] },
        ]),
      },
      'parts',
    );
    expect(parts).toContain('features refused: part \'Retry\': "learnedAt" is stamped by the writer');

    const view = await run(
      'features',
      { feature: 'orders', write: JSON.stringify({ learnedAt: '0123456789abcdef', views: { root: { title: 'x', nodes: [], edges: [] } } }) },
      'view',
    );
    expect(view).toContain('features refused: "learnedAt" is stamped by the writer');

    expect(readFileSync(join(flowDir, 'brain', 'features', 'orders.md'), 'utf-8')).toBe(before);
    expect(readFeatureView(flowDir, 'orders')).toBeNull();
    expect(readFeatures(flowDir)).toHaveLength(1);

    const observe = await run('observe', {
      json: JSON.stringify({ text: 'Forged.', anchors: [{ kind: 'file', ref: 'src/orders.ts' }], learnedAt: '0123456789abcdef' }),
    });
    expect(observe).toContain('observe refused: invalid --json payload — "learnedAt" is stamped by the writer');
    expect(readInvestigations(flowDir).notes).toEqual([]);
  });
});
