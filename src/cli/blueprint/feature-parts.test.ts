/**
 * Tests for a feature's PARTS — its children, learned in their own right.
 *
 * The rule that carries the weight is the same one `## Learned` has: the region
 * is MACHINE-OWNED, and everything above it is untouchable. A writer that
 * rewrote human prose while recording what it learned would destroy the thing
 * the file exists to hold.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseParts,
  readParts,
  serializeParts,
  splitParts,
  writeParts,
  type FeaturePart,
} from './feature-store.js';

function part(patch: Partial<FeaturePart> = {}): FeaturePart {
  return {
    name: 'Live events SSE',
    summary: 'The reconnect/resume channel.',
    anchors: ['src/app/api/chat/[chatId]/events'],
    learnings: [
      { text: 'Redis pub/sub is server-side only.', provenance: 'code', date: '2026-08-04' },
    ],
    ...patch,
  };
}

function featureRepo(body: string): { flowDir: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'parts-'));
  const flowDir = join(root, 'flow');
  const dir = join(flowDir, 'brain', 'features');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'chats.md');
  writeFileSync(file, `---\nid: f_chats\nkind: core\nanchors: []\n---\n${body}`, 'utf-8');
  return { flowDir, file };
}

describe('splitParts', () => {
  it('cuts human prose, learnings and parts apart', () => {
    const split = splitParts('# Chats\n\nprose\n\n## Learned\n\n- a <!-- learned: code 2026-08-04 -->\n\n## Parts\n\n### SSE\n');
    expect(split.human).toContain('prose');
    expect(split.learned).toContain('- a');
    expect(split.parts).toContain('### SSE');
  });

  it('reads a file written before parts existed as all human', () => {
    const split = splitParts('# Chats\n\nprose only\n');
    expect(split.parts).toBeNull();
    expect(split.human).toContain('prose only');
  });
});

describe('parseParts / serializeParts', () => {
  it('round-trips a part with its anchors and learnings', () => {
    const back = parseParts(serializeParts([part()]));
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe('Live events SSE');
    expect(back[0].anchors).toEqual(['src/app/api/chat/[chatId]/events']);
    expect(back[0].learnings[0].text).toBe('Redis pub/sub is server-side only.');
  });

  it('keeps several parts in the order they were written', () => {
    const back = parseParts(
      serializeParts([part({ name: 'A' }), part({ name: 'B' }), part({ name: 'C' })]),
    );
    expect(back.map((entry) => entry.name)).toEqual(['A', 'B', 'C']);
  });

  it('reads a part that has been named but not yet learned', () => {
    const back = parseParts(serializeParts([part({ learnings: [] })]));
    expect(back[0].learnings).toEqual([]);
    expect(back[0].name).toBe('Live events SSE');
  });

  it('is deterministic — the same parts render the same bytes', () => {
    expect(serializeParts([part()])).toBe(serializeParts([part()]));
  });

  it('claims nothing for a feature with no parts region', () => {
    expect(parseParts(null)).toEqual([]);
  });
});

describe('writeParts', () => {
  it('leaves the human prose and the learnings BYTE-FOR-BYTE alone', () => {
    // The file holds knowledge someone wrote by hand. A parts writer that
    // reformatted it while recording what it learned would destroy the thing
    // the file exists for.
    const human = '# Chats\n\nOwned by the platform team.\n\n## Notes\n\nHand-written.\n';
    const learned = '## Learned\n\n- The engine is stateless. <!-- learned: code 2026-08-03 -->\n';
    const { flowDir, file } = featureRepo(`${human}\n${learned}`);

    writeParts(flowDir, 'chats', [part()]);

    const after = readFileSync(file, 'utf-8');
    expect(after).toContain('Owned by the platform team.');
    expect(after).toContain('Hand-written.');
    expect(after).toContain('- The engine is stateless. <!-- learned: code 2026-08-03 -->');
    expect(after).toContain('### Live events SSE');
  });

  it('replaces the parts region rather than appending a second one', () => {
    const { flowDir, file } = featureRepo('# Chats\n\nprose\n');
    writeParts(flowDir, 'chats', [part({ name: 'First' })]);
    writeParts(flowDir, 'chats', [part({ name: 'Second' })]);
    const after = readFileSync(file, 'utf-8');
    expect(after.match(/^## Parts$/gm)).toHaveLength(1);
    expect(after).toContain('### Second');
    expect(after).not.toContain('### First');
  });

  it('refuses a feature that does not exist rather than creating one', () => {
    const { flowDir } = featureRepo('# Chats\n');
    expect(() => writeParts(flowDir, 'nope', [part()])).toThrow(/no feature/);
  });
});

describe('readParts', () => {
  it('reads back what was written', () => {
    const { flowDir } = featureRepo('# Chats\n\nprose\n');
    writeParts(flowDir, 'chats', [part(), part({ name: 'Chat SDK', anchors: ['src/app/sdk/chat'] })]);
    const back = readParts(flowDir, 'chats');
    expect(back.map((entry) => entry.name)).toEqual(['Live events SSE', 'Chat SDK']);
  });

  it('is empty for a feature that has none, and for one that is missing', () => {
    const { flowDir } = featureRepo('# Chats\n\nprose\n');
    expect(readParts(flowDir, 'chats')).toEqual([]);
    expect(readParts(flowDir, 'ghost')).toEqual([]);
  });
});
