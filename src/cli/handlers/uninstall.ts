/**
 * REMOVE WHAT PROVISIONING ADDED TO A PROJECT — the reverse of `init`.
 *
 * The Flow app's "Reset Flow" calls this, through `planflow-ai uninstall`, for
 * each project it manages. It removes ONLY what plan-flow put there, and
 * decides that by comparison with what the package ships, never by folder:
 *
 *   - `.claude/commands` and `.claude/resources`: each file the package ships
 *     at the same relative path. A command a person wrote beside them stays.
 *   - `.claude/rules`: a shipped file only when its content is still the
 *     shipped content. Pattern capture writes into these files, and a rule a
 *     person added or edited is theirs.
 *   - `.claude/hooks`: the hook scripts in HOOK_SCRIPTS, and their entries in
 *     `.claude/settings.json`. Every other hook and setting stays.
 *   - The marked plan-flow sections of `CLAUDE.md`, `.gitignore` and
 *     `.gitattributes`. Text outside the markers stays; a file left empty by
 *     the removal is deleted.
 *   - `flow` when it is a LINK. A real `flow` folder is a project's own
 *     knowledge and is never touched.
 *
 * IT REFUSES the plan-flow source repository itself: there those files ARE
 * the source, and "removing what plan-flow added" would delete the product.
 *
 * Needs `confirmed: true` (forbidden-pattern #15): a call that forgets it
 * removes nothing.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { HOOK_SCRIPTS } from '../hooks/hook-scripts.js';
import { isPlanFlowSourceRepo } from './claude.js';

const CLAUDE_MD_START = '<!-- plan-flow-start -->';
const CLAUDE_MD_END = '<!-- plan-flow-end -->';
const BLOCK_START = '# >>> plan-flow';
const BLOCK_END = '# <<< plan-flow';

export interface UninstallResult {
  target: string;
  /** Paths removed, relative to the target. */
  removed: string[];
  /** Files edited to drop plan-flow's part, relative to the target. */
  edited: string[];
  /** Files left because a person changed them, relative to the target. */
  kept: string[];
}

export class UninstallRefusal extends Error {
  constructor(
    readonly reason: 'not-confirmed' | 'missing' | 'source-repo',
    message: string,
  ) {
    super(message);
  }
}

/** Every file under `dir`, as paths relative to it. Links are not followed. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out;
}

/** Remove now-empty folders from `leaf` up to (not including) `stop`. */
function pruneEmpty(leaf: string, stop: string): void {
  let dir = leaf;
  while (resolve(dir) !== resolve(stop) && resolve(dir).startsWith(resolve(stop))) {
    if (!existsSync(dir) || readdirSync(dir).length > 0) return;
    rmdirSync(dir);
    dir = resolve(dir, '..');
  }
}

/** A regular file (not a link, not a folder) at `path`. */
function isPlainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Drop the marked section; null when the file has none. */
function withoutSection(text: string, start: string, end: string): string | null {
  if (!text.includes(start)) return null;
  const pattern = new RegExp(`\\n*${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`);
  return text.replace(pattern, '\n').replace(/^\n+/, '');
}

