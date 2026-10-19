/**
 * THE WORKSPACE MODEL — the on-disk shape of Workspaces, project identity, the
 * `flow` link, and every operation the `workspace` verbs perform.
 *
 * A Workspace groups projects and owns their knowledge. On disk:
 *
 *   <Flow folder>/                        resolveFlowFolder() — utils/files.ts
 *     projects.local.json                 project id → this machine's checkout (personal, never synced)
 *     settings/                           (later phases)
 *     workspaces/<w>/                     ONE git repository per Workspace
 *       workspace.json                    { name, slug, remote?, projects: [{ id, name, slug, remotes[], description? }] }
 *       projects/<p>/                     the project's knowledge — what `<repo>/flow` links to
 *
 * `<repo>/flow` stays the interface every agent, skill and command uses; it is
 * a link into `projects/<p>/`. Nothing that reads or writes `flow/` changes.
 *
 * ONE CODE PATH (allowed-pattern #14): the CLI verbs, provisioning
 * (`initShared`) and — through the CLI — the app all go through the functions
 * here. Nobody else derives a Workspace path.
 *
 * Project identity is the git remote identity (`remoteIdentity`, the grammar
 * pinned to `app/src/shared/git-remote-fixtures.json`), never a basename: two
 * repos called `app` are two projects. A repo with no remote can still join as
 * a local-only project (`local:<slug>`) — it cannot be matched on another
 * machine until it has one.
 *
 * Old knowledge is NEVER deleted (FR-6, D-9). With `import` (the hard
 * migration, decision 2026-10-06) it is first COPIED into the project folder
 * (`workspace-import.ts`); either way the original stays as the backup:
 *   - a `flow` LINK (the vault) → only the link is replaced; its target stays;
 *   - a real `flow/` git does not track → renamed `flow.pre-workspace-<date>/`;
 *   - a `flow/` that is its own knowledge repo (has `.git`) → with `import`,
 *     renamed `flow.pre-workspace-<date>/` like any untracked folder (its
 *     history stays in it); without, refused (`keeps-own-knowledge-repo`);
 *   - a `flow/` COMMITTED in the code repo → refused until a person has seen
 *     the commit it takes (message + file count); confirmed, it is
 *     `git mv flow flow.pre-workspace` in ONE commit, refused on a dirty tree.
 *
 * Every refusal is a `WorkspaceRefusal` whose payload carries what the asking
 * surface needs to put the question (allowed-pattern #21). Every refusal is
 * decided BEFORE anything is written (allowed-pattern #24's other half).
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { QUIET_CHILD_STDIO } from '../utils/child-stdio.js';
import { createSymlink, getVaultDir, isSymlink, readSymlinkTarget, resolveFlowFolder } from '../utils/files.js';
import { parseGitRemote, remoteIdentity } from './knowledge-migration.js';
import {
  upsertReadmeBlock,
  upsertWorkspaceBlock,
  workspaceGitattributes,
  workspaceGitignore,
  workspaceReadme,
} from './knowledge-classes.js';
import { writeBrainIndex } from '../state/brain-index.js';
import { locateWorkspaceProject } from './workspace-locate.js';
import { EMPTY_IMPORT, applyKnowledgeImport, planKnowledgeImport, type ImportPlan, type ImportReport } from './workspace-import.js';

// ─── Names on disk ──────────────────────────────────────────────────────────

export const WORKSPACES_DIRNAME = 'workspaces';
export const SETTINGS_DIRNAME = 'settings';
export const PROJECTS_LOCAL_FILENAME = 'projects.local.json';
export const WORKSPACE_FILENAME = 'workspace.json';
export const WORKSPACE_PROJECTS_DIRNAME = 'projects';
/** A committed `flow/` is renamed to this in the code repo's one commit. */
export const COMMITTED_FLOW_BACKUP = 'flow.pre-workspace';
/** An untracked `flow/` is renamed to `<this><YYYYMMDD>`. */
export const UNTRACKED_FLOW_BACKUP_PREFIX = 'flow.pre-workspace-';
/** The id prefix of a project whose repo has no remote. */
export const LOCAL_PROJECT_ID_PREFIX = 'local:';
/** A Workspace being cloned sits under this hidden name until it has been read. */
const JOIN_STAGING_PREFIX = '.joining-';

/**
 * The standard flow layout a project folder starts with — the same list
 * `initShared` scaffolds for a fresh `flow/` (handlers/shared.ts FLOW_SUBDIRS).
 * Restated rather than imported because shared.ts imports THIS module, and a
 * static cycle would leave one side's bindings undefined at load. A test pins
 * the two lists equal.
 */
export const WORKSPACE_PROJECT_SUBDIRS = [
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
] as const;

const CODE_RENAME_COMMIT = 'chore(plan-flow): keep the old flow/ as flow.pre-workspace — knowledge now lives in the Workspace';

/** A slug: lowercase words joined by single dashes. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 64;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 4000;
/** How long one local git call may take. */
const LOCAL_GIT_TIMEOUT_MS = 60_000;
/** How long a clone may take. */
const NETWORK_GIT_TIMEOUT_MS = 300_000;
/** The transports a Workspace's git may use (production). */
export const WORKSPACE_GIT_PROTOCOLS = 'https:ssh';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkspaceProject {
  /** The remote identity (`host/owner/repo`), or `local:<slug>` for a repo with no remote. */
  id: string;
  name: string;
  /** Folder name under `projects/` — unique within the Workspace. */
  slug: string;
  /** Every address this project has been seen under (forks, mirrors, transports). */
  remotes: string[];
  description?: string;
}

export interface WorkspaceFile {
  name: string;
  slug: string;
  remote?: string;
  projects: WorkspaceProject[];
}

/** A Workspace as read on THIS machine. `slug` is the folder name here. */
export interface LoadedWorkspace {
  slug: string;
  path: string;
  file: WorkspaceFile;
  /** The parsed JSON as read — unknown keys are written back untouched. */
  raw: Record<string, unknown>;
}

export type WorkspaceRefusalReason =
  | 'invalid-pair'
  | 'invalid-model-outcome'
  | 'pair-not-ready'
  | 'answer-with-outcome'
  | 'answer-unreadable'
  | 'invalid-name'
  | 'invalid-remote'
  | 'insecure-remote'
  | 'credentials-in-url'
  | 'no-workspace'
  | 'which-workspace'
  | 'unknown-workspace'
  | 'unknown-project'
  | 'not-a-git-repo'
  | 'unreadable-remote'
  | 'committed-flow'
  | 'dirty-code'
  | 'keeps-own-knowledge-repo'
  | 'linked-elsewhere'
  | 'malformed-workspace'
  /** The REMOTE is not a Flow Workspace — about a repository, never about this computer. */
  | 'not-a-workspace-repo'
  | 'malformed-local-map'
  | 'already-joined'
  | 'clone-failed'
  | 'commit-failed'
  | 'invalid-link-kind'
  | 'invalid-link-address'
  | 'same-project'
  // workspace sync (workspace-sync.ts)
  | 'personal-files'
  | 'no-identity'
  | 'sync-busy'
  | 'merge-in-progress'
  | 'detached-head'
  | 'merge-failed'
  | 'nothing-to-resolve'
  | 'invalid-resolution'
  /** `--id` names an ask/review whose content changed since it was shown. */
  | 'stale-decision'
  /** The incoming side carries a personal file, a symlink or a repo-settings change. */
  | 'incoming-unsafe'
  /** The remote's history was rewritten (the new tip does not descend from the last one seen). */
  | 'remote-rewritten'
  | 'invalid-description'
  // workspace move-flow-folder (workspace-move.ts)
  | 'same-folder'
  | 'target-inside'
  | 'target-not-empty'
  | 'nothing-to-move'
  /** Nothing would remember the new location — needs `--confirm`. */
  | 'move-not-persisted'
  // the hard migration (workspace-migrate.ts / workspace-admin.ts)
  /** `migrate --roots` is not a JSON array of absolute paths. */
  | 'invalid-roots'
  /** Another Workspace on this machine already has that name. */
  | 'duplicate-name'
  /** move-project: the project is already in that Workspace. */
  | 'same-workspace'
  /** move-project: the target Workspace already lists a project with that id. */
  | 'project-exists'
  /** delete: the Default Workspace is where projects go — it is never deleted. */
  | 'default-workspace'
  /** delete: needs `--confirm`; the payload lists what would move. */
  | 'unconfirmed'
  // connecting a Workspace to a shared repository (workspace-remote.ts / workspace-sync.ts)
  /** set-remote: the Workspace already has a different shared repository — needs `--replace`. */
  | 'remote-exists'
  /** sync: the shared repository holds a history that has nothing in common with this Workspace's. */
  | 'unrelated-history'
  | 'failed';

/**
 * A refusal that answers: `sentence` is what a person reads; `payload` is what
 * the asking surface needs (allowed-pattern #21) — `{ refused, detail, ... }`.
 */
