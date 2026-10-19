// THE IDENTITY GATE — no tracked file names the person who wrote it.
//
// This repo was scrubbed once for a public release, and the scrub was a PASS,
// not a gate. Work that landed afterwards never went through it: a PR link in
// `docs/pilots/native-codex/README.md` carried the author's GitHub namespace
// onto `main` and sat there until someone read the file by hand. A one-time
// pass cannot hold a moving tree.
//
// WHY THIS GATE DOES NOT NAME ANY OF THE STRINGS IT GUARDS AGAINST.
// The full scrub family (employer, products, internal hosts, ticket keys) lives
// in `flow/publish-pattern-family.py`, which is deliberately UNTRACKED: it is a
// concentrated list of every string being removed, so tracking it would publish
// the thing the scrub exists to remove. That file is the publish-time gate, run
// through `npm run publish:scan`.
//
// So this gate carries no literals at all. It derives what to look for from the
// machine's own git identity at runtime, which means:
//
//  - it guards whoever is working, not one hardcoded person;
//  - it keeps working for a contributor whose name nobody here anticipated;
//  - and it never becomes the leak it is checking for.
//
// It catches the class that actually escaped — a personal namespace inside a
// URL — because a name is a substring of the namespace built from it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shorter than this, a name fragment matches too much ordinary prose. */
export const MIN_NEEDLE = 4;

/**
 * Names that identify nobody, so a machine configured with one is not a leak.
 * Placeholders are the whole point of the repo's fixtures (`acme`, `me@here`),
 * and CI commonly runs as a bot.
 */
const PLACEHOLDER = new Set([
  'none', 'null', 'unknown', 'user', 'users', 'test', 'tester', 'example',
  'acme', 'local', 'localhost', 'admin', 'root', 'name', 'your', 'ours',
  'github', 'action', 'actions', 'runner', 'bot', 'robot', 'noreply', 'flow',
  'qa', 'dev', 'developer', 'build', 'builder', 'ci', 'agent', 'claude',
  'anthropic', 'nobody', 'someone', 'somebody', 'anon', 'anonymous',
]);

/**
 * Tracked paths allowed to carry an identity needle, each with its reason.
 *
 * An entry prints when the gate runs: an excuse that says nothing is how a
 * gate quietly stops gating.
 *
 * AN ENTRY IS NOT A PASS FOR THE FILE. The file is still read and still
 * scanned, and the allowance covers exactly ONE shape of line: a needle that
 * appears only inside this project's own repository URL (`onlyOwnRepoUrl`).
 * Any other needle in the file still refuses. A file-level excuse — which is
 * what this used to be — would hand the next leak a tracked file to ship
 * through unread, and would not even count it as scanned. Same two-condition
 * rule the scrub's SECRET fixtures follow: the right file AND the right shape.
 */
export const ALLOWED = Object.freeze({
  'package.json': {
    shape: 'own-repo-url',
    why: "the repository, homepage and issues URLs name this project's own repo",
  },
  CONTRIBUTORS: {
    shape: 'credit-line',
    why: 'a credits file: naming the people who wrote this is its entire purpose',
  },
});

/** Split a configured identity into the fragments worth searching for. */
export function identityNeedles({ userName = '', userEmail = '' } = {}) {
  const found = new Set();
  const add = (raw) => {
    const value = String(raw ?? '').trim().toLowerCase();
    if (value.length < MIN_NEEDLE) return;
    if (PLACEHOLDER.has(value)) return;
    found.add(value);
  };

  // Every word of the name, and the whole name with the spaces closed up —
  // which is the form that ends up in a URL (`github.com/<first><last>/…`).
  const nameParts = userName.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const part of nameParts) add(part);
  if (nameParts.length > 1) add(nameParts.join(''));

  // The address, but only when its local part identifies somebody. A CI
  // machine's `noreply@github.com` is a full address whose every fragment is a
  // placeholder, so adding the address itself would smuggle past the filter
  // the fragments were just rejected by — and then match the hostname in every
  // legitimate GitHub URL in the repo.
  const email = userEmail.trim().toLowerCase();
  if (email.includes('@')) {
    const local = email.slice(0, email.indexOf('@')).split('+')[0];
    // A local part is often first.last or firstlast; both halves identify.
    const fragments = [local, local.replace(/[^\p{L}\p{N}]+/gu, ''),
                       ...local.split(/[^\p{L}\p{N}]+/u).filter(Boolean)];
    const before = found.size;
    for (const fragment of fragments) add(fragment);
    if (found.size > before) add(email);
  }

  return [...found].sort();
}

