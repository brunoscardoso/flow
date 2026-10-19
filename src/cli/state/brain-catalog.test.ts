import { describe, expect, it } from '@jest/globals';

import {
  CATALOG_CODE_PATTERN,
  checkCatalog,
  isResolved,
  parseAddress,
  parseCatalog,
  resolveCode,
  sectionsOf,
  type CatalogDeps,
} from './brain-catalog.js';

const DOC = `# Complexity

Intro prose.

## Complexity Scale

| Score | Level |
|-------|-------|
| 0-2 | Trivial |

## Scoring Criteria

Modifiers go here.
`;

const CATALOG = `# Catalog

## Core rules

| Code | What it answers | Source |
|------|-----------------|--------|
| COR-CS-1 | The 0-10 complexity scale | \`.claude/resources/core/complexity-scoring.md\` › Complexity Scale |
| COR-CS-2 | The scoring modifiers | \`.claude/resources/core/complexity-scoring.md\` › Scoring Criteria |
`;

function depsWith(files: Record<string, string>): CatalogDeps {
  return { readCorpusFile: (relPath) => files[relPath] ?? null };
}

const FILES = { '.claude/resources/core/complexity-scoring.md': DOC };

describe('parseCatalog', () => {
  it('reads every row, keeping its group and its line', () => {
    const { entries, problems } = parseCatalog(CATALOG);
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      code: 'COR-CS-1',
      description: 'The 0-10 complexity scale',
      file: '.claude/resources/core/complexity-scoring.md',
      heading: 'Complexity Scale',
      group: 'Core rules',
    });
    expect(entries[0].line).toBeGreaterThan(1);
  });

  it('skips the header row and the separator rule rather than reading them as entries', () => {
    // POSITIVE FIRST (#28): the table really was parsed, so the absence of a
    // `Code`/`---` entry below is evidence of skipping, not of a dead parser.
    expect(parseCatalog(CATALOG).entries.map((entry) => entry.code)).toEqual(['COR-CS-1', 'COR-CS-2']);
    expect(parseCatalog(CATALOG).entries.some((entry) => /^-+$/.test(entry.code))).toBe(false);
  });

  it('ignores a table inside a fence, so documentation of the format is not data', () => {
    const raw = `# Catalog\n\n\`\`\`markdown\n| FAKE-1 | not real | \`x.md\` › X |\n\`\`\`\n\n${CATALOG}`;
    expect(parseCatalog(raw).entries.map((entry) => entry.code)).toEqual(['COR-CS-1', 'COR-CS-2']);
  });

  it('reports a malformed code, a malformed address and a duplicate — never drops them silently', () => {
    const raw = `# Catalog

## Group

| Code | What | Source |
|------|------|--------|
| lowercase | bad code | \`a.md\` › H |
| OK-1 | no separator | a.md H |
| OK-2 | fine | \`a.md\` › H |
| OK-2 | said twice | \`a.md\` › H2 |
`;
    const { entries, problems } = parseCatalog(raw);
    expect(entries.map((entry) => entry.code)).toEqual(['OK-2']);
    expect(problems.map((problem) => problem.reason)).toEqual(['bad-code', 'bad-address', 'duplicate-code']);
  });

  it('accepts a bare path as well as a backticked one', () => {
    expect(parseAddress('`a/b.md` › My Heading')).toEqual({ file: 'a/b.md', heading: 'My Heading' });
    expect(parseAddress('a/b.md › My Heading')).toEqual({ file: 'a/b.md', heading: 'My Heading' });
    expect(parseAddress('a/b.md no separator')).toBe(null);
  });

  it('only accepts codes shaped like reference codes', () => {
    for (const good of ['COR-CS-1', 'SKL-A-12', 'GLB-1']) expect(CATALOG_CODE_PATTERN.test(good)).toBe(true);
    for (const bad of ['cor-cs-1', 'COR', 'COR_CS_1', '1-A']) expect(CATALOG_CODE_PATTERN.test(bad)).toBe(false);
  });
});

