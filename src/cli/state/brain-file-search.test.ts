/**
 * Tests for `chunkMarkdown`'s fence handling: fenced code is opaque to
 * headings, and an `html` fence (an inline markup sample) is left out of
 * every chunk's text — fence lines included — so markup never outranks prose.
 * Other fences are kept verbatim, and heading line numbers stay true to the
 * source file even after omitted lines.
 */

import { chunkMarkdown } from './brain-file-search.js';

const FENCE = '```';

const DOC = [
  '# Discovery', //                         1
  '', //                                    2
  '## Screens', //                          3
  '### Step: Open', //                      4
  'Prose about the step.', //               5
  `${FENCE}html height=400`, //             6
  '<div class="zzmockupmarker">hi</div>', // 7
  '# Not a heading inside html', //         8
  FENCE, //                                 9
  '', //                                   10
  `${FENCE}ts`, //                         11
  '# not a heading in ts either', //       12
  'const kept = 1;', //                    13
  FENCE, //                                14
  '', //                                   15
  '## After', //                           16
  'Tail prose.', //                        17
].join('\n');

describe('chunkMarkdown — fences', () => {
  const chunks = chunkMarkdown('flow/discovery/discovery_x_v1.md', DOC);

  it('produces a chunk per real heading only', () => {
    expect(chunks.map((chunk) => chunk.heading)).toEqual(['Discovery', 'Screens', 'Step: Open', 'After']);
  });

  it('omits html fence content and its fence lines from every chunk', () => {
    for (const chunk of chunks) {
      expect(chunk.text).not.toContain('zzmockupmarker');
      expect(chunk.text).not.toContain('Not a heading inside html');
      expect(chunk.text).not.toContain(`${FENCE}html`);
    }
  });

  it('keeps a non-html fence verbatim, fence lines included', () => {
    const walk = chunks.find((chunk) => chunk.heading === 'Step: Open');
    expect(walk?.text).toBe(
      [
        '### Step: Open',
        'Prose about the step.',
        '',
        `${FENCE}ts`,
        '# not a heading in ts either',
        'const kept = 1;',
        FENCE,
      ].join('\n'),
    );
  });

  it('does not open a chunk at a `#` line inside a fence', () => {
    expect(chunks.some((chunk) => chunk.heading?.startsWith('not a heading'))).toBe(false);
    expect(chunks.some((chunk) => chunk.heading?.startsWith('Not a heading'))).toBe(false);
  });

  it('keeps source line numbers for headings after an omitted fence', () => {
    expect(chunks.map((chunk) => chunk.line)).toEqual([1, 3, 4, 16]);
  });

  it('treats an unclosed html fence as running to the end of the file', () => {
    const out = chunkMarkdown('f.md', ['## A', 'prose', `${FENCE}html`, '## B', '<p>x</p>'].join('\n'));
    expect(out).toEqual([{ file: 'f.md', heading: 'A', line: 1, text: '## A\nprose' }]);
  });

  it('closes a fence only on a marker at least as long as its opener', () => {
    const out = chunkMarkdown(
      'f.md',
      ['## A', '````html', '```', '<p>still inside</p>', '````', '## B', 'b'].join('\n'),
    );
    expect(out.map((chunk) => chunk.text)).toEqual(['## A', '## B\nb']);
  });
});
