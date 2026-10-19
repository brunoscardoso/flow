import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyTier, isCodeFile, isTestFile, walkRepo } from './scan.js';

describe('isTestFile (#538 — extractors skip test/fixture files)', () => {
  it('matches *.test.* / *.spec.* by extension', () => {
    expect(isTestFile('src/api/route.server.test.ts')).toBe(true);
    expect(isTestFile('src/api/route.spec.ts')).toBe(true);
    expect(isTestFile('lib/util.test.tsx')).toBe(true);
    expect(isTestFile('lib/util.test.mjs')).toBe(true);
  });

  it('matches test/fixture/mock directories anywhere in the path', () => {
    expect(isTestFile('src/__tests__/api.ts')).toBe(true);
    expect(isTestFile('src/__mocks__/stripe.ts')).toBe(true);
    expect(isTestFile('e2e/checkout.ts')).toBe(true);
    expect(isTestFile('app/fixtures/seed.ts')).toBe(true);
    expect(isTestFile('test/helpers.ts')).toBe(true);
    expect(isTestFile('packages/x/spec/thing.ts')).toBe(true);
  });

  it('does NOT match production source (the whole point)', () => {
    expect(isTestFile('src/api/route.ts')).toBe(false);
    expect(isTestFile('src/integrations/stripe.ts')).toBe(false);
    expect(isTestFile('lib/latest.ts')).toBe(false); // "latest" ≠ "test/" dir
    expect(isTestFile('src/contest/page.ts')).toBe(false); // "contest" ≠ "test"
  });
});

describe('isCodeFile (#536 — language-agnostic spine)', () => {
  it('matches TS/JS AND other languages (py, go, rb, java, cs, php, rs, sql, …)', () => {
    for (const p of ['a.ts', 'a.js', 'a.py', 'svc.go', 'm.rb', 'M.java', 'M.kt', 'S.cs', 'i.php', 'l.rs', 'q.sql', 'v.swift']) {
      expect(isCodeFile(p)).toBe(true);
    }
  });
  it('does NOT match non-code files', () => {
    for (const p of ['README.md', 'data.json', 'logo.png', 'notes.txt', 'style.css']) {
      expect(isCodeFile(p)).toBe(false);
    }
  });
});

describe('classifyTier (trust tiers)', () => {
  it("classifies flow/** and .claude/** as 'own', including the bare dirs themselves", () => {
    for (const p of ['flow', 'flow/plans/plan_x_v1.md', '.claude', '.claude/rules/core/allowed-patterns.md']) {
      expect(classifyTier(p)).toBe('own');
    }
  });

  it("'own' is location-based — a similarly-named sibling dir is NOT own", () => {
    expect(classifyTier('flowchart/render.ts')).toBe('code');
    expect(classifyTier('workflows/deploy.md')).toBe('claim');
  });

  it("classifies source code AND config/build extensions as 'code'", () => {
    for (const p of ['src/a.ts', 'lib/b.py', 'package.json', 'ci.yaml', 'compose.yml', 'Cargo.toml', 'yarn.lock']) {
      expect(classifyTier(p)).toBe('code');
    }
  });

  it("classifies foreign docs and images as 'claim'", () => {
    for (const p of ['README.md', 'docs/guide.mdx', 'notes.rst', 'todo.txt', 'logo.png', 'shot.jpg', 'shot.jpeg', 'icon.svg', 'anim.gif', 'hero.webp']) {
      expect(classifyTier(p)).toBe('claim');
    }
  });

  it("'own' wins over extension (precedence: location beats doc/code shape)", () => {
    expect(classifyTier('flow/brain/features/x.md')).toBe('own');
    expect(classifyTier('.claude/settings.json')).toBe('own');
  });

  it("classifies everything else as 'other'", () => {
    for (const p of ['data.bin', 'style.css', 'font.woff2', 'LICENSE', 'Makefile']) {
      expect(classifyTier(p)).toBe('other');
    }
  });

  it('is case-insensitive on extensions', () => {
    expect(classifyTier('README.MD')).toBe('claim');
    expect(classifyTier('Logo.PNG')).toBe('claim');
    expect(classifyTier('Main.TS')).toBe('code');
    expect(classifyTier('Config.JSON')).toBe('code');
  });
});

describe('walkRepo skips gitignored directories (#1588)', () => {
  // A REAL repo with a REAL .gitignore: the bug was that the walker consulted a
  // hardcoded list of seven names and never the file that actually says what
  // this repo generates, so a mock of git would test the wrong thing.
  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'scan-gitignore-'));
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    };
    git('init');
    writeFileSync(join(root, '.gitignore'), '/test-results/\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'real.ts'), 'export const a = 1\n');
    mkdirSync(join(root, 'test-results', 'some-failed-run'), { recursive: true });
    writeFileSync(join(root, 'test-results', 'some-failed-run', 'trace.ts'), 'export const b = 2\n');
    return root;
  }

  it('does not descend a directory the repo gitignores', () => {
    const root = makeRepo();
    try {
      const scan = walkRepo(root);
      expect(scan.files).toContain('src/real.ts');
      expect(scan.files.filter((f) => f.startsWith('test-results'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still walks everything when the tree is not a git repo — fail-soft', () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-nogit-'));
    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src', 'real.ts'), 'export const a = 1\n');
      const scan = walkRepo(root);
      expect(scan.files).toContain('src/real.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the hardcoded artifact names still apply, gitignore or not', () => {
    const root = mkdtempSync(join(tmpdir(), 'scan-hardcoded-'));
    try {
      mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'pkg', 'index.ts'), 'export const c = 3\n');
      const scan = walkRepo(root);
      expect(scan.files.filter((f) => f.startsWith('node_modules'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
