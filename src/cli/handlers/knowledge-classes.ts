/**
 * THE KNOWLEDGE SYNC CLASSES — one table that says, for every path a project's
 * `flow/` can hold, how it travels (workspaces-knowledge-hub FR-15):
 *
 *   generated    rebuilt locally from other files; NEVER synced (git-ignored).
 *                `brain/index.md`, `.derived/`, the derived `.structure/` files,
 *                compiled `*.run.json`, the graph.
 *   append-only  `*.jsonl` stores; synced, merged by UNION (`merge=union`), so a
 *                merge keeps both sides' lines.
 *   personal     this machine's own state; NEVER leaves it (git-ignored, and the
 *                pre-push guard refuses it even if an ignore file was damaged).
 *   authored     everything else — discoveries, plans, brainstorms, decisions,
 *                feature notes, the archive; synced with git's line merge.
 *
 * ONE TABLE (allowed-pattern #14): the Workspace `.gitignore`, its
 * `.gitattributes`, `classifyKnowledgePath`, the pre-push guard, and the older
 * per-project knowledge repo's ignore list (`knowledgeRepoLocalEntries`, which
 * this supersedes and still exports) are all read off the rows below. Nothing
 * else may restate which file is personal.
 *
 * TWO SCOPES. The per-project knowledge repo (knowledge sync, 3c330c11) shipped
 * syncing `tasklist.md`, `memory.md`, `log.md` and `heartbeat.md` — its users
 * are not migrated (C-4), so rows marked `workspaceOnly` change the Workspace
 * repo and nothing else, and the per-project list stays byte-identical.
 *
 * PATTERNS are gitignore syntax relative to a project's `flow/` root: a leading
 * `/` (or a `/` in the middle) anchors to that root, a bare name matches at any
 * depth, a trailing `/` is a directory. The Workspace emitters re-root them
 * under `projects/*\/` because the Workspace repo holds many projects.
 *
 * ORDER IS PRECEDENCE: `classifyKnowledgePath` takes the FIRST matching row;
 * the `.gitignore` emitter writes rows in reverse, so git's last-match-wins
 * reaches the same verdict.
 *
 * Deliberately import-free (shared.ts and workspace-model.ts both read it).
 */

export type KnowledgeClass = 'generated' | 'append-only' | 'personal' | 'authored';

/** Which historical list a row also belongs to (byte-stable legacy emitters). */
type LegacyGroup = 'derived' | 'personal' | 'extra';

export interface KnowledgeClassRow {
  /** gitignore-syntax pattern relative to a project's `flow/` root. */
  pattern: string;
  class: KnowledgeClass;
  /** One line: why this path is in this class. */
  why: string;
  /** Only the Workspace repo applies this row; the per-project repo does not. */
  workspaceOnly?: boolean;
  /** A tracked class that re-includes paths a LATER (broader) row ignores. */
  reinclude?: boolean;
  /** Membership in a historical list, kept so those lists stay byte-identical. */
  legacy?: LegacyGroup;
}

// ─── The table ──────────────────────────────────────────────────────────────

