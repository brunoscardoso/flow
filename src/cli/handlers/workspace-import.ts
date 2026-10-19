/**
 * BRINGING A PROJECT'S EXISTING KNOWLEDGE INTO ITS WORKSPACE — the copy step of
 * `workspace link --import` and `workspace migrate` (decision 2026-10-06,
 * workspaces-hard-migration: "existing knowledge is moved in").
 *
 * A COPY, never a move: the source (a vault folder, a plain `flow/`, a
 * committed one, a project's own knowledge repo) is read and left exactly as
 * it is; `linkRepo` keeps it as the backup.
 *
 * What is copied — everything under the source, with these exceptions:
 *   - `.git` at any depth (a knowledge repo's history stays in its backup);
 *   - files the sync-class table marks `generated` (they rebuild on this
 *     machine — `knowledge-classes.ts` is the one table, allowed-pattern #14);
 *   - `.gitkeep` (the Workspace project folder is scaffolded with its own) and
 *     `.DS_Store`;
 *   - a symlink whose real target is outside the source tree — never followed,
 *     listed in `skipped`. "The source tree" is the real `flow/` plus the
 *     project's vault folder (`<vault>/projects/<p>/`): the vault has shipped
 *     `flow/` shapes whose subdirectories are links into it.
 * Personal-class files ARE copied: they stay on this machine, and the
 * Workspace `.gitignore` (plus the pre-push guard) keeps them off the remote.
 *
 * NEVER OVERWRITES. A destination file with the same bytes is already there
 * (not copied, not reported). Any other clash keeps both: a versioned document
 * (`<stem>_v<N><suffix>`) takes the next free version — every incoming member
 * of its family (`discovery_x_v1.md` + `discovery_x_v1.walkthrough.html`)
 * moves together so the pair stays a pair — and anything else becomes
 * `<name>.imported<ext>` (`-2`, `-3`… if that is taken too). Each rename is
 * listed. References inside the renamed document are not rewritten.
 *
 * Planning is read-only (the dry run reports it); applying copies with
 * COPYFILE_EXCL, so even a race cannot overwrite.
 */

import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { classifyKnowledgePath } from './knowledge-classes.js';

export interface ImportReport {
  /** Files copied into the Workspace project folder. */
  files: number;
  /** Source paths (relative to the source) that were NOT copied: links out of the source tree, unreadable entries. */
  skipped: string[];
  /** Incoming files that clashed with a different file already there, and the name they were copied under. */
  renamed: { from: string; to: string }[];
}

export const EMPTY_IMPORT: ImportReport = Object.freeze({ files: 0, skipped: [], renamed: [] }) as ImportReport;

interface PlannedCopy {
  /** The real file to read. */
  from: string;
  /** Its path relative to the source. */
  rel: string;
  /** Where it lands, relative to the destination. */
  to: string;
}

export interface ImportPlan {
  destination: string;
  copies: PlannedCopy[];
  skipped: string[];
  renamed: { from: string; to: string }[];
}

/** Never copied, never reported. */
const IGNORED_NAMES = new Set(['.git', '.gitkeep', '.DS_Store']);

/** `<stem>_v<N><suffix>` — the suffix is everything from the first dot after the version. */
const VERSIONED = /^(.+)_v(\d+)(\..+)$/;

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function within(child: string, parent: string): boolean {
  if (child === parent) return true;
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function posixJoin(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function posixDir(rel: string): string {
  const at = rel.lastIndexOf('/');
  return at === -1 ? '' : rel.slice(0, at);
}

function posixBase(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** Collect every file to copy, reading only. */
function collect(source: string, extraRoots: readonly string[]): { files: { from: string; rel: string }[]; skipped: string[] } {
  const files: { from: string; rel: string }[] = [];
  const skipped: string[] = [];
  const root = realOrNull(source);
  if (root === null) return { files, skipped };
  const allowed = [root, ...extraRoots.map((extra) => realOrNull(extra)).filter((extra): extra is string => extra !== null)];

  const walk = (dir: string, rel: string, ancestry: ReadonlySet<string>): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      skipped.push(rel === '' ? '.' : rel);
      return;
    }
    for (const name of names) {
      if (IGNORED_NAMES.has(name)) continue;
      const full = join(dir, name);
      const childRel = posixJoin(rel, name);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        skipped.push(childRel);
        continue;
      }
      let real = full;
      if (stat.isSymbolicLink()) {
        const target = realOrNull(full);
        if (target === null || !allowed.some((base) => within(target, base))) {
          skipped.push(childRel);
          continue;
        }
        real = target;
        try {
          stat = statSync(target);
        } catch {
          skipped.push(childRel);
          continue;
        }
      }
      if (stat.isDirectory()) {
        const key = realOrNull(real) ?? real;
        if (ancestry.has(key)) {
          skipped.push(childRel);
          continue;
        }
        walk(real, childRel, new Set([...ancestry, key]));
      } else if (stat.isFile()) {
        if (classifyKnowledgePath(childRel) === 'generated') continue;
        files.push({ from: real, rel: childRel });
      } else {
        skipped.push(childRel);
      }
    }
  };
  walk(root, '', new Set([root]));
  return { files, skipped };
}

