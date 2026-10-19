/**
 * EVERY `.claude/resources/**` FILE A SHIPPED ASSET POINTS AT MUST EXIST (#1959).
 *
 * `.claude/resources/core/discovery-sub-agents.md` was referenced by six
 * shipped files at nine sites — including `CLAUDE.md`, which is always loaded,
 * and `templates/shared/CLAUDE.md.template`, which ships the same dead pointer
 * into every provisioned project — and it had never existed on any branch.
 * `git log --all` for the name returns nothing; `git rev-list --all --objects`
 * finds zero blobs. The anchor codes it was cited by (`COR-DSA-1/2/3`) were
 * minted by the references themselves, which is why they agreed with each
 * other: they were written together, never against a document.
 *
 * Two of those references were load-bearing rather than decorative.
 * `discovery-skill.md` told the coordinator to use "the Codebase Analysis
 * section format from" a file that resolved to nothing, so the shape of a
 * section in every discovery document was whatever the session improvised; and
 * the three sub-agents' return schema was documented as living somewhere it
 * did not.
 *
 * A dead pointer costs nothing at write time and everything at read time: the
 * agent follows it, finds no file, and proceeds on a contract it has just
 * invented. Nothing in the suite looked, because a reference is prose.
 *
 * Scope note: this checks the resource corpus only — paths under
 * `.claude/resources/`. Source-file mentions (`app/src/...`) move with ordinary
 * refactors and are a different, noisier problem; a test that mixed the two
 * would be disabled within a month.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every markdown file that ships, or that is always loaded. */
function shippedMarkdown(): string[] {
  const roots = ['.claude/commands', '.claude/resources', '.claude/rules', 'templates'];
  const found: string[] = ['CLAUDE.md', 'README.md'];
  const walk = (rel: string): void => {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs)) {
      const childRel = join(rel, entry);
      if (statSync(join(repoRoot, childRel)).isDirectory()) walk(childRel);
      else if (entry.endsWith('.md') || entry.endsWith('.template')) found.push(childRel);
    }
  };
  for (const root of roots) walk(root);
  return found.filter((rel) => existsSync(join(repoRoot, rel)));
}

/**
 * Full `.claude/resources/...` paths cited in a file's prose.
 *
 * Full paths only, deliberately. The first cut also matched bare filenames
 * (`discovery-sub-agents.md` in a table cell) and produced 99 hits, nearly all
 * of them `flow/` data files and unrelated table text — `tasklist.md`,
 * `log.md`, `memory.md`, `contract.md`. A guard that noisy is switched off
 * within a month, and switched-off guards read as coverage. Every file the
 * real defect touched cites it by full path somewhere, so precision costs
 * nothing here.
 *
 * Paths under `.claude/resources/project/` and `.claude/resources/frameworks/`
 * are skipped: those directories do not ship, they are GENERATED into a
 * consuming project by `/setup`, so their absence from this repo is correct.
 */
const GENERATED_SUBDIRS = ['.claude/resources/project/', '.claude/resources/frameworks/'];

function citedResources(source: string): string[] {
  const full = [...source.matchAll(/\.claude\/resources\/[A-Za-z0-9_\-./]+\.md/g)].map((m) => m[0]);
  return [...new Set(full)].filter((p) => !GENERATED_SUBDIRS.some((d) => p.startsWith(d)));
}

describe('resource references resolve', () => {
  const files = shippedMarkdown();

  it('finds a corpus to check at all', () => {
    // Guards the guard: a walk that silently found nothing would make every
    // assertion below pass vacuously (forbidden-pattern #19).
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain('CLAUDE.md');
  });

  it('points at no `.claude/resources` file that does not exist', () => {
    const dead: string[] = [];
    for (const rel of files) {
      const source = readFileSync(join(repoRoot, rel), 'utf-8');
      for (const cited of citedResources(source)) {
        if (!existsSync(join(repoRoot, cited))) {
          dead.push(`${rel} → ${cited}`);
        }
      }
    }
    // Named, not counted: the fix is to write the file or drop the pointer.
    expect(dead).toEqual([]);
  });

  it('declares every `COR-` anchor code that any shipped file cites', () => {
    // The other half of the same failure: a file can exist and still not hold
    // the section a reference promises is in it. `COR-DSA-2` was cited as "the
    // Codebase Analysis section format" by a step that instructed the agent to
    // follow it.
    const declared = new Set<string>();
    const cited = new Map<string, string[]>();
    for (const rel of files) {
      const source = readFileSync(join(repoRoot, rel), 'utf-8');
      for (const m of source.matchAll(/^##+\s+(COR-[A-Z]+-\d+):/gm)) declared.add(m[1]);
      for (const m of source.matchAll(/\b(COR-[A-Z]+-\d+)\b/g)) {
        cited.set(m[1], [...(cited.get(m[1]) ?? []), rel]);
      }
    }
    const undeclared = [...cited.entries()]
      .filter(([code]) => !declared.has(code))
      .map(([code, where]) => `${code} (cited in ${[...new Set(where)].join(', ')})`);
    expect(undeclared).toEqual([]);
  });
});
