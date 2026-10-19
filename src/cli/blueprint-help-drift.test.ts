/**
 * The `blueprint` command's --help description enumerates its actions in a
 * hand-kept string, while the actions themselves live in `runBlueprint`'s
 * dispatch switch — two places one `case` can silently outdate (#1582:
 * `features heal` shipped and the description still denied `features`,
 * `coverage` and `brief` existed).
 *
 * This test reads both SOURCES and fails on any divergence, in either
 * direction, naming the drifted action. The description stays a literal on
 * purpose: index.ts lazy-imports the blueprint module inside the action
 * handler, and importing it eagerly just to build a help string would load
 * ~4k lines on every CLI startup.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function descriptionActions(): string[] {
  const source = readFileSync(join(here, 'index.ts'), 'utf-8');
  const match = source.match(/Derive and query the blueprint system map \(([^)]+)\)/);
  if (!match) throw new Error('blueprint description parenthetical not found in src/cli/index.ts');
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/\s+<[^>]+>$/, ''))
    .filter((entry) => entry.length > 0);
}

function dispatchActions(): string[] {
  const source = readFileSync(join(here, 'commands', 'blueprint.ts'), 'utf-8');
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.includes('switch (action)'));
  if (start === -1) throw new Error('switch (action) not found in src/cli/commands/blueprint.ts');
  const actions: string[] = [];
  for (const line of lines.slice(start + 1)) {
    // Top-level cases sit at exactly one indent inside the switch; nested
    // switches (sub-verbs) are deeper and must not be required in the help.
    const caseMatch = line.match(/^    case '([^']+)'/);
    if (caseMatch) actions.push(caseMatch[1]);
    if (/^  }/.test(line)) break;
  }
  if (actions.length === 0) throw new Error('no top-level case labels extracted');
  return actions;
}

describe('blueprint --help action list stays in lockstep with the dispatch (#1582)', () => {
  it('every dispatched action is named in the description', () => {
    const described = new Set(descriptionActions());
    const undocumented = dispatchActions().filter((action) => !described.has(action));
    expect(undocumented).toEqual([]);
  });

  it('the description names no action the dispatch does not answer to', () => {
    const dispatched = new Set(dispatchActions());
    const phantom = descriptionActions().filter((action) => !dispatched.has(action));
    expect(phantom).toEqual([]);
  });
});