export class WorkspaceRefusal extends Error {
  readonly reason: WorkspaceRefusalReason;
  readonly sentence: string;
  readonly payload: Record<string, unknown>;

  constructor(reason: WorkspaceRefusalReason, sentence: string, extra: Record<string, unknown> = {}) {
    super(`${reason} — ${sentence}`);
    this.name = 'WorkspaceRefusal';
    this.reason = reason;
    this.sentence = sentence;
    this.payload = { refused: reason, detail: sentence, ...extra };
  }
}

// ─── Git ────────────────────────────────────────────────────────────────────

export interface WorkspaceGitOptions {
  /** Talks to a remote (clone). */
  network?: boolean;
}

/** Run git, return stdout, throw on a non-zero exit. */
export type WorkspaceGit = (args: string[], cwd: string, options?: WorkspaceGitOptions) => string;

/**
 * Variables cleared for every child: traces (they can print request headers)
 * and the ones that would point git at a repository other than the folder it
 * runs in. The same list as the app's knowledge git runner
 * (`app/src/main/knowledge-sync/git-runner.ts`).
 */
const CLEARED_GIT_ENV = [
  'GIT_TRACE',
  'GIT_TRACE_CURL',
  'GIT_TRACE_CURL_NO_DATA',
  'GIT_TRACE_PACKET',
  'GIT_TRACE_PACK_ACCESS',
  'GIT_TRACE_PERFORMANCE',
  'GIT_TRACE_SETUP',
  'GIT_TRACE2',
  'GIT_TRACE2_EVENT',
  'GIT_TRACE2_PERF',
  'GIT_CURL_VERBOSE',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
] as const;

/**
 * The transports for THIS process — mirrors the app's `knowledgeGitProtocols`.
 * Production is always https + ssh. A hidden end-to-end run (`FLOW_E2E=1`)
 * may name its own list in `FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS`, so a test can
 * reach a local bare repository (`file`) and nothing else.
 */
export function workspaceGitProtocols(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS;
  if (env.FLOW_E2E === '1' && typeof override === 'string' && /^[a-z]+(?::[a-z]+)*$/.test(override)) return override;
  return WORKSPACE_GIT_PROTOCOLS;
}

/**
 * The environment one Workspace git child gets (NFR-4): https/ssh only, the
 * repository search stopped at the working folder's parent (a folder whose
 * `.git` is gone FAILS instead of finding the repository around it), traces
 * cleared, and no terminal prompt for a network call. Passed EXPLICITLY — a
 * host that sandboxes `process.env` would otherwise hand children the outer one.
 */
export function workspaceGitEnv(base: NodeJS.ProcessEnv, cwd: string, network: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of CLEARED_GIT_ENV) delete env[key];
  env.GIT_CEILING_DIRECTORIES = dirname(resolve(cwd));
  env.GIT_ALLOW_PROTOCOL = workspaceGitProtocols(base);
  if (network) env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

export const defaultWorkspaceGit: WorkspaceGit = (args, cwd, options = {}) => {
  const network = options.network === true;
  return execFileSync('git', args, {
    encoding: 'utf-8',
    cwd,
    env: workspaceGitEnv(process.env, cwd, network),
    timeout: network ? NETWORK_GIT_TIMEOUT_MS : LOCAL_GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: [...QUIET_CHILD_STDIO],
  });
};

function tryGit(git: WorkspaceGit, args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function errorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : error instanceof Error ? error.message : String(error);
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 239)}…` : collapsed;
}

// ─── Injected collaborators ────────────────────────────────────────────────

export interface WorkspaceDeps {
  git: WorkspaceGit;
  now: () => Date;
}

const DEFAULT_DEPS: WorkspaceDeps = { git: defaultWorkspaceGit, now: () => new Date() };

export interface WorkspaceContext {
  /** The Flow folder. Defaults to `resolveFlowFolder()`. */
  flowFolder?: string;
  deps?: Partial<WorkspaceDeps>;
}

export function contextOf(context: WorkspaceContext): { flowFolder: string; deps: WorkspaceDeps } {
  return { flowFolder: resolve(context.flowFolder ?? resolveFlowFolder()), deps: { ...DEFAULT_DEPS, ...context.deps } };
}

// ─── Paths ──────────────────────────────────────────────────────────────────

export function workspacesDir(flowFolder: string): string {
  return join(flowFolder, WORKSPACES_DIRNAME);
}

export function workspaceDir(flowFolder: string, slug: string): string {
  return join(workspacesDir(flowFolder), slug);
}

export function projectFolder(flowFolder: string, workspaceSlug: string, projectSlug: string): string {
  return join(workspaceDir(flowFolder, workspaceSlug), WORKSPACE_PROJECTS_DIRNAME, projectSlug);
}

export function projectsLocalPath(flowFolder: string): string {
  return join(flowFolder, PROJECTS_LOCAL_FILENAME);
}

/** The real path when it exists (symlinks like /var → /private/var resolved), else the resolved one. */
export function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// ─── Slugs ──────────────────────────────────────────────────────────────────

/** A slug from a name: lowercase ASCII words joined by dashes. May be empty. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

/** `base`, or `base-2`, `base-3`, … — the first one not taken. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function isSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value);
}

// ─── workspace.json ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function isName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_NAME_LENGTH && !CONTROL_CHARACTERS.test(value);
}

/**
 * Validate a parsed `workspace.json`. Returns the problem as a sentence, or
 * null. A committed file is the most dangerous input there is (anybody who can
 * push to the Workspace writes it), so every remote in it passes the address
 * grammar too (allowed-pattern #22: validate, never rewrite).
 */
export function workspaceFileProblem(value: unknown): string | null {
  if (!isRecord(value)) return 'it is not a JSON object';
  if (!isName(value.name)) return 'its name is missing or not a plain name';
  if (!isSlug(value.slug)) return 'its slug is missing or not lowercase words joined by dashes';
  if (value.remote !== undefined) {
    if (typeof value.remote !== 'string' || !parseGitRemote(value.remote).ok) return 'its remote is not a repository address Flow can use';
  }
  if (!Array.isArray(value.projects)) return 'it has no project list';
  const ids = new Set<string>();
  const slugs = new Set<string>();
  for (const [index, project] of value.projects.entries()) {
    const where = `project ${index + 1}`;
    if (!isRecord(project)) return `${where} is not an object`;
    if (typeof project.id !== 'string' || project.id.trim() === '' || project.id.length > 512 || /\s/.test(project.id)) {
      return `${where} has no usable id`;
    }
    if (!isName(project.name)) return `${where} has no usable name`;
    if (!isSlug(project.slug)) return `${where} has a slug that is not lowercase words joined by dashes`;
    if (!Array.isArray(project.remotes) || !project.remotes.every((remote) => typeof remote === 'string' && parseGitRemote(remote).ok)) {
      return `${where} lists a remote that is not a repository address Flow can use`;
    }
    if (project.description !== undefined && (typeof project.description !== 'string' || project.description.length > MAX_DESCRIPTION_LENGTH)) {
      return `${where} has a description that is not text`;
    }
    if (ids.has(project.id)) return `two projects share the id ${project.id}`;
    if (slugs.has(project.slug)) return `two projects share the folder name ${project.slug}`;
    ids.add(project.id);
    slugs.add(project.slug);
  }
  return null;
}

/** Read and validate one Workspace's file. Refuses a malformed one with a sentence. */
export function readWorkspace(flowFolder: string, slug: string): LoadedWorkspace {
  const path = workspaceDir(flowFolder, slug);
  const filePath = join(path, WORKSPACE_FILENAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new WorkspaceRefusal(
      'malformed-workspace',
      missing
        ? `the Workspace folder ${slug} has no ${WORKSPACE_FILENAME}, so it is not a Flow Workspace`
        : `the Workspace ${slug} has a ${WORKSPACE_FILENAME} that is not valid JSON`,
      { workspace: slug, path }
    );
  }
  const problem = workspaceFileProblem(parsed);
  if (problem !== null) {
    throw new WorkspaceRefusal('malformed-workspace', `the Workspace ${slug} can't be read: ${problem}`, { workspace: slug, path });
  }
  const raw = parsed as Record<string, unknown>;
  return { slug, path, raw, file: raw as unknown as WorkspaceFile };
}

/** Write a Workspace's file — unknown keys it was read with are kept. */
export function writeWorkspace(workspace: LoadedWorkspace): void {
  const out = { ...workspace.raw, ...workspace.file };
  if (workspace.file.remote === undefined) delete (out as Record<string, unknown>).remote;
  atomicWriteFile(join(workspace.path, WORKSPACE_FILENAME), `${JSON.stringify(out, null, 2)}\n`);
}

