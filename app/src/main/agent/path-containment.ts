// Project-root containment for agent file edits (#62). A session must be STRICT
// to its own project — a thread in project A must not write into project B (a
// clone with the same codebase). The SDK's cwd/additionalDirectories scope is
// NOT enforced under bypassPermissions (Autonomous mode), and canUseTool is
// skipped there, so containment is enforced in a PreToolUse hook that fires in
// every permission mode. This module is the pure decision it uses.

import { tmpdir } from 'os'
import { posix as posixPath, win32 as win32Path, type PlatformPath } from 'path'

/**
 * The platform whose shell/path rules apply. Defaults to `process.platform`
 * everywhere, so no call site changes; tests pin it to exercise the Windows
 * branch from any host (NFR3 — platform branches testable without the platform).
 */
export type ContainmentPlatform = NodeJS.Platform | string

/**
 * The path flavor a platform's containment arithmetic must use. On darwin (and
 * Linux) this is `path.posix`, which is exactly what a bare `require('path')`
 * resolved to before — the POSIX branch is unchanged by construction. On win32
 * it is `path.win32`, which is not a nicety: Windows paths are case-insensitive
 * (`C:\Users` and `c:\users` are ONE path), accept `/` as a separator, and carry
 * drive letters. POSIX `path` gets all three wrong, and gets them wrong in the
 * dangerous direction — it reports an escaping path as contained.
 */
function pathFor(platform: ContainmentPlatform): PlatformPath {
  return platform === 'win32' ? win32Path : posixPath
}

/**
 * A target resolved for the root check: absolute as written, anything else
 * from the primary root. `~` is NOT expanded on POSIX — the known hole the
 * "POSIX `~` is NOT guarded" tests pin; closing it is a product decision
 * (agents copy files the person points at in ~/Downloads that way).
 */
function resolveTarget(target: string, primary: string, platform: ContainmentPlatform): string {
  const p = pathFor(platform)
  return p.isAbsolute(target) ? p.resolve(target) : p.resolve(primary, target)
}

/** Tools that write files — subject to root containment. */
export const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Tools that read files/dirs — scoped to the selected project(s), same as writes
 *  (#503): the agent must not LOOK at a project the user hasn't selected. */
export const FILE_READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])

/** The file path a write tool acts on, from its input, or null. */
export function editFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const candidate = record.file_path ?? record.notebook_path
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

/** True when `target` is `root` or lexically nested inside it. Exported so the
 *  auto-attach decision (phase 6) shares the ONE nesting definition with the
 *  containment checks (allowed-pattern #14).
 *
 *  On win32 the comparison runs through `path.win32`, whose `relative` folds
 *  case — so `c:\users\me\proj\x` is correctly seen as inside `C:\Users\me\proj`
 *  instead of being read as a different path that happens to look similar. */
export function isInside(
  root: string,
  target: string,
  platform: ContainmentPlatform = process.platform,
): boolean {
  const p = pathFor(platform)
  const rel = p.relative(p.resolve(root), target)
  return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel))
}

// ── Windows path shapes (Phase 4) ───────────────────────────────────────────
// `path.win32` handles drive letters, case folding and `/` separators, but four
// Windows path shapes are not arithmetic at all — they resolve against state
// this module cannot see, and `path.win32` resolves them SILENTLY and WRONGLY,
// which is a false ALLOW:
//
//   `C:foo`      drive-relative — resolves against C:'s *current directory*,
//                which is per-process and unknowable here. `win32.resolve` maps
//                it onto whatever base it was handed, so it lands "inside" the
//                root while the real write goes somewhere else entirely.
//   `~\x`        the user profile. `win32.resolve` treats `~` as an ordinary
//                directory NAME, so `~\evil.txt` reads as `<root>\~\evil.txt`.
//   `\\?\…`      the Win32 device namespace, which bypasses normal resolution
//   `\\.\…`      (and normalization) altogether.
//   `$x`, `%X%`  a value that only exists at run time.
//
// So these are not resolved and compared — they are refused. Verified against
// Node's own `path.win32` on a Windows host, not inferred from documentation
// (allowed-pattern #11).

/** `\\?\` and `\\.\` — the Win32 device namespace. */
const WINDOWS_DEVICE_NAMESPACE = /^\\\\[?.]\\/
/** `C:foo` — a drive letter with NO root separator after it. */
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/
/** A leading `~`, which PowerShell expands to the user profile. */
const WINDOWS_HOME_SHORTHAND = /^~(?:[\\/]|$)/
/** Run-time expansions inside a token: `$(…)`, `${…}`, `@(…)`, `%VAR%`, and the
 *  PowerShell escape character, any of which can rewrite the path after this
 *  check has already passed on it. */
