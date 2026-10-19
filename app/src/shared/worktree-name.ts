/**
 * WHAT A WORKTREE IS CALLED — the directory half of a question that used to
 * have one answer for both halves.
 *
 * A worktree is a directory; a branch is a git ref. Flow minted both from the
 * thread's UUID, so a person met `e2265b48-03e9-43e3-8f76-ff887a48615e` in
 * their shell prompt and `worktree/e2265b48-…` in Source Control, and neither
 * told them anything (user, 2026-09-17: "we should have two dif things, one is
 * branch, and another is worktree … we need to separate that concept
 * everywhere").
 *
 * THIS MODULE IS THE DIRECTORY'S NAME ONLY. `thread-branch.ts` beside it
 * decides the branch's. They share a slug rule and nothing else — which is the
 * point: two names, derived the same way, free to differ the moment somebody
 * types.
 *
 * THE GRAMMAR IS NOT THIS FILE'S TO CHOOSE. A worktree name becomes a path
 * segment inside `.{repo}-threads/`, and the CLI's `requireOwnerName` refuses
 * anything that is not lowercase words joined by `-` — a check whose comment
 * says outright that the grammar IS the path-traversal guard. So everything
 * here produces names that guard accepts, and the guard is never loosened to
 * accept what this produces.
 *
 * Pure and DOM-free: the panel, the chip, main and the migration all need the
 * same answer, and a second spelling would drift invisibly until two surfaces
 * disagreed about where a checkout lives (allowed-pattern #14).
 */

/** Longest slug a worktree directory takes from a title. */
export const MAX_WORKTREE_NAME_LENGTH = 40

/**
 * The grammar the CLI's owner-name guard accepts, restated here so a name is
 * born valid rather than repaired at the boundary.
 *
 * Lowercase alphanumerics in groups joined by single `-`. No leading or
 * trailing separator, no `.`, no `/`, nothing a path could be steered with.
 */
const WORKTREE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * A UUID, which is what this whole feature exists to stop appearing.
 *
 * It matters because a UUID PASSES the grammar above — lowercase alphanumerics
 * joined by `-` describes `e2265b48-03e9-43e3-8f76-ff887a48615e` exactly. That
 * is why nothing ever refused one: the guard was doing its job, and its job was
 * never "is this a name a person can read".
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The name a checkout takes when its conversation has no usable title. */
export const FALLBACK_WORKTREE_NAME = 'work'

/**
 * What marks a folder as a worktree when it shares its name with a branch.
 *
 * ONE NAME, TWO THINGS, TOLD APART BY THIS. A person types `data-contract-guard`
 * once: the branch is exactly that, and the folder is
 * `worktree/data-contract-guard` (user, 2026-09-17: "the name should not be
 * worktree-feature-branch, should be worktree/feature-branch").
 *
 * THE SLASH MAKES IT A PATH, and that is the point: the checkout nests one
 * level inside its container, so a shell prompt reads the clean name while the
 * folder above it says what kind of thing this is. The owner-name guard accepts
 * exactly one level and validates each segment with the same grammar — the
 * traversal check is unchanged in strength, only in shape.
 */
export const WORKTREE_FOLDER_PREFIX = 'worktree/'

/**
 * The folder that goes with a branch name, when the two share a name.
 *
 * The branch is whatever a person typed; this is the same word wearing the
 * prefix that says which of the two it is. A name that already carries the
 * prefix is not given a second one.
 */
export function folderForBranch(branch: string | null): string {
  const given = branch?.trim() ?? ''
  // ALREADY IN THE CONTAINER — a name that is already `worktree/<something>`
  // keeps it, rather than being slugged into `worktree/worktree-something`.
  if (given.startsWith(WORKTREE_FOLDER_PREFIX)) {
    const stem = worktreeNameFromTitle(given.slice(WORKTREE_FOLDER_PREFIX.length))
    return `${WORKTREE_FOLDER_PREFIX}${stem}`
  }
  return `${WORKTREE_FOLDER_PREFIX}${worktreeNameFromTitle(given)}`
}

/**
 * A title, as a directory name.
 *
 * DERIVED, SO IT SANITIZES (allowed-pattern #22). Nobody typed this; it is the
 * app's own proposal, and refusing an emoji-only title would leave a person
 * staring at an empty field at the moment they were asked to decide.
 *
 * Never empty and never a UUID: a title that slugs away to nothing gets
 * `work`, and one that happens to BE a uuid is treated as no title at all.
 */
export function worktreeNameFromTitle(title: string | null): string {
  const slug = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_WORKTREE_NAME_LENGTH)
    .replace(/-+$/g, '')
  if (slug === '' || UUID_RE.test(slug)) return FALLBACK_WORKTREE_NAME
  return slug
}

/** Why a typed worktree name cannot be used, or null when it can. */
export type WorktreeNameCheck =
  | { ok: true; name: string }
  | { ok: false; detail: string }

/**
 * A TYPED worktree name: validated and refused, never repaired.
 *
 * The other half of the rule above, and the reason it had to be written
 * separately. Run a person's `Data Contract Guard` through the sanitizer and
 * they silently get `data-contract-guard` — which is fine right up until they
 * typed something they meant, and the folder that appears is not the one they
 * were shown. What you propose is sanitized; what you were told is validated.
 *
 * The refusals name what is wrong in the terms of the thing on screen — a
 * folder name — and never mention the guard, the grammar or the CLI
 * (forbidden-pattern #12).
 */
