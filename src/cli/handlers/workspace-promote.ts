/**
 * `workspace promote` — run the promotion checker for every project of one
 * Workspace that is checked out on THIS machine (discovery
 * `workspace_knowledge_draft_solid`, FR-7: whoever can, promotes).
 *
 * A project with no checkout here is skipped: its drafts are promoted by a
 * machine that has it, and this one reads the lines that machine writes. The
 * checks are `checkPromotion`'s (`knowledge-landing.ts`) — this file finds the
 * drafts, runs the checker once per project, sequentially, and archives the
 * plans and discoveries it found abandoned through the archive code path.
 *
 * Bounded: one fetch per project that HAS drafts (a project with none costs
 * no fetch), one host question per draft branch, `git show` cached per
 * default-branch commit. Nothing here deletes knowledge: abandoned learnings
 * and notes are only hidden by the status resolver.
 */
import * as childProcess from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { archivePlanArtifacts } from '../commands/plan.js';
import { parseLearnings, parseParts, readFeatures, slugifyFeatureName, splitParts } from '../blueprint/feature-store.js';
import { investigationFingerprint, readInvestigations } from '../blueprint/investigation-store.js';
import { readProvenanceRecords, type KnowledgeProvenance } from '../state/knowledge-provenance.js';
import {
  itemStampOf,
  knowledgeItemId,
  readKnowledgeStatus,
  resolveItemStatus,
  type FoldedKnowledgeStatus,
  type KnowledgeItemKind,
} from '../state/knowledge-status-log.js';
import { documentStampKind, readKnowledgeStamp } from '../state/knowledge-status.js';
import { archiveDocument } from '../state/run-script-store.js';
import {
  HOST_TIMEOUT_MS,
  checkPromotion,
  documentItemId,
  hostForCheckout,
  type DraftItem,
  type HostPrState,
  type HostRunner,
  type PromotionResult,
} from './knowledge-landing.js';
import { locateWorkspaceProject } from './workspace-locate.js';
import {
  WorkspaceRefusal,
  defaultWorkspaceGit,
  errorText,
  projectFolder,
  readLocalProjects,
  readWorkspace,
  scanWorkspaces,
  type LoadedWorkspace,
  type WorkspaceGit,
} from './workspace-model.js';

/** Per-project counts. `checked` = drafts examined. */
export interface PromoteCounts {
  checked: number;
  solid: number;
  stale: number;
  abandoned: number;
  unknown: number;
}

export interface PromoteProjectReport {
  project: string;
  /** `checked` — the checker ran (or there was nothing to check); `no-checkout` — not on this machine; `failed` — see `detail`. */
  state: 'checked' | 'no-checkout' | 'failed';
  counts: PromoteCounts;
  /** Documents moved into the archive, relative to the project's knowledge folder. */
  archived: string[];
  /** Abandoned documents that could not be archived, and why. */
  archiveFailed: { document: string; detail: string }[];
  detail?: string;
}

export interface PromoteResult {
  action: 'promote';
  workspace: { name: string; slug: string };
  projects: PromoteProjectReport[];
  totals: PromoteCounts;
}

export interface PromoteDeps {
  git: WorkspaceGit;
  /** The code host for a checkout. Default: its signed-in `gh`, when the remote is GitHub. */
  host: (checkout: string) => HostPrState | null;
}

export interface PromoteOptions {
  /** REQUIRED — the Flow folder holding `workspaces/` and `projects.local.json`. */
  flowFolder: string;
  /** Which Workspace (slug or name). */
  workspace?: string;
  /** Instead of `workspace`: the Workspace this code repository belongs to. */
  target?: string;
  deps?: Partial<PromoteDeps>;
}

const emptyCounts = (): PromoteCounts => ({ checked: 0, solid: 0, stale: 0, abandoned: 0, unknown: 0 });