export interface WorkspaceScan {
  workspaces: LoadedWorkspace[];
  /** Folders under `workspaces/` that are not readable Workspaces — reported, never fatal to a scan. */
  unreadable: { workspace: string; detail: string }[];
}

/** Every Workspace on this machine, by folder name. */
export function scanWorkspaces(flowFolder: string): WorkspaceScan {
  const root = workspacesDir(flowFolder);
  const scan: WorkspaceScan = { workspaces: [], unreadable: [] };
  if (!existsSync(root)) return scan;
  for (const entry of readdirSync(root).sort()) {
    if (entry.startsWith('.')) continue;
    const full = join(root, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      scan.workspaces.push(readWorkspace(flowFolder, entry));
    } catch (error) {
      scan.unreadable.push({ workspace: entry, detail: error instanceof WorkspaceRefusal ? error.sentence : errorText(error) });
    }
  }
  return scan;
}

// ─── projects.local.json ────────────────────────────────────────────────────

/** project id → absolute checkout path on THIS machine. */
export type LocalProjectMap = Record<string, string>;

export function readLocalProjects(flowFolder: string): LocalProjectMap {
  const path = projectsLocalPath(flowFolder);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    throw new WorkspaceRefusal('malformed-local-map', `the list of this machine's project folders is not valid JSON`, { path });
  }
  if (!isRecord(parsed) || !isRecord(parsed.projects)) {
    throw new WorkspaceRefusal('malformed-local-map', `the list of this machine's project folders has no project map`, { path });
  }
  const map: LocalProjectMap = {};
  for (const [id, value] of Object.entries(parsed.projects)) {
    if (typeof value !== 'string' || (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value))) {
      throw new WorkspaceRefusal('malformed-local-map', `the list of this machine's project folders names a folder that is not an absolute path`, { path, project: id });
    }
    map[id] = value;
  }
  return map;
}

export function writeLocalProjects(flowFolder: string, map: LocalProjectMap): void {
  mkdirSync(flowFolder, { recursive: true });
  const sorted: LocalProjectMap = {};
  for (const id of Object.keys(map).sort()) sorted[id] = map[id];
  const path = projectsLocalPath(flowFolder);
  const content = `${JSON.stringify({ projects: sorted }, null, 2)}\n`;
  // UNCHANGED → UNTOUCHED. Every re-link of an already-linked project used to
  // rewrite this file with its own bytes (a new inode and mtime on each launch),
  // which made "who changed it?" unanswerable and woke anything watching it.
  try {
    if (readFileSync(path, 'utf-8') === content) return;
  } catch {
    // Absent or unreadable: write it.
  }
  atomicWriteFile(path, content);
}

// ─── settings/workspaces.local.json — this machine's Default Workspace ─────

/**
 * Which Workspace is the Default ON THIS MACHINE — where `workspace migrate`
 * puts projects, where `workspace delete` moves a deleted Workspace's
 * projects, and the one that can't be deleted. A LOCAL notion, never in the
 * synced `workspace.json`: two teammates sharing a Workspace each have their
 * own Default. Lives under `settings/`, so `move-flow-folder` carries it.
 */
export const WORKSPACE_DEFAULTS_FILENAME = 'workspaces.local.json';

export function workspaceDefaultsPath(flowFolder: string): string {
  return join(flowFolder, SETTINGS_DIRNAME, WORKSPACE_DEFAULTS_FILENAME);
}

/**
 * The Default Workspace's slug, or null when none is recorded, the record is
 * unreadable, or the Workspace it names is gone. A preference, so never a
 * refusal: an unreadable record is the same as no record.
 */
export function readDefaultWorkspace(flowFolder: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(workspaceDefaultsPath(flowFolder), 'utf-8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isSlug(parsed.default)) return null;
  return existsSync(join(workspaceDir(flowFolder, parsed.default), WORKSPACE_FILENAME)) ? parsed.default : null;
}

export function writeDefaultWorkspace(flowFolder: string, slug: string): void {
  mkdirSync(join(flowFolder, SETTINGS_DIRNAME), { recursive: true });
  atomicWriteFile(workspaceDefaultsPath(flowFolder), `${JSON.stringify({ default: slug }, null, 2)}\n`);
}

// ─── Repos and identity ─────────────────────────────────────────────────────

/** The repo's `origin` AS WRITTEN — never `remote get-url`, which applies `insteadOf`. */
export function originOf(repo: string, git: WorkspaceGit): string | null {
  const raw = tryGit(git, ['config', '--get', 'remote.origin.url'], repo);
  const url = raw?.trim() ?? '';
  return url === '' ? null : url;
}

/** Whether `repo` is the top of a git checkout (not a subfolder of one). */
export function isRepoRoot(repo: string, git: WorkspaceGit): boolean {
  const top = tryGit(git, ['rev-parse', '--show-toplevel'], repo);
  return top !== null && realOrResolved(top.trim()) === realOrResolved(repo);
}

function projectMatchesIdentity(project: WorkspaceProject, identity: string): boolean {
  if (project.id === identity) return true;
  return project.remotes.some((remote) => remoteIdentity(remote) === identity);
}

/** A display name for a project: the remote's repository name, else the folder name. */
function projectNameFor(repo: string, origin: string | null): string {
  if (origin !== null) {
    const identity = remoteIdentity(origin);
    if (identity !== null) return identity.split('/').pop() as string;
  }
  return basename(repo);
}

// ─── Public shapes ──────────────────────────────────────────────────────────

export interface WorkspaceSummary {
  name: string;
  slug: string;
  path: string;
  remote: string | null;
}

export interface ProjectView {
  id: string;
  name: string;
  slug: string;
  remotes: string[];
  description: string | null;
  /** This machine's checkout, or null when none is known. */
  localPath: string | null;
  /** The project's knowledge folder — what `<repo>/flow` links to. */
  flowPath: string;
}

export function summaryOf(workspace: LoadedWorkspace, git: WorkspaceGit): WorkspaceSummary {
  return {
    name: workspace.file.name,
    slug: workspace.slug,
    path: workspace.path,
    remote: workspace.file.remote ?? originOf(workspace.path, git),
  };
}

export function viewOf(flowFolder: string, workspace: LoadedWorkspace, project: WorkspaceProject, local: LocalProjectMap): ProjectView {
  const localPath = local[project.id];
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    remotes: [...project.remotes],
    description: project.description ?? null,
    localPath: localPath !== undefined && existsSync(localPath) ? localPath : null,
    flowPath: projectFolder(flowFolder, workspace.slug, project.slug),
  };
}

// ─── create ─────────────────────────────────────────────────────────────────

export interface CreateOptions extends WorkspaceContext {
  name: string;
  remote?: string;
}

export interface CreateResult {
  action: 'create';
  flowFolder: string;
  workspace: WorkspaceSummary;
  projects: ProjectView[];
  /** The local first commit (workspace.json + ignore/attributes), or null when git could not make one. */
  initialCommit?: string | null;
}

/**
 * Write the Workspace repo's `.gitignore`, `.gitattributes` and `README.md`
 * from the one sync-class table (knowledge-classes.ts). Only the generated
 * block is replaced — lines a person added outside it stay. Returns the files
 * changed.
 *
 * The README is generated for the same reason the ignore file is: it states
 * what the table does, so it cannot drift from the behaviour. It is also the
 * only answer a teammate gets when they open this repository in a browser and
 * find several hundred markdown files, no code and no entry point.
 */
export function writeWorkspaceRepoFiles(workspacePath: string, workspaceName?: string): string[] {
  const changed: string[] = [];
  for (const [name, block, upsert] of [
    ['.gitignore', workspaceGitignore(), upsertWorkspaceBlock],
    ['.gitattributes', workspaceGitattributes(), upsertWorkspaceBlock],
    // The name is read from the Workspace when the caller did not pass one, so
    // a README is never written titled after a folder slug.
    ['README.md', workspaceReadme(workspaceName ?? readWorkspaceName(workspacePath)), upsertReadmeBlock],
  ] as const) {
    const filePath = join(workspacePath, name);
    const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
    const next = upsert(existing, block);
    if (next === existing) continue;
    atomicWriteFile(filePath, next);
    changed.push(name);
  }
  return changed;
}

/** This Workspace's own name, or a neutral fallback when the file cannot be read. */
function readWorkspaceName(workspacePath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(workspacePath, WORKSPACE_FILENAME), 'utf-8')) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : 'This Workspace';
  } catch {
    return 'This Workspace';
  }
}

/** The refusal for an address the shared grammar does not accept, or null when it does. */
export function remoteRefusal(raw: string): WorkspaceRefusal | null {
  const verdict = parseGitRemote(raw);
  if (verdict.ok) return null;
  return new WorkspaceRefusal(verdict.reason, `that is not a repository address Flow can use: ${verdict.detail}`);
}

/**
 * Make a Workspace: its folder, a local git repository (no network) and its
 * `workspace.json`. Nothing is committed or pushed — that is `sync`'s job.
 */