export function uninstallProject(input: {
  target: string;
  packageRoot: string;
  confirmed: true;
}): UninstallResult {
  if ((input.confirmed as unknown) !== true) {
    throw new UninstallRefusal('not-confirmed', 'removing Flow files needs an explicit confirmation');
  }
  const target = resolve(input.target);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new UninstallRefusal('missing', `there is no folder at ${target}`);
  }
  if (isPlanFlowSourceRepo(target) || resolve(input.packageRoot) === target) {
    throw new UninstallRefusal('source-repo', 'this is plan-flow\'s own source; its files are the product, not a copy');
  }

  const result: UninstallResult = { target, removed: [], edited: [], kept: [] };
  const rel = (path: string): string => relative(target, path);
  const claudeDir = join(target, '.claude');

  // Owned copies: removed whatever their content, as a refresh overwrites them.
  for (const folder of ['commands', 'resources']) {
    const shipped = join(input.packageRoot, '.claude', folder);
    const dest = join(claudeDir, folder);
    for (const file of listFiles(shipped)) {
      const path = join(dest, file);
      if (!isPlainFile(path)) continue;
      unlinkSync(path);
      result.removed.push(rel(path));
      pruneEmpty(join(path, '..'), claudeDir);
    }
  }

  // Rules: only an untouched copy.
  const rulesShipped = join(input.packageRoot, '.claude', 'rules');
  for (const file of listFiles(rulesShipped)) {
    const path = join(claudeDir, 'rules', file);
    if (!isPlainFile(path)) continue;
    if (readFileSync(path, 'utf-8') === readFileSync(join(rulesShipped, file), 'utf-8')) {
      unlinkSync(path);
      result.removed.push(rel(path));
      pruneEmpty(join(path, '..'), claudeDir);
    } else {
      result.kept.push(rel(path));
    }
  }

  // Hooks: the scripts, then their registrations.
  for (const script of HOOK_SCRIPTS) {
    const path = join(claudeDir, 'hooks', script);
    if (!isPlainFile(path)) continue;
    unlinkSync(path);
    result.removed.push(rel(path));
    pruneEmpty(join(path, '..'), claudeDir);
  }
  const settingsPath = join(claudeDir, 'settings.json');
  if (isPlainFile(settingsPath)) {
    const edited = withoutHookEntries(readFileSync(settingsPath, 'utf-8'));
    if (edited === 'empty') {
      unlinkSync(settingsPath);
      result.removed.push(rel(settingsPath));
    } else if (edited !== null) {
      writeFileSync(settingsPath, edited, 'utf-8');
      result.edited.push(rel(settingsPath));
    }
  }
  pruneEmpty(claudeDir, target);

  // Marked sections.
  const sections: Array<[string, string, string]> = [
    ['CLAUDE.md', CLAUDE_MD_START, CLAUDE_MD_END],
    ['.gitignore', BLOCK_START, BLOCK_END],
    ['.gitattributes', BLOCK_START, BLOCK_END],
  ];
  for (const [name, start, end] of sections) {
    const path = join(target, name);
    if (!isPlainFile(path)) continue;
    const next = withoutSection(readFileSync(path, 'utf-8'), start, end);
    if (next === null) continue;
    if (next.trim() === '') {
      unlinkSync(path);
      result.removed.push(name);
    } else {
      writeFileSync(path, next.trimEnd() + '\n', 'utf-8');
      result.edited.push(name);
    }
  }

  // The knowledge link — a link only, never a folder.
  const flowLink = join(target, 'flow');
  try {
    if (lstatSync(flowLink).isSymbolicLink()) {
      unlinkSync(flowLink);
      result.removed.push('flow');
    }
  } catch {
    // Absent: nothing to remove.
  }

  return result;
}

/**
 * `.claude/settings.json` without plan-flow's hook entries. Null when it has
 * none (or is unreadable — never rewrite what cannot be parsed); 'empty' when
 * nothing at all is left.
 */
export function withoutHookEntries(text: string): string | null | 'empty' {
  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    settings = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const hooks = settings['hooks'];
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return null;
  const ours = (command: unknown): boolean =>
    typeof command === 'string' && HOOK_SCRIPTS.some((script) => command.includes(`.claude/hooks/${script}`));

  let changed = false;
  const nextHooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups;
      continue;
    }
    const keptGroups: unknown[] = [];
    for (const group of groups) {
      const inner = (group as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(inner)) {
        keptGroups.push(group);
        continue;
      }
      const keptInner = inner.filter((hook) => !ours((hook as { command?: unknown } | null)?.command));
      if (keptInner.length !== inner.length) changed = true;
      if (keptInner.length > 0) keptGroups.push({ ...(group as object), hooks: keptInner });
    }
    if (keptGroups.length > 0) nextHooks[event] = keptGroups;
  }
  if (!changed) return null;
  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(nextHooks).length > 0) next['hooks'] = nextHooks;
  else delete next['hooks'];
  if (Object.keys(next).length === 0) return 'empty';
  return `${JSON.stringify(next, null, 2)}\n`;
}