export const KNOWLEDGE_CLASS_TABLE: readonly KnowledgeClassRow[] = [
  // ── Legacy "derived" list (shared-mode code repo + per-project repo) ──
  // `.raw/` sat in the derived list historically; it is per-thread working
  // drafts, i.e. personal, and the ignore line is the same either way.
  { pattern: 'brain/.raw/', class: 'personal', why: 'auto-captured working drafts of this machine’s threads', legacy: 'derived' },
  { pattern: 'brain/.derived/', class: 'generated', why: 'regenerable feature index', legacy: 'derived' },
  { pattern: 'brain/.structure/graph.json', class: 'generated', why: 'rebuilt by every blueprint derive', legacy: 'derived' },
  { pattern: 'brain/.structure/graph.prev.json', class: 'generated', why: 'rotated derive output', legacy: 'derived' },
  { pattern: 'brain/.structure/symbols.jsonl', class: 'generated', why: 'symbol index rebuilt from code', legacy: 'derived' },
  { pattern: 'brain/.structure/file-stamps.json', class: 'generated', why: 'content hashes of this checkout', legacy: 'derived' },
  { pattern: 'brain/.structure/file-tiers.json', class: 'generated', why: 'trust tiers materialized per derive', legacy: 'derived' },
  { pattern: 'brain/code/', class: 'generated', why: 'code cards rebuilt from the code', legacy: 'derived' },

  // ── Legacy "personal" list ──
  { pattern: '.flowconfig', class: 'personal', why: 'per-machine preferences, may hold credentials', legacy: 'personal' },
  { pattern: '.evidence/', class: 'personal', why: 'per-run verification evidence', legacy: 'personal' },
  { pattern: '.rounds.jsonl', class: 'personal', why: 'the LIVE execution record; the archived summary syncs', legacy: 'personal' },
  { pattern: '.wave-context.jsonl', class: 'personal', why: 'per-wave scratch between parallel phases', legacy: 'personal' },
  { pattern: '.heartbeat-events.jsonl', class: 'personal', why: 'this machine’s daemon events', legacy: 'personal' },
  { pattern: '.heartbeat-state.json', class: 'personal', why: 'this machine’s read position', legacy: 'personal' },
  { pattern: '.heartbeat-prompt.md', class: 'personal', why: 'a question waiting on this machine', legacy: 'personal' },
  { pattern: '.heartbeat.log', class: 'personal', why: 'this machine’s daemon log', legacy: 'personal' },
  { pattern: '.telegram-poll-state.json', class: 'personal', why: 'retired; may hold a bot offset', legacy: 'personal' },
  { pattern: '.scratchpad.md', class: 'personal', why: 'ephemeral session notes', legacy: 'personal' },
  { pattern: '.lavish/', class: 'personal', why: 'retired engine output', legacy: 'personal' },

  // ── Legacy per-project-repo extras ──
  { pattern: '/STATE.md', class: 'personal', why: 'this machine’s execution snapshot', legacy: 'extra' },
  { pattern: 'brain/.structure/story.json', class: 'generated', why: 'compiled from a document’s Story', legacy: 'extra' },
  { pattern: 'brain/.structure/blueprint.html', class: 'generated', why: 'rendered title sheet', legacy: 'extra' },
  { pattern: 'brain/.structure/file-*.json', class: 'generated', why: 'rotated stamp/tier files', legacy: 'extra' },
  { pattern: 'brain/.structure/brain-usage.json', class: 'personal', why: 'this machine’s search usage counters', legacy: 'extra' },
  { pattern: 'brain/.structure/invariant-verdicts.json', class: 'generated', why: 'derived verdicts', legacy: 'extra' },
  { pattern: 'brain/.structure/outbound.json', class: 'generated', why: 'derived outbound surface', legacy: 'extra' },
  { pattern: 'brain/.structure/surface.json', class: 'generated', why: 'derived surface', legacy: 'extra' },
  { pattern: 'brain/.structure/feature-views/', class: 'generated', why: 'drawn from plans', legacy: 'extra' },
  { pattern: '/brain/blueprint-report.md', class: 'generated', why: 'prose report every derive rewrites', legacy: 'extra' },
  { pattern: '/.heartbeat-*', class: 'personal', why: 'daemon pid/version/tmp files', legacy: 'extra' },
  { pattern: '/.heartbeat.*', class: 'personal', why: 'daemon pid/version/tmp files', legacy: 'extra' },

  // The ONLY file at a project's knowledge root that is team knowledge. It
  // used to be `authored` by falling through to the default; now that the
  // root is a closed set, the one legitimate member has to be named.
  { pattern: '/ledger.md', class: 'authored', why: 'the project’s shared learning journal' },

  // ── Workspace-only: personal journals and local learning state ──
  { pattern: '/heartbeat.md', class: 'personal', why: 'this machine’s scheduled tasks', workspaceOnly: true },
  { pattern: '/memory.md', class: 'personal', why: 'this person’s artifact memory', workspaceOnly: true },
  { pattern: '/log.md', class: 'personal', why: 'this machine’s heartbeat log', workspaceOnly: true },
  { pattern: '/tasklist.md', class: 'personal', why: 'this person’s todo list', workspaceOnly: true },
  { pattern: '/.gitcontrol', class: 'personal', why: 'legacy per-machine git settings', workspaceOnly: true },
  { pattern: 'brain/.structure/learning-state.jsonl', class: 'personal', why: 'what THIS machine has learned', workspaceOnly: true },
  { pattern: 'brain/.structure/feature-learning-state.json', class: 'personal', why: 'per-machine feature read counters', workspaceOnly: true },
  { pattern: 'brain/.structure/*.lock', class: 'personal', why: 'advisory locks', workspaceOnly: true },

  // ── Workspace-only: generated ──
  { pattern: '/references/tech-foundation.md', class: 'generated', why: 'written by init from this checkout (folder name, date); each machine makes its own', workspaceOnly: true },
  { pattern: '/brain/index.md', class: 'generated', why: 'rebuilt from the notes on each machine', workspaceOnly: true },
  { pattern: '*.run.json', class: 'generated', why: 'compiled from the plan', workspaceOnly: true },
  { pattern: '*.run.prev.json', class: 'generated', why: 'rotated compiled run script', workspaceOnly: true },
  { pattern: '*.tmp', class: 'generated', why: 'an interrupted atomic write', workspaceOnly: true },
  { pattern: 'brain/.structure/storyline/', class: 'generated', why: 'files read as stories, cached by content hash — rebuilt on each machine from its own checkout', workspaceOnly: true },
  // Every jsonl in `.structure/` is an append-only store (annotations,
  // investigations, proposals, status events, feature candidates) — except the
  // generated/personal ones named above. Everything else there is derived.
  { pattern: 'brain/.structure/*.jsonl', class: 'append-only', why: 'append-only blueprint stores', workspaceOnly: true, reinclude: true },
  { pattern: 'brain/.structure/*', class: 'generated', why: 'derived structure layer', workspaceOnly: true },

  // ── The general rules ──
  { pattern: '*.jsonl', class: 'append-only', why: 'append-only stores merge by union' },
];

