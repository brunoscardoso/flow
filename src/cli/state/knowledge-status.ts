/**
 * WHAT A KNOWLEDGE DOCUMENT SAYS ABOUT ITSELF — its frontmatter stamp.
 *
 * `knowledge-classes.ts` answers what KIND of file a path is — personal,
 * generated, append-only, authored. This reads the few frontmatter keys an
 * `authored` discovery or plan document carries about where it came from:
 *
 *   branch: feat/orders     the branch it was written on
 *   commit: <40 hex>        that branch's HEAD when it was written
 *   status: draft | shared  an older, hand-written readiness word
 *
 * ── EVERYTHING SYNCS (discovery `workspace_knowledge_draft_solid`, FR-3) ───
 *
 * This module used to decide whether a document was HELD out of the Workspace
 * sync (`hold-draft`, `hold-pending`, matched against a `landed_by:` run token
 * on the default branch). That gate is retired: the team sees work in
 * progress, tagged as a draft, instead of never seeing it, and the promotion
 * checker (`knowledge-landing.ts`, `checkPromotion`) decides from git when a
 * draft's work reached the default branch — however the PR was merged.
 *
 * `branch:` and `commit:` are written ONLY by `planflow-ai plan stamp <doc>`
 * (`stampDocumentFile`), which reads them off the checkout it runs in. A
 * caller never supplies them: a stamp a caller could choose is a stamp a caller
 * could forge (allowed-pattern #25).
 *
 * `status: draft` is still read, for documents written before stamping existed:
 * such a document now reads as a draft instead of being held. `status: shared`
 * is a person's decision that the document is settled, and outranks the stamp.
 * A document with none of these keys is solid, as every document written
 * before this existed is (FR-13).
 */

const FENCE = '---';

/** The hand-written `status:` a document may carry. Anything else is read as absent. */
export type KnowledgeReadiness = 'draft' | 'shared';

/** What a document says about itself. Every key is independent and optional. */
export interface KnowledgeStamp {
  /** An older, hand-written `status: draft | shared`. */
  readiness: KnowledgeReadiness | null;
  /** `branch:` — written by the stamp verb. */
  branch: string | null;
  /** `commit:` — written by the stamp verb; a full commit id or null. */
  commit: string | null;
}

export const UNSTAMPED: KnowledgeStamp = { readiness: null, branch: null, commit: null };

const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Split a document into (frontmatter lines, body). No fence → no frontmatter. */
export function splitKnowledgeFrontmatter(raw: string): { fm: string[]; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(`${FENCE}\n`)) return { fm: [], body: normalized };
  const end = normalized.indexOf(`\n${FENCE}\n`, FENCE.length);
  // An unterminated fence is a half-written file, not a stamp. Reading the
  // rest of the document as frontmatter would let a line of prose that happens
  // to read `status: draft` decide how a team sees the file.
  if (end === -1) return { fm: [], body: normalized };
  return {
    fm: normalized.slice(FENCE.length + 1, end).split('\n'),
    body: normalized.slice(end + FENCE.length + 2),
  };
}

function valueOf(fm: readonly string[], key: string): string | null {
  for (const line of fm) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    if (line.slice(0, colon).trim() !== key) continue;
    const value = line.slice(colon + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}

/** What a document says about itself. Never throws. */
export function readKnowledgeStamp(raw: string): KnowledgeStamp {
  const { fm } = splitKnowledgeFrontmatter(raw);
  if (fm.length === 0) return UNSTAMPED;
  const status = valueOf(fm, 'status');
  const branch = valueOf(fm, 'branch');
  const commit = valueOf(fm, 'commit');
  return {
    // An unrecognised `status:` is NOT a stamp. Documents carry all sorts of
    // status words ("status: approved"), and treating an unknown one as a
    // decision would let unrelated prose mark a file as a draft for ever.
    readiness: status === 'draft' || status === 'shared' ? status : null,
    branch: branch !== null && !/\s/.test(branch) ? branch : null,
    commit: commit !== null && COMMIT_RE.test(commit) ? commit : null,
  };
}

/**
 * Write stamp keys into a document, keeping every other key and the body
 * byte-for-byte. `undefined` leaves a key alone; `null` removes it.
 *
 * Rewriting the whole frontmatter would drop the keys this module does not
 * know about — `id`, `anchors`, `relates`, `author` — which are precious and
 * owned by other writers.
 */
export function writeKnowledgeStamp(
  raw: string,
  changes: { readiness?: KnowledgeReadiness | null; branch?: string | null; commit?: string | null }
): string {
  const { fm, body } = splitKnowledgeFrontmatter(raw);
  const lines = [...fm];

  const set = (key: string, value: string | null | undefined): void => {
    if (value === undefined) return;
    const at = lines.findIndex((line) => {
      const colon = line.indexOf(':');
      return colon > 0 && line.slice(0, colon).trim() === key;
    });
    if (value === null) {
      if (at !== -1) lines.splice(at, 1);
      return;
    }
    const written = `${key}: ${value}`;
    if (at === -1) lines.push(written);
    else lines[at] = written;
  };

  set('status', changes.readiness);
  set('branch', changes.branch);
  set('commit', changes.commit);

  if (lines.length === 0) return body;
  return `${FENCE}\n${lines.join('\n')}\n${FENCE}\n${body}`;
}

/**
 * How a document reads before the status log is consulted:
 *
 * - `shared` — a person said it is settled (`status: shared`): solid;
 * - `stamped` — written on a branch at a commit: a draft until the promotion
 *   checker proves its commit reached the default branch (or the log says so);
 * - `draft` — an older `status: draft` with no stamp: a draft nothing can
 *   promote, because there is no commit to look for;
 * - `unstamped` — none of the keys: solid (FR-13).
 */
export type DocumentStampKind = 'shared' | 'stamped' | 'draft' | 'unstamped';

export function documentStampKind(stamp: KnowledgeStamp): DocumentStampKind {
  if (stamp.readiness === 'shared') return 'shared';
  if (stamp.commit !== null) return 'stamped';
  if (stamp.readiness === 'draft') return 'draft';
  return 'unstamped';
}