export function createWorkspace(options: CreateOptions): CreateResult {
  const { flowFolder, deps } = contextOf(options);
  const name = options.name.trim();
  if (!isName(name)) throw new WorkspaceRefusal('invalid-name', 'a Workspace needs a plain name');
  const base = slugify(name);
  if (base === '') throw new WorkspaceRefusal('invalid-name', 'a Workspace name needs at least one letter or digit');
  if (options.remote !== undefined) {
    const refusal = remoteRefusal(options.remote);
    if (refusal !== null) throw refusal;
  }

  const root = workspacesDir(flowFolder);
  const taken = new Set(existsSync(root) ? readdirSync(root) : []);
  const slug = uniqueSlug(base, taken);
  const path = workspaceDir(flowFolder, slug);

  mkdirSync(join(path, WORKSPACE_PROJECTS_DIRNAME), { recursive: true });
  try {
    deps.git(['init', '-q', '-b', 'main'], path);
    if (options.remote !== undefined) deps.git(['remote', 'add', '--', 'origin', options.remote], path);
    const workspace: LoadedWorkspace = {
      slug,
      path,
      raw: {},
      file: { name, slug, ...(options.remote === undefined ? {} : { remote: options.remote }), projects: [] },
    };
    writeWorkspace(workspace);
    writeWorkspaceRepoFiles(path);
    // The first commit is local and best-effort: a machine with no git
    // identity yet still gets a usable Workspace, and `sync` commits later.
    const initialCommit =
      tryGit(deps.git, ['add', '--', WORKSPACE_FILENAME, '.gitignore', '.gitattributes', 'README.md'], path) === null ||
      tryGit(deps.git, ['commit', '-q', '-m', `chore(plan-flow): start the ${name} Workspace`], path) === null
        ? null
        : tryGit(deps.git, ['rev-parse', 'HEAD'], path)?.trim() ?? null;
    return { action: 'create', flowFolder, workspace: summaryOf(workspace, deps.git), projects: [], initialCommit };
  } catch (error) {
    // The folder is ours and brand new — nothing of the person's is in it.
    rmSync(path, { recursive: true, force: true });
    if (error instanceof WorkspaceRefusal) throw error;
    throw new WorkspaceRefusal('failed', `the Workspace could not be started: ${errorText(error)}`);
  }
}

// ─── link ───────────────────────────────────────────────────────────────────

export interface LinkOptions extends WorkspaceContext {
  /** The code repository. */
  target: string;
  /** The Workspace (slug or name). Optional when only one could be meant. */
  workspace?: string;
  /** Map this repo onto an EXISTING project of the Workspace (id or slug) — forks, mirrors, no remote. */
  project?: string;
  /** A person has seen the commit a committed `flow/` takes, and wants it. */
  confirmCommit?: boolean;
  /**
   * Copy the knowledge `<repo>/flow` holds today into the project folder
   * before linking (`workspace-import.ts`), and rebuild its brain index.
   * Also what lets a project's own knowledge repo be linked at all.
   */
  import?: boolean;
}

/** What was at `<repo>/flow` before, and where it is now. Nothing is ever deleted. */
export type PreviousFlow =
  | { kind: 'none' }
  | { kind: 'workspace-link' }
  | { kind: 'link'; target: string | null }
  | { kind: 'folder'; keptAt: string }
  /** The project's own knowledge repo (a `flow/` with `.git`), kept whole — history and all. */
  | { kind: 'knowledge-repo'; keptAt: string }
  | { kind: 'committed-folder'; keptAt: string };

export interface LinkResult {
  action: 'link';
  flowFolder: string;
  workspace: WorkspaceSummary;
  project: ProjectView;
  /** `created` a new link, `unchanged` it already pointed here. */
  link: 'created' | 'unchanged';
  previous: PreviousFlow;
  /** The project entry was added to `workspace.json` by this call. */
  projectAdded: boolean;
  codeRepo: {
    /** How `flow` is kept out of the code repo's git. */
    ignored: 'already' | 'info-exclude';
    commit: { sha: string; message: string; files: number } | null;
  };
  /** What `--import` copied in; null when the call did not ask for it. */
  imported: ImportReport | null;
}

/** What is already known about the repo being linked — used to guess its Workspace. */
export interface RepoHints {
  identity: string | null;
  /** Project ids this machine has recorded for the repo's folder. */
  knownIds: readonly string[];
  /** The project the caller named (`--project`). */
  project?: string;
}

export function pickWorkspace(scan: WorkspaceScan, wanted: string | undefined, hints: RepoHints): LoadedWorkspace {
  const choices = scan.workspaces.map((workspace) => ({ slug: workspace.slug, name: workspace.file.name }));
  if (wanted !== undefined) {
    const found =
      scan.workspaces.find((workspace) => workspace.slug === wanted) ??
      scan.workspaces.find((workspace) => workspace.file.name === wanted) ??
      scan.workspaces.find((workspace) => workspace.slug === slugify(wanted));
    if (found === undefined) {
      throw new WorkspaceRefusal('unknown-workspace', `there is no Workspace called ${wanted} on this machine`, { workspaces: choices });
    }
    return found;
  }
  if (scan.workspaces.length === 0) {
    throw new WorkspaceRefusal('no-workspace', 'there is no Workspace on this machine yet — create or join one first', { workspaces: [] });
  }
  const holds = (project: WorkspaceProject): boolean =>
    (hints.project !== undefined && (project.id === hints.project || project.slug === hints.project)) ||
    hints.knownIds.includes(project.id) ||
    (hints.identity !== null && projectMatchesIdentity(project, hints.identity));
  const holding = scan.workspaces.filter((workspace) => workspace.file.projects.some(holds));
  if (holding.length === 1) return holding[0];
  if (scan.workspaces.length === 1) return scan.workspaces[0];
  throw new WorkspaceRefusal('which-workspace', 'there is more than one Workspace on this machine — say which one this project joins', {
    workspaces: choices,
  });
}

/** Which Workspace project folder a `flow` link points into, if any. */
export function workspaceLinkOf(flowFolder: string, linkPath: string): { workspace: string; project: string } | null {
  if (!isSymlink(linkPath)) return null;
  const stored = readSymlinkTarget(linkPath);
  if (stored === null) return null;
  const target = resolve(dirname(linkPath), stored);
  const root = workspacesDir(flowFolder);
  const candidates = [target, realOrResolved(target)];
  for (const candidate of candidates) {
    for (const base of [root, realOrResolved(root)]) {
      if (!isInside(candidate, base)) continue;
      const parts = relative(base, candidate).split(sep);
      if (parts.length === 3 && parts[1] === WORKSPACE_PROJECTS_DIRNAME) return { workspace: parts[0], project: parts[2] };
    }
  }
  return null;
}

/**
 * How many files the code repository commits under `flow` (a committed
 * symlink counts as one). THROWS — as a refusal — when git cannot answer:
 * "unknown" read as "none" would rename committed knowledge without its commit.
 */
function trackedFlowFiles(repo: string, git: WorkspaceGit): number {
  let out: string;
  try {
    out = git(['ls-files', '-z', '--', 'flow'], repo);
  } catch (error) {
    throw new WorkspaceRefusal('failed', `git could not say whether this project commits its flow folder, so nothing was changed: ${errorText(error)}`, {
      target: repo,
    });
  }
  return out.split('\0').filter((entry) => entry.length > 0).length;
}

function dirtyTrackedFiles(repo: string, git: WorkspaceGit): string[] {
  let out: string;
  try {
    out = git(['status', '--porcelain', '--untracked-files=no'], repo);
  } catch (error) {
    throw new WorkspaceRefusal('failed', `git could not say whether this project has uncommitted changes, so nothing was changed: ${errorText(error)}`, {
      target: repo,
    });
  }
  return out
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
}

export function stamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function freeSibling(repo: string, base: string): string {
  const taken = new Set(readdirSync(repo));
  return uniqueSlugLike(base, taken);
}