function sameBytes(left: string, right: string): boolean {
  try {
    return readFileSync(left).equals(readFileSync(right));
  } catch {
    return false;
  }
}

/** What occupies `rel` in the destination: nothing, a file, or something else (a folder, a link). */
function occupant(destination: string, rel: string): 'none' | 'file' | 'other' {
  try {
    const stat = lstatSync(join(destination, ...rel.split('/')));
    return stat.isFile() ? 'file' : 'other';
  } catch {
    return 'none';
  }
}

/** Names already in a destination directory (rel, posix). */
function destinationNames(destination: string, dirRel: string): string[] {
  try {
    return readdirSync(join(destination, ...dirRel.split('/').filter((part) => part !== '')));
  } catch {
    return [];
  }
}

/**
 * The plan for copying `source` into `destination` — read-only. `extraRoots`
 * are folders a symlink may point into besides the source itself.
 */
export function planKnowledgeImport(source: string | null, destination: string, extraRoots: readonly string[] = []): ImportPlan {
  const plan: ImportPlan = { destination: resolve(destination), copies: [], skipped: [], renamed: [] };
  if (source === null || !existsSync(source)) return plan;
  const { files, skipped } = collect(source, extraRoots);
  plan.skipped = skipped;

  // Pass 1: what clashes. Same bytes = already there; a different file (or a
  // folder/link in its place) = a clash that keeps both.
  const clashing = new Set<string>();
  const incoming = new Set(files.map((file) => file.rel));
  const keep: { from: string; rel: string }[] = [];
  for (const file of files) {
    const there = occupant(plan.destination, file.rel);
    if (there === 'file' && sameBytes(file.from, join(plan.destination, ...file.rel.split('/')))) continue;
    if (there !== 'none') clashing.add(file.rel);
    keep.push(file);
  }

  // Pass 2: names. Taken = what the destination holds + every incoming name + every name assigned.
  const assigned = new Set<string>();
  const taken = (rel: string): boolean => assigned.has(rel) || incoming.has(rel) || occupant(plan.destination, rel) !== 'none';
  const renames = new Map<string, string>();

  // Versioned families move together.
  const families = new Map<string, { dir: string; stem: string; version: number; members: { rel: string; suffix: string }[] }>();
  for (const file of keep) {
    const match = VERSIONED.exec(posixBase(file.rel));
    if (match === null) continue;
    const dir = posixDir(file.rel);
    const key = `${dir}\0${match[1]}\0${match[2]}`;
    const family = families.get(key) ?? { dir, stem: match[1], version: Number(match[2]), members: [] };
    family.members.push({ rel: file.rel, suffix: match[3] });
    families.set(key, family);
  }
  for (const family of families.values()) {
    if (!family.members.some((member) => clashing.has(member.rel))) continue;
    const pattern = new RegExp(`^${family.stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_v(\\d+)\\.`);
    const versions = [
      ...destinationNames(plan.destination, family.dir),
      ...[...incoming, ...assigned].filter((rel) => posixDir(rel) === family.dir).map(posixBase),
    ]
      .map((name) => pattern.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));
    let next = Math.max(family.version, ...versions) + 1;
    while (family.members.some((member) => taken(posixJoin(family.dir, `${family.stem}_v${next}${member.suffix}`)))) next += 1;
    for (const member of family.members) {
      const to = posixJoin(family.dir, `${family.stem}_v${next}${member.suffix}`);
      renames.set(member.rel, to);
      assigned.add(to);
    }
  }

  // Everything else that clashes: `<name>.imported<ext>`.
  for (const file of keep) {
    if (!clashing.has(file.rel) || renames.has(file.rel)) continue;
    const dir = posixDir(file.rel);
    const name = posixBase(file.rel);
    const ext = extname(name);
    const base = ext === '' ? name : name.slice(0, -ext.length);
    let candidate = posixJoin(dir, `${base}.imported${ext}`);
    for (let n = 2; taken(candidate); n += 1) candidate = posixJoin(dir, `${base}.imported-${n}${ext}`);
    renames.set(file.rel, candidate);
    assigned.add(candidate);
  }

  for (const file of keep) {
    const to = renames.get(file.rel) ?? file.rel;
    plan.copies.push({ from: file.from, rel: file.rel, to });
    if (to !== file.rel) plan.renamed.push({ from: file.rel, to });
  }
  return plan;
}

/**
 * Copy what the plan says. A file that cannot be copied (a folder in the way
 * of its parent, a vanished source) is listed in `skipped`, never fatal; the
 * copy never overwrites (COPYFILE_EXCL).
 */
export function applyKnowledgeImport(plan: ImportPlan): ImportReport {
  const report: ImportReport = { files: 0, skipped: [...plan.skipped], renamed: [] };
  for (const copy of plan.copies) {
    const target = join(plan.destination, ...copy.to.split('/'));
    try {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(copy.from, target, constants.COPYFILE_EXCL);
      report.files += 1;
      if (copy.to !== copy.rel) report.renamed.push({ from: copy.rel, to: copy.to });
    } catch {
      report.skipped.push(copy.rel);
    }
  }
  return report;
}
