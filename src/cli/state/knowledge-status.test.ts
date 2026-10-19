import { describe, expect, it } from '@jest/globals';

import {
  UNSTAMPED,
  isRunToken,
  knowledgeDisposition,
  readKnowledgeStamp,
  runTrailer,
  splitKnowledgeFrontmatter,
  writeKnowledgeStamp,
} from './knowledge-status.js';

const FEATURE = `---
id: feature:orders-api::orders
name: Orders
kind: core
anchors: [file:src/orders.ts]
relates: []
author: A Person
---
# Orders

What it does.
`;

describe('readKnowledgeStamp', () => {
  it('reads a document with no frontmatter as unstamped, which shares', () => {
    expect(readKnowledgeStamp('# Just a heading\n')).toEqual(UNSTAMPED);
    expect(knowledgeDisposition(readKnowledgeStamp('# Just a heading\n'), null)).toBe('share');
  });

  it('reads both keys, and ignores the ones other writers own', () => {
    const raw = FEATURE.replace('author: A Person', 'author: A Person\nstatus: draft\nlanded_by: run_a1b2c3');
    expect(readKnowledgeStamp(raw)).toEqual({ readiness: 'draft', landedBy: 'run_a1b2c3' });
  });

  it('does not read an unrecognised status as a decision', () => {
    // Documents carry all sorts of status words. Treating one this module does
    // not know as "hold" would let unrelated prose withhold a file for ever.
    for (const word of ['approved', 'in-progress', 'done', 'Draft ', '']) {
      const raw = `---\nstatus: ${word}\n---\n# X\n`;
      expect(readKnowledgeStamp(raw).readiness).toBe(null);
      expect(knowledgeDisposition(readKnowledgeStamp(raw), null)).toBe('share');
    }
  });

  it('ignores an unterminated fence rather than reading the body as frontmatter', () => {
    // Otherwise a half-written file, or a line of prose reading `status: draft`,
    // decides whether a team sees the document.
    const raw = '---\nstatus: draft\n\n# Heading\n\nstatus: draft appears in prose too.\n';
    expect(splitKnowledgeFrontmatter(raw).fm).toEqual([]);
    expect(readKnowledgeStamp(raw)).toEqual(UNSTAMPED);
  });

  it('reads a stamp written into a CRLF document', () => {
    const raw = '---\r\nstatus: draft\r\n---\r\n# X\r\n';
    expect(readKnowledgeStamp(raw).readiness).toBe('draft');
  });
});

describe('writeKnowledgeStamp', () => {
  it('keeps every key it does not own, and the body byte-for-byte', () => {
    const out = writeKnowledgeStamp(FEATURE, { readiness: 'draft', landedBy: 'run_a1b2c3' });
    for (const kept of ['id: feature:orders-api::orders', 'anchors: [file:src/orders.ts]', 'author: A Person']) {
      expect(out).toContain(kept);
    }
    expect(out).toContain('status: draft');
    expect(out).toContain('landed_by: run_a1b2c3');
    expect(splitKnowledgeFrontmatter(out).body).toBe(splitKnowledgeFrontmatter(FEATURE).body);
  });

  it('adds frontmatter to a document that had none', () => {
    const out = writeKnowledgeStamp('# Orders\n\nWhat it does.\n', { readiness: 'draft' });
    expect(out).toBe('---\nstatus: draft\n---\n# Orders\n\nWhat it does.\n');
    expect(readKnowledgeStamp(out).readiness).toBe('draft');
  });

  it('replaces a key in place instead of appending a second one', () => {
    const once = writeKnowledgeStamp(FEATURE, { readiness: 'draft' });
    const twice = writeKnowledgeStamp(once, { readiness: 'shared' });
    expect(twice.match(/^status:/gm)).toHaveLength(1);
    expect(readKnowledgeStamp(twice).readiness).toBe('shared');
  });

  it('removes a key on null and leaves it alone on undefined', () => {
    const stamped = writeKnowledgeStamp(FEATURE, { readiness: 'draft', landedBy: 'run_x' });
    const cleared = writeKnowledgeStamp(stamped, { readiness: null });
    expect(readKnowledgeStamp(cleared)).toEqual({ readiness: null, landedBy: 'run_x' });
    expect(readKnowledgeStamp(writeKnowledgeStamp(cleared, {}))).toEqual({ readiness: null, landedBy: 'run_x' });
  });

  it('round-trips: what it writes is what it reads', () => {
    for (const readiness of ['draft', 'shared'] as const) {
      const out = writeKnowledgeStamp(FEATURE, { readiness, landedBy: 'run_a1b2c3' });
      expect(readKnowledgeStamp(out)).toEqual({ readiness, landedBy: 'run_a1b2c3' });
    }
  });
});

describe('knowledgeDisposition', () => {
  it('shares an unstamped document whatever the landing answer is', () => {
    // THE DEFAULT THAT MAKES THIS SHIPPABLE. A real Workspace holds hundreds of
    // unstamped documents; holding them would withdraw all of them from the
    // team on the next sync, which every teammate reads as a deletion.
    for (const landed of [true, false, null]) {
      expect(knowledgeDisposition(UNSTAMPED, landed)).toBe('share');
    }
  });

  it('never shares a draft, however its work landed', () => {
    for (const landed of [true, false, null]) {
      expect(knowledgeDisposition({ readiness: 'draft', landedBy: 'run_x' }, landed)).toBe('hold-draft');
    }
  });

  it('holds a stamped document whose token has not reached the default branch', () => {
    expect(knowledgeDisposition({ readiness: null, landedBy: 'run_x' }, false)).toBe('hold-pending');
    expect(knowledgeDisposition({ readiness: null, landedBy: 'run_x' }, true)).toBe('share');
  });

  it('shares when the landing question could not be asked at all', () => {
    // `null` is "the checkout is not on this computer, or git refused". A gate
    // that silently stops publishing because a folder moved is indistinguishable
    // from a gate that is broken.
    expect(knowledgeDisposition({ readiness: null, landedBy: 'run_x' }, null)).toBe('share');
  });

  it("lets an explicit 'shared' outrank the token", () => {
    // How a person publishes a document whose work will never be a commit — a
    // meeting note, a decision — and how they override a trailer a hand-edited
    // squash message ate.
    expect(knowledgeDisposition({ readiness: 'shared', landedBy: 'run_x' }, false)).toBe('share');
  });
});

describe('the run token', () => {
  it('accepts the ids a driver mints and refuses anything that could reach a shell or a glob', () => {
    expect(isRunToken('run_a1b2c3')).toBe(true);
    expect(isRunToken('orders-20261016-120000')).toBe(true);
    for (const bad of ['', '-leading', 'has space', 'star*', 'semi;colon', '$(whoami)', '..', 'a'.repeat(129)]) {
      expect(isRunToken(bad)).toBe(false);
    }
  });

  it('writes a trailer git can be asked about verbatim', () => {
    expect(runTrailer('run_a1b2c3')).toBe('Flow-Run: run_a1b2c3');
  });
});