describe('resolveCode', () => {
  const catalog = parseCatalog(CATALOG);

  it('prints the whole section, heading line included', () => {
    const result = resolveCode(catalog, 'COR-CS-1', depsWith(FILES));
    expect(isResolved(result)).toBe(true);
    if (!isResolved(result)) return;
    expect(result.text).toContain('## Complexity Scale');
    expect(result.text).toContain('| 0-2 | Trivial |');
    // …and stops at the next heading — it is one section, not the rest of the file.
    expect(result.text).not.toContain('Modifiers go here');
    expect(result.line).toBe(5);
  });

  it('STILL RESOLVES after text is inserted above it — the whole point of a heading anchor', () => {
    // This is the defect the retired line-range index could not survive: an
    // edit above a section silently re-pointed its code at neighbouring prose.
    const before = resolveCode(catalog, 'COR-CS-1', depsWith(FILES));
    const shifted = `# Complexity\n\n${'Added paragraph.\n\n'.repeat(40)}${DOC.slice(DOC.indexOf('Intro prose.'))}`;
    const after = resolveCode(catalog, 'COR-CS-1', depsWith({
      '.claude/resources/core/complexity-scoring.md': shifted,
    }));
    expect(isResolved(before) && isResolved(after)).toBe(true);
    if (!isResolved(before) || !isResolved(after)) return;
    expect(after.text).toBe(before.text);
    expect(after.line).not.toBe(before.line); // it moved, and was found anyway
  });

  it('rejoins a section the chunker split for being long, instead of calling it ambiguous', () => {
    // The chunker cuts a section over 120 lines into chunks that all keep the
    // heading. Those are one SECTION; treating them as two would make every
    // long document un-catalogable.
    const long = `# T\n\n## Complexity Scale\n\n${'filler line\n'.repeat(400)}\n## Scoring Criteria\n\nx\n`;
    expect(sectionsOf('f.md', long).filter((section) => section.heading === 'Complexity Scale')).toHaveLength(1);
    const result = resolveCode(catalog, 'COR-CS-1', depsWith({ '.claude/resources/core/complexity-scoring.md': long }));
    expect(isResolved(result)).toBe(true);
    if (!isResolved(result)) return;
    expect(result.text.split('\n').length).toBeGreaterThan(300);
  });

  it('refuses a heading the file carries twice, rather than picking one', () => {
    // POSITIVE FIRST: the unique heading resolves against this same file, so
    // the refusal below is about the duplicate and not about a broken reader.
    const twice = `# T\n\n## Scoring Criteria\n\nfirst\n\n## Complexity Scale\n\nonly one\n\n## Scoring Criteria\n\nsecond\n`;
    const deps = depsWith({ '.claude/resources/core/complexity-scoring.md': twice });
    expect(isResolved(resolveCode(catalog, 'COR-CS-1', deps))).toBe(true);
    const result = resolveCode(catalog, 'COR-CS-2', deps);
    expect(result).toMatchObject({ refusal: 'heading-ambiguous', matches: 2 });
  });

  it('names the failure when the heading was renamed, the file went, or the code is unknown', () => {
    expect(resolveCode(catalog, 'COR-CS-1', depsWith({
      '.claude/resources/core/complexity-scoring.md': '# T\n\n## Renamed\n\nbody\n',
    }))).toMatchObject({ refusal: 'heading-not-found' });
    expect(resolveCode(catalog, 'COR-CS-1', depsWith({}))).toMatchObject({ refusal: 'source-missing' });
    expect(resolveCode(catalog, 'NOPE-1', depsWith(FILES))).toMatchObject({ refusal: 'unknown-code', entry: null });
  });

  it('refuses a duplicated code instead of silently answering with the first', () => {
    const duped = parseCatalog(`# C\n\n## G\n\n| Code | W | Source |\n|---|---|---|\n| D-1 | a | \`f.md\` › A |\n| D-1 | b | \`f.md\` › B |\n`);
    expect(resolveCode(duped, 'D-1', depsWith({ 'f.md': '# T\n\n## A\n\nx\n' }))).toMatchObject({
      refusal: 'duplicate-code',
    });
  });
});

describe('checkCatalog', () => {
  it('resolves every entry and reports only the broken one', () => {
    const results = checkCatalog(parseCatalog(CATALOG), depsWith({
      '.claude/resources/core/complexity-scoring.md': '# T\n\n## Complexity Scale\n\nkept\n',
    }));
    expect(results).toHaveLength(2);
    expect(isResolved(results[0].result)).toBe(true);
    expect(results[1].result).toMatchObject({ refusal: 'heading-not-found' });
  });
});
