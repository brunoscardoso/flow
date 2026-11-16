import { describe, expect, it } from '@jest/globals';

import {
  UNSTAMPED,
  documentStampKind,
  readKnowledgeStamp,
  splitKnowledgeFrontmatter,
  writeKnowledgeStamp,
} from './knowledge-status.js';

const COMMIT = 'a'.repeat(40);

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
  it('reads a document with no frontmatter as unstamped, which is solid', () => {
    expect(readKnowledgeStamp('# Just a heading\n')).toEqual(UNSTAMPED);
    expect(documentStampKind(readKnowledgeStamp('# Just a heading\n'))).toBe('unstamped');
  });

  it('reads every key, and ignores the ones other writers own', () => {
    const raw = FEATURE.replace('author: A Person', `author: A Person\nstatus: draft\nbranch: feat/orders\ncommit: ${COMMIT}`);
    expect(readKnowledgeStamp(raw)).toEqual({ readiness: 'draft', branch: 'feat/orders', commit: COMMIT });
  });

  it('reads an older `status: draft` as a draft instead of holding it', () => {
    // FR-3: the hold gate is retired. A legacy draft is still a draft — one
    // nothing can promote, because it names no commit.
    expect(documentStampKind(readKnowledgeStamp('---\nstatus: draft\n---\n# X\n'))).toBe('draft');
  });

  it('does not read an unrecognised status, or a malformed commit, as a stamp', () => {
    for (const word of ['approved', 'in-progress', 'done', 'Draft ', '']) {
      const raw = `---\nstatus: ${word}\n---\n# X\n`;
      expect(readKnowledgeStamp(raw).readiness).toBe(null);
      expect(documentStampKind(readKnowledgeStamp(raw))).toBe('unstamped');
    }
    expect(readKnowledgeStamp('---\ncommit: not-a-sha\n---\n# X\n').commit).toBe(null);
  });

  it('ignores an unterminated fence rather than reading the body as frontmatter', () => {
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
    const out = writeKnowledgeStamp(FEATURE, { branch: 'feat/orders', commit: COMMIT });
    for (const kept of ['id: feature:orders-api::orders', 'anchors: [file:src/orders.ts]', 'author: A Person']) {
      expect(out).toContain(kept);
    }
    expect(out).toContain('branch: feat/orders');
    expect(out).toContain(`commit: ${COMMIT}`);
    expect(splitKnowledgeFrontmatter(out).body).toBe(splitKnowledgeFrontmatter(FEATURE).body);
  });

  it('adds frontmatter to a document that had none', () => {
    const out = writeKnowledgeStamp('# Orders\n\nWhat it does.\n', { commit: COMMIT });
    expect(out).toBe(`---\ncommit: ${COMMIT}\n---\n# Orders\n\nWhat it does.\n`);
    expect(documentStampKind(readKnowledgeStamp(out))).toBe('stamped');
  });

  it('replaces a key in place instead of appending a second one', () => {
    const once = writeKnowledgeStamp(FEATURE, { branch: 'a' });
    const twice = writeKnowledgeStamp(once, { branch: 'b' });
    expect(twice.match(/^branch:/gm)).toHaveLength(1);
    expect(readKnowledgeStamp(twice).branch).toBe('b');
  });

  it('removes a key on null and leaves it alone on undefined', () => {
    const stamped = writeKnowledgeStamp(FEATURE, { readiness: 'draft', commit: COMMIT });
    const cleared = writeKnowledgeStamp(stamped, { readiness: null });
    expect(readKnowledgeStamp(cleared)).toEqual({ readiness: null, branch: null, commit: COMMIT });
    expect(readKnowledgeStamp(writeKnowledgeStamp(cleared, {}))).toEqual({ readiness: null, branch: null, commit: COMMIT });
  });
});

describe('documentStampKind', () => {
  it("lets a person's `status: shared` outrank a stamp", () => {
    expect(documentStampKind({ readiness: 'shared', branch: 'feat/x', commit: COMMIT })).toBe('shared');
    expect(documentStampKind({ readiness: null, branch: 'feat/x', commit: COMMIT })).toBe('stamped');
    expect(documentStampKind({ readiness: 'draft', branch: 'feat/x', commit: COMMIT })).toBe('stamped');
  });
});