/** `base`, `base-2`, … for file names (which need not be slugs). */
function uniqueSlugLike(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Ensure the standard layout inside a project folder; existing folders are left alone. */
export function scaffoldProjectFolder(folder: string): string[] {
  const created: string[] = [];
  for (const subdir of WORKSPACE_PROJECT_SUBDIRS) {
    const dir = join(folder, subdir);
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gitkeep'), '', 'utf-8');
    created.push(dir);
  }
  return created;
}

/**
 * Keep `flow` (the link) and the renamed untracked folder out of the code
 * repo's `git status` — through the clone-local `info/exclude`, never the
 * committed `.gitignore` (the `knowledge` converters' rule: a project's
 * committed files change only in a commit a person reviewed).
 */
function ensureFlowIgnored(repo: string, git: WorkspaceGit): 'already' | 'info-exclude' {
  const wanted: string[] = [];
  if (tryGit(git, ['check-ignore', '-q', '--no-index', '--', 'flow'], repo) === null) wanted.push('/flow');
  const hasUntrackedBackup = readdirSync(repo).some((entry) => entry.startsWith(UNTRACKED_FLOW_BACKUP_PREFIX));
  if (hasUntrackedBackup && tryGit(git, ['check-ignore', '-q', '--no-index', '--', `${UNTRACKED_FLOW_BACKUP_PREFIX}x`], repo) === null) {
    wanted.push(`/${UNTRACKED_FLOW_BACKUP_PREFIX}*`);
  }
  if (wanted.length === 0) return 'already';
  const rel = git(['rev-parse', '--git-path', 'info/exclude'], repo).trim();
  const path = resolve(repo, rel);
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const missing = wanted.filter((line) => !existing.split('\n').includes(line));
  if (missing.length > 0) {
    mkdirSync(dirname(path), { recursive: true });
    const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
    writeFileSync(path, `${prefix}${missing.join('\n')}\n`, 'utf-8');
  }
  return 'info-exclude';
}

/** What linking would do to `<repo>/flow` — decided before anything is written. */
export type FlowPlan =
  | { kind: 'absent' }
  | { kind: 'here' }
  | { kind: 'link'; target: string | null }
  | { kind: 'untracked'; renameTo: string }
  | { kind: 'knowledge-repo'; renameTo: string }
  | { kind: 'committed'; renameTo: string; files: number };

function planFlow(
  flowFolder: string,
  repo: string,
  destination: { workspace: string; project: string },
  options: { confirmCommit: boolean; import: boolean },
  git: WorkspaceGit,
  now: Date
): FlowPlan {
  const flowPath = join(repo, 'flow');
  if (isSymlink(flowPath)) {
    const linked = workspaceLinkOf(flowFolder, flowPath);
    if (linked !== null) {
      if (linked.workspace === destination.workspace && linked.project === destination.project) return { kind: 'here' };
      throw new WorkspaceRefusal(
        'linked-elsewhere',
        `this project's knowledge already lives in the ${linked.workspace} Workspace, and a project's knowledge lives in one place`,
        { linkedTo: linked }
      );
    }
    // A link into ANOTHER Flow folder's Workspace (judged from the link's own
    // target, like `provisionWorkspaceLink` and `migrate`) is never taken over.
    // Live 2026-10-09: a run with a throwaway Flow folder (PLAN_FLOW_HOME in a
    // temp dir) linked a real checkout into itself; the temp folder was then
    // deleted and the checkout's `flow` dangled until the next launch healed it
    // — ENOTDIR/ENOENT on every reader in between.
    const elsewhere = locateWorkspaceProject(flowPath);
    if (elsewhere !== null) {
      throw new WorkspaceRefusal(
        'linked-elsewhere',
        `this project's knowledge already lives in the ${elsewhere.workspace} Workspace of another Flow folder, and a project's knowledge lives in one place`,
        { linkedTo: { workspace: elsewhere.workspace, project: elsewhere.project }, workspacePath: elsewhere.workspacePath }
      );
    }
    // A link the code repository COMMITS is a committed change like any
    // other: replacing it would leave a modified tracked file behind.
    if (trackedFlowFiles(repo, git) === 0) return { kind: 'link', target: readSymlinkTarget(flowPath) };
    return committedPlan(repo, options, git);
  }
  if (!existsSync(flowPath)) return { kind: 'absent' };
  if (!lstatSync(flowPath).isDirectory()) {
    throw new WorkspaceRefusal('failed', 'there is a file called flow in this project, where its knowledge link belongs', { path: flowPath });
  }
  if (existsSync(join(flowPath, '.git'))) {
    if (!options.import) {
      throw new WorkspaceRefusal(
        'keeps-own-knowledge-repo',
        'this project keeps its knowledge in its own repository — bring it in with --import: its content is copied into the Workspace and the repository is kept beside the project as a backup',
        { path: flowPath, needs: 'import' }
      );
    }
    // A nested repository is invisible to the code repo's index unless it was
    // committed as a gitlink — that one is a committed change like any other.
    if (trackedFlowFiles(repo, git) === 0) {
      return { kind: 'knowledge-repo', renameTo: freeSibling(repo, `${UNTRACKED_FLOW_BACKUP_PREFIX}${stamp(now)}`) };
    }
    return committedPlan(repo, options, git);
  }
  const files = trackedFlowFiles(repo, git);
  if (files === 0) {
    return { kind: 'untracked', renameTo: freeSibling(repo, `${UNTRACKED_FLOW_BACKUP_PREFIX}${stamp(now)}`) };
  }
  return committedPlan(repo, options, git, files);
}

/** A committed `flow` (folder or link): renamed in one commit, after the go-ahead, on a clean tree. */
function committedPlan(repo: string, options: { confirmCommit: boolean }, git: WorkspaceGit, known?: number): FlowPlan {
  const files = known ?? trackedFlowFiles(repo, git);
  const renameTo = freeSibling(repo, COMMITTED_FLOW_BACKUP);
  const commit = { message: CODE_RENAME_COMMIT, files, from: 'flow', to: renameTo };
  if (!options.confirmCommit) {
    throw new WorkspaceRefusal(
      'committed-flow',
      `this project commits its flow/ folder (${files} file${files === 1 ? '' : 's'}); joining renames it to ${renameTo} in one commit, which needs your go-ahead first`,
      { commit, needs: 'confirm-commit' }
    );
  }
  // The rename commit names its paths (`commit -- flow <renameTo>`), so work in
  // progress elsewhere neither rides along nor is touched — only an uncommitted
  // change to the knowledge folder itself could be swept in or lost.
  const touchesRename = (path: string): boolean =>
    [ 'flow', renameTo ].some((name) => path === name || path.startsWith(`${name}/`) || path.includes(` -> ${name}`));
  const dirty = dirtyTrackedFiles(repo, git).filter(touchesRename);
  if (dirty.length > 0) {
    throw new WorkspaceRefusal(
      'dirty-code',
      'the knowledge folder has uncommitted changes — commit or put them aside first, so the rename is the only thing in its commit',
      { files: dirty.slice(0, 50), commit }
    );
  }
  return { kind: 'committed', renameTo, files };
}

/** The `git mv` + one commit. Rolled back if the commit fails. */
function commitRename(repo: string, renameTo: string, git: WorkspaceGit): { sha: string; message: string } {
  git(['mv', '--', 'flow', renameTo], repo);
  try {
    // A pathspec: the commit carries the rename and nothing else staged.
    git(['commit', '-q', '-m', CODE_RENAME_COMMIT, '--', 'flow', renameTo], repo);
  } catch (error) {
    tryGit(git, ['reset', '-q', '--', 'flow', renameTo], repo);
    if (existsSync(join(repo, renameTo)) && !existsSync(join(repo, 'flow'))) renameSync(join(repo, renameTo), join(repo, 'flow'));
    tryGit(git, ['reset', '-q', '--', 'flow', renameTo], repo);
    throw new WorkspaceRefusal('commit-failed', `the rename could not be committed, so flow/ was put back as it was: ${errorText(error)}`, {
      restored: true,
    });
  }
  return { sha: git(['rev-parse', 'HEAD'], repo).trim(), message: CODE_RENAME_COMMIT };
}

/** Find (or add) the project this repo is, inside the chosen Workspace. */
function resolveProject(
  workspace: LoadedWorkspace,
  repo: string,
  origin: string | null,
  identity: string | null,
  wanted: string | undefined,
  knownIds: readonly string[]
): { project: WorkspaceProject; added: boolean; remoteAdded: boolean } {
  const projects = workspace.file.projects;
  if (wanted === undefined) {
    // This machine already linked this folder to a project here (a repo with no remote has no other name).
    const recorded = projects.find((project) => knownIds.includes(project.id));
    if (recorded !== undefined && (identity === null || projectMatchesIdentity(recorded, identity))) {
      return { project: recorded, added: false, remoteAdded: false };
    }
  }
  if (wanted !== undefined) {
    const found = projects.find((project) => project.id === wanted) ?? projects.find((project) => project.slug === wanted);
    if (found === undefined) {
      throw new WorkspaceRefusal('unknown-project', `the ${workspace.file.name} Workspace has no project ${wanted}`, {
        workspace: workspace.slug,
        projects: projects.map((project) => ({ id: project.id, name: project.name, slug: project.slug })),
      });
    }
    // A fork or a mirror: remember its address so it matches from now on.
    const remoteAdded = origin !== null && identity !== null && !projectMatchesIdentity(found, identity);
    return { project: remoteAdded ? { ...found, remotes: [...found.remotes, origin as string] } : found, added: false, remoteAdded };
  }
  if (identity !== null) {
    const found = projects.find((project) => projectMatchesIdentity(project, identity));
    if (found !== undefined) {
      const known = found.remotes.includes(origin as string);
      return { project: known ? found : { ...found, remotes: [...found.remotes, origin as string] }, added: false, remoteAdded: !known };
    }
  }
  const name = projectNameFor(repo, origin);
  const slug = uniqueSlug(slugify(name) || 'project', new Set(projects.map((project) => project.slug)));
  const id = identity ?? `${LOCAL_PROJECT_ID_PREFIX}${slug}`;
  if (identity === null && projects.some((project) => project.id === id)) {
    // A local-only id is only unique by its slug, which uniqueSlug already made unique.
    throw new WorkspaceRefusal('failed', 'this project could not be given a unique name in the Workspace');
  }
  return { project: { id, name, slug, remotes: origin === null ? [] : [origin] }, added: true, remoteAdded: false };
}

/**
 * Where a symlink inside the knowledge being imported may point, besides the
 * source itself: the project's vault folder (`<vault>/projects/<p>/`) — the
 * vault has shipped `flow/` shapes whose subdirectories link into it. Both the
 * vault folder the `flow` link resolves into and the one named after the
 * checkout count.
 */
function importRootsFor(repo: string, flowPath: string): string[] {
  const vaultProjects = realOrResolved(join(getVaultDir(), 'projects'));
  const roots = new Set<string>([join(vaultProjects, basename(repo))]);
  const real = realOrResolved(flowPath);
  if (isInside(real, vaultProjects)) roots.add(join(vaultProjects, relative(vaultProjects, real).split(sep)[0]));
  return [...roots];
}

/** What `<repo>/flow` holds today that `--import` copies: null when there is nothing to copy. */
function importSourceOf(plan: FlowPlan, flowPath: string): string | null {
  switch (plan.kind) {
    case 'link':
    case 'untracked':
    case 'knowledge-repo':
    case 'committed':
      return existsSync(flowPath) ? flowPath : null;
    case 'absent':
    case 'here':
      return null;
  }
}

/**
 * Everything `linkRepo` decides before it writes — shared with the dry run of
 * `workspace migrate`, so the preview and the real thing cannot disagree.
 */
export interface PreparedLink {
  flowFolder: string;
  deps: WorkspaceDeps;
  repo: string;
  workspace: LoadedWorkspace;
  project: WorkspaceProject;
  added: boolean;
  remoteAdded: boolean;
  folder: string;
  plan: FlowPlan;
  local: LocalProjectMap;
  /** The copy `--import` would make (read-only; null without `import`). */
  importPlan: ImportPlan | null;
}

export interface PrepareLinkOverrides {
  /**
   * Plan against this Workspace instead of one read from disk — the dry run's
   * Workspace that does not exist yet. Never used by a call that writes.
   */
  workspace?: LoadedWorkspace;
}

/**
 * Decide everything `linkRepo` would do — the Workspace, the project, what
 * happens to `<repo>/flow`, what `--import` copies — and write nothing. Every
 * refusal is thrown from here.
 */
export function prepareLink(options: LinkOptions, overrides: PrepareLinkOverrides = {}): PreparedLink {
  const { flowFolder, deps } = contextOf(options);
  const { git } = deps;
  const repo = realOrResolved(options.target);
  if (!existsSync(repo) || !isRepoRoot(repo, git)) {
    throw new WorkspaceRefusal('not-a-git-repo', 'that folder is not the top of a git repository', { target: repo });
  }

  const rawOrigin = originOf(repo, git);
  const identity = rawOrigin === null ? null : remoteIdentity(rawOrigin);
  // A remote Flow cannot read (an odd form, or one carrying a password or a
  // token) is not recorded and not matched on: the repo is a local-only
  // project (`local:<slug>`) unless the caller names the project. Nothing that
  // could hold a credential is ever written to the Workspace.
  const origin = identity === null ? null : rawOrigin;

  const local = readLocalProjects(flowFolder);
  const knownIds = Object.entries(local)
    .filter(([, path]) => realOrResolved(path) === repo)
    .map(([id]) => id);
  let workspace: LoadedWorkspace;
  if (overrides.workspace !== undefined) {
    workspace = overrides.workspace;
  } else {
    const scan = scanWorkspaces(flowFolder);
    if (options.workspace !== undefined) {
      const broken = scan.unreadable.find((entry) => entry.workspace === options.workspace);
      if (broken !== undefined) throw new WorkspaceRefusal('malformed-workspace', broken.detail, { workspace: broken.workspace });
    }
    workspace = pickWorkspace(scan, options.workspace, { identity, knownIds, project: options.project });
  }
  const { project, added, remoteAdded } = resolveProject(workspace, repo, origin, identity, options.project, knownIds);
  const folder = projectFolder(flowFolder, workspace.slug, project.slug);
  const doImport = options.import === true;

  const plan = planFlow(
    flowFolder,
    repo,
    { workspace: workspace.slug, project: project.slug },
    { confirmCommit: options.confirmCommit === true, import: doImport },
    git,
    deps.now()
  );
  const flowPath = join(repo, 'flow');
  const importPlan = doImport ? planKnowledgeImport(importSourceOf(plan, flowPath), folder, importRootsFor(repo, flowPath)) : null;
  return { flowFolder, deps, repo, workspace, project, added, remoteAdded, folder, plan, local, importPlan };
}

/**
 * Add a code repo to a Workspace and make its `flow` a link to the project's
 * folder there. Every refusal is decided before anything is written.
 */
export function linkRepo(options: LinkOptions): LinkResult {
  const prepared = prepareLink(options);
  const { flowFolder, deps, repo, workspace, project, added, remoteAdded, folder, plan, local } = prepared;
  const { git } = deps;

  // ── Nothing above wrote anything. From here on, every step is recorded. ──
  if (added || remoteAdded) {
    const projects = added
      ? [...workspace.file.projects, project]
      : workspace.file.projects.map((entry) => (entry.id === project.id ? project : entry));
    writeWorkspace({ ...workspace, file: { ...workspace.file, projects } });
  }
  scaffoldProjectFolder(folder);

  const flowPath = join(repo, 'flow');
  // The copy comes BEFORE anything is renamed or re-linked, and is planned
  // again now that the folder is scaffolded, so what it compares against is
  // exactly what is there.
  let imported: ImportReport | null = null;
  if (prepared.importPlan !== null) {
    imported =
      plan.kind === 'here'
        ? { ...EMPTY_IMPORT, skipped: [], renamed: [] }
        : applyKnowledgeImport(planKnowledgeImport(importSourceOf(plan, flowPath), folder, importRootsFor(repo, flowPath)));
  }

  let previous: PreviousFlow = { kind: 'none' };
  let commit: LinkResult['codeRepo']['commit'] = null;
  let undoRename: (() => void) | null = null;
  switch (plan.kind) {
    case 'here':
      previous = { kind: 'workspace-link' };
      break;
    case 'link':
      // Only the link goes; whatever it pointed at stays exactly where it is.
      previous = { kind: 'link', target: plan.target };
      break;
    case 'untracked':
    case 'knowledge-repo': {
      const keptAt = join(repo, plan.renameTo);
      renameSync(flowPath, keptAt);
      undoRename = () => renameSync(keptAt, flowPath);
      previous = plan.kind === 'untracked' ? { kind: 'folder', keptAt } : { kind: 'knowledge-repo', keptAt };
      break;
    }
    case 'committed': {
      const done = commitRename(repo, plan.renameTo, git);
      commit = { ...done, files: plan.files };
      previous = { kind: 'committed-folder', keptAt: join(repo, plan.renameTo) };
      break;
    }
    case 'absent':
      break;
  }

  if (plan.kind !== 'here') {
    try {
      createSymlink(folder, flowPath);
    } catch (error) {
      undoRename?.();
      throw new WorkspaceRefusal('failed', `the knowledge link could not be made: ${errorText(error)}`, { restored: undoRename !== null });
    }
  }

  writeLocalProjects(flowFolder, { ...local, [project.id]: repo });
  const ignored = ensureFlowIgnored(repo, git);
  if (imported !== null && plan.kind !== 'here') {
    try {
      writeBrainIndex(folder);
    } catch {
      // A missing index is rebuilt on the next capture; linking never fails on it.
    }
  }
  const updated = readWorkspace(flowFolder, workspace.slug);
  const stored = updated.file.projects.find((entry) => entry.id === project.id) ?? project;

  return {
    action: 'link',
    flowFolder,
    workspace: summaryOf(updated, git),
    project: viewOf(flowFolder, updated, stored, { ...local, [project.id]: repo }),
    link: plan.kind === 'here' ? 'unchanged' : 'created',
    previous,
    projectAdded: added,
    codeRepo: { ignored, commit },
    imported,
  };
}

// ─── join ───────────────────────────────────────────────────────────────────

export interface JoinOptions extends WorkspaceContext {
  remote: string;
  /** The folder name to use on this machine (the Workspace's own name is kept). */
  name?: string;
}

export interface JoinResult {
  action: 'join';
  flowFolder: string;
  workspace: WorkspaceSummary;
  linked: ProjectView[];
  /** Projects with no checkout known on this machine. */
  noLocalCheckout: ProjectView[];
  /** Projects whose checkout needs a person first (a committed flow/, a dirty tree…). */
  needsReview: (ProjectView & { refusal: Record<string, unknown> })[];
  /**
   * Projects with no record on this machine whose REMOTE matches a checkout
   * this machine knows under another id. Never linked here — a remote is a
   * guess about a folder; the person confirms with `workspace link`.
   * `localPath` is the matching checkout.
   */
  candidates: ProjectView[];
}

/** Clone a Workspace and link every project whose checkout this machine knows. */
export function joinWorkspace(options: JoinOptions): JoinResult {
  const { flowFolder, deps } = contextOf(options);
  const remote = options.remote.trim();
  const refusal = remoteRefusal(remote);
  if (refusal !== null) throw refusal;
  const identity = remoteIdentity(remote);

  const scan = scanWorkspaces(flowFolder);
  const already = scan.workspaces.find((workspace) => {
    const known = workspace.file.remote ?? originOf(workspace.path, deps.git);
    return known !== null && known !== undefined && remoteIdentity(known) === identity;
  });
  if (already !== undefined) {
    throw new WorkspaceRefusal('already-joined', `this machine already has that Workspace, as ${already.file.name}`, {
      workspace: summaryOf(already, deps.git),
    });
  }

  const local = readLocalProjects(flowFolder);
  const root = workspacesDir(flowFolder);
  mkdirSync(root, { recursive: true });
  // Cloned under a hidden staging name (scans skip dot-folders), so the
  // folder can take the Workspace's OWN slug once its file has been read.
  const staging = join(root, `${JOIN_STAGING_PREFIX}${process.pid}-${Date.now()}`);

  try {
    // No symlink is ever checked out of a Workspace: not by the clone, and —
    // recorded in the clone's own config — not by any later checkout.
    deps.git(['-c', 'core.symlinks=false', 'clone', '-q', '--config', 'core.symlinks=false', '--', remote, staging], root, { network: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw new WorkspaceRefusal('clone-failed', `the Workspace could not be fetched: ${errorText(error)}`, { remote });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(staging, WORKSPACE_FILENAME), 'utf-8'));
  } catch {
    parsed = undefined;
  }
  const problem = parsed === undefined ? `it has no readable ${WORKSPACE_FILENAME}` : workspaceFileProblem(parsed);
  if (problem !== null) {
    // A fresh clone of somebody else's repository — nothing of this person's is in it.
    rmSync(staging, { recursive: true, force: true });
    throw new WorkspaceRefusal('not-a-workspace-repo', `that repository is not a Flow Workspace Flow can read: ${problem}`, { remote });
  }
  const own = (parsed as WorkspaceFile).slug;
  const base = slugify(options.name ?? '') || own;
  const slug = uniqueSlug(base, new Set(readdirSync(root)));
  renameSync(staging, workspaceDir(flowFolder, slug));
  const workspace = readWorkspace(flowFolder, slug);
  // Keep the clone's ignore/attributes current with THIS Flow's table (a
  // change shows up for the next sync to commit), and build each project's
  // generated brain index — it is never synced, so a fresh clone has none.
  writeWorkspaceRepoFiles(workspace.path);
  for (const project of workspace.file.projects) {
    const folder = projectFolder(flowFolder, slug, project.slug);
    if (!existsSync(folder)) continue;
    try {
      writeBrainIndex(folder);
    } catch {
      // A missing index is rebuilt on the next capture; joining never fails on it.
    }
  }

  const result: JoinResult = {
    action: 'join',
    flowFolder,
    workspace: summaryOf(workspace, deps.git),
    linked: [],
    noLocalCheckout: [],
    needsReview: [],
    candidates: [],
  };
  // The checkouts this machine knows, by remote identity — candidates only.
  const knownCheckouts: { path: string; identity: string }[] = [];
  for (const path of new Set(Object.values(local))) {
    if (!existsSync(path)) continue;
    const origin = originOf(path, deps.git);
    const known = origin === null ? null : remoteIdentity(origin);
    if (known !== null) knownCheckouts.push({ path, identity: known });
  }
  for (const project of workspace.file.projects) {
    const view = viewOf(flowFolder, workspace, project, local);
    if (view.localPath === null) {
      const candidate = knownCheckouts.find((checkout) => projectMatchesIdentity(project, checkout.identity));
      if (candidate === undefined) result.noLocalCheckout.push(view);
      else result.candidates.push({ ...view, localPath: candidate.path });
      continue;
    }
    try {
      // The checkout's existing knowledge is brought in, never left behind (decision 2026-10-06).
      const linked = linkRepo({ flowFolder, deps, target: view.localPath, workspace: slug, project: project.id, import: true });
      result.linked.push(linked.project);
    } catch (error) {
      if (!(error instanceof WorkspaceRefusal)) throw error;
      result.needsReview.push({ ...view, refusal: error.payload });
    }
  }
  return result;
}

// ─── status ─────────────────────────────────────────────────────────────────

export interface StatusOptions extends WorkspaceContext {
  target?: string;
  workspace?: string;
}

export interface WorkspaceListing extends WorkspaceSummary {
  projects: ProjectView[];
  /** This machine's Default Workspace (`settings/workspaces.local.json`). */
  default: boolean;
}

export interface StatusListResult {
  action: 'status';
  flowFolder: string;
  /** The Default Workspace's slug on this machine, or null. */
  defaultWorkspace: string | null;
  workspaces: WorkspaceListing[];
  unreadable: WorkspaceScan['unreadable'];
}

export interface StatusTargetResult {
  action: 'status';
  flowFolder: string;
  target: string;
  /** Null when the repo is in no Workspace — not an error. */
  workspace: WorkspaceSummary | null;
  project: ProjectView | null;
  /** Whether `<repo>/flow` is a link to the project's folder. */
  linked: boolean;
  /** How the repo was recognised. */
  via: 'flow-link' | 'local-path' | 'remote' | null;
  siblings: ProjectView[];
  /** Other Workspaces that also list this repo. */
  alsoIn: string[];
}

interface RepoMatch {
  workspace: LoadedWorkspace;
  project: WorkspaceProject;
  via: 'flow-link' | 'local-path' | 'remote';
}

/**
 * Every Workspace project this repo is, strongest evidence first: the `flow`
 * link itself, then this machine's recorded checkout, then the remote identity.
 */
export function matchRepo(flowFolder: string, repo: string, git: WorkspaceGit, scan?: WorkspaceScan, local?: LocalProjectMap): RepoMatch[] {
  const realRepo = realOrResolved(repo);
  const workspaces = (scan ?? scanWorkspaces(flowFolder)).workspaces;
  if (workspaces.length === 0) return [];
  const map = local ?? readLocalProjects(flowFolder);
  const matches: RepoMatch[] = [];
  const push = (match: RepoMatch): void => {
    if (!matches.some((seen) => seen.workspace.slug === match.workspace.slug && seen.project.id === match.project.id)) matches.push(match);
  };

  const linked = workspaceLinkOf(flowFolder, join(realRepo, 'flow'));
  if (linked !== null) {
    const workspace = workspaces.find((entry) => entry.slug === linked.workspace);
    const project = workspace?.file.projects.find((entry) => entry.slug === linked.project);
    if (workspace !== undefined && project !== undefined) push({ workspace, project, via: 'flow-link' });
  }
  for (const [id, path] of Object.entries(map)) {
    if (realOrResolved(path) !== realRepo) continue;
    for (const workspace of workspaces) {
      const project = workspace.file.projects.find((entry) => entry.id === id);
      if (project !== undefined) push({ workspace, project, via: 'local-path' });
    }
  }
  const origin = originOf(realRepo, git);
  const identity = origin === null ? null : remoteIdentity(origin);
  if (identity !== null) {
    for (const workspace of workspaces) {
      const project = workspace.file.projects.find((entry) => projectMatchesIdentity(entry, identity));
      if (project !== undefined) push({ workspace, project, via: 'remote' });
    }
  }
  return matches;
}

export const NO_HINTS: RepoHints = { identity: null, knownIds: [] };

export function workspaceStatus(options: StatusOptions): StatusListResult | StatusTargetResult {
  const { flowFolder, deps } = contextOf(options);
  const scan = scanWorkspaces(flowFolder);
  const local = readLocalProjects(flowFolder);

  if (options.target === undefined) {
    const chosen = options.workspace === undefined ? scan.workspaces : [pickWorkspace(scan, options.workspace, NO_HINTS)];
    const defaultWorkspace = readDefaultWorkspace(flowFolder);
    return {
      action: 'status',
      flowFolder,
      defaultWorkspace,
      workspaces: chosen.map((workspace) => ({
        ...summaryOf(workspace, deps.git),
        projects: workspace.file.projects.map((project) => viewOf(flowFolder, workspace, project, local)),
        default: workspace.slug === defaultWorkspace,
      })),
      unreadable: scan.unreadable,
    };
  }

  const target = realOrResolved(options.target);
  let matches = matchRepo(flowFolder, target, deps.git, scan, local);
  if (options.workspace !== undefined) {
    const wanted = pickWorkspace(scan, options.workspace, NO_HINTS);
    matches = matches.filter((match) => match.workspace.slug === wanted.slug);
  }
  const best = matches[0];
  if (best === undefined) {
    return { action: 'status', flowFolder, target, workspace: null, project: null, linked: false, via: null, siblings: [], alsoIn: [] };
  }
  const linked = workspaceLinkOf(flowFolder, join(target, 'flow'));
  return {
    action: 'status',
    flowFolder,
    target,
    workspace: summaryOf(best.workspace, deps.git),
    project: viewOf(flowFolder, best.workspace, best.project, local),
    linked: linked !== null && linked.workspace === best.workspace.slug && linked.project === best.project.slug,
    via: best.via,
    siblings: best.workspace.file.projects
      .filter((project) => project.id !== best.project.id)
      .map((project) => viewOf(flowFolder, best.workspace, project, local)),
    alsoIn: [...new Set(matches.slice(1).map((match) => match.workspace.slug).filter((slug) => slug !== best.workspace.slug))],
  };
}

// ─── describe ───────────────────────────────────────────────────────────────

export interface DescribeOptions extends WorkspaceContext {
  /** The project, by slug or id. */
  project: string;
  /** The description — what the project is, in a sentence or two. */
  text: string;
  /** Which Workspace (slug or name) — optional when only one could be meant. */
  workspace?: string;
  /**
   * Only write when the project has no description yet. The app's generated
   * descriptions pass it, so a sentence a person wrote meanwhile is never
   * overwritten by a machine's guess.
   */
  ifEmpty?: boolean;
}

export interface DescribeResult {
  action: 'describe';
  workspace: WorkspaceSummary;
  project: ProjectView;
  /** False when nothing was written (the same text, or `ifEmpty` met a description). */
  changed: boolean;
}

// Tabs and newlines are fine in a description; nothing else below 0x20 is.
// eslint-disable-next-line no-control-regex
const DESCRIPTION_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/**
 * Set one project's description in `workspace.json` — the text the context
 * gate reads to decide which projects a conversation needs. The ONE writer of
 * that field (allowed-pattern #14): the app calls this verb, never the file.
 */
export function describeProject(options: DescribeOptions): DescribeResult {
  const { flowFolder, deps } = contextOf(options);
  const text = options.text.trim();
  if (text === '' || text.length > MAX_DESCRIPTION_LENGTH || DESCRIPTION_CONTROL_CHARACTERS.test(text)) {
    throw new WorkspaceRefusal(
      'invalid-description',
      `a description is plain text of 1 to ${MAX_DESCRIPTION_LENGTH} characters`,
      { maxLength: MAX_DESCRIPTION_LENGTH }
    );
  }
  const scan = scanWorkspaces(flowFolder);
  const workspace = pickWorkspace(scan, options.workspace, { ...NO_HINTS, project: options.project });
  const project = workspace.file.projects.find((entry) => entry.slug === options.project || entry.id === options.project);
  if (project === undefined) {
    throw new WorkspaceRefusal('unknown-project', `the Workspace ${workspace.file.name} has no project ${options.project}`, {
      workspace: workspace.slug,
      projects: workspace.file.projects.map((entry) => ({ id: entry.id, slug: entry.slug, name: entry.name })),
    });
  }
  const hasOne = typeof project.description === 'string' && project.description.trim() !== '';
  const changed = !(options.ifEmpty === true && hasOne) && project.description !== text;
  if (changed) {
    project.description = text;
    writeWorkspace(workspace);
  }
  return {
    action: 'describe',
    workspace: summaryOf(workspace, deps.git),
    project: viewOf(flowFolder, workspace, project, readLocalProjects(flowFolder)),
    changed,
  };
}

// ─── Provisioning ───────────────────────────────────────────────────────────

export type ProvisionLink =
  | { kind: 'not-in-workspace' }
  /** `<repo>/flow` already links into a Workspace — never moved or re-linked. */
  | { kind: 'workspace-link'; folder: string }
  /** Provisioning made the link just now. */
  | { kind: 'linked'; folder: string; result: LinkResult }
  /** The repo is a Workspace project, but linking needs a person (a committed flow/, …). */
  | { kind: 'needs-review'; sentence: string }
  /**
   * The repo's REMOTE matches a Workspace project, but this machine has never
   * recorded this checkout as that project. A remote is a guess about a folder
   * (a scratch clone, a fork, somebody else's copy), so nothing is linked: the
   * person confirms with `workspace link`.
   */
  | { kind: 'suggestion'; workspace: string; workspaceName: string; project: string; projectSlug: string; sentence: string };

/**
 * What `initShared` does about Workspaces, decided in one place: an existing
 * Workspace link is left exactly as it is; a repo that is a project of exactly
 * one Workspace (by recorded path or remote identity) is linked there, never
 * into the vault; anything else is not a Workspace project and provisioning
 * carries on as it always has (FR-5). Never throws for an unrelated project —
 * an unreadable Flow folder is the same as no Workspaces.
 *
 * Workspaces are always on (decision 2026-10-06): there is no environment
 * switch any more — a `PLANFLOW_WORKSPACES` left in the environment is
 * ignored. The link imports whatever `flow/` holds (a project's own knowledge
 * repo included), exactly as `workspace link --import` does.
 */
export function provisionWorkspaceLink(target: string, context: WorkspaceContext = {}): ProvisionLink {
  const { flowFolder, deps } = contextOf(context);
  const flowPath = join(target, 'flow');
  const existing = workspaceLinkOf(flowFolder, flowPath);
  if (existing !== null) {
    return { kind: 'workspace-link', folder: projectFolder(flowFolder, existing.workspace, existing.project) };
  }
  // A link into ANY Workspace project folder — judged from the link's own
  // target, not from this process's Flow folder (which may resolve elsewhere:
  // another env, a moved home). Never moved, merged or re-linked.
  const located = isSymlink(flowPath) ? locateWorkspaceProject(flowPath) : null;
  if (located !== null) return { kind: 'workspace-link', folder: realOrResolved(flowPath) };
  if (!existsSync(workspacesDir(flowFolder))) return { kind: 'not-in-workspace' };

  let all: RepoMatch[];
  try {
    all = matchRepo(flowFolder, target, deps.git);
  } catch {
    return { kind: 'not-in-workspace' };
  }
  // Only THIS machine's record of the checkout links on its own.
  const matches = all.filter((match) => match.via !== 'remote');
  const workspaces = [...new Set(matches.map((match) => match.workspace.slug))];
  if (workspaces.length !== 1) {
    const byRemote = all.filter((match) => match.via === 'remote');
    if (matches.length === 0 && new Set(byRemote.map((match) => match.workspace.slug)).size === 1) {
      const { workspace, project } = byRemote[0];
      return {
        kind: 'suggestion',
        workspace: workspace.slug,
        workspaceName: workspace.file.name,
        project: project.id,
        projectSlug: project.slug,
        sentence: `this checkout looks like ${project.name} of the ${workspace.file.name} Workspace — link it from the Workspace to keep its knowledge there`,
      };
    }
    return { kind: 'not-in-workspace' };
  }
  const match = matches[0];
  try {
    const result = linkRepo({ flowFolder, deps, target, workspace: match.workspace.slug, project: match.project.id, import: true });
    return { kind: 'linked', folder: result.project.flowPath, result };
  } catch (error) {
    if (error instanceof WorkspaceRefusal) return { kind: 'needs-review', sentence: error.sentence };
    throw error;
  }
}

// ─── The quiet lookup ───────────────────────────────────────────────────────

/**
 * Which Workspace and project `target` is, for READERS that must never fail
 * because of Workspaces — sibling surfaces, brain search, blueprint context.
 * The same answer as `workspace status --target` (one code path, allowed-pattern
 * #14), but null — never a refusal — when the repo is in no Workspace, the Flow
 * folder has none, or anything about it is unreadable: a reader outside a
 * Workspace behaves exactly as it did before Workspaces existed (FR-5).
 */
export function workspaceContextOf(target: string, context: WorkspaceContext = {}): StatusTargetResult | null {
  const flowFolder = resolve(context.flowFolder ?? resolveFlowFolder());
  if (!existsSync(workspacesDir(flowFolder))) return null;
  try {
    const status = workspaceStatus({ ...context, flowFolder, target });
    if (!('target' in status) || status.workspace === null || status.project === null) return null;
    return status;
  } catch {
    return null;
  }
}
