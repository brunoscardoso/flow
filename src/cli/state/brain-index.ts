/**
 * `flow/brain/index.md` — GENERATED, never edited in place
 * (workspaces-knowledge-hub FR-15).
 *
 * The index is the session-start L1 cache. It used to be edited in place —
 * new feature lines inserted before `## Recent Errors`, a timestamp rewritten —
 * which is a guaranteed conflict the moment two machines share the knowledge:
 * both insert at the same fixed point. Now it is a pure function of the notes
 * (`brain/features`, `brain/errors`, `brain/decisions`, their frontmatter, and
 * which plans/discoveries are live or archived), rebuilt locally on each
 * machine and git-ignored in a Workspace (knowledge-classes.ts).
 *
 * The visible format is the one session start already reads: `# Brain Index`,
 * `**Last Updated**`, `## Active Features` (`- name [status] - summary`,
 * archived ones struck through), `## Recent Errors (max 5)`,
 * `## Recent Decisions (max 3)`. A section some other local tool keeps in the
 * index (e.g. `## Global Patterns`) is carried over verbatim.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { atomicWriteFile } from '../utils/atomic-write.js';
import { featureExclusion, featureSummary } from '../blueprint/feature-store.js';

export const BRAIN_INDEX_RELPATH = join('brain', 'index.md');

const MAX_ERRORS = 5;
const MAX_DECISIONS = 3;
const MAX_ARCHIVED = 10;
const MAX_CAPABILITIES = 20;
const MAX_SUMMARY_LENGTH = 140;

/** Sections this generator owns; any other `## ` section is preserved. */
const OWNED_SECTIONS = [/^## Active Features\b/, /^## Recent Errors\b/, /^## Recent Decisions\b/, /^## Capabilities\b/];

interface Note {
  slug: string;
  raw: string;
  fm: Map<string, string>;
  body: string;
  /** ISO-ish date used for recency: frontmatter updated/created/date, else mtime. */
  date: string;
}

function parseNote(path: string): Note {
  const raw = readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
  const fm = new Map<string, string>();
  let body = raw;
  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---\n', 3);
    if (end !== -1) {
      for (const line of raw.slice(4, end).split('\n')) {
        const colon = line.indexOf(':');
        if (colon <= 0 || /^\s/.test(line)) continue;
        fm.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim().replace(/^["']|["']$/g, ''));
      }
      body = raw.slice(end + 5);
    }
  }
  const stamped = fm.get('updated') ?? fm.get('date') ?? fm.get('created');
  const date = stamped !== undefined && /^\d{4}-\d{2}-\d{2}/.test(stamped) ? stamped : statSync(path).mtime.toISOString();
  return { slug: basename(path, '.md'), raw, fm, body, date };
}

function readNotes(dir: string): Note[] {
  if (!existsSync(dir)) return [];
  const notes: Note[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.md') || entry === 'index.md') continue;
    try {
      notes.push(parseNote(join(dir, entry)));
    } catch {
      // One unreadable note never hides the rest of the index.
      continue;
    }
  }
  return notes;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SUMMARY_LENGTH ? `${flat.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…` : flat;
}

function firstHeading(body: string): string {
  const match = /^#\s+(.+)$/m.exec(body);
  return match === null ? '' : match[1].replace(/\[\[(.+?)\]\]/g, '$1').trim();
}

function summaryOf(note: Note): string {
  const described = note.fm.get('description');
  if (described !== undefined && described.length > 0) return oneLine(described);
  let summary = '';
  try {
    summary = featureSummary(note.body);
  } catch {
    summary = '';
  }
  if (summary.length > 0) return oneLine(summary);
  return oneLine(note.fm.get('name') ?? (firstHeading(note.body) || note.slug));
}

const byRecency = (a: Note, b: Note): number => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug);

/** Feature names that have a live plan/discovery, and those only archived. */
function artifactStatus(flowDir: string): { live: Set<string>; archived: Set<string> } {
  const namesIn = (dir: string): Set<string> => {
    const names = new Set<string>();
    if (!existsSync(dir)) return names;
    for (const entry of readdirSync(dir)) {
      const match = /^(?:plan|discovery)_(.+?)_v\d+\.md$/.exec(entry);
      if (match !== null) names.add(match[1].replace(/_/g, '-'));
    }
    return names;
  };
  const live = new Set([...namesIn(join(flowDir, 'plans')), ...namesIn(join(flowDir, 'discovery'))]);
  return { live, archived: namesIn(join(flowDir, 'archive')) };
}

/** The sections of an existing index this generator does not own, verbatim. */
function preservedSections(existing: string | null): string[] {
  if (existing === null) return [];
  const sections: string[] = [];
  let current: string[] | null = null;
  for (const line of existing.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('## ')) {
      if (current !== null) sections.push(current.join('\n').trimEnd());
      current = OWNED_SECTIONS.some((owned) => owned.test(line)) ? null : [line];
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) sections.push(current.join('\n').trimEnd());
  return sections;
}

export interface BuildBrainIndexOptions {
  now?: Date;
  /** The current index text, for carrying over sections other tools keep. */
  existing?: string | null;
}

/** The index for a `flow/` dir, as text. Pure apart from reading the notes. */
export function buildBrainIndex(flowDir: string, options: BuildBrainIndexOptions = {}): string {
  const now = options.now ?? new Date();
  const { live, archived } = artifactStatus(flowDir);
  // A thread's working set is scratch, not a feature (same rule as the board).
  const features = readNotes(join(flowDir, 'brain', 'features')).filter((note) => featureExclusion(note.raw) !== 'working-set');

  const active: Note[] = [];
  const done: { note: Note; status: string }[] = [];
  const capabilities: Note[] = [];
  for (const note of features) {
    const stated = note.fm.get('status');
    let status: string | null = stated !== undefined && stated.length > 0 ? stated : null;
    if (status === null) {
      if (live.has(note.slug)) status = 'active';
      else if (archived.has(note.slug)) status = 'archived';
    }
    if (status === null) capabilities.push(note);
    else if (status === 'active' || status === 'in-progress') active.push(note);
    else done.push({ note, status });
  }
  active.sort(byRecency);
  done.sort((a, b) => byRecency(a.note, b.note));
  capabilities.sort((a, b) => a.slug.localeCompare(b.slug));

  const lines: string[] = [
    '# Brain Index',
    '',
    `**Last Updated**: ${now.toISOString().slice(0, 10)}`,
    '',
    '> Generated from the brain notes on this machine — edit the notes, not this file.',
    '',
    '## Active Features',
  ];
  for (const note of active) {
    lines.push(`- ${note.slug} [${note.fm.get('status') ?? 'active'}] - ${summaryOf(note)}`);
  }
  for (const { note, status } of done.slice(0, MAX_ARCHIVED)) {
    lines.push(`- ~~${note.slug}~~ [${status}] - ${summaryOf(note)}`);
  }
  if (capabilities.length > 0) {
    const shown = capabilities.slice(0, MAX_CAPABILITIES).map((note) => `[[${note.slug}]]`);
    const more = capabilities.length - shown.length;
    lines.push('', '## Capabilities', `- ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`);
  }

  lines.push('', `## Recent Errors (max ${MAX_ERRORS})`);
  for (const note of readNotes(join(flowDir, 'brain', 'errors')).sort(byRecency).slice(0, MAX_ERRORS)) {
    lines.push(`- [[${note.slug}]] - ${summaryOf(note)}`);
  }
  lines.push('', `## Recent Decisions (max ${MAX_DECISIONS})`);
  for (const note of readNotes(join(flowDir, 'brain', 'decisions')).sort(byRecency).slice(0, MAX_DECISIONS)) {
    lines.push(`- [[${note.slug}]] - ${note.fm.get('description') ?? (firstHeading(note.body) || note.slug)}`);
  }
  for (const section of preservedSections(options.existing ?? null)) {
    lines.push('', section);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Rebuild `flow/brain/index.md` from the notes. Returns the path written.
 * Every writer of the index goes through here (allowed-pattern #14).
 */
export function writeBrainIndex(flowDir: string, now: Date = new Date()): string {
  const indexPath = join(flowDir, BRAIN_INDEX_RELPATH);
  const existing = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null;
  atomicWriteFile(indexPath, buildBrainIndex(flowDir, { now, existing }));
  return indexPath;
}
