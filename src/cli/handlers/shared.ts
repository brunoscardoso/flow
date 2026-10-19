/**
 * Shared handler
 *
 * Creates flow/ directory structure and manages .gitignore entries.
 * Runs for all platform installations.
 */

import { join, resolve, dirname, relative } from 'node:path';
import { existsSync, readFileSync, writeFileSync, readdirSync, lstatSync, unlinkSync, rmSync, rmdirSync, statSync, cpSync, mkdirSync } from 'node:fs';
import type { BrainPointer, CopyOptions, CopyResult, Platform, ShareMode } from '../types.js';
import { upsertFlowconfigKey } from '../state/flowconfig-writer.js';
import {
  codeRepoDerivedEntries,
  codeRepoPersonalEntries,
  knowledgeRepoLocalEntries,
} from './knowledge-classes.js';
import { writeBrainIndex } from '../state/brain-index.js';
import { workspaceAuthor } from './knowledge-authorship.js';
import { locateWorkspaceProject } from './workspace-locate.js';
import {
  ensureDir,
  getVaultDir,
  getProjectName,
  createSymlink,
  readSymlinkTarget,
  isSymlink,
  mergeMissingContents,
  moveContents,
} from '../utils/files.js';
import { askBusinessContext } from '../utils/prompts.js';
import { seedLoopDirectives } from '../loop/directive-templates.js';
import * as log from '../utils/logger.js';
import { ensureCopilotSandboxAccess } from '../copilot/sandbox-config.js';

/** The standard `flow/` layout every provision (and a knowledge repo started
 *  from nothing) scaffolds. Exported so `knowledge enable` reuses it. */
export const FLOW_SUBDIRS = [
  'archive',
  'brain',
  'brain/features',
  'brain/errors',
  'brain/learning',
  'contracts',
  'discovery',
  'plans',
  'references',
  'resources',
  'brainstorms',
  'reviewed-code',
  'reviewed-pr',
];

const MARKER_START = '# >>> plan-flow';
const MARKER_END = '# <<< plan-flow';

/**
 * Maps each platform to the paths it installs in the user's project.
 */
const PLATFORM_GITIGNORE_ENTRIES: Record<Platform, string[]> = {
  claude: ['.claude/*', '!.claude/rules/', '!.claude/rules/core/', '!.claude/rules/core/allowed-patterns.md', '!.claude/rules/core/forbidden-patterns.md', 'CLAUDE.md'],
};

/** The project's default answer when nobody has answered: keep it local. */
export const DEFAULT_SHARE_MODE: ShareMode = 'local';

/**
 * Paths ignored in BOTH modes, because nothing about them is knowledge:
 *  - `graphify-out` is the graphify engine's graph output at the repo root,
 *    so it is never covered by a `flow` entry. No trailing slash: it must match
 *    the local directory AND any transient relocation symlink (#142).
 *  - `.brain.sqlite` is the RETIRED search index. Nothing writes it any more —
 *    the entry is kept as legacy tolerance, because every project provisioned
 *    before the retirement still has a multi-tens-of-MB database sitting at its
 *    root, and deleting it is the user's call, not ours. Dropping this line
 *    would make that leftover trackable and let someone commit it. It costs one
 *    line, and it retires on its own once no such file survives.
 *  - the two config/env files are per-machine.
 */
const ALWAYS_IGNORED_ENTRIES = ['.plan-flow.yml', '.plan.flow.env', '.brain.sqlite', 'graphify-out'];

/**
 * The knowledge layer, ignored wholesale in `local` mode.
 *
 * ROOT-ANCHORED and NO trailing slash, deliberately — this is the shape that
 * kept getting hand-tuned back in and clobbered by the next provision:
 *  - a trailing slash (`flow/`) does NOT match the top-level `flow` vault
 *    SYMLINK, because git sees a symlink as a file;
 *  - without the leading slash, `flow` also swallows nested SOURCE directories
 *    (e.g. `app/src/renderer/flow/`), silently dropping new files added there.
 * It still recursively covers runtime artifacts under it — `flow/.evidence/`,
 * `flow/.rounds.jsonl` — so those need no entries of their own.
 */
const LOCAL_KNOWLEDGE_ENTRY = '/flow';

/**
 * In `separate` mode `flow/` is its OWN nested git repo (a team brain repo), so
 * the PARENT repo ignores it wholesale — the same root-anchored `/flow` shape as
 * `local` — PLUS `.claude/rules`, which is MATERIALIZED locally from the brain
 * repo's `flow/rules/` and must never be committed to the code repo. Both are
 * root-anchored so they cannot swallow a nested source dir.
 */
const SEPARATE_KNOWLEDGE_ENTRIES = [LOCAL_KNOWLEDGE_ENTRY, '/.claude/rules'];

/**
 * In `shared` mode the knowledge markdown is committed, so only the DERIVED
 * layer is ignored: everything a `blueprint derive` / capture pass rebuilds
 * from the markdown and the code. `.raw/` is auto-captured working-set drafts
 * and stays untracked in both modes.
 *
 * These are NOT root-anchored: after the migration `flow/` is a real directory
 * in the repo, and an unanchored path with this many segments cannot collide
 * with anything else.
 */
// The rows live in the one sync-class table (knowledge-classes.ts); the
// historical order is kept so this block's bytes never change.
const DERIVED_KNOWLEDGE_ENTRIES = codeRepoDerivedEntries();

/**
 * PER-RUN and PER-MACHINE artifacts that live under `flow/` but are not
 * knowledge. `local` covers them by inheritance from `/flow`; `shared` has to
 * name them, or every run of every teammate churns the repo.
 *
 * Three of these were flagged as open questions when the shared list was first
 * drawn, and are settled here:
 *  - `.flowconfig` holds `telegram_bot_token` / `webhook_url` alongside
 *    per-machine preferences. It is IGNORED: a credential must never become
 *    trackable by flipping a sharing switch. The team's mode still travels,
 *    because the generated `.gitignore` block states it in its own header and
 *    `readShareMode` falls back to reading it there.
 *  - `.evidence/`, `.rounds.jsonl`, `.wave-context.jsonl` are per-run execution
 *    records. The durable copy of a run is `flow/archive/rounds_<plan>.jsonl`,
 *    which stays tracked; the live ones are rewritten by every execution.
 *  - the heartbeat/telegram/scratchpad state files are the same class — machine
 *    state that would conflict on every pull.
 *
 * NOTHING under `flow/brain/features/` appears here: the auto-captured working
 * sets living in that directory are excluded by a nested, self-ignoring list
 * (see `updateWorkingSetIgnore`), so this block never has to name a path inside
 * the precious layer.
 */
// RETIRED entries (`.telegram-poll-state.json`, `.lavish/`) are KEPT on purpose
// in the table: a project provisioned before their removal may still have them
// on disk, and dropping the line would start committing them.
const PERSONAL_ENTRIES = codeRepoPersonalEntries();

/**
 * The shared (platform-independent) gitignore entries FOR A GIVEN SHARE MODE.
 *
 * This was a constant, and that was the bug: regeneration had no way to know
 * what the user wanted, so every hand-tuned `.gitignore` was "clobbered" by a
 * generator doing its job. It is a function of the answer now.
 */
export function sharedGitignoreEntries(mode: ShareMode): string[] {
  switch (mode) {
    case 'shared':
      return [...DERIVED_KNOWLEDGE_ENTRIES, ...PERSONAL_ENTRIES, ...ALWAYS_IGNORED_ENTRIES];
    case 'separate':
      return [...SEPARATE_KNOWLEDGE_ENTRIES, ...ALWAYS_IGNORED_ENTRIES];
    case 'local':
    default:
      return [LOCAL_KNOWLEDGE_ENTRY, ...ALWAYS_IGNORED_ENTRIES];
  }
}

/** The explanatory header carried INSIDE the block, per mode. Generated, so it
 *  survives every regeneration — the reason the hand edits kept being lost. In
 *  `separate` mode it also carries the brain-repo POINTER, the one channel a
 *  fresh clone reads. */
function shareModeComment(mode: ShareMode, pointer?: BrainPointer): string[] {
  switch (mode) {
    case 'shared':
      return [
        '# Knowledge sharing: shared — flow/ knowledge markdown is committed with the code.',
        '# Only the derived layer is ignored. Switch back with: /flow share=local',
      ];
    case 'separate':
      return [
        '# Knowledge sharing: separate — flow/ is its own git repo (a team brain repo);',
        '# the code repo ignores flow/ and the materialized .claude/rules.',
        ...(pointer
          ? [`# Brain repo: ${pointer.url}${pointer.branch ? ` ${pointer.branch}` : ''}`]
          : []),
      ];
    case 'local':
    default:
      return [
        '# Knowledge sharing: local — flow/ stays out of git entirely.',
        '# Root-anchored, no trailing slash (the top-level flow is a SYMLINK, which',
        '# git sees as a file; unanchored would also swallow nested source dirs).',
        '# Share it with the team with: /flow share=shared',
      ];
  }
}

/**
 * Builds the plan-flow .gitignore block with markers.
 *
 * Deterministic: same mode + same platforms (+ same pointer) → byte-identical
 * block, every time.
 */
export function buildGitignoreBlock(
  platforms: Platform[],
  mode: ShareMode,
  pointer?: BrainPointer
): string {
  const lines: string[] = [MARKER_START, ...shareModeComment(mode, pointer)];

  // Shared entries — a function of the share mode
  for (const entry of sharedGitignoreEntries(mode)) {
    lines.push(entry);
  }

  // Platform-specific entries
  for (const platform of platforms) {
    const entries = PLATFORM_GITIGNORE_ENTRIES[platform];
    if (entries) {
      for (const entry of entries) {
        // In `separate` mode `.claude/rules` is materialized from the brain repo
        // and IGNORED, so the platform un-ignores that would re-track it are
        // suppressed (else last-match-wins re-includes rules the code repo must
        // not carry).
        if (mode === 'separate' && entry.startsWith('!.claude/rules')) continue;
        lines.push(entry);
      }
    }
  }

  lines.push(MARKER_END);
  return lines.join('\n');
}

/**
 * THE list of what stays on this machine inside a project's OWN knowledge repo
 * (per-project knowledge sync) — superseded by the sync-class table in
 * `knowledge-classes.ts`, which now owns every row (and the Workspace repo's
 * ignore file). Re-exported here so existing callers keep their import.
 */
export { knowledgeRepoLocalEntries };

/**
 * The `.gitignore` for the NESTED brain repo (separate mode), whose root IS the
 * project's `flow/` dir. It commits the precious knowledge (markdown + append-only
 * stores + `rules/`) and ignores the derived/personal layer listed by
 * `knowledgeRepoLocalEntries`.
 *
 * `rules/` is NOT ignored: the team's coding standards are precious knowledge and
 * are committed in the brain repo (materialized to `<cwd>/.claude/rules` locally).
 */
export function buildBrainRepoGitignore(): string {
  const lines: string[] = [
    MARKER_START,
    '# plan-flow brain repo — precious knowledge is committed; derived/personal is ignored.',
    '# Paths are relative to this repo root, which is the project\'s flow/ directory.',
    ...knowledgeRepoLocalEntries(),
    MARKER_END,
  ];
  return lines.join('\n');
}

/**
 * The knowledge repo's OWN `.gitattributes`. Distinct from the code repo's
 * block (`flow/**\/*.jsonl`): here the repo root IS `flow/`, and every JSONL in
 * it is an append-only store, so the rule is repo-wide. Deterministic.
 */
export function buildBrainRepoGitattributes(): string {
  return [
    MARKER_START,
    '# Append-only knowledge stores: a merge must keep BOTH sides\' entries, never',
    '# pick one. Identical entries are deduped when the store is read.',
    '*.jsonl merge=union',
    MARKER_END,
  ].join('\n');
}

/**
 * Whether this project keeps its knowledge in its OWN git repo at `flow/`:
 * the COMMITTED `.gitignore` block says `separate` and carries a brain-repo
 * pointer. Read from the committed block on purpose — it is what a fresh clone
 * on another machine has, before any `flow/` (and its `.flowconfig`) exists.
 *
 * When true, provisioning never moves, re-links or pre-creates `flow/`: that
 * path belongs to the knowledge clone.
 */
export function keepsOwnKnowledgeRepo(target: string): boolean {
  return readShareModeFromGitignore(target) === 'separate' && readBrainPointer(target) !== null;
}

/**
 * Reads the project's persisted share setting from `flow/.flowconfig`.
 * Returns `null` when the key is absent or unparseable — the caller must
 * distinguish "never answered" from "answered local", because an unanswered
 * project is asked, never published.
 */
export function readShareMode(target: string): ShareMode | null {
  const configPath = join(target, 'flow', '.flowconfig');
  if (existsSync(configPath)) {
    try {
      // Same line grammar as the flowconfig parser: value constrained to its line.
      const match = readFileSync(configPath, 'utf-8').match(/^share:[ \t]*(local|shared|separate)[ \t\r]*$/m);
      if (match) return match[1] as ShareMode;
    } catch {
      // Sanctioned fail-soft: unreadable config — fall through to the block.
    }
  }
  return readShareModeFromGitignore(target);
}

/**
 * The team's answer as recorded in the COMMITTED `.gitignore` block.
 *
 * `flow/.flowconfig` is ignored in shared mode (it can carry a bot token), so
 * it cannot be the channel that carries the mode to a teammate's clone. The
 * generated block already states the mode in its own header — a line that is
 * committed, regenerated from the setting, and therefore always true. Reading
 * it back is what lets a clone regenerate the SAME block instead of silently
 * reverting the project to local on the next provision.
 */