/**
 * Paths at the Workspace repo's ROOT (beside `projects/`), classified before
 * the project table is consulted.
 */
export const WORKSPACE_ROOT_TABLE: readonly KnowledgeClassRow[] = [
  { pattern: '/workspace.json', class: 'authored', why: 'the Workspace’s own description' },
  { pattern: '/.gitignore', class: 'authored', why: 'generated by Flow, committed so every clone ignores the same files' },
  { pattern: '/.gitattributes', class: 'authored', why: 'generated by Flow, committed so every clone merges the same way' },
  { pattern: '/links.jsonl', class: 'append-only', why: 'cross-project links' },
  { pattern: '/merges/', class: 'authored', why: 'the audit of every automatic merge' },
];

// ─── Matching ───────────────────────────────────────────────────────────────

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** A gitignore-syntax glob body → regex source (no anchors). */
function globSource(body: string): string {
  let out = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '*') {
      if (body[index + 1] === '*') {
        const slashAfter = body[index + 2] === '/';
        out += slashAfter ? '(?:.*/)?' : '.*';
        index += slashAfter ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
}

const compiled = new Map<string, RegExp>();

/** Does a gitignore-syntax `pattern` match the file path `relPath`? */
export function matchesKnowledgePattern(pattern: string, relPath: string): boolean {
  let regex = compiled.get(pattern);
  if (regex === undefined) {
    const directory = pattern.endsWith('/');
    let body = directory ? pattern.slice(0, -1) : pattern;
    const anchored = body.startsWith('/') || body.includes('/');
    if (body.startsWith('/')) body = body.slice(1);
    const prefix = anchored ? '^' : '^(?:.*/)?';
    // A file pattern also matches a DIRECTORY of that name, which takes
    // everything under it — exactly as git reads it.
    const suffix = directory ? '/.+$' : '(?:/.+)?$';
    // CASE-INSENSITIVE: on a case-insensitive disk (macOS, Windows) `TaskList.md`
    // IS `tasklist.md`, so a class that only matched one spelling would let the
    // other carry a personal file out (or in) under the guard's nose.
    regex = new RegExp(`${prefix}${globSource(body)}${suffix}`, 'i');
    compiled.set(pattern, regex);
  }
  return regex.test(relPath);
}

function normalizePath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export interface KnowledgeClassification {
  class: KnowledgeClass;
  /** The row that decided it, or null for the authored default. */
  row: KnowledgeClassRow | null;
  /** The project slug when the path was under `projects/<slug>/`. */
  project: string | null;
}

export interface ClassifyOptions {
  /**
   * What `relPath` is relative to: a project's `flow/` root (default), or the
   * Workspace repo root (`projects/<slug>/…`, `workspace.json`, …) — the form
   * `git diff --cached --name-only` prints inside a Workspace.
   */
  root?: 'project' | 'workspace';
  /** Apply only the per-project-repo rows (no `workspaceOnly`). Default false. */
  legacyScope?: boolean;
}

function classifyInProject(
  relPath: string,
  legacyScope: boolean,
  closedRoot: boolean
): { class: KnowledgeClass; row: KnowledgeClassRow | null } {
  for (const row of KNOWLEDGE_CLASS_TABLE) {
    if (legacyScope && row.workspaceOnly === true) continue;
    if (matchesKnowledgePattern(row.pattern, relPath)) return { class: row.class, row };
  }
  // THE KNOWLEDGE ROOT IS A CLOSED SET, AND ITS DEFAULT IS *NOT SHARED*.
  //
  // Every artifact has a folder — discovery/, plans/, resources/, archive/ —
  // and the root holds a handful of named files and nothing else. An
  // unrecognised file sitting there is a deliverable somebody wrote beside the
  // folders instead of inside one, and the old default (`authored`) published
  // it to the whole team.
  //
  // Measured on a real Workspace the day this changed: of EVERY root-level
  // file tracked across five projects, not one was a legitimate artifact —
  // four Confluence drafts, two PR drafts, a QA checklist, a test plan, a
  // stray .patch, and a .DS_Store. A default that is wrong for 100% of the
  // cases it has ever decided is the wrong default.
  //
  // Unshared is the safe direction: a file kept local is filed later and
  // syncs then, while a file published to a team repository is read by other
  // people's agents as settled knowledge and steers them.
  //
  // NOT in `legacyScope`. A per-project knowledge repo — `flow/` as its own
  // repository, the mode that predates Workspaces — shares its root journals
  // by contract (tasklist, memory, log, heartbeat are `workspaceOnly` rows and
  // are skipped there, so they land on this default on purpose). Closing the
  // root there would stop an existing repo syncing the journals it has always
  // synced, which is a different change from the one this is.
  if (closedRoot && !legacyScope && !relPath.includes('/')) return { class: 'personal', row: null };
  return { class: 'authored', row: null };
}

/** The sync class of one knowledge path, and the row that decided it. */
export function classifyKnowledgePathDetailed(relPath: string, options: ClassifyOptions = {}): KnowledgeClassification {
  const path = normalizePath(relPath);
  const legacyScope = options.legacyScope === true;
  if (options.root === 'workspace') {
    const underProject = /^projects\/([^/]+)\/(.+)$/.exec(path);
    if (underProject !== null) {
      return { ...classifyInProject(underProject[2], legacyScope, true), project: underProject[1] };
    }
    for (const row of WORKSPACE_ROOT_TABLE) {
      if (matchesKnowledgePattern(row.pattern, path)) return { class: row.class, row, project: null };
    }
    // Anything else at the root is judged by the project rules too, so a
    // personal file dropped there by hand is still recognised. The closed-root
    // rule does NOT apply here: this is the Workspace repo's own root, whose
    // members (the team README, the generated git files, the shared learning
    // log) are a different set from a project's.
    return { ...classifyInProject(path, legacyScope, false), project: null };
  }
  return { ...classifyInProject(path, legacyScope, true), project: null };
}

/** The sync class of one knowledge path. See `ClassifyOptions` for `root`. */
export function classifyKnowledgePath(relPath: string, options: ClassifyOptions = {}): KnowledgeClass {
  return classifyKnowledgePathDetailed(relPath, options).class;
}

// ─── Emitters ───────────────────────────────────────────────────────────────

const WORKSPACE_MARKER_START = '# >>> plan-flow workspace (generated — edits inside this block are replaced) >>>';
const WORKSPACE_MARKER_END = '# <<< plan-flow workspace <<<';

/** Re-root a project-relative pattern under every project of a Workspace. */
function underEveryProject(pattern: string): string {
  const negated = pattern.startsWith('!');
  const raw = negated ? pattern.slice(1) : pattern;
  const directory = raw.endsWith('/');
  const body = directory ? raw.slice(0, -1) : raw;
  const anchored = body.startsWith('/') || body.includes('/');
  const rooted = anchored ? `/projects/*/${body.replace(/^\//, '')}` : `/projects/*/**/${body}`;
  return `${negated ? '!' : ''}${rooted}${directory ? '/' : ''}`;
}

/**
 * The Workspace repo's `.gitignore`: every generated and personal row, re-rooted
 * under `projects/*\/`, written in REVERSE table order so git's last match wins
 * the same way the table's first match does. Deterministic: same table, same
 * bytes.
 */
export function workspaceGitignore(): string {
  const lines: string[] = [
    WORKSPACE_MARKER_START,
    '# The Workspace repository commits authored knowledge and append-only stores.',
    '# Generated files are rebuilt on each machine; personal files never leave it.',
    '',
    "# A project's knowledge root is a closed set: every artifact lives in a",
    '# folder, and a loose file beside them is a deliberable somebody misfiled',
    '# (forbidden-pattern #24). Ignored rather than published, which also stops',
    '# it flapping — without this, sync would stage it, untrack it as personal,',
    '# stage it again next run, and commit a removal every other sync for ever.',
    '/projects/*/*',
    '!/projects/*/*/',
    '!/projects/*/ledger.md',
    '',
  ];
  for (const row of [...KNOWLEDGE_CLASS_TABLE].reverse()) {
    if (row.class === 'generated' || row.class === 'personal') {
      lines.push(underEveryProject(row.pattern));
    } else if (row.reinclude === true) {
      lines.push(underEveryProject(`!${row.pattern}`));
    }
  }
  lines.push(WORKSPACE_MARKER_END);
  return lines.join('\n');
}

/**
 * The Workspace repo's `.gitattributes`: every append-only store merges by
 * union, so two machines' appends both survive a merge. Repo-wide on purpose —
 * `links.jsonl` at the root is append-only too.
 */
export function workspaceGitattributes(): string {
  return [
    WORKSPACE_MARKER_START,
    '# Append-only knowledge stores: a merge keeps BOTH sides\' lines, never one.',
    '*.jsonl merge=union',
    WORKSPACE_MARKER_END,
  ].join('\n');
}

/**
 * A text split around Flow's generated block: the block itself (null when
 * absent) and every line outside it, normalized (trailing spaces and blank
 * lines dropped) so a re-emitted block or a stray newline is no change.
 */
export function splitWorkspaceBlock(text: string | null): { block: string | null; outside: string } {
  if (text === null) return { block: null, outside: '' };
  const start = text.indexOf(WORKSPACE_MARKER_START);
  const end = text.indexOf(WORKSPACE_MARKER_END);
  const hasBlock = start !== -1 && end !== -1 && end > start;
  const block = hasBlock ? text.slice(start, end + WORKSPACE_MARKER_END.length) : null;
  const rest = hasBlock ? `${text.slice(0, start)}\n${text.slice(end + WORKSPACE_MARKER_END.length)}` : text;
  const outside = rest
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .join('\n');
  return { block, outside };
}

/**
 * Replace (or add) the generated block inside an existing file's text, keeping
 * every line a person wrote outside it. Returns the new text.
 */
export function upsertWorkspaceBlock(existing: string | null, block: string): string {
  if (existing === null || existing.trim() === '') return `${block}\n`;
  const start = existing.indexOf(WORKSPACE_MARKER_START);
  const end = existing.indexOf(WORKSPACE_MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + WORKSPACE_MARKER_END.length)}`;
  }
  return `${existing.replace(/\s*$/, '\n')}\n${block}\n`;
}

/* A markdown file cannot use the `#` markers: they would render as headings.
   HTML comments are invisible in every renderer Azure DevOps, GitHub and
   Obsidian use, and are still a plain string to find. */
const README_MARKER_START = '<!-- >>> plan-flow workspace (generated — edits inside this block are replaced) >>> -->';
const README_MARKER_END = '<!-- <<< plan-flow workspace <<< -->';

/**
 * The README a Workspace repository explains itself with.
 *
 * It exists because of what the repository looks like to somebody who did not
 * make it. A teammate opening it in a browser sees `projects/<slug>/brain/…`
 * and several hundred markdown files with no code, no build and no entry
 * point, and the honest first question — "what is this, and may I edit it?" —
 * has no answer anywhere in the repository. Azure's own scaffolded README says
 * TODO four times.
 *
 * Generated from the same class table that decides what syncs, so the "what is
 * shared" section cannot drift from the behaviour: both are the table.
 */
export function workspaceReadme(workspaceName: string): string {
  const shared = KNOWLEDGE_CLASS_TABLE.filter((row) => row.class === 'append-only').length;
  return [
    README_MARKER_START,
    `# ${workspaceName} — a Flow Workspace`,
    '',
    'This repository holds **what a team knows about its projects**, not the projects.',
    'There is no code here to build and nothing to run. Every file is markdown or',
    'JSON that Flow reads, writes and keeps in step with the code living in the',
    'ordinary repositories beside it.',
    '',
    '## What is in it',
    '',
    '```',
    'workspace.json           the projects this Workspace holds, and where their code lives',
    'links.jsonl              connections noticed between projects (append-only)',
    'projects/<slug>/         one folder per project — its knowledge, never its code',
    '```',
    '',
    'Inside a project:',
    '',
    '```',
    'brain/features/          what each capability IS — the index, described below',
    'brain/decisions/         why something was done the way it was',
    'brain/errors/            failures worth recognising again',
    'discovery/  plans/       intent: what someone meant to build, and how',
    'brainstorms/             thinking that has not become a plan',
    'reviewed-code/  reviewed-pr/   what review found',
    'resources/               finished documents worth keeping',
    'archive/                 completed and abandoned work',
    'contracts/  references/  external API shapes and generated reference material',
    '```',
    '',
    '## How the index works',
    '',
    'The index is the markdown. There is no database, nothing to rebuild and',
    'nothing that can be stale as a whole — searching runs over these files',
    'directly.',
    '',
    '**A feature is a capability, not a folder.** `brain/features/<slug>.md` describes',
    'one thing the project does. Its frontmatter carries `anchors:` — the real files',
    'that capability stands on — and `kind:` saying whether it is a capability',
    '(`core`), a piece of one (`part`) or a change that touched it (`child`).',
    '',
    '**Documents are stamped against the code they describe.** A learned document',
    'records content hashes of the files it was written from. When that code moves,',
    'the document is flagged stale and re-learned. Staleness is decided by content,',
    'never by a timestamp — so an edit nobody committed still counts.',
    '',
    '**Code is the ground truth.** Where a document and the code disagree, the code',
    'wins and the document is the thing that is wrong. A README or a wiki page found',
    'outside this repository is an unverified claim until it is checked against the',
    'code.',
    '',
    '## What syncs, and what never leaves a machine',
    '',
    'Every path falls into one of four classes, decided in one place:',
    '',
    '| Class | Example | Shared? |',
    '| --- | --- | --- |',
    '| authored | `discovery/`, `plans/`, `brain/features/` | yes — this is the knowledge |',
    `| append-only | ${shared} stores such as \`links.jsonl\` | yes, merged by union so no one's lines are lost |`,
    '| generated | derived indexes, rebuilt per machine | no — each machine makes its own |',
    '| personal | `.flowconfig`, journals, daemon state | no — never leaves the machine |',
    '',
    "A project's knowledge root is a **closed set**: every artifact belongs in one of",
    'the folders above. A loose file beside them is treated as personal and stays',
    'local, because it is almost always a deliverable someone misfiled.',
    '',
    '## Drafts stay out',
    '',
    'A document may say whether it is ready:',
    '',
    '```yaml',
    '---',
    'status: draft          # never published',
    'landed_by: run_orders  # published once that token reaches the default branch',
    '---',
    '```',
    '',
    '`landed_by` is matched against a `Flow-Run:` trailer on the commits the work was',
    'made in, so knowledge about a branch nobody merged does not become something the',
    'rest of the team plans against. A document with neither key is shared, which is',
    'what every document written before this existed does.',
    '',
    '## Editing it',
    '',
    'The markdown is **yours**: correcting a document by editing it is the intended',
    'way to correct it, and no automatic pass overwrites prose, a name or a kind.',
    '',
    'Do not hand-edit `workspace.json`, `links.jsonl`, `merges/`, or anything inside',
    'a block marked generated — including this one. Flow rewrites them, and an edit',
    'there is lost rather than honoured.',
    '',
    '## Joining it',
    '',
    "In Flow: **Join a Workspace**, with this repository's address. The projects you",
    'already have open are matched to the ones listed here, and you choose which to',
    'join. Their knowledge arrives with them.',
    README_MARKER_END,
  ].join('\n');
}

/** Replace (or add) the README's generated block, keeping a person's own prose. */
export function upsertReadmeBlock(existing: string | null, block: string): string {
  if (existing === null || existing.trim() === '') return `${block}\n`;
  const start = existing.indexOf(README_MARKER_START);
  const end = existing.indexOf(README_MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + README_MARKER_END.length)}`;
  }
  return `${existing.replace(/\s*$/, '\n')}\n${block}\n`;
}

// ─── The legacy lists (superseded, byte-stable) ─────────────────────────────

function legacyPatterns(group: LegacyGroup): string[] {
  return KNOWLEDGE_CLASS_TABLE.filter((row) => row.legacy === group).map((row) => row.pattern);
}

/** The shared-mode code repo's DERIVED entries (`flow/`-prefixed, historical order). */
export function codeRepoDerivedEntries(): string[] {
  return legacyPatterns('derived').map((pattern) => `flow/${pattern}`);
}

/** The shared-mode code repo's PERSONAL entries (`flow/`-prefixed, historical order). */
export function codeRepoPersonalEntries(): string[] {
  return legacyPatterns('personal').map((pattern) => `flow/${pattern}`);
}

/**
 * THE list of what stays on this machine inside a project's OWN knowledge repo
 * (per-project knowledge sync), relative to that repo's root (`flow/`).
 * Superseded by the table above and kept, byte-for-byte, for its callers and
 * for the projects already syncing that way (C-4).
 */
export function knowledgeRepoLocalEntries(): string[] {
  return [...legacyPatterns('derived'), ...legacyPatterns('personal'), ...legacyPatterns('extra')];
}

// ─── The pre-push guard ─────────────────────────────────────────────────────

export interface PersonalFileHit {
  path: string;
  /** The table row that names it personal. */
  pattern: string;
  why: string;
}

/** Every path in `stagedPaths` (Workspace-root relative) that is personal. */
export function findPersonalFiles(stagedPaths: readonly string[]): PersonalFileHit[] {
  const hits: PersonalFileHit[] = [];
  for (const path of stagedPaths) {
    const verdict = classifyKnowledgePathDetailed(path, { root: 'workspace' });
    if (verdict.class === 'personal' && verdict.row !== null) {
      hits.push({ path, pattern: verdict.row.pattern, why: verdict.row.why });
    }
  }
  return hits;
}

/** Raised by `assertNoPersonalFiles`. `paths` is what was refused. */
export class PersonalFilesRefusal extends Error {
  readonly reason = 'personal-files' as const;
  readonly paths: string[];
  readonly hits: PersonalFileHit[];
  readonly sentence: string;

  constructor(hits: PersonalFileHit[]) {
    const paths = hits.map((hit) => hit.path);
    const sentence =
      hits.length === 1
        ? `${paths[0]} belongs to this machine only, so it can't be shared with the Workspace`
        : `${hits.length} files belong to this machine only, so they can't be shared with the Workspace: ${paths.join(', ')}`;
    super(sentence);
    this.name = 'PersonalFilesRefusal';
    this.paths = paths;
    this.hits = hits;
    this.sentence = sentence;
  }
}

/**
 * The pre-push guard (Phase 6's `workspace sync` calls it on the staged list
 * before committing). Paths are relative to the Workspace repo root. Refuses —
 * throws `PersonalFilesRefusal` carrying every offending path — when any of
 * them is in the personal class, whatever the `.gitignore` says: an ignore
 * file can be hand-damaged or force-added past, this check cannot.
 */
export function assertNoPersonalFiles(stagedPaths: readonly string[]): void {
  const hits = findPersonalFiles(stagedPaths);
  if (hits.length > 0) throw new PersonalFilesRefusal(hits);
}