export function validateWorktreeName(typed: string): WorktreeNameCheck {
  const value = typed.trim()
  if (value === '') return { ok: false, detail: 'Type a name for this worktree.' }
  // ── MEASURED WITHOUT THE PREFIX, WHICH NOBODY TYPED ──────────────────────
  //
  // Callers hand this the full folder name, prefix included, because the
  // GRAMMAR has to be checked against the whole path. But the field a person
  // types into holds the stem only — the prefix sits beside it as fixed text
  // ("Folder name, after worktree/") — so charging them for nine characters
  // they cannot see left 31 usable and a refusal quoting 40. A limit a reader
  // cannot count against what is on their screen is worse than a lower limit
  // honestly stated.
  const counted = value.startsWith(WORKTREE_FOLDER_PREFIX)
    ? value.slice(WORKTREE_FOLDER_PREFIX.length)
    : value
  if (counted.length > MAX_WORKTREE_NAME_LENGTH) {
    return { ok: false, detail: `Keep it to ${MAX_WORKTREE_NAME_LENGTH} characters or fewer.` }
  }
  if (UUID_RE.test(value)) {
    return { ok: false, detail: 'That is an id, not a name. Call it something you will recognise.' }
  }
  const segments = value.split('/')
  if (segments.length > 2) {
    return { ok: false, detail: 'One folder inside another is as deep as this goes.' }
  }
  if (!segments.every((part) => WORKTREE_NAME_RE.test(part))) {
    return {
      ok: false,
      detail: `‘${value}’ isn’t a name a folder can have here — lowercase words joined by ‘-’.`,
    }
  }
  return { ok: true, name: value }
}

/**
 * A checkout's name, read back from the path it was created at.
 *
 * NOT A SECOND COLUMN. The directory's last segment IS the worktree's name, so
 * storing it beside the path would be two sources of truth for one fact, and
 * the first rename would make them disagree (allowed-pattern #23).
 *
 * TWO SEGMENTS WHEN IT IS NESTED. A checkout lives at
 * `.{repo}-threads/worktree/<name>`, so its NAME is `worktree/<name>` — and a
 * caller handed only the basename rebuilds the path one level too shallow,
 * looks in a folder that does not exist, and reports the checkout missing.
 *
 * Null for a checkout named after a thread id — those have no name yet, which
 * is precisely what the upgrade migration is for, and a uuid is the one thing
 * this surface must never print.
 *
 * IN SHARED, NOT IN MAIN. The panel shows this name and main passes it to the
 * CLI; two spellings of "what is this checkout called" would disagree on the
 * first nested path either of them met (allowed-pattern #14).
 */
export function checkoutName(path: string | null): string | null {
  const trimmed = path?.replace(/\/+$/, '') ?? ''
  if (trimmed === '') return null
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  if (base === '' || isUnnamedCheckoutPath(trimmed)) return null
  const above = trimmed.slice(0, trimmed.lastIndexOf('/'))
  const folder = WORKTREE_FOLDER_PREFIX.replace(/\/$/, '')
  return above.slice(above.lastIndexOf('/') + 1) === folder ? `${folder}/${base}` : base
}

/**
 * The same name, made unique against the ones already taken.
 *
 * TWO CONVERSATIONS ABOUT ONE THING IS THE COMMON CASE, not an edge: titles
 * repeat, and two checkouts cannot share a directory. The ladder is the one
 * branch naming already uses (`-2`, `-3`), so a person meeting both sees one
 * convention.
 *
 * The caller supplies what is taken — this module never reads a disk.
 */
export function uniqueWorktreeName(name: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const entry of taken) {
    const trimmed = entry.trim()
    if (trimmed !== '') used.add(trimmed)
  }
  if (!used.has(name)) return name
  // `-2` is the SECOND one, which is what a person counting would say — there
  // is no `-1`, because the first has no suffix at all.
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${name}-${n}`
    if (!used.has(candidate)) return candidate
  }
  // A thousand checkouts of one name is not a case to solve, but it is a case
  // to not hang on: fall through to something unique rather than loop for ever.
  return `${name}-${Date.now().toString(36)}`
}

/**
 * The name a checkout should get, from everything known at the cut.
 *
 * ONE ENTRY POINT so the panel, the chip, main and the migration cannot each
 * assemble the pieces in a different order. A typed name wins and is validated
 * by its caller; an absent one is derived; either way the result is unique
 * against what exists.
 */
export function worktreeNameFor(input: {
  typed?: string | null
  title: string | null
  taken?: Iterable<string>
}): string {
  const typed = input.typed?.trim() ?? ''
  const base = typed === '' ? worktreeNameFromTitle(input.title) : typed
  return uniqueWorktreeName(base, input.taken ?? [])
}

/**
 * Whether a path's last segment is a thread id rather than a name.
 *
 * The migration's subject: a checkout whose directory is a UUID is one nobody
 * named, and is exactly what the upgrade renames. Anything else — including a
 * name a person chose that happens to look odd — is left alone.
 */
export function isUnnamedCheckoutPath(path: string): boolean {
  const trimmed = path.replace(/\/+$/, '')
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return UUID_RE.test(base)
}
