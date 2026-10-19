/**
 * Query-scope boundary lock (trust-tiers FR8).
 *
 * The brain's query-scope allowlist (`SCOPE_TO_DIRS` in `brain-query.ts`) is
 * the CLI-side authority on which directories project-brain content may be
 * scoped from. FR8 pins that this boundary stays inside `flow/` + `.claude/`:
 * foreign docs (e.g. `docs/`, repo-wide markdown) must never gain a scope and
 * so can never enter Tier-1 retrieval via `state-query`.
 *
 * Two locks:
 *  1. Data lock — the `SCOPE_TO_DIRS` literal is parsed out of the module
 *     source and asserted EXACTLY. Adding `docs/` (or any prefix outside
 *     `flow/` + `.claude/`) fails this test.
 *  2. Behavior lock — `queryProjectBrain` with each named scope filters out
 *     results whose file lies outside `flow/` + `.claude/`, even when those
 *     files sit right there in the project and match the query harder than the
 *     in-boundary one does.
 *
 * The behavior lock used to mock an index package and hand it foreign rows.
 * Now that the store IS the markdown, the foreign files are written to disk for
 * real — a stronger lock, because a corpus walk that wandered outside the
 * boundary would fail it where a mocked engine could not.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { queryProjectBrain } from './brain-query.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// 1. Data lock — the allowlist literal itself
// ---------------------------------------------------------------------------

/** The ONLY directory prefixes the brain may scope content from (FR8). */
const EXPECTED_SCOPE_TO_DIRS: Record<string, string[]> = {
  resources: ['.claude/resources/'],
  rules: ['.claude/rules/'],
  brain: ['flow/brain/'],
  plans: ['flow/plans/'],
  discovery: ['flow/discovery/'],
  all: [],
};

/** Roots the trust-tier boundary allows — everything else is foreign. */
const ALLOWED_ROOT_PREFIXES = ['flow/', '.claude/'];

/**
 * Parse the `SCOPE_TO_DIRS` object literal out of the brain-query source.
 * The const is intentionally module-private, so the lock reads the source
 * text — if the block is renamed or removed this fails loudly rather than
 * passing vacuously.
 */
function parseScopeToDirsFromSource(): Record<string, string[]> {
  const source = readFileSync(join(__dirname, 'brain-query.ts'), 'utf-8');
  const blockMatch = source.match(
    /const SCOPE_TO_DIRS[^=]*=\s*\{([\s\S]*?)\n\};/,
  );
  if (blockMatch === null) {
    throw new Error(
      'SCOPE_TO_DIRS literal not found in brain-query.ts — if the allowlist moved, move this lock with it (trust-tiers FR8)',
    );
  }
  const body = blockMatch[1];
  const parsed: Record<string, string[]> = {};
  const entryPattern = /(\w+):\s*\[([^\]]*)\]/g;
  let entry: RegExpExecArray | null;
  while ((entry = entryPattern.exec(body)) !== null) {
    const dirs = [...entry[2].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    parsed[entry[1]] = dirs;
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error('SCOPE_TO_DIRS parsed to zero entries — parser drifted from the source shape');
  }
  return parsed;
}

describe('brain query boundary — SCOPE_TO_DIRS allowlist (FR8)', () => {
  it('the allowlist contains EXACTLY the known flow/ + .claude/ scopes', () => {
    expect(parseScopeToDirsFromSource()).toEqual(EXPECTED_SCOPE_TO_DIRS);
  });

  it('every scoped directory prefix lies within flow/ or .claude/', () => {
    const scopeMap = parseScopeToDirsFromSource();
    for (const [scope, dirs] of Object.entries(scopeMap)) {
      for (const dir of dirs) {
        const inBoundary = ALLOWED_ROOT_PREFIXES.some((root) => dir.startsWith(root));
        expect({ scope, dir, inBoundary }).toEqual({ scope, dir, inBoundary: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Behavior lock — foreign paths never survive a scoped query
// ---------------------------------------------------------------------------

/** Foreign markdown, written for real and stuffed with the query terms. */
const FOREIGN_FILES = [
  'docs/architecture.md',
  'README.md',
  'src/notes/design.md',
  'templates/shared/CLAUDE.md.template',
];

/** One legitimate in-boundary file per named scope. */
const IN_SCOPE_FILE: Record<string, string> = {
  resources: '.claude/resources/core/blueprint.md',
  rules: '.claude/rules/core/allowed-patterns.md',
  brain: 'flow/brain/features/auth.md',
  plans: 'flow/plans/plan_x_v1.md',
  discovery: 'flow/discovery/discovery_x_v1.md',
};

const QUERY = 'quarkfold provenance';

describe('brain query boundary — scoped queries reject foreign paths (FR8)', () => {
  let projectRoot: string;

  function seed(relPath: string, body: string): void {
    const full = join(projectRoot, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, 'utf-8');
  }

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'brain-boundary-test-'));
    // The foreign files match HARDER than any in-scope file — if the boundary
    // leaked, they would not merely appear, they would win.
    for (const file of FOREIGN_FILES) {
      seed(file, `# Foreign\n\n## Quarkfold provenance\n\n${'quarkfold provenance '.repeat(20)}\n`);
    }
    for (const file of Object.values(IN_SCOPE_FILE)) {
      seed(file, '# In scope\n\n## Quarkfold\n\nquarkfold provenance, mentioned once.\n');
    }
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it.each(Object.keys(IN_SCOPE_FILE))(
    'scope "%s" filters out docs/, repo-root, src/ and templates/ markdown',
    (scope) => {
      const results = queryProjectBrain(projectRoot, QUERY, { scope: scope as never, limit: 50 });

      expect(results.map((r) => r.file)).toEqual([IN_SCOPE_FILE[scope]]);
    },
  );

  it('even the unscoped "all" query never walks outside flow/ + .claude/', () => {
    const results = queryProjectBrain(projectRoot, QUERY, { scope: 'all', limit: 50 });

    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every((r) =>
        ALLOWED_ROOT_PREFIXES.some((root) => r.file.startsWith(root)) || r.file === 'CLAUDE.md',
      ),
    ).toBe(true);
  });
});