export function readShareModeFromGitignore(target: string): ShareMode | null {
  const gitignorePath = join(target, '.gitignore');
  if (!existsSync(gitignorePath)) return null;
  try {
    const match = readFileSync(gitignorePath, 'utf-8').match(/^# Knowledge sharing: (local|shared|separate)\b/m);
    return match ? (match[1] as ShareMode) : null;
  } catch {
    return null;
  }
}

/**
 * The `separate`-mode brain-repo pointer, read from the COMMITTED `.gitignore`
 * header (`# Brain repo: <url> [branch]`). Null when absent.
 *
 * This is the ONLY channel a fresh clone has: `flow/.flowconfig` is gitignored in
 * separate mode, so the URL a teammate needs to clone the brain into `flow/` must
 * live in a file the parent repo commits. The generated block is that file.
 */
export function readBrainPointer(target: string): BrainPointer | null {
  const gitignorePath = join(target, '.gitignore');
  if (!existsSync(gitignorePath)) return null;
  try {
    const match = readFileSync(gitignorePath, 'utf-8').match(
      /^# Brain repo: (\S+)(?:[ \t]+(\S+))?[ \t\r]*$/m
    );
    if (!match) return null;
    return match[2] ? { url: match[1], branch: match[2] } : { url: match[1] };
  } catch {
    return null;
  }
}

/**
 * Materialize the team rules from the brain repo (canonical at `<flowDir>/rules/`)
 * into `<projectRoot>/.claude/rules/`, the location the SDK loads project rules
 * from (`'project'` scope). ONE-WAY: the brain copy is the source of truth; the
 * `.claude/rules` copy is gitignored in the code repo (separate mode) and rebuilt
 * from the brain on open. Returns the paths written (relative to projectRoot). A
 * missing source is a no-op — a project may not have team rules yet.
 *
 * This is what resolves discovery R-2/TC-4: rules live in the brain repo AND stay
 * loadable at `<cwd>/.claude/rules`, so a brain-only teammate still gets them.
 */
export function materializeRules(flowDir: string, projectRoot: string): string[] {
  const src = join(flowDir, 'rules');
  if (!existsSync(src)) return [];
  const dest = join(projectRoot, '.claude', 'rules');
  // MIRROR, not merge (review F2): in separate mode `<cwd>/.claude/rules` is a
  // pure materialization of the brain's `flow/rules/`, so a rule DELETED in the
  // brain must disappear here too — otherwise the SDK keeps loading a retired
  // rule forever. Wipe-then-copy is the mirror. We only reach this branch when
  // the brain HAS rules (`src` exists), so an empty source never wipes a
  // populated dest (that case returned `[]` above). Because dest is cleared
  // first, `written` below lists ONLY brain-sourced files (review F5).
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  const written: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (lstatSync(full).isDirectory()) walk(full);
      else written.push(relative(projectRoot, full));
    }
  };
  walk(dest);
  return written;
}

/**
 * Persists the share setting beside `autopilot` / `commit` / `push` / `pr`.
 * No-op (and returns false) when the file already says exactly this.
 */
export function persistShareMode(target: string, mode: ShareMode): boolean {
  if (readShareMode(target) === mode) return false;
  upsertFlowconfigKey(join(target, 'flow'), 'share', mode);
  return true;
}

/**
 * Resolves the mode a provision should generate with. Precedence:
 * explicit answer for this run → the project's persisted setting → local.
 * An existing project that never answered stays LOCAL — provisioning must
 * never publish someone's knowledge on their behalf.
 */
export function resolveShareMode(target: string, answer?: ShareMode): ShareMode {
  return answer ?? readShareMode(target) ?? DEFAULT_SHARE_MODE;
}

/**
 * Updates or creates .gitignore with plan-flow entries for `mode`.
 */
