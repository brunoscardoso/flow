/**
 * AUTHORSHIP of shared knowledge (workspaces-knowledge-hub FR-19).
 *
 * Knowledge written into a Workspace is read by a team, so the writers stamp
 * who wrote it: `author` on discoveries, plans and feature notes, `decided_by`
 * on decisions — taken from the person's git identity FOR THE WORKSPACE REPO
 * (`git config user.name` run there, so a repo-local identity wins over the
 * global one, exactly as the commit that carries the file will).
 *
 * NAME ONLY, decided on purpose: a Workspace repo is shared with everyone who
 * can read it, and an email address in every note's frontmatter is personal
 * data copied into a team artifact — while the commit already records the
 * email for anyone who needs it. Nothing in this codebase recorded emails in
 * knowledge before, and this does not start.
 *
 * The Flow sign-in name is not visible to the CLI (the desktop session token
 * never leaves the app), so the git identity is the one source here.
 */

import { execFileSync } from 'node:child_process';

import { QUIET_CHILD_STDIO } from '../utils/child-stdio.js';
import { locateWorkspaceProject } from './workspace-locate.js';

/** How long `git config` may take before authorship is simply left out. */
const GIT_CONFIG_TIMEOUT_MS = 5_000;
/** Longest name recorded; frontmatter is one line. */
const MAX_AUTHOR_LENGTH = 120;

export type GitConfigReader = (cwd: string) => string | null;

const defaultReader: GitConfigReader = (cwd) => {
  try {
    return execFileSync('git', ['config', '--get', 'user.name'], {
      cwd,
      // Passed explicitly: a host that sandboxes `process.env` (a test runner)
      // would otherwise hand the child the OUTER environment.
      env: process.env,
      encoding: 'utf-8',
      timeout: GIT_CONFIG_TIMEOUT_MS,
      stdio: [...QUIET_CHILD_STDIO],
    });
  } catch {
    // No identity configured (git exits 1) or no git at all: authorship is
    // optional metadata, and its absence is recorded by its absence.
    return null;
  }
};

/**
 * Collapse a raw identity to a safe one-line frontmatter value, or null.
 * Strips anything that could break the line or the fence.
 */
export function cleanAuthorName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-\s]+/, '')
    .trim()
    .slice(0, MAX_AUTHOR_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The author name for knowledge written under `cwd` (normally the Workspace
 * repo), or null when git has none. Never throws.
 */
export function knowledgeAuthor(cwd: string, reader: GitConfigReader = defaultReader): string | null {
  return cleanAuthorName(reader(cwd));
}

/**
 * The author for knowledge written into `flowDir` — only when that `flow/` is
 * a Workspace project (outside one, writers stay byte-identical to before,
 * FR-5). Read from the Workspace repo, whose commits will carry the file.
 */
export function workspaceAuthor(flowDir: string, reader: GitConfigReader = defaultReader): string | null {
  const location = locateWorkspaceProject(flowDir);
  return location === null ? null : knowledgeAuthor(location.workspacePath, reader);
}

/**
 * Frontmatter lines (`---` fenced) stamping `key: <author>` for a NEW document
 * written into a Workspace project, or `[]` when there is nothing to stamp.
 */
export function authorshipFrontmatter(
  flowDir: string,
  key: 'author' | 'decided_by',
  reader: GitConfigReader = defaultReader
): string[] {
  const author = workspaceAuthor(flowDir, reader);
  return author === null ? [] : ['---', `${key}: ${author}`, '---', ''];
}