/** Run a host CLI with a timeout; any failure is "could not ask". */
export const defaultHostRunner: HostRunner = (command, args, cwd) => {
  try {
    const result = childProcess.spawnSync(command, args, {
      cwd,
      encoding: 'utf-8',
      timeout: HOST_TIMEOUT_MS,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error !== undefined || result.status !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
};

/**
 * Every draft in one project's knowledge folder: learnings, part learnings and
 * investigation notes whose status resolves as draft, and discovery or plan
 * documents stamped with a branch and commit the log has not decided yet.
 */
export function collectDraftItems(flowDir: string): DraftItem[] {
  const records = readProvenanceRecords(flowDir);
  const folded = readKnowledgeStatus(flowDir);
  const drafts = new Map<string, DraftItem>();

  const consider = (kind: Exclude<KnowledgeItemKind, 'view'>, scope: string, text: string, learnedAt: string | undefined): void => {
    const stamp = itemStampOf(learnedAt, records);
    if (stamp.kind === 'unstamped') return;
    const item = knowledgeItemId({ kind, scope, text, learnedAt });
    if (drafts.has(item)) return;
    if (resolveItemStatus(stamp, folded.get(item)).status !== 'draft') return;
    drafts.set(item, draftOf(item, kind, stamp.provenance));
  };

  for (const node of readFeatures(flowDir)) {
    let split: ReturnType<typeof splitParts>;
    try {
      split = splitParts(node.body);
    } catch {
      continue; // an ambiguous body is never guessed at
    }
    for (const learning of parseLearnings(split.learned)) {
      consider('learning', node.slug, learning.text, learning.learnedAt);
    }
    for (const part of parseParts(split.parts)) {
      const scope = `${node.slug}/${slugifyFeatureName(part.name)}`;
      for (const learning of part.learnings) consider('part-learning', scope, learning.text, learning.learnedAt);
    }
  }

  for (const note of readInvestigations(flowDir).notes) {
    consider('note', '', investigationFingerprint(note), note.learnedAt);
  }

  for (const folder of ['discovery', 'plans'] as const) {
    for (const draft of documentDrafts(flowDir, folder, folded)) {
      if (!drafts.has(draft.item)) drafts.set(draft.item, draft);
    }
  }
  return [...drafts.values()];
}

function draftOf(item: string, kind: DraftItem['kind'], provenance: KnowledgeProvenance | null): DraftItem {
  return {
    item,
    kind,
    branch: provenance?.branch ?? null,
    commit: provenance?.commit ?? null,
    hashes: provenance?.hashes ?? [],
  };
}

function documentDrafts(flowDir: string, folder: 'discovery' | 'plans', folded: ReadonlyMap<string, FoldedKnowledgeStatus>): DraftItem[] {
  const dir = join(flowDir, folder);
  if (!existsSync(dir)) return [];
  const out: DraftItem[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), 'utf-8');
    } catch {
      continue;
    }
    const stamp = readKnowledgeStamp(raw);
    if (documentStampKind(stamp) !== 'stamped' || stamp.commit === null) continue;
    const item = documentItemId(name, stamp.commit);
    const decided = folded.get(item);
    if (decided !== undefined && decided.status !== 'draft') continue;
    out.push({ item, kind: 'document', branch: stamp.branch, commit: stamp.commit, hashes: [], document: `${folder}/${name}` });
  }
  return out;
}

/** The Workspace a call is about: by `--target`'s location, or by slug/name. */
function resolvePromoteWorkspace(options: PromoteOptions): { flowFolder: string; workspace: LoadedWorkspace } {
  if (options.target !== undefined) {
    const located = locateWorkspaceProject(join(options.target, 'flow'));
    if (located === null) {
      throw new WorkspaceRefusal('no-workspace', 'this project is in no Workspace, so there is nothing to promote', {
        target: options.target,
      });
    }
    const flowFolder = dirname(dirname(located.workspacePath));
    return { flowFolder, workspace: readWorkspace(flowFolder, basename(located.workspacePath)) };
  }
  const flowFolder = options.flowFolder;
  const scan = scanWorkspaces(flowFolder);
  const choices = scan.workspaces.map((workspace) => ({ slug: workspace.slug, name: workspace.file.name }));
  const wanted = options.workspace;
  if (wanted === undefined || wanted.trim() === '') {
    throw new WorkspaceRefusal('which-workspace', 'say which Workspace to promote', { workspaces: choices });
  }
  const broken = scan.unreadable.find((entry) => entry.workspace === wanted);
  if (broken !== undefined) throw new WorkspaceRefusal('malformed-workspace', broken.detail, { workspace: wanted });
  const found =
    scan.workspaces.find((workspace) => workspace.slug === wanted) ?? scan.workspaces.find((workspace) => workspace.file.name === wanted);
  if (found === undefined) {
    throw new WorkspaceRefusal('unknown-workspace', `there is no Workspace called ${wanted} on this machine`, { workspaces: choices });
  }
  return { flowFolder, workspace: found };
}

/** Promote one Workspace. See the module header. */
export function promoteWorkspace(options: PromoteOptions): PromoteResult {
  const { flowFolder, workspace } = resolvePromoteWorkspace(options);
  const git = options.deps?.git ?? defaultWorkspaceGit;
  const host = options.deps?.host ?? ((checkout: string) => hostForCheckout(git, checkout, defaultHostRunner));
  const local = readLocalProjects(flowFolder);
  const totals = emptyCounts();
  const projects: PromoteProjectReport[] = [];

  for (const project of workspace.file.projects) {
    const report: PromoteProjectReport = { project: project.slug, state: 'checked', counts: emptyCounts(), archived: [], archiveFailed: [] };
    projects.push(report);
    const checkout = local[project.id];
    if (checkout === undefined || checkout === '' || !existsSync(checkout)) {
      report.state = 'no-checkout';
      continue;
    }
    const flowDir = projectFolder(flowFolder, workspace.slug, project.slug);
    let results: PromotionResult[];
    try {
      const drafts = collectDraftItems(flowDir);
      results = checkPromotion(git, checkout, drafts, drafts.length === 0 ? null : host(checkout), { flowDir });
    } catch (error) {
      report.state = 'failed';
      report.detail = errorText(error);
      continue;
    }
    for (const result of results) {
      report.counts.checked += 1;
      report.counts[result.outcome] += 1;
      if (result.outcome === 'abandoned' && result.document !== undefined) archiveAbandoned(flowDir, result.document, report);
    }
    for (const key of Object.keys(totals) as (keyof PromoteCounts)[]) totals[key] += report.counts[key];
  }
  return { action: 'promote', workspace: { name: workspace.file.name, slug: workspace.slug }, projects, totals };
}

/** FR-8: an abandoned plan or discovery moves to the archive through the archive code path. */
function archiveAbandoned(flowDir: string, document: string, report: PromoteProjectReport): void {
  try {
    report.archived.push(...archiveDocument(flowDir, document));
    if (document.startsWith('plans/')) archivePlanArtifacts(flowDir, basename(document));
  } catch (error) {
    report.archiveFailed.push({ document, detail: errorText(error) });
  }
}