export function updateGitignore(
  target: string,
  platforms: Platform[],
  _options: CopyOptions,
  mode: ShareMode,
  pointer?: BrainPointer
): CopyResult {
  const result: CopyResult = { created: [], skipped: [], updated: [] };
  const gitignorePath = join(target, '.gitignore');
  // A `separate` regeneration that was not handed a pointer KEEPS the committed
  // one. Dropping it would be silent and load-bearing: the pointer is how a
  // re-provision knows `flow/` is a knowledge clone, so losing it turns the
  // next provision into a move of that clone — `.git` and all — into the vault.
  const effectivePointer =
    pointer ?? (mode === 'separate' ? readBrainPointer(target) ?? undefined : undefined);
  const block = buildGitignoreBlock(platforms, mode, effectivePointer);

  if (!existsSync(gitignorePath)) {
    // No .gitignore exists - create it with plan-flow entries
    writeFileSync(gitignorePath, block + '\n', 'utf-8');
    result.created.push(gitignorePath);
    log.success('Created .gitignore with plan-flow entries');
    return result;
  }

  const existing = readFileSync(gitignorePath, 'utf-8');

  if (existing.includes(MARKER_START)) {
    // The marker block is machine-owned, so keep it CURRENT even without --force:
    // a project provisioned before an entry existed (e.g. `graphify-out/`, #581)
    // would otherwise never receive it and the files show as untracked forever.
    // Reconcile only when the block actually drifted (else it's a no-op skip).
    const pattern = new RegExp(
      `${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}`
    );
    const currentBlock = pattern.exec(existing)?.[0] ?? '';
    if (currentBlock === block) {
      result.skipped.push(gitignorePath);
      log.skip('.gitignore already has current plan-flow entries');
    } else {
      const updated = existing.replace(pattern, block);
      writeFileSync(gitignorePath, updated, 'utf-8');
      result.updated.push(gitignorePath);
      log.warn('Updated plan-flow entries in .gitignore');
    }
  } else {
    // Append plan-flow section to existing .gitignore
    const appended = existing.trimEnd() + '\n\n' + block + '\n';
    writeFileSync(gitignorePath, appended, 'utf-8');
    result.updated.push(gitignorePath);
    log.success('Added plan-flow entries to .gitignore');
  }

  return result;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `.gitattributes` block for a SHARED project's append-only stores.
 *
 * Union merge means a merge keeps BOTH sides' lines instead of raising a
 * conflict — which is the correct semantic for an append-only store and the
 * wrong one for anything else, so the pattern is scoped to `flow/` rather than
 * the repo-wide `*.jsonl`: a user's own JSONL elsewhere may be a rewritten
 * document, and silently interleaving two versions of it would corrupt it.
 *
 * Union's cost is duplicate lines when both sides appended the same entry;
 * that is paid at READ time by the stores' dedupe, not by a merge driver.
 */
const GITATTRIBUTES_BLOCK = [
  MARKER_START,
  '# Append-only knowledge stores: a merge must keep BOTH sides\' entries, never',
  '# pick one. Identical entries are deduped when the store is read.',
  'flow/**/*.jsonl merge=union',
  MARKER_END,
].join('\n');

/** The generated `.gitattributes` block. Deterministic — same bytes, always. */
export function buildGitattributesBlock(): string {
  return GITATTRIBUTES_BLOCK;
}

/**
 * Create or reconcile the plan-flow `.gitattributes` block. Same marker
 * discipline as the `.gitignore` block: machine-owned inside the markers,
 * everything outside untouched, idempotent when already current.
 */
export function updateGitattributes(target: string): 'created' | 'updated' | 'unchanged' {
  const path = join(target, '.gitattributes');
  const block = buildGitattributesBlock();

  if (!existsSync(path)) {
    writeFileSync(path, block + '\n', 'utf-8');
    return 'created';
  }

  const existing = readFileSync(path, 'utf-8');
  if (!existing.includes(MARKER_START)) {
    writeFileSync(path, existing.trimEnd() + '\n\n' + block + '\n', 'utf-8');
    return 'updated';
  }

  const pattern = new RegExp(`${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}`);
  if ((pattern.exec(existing)?.[0] ?? '') === block) {
    return 'unchanged';
  }
  writeFileSync(path, existing.replace(pattern, block), 'utf-8');
  return 'updated';
}

// ── Auto-captured working sets inside a precious directory ──────────────────
// `flow/brain/features/` holds TWO different things: real features, and one
// auto-captured working set per CHAT THREAD (a `thread_id` frontmatter key, or
// a body opening "Working set for …"). Measured on a real project: 41 files,
// 26 features, 15 working sets, INTERLEAVED — no filename or directory tells
// them apart, only the content does.
//
// Under `shared` the working sets would be committed: one per thread, per
// person, forever. But the three obvious fixes each lose something real —
// ignoring the directory drops the precious layer; MOVING them to `.raw/`
// hides them from `brain:query`, which scans `features/` non-recursively;
// RENAMING them breaks compaction's merge-by-slug and rewrites files a person
// may have linked in Obsidian.
//
// So the ignore is expressed where git can be content-aware: a NESTED,
// SELF-IGNORING `.gitignore` inside the directory, regenerated from the files
// actually on disk. Nothing moves, nothing is renamed, the captures stay
// queryable, and the list itself is per-machine (it ignores itself, and the
// main block ignores it too).

const WORKING_SET_IGNORE_HEADER = [
  '# Generated by plan-flow. Auto-captured working sets — one per chat thread,',
  '# identified by a thread_id frontmatter key or a "Working set for …" body.',
  '# They live beside real features because that is where compaction promotes',
  '# them; they are personal session records, so they are not shared.',
  '# Regenerated on every share switch and migration. This file ignores itself.',
];

/** Detects an auto-captured working set. Mirrors `isWorkingSetCapture` in the
 *  feature store, which is the reader-side owner of the same rule. */
function looksLikeWorkingSet(raw: string): boolean {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (normalized.startsWith('---\n')) {
    const end = normalized.indexOf('\n---\n', 3);
    if (end !== -1) {
      const frontmatter = normalized.slice(4, end);
      if (frontmatter.split('\n').some((line) => line.trimStart().startsWith('thread_id:'))) {
        return true;
      }
    }
  }
  return /^\s*Working set for\b/m.test(normalized);
}

/**
 * Regenerate `flow/brain/features/.gitignore` from the files on disk.
 * Returns the names it listed. A directory with no working sets gets no file
 * (and an existing one is removed) — an empty generated file is just noise.
 */
export function updateWorkingSetIgnore(target: string): string[] {
  return updateWorkingSetIgnoreIn(join(target, 'flow', 'brain', 'features'));
}

/**
 * The same nested list, for a features directory named directly. A knowledge
 * repo is assembled in a staging directory before it becomes `flow/`, so its
 * writer cannot address it through a project root. One rule, two doors.
 */
export function updateWorkingSetIgnoreIn(featuresDir: string): string[] {
  const ignorePath = join(featuresDir, '.gitignore');
  if (!existsSync(featuresDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(featuresDir).sort();
  } catch {
    return [];
  }

  const captures: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    try {
      if (looksLikeWorkingSet(readFileSync(join(featuresDir, entry), 'utf-8'))) {
        captures.push(entry);
      }
    } catch {
      // Sanctioned fail-soft: unreadable file — never guess it is personal.
    }
  }

  if (captures.length === 0) {
    if (existsSync(ignorePath)) {
      try {
        unlinkSync(ignorePath);
      } catch {
        // Sanctioned fail-soft: a stale list is harmless, it only over-ignores.
      }
    }
    return [];
  }

  const content = [...WORKING_SET_IGNORE_HEADER, '.gitignore', ...captures].join('\n') + '\n';
  if (!existsSync(ignorePath) || readFileSync(ignorePath, 'utf-8') !== content) {
    writeFileSync(ignorePath, content, 'utf-8');
  }
  return captures;
}

/** What a share switch did — what changed, and what it changed for the repo. */
export interface ShareSwitchReport {
  /** The mode the project was in before (resolved; unanswered reads as local). */
  previous: ShareMode;
  /** The mode it is in now. */
  mode: ShareMode;
  /** False when the requested mode was already the current one. */
  changed: boolean;
  /** Existing files that were ignored before and are tracked now (repo-relative). */
  nowTrackable: string[];
  /** Existing files that were tracked before and are ignored now (repo-relative). */
  nowIgnored: string[];
  /** What happened to `.gitignore`. */
  gitignore: 'created' | 'updated' | 'unchanged';
  /** What happened to `.gitattributes` (shared mode only; `unchanged` in local). */
  gitattributes: 'created' | 'updated' | 'unchanged';
  /** Auto-captured working sets kept out of git by the nested ignore file. */
  workingSetsIgnored: string[];
}

/**
 * Whether `relPath` (repo-relative, POSIX) is covered by one of `entries`.
 *
 * A deliberately small subset of gitignore semantics — enough for the entries
 * this generator emits and nothing more: a leading `/` is a root anchor (all of
 * ours are effectively root-relative), a trailing `/` marks a directory, and a
 * match is the path itself or anything beneath it. No globs, because none of
 * the knowledge entries use one.
 */
function isIgnoredBy(entries: readonly string[], relPath: string): boolean {
  return entries.some((raw) => {
    const entry = (raw.startsWith('/') ? raw.slice(1) : raw).replace(/\/+$/, '');
    return relPath === entry || relPath.startsWith(`${entry}/`);
  });
}

/** Hard cap on the switch-report walk — a report is never worth a hang. */
const SHARE_REPORT_FILE_CAP = 20_000;

/** Repo-relative POSIX paths of the files under `flow/` (symlink followed). */
function listKnowledgeFiles(target: string): string[] {
  const files: string[] = [];
  const root = join(target, 'flow');
  if (!existsSync(root)) return files;

  const walk = (dir: string, prefix: string): void => {
    if (files.length >= SHARE_REPORT_FILE_CAP) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir — the report degrades, it never throws
    }
    for (const entry of entries) {
      if (entry === '.git') continue;
      const rel = `${prefix}${entry}`;
      let isDir = false;
      try {
        isDir = statSync(join(dir, entry)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(join(dir, entry), `${rel}/`);
      } else {
        files.push(rel);
        if (files.length >= SHARE_REPORT_FILE_CAP) return;
      }
    }
  };

  walk(root, 'flow/');
  return files.sort();
}

/** Why a share-mode switch was refused. */
export type ShareModeRefusalReason = 'knowledge-repo';

/**
 * A share-mode switch that would undo something only knowledge sync may undo.
 * `sentence` is what a person reads — no command, path or key in it.
 */
export class ShareModeRefusal extends Error {
  readonly reason: ShareModeRefusalReason;
  readonly sentence: string;

  constructor(reason: ShareModeRefusalReason, sentence: string) {
    super(`${reason} — ${sentence}`);
    this.name = 'ShareModeRefusal';
    this.reason = reason;
    this.sentence = sentence;
  }
}

/**
 * Switch this project between `local` and `shared` — the mechanism behind
 * `/flow share=<mode>`.
 *
 * Persists the setting, regenerates the marker block from it, and reports which
 * EXISTING files changed tracking status in each direction. It only ever
 * changes which paths are ignored: no file is moved, rewritten or deleted, so
 * switching back is always safe.
 *
 * REFUSES, before writing anything, to leave `separate` on a project that keeps
 * its knowledge in its own repo: regenerating the block without the pointer
 * would silently cut every fresh clone off from its knowledge. Turning sync off
 * is the one door out of that shape.
 */
export function applyShareMode(
  target: string,
  mode: ShareMode,
  platforms: Platform[] = ['claude']
): ShareSwitchReport {
  if (mode !== 'separate' && (keepsOwnKnowledgeRepo(target) || holdsOwnRepo(join(target, 'flow')))) {
    throw new ShareModeRefusal(
      'knowledge-repo',
      `this project keeps its knowledge in its own repository, so it can't be switched to ${mode} here — turn knowledge sync off in the project's Flow settings first`
    );
  }
  const previous = resolveShareMode(target);
  const before = sharedGitignoreEntries(previous);
  const after = sharedGitignoreEntries(mode);

  persistShareMode(target, mode);
  const copy = updateGitignore(target, platforms, { force: false }, mode);

  // Regenerate the nested working-set list BEFORE the report is computed, so a
  // personal capture is never announced as "now trackable".
  const workingSetsIgnored = mode === 'shared' ? updateWorkingSetIgnore(target) : [];
  const workingSetPaths = new Set(workingSetsIgnored.map((name) => `flow/brain/features/${name}`));

  const nowTrackable: string[] = [];
  const nowIgnored: string[] = [];
  if (previous !== mode) {
    for (const file of listKnowledgeFiles(target)) {
      if (workingSetPaths.has(file)) continue;
      const wasIgnored = isIgnoredBy(before, file);
      const isIgnored = isIgnoredBy(after, file);
      if (wasIgnored && !isIgnored) nowTrackable.push(file);
      else if (!wasIgnored && isIgnored) nowIgnored.push(file);
    }
  }

  const gitignore = copy.created.length > 0
    ? 'created'
    : copy.updated.length > 0
      ? 'updated'
      : 'unchanged';

  // Only a shared project tracks the append-only stores, so only a shared
  // project needs the union-merge rule. Switching back leaves the block in
  // place: it is inert when nothing under flow/ is tracked, and removing it
  // would churn the file on every round trip.
  const gitattributes = mode === 'shared' ? updateGitattributes(target) : 'unchanged';

  return {
    previous,
    mode,
    changed: previous !== mode,
    nowTrackable,
    nowIgnored,
    gitignore,
    gitattributes,
    workingSetsIgnored,
  };
}

// ── Tailwind v4 source-scan mitigation (#644) ─────────────────────────────
// Tailwind v4 (`@import "tailwindcss"` + @tailwindcss/postcss) auto-scans the
// project root for source files and FOLLOWS symlinks. plan-flow's root symlinks
// — `flow/` (points OUTSIDE the repo, into the central vault) and `graphify-out/`
// — make Tailwind resolve a relative path that escapes the filesystem root
// (`../../../plan-flow/...`), which panics Turbopack's PostCSS path resolver and
// breaks `next dev`/`next build`. `.gitignore` doesn't prevent the crash (the
// traversal happens during scanning); Tailwind's own `@source not` directive
// does. So when we detect a Tailwind v4 entry stylesheet, we append an idempotent
// marker block excluding those artifacts — committed, so it survives the symlinks
// being recreated on the next `plan-flow init`.
const TAILWIND_MARKER_START = '/* >>> plan-flow: exclude plan-flow artifacts from Tailwind source scan (#644) */';
const TAILWIND_MARKER_END = '/* <<< plan-flow */';

/** Common Tailwind v4 entry stylesheet locations (Next.js app/pages, Vite). */
const TAILWIND_ENTRY_CANDIDATES = [
  'src/app/globals.css',
  'app/globals.css',
  'src/styles/globals.css',
  'styles/globals.css',
  'src/app/global.css',
  'app/global.css',
  'src/index.css',
  'src/main.css',
  'src/styles.css',
  'src/style.css',
];

/** The `@import "tailwindcss"` line is the Tailwind v4 signal that triggers the
 *  auto source scan (and the crash). Single/double quotes, optional `.css`. */
const TAILWIND_V4_IMPORT = /@import\s+["']tailwindcss(?:\.css)?["']/;

/** Forward-slash a path so the CSS `@source` glob is POSIX-style on all OSes. */
function toPosixPath(p: string): string {
  return p.split('\\').join('/');
}

/** The exclusion block for a specific entry CSS file — `@source not` paths are
 *  relative to the CSS file, so compute each from the file's own directory. */
function buildTailwindBlock(cssFile: string, target: string): string {
  const dir = dirname(cssFile);
  const relFlow = toPosixPath(relative(dir, join(target, 'flow'))) || './flow';
  const relGraphify = toPosixPath(relative(dir, join(target, 'graphify-out'))) || './graphify-out';
  return [
    TAILWIND_MARKER_START,
    `@source not '${relFlow}';`,
    `@source not '${relGraphify}';`,
    TAILWIND_MARKER_END,
  ].join('\n');
}

/**
 * Append (or reconcile) the Tailwind `@source not` exclusion block into the
 * project's Tailwind v4 entry stylesheet (#644). Only touches a file that
 * actually imports tailwindcss; idempotent (skip when current, reconcile on
 * drift, like the .gitignore block). Non-Tailwind projects are a no-op.
 */
export function mitigateTailwindSources(target: string, _options: CopyOptions): CopyResult {
  const result: CopyResult = { created: [], skipped: [], updated: [] };
  for (const rel of TAILWIND_ENTRY_CANDIDATES) {
    const cssFile = join(target, rel);
    if (!existsSync(cssFile)) continue;
    let content: string;
    try {
      content = readFileSync(cssFile, 'utf-8');
    } catch {
      continue;
    }
    if (!TAILWIND_V4_IMPORT.test(content)) continue; // not a Tailwind v4 entry
    const block = buildTailwindBlock(cssFile, target);

    if (content.includes(TAILWIND_MARKER_START)) {
      const pattern = new RegExp(
        `${escapeRegExp(TAILWIND_MARKER_START)}[\\s\\S]*?${escapeRegExp(TAILWIND_MARKER_END)}`
      );
      const current = pattern.exec(content)?.[0] ?? '';
      if (current === block) {
        result.skipped.push(cssFile);
      } else {
        writeFileSync(cssFile, content.replace(pattern, block), 'utf-8');
        result.updated.push(cssFile);
        log.warn(`Reconciled plan-flow Tailwind source exclusions in ${rel}`);
      }
    } else {
      writeFileSync(cssFile, content.trimEnd() + '\n\n' + block + '\n', 'utf-8');
      result.created.push(cssFile);
      log.success(`Excluded plan-flow artifacts from Tailwind source scanning (${rel})`);
    }
  }
  return result;
}

const VAULT_SUBDIRS = ['patterns', 'projects', 'notes', 'learns'];

/**
 * Maps detected stack values (lowercase) to brain pattern file names (without .md).
 * Keys are matched against detected language, framework label, and dependency names.
 */
const STACK_TO_PATTERN: Record<string, string> = {
  // Languages
  'typescript': 'typescript',
  'javascript': 'typescript',
  'python': 'python',
  'rust': 'rust',
  'go': 'go',
  'ruby': 'ruby',
  'c#': 'csharp',
  'java': 'java',
  // Frameworks
  'next.js': 'nextjs',
  'react': 'react',
  'react native': 'react-native',
  'vue': 'vue',
  'vue.js': 'vue',
  'nuxt': 'nuxt',
  'angular': 'angular',
  'svelte': 'svelte',
  'express': 'express',
  'fastify': 'fastify',
  'hono': 'hono',
  'nestjs': 'nestjs',
  'fastapi': 'fastapi',
  'django': 'django',
  'flask': 'flask',
  'remix': 'remix',
  'gatsby': 'gatsby',
  'astro': 'astro',
  'solidjs': 'solidjs',
  'starlette': 'starlette',
  // Libraries
  'langchain': 'langchain',
  'langgraph': 'langgraph',
  'prisma': 'prisma',
  'drizzle-orm': 'drizzle',
  'tailwindcss': 'tailwind',
  'zustand': 'zustand',
  'redux': 'redux',
  'expo': 'react-native',
};

/**
 * Old per-subdirectory symlink names that were previously created in the vault project dir.
 * These are no longer needed since flow/ is now a single symlink to the brain.
 * Kept here for cleanup of existing installations.
 */
const OLD_VAULT_LINKS = [
  'features', 'errors', 'discovery', 'plans', 'archive',
  'contracts', 'reviewed-code', 'reviewed-pr', 'references', 'resources',
  'tasklist.md', 'memory.md', 'heartbeat.md', 'log.md', 'ledger.md',
  'brainstorms',
];

/**
 * Cleans broken symlinks and old-format single symlinks from the vault projects/ dir.
 * Old format: projects/{name} → /path/flow (single symlink to entire flow/).
 * New format: projects/{name}/ is a real directory with individual symlinks inside.
 */
function cleanBrokenSymlinks(vaultDir: string): void {
  const projectsDir = join(vaultDir, 'projects');
  if (!existsSync(projectsDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(projectsDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Could not read vault projects dir (non-fatal): ${projectsDir} — ${msg}`);
    return;
  }

  const indexPath = join(vaultDir, 'index.md');
  let indexContent = existsSync(indexPath) ? readFileSync(indexPath, 'utf-8') : null;
  let indexModified = false;

  for (const entry of entries) {
    const entryPath = join(projectsDir, entry);
    let shouldRemove = false;

    try {
      const stat = lstatSync(entryPath);

      if (stat.isSymbolicLink()) {
        // Old-format single symlink or broken symlink — remove it
        shouldRemove = true;
      }
    } catch (err) {
      // Can't stat — broken entry, remove it
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Could not stat vault entry (removing): ${entryPath} — ${msg}`);
      shouldRemove = true;
    }

    if (shouldRemove) {
      try {
        unlinkSync(entryPath);
      } catch {
        try {
          rmSync(entryPath, { force: true });
        } catch (err) {
          // Can't remove — skip
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`Could not remove stale vault entry (non-fatal): ${entryPath} — ${msg}`);
          continue;
        }
      }

      // Remove corresponding index.md entry
      if (indexContent) {
        const pattern = new RegExp(`^- \\[\\[${escapeRegExp(entry)}\\]\\].*\\n?`, 'gm');
        const cleaned = indexContent.replace(pattern, '');
        if (cleaned !== indexContent) {
          indexContent = cleaned;
          indexModified = true;
        }
      }
    }
  }

  if (indexModified && indexContent) {
    // Clean up any double blank lines left behind
    indexContent = indexContent.replace(/\n{3,}/g, '\n\n');
    writeFileSync(indexPath, indexContent, 'utf-8');
  }
}

/**
 * Updates the global vault index at ~/plan-flow/brain/index.md
 * with the project entry.
 */
function updateVaultIndex(vaultDir: string, projectName: string, target: string): void {
  const indexPath = join(vaultDir, 'index.md');

  if (!existsSync(indexPath)) {
    const content = [
      '# Plan-Flow Vault',
      '',
      'Central knowledge vault — orchestration hub for all projects.',
      '',
      '## Dashboard',
      '',
      '| View | Description |',
      '|------|-------------|',
      '| [[tasklist]] | Tasks across all projects — backlog, in-progress, done |',
      '| [[memory]] | Recent skill completions across all projects |',
      '| [[heartbeat]] | Scheduled automations across all projects |',
      '| [[ledger]] | Learnings and project quirks across all projects |',
      '',
      '## Projects',
      '',
      `- [[${projectName}]] — \`${resolve(target)}\``,
      '',
    ].join('\n');
    writeFileSync(indexPath, content, 'utf-8');
    return;
  }

  // Ensure Dashboard section exists in legacy index files
  const existingContent = readFileSync(indexPath, 'utf-8');
  if (!existingContent.includes('## Dashboard')) {
    const dashboardSection = [
      '',
      '## Dashboard',
      '',
      '| View | Description |',
      '|------|-------------|',
      '| [[tasklist]] | Tasks across all projects — backlog, in-progress, done |',
      '| [[memory]] | Recent skill completions across all projects |',
      '| [[heartbeat]] | Scheduled automations across all projects |',
      '| [[ledger]] | Learnings and project quirks across all projects |',
      '',
    ].join('\n');
    const updatedContent = existingContent.replace('## Projects', dashboardSection + '## Projects');
    writeFileSync(indexPath, updatedContent, 'utf-8');
  }

  const existing = readFileSync(indexPath, 'utf-8');
  const projectLink = `[[${projectName}]]`;

  // Already listed
  if (existing.includes(projectLink)) return;

  // Append to Projects section
  const entry = `- [[${projectName}]] — \`${resolve(target)}\``;
  const updated = existing.trimEnd() + '\n' + entry + '\n';
  writeFileSync(indexPath, updated, 'utf-8');
}

/**
 * Creates the .obsidian/ config in the vault with pre-configured
 * graph color groups using path-based queries.
 * Pass force=true to regenerate the config even if it exists.
 */
function ensureObsidianConfig(vaultDir: string, force = false): void {
  const obsidianDir = join(vaultDir, '.obsidian');
  const graphPath = join(obsidianDir, 'graph.json');

  // Don't overwrite existing config unless forced
  if (existsSync(graphPath) && !force) return;

  ensureDir(obsidianDir);

  const graphConfig = {
    'collapse-filter': true,
    'showTags': false,
    'showAttachments': false,
    'showOrphans': true,
    'collapse-color': false,
    'colorGroups': [
      { query: 'path:patterns', color: { a: 1, rgb: 16771584 } },       // yellow
      { query: 'path:features', color: { a: 1, rgb: 10040217 } },       // purple
      { query: 'path:errors', color: { a: 1, rgb: 16007990 } },         // red
      { query: 'path:notes', color: { a: 1, rgb: 10395294 } },           // gray
      { query: 'path:discovery', color: { a: 1, rgb: 16747520 } },      // orange
      { query: 'path:plans', color: { a: 1, rgb: 5025616 } },           // green
      { query: 'path:contracts', color: { a: 1, rgb: 52428 } },         // teal
      { query: 'path:archive', color: { a: 1, rgb: 8421504 } },         // dark gray
      { query: 'path:reviewed-code', color: { a: 1, rgb: 16761035 } },  // pink
      { query: 'path:reviewed-pr', color: { a: 1, rgb: 14381056 } },    // coral
      { query: 'path:references', color: { a: 1, rgb: 9868950 } },      // sage
      { query: 'path:resources', color: { a: 1, rgb: 6724044 } },       // olive
      { query: 'path:learns', color: { a: 1, rgb: 3381759 } },          // blue
    ],
    'collapse-display': true,
    'collapse-forces': false,
    'search': '',
    'showArrow': false,
    'textFadeMultiplier': 0,
    'nodeSizeMultiplier': 1,
    'lineSizeMultiplier': 1,
    'centerStrength': 0.518713,
    'repelStrength': 10,
    'linkStrength': 1,
    'linkDistance': 250,
    'scale': 1,
    'close': true,
  };

  writeFileSync(graphPath, JSON.stringify(graphConfig, null, 2), 'utf-8');
}

/**
 * Detects the project's stack and returns matching brain pattern names
 * that exist in ~/plan-flow/brain/patterns/.
 */
function detectMatchingPatterns(target: string, vaultDir: string): string[] {
  const patternsDir = join(vaultDir, 'patterns');
  if (!existsSync(patternsDir)) return [];

  // Get available pattern files (without .md extension)
  let availablePatterns: Set<string>;
  try {
    availablePatterns = new Set(
      readdirSync(patternsDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace(/\.md$/, ''))
    );
  } catch {
    return [];
  }

  if (availablePatterns.size === 0) return [];

  // Collect stack identifiers from the project
  const stackKeys: string[] = [];

  const pkgParsed = parsePackageJson(target);
  if (pkgParsed) {
    stackKeys.push(pkgParsed.language.toLowerCase());
    if (pkgParsed.framework !== 'None') {
      // Extract framework label without version: "Next.js 14.2.0" → "next.js"
      const fwLabel = pkgParsed.framework.replace(/\s+[\d.]+$/, '').toLowerCase();
      stackKeys.push(fwLabel);
    }
    // Add dependency names for library-level matching
    for (const dep of [...pkgParsed.prodDeps, ...pkgParsed.devDeps]) {
      stackKeys.push(dep.name.toLowerCase());
    }
  }

  const pyParsed = parsePyprojectToml(target);
  if (pyParsed) {
    stackKeys.push(pyParsed.language.toLowerCase());
    if (pyParsed.framework !== 'None') {
      stackKeys.push(pyParsed.framework.toLowerCase());
    }
    for (const dep of pyParsed.prodDeps) {
      stackKeys.push(dep.name.toLowerCase());
    }
  }

  // Also check for other language indicators
  for (const depFile of DEP_FILES) {
    if (existsSync(join(target, depFile.file))) {
      stackKeys.push(depFile.language.toLowerCase());
    }
  }

  // Check for React Native (expo or react-native dep)
  if (stackKeys.includes('react-native') || stackKeys.includes('expo')) {
    stackKeys.push('react native');
  }

  // Match stack keys against pattern map, then filter by available patterns
  const matched = new Set<string>();
  for (const key of stackKeys) {
    const patternName = STACK_TO_PATTERN[key];
    if (patternName && availablePatterns.has(patternName)) {
      matched.add(patternName);
    }
  }

  // Also include global patterns that always apply (e.g., global-rules, engineering)
  const alwaysLink = ['global-rules', 'engineering'];
  for (const p of alwaysLink) {
    if (availablePatterns.has(p)) {
      matched.add(p);
    }
  }

  return [...matched];
}

/**
 * Registers the project in the central vault at ~/plan-flow/brain/
 * by creating a real directory per project with individual symlinks
 * for each flow subdirectory (features, errors,
 * discovery, plans, archive, contracts).
 */
function registerVault(
  target: string,
  options: CopyOptions
): CopyResult {
  const result: CopyResult = { created: [], skipped: [], updated: [] };
  const vaultDir = getVaultDir();
  const projectName = getProjectName(target);
  const projectDir = join(vaultDir, 'projects', projectName);

  try {
    // Create vault structure if it doesn't exist
    ensureDir(vaultDir);
    for (const sub of VAULT_SUBDIRS) {
      ensureDir(join(vaultDir, sub));
    }

    // Clean broken/old-format symlinks
    cleanBrokenSymlinks(vaultDir);

    // Set up Obsidian config with graph color groups
    ensureObsidianConfig(vaultDir, options.force);

    // Create real project directory
    ensureDir(projectDir);

    // Clean old per-subdirectory symlinks that are no longer needed
    // (flow/ is now a single symlink from project → brain)
    let cleanedCount = 0;
    for (const name of OLD_VAULT_LINKS) {
      const linkPath = join(projectDir, name);
      if (isSymlink(linkPath)) {
        unlinkSync(linkPath);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      log.success(`Cleaned ${cleanedCount} old vault symlink(s) for ${projectName}`);
    }

    // Detect matching brain patterns for this project's stack
    const matchedPatterns = detectMatchingPatterns(target, vaultDir);

    // Create project index file (the project node in Obsidian's graph)
    const projectIndexPath = join(projectDir, `${projectName}.md`);
    if (!existsSync(projectIndexPath) || options.force) {
      const indexLines = [
        `# [[${projectName}]]`,
        '',
        `**Path**: \`${resolve(target)}\``,
      ];

      if (matchedPatterns.length > 0) {
        indexLines.push('');
        indexLines.push('## Patterns');
        indexLines.push('');
        for (const pattern of matchedPatterns) {
          indexLines.push(`- [[${pattern}]]`);
        }
      }

      indexLines.push('');
      writeFileSync(projectIndexPath, indexLines.join('\n'), 'utf-8');

      if (matchedPatterns.length > 0) {
        log.success(`Linked ${matchedPatterns.length} brain pattern(s): ${matchedPatterns.join(', ')}`);
      }
    } else {
      // File exists — check if we need to add/update pattern links
      const existing = readFileSync(projectIndexPath, 'utf-8');
      if (matchedPatterns.length > 0 && !existing.includes('## Patterns')) {
        const patternSection = [
          '',
          '## Patterns',
          '',
          ...matchedPatterns.map((p) => `- [[${p}]]`),
          '',
        ].join('\n');
        writeFileSync(projectIndexPath, existing.trimEnd() + '\n' + patternSection, 'utf-8');
        result.updated.push(projectIndexPath);
        log.success(`Linked ${matchedPatterns.length} brain pattern(s): ${matchedPatterns.join(', ')}`);
      }
    }

    log.success(`Registered vault project: ${projectName}`);

    // Update vault index
    updateVaultIndex(vaultDir, projectName, target);

    // Generate/update global aggregation files
    generateGlobalTasklist(vaultDir);
    generateGlobalMemory(vaultDir);
    generateGlobalHeartbeat(vaultDir);
    generateGlobalLedger(vaultDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Could not register vault (non-fatal): ${msg}`);
  }

  return result;
}

/**
 * Generates or updates ~/plan-flow/brain/tasklist.md — a global aggregator
 * that links to each project's tasklist for a cross-project overview.
 */
function generateGlobalTasklist(vaultDir: string): void {
  const globalTasklistPath = join(vaultDir, 'tasklist.md');
  const projectsDir = join(vaultDir, 'projects');

  if (!existsSync(projectsDir)) return;

  // Scan all project directories for tasklist.md symlinks
  const projects: { name: string; tasklistPath: string }[] = [];
  try {
    const entries = readdirSync(projectsDir);
    for (const entry of entries) {
      const entryPath = join(projectsDir, entry);
      const tasklistLink = join(entryPath, 'tasklist.md');
      if (existsSync(tasklistLink)) {
        projects.push({ name: entry, tasklistPath: tasklistLink });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Could not scan vault projects dir (non-fatal): ${projectsDir} — ${msg}`);
    return;
  }

  // Count tasks per project by reading each tasklist
  const projectSummaries: string[] = [];
  for (const project of projects) {
    try {
      const content = readFileSync(project.tasklistPath, 'utf-8');

      // Count tasks in each section properly
      const sections = content.split(/^## /m);
      let inProgressCount = 0;
      let backlogCount = 0;
      let toDoCount = 0;
      let doneCount = 0;
      for (const section of sections) {
        const lines = (section.match(/^- \[[ x]\] .+/gm) || []).length;
        if (section.startsWith('In Progress')) inProgressCount = lines;
        else if (section.startsWith('Backlog')) backlogCount = lines;
        else if (section.startsWith('To Do')) toDoCount = lines;
        else if (section.startsWith('Done')) doneCount = lines;
      }

      const summaryRows = [
        `| In Progress | ${inProgressCount} |`,
        ...(backlogCount > 0 ? [`| Backlog | ${backlogCount} |`] : []),
        `| To Do | ${toDoCount} |`,
        `| Done | ${doneCount} |`,
      ];

      projectSummaries.push(
        `### [[${project.name}]]`,
        '',
        `| Status | Count |`,
        `|--------|-------|`,
        ...summaryRows,
        '',
        `> See: [[${project.name}/tasklist.md|Full Tasklist]]`,
        '',
      );
    } catch {
      projectSummaries.push(
        `### [[${project.name}]]`,
        '',
        `_Tasklist not accessible_`,
        '',
      );
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const content = [
    '# Global Tasklist',
    '',
    `**Last Updated**: ${today}`,
    `**Projects**: ${projects.length}`,
    '',
    '---',
    '',
    ...(projectSummaries.length > 0
      ? projectSummaries
      : ['_No projects with tasklists found._', '']),
  ].join('\n');

  writeFileSync(globalTasklistPath, content, 'utf-8');
}

/**
 * Generates or updates ~/plan-flow/brain/memory.md — a global aggregator
 * that shows recent skill completions across all projects.
 */
function generateGlobalMemory(vaultDir: string): void {
  const globalMemoryPath = join(vaultDir, 'memory.md');
  const projectsDir = join(vaultDir, 'projects');

  if (!existsSync(projectsDir)) return;

  const projects: { name: string; memoryPath: string }[] = [];
  try {
    const entries = readdirSync(projectsDir);
    for (const entry of entries) {
      const memoryLink = join(projectsDir, entry, 'memory.md');
      if (existsSync(memoryLink)) {
        projects.push({ name: entry, memoryPath: memoryLink });
      }
    }
  } catch {
    return;
  }

  const projectSummaries: string[] = [];
  for (const project of projects) {
    try {
      const content = readFileSync(project.memoryPath, 'utf-8');
      // Count table rows (lines starting with | that are not headers or separators)
      const tableRows = (content.match(/^\| \d{4}-/gm) || []).length;
      // Extract last 5 entries for preview
      const rows = content.split('\n').filter((l) => /^\| \d{4}-/.test(l));
      const recentRows = rows.slice(0, 5);

      projectSummaries.push(
        `### [[${project.name}]]`,
        '',
        `**Total entries**: ${tableRows}`,
        '',
      );

      if (recentRows.length > 0) {
        projectSummaries.push(
          '| Date | Skill | Feature | Summary |',
          '|------|-------|---------|---------|',
        );
        for (const row of recentRows) {
          // Extract Date, Skill, Feature, and Summary columns (skip Artifact)
          const cols = row.split('|').map((c) => c.trim()).filter(Boolean);
          if (cols.length >= 5) {
            projectSummaries.push(`| ${cols[0]} | ${cols[1]} | ${cols[2]} | ${cols[4]} |`);
          } else if (cols.length >= 4) {
            projectSummaries.push(`| ${cols[0]} | ${cols[1]} | ${cols[2]} | ${cols[3]} |`);
          }
        }
        projectSummaries.push('');
      }

      projectSummaries.push(
        `> See: [[${project.name}/memory.md|Full Memory]]`,
        '',
      );
    } catch {
      projectSummaries.push(
        `### [[${project.name}]]`,
        '',
        '_Memory not accessible_',
        '',
      );
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const output = [
    '# Global Memory',
    '',
    `**Last Updated**: ${today}`,
    `**Projects**: ${projects.length}`,
    '',
    '---',
    '',
    ...(projectSummaries.length > 0
      ? projectSummaries
      : ['_No projects with memory files found._', '']),
  ].join('\n');

  writeFileSync(globalMemoryPath, output, 'utf-8');
}

/**
 * Generates or updates ~/plan-flow/brain/heartbeat.md — a global aggregator
 * that shows all scheduled tasks across all projects.
 */
function generateGlobalHeartbeat(vaultDir: string): void {
  const globalHeartbeatPath = join(vaultDir, 'heartbeat.md');
  const projectsDir = join(vaultDir, 'projects');

  if (!existsSync(projectsDir)) return;

  const projects: { name: string; heartbeatPath: string }[] = [];
  try {
    const entries = readdirSync(projectsDir);
    for (const entry of entries) {
      const heartbeatLink = join(projectsDir, entry, 'heartbeat.md');
      if (existsSync(heartbeatLink)) {
        projects.push({ name: entry, heartbeatPath: heartbeatLink });
      }
    }
  } catch {
    return;
  }

  const projectSummaries: string[] = [];
  for (const project of projects) {
    try {
      const content = readFileSync(project.heartbeatPath, 'utf-8');
      // Parse task blocks (### headings under ## Tasks)
      const taskBlocks = content.split(/^### /m).slice(1);
      let enabledCount = 0;
      let disabledCount = 0;
      const taskLines: string[] = [];

      for (const block of taskBlocks) {
        const nameMatch = block.match(/^(.+)/);
        const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
        const scheduleMatch = block.match(/\*\*Schedule\*\*:\s*(.+)/);
        const enabledMatch = block.match(/\*\*Enabled\*\*:\s*(true|false)/);
        const schedule = scheduleMatch ? scheduleMatch[1].trim() : '—';
        const enabled = enabledMatch ? enabledMatch[1].trim() === 'true' : false;

        if (enabled) enabledCount++;
        else disabledCount++;

        taskLines.push(`| ${name} | ${schedule} | ${enabled ? 'Active' : 'Disabled'} |`);
      }

      projectSummaries.push(
        `### [[${project.name}]]`,
        '',
        `**Active**: ${enabledCount} | **Disabled**: ${disabledCount}`,
        '',
      );

      if (taskLines.length > 0) {
        projectSummaries.push(
          '| Task | Schedule | Status |',
          '|------|----------|--------|',
          ...taskLines,
          '',
        );
      }

      projectSummaries.push(
        `> See: [[${project.name}/heartbeat.md|Full Heartbeat]]`,
        '',
      );
    } catch {
      projectSummaries.push(
        `### [[${project.name}]]`,
        '',
        '_Heartbeat not accessible_',
        '',
      );
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const output = [
    '# Global Heartbeat',
    '',
    `**Last Updated**: ${today}`,
    `**Projects**: ${projects.length}`,
    '',
    '---',
    '',
    ...(projectSummaries.length > 0
      ? projectSummaries
      : ['_No projects with heartbeat files found._', '']),
  ].join('\n');

  writeFileSync(globalHeartbeatPath, output, 'utf-8');
}

/**
 * Generates or updates ~/plan-flow/brain/ledger.md — a global aggregator
 * that shows learnings and project quirks across all projects.
 */
function generateGlobalLedger(vaultDir: string): void {
  const globalLedgerPath = join(vaultDir, 'ledger.md');
  const projectsDir = join(vaultDir, 'projects');

  if (!existsSync(projectsDir)) return;

  const projects: { name: string; ledgerPath: string }[] = [];
  try {
    const entries = readdirSync(projectsDir);
    for (const entry of entries) {
      const ledgerLink = join(projectsDir, entry, 'ledger.md');
      if (existsSync(ledgerLink)) {
        projects.push({ name: entry, ledgerPath: ledgerLink });
      }
    }
  } catch {
    return;
  }

  const projectSummaries: string[] = [];
  for (const project of projects) {
    try {
      const content = readFileSync(project.ledgerPath, 'utf-8');
      // Count entries per section
      const sections = content.split(/^## /m).slice(1);
      const sectionCounts: string[] = [];

      for (const section of sections) {
        const titleMatch = section.match(/^(.+)/);
        const title = titleMatch ? titleMatch[1].trim() : 'Unknown';
        // Count bullet entries (lines starting with -)
        const entries = (section.match(/^- .+/gm) || []).length;
        if (entries > 0) {
          sectionCounts.push(`| ${title} | ${entries} |`);
        }
      }

      projectSummaries.push(
        `### [[${project.name}]]`,
        '',
      );

      if (sectionCounts.length > 0) {
        projectSummaries.push(
          '| Section | Entries |',
          '|---------|---------|',
          ...sectionCounts,
          '',
        );
      } else {
        projectSummaries.push('_No learnings recorded yet._', '');
      }

      projectSummaries.push(
        `> See: [[${project.name}/ledger.md|Full Ledger]]`,
        '',
      );
    } catch {
      projectSummaries.push(
        `### [[${project.name}]]`,
        '',
        '_Ledger not accessible_',
        '',
      );
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const output = [
    '# Global Ledger',
    '',
    `**Last Updated**: ${today}`,
    `**Projects**: ${projects.length}`,
    '',
    '---',
    '',
    ...(projectSummaries.length > 0
      ? projectSummaries
      : ['_No projects with ledger files found._', '']),
  ].join('\n');

  writeFileSync(globalLedgerPath, output, 'utf-8');
}

/**
 * Extracts a feature name from a plan-flow artifact filename.
 * e.g., "plan_user_auth_v1.md" → "user-auth"
 *       "discovery_dark_mode_v2.md" → "dark-mode"
 */
function extractFeatureName(filename: string): string | null {
  // Match plan_<name>_v<n>.md or discovery_<name>_v<n>.md
  const match = filename.match(/^(?:plan|discovery)_(.+?)_v\d+\.md$/);
  if (!match) return null;
  return match[1].replace(/_/g, '-');
}

/**
 * Reads the first heading from a markdown file.
 */
function extractTitle(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^#\s+(.+)$/m);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * Creates a brain feature entry for a legacy artifact.
 */
function createBrainFeatureEntry(
  brainDir: string,
  featureName: string,
  artifacts: { path: string; type: string; title: string }[],
  status: string,
  projectName: string
): string | null {
  const featureFile = join(brainDir, 'features', `${featureName}.md`);

  if (existsSync(featureFile)) return null; // Already exists

  const today = new Date().toISOString().slice(0, 10);
  const links = artifacts
    .map((a) => `- ${a.type}: [[${a.path.replace(/\.md$/, '').split('/').pop()}]]`)
    .join('\n');

  // A Workspace project's notes say who wrote them (FR-19); elsewhere no change.
  const author = workspaceAuthor(dirname(brainDir));
  const content = [
    '---',
    `status: ${status}`,
    `created: ${today}`,
    ...(author === null ? [] : [`author: ${author}`]),
    '---',
    '',
    `# [[${featureName}]]`,
    '',
    `**Project**: [[${projectName}]]`,
    `**Status**: ${status}`,
    `**Created**: ${today}`,
    `**Last Updated**: ${today}`,
    '',
    '## Links',
    '',
    links,
    '',
    '## Timeline',
    '',
    `### ${today} - legacy-scan`,
    '- **Prompt**: Discovered during plan-flow init',
    `- **Outcome**: Found ${artifacts.length} existing artifact(s)`,
    '- **Errors**: none',
    '- **Decisions**: none',
    `- **Files Changed**: ${artifacts.map((a) => a.path).join(', ')}`,
    '',
  ].join('\n');

  ensureDir(join(brainDir, 'features'));
  writeFileSync(featureFile, content, 'utf-8');
  return featureFile;
}

/**
 * Scans flow/archive/, flow/discovery/, and flow/plans/ for existing artifacts
 * and creates brain feature entries from them.
 */
function scanLegacyArtifacts(
  target: string,
  options: CopyOptions
): CopyResult {
  const result: CopyResult = { created: [], skipped: [], updated: [] };
  const brainDir = join(target, 'flow', 'brain');

  // Directories to scan for brain feature extraction
  const scanDirs = [
    { dir: join(target, 'flow', 'archive'), status: 'archived' },
    { dir: join(target, 'flow', 'discovery'), status: 'active' },
    { dir: join(target, 'flow', 'plans'), status: 'active' },
  ];

  // All directories to inject [[project-name]] into existing .md files
  const tagDirs = [
    ...scanDirs.map((s) => s.dir),
    join(target, 'flow', 'contracts'),
    join(target, 'flow', 'reviewed-code'),
    join(target, 'flow', 'reviewed-pr'),
  ];

  // Collect artifacts grouped by feature
  const featureArtifacts: Record<
    string,
    { path: string; type: string; title: string; status: string }[]
  > = {};

  for (const { dir, status } of scanDirs) {
    if (!existsSync(dir)) continue;

    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '.gitkeep');

      for (const file of files) {
        const featureName = extractFeatureName(file);
        if (!featureName) continue;

        const filePath = join(dir, file);
        const title = extractTitle(filePath);
        const type = file.startsWith('plan') ? 'Plan' : 'Discovery';
        const relativeFolderName = dir.split('/').pop() || '';

        if (!featureArtifacts[featureName]) {
          featureArtifacts[featureName] = [];
        }

        featureArtifacts[featureName].push({
          path: `flow/${relativeFolderName}/${file}`,
          type,
          title,
          status,
        });
      }
    } catch {
      // Skip directories we can't read
    }
  }

  // Inject [[project-name]] into legacy artifact files that don't have it
  const projectName = getProjectName(target);
  const projectTag = `**Project**: [[${projectName}]]`;

  for (const dir of tagDirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '.gitkeep');
      for (const file of files) {
        const filePath = join(dir, file);
        const content = readFileSync(filePath, 'utf-8');
        if (content.includes(`[[${projectName}]]`)) continue; // Already tagged

        // Insert after the first heading (# ...)
        const updated = content.replace(
          /^(# .+)$/m,
          `$1\n\n${projectTag}`
        );
        if (updated !== content) {
          writeFileSync(filePath, updated, 'utf-8');
          result.updated.push(filePath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  // Create brain entries for each feature
  const indexFeatures: { name: string; status: string; title: string }[] = [];

  for (const [featureName, artifacts] of Object.entries(featureArtifacts)) {
    const featureFile = join(brainDir, 'features', `${featureName}.md`);

    if (existsSync(featureFile) && !options.force) {
      result.skipped.push(featureFile);
      continue;
    }

    // Determine overall status: archived if any artifact is in archive
    const overallStatus = artifacts.some((a) => a.status === 'archived')
      ? 'archived'
      : 'active';

    const firstTitle = artifacts[0]?.title || featureName;

    const created = createBrainFeatureEntry(
      brainDir,
      featureName,
      artifacts,
      overallStatus,
      getProjectName(target)
    );

    if (created) {
      result.created.push(created);
      log.success(`Brain entry created: ${featureName}`);
    }

    indexFeatures.push({ name: featureName, status: overallStatus, title: firstTitle });
  }

  // Rebuild the brain index from the notes — it is generated, never edited in
  // place (two machines inserting at the same point is a guaranteed conflict).
  if (indexFeatures.length > 0) {
    writeBrainIndex(join(target, 'flow'));
    log.success(`Brain index rebuilt with ${indexFeatures.length} legacy feature(s)`);
  }

  return result;
}

// --- Dependency file detection ---

interface DepFileInfo {
  file: string;
  language: string;
  packageManager: string;
}

const DEP_FILES: DepFileInfo[] = [
  { file: 'package.json', language: 'JavaScript', packageManager: 'npm' },
  { file: 'pyproject.toml', language: 'Python', packageManager: 'pip' },
  { file: 'Cargo.toml', language: 'Rust', packageManager: 'cargo' },
  { file: 'go.mod', language: 'Go', packageManager: 'go' },
  { file: 'Gemfile', language: 'Ruby', packageManager: 'bundler' },
];

/** Well-known dependency → framework label mapping */
const FRAMEWORK_MAP: Record<string, string> = {
  'next': 'Next.js',
  'react': 'React',
  'vue': 'Vue',
  'nuxt': 'Nuxt',
  '@angular/core': 'Angular',
  'svelte': 'Svelte',
  'express': 'Express',
  'fastify': 'Fastify',
  'koa': 'Koa',
  'hono': 'Hono',
  'nestjs': 'NestJS',
  '@nestjs/core': 'NestJS',
  'fastapi': 'FastAPI',
  'django': 'Django',
  'flask': 'Flask',
  'actix-web': 'Actix Web',
  'rocket': 'Rocket',
  'gin': 'Gin',
  'rails': 'Ruby on Rails',
  'remix': 'Remix',
  'gatsby': 'Gatsby',
  'astro': 'Astro',
  'solid-js': 'SolidJS',
  'qwik': 'Qwik',
};

const TEST_FRAMEWORK_MAP: Record<string, string> = {
  'jest': 'Jest',
  'vitest': 'Vitest',
  'mocha': 'Mocha',
  'ava': 'Ava',
  'jasmine': 'Jasmine',
  'pytest': 'Pytest',
  'unittest': 'unittest',
};

const PKG_MANAGER_INDICATORS: Record<string, string> = {
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'Pipfile.lock': 'pipenv',
  'poetry.lock': 'poetry',
};

/** Directories to skip when scanning project structure */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '__pycache__', '.pytest_cache', 'target', 'vendor',
  '.cache', '.turbo', '.vercel', '.output', 'flow',
]);

/**
 * Scans directory structure up to maxDepth levels deep.
 * Returns a tree representation with file counts per directory.
 */
function scanDirectoryTree(
  rootDir: string,
  maxDepth: number
): { tree: string; extensions: Record<string, number> } {
  const extensions: Record<string, number> = {};
  const lines: string[] = [];

  function scan(dir: string, prefix: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir).filter((e) => !e.startsWith('.') && !SKIP_DIRS.has(e));
    } catch {
      return;
    }

    // Sort: directories first, then files
    const dirs: string[] = [];
    const files: string[] = [];
    for (const entry of entries) {
      try {
        const stat = statSync(join(dir, entry));
        if (stat.isDirectory()) dirs.push(entry);
        else files.push(entry);
      } catch {
        // skip unreadable entries
      }
    }

    // Count files by extension in this directory (recursively)
    const fileCounts: Record<string, number> = {};
    function countFiles(d: string): number {
      let total = 0;
      try {
        for (const e of readdirSync(d)) {
          if (e.startsWith('.') || SKIP_DIRS.has(e)) continue;
          const p = join(d, e);
          try {
            const s = statSync(p);
            if (s.isDirectory()) {
              total += countFiles(p);
            } else {
              total++;
              const ext = e.includes('.') ? '.' + e.split('.').pop() : '(no ext)';
              extensions[ext] = (extensions[ext] || 0) + 1;
              fileCounts[ext] = (fileCounts[ext] || 0) + 1;
            }
          } catch {
            // skip
          }
        }
      } catch {
        // skip
      }
      return total;
    }

    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i];
      const isLast = i === dirs.length - 1 && files.length === 0;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      const dirPath = join(dir, d);
      const fileCount = countFiles(dirPath);
      lines.push(`${prefix}${connector}${d}/    (${fileCount} files)`);

      if (depth < maxDepth) {
        scan(dirPath, prefix + childPrefix, depth + 1);
      }
    }
  }

  scan(rootDir, '', 0);
  return { tree: lines.join('\n'), extensions };
}

/**
 * Detects architecture pattern from top-level directory names.
 */
function detectArchitecturePattern(target: string): string {
  const srcDir = join(target, 'src');
  const hasPackagesDir = existsSync(join(target, 'packages'));
  const hasAppsDir = existsSync(join(target, 'apps'));

  if (hasPackagesDir || hasAppsDir) return 'Monorepo';

  if (existsSync(srcDir)) {
    try {
      const srcEntries = readdirSync(srcDir);
      const featureDirs = ['features', 'modules', 'domains'];
      const layerDirs = ['controllers', 'services', 'models', 'repositories'];

      if (featureDirs.some((d) => srcEntries.includes(d))) return 'Feature-based';
      if (layerDirs.some((d) => srcEntries.includes(d))) return 'Layer-based';
      if (srcEntries.includes('components')) return 'Component-based';
    } catch {
      // skip
    }
  }

  return 'Standard';
}

/**
 * Parses a package.json and extracts dependency info.
 */
function parsePackageJson(target: string): {
  language: string;
  framework: string;
  testFramework: string;
  packageManager: string;
  prodDeps: { name: string; version: string; category: string }[];
  devDeps: { name: string; version: string; category: string }[];
  tsStrict: boolean;
  tsTarget: string;
  tsPaths: boolean;
} | null {
  const pkgPath = join(target, 'package.json');
  if (!existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const hasTsConfig = existsSync(join(target, 'tsconfig.json'));
    const hasTs = allDeps['typescript'] || hasTsConfig;
    const language = hasTs ? 'TypeScript' : 'JavaScript';

    // Detect framework
    let framework = 'None';
    for (const [dep, label] of Object.entries(FRAMEWORK_MAP)) {
      if (allDeps[dep]) {
        const version = allDeps[dep] as string;
        framework = `${label} ${version.replace(/^[\^~]/, '')}`;
        break;
      }
    }

    // Detect test framework
    let testFramework = 'None';
    for (const [dep, label] of Object.entries(TEST_FRAMEWORK_MAP)) {
      if (allDeps[dep]) {
        testFramework = label;
        break;
      }
    }

    // Detect package manager from lock files
    let packageManager = 'npm';
    for (const [lockFile, pm] of Object.entries(PKG_MANAGER_INDICATORS)) {
      if (existsSync(join(target, lockFile))) {
        packageManager = pm;
        break;
      }
    }

    // Categorize dependencies
    function categorizeDep(name: string): string {
      if (FRAMEWORK_MAP[name]) return 'Framework';
      if (TEST_FRAMEWORK_MAP[name]) return 'Testing';
      if (name.startsWith('@types/')) return 'Types';
      if (name === 'typescript') return 'Language';
      if (['eslint', 'prettier', 'biome'].some((t) => name.includes(t))) return 'Linting';
      if (['webpack', 'vite', 'rollup', 'esbuild', 'tsup', 'swc'].some((t) => name.includes(t))) return 'Build';
      return 'Library';
    }

    const prodDeps = Object.entries(pkg.dependencies || {}).map(([name, version]) => ({
      name,
      version: version as string,
      category: categorizeDep(name),
    }));

    const devDeps = Object.entries(pkg.devDependencies || {}).map(([name, version]) => ({
      name,
      version: version as string,
      category: categorizeDep(name),
    }));

    // Parse tsconfig
    let tsStrict = false;
    let tsTarget = '';
    let tsPaths = false;
    if (hasTsConfig) {
      try {
        const tsconfig = JSON.parse(readFileSync(join(target, 'tsconfig.json'), 'utf-8'));
        tsStrict = tsconfig.compilerOptions?.strict === true;
        tsTarget = tsconfig.compilerOptions?.target || '';
        tsPaths = !!(tsconfig.compilerOptions?.paths && Object.keys(tsconfig.compilerOptions.paths).length > 0);
      } catch {
        // Could not parse tsconfig
      }
    }

    return {
      language,
      framework,
      testFramework,
      packageManager,
      prodDeps,
      devDeps,
      tsStrict,
      tsTarget,
      tsPaths,
    };
  } catch {
    return null;
  }
}

/**
 * Parses pyproject.toml for Python projects (basic key=value parsing).
 */
function parsePyprojectToml(target: string): {
  language: string;
  framework: string;
  testFramework: string;
  packageManager: string;
  prodDeps: { name: string; version: string; category: string }[];
  devDeps: { name: string; version: string; category: string }[];
} | null {
  const pyPath = join(target, 'pyproject.toml');
  if (!existsSync(pyPath)) return null;

  try {
    const content = readFileSync(pyPath, 'utf-8');

    // Extract dependencies from [project.dependencies] or [tool.poetry.dependencies]
    const depPattern = /\[(?:project\.dependencies|tool\.poetry\.dependencies)\]\s*\n([\s\S]*?)(?:\n\[|\n$)/;
    const depMatch = content.match(depPattern);
    const deps: { name: string; version: string; category: string }[] = [];

    if (depMatch) {
      const lines = depMatch[1].split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
      for (const line of lines) {
        const parts = line.match(/^["\s]*([a-zA-Z0-9_-]+)["\s]*[>=<~!]*(.*)/);
        if (parts) {
          deps.push({ name: parts[1], version: parts[2]?.trim() || '*', category: 'Library' });
        }
      }
    }

    // Detect framework
    let framework = 'None';
    const allDepNames = deps.map((d) => d.name.toLowerCase());
    const pyFrameworks: Record<string, string> = {
      'fastapi': 'FastAPI',
      'django': 'Django',
      'flask': 'Flask',
      'starlette': 'Starlette',
      'tornado': 'Tornado',
      'sanic': 'Sanic',
    };
    for (const [dep, label] of Object.entries(pyFrameworks)) {
      if (allDepNames.includes(dep)) {
        framework = label;
        break;
      }
    }

    // Detect test framework
    let testFramework = 'None';
    if (content.includes('pytest') || existsSync(join(target, 'pytest.ini'))) {
      testFramework = 'Pytest';
    }

    // Detect package manager
    let packageManager = 'pip';
    if (existsSync(join(target, 'poetry.lock'))) packageManager = 'poetry';
    else if (existsSync(join(target, 'Pipfile.lock'))) packageManager = 'pipenv';
    else if (content.includes('[tool.poetry]')) packageManager = 'poetry';

    return { language: 'Python', framework, testFramework, packageManager, prodDeps: deps, devDeps: [] };
  } catch {
    return null;
  }
}

/**
 * Detects config files and returns a summary.
 */
function detectConfigFiles(target: string): string[] {
  const configs: string[] = [];

  // TypeScript
  if (existsSync(join(target, 'tsconfig.json'))) {
    try {
      const tsconfig = JSON.parse(readFileSync(join(target, 'tsconfig.json'), 'utf-8'));
      const strict = tsconfig.compilerOptions?.strict ? 'strict mode' : 'non-strict';
      const paths = tsconfig.compilerOptions?.paths
        ? ', paths aliases (' + Object.keys(tsconfig.compilerOptions.paths).join(', ') + ')'
        : '';
      configs.push(`TypeScript: ${strict}${paths}`);
    } catch {
      configs.push('TypeScript: Could not parse tsconfig.json');
    }
  }

  // ESLint
  const eslintFiles = ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'];
  for (const f of eslintFiles) {
    if (existsSync(join(target, f))) {
      configs.push(`ESLint: ${f}`);
      break;
    }
  }

  // Prettier
  const prettierFiles = ['.prettierrc', '.prettierrc.js', '.prettierrc.json', 'prettier.config.js', 'prettier.config.mjs'];
  for (const f of prettierFiles) {
    if (existsSync(join(target, f))) {
      configs.push(`Prettier: ${f}`);
      break;
    }
  }

  // Biome
  if (existsSync(join(target, 'biome.json')) || existsSync(join(target, 'biome.jsonc'))) {
    configs.push('Biome: biome.json');
  }

  return configs;
}

/**
 * Generates flow/references/tech-foundation.md from programmatic project analysis.
 */
export function generateTechFoundation(
  target: string,
  options: CopyOptions
): CopyResult {
  const result: CopyResult = { created: [], skipped: [], updated: [] };
  const filePath = join(target, 'flow', 'references', 'tech-foundation.md');

  if (existsSync(filePath) && !options.force) {
    result.skipped.push(filePath);
    log.skip('Tech foundation already exists');
    return result;
  }

  const projectName = getProjectName(target);
  const today = new Date().toISOString().slice(0, 10);

  // Detect primary language and parse dependencies
  let parsed: {
    language: string;
    framework: string;
    testFramework: string;
    packageManager: string;
    prodDeps: { name: string; version: string; category: string }[];
    devDeps: { name: string; version: string; category: string }[];
    tsStrict?: boolean;
    tsTarget?: string;
    tsPaths?: boolean;
  } | null = null;

  // Try each dependency file in priority order
  parsed = parsePackageJson(target);
  if (!parsed) parsed = parsePyprojectToml(target);
  if (!parsed) {
    // Check for other language files
    for (const depFile of DEP_FILES.slice(2)) {
      if (existsSync(join(target, depFile.file))) {
        parsed = {
          language: depFile.language,
          framework: 'None',
          testFramework: 'None',
          packageManager: depFile.packageManager,
          prodDeps: [],
          devDeps: [],
        };
        break;
      }
    }
  }

  // Also check for *.csproj
  if (!parsed) {
    try {
      const rootFiles = readdirSync(target);
      if (rootFiles.some((f) => f.endsWith('.csproj'))) {
        parsed = {
          language: 'C#',
          framework: '.NET',
          testFramework: 'None',
          packageManager: 'dotnet',
          prodDeps: [],
          devDeps: [],
        };
      }
    } catch {
      // skip
    }
  }

  if (!parsed) {
    parsed = {
      language: 'Unknown',
      framework: 'None',
      testFramework: 'None',
      packageManager: 'Unknown',
      prodDeps: [],
      devDeps: [],
    };
  }

  // TypeScript info for stack overview
  const tsLine = parsed.language === 'TypeScript' && parsed.tsStrict !== undefined
    ? `| TypeScript | ${parsed.tsStrict ? 'Strict mode' : 'Non-strict'} |`
    : '';

  // Scan directory structure
  const { tree } = scanDirectoryTree(target, 2);

  // Detect architecture
  const architecture = detectArchitecturePattern(target);

  // Detect configs
  const configs = detectConfigFiles(target);

  // Build the markdown
  const lines: string[] = [
    '# Tech Foundation',
    '',
    `**Project**: [[${projectName}]]`,
    `**Generated**: ${today}`,
    '',
    '## Stack Overview',
    '',
    '| Attribute | Value |',
    '|-----------|-------|',
    `| Language | ${parsed.language} |`,
    `| Framework | ${parsed.framework} |`,
    `| Package Manager | ${parsed.packageManager} |`,
    `| Test Framework | ${parsed.testFramework} |`,
  ];

  if (tsLine) lines.push(tsLine);
  lines.push(`| Architecture | ${architecture} |`);

  // Production dependencies
  if (parsed.prodDeps.length > 0) {
    lines.push('', `## Dependencies`, '', `### Production (${parsed.prodDeps.length} packages)`, '');
    lines.push('| Package | Version | Category |');
    lines.push('|---------|---------|----------|');
    for (const dep of parsed.prodDeps) {
      lines.push(`| ${dep.name} | ${dep.version} | ${dep.category} |`);
    }
  }

  // Dev dependencies
  if (parsed.devDeps.length > 0) {
    lines.push('', `### Development (${parsed.devDeps.length} packages)`, '');
    lines.push('| Package | Version | Category |');
    lines.push('|---------|---------|----------|');
    for (const dep of parsed.devDeps) {
      lines.push(`| ${dep.name} | ${dep.version} | ${dep.category} |`);
    }
  }

  // Project structure
  if (tree) {
    lines.push('', '## Project Structure', '', '```');
    lines.push(tree);
    lines.push('```');
  }

  // Configuration
  if (configs.length > 0) {
    lines.push('', '## Configuration', '');
    for (const config of configs) {
      lines.push(`- ${config}`);
    }
  }

  lines.push('');

  const isUpdate = existsSync(filePath);
  ensureDir(join(target, 'flow', 'references'));
  writeFileSync(filePath, lines.join('\n'), 'utf-8');

  if (isUpdate) {
    result.updated.push(filePath);
    log.warn('Updated tech foundation');
  } else {
    result.created.push(filePath);
    log.success('Generated tech foundation');
  }

  return result;
}

/**
 * Extracts a one-liner description from the first paragraph of a README.
 */
function extractReadmeHint(target: string): string | undefined {
  const readmePath = join(target, 'README.md');
  if (!existsSync(readmePath)) return undefined;

  try {
    const content = readFileSync(readmePath, 'utf-8');
    const lines = content.split('\n').slice(0, 50);

    // Skip badge/image lines and headings, find first paragraph text
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('!')) continue;  // images
      if (trimmed.startsWith('[!')) continue;  // badges
      if (trimmed.startsWith('[![')) continue; // badge links
      if (trimmed.startsWith('<')) continue;    // HTML tags
      if (trimmed.startsWith('---')) continue;  // horizontal rules
      // Found a real paragraph line
      return trimmed;
    }
  } catch {
    // skip
  }

  return undefined;
}

/**
 * Generates flow/references/business-context.md from interactive prompts.
 */
export async function generateBusinessContext(
  target: string,
  options: CopyOptions
): Promise<CopyResult> {
  const result: CopyResult = { created: [], skipped: [], updated: [] };
  const filePath = join(target, 'flow', 'references', 'business-context.md');

  if (existsSync(filePath) && !options.force) {
    result.skipped.push(filePath);
    log.skip('Business context already exists');
    return result;
  }

  // Business context is an interactive Q&A — skip it entirely in non-interactive
  // mode (the IDE runs init under the hood, no terminal). It's an optional doc.
  if (options.nonInteractive) {
    result.skipped.push(filePath);
    log.skip('Business context skipped (non-interactive)');
    return result;
  }

  const projectName = getProjectName(target);
  const today = new Date().toISOString().slice(0, 10);
  const readmeHint = extractReadmeHint(target);

  const answers = await askBusinessContext(readmeHint);

  // Extract README summary (first ~5 lines of real content, skipping headings/badges)
  let readmeSummary = 'No README found.';
  const readmePath = join(target, 'README.md');
  if (existsSync(readmePath)) {
    try {
      const readmeContent = readFileSync(readmePath, 'utf-8');
      const readmeLines = readmeContent.split('\n').slice(0, 50);
      const contentLines: string[] = [];
      for (const line of readmeLines) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (contentLines.length > 0) break; // stop at first blank line after content
          continue;
        }
        if (trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('[![') || trimmed.startsWith('[!') || trimmed.startsWith('!')) continue;
        if (trimmed.startsWith('<')) continue;
        if (trimmed.startsWith('---')) continue;
        contentLines.push(trimmed);
        if (contentLines.length >= 5) break;
      }
      if (contentLines.length > 0) readmeSummary = contentLines.join('\n');
    } catch {
      // skip
    }
  }

  const content = [
    '# Business Context',
    '',
    `**Project**: [[${projectName}]]`,
    `**Generated**: ${today}`,
    '',
    '## What It Does',
    '',
    answers.whatItDoes || 'Not specified.',
    '',
    '## Target Audience',
    '',
    answers.targetAudience || 'Not specified.',
    '',
    '## Problem It Solves',
    '',
    answers.problemItSolves || 'Not specified.',
    '',
    '## README Summary',
    '',
    readmeSummary,
    '',
  ].join('\n');

  const isUpdate = existsSync(filePath);
  ensureDir(join(target, 'flow', 'references'));
  writeFileSync(filePath, content, 'utf-8');

  if (isUpdate) {
    result.updated.push(filePath);
    log.warn('Updated business context');
  } else {
    result.created.push(filePath);
    log.success('Generated business context');
  }

  return result;
}

/**
 * Generates flow/tasklist.md — a persistent project todo list
 * updated in real-time during skill execution.
 */
export function generateTasklist(
  target: string,
  _options: CopyOptions
): CopyResult {
  const result: CopyResult = { created: [], skipped: [], updated: [] };
  const filePath = join(target, 'flow', 'tasklist.md');

  // Accumulated user knowledge — create-if-missing even under --force, so an
  // IDE re-provision (`init --claude --force --yes`) never resets the user's
  // tasks (NFR3: provisioning must never rewrite flow/ content).
  if (existsSync(filePath)) {
    result.skipped.push(filePath);
    log.skip('Tasklist already exists');
    return result;
  }

  const projectName = getProjectName(target);
  const today = new Date().toISOString().slice(0, 10);

  const content = [
    '# Tasklist',
    '',
    `**Project**: [[${projectName}]]`,
    `**Created**: ${today}`,
    `**Last Updated**: ${today}`,
    '',
    '## In Progress',
    '',
    '',
    '## To Do',
    '',
    '',
    '## Done',
    '',
    '',
  ].join('\n');

  ensureDir(join(target, 'flow'));
  writeFileSync(filePath, content, 'utf-8');
  result.created.push(filePath);
  log.success('Generated tasklist');

  return result;
}

/**
 * Generates flow/memory.md — a persistent artifact tracker
 * that records every completed skill execution.
 */
export function generateMemory(
  target: string,
  _options: CopyOptions
): CopyResult {
  const result: CopyResult = { created: [], skipped: [], updated: [] };
  const filePath = join(target, 'flow', 'memory.md');

  // Accumulated user knowledge — create-if-missing even under --force, so an
  // IDE re-provision never resets the completed-work tracker (NFR3).
  if (existsSync(filePath)) {
    result.skipped.push(filePath);
    log.skip('Memory already exists');
    return result;
  }

  const projectName = getProjectName(target);
  const today = new Date().toISOString().slice(0, 10);

  const content = [
    '# Project Memory',
    '',
    `**Project**: [[${projectName}]]`,
    `**Last Updated**: ${today}`,
    '',
    '## Memory',
    '',
    '| Date | Skill | Feature | Artifact | Summary |',
    '|------|-------|---------|----------|---------|',
    '',
  ].join('\n');

  ensureDir(join(target, 'flow'));
  writeFileSync(filePath, content, 'utf-8');
  result.created.push(filePath);
  log.success('Generated project memory');

  return result;
}

/**
 * Generates flow/heartbeat.md — a scheduled task definitions file
 * for the heartbeat daemon.
 */
export function generateHeartbeat(
  target: string,
  _options: CopyOptions
): CopyResult {
  const result: CopyResult = { created: [], skipped: [], updated: [] };
  const filePath = join(target, 'flow', 'heartbeat.md');

  // User-authored task definitions — create-if-missing even under --force, so an
  // IDE re-provision never wipes the user's scheduled tasks (NFR3).
  if (existsSync(filePath)) {
    result.skipped.push(filePath);
    log.skip('Heartbeat already exists');
    return result;
  }

  const projectName = getProjectName(target);
  const today = new Date().toISOString().slice(0, 10);

  const content = [
    '# Heartbeat',
    '',
    `**Project**: [[${projectName}]]`,
    `**Last Updated**: ${today}`,
    '',
    '## Tasks',
    '',
    '<!-- Add tasks below using the format:',
    '### task-name',
    '- **Schedule**: daily at 10:00 PM',
    '- **Command**: research about topic X and add to brain',
    '- **Enabled**: true',
    '- **Description**: What this task does',
    '-->',
    '',
  ].join('\n');

  ensureDir(join(target, 'flow'));
  writeFileSync(filePath, content, 'utf-8');
  result.created.push(filePath);
  log.success('Generated heartbeat config');

  return result;
}

/**
 * Generates flow/log.md — an append-only heartbeat log
 * of important events during project execution.
 */
export function generateLog(
  target: string,
  _options: CopyOptions
): CopyResult {
  const result: CopyResult = { created: [], skipped: [], updated: [] };
  const filePath = join(target, 'flow', 'log.md');

  // Append-only event log — create-if-missing even under --force, so an IDE
  // re-provision never truncates the user's project log (NFR3).
  if (existsSync(filePath)) {
    result.skipped.push(filePath);
    log.skip('Log already exists');
    return result;
  }

  const projectName = getProjectName(target);
  const today = new Date().toISOString().slice(0, 10);

  const content = [
    '# Project Log',
    '',
    `**Project**: [[${projectName}]]`,
    `**Created**: ${today}`,
    '',
    '---',
    '',
    `### ${today}`,
    '',
    `- plan-flow initialized`,
    '',
  ].join('\n');

  ensureDir(join(target, 'flow'));
  writeFileSync(filePath, content, 'utf-8');
  result.created.push(filePath);
  log.success('Generated project log');

  return result;
}

/**
 * Whether this project's knowledge lives in the REPO rather than the vault —
 * the topology `planflow-ai brain migrate` leaves behind.
 *
 * Two signals, either sufficient:
 *  - the vault's project `flow` is a symlink resolving to the repo's `flow/`
 *    (the normal post-migration shape), or
 *  - the repo's `flow/` is a real directory and the project is answered
 *    `shared` (the recovery shape, when the vault link was lost — a fresh
 *    local project with a legacy real `flow/` is unanswered, so it still takes
 *    the original migrate-into-the-vault path), or
 *  - the repo's `flow/` is a real directory and the project keeps its own
 *    knowledge repo (`keepsOwnKnowledgeRepo`) — `.git` or not, because a clone
 *    interrupted before its `.git` landed is still not ours to move.
 */
/**
 * A real `flow/` holding its own `.git` is a knowledge repo, whatever the share
 * mode says — e.g. after sync was turned off but the history kept on this
 * machine (`knowledge disable --to keep`). Moving it into the vault would carry
 * a repository into a folder another repository tracks, so provisioning leaves
 * it exactly where it is.
 */
function holdsOwnRepo(localFlowDir: string): boolean {
  return !isSymlink(localFlowDir) && existsSync(join(localFlowDir, '.git'));
}

function repoOwnsFlow(target: string, brainFlowDir: string, localFlowDir: string): boolean {
  if (isSymlink(brainFlowDir)) {
    const linkTarget = readSymlinkTarget(brainFlowDir);
    const resolved = linkTarget ? resolve(brainFlowDir, '..', linkTarget) : null;
    if (resolved === resolve(localFlowDir)) return true;
  }
  if (existsSync(localFlowDir) && !isSymlink(localFlowDir)) {
    return (
      keepsOwnKnowledgeRepo(target) || holdsOwnRepo(localFlowDir) || readShareMode(target) === 'shared'
    );
  }
  return false;
}

/**
 * Link `flow` into the repo's Workspace when it is a Workspace project.
 * Returns whether `flow` is (now) a Workspace link — in which case the vault
 * ladder below must not run. A Workspace project whose link needs a person
 * first (a committed `flow/`) is reported and left to the ladder, unchanged.
 */
async function linkIntoWorkspace(target: string): Promise<boolean> {
  const { provisionWorkspaceLink } = await import('./workspace-model.js');
  let outcome: Awaited<ReturnType<typeof provisionWorkspaceLink>>;
  try {
    outcome = provisionWorkspaceLink(target);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Could not check this project's Workspace (non-fatal): ${msg}`);
    return false;
  }
  switch (outcome.kind) {
    case 'workspace-link': {
      const { scaffoldProjectFolder } = await import('./workspace-model.js');
      if (existsSync(outcome.folder)) scaffoldProjectFolder(outcome.folder);
      return true;
    }
    case 'linked':
      log.success(`Linked flow/ → its Workspace project folder (${outcome.folder})`);
      return true;
    case 'needs-review':
      log.warn(`This project belongs to a Workspace, but flow/ was not linked: ${outcome.sentence}`);
      return false;
    case 'suggestion':
      log.info(`Not linked to a Workspace: ${outcome.sentence}`);
      return false;
    case 'not-in-workspace':
      return false;
  }
}

export async function initShared(
  target: string,
  options: CopyOptions,
  platforms: Platform[] = []
): Promise<CopyResult> {
  const result: CopyResult = { created: [], skipped: [], updated: [] };

  // 1. Create flow/ directory structure in the brain, symlinked from project
  const projectName = getProjectName(target);
  const vaultDir = getVaultDir();
  const brainFlowDir = join(vaultDir, 'projects', projectName, 'flow');
  const localFlowDir = join(target, 'flow');

  // A project that keeps its knowledge in its own repo: `flow/` is that repo's
  // clone (or will be), so nothing below may move, re-link, scaffold or seed
  // it. Decided ONCE, before anything writes, and held for the whole provision.
  // A `flow/` symlink is the one exception — that is still a vault project
  // that has not been converted on this machine, and the ladder handles it.
  const leaveFlowAlone =
    !isSymlink(localFlowDir) && (keepsOwnKnowledgeRepo(target) || holdsOwnRepo(localFlowDir));
  const flowAbsent = !existsSync(localFlowDir) && !isSymlink(localFlowDir);

  // A Workspace project: `flow` links into the Workspace's project folder,
  // never into the vault, and an existing Workspace link is never moved or
  // re-linked. Decided by the one model (workspace-model.ts); a project in no
  // Workspace — or one that keeps its own knowledge repo — is untouched here.
  // Imported lazily: the model imports this module's neighbours, and a static
  // cycle would leave one side's bindings undefined at load.
  // A `flow` that already links into a Workspace project folder is decided
  // from the link's OWN target (independent of where this process resolves
  // the Flow folder) — the vault ladder below must never merge or re-link it.
  // A project that keeps its own knowledge repo is a candidate too: linking a
  // recorded checkout imports it (decision 2026-10-06), never leaves it out.
  const linksIntoWorkspace = isSymlink(localFlowDir) && locateWorkspaceProject(localFlowDir) !== null;
  const inWorkspace = linksIntoWorkspace || (await linkIntoWorkspace(target));
  // The Flow app puts every project in a Workspace itself (`workspace
  // migrate`, which copies flow/ in): a vault link made here would only be
  // something for migrate to import, so a managed provision leaves flow/ —
  // whatever it is — exactly as it found it.
  const managedElsewhere = options.workspaceManaged === true && !inWorkspace;
  // Nothing below may write into flow/: a knowledge repo's own contents, or a
  // flow/ the app's migration is about to take in.
  const flowUntouchable = !inWorkspace && (leaveFlowAlone || managedElsewhere);

  if (inWorkspace) {
    log.skip('flow/ links into its Workspace — left as is');
  } else if (managedElsewhere) {
    log.info('flow/ is left as it is — the Flow app moves it into a Workspace');
  } else if (leaveFlowAlone && flowAbsent) {
    // Fresh clone / another machine: the knowledge clone creates `flow/`. No
    // vault dir, no link, no placeholder — a pre-created `flow/` would make the
    // clone refuse a non-empty destination.
    log.info('flow/ is this project\'s knowledge repo — it will be cloned into place, not created');
  } else if (repoOwnsFlow(target, brainFlowDir, localFlowDir)) {
    // Case 0: INVERTED topology (post `brain migrate`) — the repo holds the
    // real flow/ and the vault points INTO it. Reuses this same relocation
    // ladder rather than adding a second symlink mechanism: the only thing
    // that changes is which side is the link. Falling through to Case 3 would
    // move the repo's knowledge into a vault path that is itself a link back
    // to the repo, so the check is load-bearing, not cosmetic.
    if (leaveFlowAlone) {
      // The knowledge repo's own contents are its business: no scaffolding
      // (every `.gitkeep` would be an uncommitted change in it) and no vault
      // back-link — the vault keeps whatever copy it had, as a backup.
      log.skip('flow/ is this project\'s knowledge repo — left as is');
    } else {
      for (const subdir of FLOW_SUBDIRS) {
        const dir = join(localFlowDir, subdir);
        if (!existsSync(dir)) {
          ensureDir(dir);
          writeFileSync(join(dir, '.gitkeep'), '', 'utf-8');
          result.created.push(dir);
          log.success(`Created flow/${subdir}/`);
        } else {
          result.skipped.push(dir);
        }
      }
      // Re-link the vault when its link is missing (Obsidian's one-graph view),
      // never when a real directory is sitting there — that is the migration's
      // job, and it refuses rather than merging blind.
      if (!existsSync(brainFlowDir) && !isSymlink(brainFlowDir)) {
        createSymlink(localFlowDir, brainFlowDir);
        log.success('Re-linked the vault at this repo (knowledge lives in the repo)');
      }
      log.skip('flow/ is owned by the repo — vault points at it');
    }
  } else if (!existsSync(localFlowDir)) {
    // Case 1: flow/ doesn't exist (new project) — create in brain and symlink
    ensureDir(brainFlowDir);
    for (const subdir of FLOW_SUBDIRS) {
      const dir = join(brainFlowDir, subdir);
      ensureDir(dir);
      writeFileSync(join(dir, '.gitkeep'), '', 'utf-8');
      result.created.push(dir);
      log.success(`Created flow/${subdir}/`);
    }
    createSymlink(brainFlowDir, localFlowDir);
    log.success(`Created flow/ symlink → brain`);
  } else if (isSymlink(localFlowDir)) {
    // Case 2: flow/ is already a symlink (already migrated)
    const currentTarget = readSymlinkTarget(localFlowDir);
    const resolvedCurrent = currentTarget ? resolve(localFlowDir, '..', currentTarget) : null;
    const resolvedExpected = resolve(brainFlowDir);

    if (resolvedCurrent === resolvedExpected) {
      // Already correct — ensure subdirs exist
      for (const subdir of FLOW_SUBDIRS) {
        const dir = join(brainFlowDir, subdir);
        if (!existsSync(dir)) {
          ensureDir(dir);
          writeFileSync(join(dir, '.gitkeep'), '', 'utf-8');
          result.created.push(dir);
          log.success(`Created flow/${subdir}/`);
        } else {
          result.skipped.push(dir);
          log.skip(`flow/${subdir}/ already exists`);
        }
      }
    } else {
      // Wrong target — update the symlink, but NEVER abandon the old target's
      // data (#908): the previous vault dir holds precious stores (learning
      // state, investigations, brain docs). Merge everything missing into the
      // new target first; existing files in the new target are never
      // overwritten.
      if (resolvedCurrent !== null && existsSync(resolvedCurrent)) {
        const merge = mergeMissingContents(resolvedCurrent, brainFlowDir);
        if (merge.moved > 0) {
          log.success(`Migrated ${merge.moved} item(s) from the previous vault location`);
        }
        for (const err of merge.errors) {
          log.warn(`Vault migration warning: ${err}`);
        }
      }
      unlinkSync(localFlowDir);
      ensureDir(brainFlowDir);
      for (const subdir of FLOW_SUBDIRS) {
        const dir = join(brainFlowDir, subdir);
        if (!existsSync(dir)) {
          ensureDir(dir);
          writeFileSync(join(dir, '.gitkeep'), '', 'utf-8');
        }
      }
      createSymlink(brainFlowDir, localFlowDir);
      log.success(`Updated flow/ symlink → brain`);
    }
  } else {
    // Case 3: flow/ is a real directory (needs migration to brain)
    ensureDir(brainFlowDir);
    const { moved, errors: moveErrors } = moveContents(localFlowDir, brainFlowDir);

    if (moveErrors.length > 0) {
      for (const err of moveErrors) {
        log.warn(`Migration warning: ${err}`);
      }
    }

    // Ensure all expected subdirs exist in brain after migration
    for (const subdir of FLOW_SUBDIRS) {
      const dir = join(brainFlowDir, subdir);
      if (!existsSync(dir)) {
        ensureDir(dir);
        writeFileSync(join(dir, '.gitkeep'), '', 'utf-8');
      }
    }

    const remaining = readdirSync(localFlowDir);
    if (remaining.length === 0) {
      rmdirSync(localFlowDir);
      createSymlink(brainFlowDir, localFlowDir);
      log.success(`Migrated flow/ to brain (${moved} items moved)`);
    } else {
      log.warn(`flow/ migration incomplete, ${remaining.length} files remain`);
    }
  }

  // 1b. Make the flow/ symlink writable from a GitHub Copilot session (#1928).
  //     flow/ resolves into the vault (outside the repo), which Copilot's realpath
  //     sandbox denies for writes; grant the resolved target on ~/.copilot's
  //     read-write allowlist. Fail-soft + idempotent — re-asserted every init.
  //     The orchestrator logs the 'granted'/skipped/error lines itself (it holds
  //     the logger); we only surface the otherwise-silent 'already-allowed' note.
  const copilot = ensureCopilotSandboxAccess(target, {
    env: process.env,
    platform: process.platform,
    logger: log,
  });
  if (copilot.status === 'already-allowed') {
    log.skip('Copilot sandbox: flow/ already writable');
  }

  // 2–7. Seed flow/'s templates — never into a knowledge repo (its contents
  //      are committed and synced by that repo, and when flow/ is absent each
  //      generator's ensureDir would pre-create the clone's destination).
  if (!flowUntouchable) {
    // 2. Generate tech foundation (programmatic scan)
    const techResult = generateTechFoundation(target, options);
    result.created.push(...techResult.created);
    result.skipped.push(...techResult.skipped);
    result.updated.push(...techResult.updated);

    // 3. Generate business context (interactive prompts)
    const bizResult = await generateBusinessContext(target, options);
    result.created.push(...bizResult.created);
    result.skipped.push(...bizResult.skipped);
    result.updated.push(...bizResult.updated);

    // 4. Generate tasklist
    const tasklistResult = generateTasklist(target, options);
    result.created.push(...tasklistResult.created);
    result.skipped.push(...tasklistResult.skipped);
    result.updated.push(...tasklistResult.updated);

    // 5. Generate project memory
    const memoryResult = generateMemory(target, options);
    result.created.push(...memoryResult.created);
    result.skipped.push(...memoryResult.skipped);
    result.updated.push(...memoryResult.updated);

    // 6. Generate heartbeat config
    const heartbeatResult = generateHeartbeat(target, options);
    result.created.push(...heartbeatResult.created);
    result.skipped.push(...heartbeatResult.skipped);
    result.updated.push(...heartbeatResult.updated);

    // 7. Generate project log
    const logResult = generateLog(target, options);
    result.created.push(...logResult.created);
    result.skipped.push(...logResult.skipped);
    result.updated.push(...logResult.updated);
  }

  // 7b. Resolve and persist the knowledge-sharing setting BEFORE the ignore
  //     block is generated from it. Unanswered stays local (silent-publish guard).
  //     A knowledge-repo project is not persisted: the committed block already
  //     states `separate`, and `.flowconfig` lives inside the clone.
  //     The committed block naming a knowledge repo wins over any answer: on a
  //     machine still linked to the vault (`vault-pending`) the vault's own
  //     `share: local` would otherwise regenerate a block without the pointer.
  const keepsKnowledgeRepo = keepsOwnKnowledgeRepo(target);
  if (keepsKnowledgeRepo && options.share !== undefined && options.share !== 'separate') {
    log.warn(`Knowledge sharing stays separate — this project keeps its knowledge in its own repository`);
  }
  const shareMode: ShareMode = keepsKnowledgeRepo ? 'separate' : resolveShareMode(target, options.share);
  if (!flowUntouchable && !keepsKnowledgeRepo && persistShareMode(target, shareMode)) {
    log.success(`Knowledge sharing: ${shareMode}`);
  }

  // 8. Update .gitignore with plan-flow entries
  const giResult = updateGitignore(target, platforms, options, shareMode);
  result.created.push(...giResult.created);
  result.skipped.push(...giResult.skipped);
  result.updated.push(...giResult.updated);

  // 8a. A shared project tracks the append-only stores, so a merge must union
  //     them rather than pick a side (read-time dedupe pays union's cost).
  if (shareMode === 'shared') {
    const attrs = updateGitattributes(target);
    if (attrs !== 'unchanged') {
      log.success(`.gitattributes: union-merge rule for the append-only stores (${attrs})`);
    }
    const captures = updateWorkingSetIgnore(target);
    if (captures.length > 0) {
      log.info(`${captures.length} auto-captured working set(s) kept out of git (personal, not features)`);
    }
  }

  // 8b. Exclude plan-flow's root symlinks from Tailwind v4's source scan (#644),
  //     so `flow/`/`graphify-out/` don't crash Turbopack's PostCSS resolver.
  const twResult = mitigateTailwindSources(target, options);
  result.created.push(...twResult.created);
  result.skipped.push(...twResult.skipped);
  result.updated.push(...twResult.updated);

  // 9. Register project in central vault (~/plan-flow/brain/) — never for a
  //    project the Flow app manages: its knowledge lives in a Workspace.
  if (options.workspaceManaged !== true) {
    const vaultResult = registerVault(target, options);
    result.created.push(...vaultResult.created);
    result.skipped.push(...vaultResult.skipped);
    result.updated.push(...vaultResult.updated);
  }

  // 10. Scan legacy artifacts to populate brain — it rewrites markdown in
  //     place, so a knowledge repo is skipped like every other flow/ writer.
  //     So is a Workspace project: its documents are the TEAM's synced
  //     knowledge, not legacy artifacts, and the scan stamps
  //     `**Project**: [[<this checkout's folder name>]]` into each one and
  //     mints feature notes from them — an edit to everyone's documents named
  //     after one machine's directory, made again by every machine that
  //     provisions (found by workspace-e2e.test.ts).
  if (!flowUntouchable && !inWorkspace) {
    const legacyResult = scanLegacyArtifacts(target, options);
    result.created.push(...legacyResult.created);
    result.skipped.push(...legacyResult.skipped);
    result.updated.push(...legacyResult.updated);
  }

  // 11. Seed the tracked `loops/` directives — PAUSED, and bound to this
  //     project's own remote only when one actually resolves. A provisioned
  //     project with no directives is a `/beat fix` that fails with "no
  //     directive for loop 'fix'", which is exactly how this step was found
  //     missing. Never overwrites: a `loops/` with anything in it is left alone.
  const loopsResult = seedLoopDirectives(target);
  result.created.push(...loopsResult.created);
  result.skipped.push(...loopsResult.skipped);
  result.updated.push(...loopsResult.updated);

  return result;
}
