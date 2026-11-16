/**
 * WHERE A PIECE OF KNOWLEDGE WAS LEARNED.
 *
 * Every description write — a `## Learned` line, a part learning, an
 * investigation note, a feature view — says which code it describes: the
 * branch and HEAD commit of the checkout it was learned in, whether that
 * commit is on the default branch, and the SHA-256 of each file it cites. That
 * is what lets a later check call it a **draft** (learned on a branch that has
 * not merged) or **solid** (learned on the default branch), and promote a draft
 * once its code lands (discovery `workspace_knowledge_draft_solid`, FR-1).
 *
 * ── THE WRITER STAMPS, NEVER THE CALLER ────────────────────────────────────
 *
 * `stampProvenance` is called INSIDE the store writers (`writeLearned`,
 * `writeParts`, `writeFeatureView`, `appendInvestigationNote`), from the
 * checkout the CLI runs in. The verbs refuse a caller-supplied `learnedAt`. A
 * stamp a caller could choose is a stamp a caller could forge, and a forged
 * "learned on main" is exactly the draft-presented-as-truth this exists to stop
 * (allowed-pattern #25: the subject of a gate never comes from the artifact).
 *
 * ── ONE NAME: `learnedAt` ──────────────────────────────────────────────────
 *
 * Items carry a COMPACT reference — `learnedAt: <16 hex>` — never the stamp
 * itself. The full stamp (branch, commit, onDefault, hashes) is one line of
 * `flow/brain/.structure/knowledge-provenance.jsonl`, content-addressed: the id
 * is a digest of the canonical record, so the same stamp always gets the same
 * id and the same bytes, and the union merge that syncs the store removes the
 * duplicates two machines write. A `## Learned` line cannot hold a hash per
 * cited file; a 16-character reference fits beside the existing comment.
 *
 * The human `provenance` tag (`code` | `human` | `plan:<name>`) is a different
 * claim — WHO taught it — and is untouched.
 *
 * ── NOT A CHECKOUT ⇒ NOT STAMPED ───────────────────────────────────────────
 *
 * A folder that is not a git checkout has no branch to be a draft of. The
 * writers then write no `learnedAt`, and unstamped knowledge resolves as solid
 * (FR-13) — the same answer every item written before this existed gets.
 * Git is asked only about the folder itself (`GIT_CEILING_DIRECTORIES` is its
 * parent), so a scratch folder inside some other repository is never stamped
 * with that repository's branch.
 *
 * Every git call is bounded by `GIT_TIMEOUT_MS` (NFR-1). This is the CLI's own
 * process, so a synchronous child blocks nobody else.
 */
// A namespace import, not a named one: eight suites mock `node:child_process`
// with a factory that lists only what THEY use, and a named import missing
// from such a factory is a module-link error under ESM jest for every suite
// that reaches a store writer. Absent, the call below throws, is caught, and
// the folder reads as "not a checkout" — the unstamped path.
import * as childProcess from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BLUEPRINT_DIRNAME, hashFileContent, hashRepoFile } from '../blueprint/store.js';
import { defaultBranchRef } from '../handlers/knowledge-landing.js';
import type { WorkspaceGit } from '../handlers/workspace-model.js';
import { parseFlowConfig } from './flowconfig-parser.js';
import { canonicalProvenanceBody, parseProvenanceRecordLine, type KnowledgeProvenance } from './knowledge-status-fold.js';

/** The one field name every item uses for its provenance reference. */
export const LEARNED_AT_FIELD = 'learnedAt';

/** A provenance reference: the first 16 hex characters of the record digest. */
export { LEARNED_AT_RE } from './knowledge-status-fold.js';

/** Where the provenance records live, relative to `flow/`. */
export const KNOWLEDGE_PROVENANCE_FILENAME = 'knowledge-provenance.jsonl';

/** Each git call's bound. Local reads only — nothing here talks to a remote. */
const GIT_TIMEOUT_MS = 15_000;

// The record's shape and its canonical bytes live in the pure module the app
// also compiles (`knowledge-status-fold.ts`).
export type { KnowledgeProvenance, ProvenanceHash } from './knowledge-status-fold.js';

interface GitResult {
  status: number | null;
  stdout: Buffer;
}

/**
 * Run git in `cwd` only. The variables that would point git at another
 * repository are cleared — the same intent as `workspaceGitEnv`, inlined here
 * because importing the Workspace model would close an import cycle back into
 * the feature store.
 */
function git(args: string[], cwd: string): GitResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE']) {
    delete env[key];
  }
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(cwd));
  try {
    const result = childProcess.spawnSync('git', args, {
      cwd,
      env,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error !== undefined) return { status: null, stdout: Buffer.alloc(0) };
    return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0) };
  } catch {
    return { status: null, stdout: Buffer.alloc(0) };
  }
}

function gitText(args: string[], cwd: string): string | null {
  const result = git(args, cwd);
  if (result.status !== 0) return null;
  const text = result.stdout.toString('utf-8').trim();
  return text === '' ? null : text;
}

