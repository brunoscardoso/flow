/**
 * WHETHER A KNOWLEDGE DOCUMENT IS READY TO REACH THE TEAM.
 *
 * `knowledge-classes.ts` answers what KIND of file a path is — personal,
 * generated, append-only, authored. This answers a different question about
 * the `authored` ones only: is this one finished, and did the work it
 * describes actually land?
 *
 * Two deciders, two questions, composed rather than merged: the path decides
 * the kind, the document decides its own readiness. Folding readiness into the
 * class table would mean the same key meant "never share this" for a
 * credential and "not yet" for a draft, and nothing could tell them apart.
 *
 * ── THE DEFAULT IS SHARE ───────────────────────────────────────────────────
 *
 * A document with no stamp syncs, exactly as it did before this existed. That
 * is not timidity, it is the only safe direction: a real Workspace already
 * holds hundreds of unstamped documents, and a default of "hold" would
 * withdraw all of them from the team on the next sync — a deletion, to every
 * teammate, of knowledge nobody asked to remove. Strictness is opt-in per
 * document and comes from the WRITER stamping what it made, never from this
 * reader guessing about what it did not.
 *
 * ── WHY A TOKEN AND NOT A COMMIT SHA ───────────────────────────────────────
 *
 * The question "did this land on the default branch?" cannot be answered with
 * the sha of the commit the work was made on: a squash merge mints a NEW
 * commit, so the original is never an ancestor of `main` and an ancestry test
 * would answer "not landed" for ever. A token carried in the commit MESSAGE
 * survives squash and rebase alike, because both preserve the body.
 *
 * The token is the run id — minted by the driver that made the run, never read
 * off the documents being judged (allowed-pattern #25). A file cannot forge
 * one, because it does not get to choose it.
 */

const FENCE = '---';

/** The `status:` a document may carry. Anything else is read as unstamped. */
export type KnowledgeReadiness = 'draft' | 'shared';

/** What a document says about itself. Both keys are independent and optional. */
export interface KnowledgeStamp {
  /** `draft` never syncs; `shared` syncs regardless of `landedBy`. */
  readiness: KnowledgeReadiness | null;
  /** The run token to look for in the project's default branch. */
  landedBy: string | null;
}

export const UNSTAMPED: KnowledgeStamp = { readiness: null, landedBy: null };

/**
 * What sync should do with one document.
 *
 * `hold-pending` is deliberately distinct from `hold-draft`: they are different
 * sentences to a person ("you have not finished it" vs "its work has not
 * reached main yet"), and a surface that collapsed them would be unable to say
 * which one the reader can act on.
 */
export type KnowledgeDisposition = 'share' | 'hold-draft' | 'hold-pending';

/** Split a document into (frontmatter lines, body). No fence → no frontmatter. */
export function splitKnowledgeFrontmatter(raw: string): { fm: string[]; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(`${FENCE}\n`)) return { fm: [], body: normalized };
  const end = normalized.indexOf(`\n${FENCE}\n`, FENCE.length);
  // An unterminated fence is a half-written file, not a stamp. Reading the
  // rest of the document as frontmatter would let a line of prose that happens
  // to read `status: draft` decide whether a team sees the file.
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

/** What a document says about its own readiness. Never throws. */
export function readKnowledgeStamp(raw: string): KnowledgeStamp {
  const { fm } = splitKnowledgeFrontmatter(raw);
  if (fm.length === 0) return UNSTAMPED;
  const status = valueOf(fm, 'status');
  const landedBy = valueOf(fm, 'landed_by');
  return {
    // An unrecognised `status:` is NOT a stamp. Documents carry all sorts of
    // status words ("status: approved"), and treating an unknown one as a
    // decision would let unrelated prose hold a file back for ever.
    readiness: status === 'draft' || status === 'shared' ? status : null,
    landedBy,
  };
}

/**
 * Write `status:` / `landed_by:` into a document, keeping every other key and
 * the body byte-for-byte. `undefined` leaves a key alone; `null` removes it.
 *
 * Rewriting the whole frontmatter would drop the keys this module does not
 * know about — `id`, `anchors`, `relates`, `author` — which are precious and
 * owned by other writers.
 */
export function writeKnowledgeStamp(
  raw: string,
  changes: { readiness?: KnowledgeReadiness | null; landedBy?: string | null }
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
  set('landed_by', changes.landedBy);

  if (lines.length === 0) return body;
  return `${FENCE}\n${lines.join('\n')}\n${FENCE}\n${body}`;
}

/**
 * What to do with a document, given its stamp and whether its token has
 * reached the default branch.
 *
 * `landed` is three-valued on purpose. `null` means the question could not be
 * asked — the project's checkout is not on this computer, or its git refused —
 * and an unanswerable question must not hold a document back. A gate that
 * silently stops publishing because a folder moved is indistinguishable from a
 * gate that is broken, and nobody would know which.
 */
export function knowledgeDisposition(stamp: KnowledgeStamp, landed: boolean | null): KnowledgeDisposition {
  if (stamp.readiness === 'draft') return 'hold-draft';
  // An explicit `shared` is a person's decision and outranks the token: it is
  // how someone publishes a document whose work will never be a commit at all
  // (a meeting note, a decision), and how they override a trailer the merge ate.
  if (stamp.readiness === 'shared') return 'share';
  if (stamp.landedBy === null) return 'share';
  return landed === false ? 'hold-pending' : 'share';
}

/** The commit-message trailer that carries a run's token into git's own record. */
export const RUN_TRAILER_KEY = 'Flow-Run';

/** The trailer line a per-task commit ends with, for a given run token. */
export function runTrailer(token: string): string {
  return `${RUN_TRAILER_KEY}: ${token}`;
}

/**
 * A token is a bare word, so it can be grepped out of a commit message and
 * written into YAML without quoting, and cannot carry a glob or a shell
 * metacharacter into the `--grep` that looks for it.
 */
export function isRunToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}