const WINDOWS_RUNTIME_EXPANSION = /\$\(|\$\{|@\(|`|%[A-Za-z_][A-Za-z0-9_]*%/
/** PowerShell literals that look like variables but are constants — `> $null`
 *  is the idiomatic Windows discard and must not be mistaken for a path. */
const WINDOWS_SAFE_LITERALS = new Set(['$null', '$true', '$false'])

/**
 * Why a Windows path token cannot be contained by lexical arithmetic, or null
 * when it can. A non-null answer is a DENY, never a best-effort resolve: the
 * whole point of the Windows branch is that "I could not read this" and "this is
 * fine" are different answers (Phase 4, default-deny).
 */
export function windowsPathUnsafeReason(target: string): string | null {
  if (WINDOWS_SAFE_LITERALS.has(target.toLowerCase())) return null
  if (WINDOWS_DEVICE_NAMESPACE.test(target)) {
    return 'it uses the Win32 device namespace, which bypasses normal path resolution'
  }
  if (WINDOWS_DRIVE_RELATIVE.test(target)) {
    return "it is drive-relative, so it resolves against that drive's current directory rather than any root"
  }
  if (WINDOWS_HOME_SHORTHAND.test(target)) {
    return 'it starts at the user profile, which is outside every project root'
  }
  if (target.startsWith('$')) {
    return 'it is a variable whose value is only known at run time'
  }
  if (WINDOWS_RUNTIME_EXPANSION.test(target)) {
    return 'it contains an expansion that is only resolved at run time'
  }
  return null
}

/** The path a read tool targets: `Read.file_path`, or `Grep`/`Glob`/`LS`.path.
 *  Null when omitted — Grep/Glob default to cwd, always inside a root (#503). */
export function readTargetPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const candidate = record.file_path ?? record.path
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

/**
 * True when `filePath` resolves OUTSIDE every one of the thread's `roots` — an
 * edit that must be blocked. A relative path is resolved against the primary
 * root (cwd = roots[0]), so it is always inside. With no roots, nothing is
 * enforced (returns false). Lexical only — `flow/` (a symlink to the vault)
 * stays allowed because the path is lexically inside the root.
 */
export function editEscapesRoots(
  filePath: string,
  roots: readonly string[],
  platform: ContainmentPlatform = process.platform,
): boolean {
  if (!filePath || roots.length === 0) return false
  // Windows shapes that cannot be resolved lexically count as an escape — a
  // path this module cannot read is never quietly treated as contained.
  if (platform === 'win32' && windowsPathUnsafeReason(filePath) !== null) return true
  const abs = resolveTarget(filePath, roots[0], platform)
  return !roots.some((root) => isInside(root, abs, platform))
}

// ── Bash containment (#82) ──────────────────────────────────────────────────
// The edit tools above are not the only write path: under Autonomous mode
// (bypassPermissions) canUseTool is skipped, so a `Bash` call can write into a
// sibling project via redirection / cp / mv / sed -i / tee, reopening #62. So
// Bash gets its own containment: parse the command's WRITE targets (best-effort)
// and deny when a target escapes every root. Reads are also scoped now (#503) —
// path-argument read verbs are checked the same way; temp dirs and /dev sinks are
// always allowed (not project corruption / not an unselected project).

/** Absolute write targets that are never project corruption (temp + /dev). */
const DEV_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/zero'])

/** Shell verbs whose absolute-path arguments are treated as write targets. */
const BASH_WRITE_VERBS = new Set([
  'cp', 'mv', 'install', 'rsync', 'ln', 'rm', 'rmdir', 'truncate', 'mkdir', 'touch', 'chmod',
  'chown', 'dd',
])

/** Shell verbs whose path arguments are READ targets — scoped to the selected
 *  project(s) so the agent can't `cat`/`find` its way into an unselected repo
 *  (#503). grep-family (grep/rg/ag/egrep/fgrep) is DELIBERATELY excluded: their
 *  first arg is a search PATTERN (often slash-bearing), so scanning args would
 *  false-positive — the native Grep/Glob tools cover search and are contained. */
const BASH_READ_VERBS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'nl', 'tac', 'wc', 'stat', 'file', 'xxd', 'od',
  'readlink', 'realpath', 'ls', 'du', 'tree', 'find', 'diff', 'cmp',
])

// ── Where a verb has to appear to BE a verb ─────────────────────────────────
//
// THE FALSE POSITIVE THIS FIXES BROKE A WHOLE FEATURE. Both lists used to be
// matched with `\b<verb>\b` against the ENTIRE command string, so any command
// merely CONTAINING one of these words turned on the path scan below — and the
// scan then treats every whitespace-separated token as a candidate path,
// including prose inside quotes. The agent loops are named `find` and `fix`, so
//
//     planflow-ai loop next --loop find --focus "tenant id / tenant alias"
//
// read as a `find` invocation whose arguments included the path `/`, which is
// outside every project root — and the gate blocked the one command the loop
// cannot start without. Nothing in it reads anything. `git commit -m "rm the
// old dir"` failed the same way, on the write half.
//
// A verb is a verb where a COMMAND can appear: first word of the command, or of
// any segment after a separator, or of a subshell — plus the word after it, so
// `git rm`, `npm install` and `docker cp` still count. Anywhere else it is an
// argument, a flag value, or someone's prose.

/** Anything that starts a fresh command: separators, subshells, blocks. */
const SEGMENT_BREAK = /[\n;|&()`{}]+/

/** Words that PREFIX a real command rather than being one. */
const COMMAND_PREFIXES = new Set([
  'sudo', 'env', 'nohup', 'time', 'nice', 'command', 'builtin', 'exec', 'xargs', 'then', 'else',
  'do', 'if', 'while', 'until',
])

/** `FOO=bar` — an environment assignment before the command proper. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * The words in COMMAND POSITION: for each segment, the command itself (basename,
 * so `/bin/cat` counts) and the word right after it (the subcommand). Exported
 * for the tests that pin the rule.
 */
export function commandHeads(command: string): string[] {
  const heads: string[] = []
  for (const segment of command.split(SEGMENT_BREAK)) {
    const tokens = segment.trim().split(/\s+/).filter((token) => token.length > 0)
    let index = 0
    while (
      index < tokens.length &&
      (ASSIGNMENT.test(tokens[index]) || COMMAND_PREFIXES.has(tokens[index]))
    ) {
      index += 1
    }
    const head = tokens[index]
    if (head === undefined) continue
    heads.push(head.split('/').pop() ?? head)
    // The subcommand — `git rm`, `npm install`, `docker cp` are real writes.
    const sub = tokens[index + 1]
    if (sub !== undefined && !sub.startsWith('-')) heads.push(sub)
  }
  return heads
}

/** True when the command RUNS one of `verbs`, rather than merely mentioning it. */
function runsVerb(command: string, verbs: ReadonlySet<string>): boolean {
  return commandHeads(command).some((head) => verbs.has(head))
}

/**
 * The path-like tokens in a command, with quoted PROSE left out.
 *
 * THE SCAN GOT BROADER AND PROSE CAME WITH IT. Upstream #1647 stopped gating
 * the whole-token scan on a write verb — an allowlist of write verbs cannot
 * enumerate the ways a shell writes (`curl -o`, `tar -C`), so anything not
 * provably a read is scanned. Right call, and it means every word of every
 * quoted argument became a path candidate:
 *
 *     planflow-ai loop next --loop find --focus "tenant id / tenant alias"
 *
 * tokenized to `tenant`, `id`, `/`, `tenant`, `alias` — and `/` resolves to the
 * filesystem root, outside every project. The one command a loop cannot start
 * without was refused as a cross-project WRITE to `/`.
 *
 * So OUTSIDE quotes nothing changes — `rm -rf /` yields the same `/` token it
 * always did — and INSIDE them only path-SHAPED runs are taken: a slash (or
 * `./`, `../`, `~/`) followed by at least one more character. That keeps the
 * embedded path in `python3 -c "open('/Users/me/exfil/e','w')"` (#1647's pin,
 * which the first cut of this rule broke by treating the whole quoted
 * expression as one opaque token) while a lone slash between two words stays
 * what it is: punctuation in a sentence.
 */
export function pathCandidates(command: string): string[] {
  const targets: string[] = []
  command = withoutPlanflowArguments(withoutHeredocBodies(command))
  // A NETWORK URL IS NOT A PATH, and the scan below cannot tell on its own:
  // `QUOTED_PATH` accepts `:` as a leading delimiter, so `https://host/x` gives
  // up its scheme and yields `//host/x` — absolute on posix, outside every root,
  // denied. That is how `curl -s "https://dev.azure.com/…"` came back as "this
  // shell command writes outside this thread's projects" while `cd` into the
  // very same project succeeded (user, 2026-09-16). The module's own comment
  // said a URL "resolves inside a root and is dropped"; it does not.
  //
  // `file:` IS DELIBERATELY ABSENT. It names a real local path, so it stays
  // scannable — the exemption is for addresses that cannot be a file, not for
  // any token wearing a scheme.
  command = command.replace(NETWORK_URL, 'url')
  const QUOTED = /'([^']*)'|"([^"]*)"/g
  const unquoted: string[] = []
  let lastIndex = 0
  let quoted = QUOTED.exec(command)
  while (quoted !== null) {
    unquoted.push(command.slice(lastIndex, quoted.index))
    const inner = quoted[1] ?? quoted[2] ?? ''
    // A quoted run of slashes alone (`//` out of `sed 's/^a\/b://'`) is
    // punctuation, not the filesystem root; an unquoted `/` still counts.
    for (const found of inner.matchAll(QUOTED_PATH)) if (!/^\/+$/.test(found[2])) targets.push(found[2])
    for (const found of inner.matchAll(QUOTED_TRAVERSAL)) targets.push(found[2])
    lastIndex = quoted.index + quoted[0].length
    quoted = QUOTED.exec(command)
  }
  unquoted.push(command.slice(lastIndex))
  for (const segment of unquoted) {
    for (const found of segment.matchAll(BARE_TOKEN)) targets.push(found[1])
  }
  return targets
}

/**
 * Interpreters whose heredoc body is CODE, not data.
 *
 * `bash <<EOF … EOF` runs its body. Anything path-shaped in there is a path the
 * shell will really open, so the scan must keep seeing it — the exemption below
 * exists for prose, not for a way to smuggle a command past the gate.
 */
const HEREDOC_INTERPRETERS = new Set([
  'bash', 'sh', 'zsh', 'ksh', 'dash', 'python', 'python3', 'node', 'ruby', 'perl', 'php', 'osascript', 'env', 'xargs',
])

/** `<<` or `<<-`, optional quotes, then the delimiter word. */
const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/

/**
 * The command with its heredoc BODIES removed.
 *
 * A HEREDOC BODY IS DATA, AND DATA IS NOT ARGUMENTS. Reported live
 * (2026-09-08): four `git commit` calls in a row refused with "this shell
 * command reads outside this thread's project". The command was
 *
 *     git commit -m "$(cat <<'EOF'
 *     … paid a redundant POST /v1/chats — each of those is a separate request
 *     EOF
 *     )"
 *
 * and the scan reported `/active` and `/v1/chats` — REST routes in the commit
 * MESSAGE — as absolute paths outside the root. Every retry failed the same
 * way, because rewording prose cannot fix a rule that reads prose as paths.
 * (`cat` is what turns the read scan on, and it is genuinely in verb position
 * inside the substitution, so the verb gate was working exactly as designed.)
 *
 * The body of a heredoc is fed to a command's stdin. It is never a path
 * argument the shell resolves, so dropping it cannot let a real escape past —
 * with one exception, which is why `HEREDOC_INTERPRETERS` exists: a body piped
 * into a shell or an interpreter IS code, and its paths are real.
 *
 * Unterminated heredocs are dropped to the end of the string: an unclosed body
 * is still body, and treating the remainder as arguments is the same mistake in
 * a rarer shape.
 */
export function withoutHeredocBodies(command: string): string {
  if (!command.includes('<<')) return command
  // Conservative: if anything in this command line runs an interpreter, the
  // body may be executed. Scan it all, exactly as before.
  if (runsVerb(command, HEREDOC_INTERPRETERS)) return command
  const lines = command.split('\n')
  const kept: string[] = []
  let delimiter: string | null = null
  for (const line of lines) {
    if (delimiter !== null) {
      // `<<-` allows the terminator to be indented with tabs; comparing the
      // trimmed line accepts both forms and costs nothing for the plain one.
      if (line.trim() === delimiter) delimiter = null
      continue
    }
    kept.push(line)
    const start = HEREDOC_START.exec(line)
    if (start !== null) delimiter = start[2] ?? null
  }
  return kept.join('\n')
}

// ── plan-flow's own CLI is not a path the shell opens ───────────────────────
//
// REPORTED LIVE (2026-10-08): a discovery in a two-project Workspace ran
//
//     planflow-ai blueprint propose --plan x --node "endpoint:POST /api/apps/rebuild" --kind endpoint
//
// and was refused as "writes outside this thread's projects (#62)" — and, with
// `| tail -3` appended, as "reads outside … (#503)". Since #1647 every token of
// a command that is not provably a read is a path candidate, so the REST route
// inside the quoted node id was read as an absolute path. The agent then worked
// around the refusal by turning the sandbox off: a false positive in a guard is
// not merely inconvenient, it teaches the agent to remove the guard.
//
// The ARGUMENTS of plan-flow's own CLI (`planflow-ai`, which the app pins on
// PATH, and its `plan-flow` bin name) are ids, routes, prose and JSON the CLI
// validates itself — not paths the shell resolves. So, for a segment whose
// command head is that CLI, the arguments are dropped from the path scan. What
// is NOT dropped, and is scanned exactly as before:
//   - redirections on that segment (`> /etc/x`, `2>/x`, `< /x`) — kept in place
//     here, and the write gate's own redirection/tee/`of=` scans run over the
//     original command regardless;
//   - every OTHER segment of the same line (`cd`, `| tail`, `&& rm /x`, `;`);
//   - any segment holding a command substitution (`$(…)`, backticks, `<(…)`),
//     whose inner command the shell really runs — that segment is left whole.
// Segments are split on UNQUOTED separators only, so a `|` inside a quoted
// argument (`--text "a | /etc/x"`) neither breaks the segment nor gets scanned.
// An unbalanced quote leaves the whole command as it was: unreadable is never
// treated as clean.

/** Basenames of plan-flow's own CLI binary. */
const PLANFLOW_CLI_HEADS = new Set(['planflow-ai', 'plan-flow'])

/** Characters that start a fresh command when they appear unquoted. */
const UNQUOTED_SEGMENT_BREAK = new Set(['\n', ';', '|', '&', '(', ')', '{', '}'])

/** Anything that makes the shell execute text found inside an argument. */
const COMMAND_SUBSTITUTION = /\$\(|`|<\(|>\(/

/** A redirection operator, possibly with its target glued on (`2>/x`, `>>f`). */
const REDIRECTION_TOKEN = /^(?:\d*>>?|&>>?|\d*<{1,3}|\d*<>)/

/** Ranges of the command split on unquoted separators, or null when a quote
 *  never closes (the caller then leaves the command exactly as it was). */
function unquotedSegments(command: string): Array<[number, number]> | null {
  const ranges: Array<[number, number]> = []
  let start = 0
  let quote: "'" | '"' | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (ch === '\\') {
      i += 1 // an escaped character is never a separator or a quote
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (UNQUOTED_SEGMENT_BREAK.has(ch)) {
      ranges.push([start, i])
      start = i + 1
    }
  }
  if (quote !== null) return null
  ranges.push([start, command.length])
  return ranges
}

/** The shell words of one segment, quotes kept on (so a quoted word stays one). */
function shellWords(segment: string): string[] {
  return [...segment.matchAll(/(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+/g)].map((m) => m[0])
}

/** The segment reduced to its command head and its redirections, when the head
 *  is plan-flow's CLI; null when it is anything else (scan it as it is). */
function planflowSegmentRemainder(segment: string): string | null {
  if (COMMAND_SUBSTITUTION.test(segment)) return null
  const words = shellWords(segment)
  let index = 0
  while (
    index < words.length &&
    (ASSIGNMENT.test(words[index]) || COMMAND_PREFIXES.has(words[index]))
  ) {
    index += 1
  }
  const head = words[index]
  if (head === undefined) return null
  if (!PLANFLOW_CLI_HEADS.has(head.split('/').pop() ?? head)) return null
  const kept: string[] = []
  for (let i = index + 1; i < words.length; i++) {
    const word = words[i]
    const operator = REDIRECTION_TOKEN.exec(word)
    if (operator === null) continue
    kept.push(word)
    // `> /x` — the operator alone; its target is the next word.
    if (operator[0] === word && i + 1 < words.length) kept.push(words[++i])
  }
  return ` ${kept.join(' ')} `
}

/**
 * The command with the ARGUMENTS of every plan-flow CLI segment removed — see
 * the note above. Exported for the tests that pin the rule.
 */
export function withoutPlanflowArguments(command: string): string {
  if (!/\b(?:planflow-ai|plan-flow)\b/.test(command)) return command
  const ranges = unquotedSegments(command)
  if (ranges === null) return command
  let out = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    const remainder = planflowSegmentRemainder(command.slice(start, end))
    if (remainder === null) continue
    out += command.slice(cursor, start) + remainder
    cursor = end
  }
  return out + command.slice(cursor)
}

/**
 * A path-shaped run INSIDE a quoted argument: `/x`, `./x`, `../x`, `~/x` —
 * never a slash on its own, which in quoted text is punctuation far more often
 * than it is the filesystem root.
 *
 * IT HAS TO START A WORD, and that is not a nicety: `sed -i 's/a/b/' f.ts`
 * carries `/a/b/` inside its expression, and a rule that read any slash-run as
 * a path denied a sed that writes to a file inside the root. Preceded by a word
 * character it is part of a word — an expression, a regex, a date — and only a
 * run that begins where a word begins is a path.
 *
 * THE BARE PARENT IS ITS OWN ALTERNATIVE (#1720). The main branch requires at
 * least one character after the path prefix, so a quoted target of exactly
 * `..` or `../` — one level up, the shortest possible escape — yielded zero
 * candidates while every deeper climb was caught. The alternative takes `..`
 * (optionally slash-terminated) only when a delimiter or the end follows, so
 * an ellipsis ("wait...") stays prose: its third dot fails the lookahead.
 */
const QUOTED_PATH = /(^|[\s(,=:'"])((?:\.{1,2}\/|~\/|\/)[^\s'"(),;|&]+|\.\.\/?(?=$|[\s'"(),;|&]))/g

/**
 * A quoted run that CLIMBS from a bare first segment: `sub/../../etc/passwd`.
 *
 * QUOTED_PATH only takes runs that BEGIN path-shaped, so a quoted traversal
 * opening with a plain directory name matched nothing and sailed past both
 * gates — `cp README.md "sub/../../../../etc/cron.d/evil"` was allowed while
 * its unquoted twin was denied (#1709, re-opening #90 for quoted paths; the
 * pre-rewrite scan captured any quoted token and caught it). A `../` anywhere
 * later in a word-starting run is what makes it a traversal rather than a
 * sentence, so that is the anchor — quoting must never change the verdict.
 */
const QUOTED_TRAVERSAL = /(^|[\s(,=:'"])([^\s'"(),;|&]*\.\.\/[^\s'"(),;|&]+)/g

/**
 * A URL whose scheme cannot name a local file.
 *
 * Only these are neutralized. `file://` is excluded on purpose (it addresses a
 * real path), and so is anything unrecognized — a guard that drops every
 * token containing `://` would let an unknown scheme smuggle a path past it.
 */
const NETWORK_URL = /\b(?:https?|ftps?|wss?|ssh|rsync|git\+ssh):\/\/[^\s'"(),;|&]*/gi

/** An unquoted token: unchanged from the scan that has always run here. */
const BARE_TOKEN = /([^\s'";|&()<>]+)/g

/** grep-family: read-only TOOLS whose first argument is a search PATTERN, not a
 *  path. They count as provably-read for the write gate below (#1647) — they
 *  cannot write except through `>` redirection, which the redirection scan
 *  catches independently of any verb. They stay OUT of the whole-token read
 *  scan (a pattern like `grep '/usr/bin' scripts/` would false-positive as an
 *  escaping read) but get a POSITIONAL scan of their own (#1672): the first
 *  non-flag argument is the pattern and is skipped; the path arguments after
 *  it are read targets like any other verb's — `grep root /etc/passwd` is the
 *  same cross-project LOOK #503 exists to stop. */
const GREP_FAMILY = new Set(['grep', 'rg', 'ag', 'egrep', 'fgrep'])

/** grep/rg/ag flags that consume the NEXT token as their value. Union across
 *  the family, best-effort: a missed value flag shifts which token is taken as
 *  the pattern, which can only over-deny a slash-bearing pattern — the
 *  inconvenient direction, never the dangerous one. */
const GREP_VALUE_FLAGS = new Set([
  '-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '-g', '-t', '-T', '-j', '-M',
  '--regexp', '--file', '--include', '--exclude', '--exclude-dir', '--glob',
  '--type', '--type-not', '--type-add', '--max-count', '--max-depth', '--threads',
  '--context', '--after-context', '--before-context', '--max-columns',
  '--max-filesize', '--binary-files', '--devices', '--directories', '--label',
  '--color', '--colour', '--ignore-file', '--pre', '--sort', '--sortr',
])

/**
 * Path READ targets of a grep-family command (#1672). Positional, per shell
 * segment: the verb's first non-flag argument is the search pattern (or it
 * arrives via `-e`/`--regexp`) and is never treated as a path; every non-flag
 * token after it is a path argument. `-f`/`--file` values are pattern FILES —
 * real reads, so they are targets too.
 */
function grepReadTargets(command: string): string[] {
  const targets: string[] = []
  // A `grep` word among plan-flow CLI arguments is prose, not a grep.
  command = withoutPlanflowArguments(command)
  for (const segment of command.split(/\|\||&&|[|;&()]/)) {
    const tokens = [...segment.matchAll(/'([^']*)'|"([^"]*)"|([^\s'"]+)/g)].map(
      (m) => m[1] ?? m[2] ?? m[3] ?? '',
    )
    const verbAt = tokens.findIndex((token) => GREP_FAMILY.has(token))
    if (verbAt === -1) continue
    let patternSeen = false
    for (let i = verbAt + 1; i < tokens.length; i++) {
      const token = tokens[i] ?? ''
      if (token.startsWith('--')) {
        const eq = token.indexOf('=')
        if (eq !== -1) {
          // `--file=PATH` carries a readable path; other `=` values (globs,
          // counts, colors) are not paths.
          if (token.slice(0, eq) === '--file') targets.push(token.slice(eq + 1))
          continue
        }
        if (GREP_VALUE_FLAGS.has(token)) {
          const value = tokens[++i] ?? ''
          if (token === '--file') targets.push(value)
          else if (token === '--regexp') patternSeen = true
          continue
        }
        continue
      }
      if (token.startsWith('-') && token.length > 1) {
        if (GREP_VALUE_FLAGS.has(token)) {
          const value = tokens[++i] ?? ''
          if (token === '-f') targets.push(value) // pattern FILE — a real read
          else if (token === '-e') patternSeen = true
          continue
        }
        continue // boolean flag, possibly bundled (-rin)
      }
      if (!patternSeen) {
        patternSeen = true // the search PATTERN — never a path
        continue
      }
      targets.push(token)
    }
  }
  return targets
}

// ── PowerShell vocabulary (Phase 4) ─────────────────────────────────────────
// On win32, `terminal/pty-manager.ts` spawns `powershell.exe`, so the string in
// a Bash tool call is a PowerShell command. The POSIX vocabulary above does not
// under-match it a little — it misses it almost entirely: `Remove-Item`,
// `Set-Content` and `Out-File` share no token with `rm`, `cp` or `tee`, and
// PowerShell is CASE-INSENSITIVE, so even a shared alias only matches by luck of
// casing. These sets are used IN ADDITION to the POSIX ones on win32 (a Windows
// box routinely has git-bash coreutils on PATH, and `rm`/`del` are PowerShell
// aliases anyway), and are never consulted on POSIX.

/** PowerShell cmdlets + aliases that create, overwrite, move or delete files.
 *  Matched case-insensitively. Over-inclusive on purpose: a false positive only
 *  widens the argument scan (conservative), while a miss is an escape. */
const POWERSHELL_WRITE_VERBS =
  /\b(?:Remove-Item|Remove-ItemProperty|Move-Item|Copy-Item|Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Rename-Item|Set-Item|Set-ItemProperty|New-ItemProperty|Set-Acl|Tee-Object|Export-Csv|Export-Clixml|Start-Transcript|Compress-Archive|Expand-Archive|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|New-Symlink|ri|rd|rni|ren|rename|del|erase|md|mi|mv|cpi|copy|cp|rm|rmdir|mkdir|ni|sc|ac|clc|spi|si|epcsv|oft)\b/i

/** PowerShell cmdlets + aliases whose path arguments are READ targets (#503).
 *  `Select-String`/`sls` is excluded for the same reason grep is: its first
 *  argument is a PATTERN, not a path. */
const POWERSHELL_READ_VERBS =
  /\b(?:Get-Content|Get-ChildItem|Get-Item|Get-ItemProperty|Get-Acl|Get-FileHash|Import-Csv|Import-Clixml|Test-Path|Resolve-Path|Compare-Object|Format-Hex|Get-Location|gc|gci|gi|gp|type|dir|cat|ls)\b/i

/**
 * Verbs that CHANGE the working directory. Their argument is checked exactly as
 * a write target is, because the Bash tool's shell persists between calls: a
 * `cd` out of the project silently re-bases every later relative path, so the
 * NEXT command's `Remove-Item x` would be judged against the root while writing
 * somewhere else entirely. Checking the destination is stricter than ignoring it
 * and far less disruptive than refusing `cd` outright — `cd src` still passes.
 */
const POWERSHELL_LOCATION_VERBS = /\b(?:Set-Location|Push-Location|chdir|cd|sl)\b/i

/**
 * Native Windows executables that write files without any PowerShell cmdlet or
 * POSIX verb in the command — and without `>` redirection, because they take a
 * DESTINATION ARGUMENT instead. A verb allowlist cannot see these at all:
 * `robocopy . C:\Users\Public\exfil /E` names no verb this module knew, so the
 * argument scan never ran and the write was ALLOWED (review F1, verified by
 * executing the guard, not by reading it).
 *
 * `curl`/`tar`/`wget` also exist as POSIX binaries and are matched on both
 * branches' commands here; that is deliberate — the shell on Windows may well
 * be running a git-bash coreutil.
 */
const WINDOWS_EXTERNAL_WRITE_TOOLS =
  /\b(?:robocopy|xcopy|curl|wget|certutil|bitsadmin|msiexec|attrib|takeown|icacls|fsutil|subst|7z|tar|unzip|expand)(?:\.exe)?\b/i

/** Read the Bash `command` string from a tool input, or null. */
export function bashCommand(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const command = (input as Record<string, unknown>).command
  return typeof command === 'string' && command.length > 0 ? command : null
}

/** True when an absolute target is a temp dir or /dev sink — always allowed.
 *  Exported for the auto-attach decision (phase 6), which must skip the same
 *  sinks the containment check skips. */
export function isAllowedOutsideWriteTarget(
  abs: string,
  platform: ContainmentPlatform = process.platform,
): boolean {
  if (platform === 'win32') {
    // `NUL` is Windows' /dev/null; `$null` never reaches here (it is filtered
    // out as a literal). `os.tmpdir()` is only meaningful when the HOST is
    // Windows — on a pinned-platform test it would hand back a POSIX path.
    if (/^(?:[A-Za-z]:\\)?NUL$/i.test(abs)) return true
    const temps = ['C:\\Windows\\Temp']
    if (process.platform === 'win32') {
      for (const candidate of [tmpdir(), process.env.TEMP, process.env.TMP]) {
        if (candidate) temps.push(candidate)
      }
    }
    return temps.some((temp) => isInside(temp, abs, platform))
  }
  if (DEV_SINKS.has(abs) || abs.startsWith('/dev/fd/')) return true
  const temps = [tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
  return temps.some((temp) => isInside(temp, abs, platform))
}

// ── PowerShell argument extraction (Phase 4) ────────────────────────────────

/** One path-like token: a single-quoted run, a double-quoted run, or a bare run
 *  of non-space/non-metacharacter. Unlike the POSIX token, the quoted forms may
 *  contain SPACES — `Remove-Item "C:\Program Files\x"` is one target, not two,
 *  and splitting it would compare the wrong string against the roots. */
const WINDOWS_PATH_TOKEN = "(?:'([^']*)'|\"([^\"]*)\"|([^\\s'\";|&()<>]+))"

/** Every token in `command` that follows `prefix` (a group-free pattern). */
function windowsTokensAfter(command: string, prefix: string): string[] {
  const matcher = new RegExp(`${prefix}${WINDOWS_PATH_TOKEN}`, 'gi')
  const tokens: string[] = []
  for (const match of command.matchAll(matcher)) {
    const value = match[1] ?? match[2] ?? match[3]
    if (value !== undefined && value.length > 0) tokens.push(value)
  }
  return tokens
}

/**
 * The path a PowerShell argument token names, or null when the token is not a
 * path at all. Two PowerShell-only shapes matter here:
 *  - `-Path:C:\x` — the colon form of a parameter. Left whole, the token starts
 *    with `-`, so the drive-relative and absolute checks never see the value.
 *  - a bare switch (`-Recurse`, `-Force`, `-LiteralPath`) — not a path. The
 *    VALUE that follows it is a separate token and is scanned on its own, which
 *    is what makes `-LiteralPath`, `-Destination` and `-Path` all work without
 *    enumerating them.
 */
function windowsPathArgument(token: string): string | null {
  const colonForm = /^-{1,2}[A-Za-z][A-Za-z0-9]*:(.+)$/.exec(token)
  const value = colonForm ? colonForm[1] : token
  if (value.length === 0) return null
  if (/^-{1,2}[A-Za-z]/.test(value)) return null
  if (WINDOWS_SAFE_LITERALS.has(value.toLowerCase())) return null
  return value
}

/**
 * WRITE-target tokens in a PowerShell command: redirection targets, plus every
 * path-like argument whenever the command is not provably a pure read.
 *
 * The gate used to be "a write verb is present", which is an ALLOWLIST — and an
 * allowlist of write verbs cannot enumerate the ways Windows writes files.
 * `robocopy`, `xcopy`, `curl.exe -o`, `certutil -decode` and `tar -C` name no
 * cmdlet, no POSIX verb and no redirection, so nothing was scanned and the
 * escape was ALLOWED (review F1). Scanning a command the guard cannot classify
 * as a read is the same default-deny stance Phase 4 already took for shapes it
 * cannot parse: judge in the safe direction when unsure.
 *
 * Scanning more tokens does not over-deny by itself — a command name, a flag or
 * an in-project path all resolve INSIDE a root and are dropped downstream by
 * `targetsEscapeRoots`. What it costs is that an unrecognized command naming an
 * out-of-project ABSOLUTE path is now refused rather than waved through; that is
 * the intended trade, and the deny message says which path did it.
 */
function powershellWriteTargets(command: string): string[] {
  const tokens = windowsTokensAfter(command, '\\d*>>?\\s*')

  const namesWriteVerb =
    POWERSHELL_WRITE_VERBS.test(command) ||
    POWERSHELL_LOCATION_VERBS.test(command) ||
    runsVerb(command, BASH_WRITE_VERBS) ||
    WINDOWS_EXTERNAL_WRITE_TOOLS.test(command)

  // A pure read is left to `powershellReadTargets`, so `Get-Content C:\...`
  // still reports as a read escape rather than being mislabelled a write.
  const provablyRead =
    !namesWriteVerb &&
    (POWERSHELL_READ_VERBS.test(command) || runsVerb(command, BASH_READ_VERBS))

  if (namesWriteVerb || !provablyRead) {
    tokens.push(...windowsTokensAfter(command, ''))
  }
  return tokens.map(windowsPathArgument).filter((value): value is string => value !== null)
}

/** READ-target tokens in a PowerShell command (#503), same shape as writes. */
function powershellReadTargets(command: string): string[] {
  if (!POWERSHELL_READ_VERBS.test(command) && !runsVerb(command, BASH_READ_VERBS)) return []
  return windowsTokensAfter(command, '')
    .map(windowsPathArgument)
    .filter((value): value is string => value !== null)
}

/**
 * Best-effort extraction of the WRITE-target path tokens in a Bash command —
 * both absolute (`/…`) AND relative (`../sibling/x`, `./x`, `x/y`), since a
 * relative parent-traversal is the most natural cross-project escape (#90).
 * Covers redirection targets (`>`/`>>`/`n>`, including space-less `x>/abs`, but
 * not fd dups like `2>&1`/`>&2`), `tee` destinations, `dd of=`, and — whenever
 * the command is not provably a pure read (#1647) — every path-like argument
 * (conservative: a copy/move SOURCE outside a root is flagged too, acceptable
 * for a security gate). `bashWriteEscapesRoots` resolves relatives against the
 * primary root, so a relative token that stays inside a root is harmless.
 */
export function bashWriteTargets(
  command: string,
  platform: ContainmentPlatform = process.platform,
): string[] {
  if (platform === 'win32') return powershellWriteTargets(command)
  const targets: string[] = []
  // A path-like token (optionally quoted): a run of non-space/non-shell-meta
  // chars. Not `/`-anchored, so it captures relative targets too. The excluded
  // `&`/`<`/`>` keep fd dups (`2>&1`, `>&2`) from ever forming a target.
  const PATH = "(['\"]?)([^\\s'\";|&()<>]+)\\1"

  // Redirection: `>`/`>>`, optional leading fd digits (`1>`), optional space —
  // so both `> path` and space-less `x>path` match. fd dups don't match because
  // the target class excludes the `&` that follows `>` in `>&1`/`2>&1`.
  for (const m of command.matchAll(new RegExp(`\\d*>>?\\s*${PATH}`, 'g'))) {
    targets.push(m[2])
  }
  // tee [-a] <target>
  for (const m of command.matchAll(new RegExp(`\\btee\\b(?:\\s+-a\\b)?\\s+${PATH}`, 'g'))) {
    targets.push(m[2])
  }
  // dd of=<target>
  for (const m of command.matchAll(new RegExp(`\\bof=${PATH}`, 'g'))) {
    targets.push(m[2])
  }
  // Every path-like argument is a candidate target whenever the command is not
  // PROVABLY a pure read — the same stance the win32 branch took for review F1,
  // now applied to the branch that ships (#1647, review F2). The gate used to be
  // "a write verb is present", and an allowlist of write verbs cannot enumerate
  // the ways a shell writes files: `curl -o`, `wget -O`, `tar -C`, `git clone`
  // and a `python3 -c "open(...)"` name no verb this module knew, so the scan
  // never ran and the escape was ALLOWED — verified by executing the guard.
  //
  // Scanning more tokens does not over-deny by itself: a command name, a flag,
  // a URL or an in-project path all resolve inside a root and are dropped by
  // `targetsEscapeRoots`; temp and /dev sinks stay allowed. The cost is that an
  // unrecognized command naming an out-of-project ABSOLUTE path is refused
  // instead of waved through — the intended trade for a containment guard.
  const sedInPlace = /\bsed\b[^|;&]*(?:\s-i\b|--in-place\b)/.test(command)
  const namesWriteVerb = sedInPlace || runsVerb(command, BASH_WRITE_VERBS)
  // A pure read is left to `bashReadTargets`, so `cat /outside` still reports
  // as a READ escape rather than being mislabelled a write. The grep family
  // counts as read here (it cannot write without redirection, which is caught
  // above) but is never read-scanned — see GREP_FAMILY.
  const provablyRead =
    !namesWriteVerb && (runsVerb(command, BASH_READ_VERBS) || runsVerb(command, GREP_FAMILY))
  if (namesWriteVerb || !provablyRead) {
    targets.push(...pathCandidates(command))
  }
  return targets
}

/**
 * True when a Bash command writes to a path OUTSIDE every root (and not to an
 * allowed temp/`/dev` sink). Relative targets resolve against the primary root
 * (cwd = roots[0]), mirroring `editEscapesRoots`, so `../sibling` is normalized
 * and caught. With no roots, nothing is enforced.
 */
/**
 * READ-target path tokens in a Bash command (best-effort), when a path-argument
 * read verb is present (#503). Mirrors bashWriteTargets' arg scan: every path-like
 * token is a candidate; the verb name and flags resolve inside the primary root,
 * so only a real escaping path (absolute or `../`) is flagged downstream.
 */
export function bashReadTargets(
  command: string,
  platform: ContainmentPlatform = process.platform,
): string[] {
  if (platform === 'win32') return powershellReadTargets(command)
  const targets: string[] = []
  // grep-family reads are scanned positionally — pattern skipped, path
  // arguments checked (#1672) — because the whole-token scan below would
  // false-positive on slash-bearing patterns.
  if (runsVerb(command, GREP_FAMILY)) targets.push(...grepReadTargets(command))
  if (!runsVerb(command, BASH_READ_VERBS)) return targets
  targets.push(...pathCandidates(command))
  return targets
}

/** True when a Bash command READS a path outside every root (not a temp/dev sink).
 *  Same resolution as writes; used to keep the agent's reads in-project (#503). */
export function bashReadEscapesRoots(
  command: string,
  roots: readonly string[],
  platform: ContainmentPlatform = process.platform,
  allowance: ReadAllowance = {},
): boolean {
  return bashReadEscape(command, roots, platform, allowance) !== null
}

/** The first path a Bash command reads outside every root, or null. */
export function bashReadEscape(
  command: string,
  roots: readonly string[],
  platform: ContainmentPlatform = process.platform,
  allowance: ReadAllowance = {},
): string | null {
  return firstEscapingTarget(bashReadTargets(command, platform), command, roots, platform, (abs) =>
    readAllowedOutside(abs, allowance, platform),
  )
}

export function bashWriteEscapesRoots(
  command: string,
  roots: readonly string[],
  platform: ContainmentPlatform = process.platform,
): boolean {
  return targetsEscapeRoots(bashWriteTargets(command, platform), command, roots, platform)
}

/** The ONE resolution rule both directions share (allowed-pattern #14): resolve
 *  relatives against the primary root, skip the always-allowed sinks, and treat
 *  an unresolvable Windows shape as an escape rather than as contained. */
function targetsEscapeRoots(
  targets: readonly string[],
  command: string,
  roots: readonly string[],
  platform: ContainmentPlatform,
): boolean {
  return firstEscapingTarget(targets, command, roots, platform) !== null
}

/** The first target outside every root (as the shell resolves it), or null.
 *  `allowedOutside` lets a READ check pass places only reads may go. */
function firstEscapingTarget(
  targets: readonly string[],
  command: string,
  roots: readonly string[],
  platform: ContainmentPlatform,
  allowedOutside: (abs: string) => boolean = () => false,
): string | null {
  if (!command || roots.length === 0) return null
  const primary = roots[0]
  for (const target of targets) {
    if (platform === 'win32' && windowsPathUnsafeReason(target) !== null) return target
    const abs = resolveTarget(target, primary, platform)
    if (isAllowedOutsideWriteTarget(abs, platform)) continue
    if (roots.some((root) => isInside(root, abs, platform))) continue
    if (allowedOutside(abs)) continue
    return target
  }
  return null
}

// ── Where a READ may go outside the project ─────────────────────────────────
//
// MEASURED ON THE REAL PROFILE (2026-10-09): 92 shell commands were refused as
// "reads outside this thread's projects" since 2026-09-01, and replaying them
// against this module showed most were not reads of anything: a sed address
// (`/def _stream_key/,/return/p`), a REST route (`/api/chat/stream`), a word in
// a Python heredoc (`/create-plan`), the agent's own saved tool output, `ls -l
// /opt/homebrew/bin/git`. Each refusal cost the agent a turn and taught it to
// work around the guard. Reads (never writes) may therefore go to:
//   - a path that does not exist — nothing can be read from it. A glob counts
//     by its folder (`/x/*.py` is a read of `/x`), so a wildcard cannot hide a
//     real place behind a missing literal;
//   - the session's own files under its config dir: the tool output Claude
//     saves when a result is too long to show, and its plan file;
//   - the system's program folders, which hold no project.

/** Program folders a read may look in. Not `/etc`, not `/Users`, not `/var`. */
const SYSTEM_READ_DIRS = ['/usr', '/bin', '/sbin', '/opt/homebrew']

export interface ReadAllowance {
  /** The session's CLAUDE_CONFIG_DIR — its saved tool output and plan file. */
  sessionConfigDir?: string
  /** Whether a path exists on disk. Omitted: every path is taken to exist. */
  exists?: (abs: string) => boolean
}

/** True when a session may read `abs` although it is outside every root. */
export function readAllowedOutside(
  abs: string,
  allowance: ReadAllowance,
  platform: ContainmentPlatform = process.platform,
): boolean {
  if (platform !== 'win32' && SYSTEM_READ_DIRS.some((dir) => isInside(dir, abs, platform))) return true
  if (allowance.sessionConfigDir !== undefined && isSessionOwnFile(abs, allowance.sessionConfigDir, platform)) return true
  if (allowance.exists !== undefined && !couldBeRead(abs, allowance.exists, platform)) return true
  return false
}

/** The saved tool output (`projects/<project>/<session>/tool-results/…`) and
 *  the plan file of the session whose config dir is `configDir`. */
function isSessionOwnFile(abs: string, configDir: string, platform: ContainmentPlatform): boolean {
  if (isSessionPlanFile(abs, configDir, platform)) return true
  const p = pathFor(platform)
  if (!p.isAbsolute(configDir)) return false
  const projects = p.resolve(configDir, 'projects')
  if (!isInside(projects, abs, platform)) return false
  const parts = p.relative(projects, abs).split(p.sep)
  return parts.length >= 4 && parts[2] === 'tool-results'
}

/** Whether a read of `abs` could find anything: the path exists, or — for a
 *  glob — the folder it searches exists. */
function couldBeRead(abs: string, exists: (abs: string) => boolean, platform: ContainmentPlatform): boolean {
  const wildcard = abs.search(/[*?[{]/)
  if (wildcard === -1) return exists(abs)
  const p = pathFor(platform)
  const literal = abs.slice(0, wildcard)
  // `/x/*.py` searches `/x`; `/x/ab*` searches `/x` too.
  const folder = literal.endsWith(p.sep) ? p.resolve(literal) : p.dirname(literal)
  return exists(folder.length > 0 ? folder : p.sep)
}

// ── Default-deny on unparseable PowerShell (Phase 4) ────────────────────────
// A textual guard cannot parse PowerShell. It can only decide what it is willing
// to read, and PowerShell offers several ways to put the real command somewhere
// the text is not: base64 (`-EncodedCommand`), a string evaluated as code
// (`Invoke-Expression`), a subexpression, a variable holding the path, the
// escape character splitting a verb in half, a nested interpreter, or a direct
// .NET call. For every one of those the honest answer is "I cannot tell", and
// this branch says so — it DENIES with a reason instead of falling through to a
// scan that will find no targets and report the command clean.
//
// That is the deliberate trade named in the plan: some legitimate commands will
// be refused and have to be rewritten with literal paths. A guard that guesses
// in the allow direction is the only failure in this plan that is dangerous
// rather than merely inconvenient.

const POWERSHELL_OPAQUE_SHAPES: ReadonlyArray<{ shape: RegExp; why: string }> = [
  {
    shape: /(?<![-\w])-e(?:c|nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{16,}/i,
    why: 'it carries a base64 -EncodedCommand, which hides the real command from any textual check',
  },
  {
    shape: /(?<![-\w])(?:Invoke-Expression|iex)(?![-\w])/i,
    why: 'it evaluates a string as code, so what it actually runs is not in the command text',
  },
  {
    shape: /(?<![-\w])wsl(?:\.exe)?(?![-\w])/i,
    why: 'it hands the work to WSL, where this guard does not run',
  },
  {
    shape:
      /(?<![-\w])(?:powershell|pwsh|cmd|bash|sh|zsh|node|deno|python3?|ruby|perl)(?:\.exe)?(?![-\w])[^\n]{0,80}?\s(?:-{1,2}(?:c|e|lc|le|ec|enc|command|encodedcommand|file)(?![-\w])|\/[ck](?![-\w]))/i,
    why: 'it launches a nested interpreter, whose command text this guard never sees',
  },
  {
    shape: /(?<![-\w])(?:Start-Process|New-PSDrive|Add-Type|Start-Job|Register-ScheduledTask|New-Service|subst)(?![-\w])/i,
    why: 'it starts, registers or re-maps work that runs outside this command, where containment cannot follow it',
  },
  {
    shape: /\[(?:System\.)?(?:IO|Convert|Reflection|Diagnostics)[.\]]/i,
    why: 'it calls into .NET directly, which can write anywhere without naming a path in the text',
  },
  {
    shape: /&\s*[$"']/,
    why: 'it invokes a variable or a quoted string through the call operator, so the command being run is not in the text',
  },
  {
    shape: /\$\(|\$\{|@\(/,
    why: 'it contains a subexpression whose value is computed at run time',
  },
  {
    shape: /(?<![-\w])\$env:/i,
    why: 'it reads an environment variable into the command, which resolves outside this check',
  },
  {
    shape: /%[A-Za-z_][A-Za-z0-9_]*%/,
    why: 'it contains a cmd.exe variable expansion that resolves at run time',
  },
  {
    shape: /`/,
    why: 'it uses the PowerShell escape character, which can hide any verb or path from a textual check',
  },
]

/**
 * Why a PowerShell command cannot be checked at all, or null when it can be.
 * Non-null means DENY — see the note above on why "unreadable" is not "clean".
 */
export function powershellOpaqueReason(command: string): string | null {
  for (const { shape, why } of POWERSHELL_OPAQUE_SHAPES) {
    if (shape.test(command)) return why
  }
  return null
}

export interface ContainmentCheck {
  /** True when the write must be blocked. */
  deny: boolean
  /** User-facing reason (populated only when denied). */
  reason: string
  /** Set only when the denial is "I could not read this command", not "this
   *  command escapes" — the default-deny path, which the agent can clear by
   *  rewriting the command with literal paths. */
  unparsable?: boolean
}

/**
 * Decide whether a tool's write must be blocked for escaping the thread's roots.
 * Pure — the PreToolUse hook wraps this in the SDK's deny shape.
 */
export function containmentCheck(
  input: unknown,
  roots: readonly string[],
  platform: ContainmentPlatform = process.platform,
): ContainmentCheck {
  const filePath = editFilePath(input)
  if (filePath && roots.length > 0 && platform === 'win32') {
    const unsafe = windowsPathUnsafeReason(filePath)
    if (unsafe !== null) {
      return {
        deny: true,
        unparsable: true,
        reason:
          `Blocked: "${filePath}" cannot be checked against this thread's project` +
          `${roots.length > 1 ? 's' : ''} because ${unsafe}. ` +
          `Use a full literal path inside the project (#62).`,
      }
    }
  }
  if (filePath && editEscapesRoots(filePath, roots, platform)) {
    return {
      deny: true,
      reason:
        `Blocked: "${filePath}" is outside this thread's project` +
        `${roots.length > 1 ? 's' : ''} (${roots.join(', ')}). ` +
        `A session is strict to its own project (#62).`,
    }
  }
  return { deny: false, reason: '' }
}

/**
 * Read-target containment decision (#503): deny a read tool (Read/Grep/Glob/LS)
 * whose target escapes the thread's selected project(s). Pure.
 */
export function readContainmentCheck(
  input: unknown,
  roots: readonly string[],
  platform: ContainmentPlatform = process.platform,
  allowance: Pick<ReadAllowance, 'sessionConfigDir'> = {},
): ContainmentCheck {
  const target = readTargetPath(input)
  if (target && roots.length > 0 && platform === 'win32') {
    const unsafe = windowsPathUnsafeReason(target)
    if (unsafe !== null) {
      return {
        deny: true,
        unparsable: true,
        reason:
          `Blocked: "${target}" cannot be checked against this thread's selected project` +
          `${roots.length > 1 ? 's' : ''} because ${unsafe}. ` +
          `Use a full literal path inside the project (#503).`,
      }
    }
  }
  if (
    target &&
    editEscapesRoots(target, roots, platform) &&
    // A read tool names one literal path, so no existence allowance here: only
    // the session's own files and the system's program folders.
    !readAllowedOutside(resolveTarget(target, roots[0] ?? '/', platform), { sessionConfigDir: allowance.sessionConfigDir }, platform)
  ) {
    return {
      deny: true,
      reason:
        `Blocked: "${target}" is outside this thread's selected project` +
        `${roots.length > 1 ? 's' : ''} (${roots.join(', ')}). ` +
        `A session only looks at the projects you selected (#503).`,
    }
  }
  return { deny: false, reason: '' }
}

/**
 * Bash-tool containment decision (#82, #503): deny a shell command that writes OR
 * reads outside the thread's selected project(s). Pure — the PreToolUse hook wraps
 * this in the SDK deny shape.
 */
export function bashContainmentCheck(
  input: unknown,
  roots: readonly string[],
  platform: ContainmentPlatform = process.platform,
  allowance: ReadAllowance = {},
): ContainmentCheck {
  const command = bashCommand(input)
  if (!command) return { deny: false, reason: '' }
  const scope = `this thread's project${roots.length > 1 ? 's' : ''} (${roots.join(', ')})`
  // Default-deny FIRST on win32: a command shape this guard cannot read is
  // refused before any target scan, because that scan would find nothing and
  // report the command clean. As everywhere else, no roots → nothing enforced.
  if (platform === 'win32' && roots.length > 0) {
    const opaque = powershellOpaqueReason(command)
    if (opaque !== null) {
      return {
        deny: true,
        unparsable: true,
        reason:
          `Blocked: this shell command cannot be checked against ${scope} because ${opaque}. ` +
          `Rewrite it as a plain command with literal paths, or ask the user to run it. ` +
          `On Windows, containment denies what it cannot parse (#62).`,
      }
    }
  }
  if (bashWriteEscapesRoots(command, roots, platform)) {
    return {
      deny: true,
      reason: `Blocked: this shell command writes outside ${scope}. A session is strict to its own project (#62).`,
    }
  }
  const readEscape = bashReadEscape(command, roots, platform, allowance)
  if (readEscape !== null) {
    // The path is named: an agent told only "reads outside" cannot tell which
    // word tripped the check, and retries the same command.
    return {
      deny: true,
      reason: `Blocked: this shell command reads outside ${scope}: "${readEscape}". A session only looks at the projects you selected (#503).`,
    }
  }
  return { deny: false, reason: '' }
}

/**
 * THE SESSION'S OWN PLAN FILE (2026-10-09). Claude's plan mode writes its plan
 * to `<config dir>/plans/<name>.md` before it asks to leave plan mode. That
 * folder belongs to the agent's account, not to any project, so the strict
 * project rule (#62) blocked the write and the agent fell back to pasting the
 * plan into the chat. Only a Markdown file DIRECTLY inside that one folder is
 * let through — no subfolder, no `..`, nothing else in the config dir.
 *
 * `configDir` is the session's CLAUDE_CONFIG_DIR: the account's isolated dir,
 * else the inherited variable, else `~/.claude`.
 */
export function isSessionPlanFile(
  filePath: string | null,
  configDir: string,
  platform: ContainmentPlatform = process.platform,
): boolean {
  if (filePath === null || filePath.length === 0) return false
  const path: PlatformPath = platform === 'win32' ? win32Path : posixPath
  if (!path.isAbsolute(filePath) || !path.isAbsolute(configDir)) return false
  const target = path.resolve(filePath)
  const plans = path.resolve(configDir, 'plans')
  const same = (a: string, b: string): boolean => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
  return same(path.dirname(target), plans) && path.extname(target).toLowerCase() === '.md'
}