/** `defaultBranchRef` speaks `WorkspaceGit` (throw on non-zero); adapt to it. */
const asWorkspaceGit: WorkspaceGit = (args, cwd) => {
  const result = git(args, cwd);
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ''} failed`);
  return result.stdout.toString('utf-8');
};

/** Repo root is a checkout when git answers for exactly this folder. */
function isCheckout(repoRoot: string): boolean {
  return existsSync(repoRoot) && gitText(['rev-parse', '--git-dir'], repoRoot) !== null;
}

/** The project's Base branch setting (`branch:` in `flow/.flowconfig`), or null. */
function baseBranchSetting(repoRoot: string): string | null {
  try {
    const branch = parseFlowConfig(join(repoRoot, 'flow')).branch;
    return typeof branch === 'string' && branch.trim() !== '' ? branch.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The default branch's ref for `repoRoot` — the FR-14 ladder: the project's
 * Base branch setting, then `origin/HEAD`, then `main` / `master`. Never
 * fetches. Null when no rung resolves.
 */
export function defaultBranchOf(repoRoot: string): string | null {
  if (!isCheckout(repoRoot)) return null;
  return defaultBranchRef(asWorkspaceGit, repoRoot, baseBranchSetting(repoRoot));
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Record where knowledge is being learned: the cwd checkout's branch and HEAD,
 * whether HEAD is on the default branch, and each cited file's digest through
 * `hashRepoFile` (the one digest). Pure read; writes nothing.
 */
export function stampProvenance(repoRoot: string, citedFiles: readonly string[]): KnowledgeProvenance {
  const hashes = new Map<string, string>();
  for (const raw of citedFiles) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const path = normalizeRelPath(raw.trim());
    if (path === '' || hashes.has(path)) continue;
    const result = hashRepoFile(repoRoot, path);
    // A directory reads as an error and lands here too: only files have a digest.
    if (result.status === 'ok') hashes.set(path, result.contentHash);
  }
  const sortedHashes = [...hashes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, contentHash]) => ({ path, contentHash }));

  if (!isCheckout(repoRoot)) {
    return { branch: null, commit: null, onDefault: null, hashes: sortedHashes };
  }
  const branch = gitText(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoRoot);
  const commit = gitText(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], repoRoot);
  let onDefault: boolean | null = null;
  if (commit !== null) {
    const ref = defaultBranchRef(asWorkspaceGit, repoRoot, baseBranchSetting(repoRoot));
    if (ref !== null) {
      // Exit 0 = ancestor (or equal), 1 = not, anything else = git could not say.
      const status = git(['merge-base', '--is-ancestor', commit, ref], repoRoot).status;
      onDefault = status === 0 ? true : status === 1 ? false : null;
    }
  }
  return { branch, commit, onDefault, hashes: sortedHashes };
}

/**
 * The digest of `path` as it is at `ref`, through `hashFileContent` — so a
 * stamp and a later check share one digest. Null when the file is absent at
 * that ref, the ref does not exist, or git refused.
 *
 * Raw blob bytes: a checkout that converts line endings on checkout
 * (`core.autocrlf`) hashes differently in the working tree than at a revision.
 */
export function hashFileAtRevision(repoRoot: string, ref: string, path: string): string | null {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-')) return null;
  const rel = normalizeRelPath(path);
  if (rel === '' || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  if (!isCheckout(repoRoot)) return null;
  // Only a blob has file content; a tree at that path is not "the file".
  if (gitText(['cat-file', '-t', `${ref}:${rel}`], repoRoot) !== 'blob') return null;
  const result = git(['show', `${ref}:${rel}`], repoRoot);
  if (result.status !== 0) return null;
  return hashFileContent(result.stdout);
}

// ── The record store ────────────────────────────────────────────────────────

function canonicalBody(provenance: KnowledgeProvenance): string {
  return canonicalProvenanceBody(provenance);
}

/** The content address of a stamp — the value an item carries as `learnedAt`. */
export function provenanceId(provenance: KnowledgeProvenance): string {
  return hashFileContent(canonicalBody(provenance)).slice(0, 16);
}

/** The one line a stamp is stored as. Same stamp ⇒ same bytes. */
export function provenanceLine(provenance: KnowledgeProvenance): string {
  return `{"id":${JSON.stringify(provenanceId(provenance))},${canonicalBody(provenance).slice(1)}`;
}

function provenancePath(flowDir: string): string {
  return join(flowDir, BLUEPRINT_DIRNAME, KNOWLEDGE_PROVENANCE_FILENAME);
}

function parseRecord(line: string): [string, KnowledgeProvenance] | null {
  // A line whose id does not match its body was not written by this module.
  return parseProvenanceRecordLine(line, hashFileContent);
}

/** Every stored stamp by id. Corrupt or foreign lines are skipped. */
export function readProvenanceRecords(flowDir: string): Map<string, KnowledgeProvenance> {
  const out = new Map<string, KnowledgeProvenance>();
  const filePath = provenancePath(flowDir);
  if (!existsSync(filePath)) return out;
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseRecord(line);
    if (parsed !== null && !out.has(parsed[0])) out.set(parsed[0], parsed[1]);
  }
  return out;
}

/**
 * Store a stamp and return its id. The ONLY writer of the record store.
 * Appends nothing when the id is already there; a race that writes it twice
 * writes the same bytes twice, which every reader (and the union merge) folds.
 */
export function recordProvenance(flowDir: string, provenance: KnowledgeProvenance): string {
  const id = provenanceId(provenance);
  if (readProvenanceRecords(flowDir).has(id)) return id;
  const filePath = provenancePath(flowDir);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${provenanceLine(provenance)}\n`, 'utf-8');
  return id;
}

/**
 * What the store writers call: stamp from `repoRoot`, record it, return the
 * `learnedAt` reference — or null when `repoRoot` is not a checkout (nothing
 * to stamp; the item stays unstamped and resolves as solid).
 */
export function stampLearnedAt(flowDir: string, repoRoot: string, citedFiles: readonly string[]): string | null {
  const provenance = stampProvenance(repoRoot, citedFiles);
  if (provenance.commit === null) return null;
  return recordProvenance(flowDir, provenance);
}

/** The repository a `flow/` folder belongs to when no root is given. */
export function repoRootOfFlowDir(flowDir: string): string {
  return dirname(resolve(flowDir));
}
