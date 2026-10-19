// LIST-QUERY GUARD — catch the mistake where it is typed, not on the board.
//
// The board's Remote column runs a saved query VERBATIM against the tracker
// (that is the feature: the user's own search language). But a person naturally
// pastes a repository URL or a bare `owner/repo` into the field, and GitHub's
// Search API takes that as free-text tokens rather than a repo filter — so it
// returns unrelated issues that match those words, and the board faithfully
// draws them. The list then diverges completely from what the same repo shows
// on GitHub, and nothing tells the user their query is the problem.
//
// This module is the detector. It is PURE — no DOM, no IPC, no network — so the
// rule is one table-tested function. It never rewrites what the user typed; it
// only says "this looks wrong" and OFFERS a scoped rewrite the user can accept
// with one click (allowed-pattern #22: sanitize what you PROPOSE, validate what
// you were TOLD — here we only propose).

import type { IntegrationProvider } from '../../shared/ipc-contract'

/** What the guard concluded about one saved/typed query. */
export interface ListQueryInspection {
  /**
   * True when the query is clearly not a search expression for its tracker —
   * a URL, a bare `owner/repo`, a repo path. NOT a claim that a valid-looking
   * query returns what the user wants; only that this string will be read as
   * free text and almost certainly surprise them.
   */
  looksMalformedForSearch: boolean
  /** Why, in the user's terms — never raw API prose (forbidden-pattern #12). */
  reason: string | null
  /** A scoped query to OFFER, or null when we cannot confidently build one. */
  suggestion: string | null
}

const OK: ListQueryInspection = { looksMalformedForSearch: false, reason: null, suggestion: null }

/**
 * The qualifiers that mark a string as an intentional GitHub search rather than
 * free text. The presence of ANY one means the user is speaking the search
 * language, and we leave it alone.
 */
const GITHUB_QUALIFIERS =
  /\b(repo|org|user|is|state|assignee|author|label|in|type|involves|mentions|milestone|project|no|linked):/i

/** A `github.com/owner/repo[/…]` URL, with or without scheme. */
const GITHUB_URL = /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s?#]+)/i

/**
 * A bare `owner/repo` (optionally trailed by `/issues`, `/pulls`, `#12`, …).
 * `owner` and `repo` follow GitHub's own name rules: letters, digits, `-`,
 * `_`, `.`. Anchored so a query that merely CONTAINS a slash (e.g. a search
 * with a path-like value) is not mistaken for a repo path.
 */
const BARE_OWNER_REPO = /^([\w.-]+)\/([\w.-]+?)(?:\/(?:issues|pulls)\/?)?(?:#\d+)?$/

/** Strip a GitHub name of a trailing `.git`, which a copied clone URL carries. */
function cleanRepoName(repo: string): string {
  return repo.replace(/\.git$/i, '')
}

/** The scoped search we offer for a recognised `owner/repo`. */
function scopedSuggestion(owner: string, repo: string): string {
  return `repo:${owner}/${cleanRepoName(repo)} is:issue is:open`
}

/**
 * Inspect a saved/typed list query for one provider.
 *
 * GitHub is the only tracker this guards today — Jira (JQL) and Azure (WIQL)
 * have different "obviously not a query" shapes and get their own detection
 * when they are built. They pass through as OK for now (the extension point is
 * this switch), never flagged, so nothing a Jira/Azure user typed is second-
 * guessed by a rule written for GitHub.
 *
 * An empty/whitespace query is OK, not malformed: clearing the field is a real
 * choice the store honours ("assigned only"), so flagging it would nag about a
 * deliberate blank.
 */
export function inspectListQuery(
  provider: IntegrationProvider,
  query: string,
): ListQueryInspection {
  const trimmed = query.trim()
  if (trimmed.length === 0) return OK
  if (provider !== 'github') return OK

  // A GitHub search the user clearly meant — leave it alone.
  if (GITHUB_QUALIFIERS.test(trimmed)) return OK

  // A pasted repository URL.
  const url = GITHUB_URL.exec(trimmed)
  if (url) {
    return {
      looksMalformedForSearch: true,
      reason: 'This looks like a repository link, not a GitHub search — it will match issues by text, not by repo.',
      suggestion: scopedSuggestion(url[1], url[2]),
    }
  }

  // A bare `owner/repo` (with or without a trailing /issues, /pulls, #n).
  const bare = BARE_OWNER_REPO.exec(trimmed)
  if (bare) {
    return {
      looksMalformedForSearch: true,
      reason: 'This looks like a repository path, not a GitHub search — it will match issues by text, not by repo.',
      suggestion: scopedSuggestion(bare[1], bare[2]),
    }
  }

  // A value with a path-like slash but no qualifier — probably not a search,
  // but we cannot name a repo to suggest, so we flag without a rewrite.
  if (trimmed.includes('/') && !trimmed.includes(' ')) {
    return {
      looksMalformedForSearch: true,
      reason: 'This does not look like a GitHub search. A search uses qualifiers such as repo:owner/name is:issue is:open.',
      suggestion: null,
    }
  }

  return OK
}