/** Read the identity git itself would stamp on a commit here. */
export function gitIdentity(root) {
  const read = (key) => {
    try {
      return execFileSync('git', ['-C', root, 'config', '--get', key], {
        encoding: 'utf8',
      }).trim();
    } catch {
      return ''; // unset is a normal answer, not a failure
    }
  };
  return { userName: read('user.name'), userEmail: read('user.email') };
}

/** Every tracked path — the publish is a squash of exactly this set. */
export function trackedFiles(root) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/**
 * Substring, case-insensitive, no word boundaries — on purpose.
 *
 * `\b` would have missed the hit this gate exists for: in `marlowefenwick` the
 * surname is preceded by a letter, so a boundary-anchored search finds nothing
 * there. A leak gate takes the stricter reading and lets ALLOWED carry the
 * exceptions by name.
 */
export function findNeedles(text, needles) {
  const lower = text.toLowerCase();
  return needles.filter((needle) => lower.includes(needle));
}

/**
 * The GitHub namespaces this project declares as its own home.
 *
 * DERIVED, never written down. The publishing account's name is itself one of
 * the needles, so a literal here would make this file the leak it checks for —
 * a mistake this gate has already caught once, in its own comments.
 *
 * No readable manifest means no allowance: refusing is the safe direction.
 */
export function ownRepoPrefixes(root, readFile = readFileSync) {
  let manifest;
  try {
    manifest = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(readFile(join(root, 'package.json'))),
    );
  } catch {
    return [];
  }
  const prefixes = new Set();
  for (const raw of [manifest?.repository?.url, manifest?.homepage, manifest?.bugs?.url]) {
    const found = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(String(raw ?? ''));
    if (found) prefixes.add(`github.com/${found[1]}/${found[2]}`.toLowerCase());
  }
  return [...prefixes];
}

/**
 * True when every needle on this line sits inside the project's own repo URL.
 *
 * The URL is cut out of the line and what remains is searched again — so the
 * allowance covers the URL and nothing else sharing its line. An address, a
 * home directory or a second name beside it still refuses.
 */
export function onlyOwnRepoUrl(line, needles, prefixes) {
  if (prefixes.length === 0) return false;
  let rest = line.toLowerCase();
  for (const prefix of prefixes) rest = rest.split(prefix).join(' ');
  return findNeedles(rest, needles).length === 0;
}

/**
 * True when this line is a credits entry: a name, and nothing contactable.
 *
 * A credits file names people deliberately, so a bare name there is content,
 * not a leak. What this gate is actually for is the stuff that travels WITH a
 * name — an address, a GitHub namespace, a home directory, an employer — so the
 * shape admits letters, marks, spaces and the punctuation names really use, and
 * refuses a line carrying `@`, a slash, a colon, a digit or a bracket.
 */
export function isCreditLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('-')) return false;
  const name = trimmed.slice(1).trim();
  if (name === '') return false;
  return /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(name);
}

/** The allowance predicates, by the `shape` an ALLOWED entry names. */
const SHAPES = Object.freeze({
  'own-repo-url': (line, needles, prefixes) => onlyOwnRepoUrl(line, needles, prefixes),
  'credit-line': (line) => isCreditLine(line),
});

/**
 * Scan the tracked tree. Returns hits with line numbers, plus what was skipped
 * and why — a reader of the output can always tell gating from not gating.
 */
export function scanTracked({ root, needles, readFile = readFileSync } = {}) {
  const hits = [];
  const excused = [];
  const skipped = { binary: 0, unreadable: [] };
  if (needles.length === 0) return { hits, excused, skipped, scanned: 0 };

  const prefixes = ownRepoPrefixes(root, readFile);
  let scanned = 0;
  for (const rel of trackedFiles(root)) {
    let text;
    try {
      // utf-8 only, strictly: a lossy decode cannot fail, and a decode that
      // cannot fail invents matches out of binary noise.
      text = new TextDecoder('utf-8', { fatal: true }).decode(readFile(join(root, rel)));
    } catch (error) {
      if (error instanceof TypeError) {
        skipped.binary += 1; // not text; the family scanner does the byte pass
      } else {
        skipped.unreadable.push([rel, String(error?.message ?? error)]);
      }
      continue;
    }
    scanned += 1;
    const matched = findNeedles(text, needles);
    if (matched.length === 0) continue;
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      const onLine = findNeedles(line, matched);
      if (onLine.length === 0) continue;
      const text_ = line.trim().slice(0, 160);
      const allowance = ALLOWED[rel];
      if (allowance !== undefined && SHAPES[allowance.shape]?.(line, onLine, prefixes) === true) {
        excused.push({ file: rel, line: index + 1, why: allowance.why, text: text_ });
        continue;
      }
      for (const needle of onLine) hits.push({ file: rel, line: index + 1, needle, text: text_ });
    }
  }
  return { hits, excused, skipped, scanned };
}
