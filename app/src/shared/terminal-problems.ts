// Terminal problems — the pure rules that turn what a terminal prints into
// rows of the Problems list. DOM-free and clock-free, so every rule is a test.
//
// MAIN reads every user terminal's raw output (main/terminal/terminal-problems-service.ts),
// splits it into lines and asks `detectProblem` about each one, carrying the
// colour state from line to line (`colourOfLine`). A line is judged on its RAW
// form for colour and on its visible text for words:
//
//   - a LEVEL TOKEN at a level position wins: `2026-… | WARNING | …`,
//     `…Z  WARN target: …`, `[error] …`, `ERROR: …`, `level=warn`, `"level":"error"`.
//     A DEBUG/INFO token makes the line no problem at all, even when it is red
//     or its message says "error".
//   - shapes that are errors by position: `error:` / `Error:` / `error[E0308]:`
//     at the start, `npm ERR!`, `panic:`, a traceback's last line
//     (`ConnectionRefusedError: …`), a compiler's `file:12:3: error: …`.
//   - otherwise colour: a line printed mostly in red is an error, mostly in
//     yellow a warning — with guards against diffs and file listings.
//
// "error" inside ordinary prose is never enough: it has to be at a level
// position. Same problem twice = same `problemFingerprint` (times, ids,
// numbers and quoted values removed).

export type TerminalProblemSeverity = 'error' | 'warning'

/** What one line was found to be. */
export interface DetectedProblem {
  severity: TerminalProblemSeverity
  /** The meaningful part: for a structured log line, the text after its prefix. */
  message: string
  /** The logger / module / target / location the line names, when it names one. */
  meta: string | null
}

/** The longest line kept, in characters. */
export const MAX_PROBLEM_LINE_CHARS = 2000

// ── ANSI ─────────────────────────────────────────────────────────────────

// CSI (colours, cursor moves), OSC (titles, links — BEL or ST terminated),
// two-byte escapes, then any other control character except tab.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g

/** The visible text of raw terminal output. */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_PATTERN, '')
}

// ── Colour ───────────────────────────────────────────────────────────────

/** The foreground colour in effect, as far as problems care. */
export type ColourState = 'red' | 'yellow' | 'other' | null

const RED_256 = new Set([1, 9, 52, 88, 124, 160, 196])
const YELLOW_256 = new Set([3, 11, 136, 142, 148, 172, 178, 184, 214, 220, 226])

function classify256(n: number): ColourState {
  if (RED_256.has(n)) return 'red'
  if (YELLOW_256.has(n)) return 'yellow'
  return 'other'
}

function classifyRgb(r: number, g: number, b: number): ColourState {
  if (r >= 180 && g < 110 && b < 110) return 'red'
  if (r >= 180 && g >= 140 && b < 110) return 'yellow'
  return 'other'
}

/** Apply one SGR sequence's parameters to the current colour. */
export function applySgr(state: ColourState, params: string): ColourState {
  const parts = params === '' ? [0] : params.split(/[;:]/).map((part) => (part === '' ? 0 : Number(part)))
  let next = state
  for (let index = 0; index < parts.length; index += 1) {
    const code = parts[index]!
    if (code === 0 || code === 39) next = null
    else if (code === 31 || code === 91) next = 'red'
    else if (code === 33 || code === 93) next = 'yellow'
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) next = 'other'
    else if (code === 38 || code === 48) {
      const mode = parts[index + 1]
      if (mode === 5) {
        if (code === 38) next = classify256(parts[index + 2] ?? -1)
        index += 2
      } else if (mode === 2) {
        if (code === 38) next = classifyRgb(parts[index + 2] ?? 0, parts[index + 3] ?? 0, parts[index + 4] ?? 0)
        index += 4
      }
    }
  }
  return next
}

export interface LineColour {
  /** The colour most of the line's visible characters are printed in. */
  tone: 'red' | 'yellow' | null
  /** The colour still in effect after the line — the next line starts in it. */
  end: ColourState
}

/** Share of a line's visible non-space characters a tone needs to colour it. */
const TONE_SHARE = 0.6

/**
 * Which colour a raw line is printed in. Only what is still on screen counts:
 * a carriage return starts the count over (a progress bar redrawing itself).
 */
export function colourOfLine(rawLine: string, start: ColourState): LineColour {
  const raw = withoutTrailingCr(rawLine)
  let state = start
  let red = 0
  let yellow = 0
  let visible = 0
  let index = 0
  while (index < raw.length) {
    const char = raw.charCodeAt(index)
    if (char === 0x1b) {
      // eslint-disable-next-line no-control-regex
      const csi = /^\u001b\[([0-?]*)([ -/]*)([@-~])/.exec(raw.slice(index, index + 64))
      if (csi !== null) {
        if (csi[3] === 'm' && csi[2] === '') state = applySgr(state, csi[1]!)
        index += csi[0].length
        continue
      }
      index += 1
      continue
    }
    if (char === 0x0d) {
      red = 0
      yellow = 0
      visible = 0
    } else if (char > 0x20 && char !== 0x7f) {
      visible += 1
      if (state === 'red') red += 1
      else if (state === 'yellow') yellow += 1
    }
    index += 1
  }
  let tone: LineColour['tone'] = null
  if (visible > 0 && red / visible >= TONE_SHARE) tone = 'red'
  else if (visible > 0 && yellow / visible >= TONE_SHARE) tone = 'yellow'
  return { tone, end: state }
}

// ── Words ────────────────────────────────────────────────────────────────

const ERROR_LEVELS = new Set(['ERROR', 'ERR', 'FATAL', 'CRITICAL', 'CRIT', 'PANIC', 'SEVERE', 'EMERG', 'EMERGENCY', 'ALERT'])
const WARNING_LEVELS = new Set(['WARN', 'WARNING'])
const QUIET_LEVELS = new Set(['TRACE', 'DEBUG', 'INFO', 'NOTICE', 'SUCCESS', 'VERBOSE', 'FINE', 'LOG'])

/** A level word: 'error' | 'warning' | 'quiet' (DEBUG, INFO…) | null (not a level). */
function levelOf(word: string): TerminalProblemSeverity | 'quiet' | null {
  const upper = word.toUpperCase()
  if (ERROR_LEVELS.has(upper)) return 'error'
  if (WARNING_LEVELS.has(upper)) return 'warning'
  if (QUIET_LEVELS.has(upper)) return 'quiet'
  return null
}

const LEVEL_WORD =
  'TRACE|DEBUG|INFO|NOTICE|SUCCESS|VERBOSE|WARN(?:ING)?|ERROR|ERR|FATAL|CRIT(?:ICAL)?|PANIC|SEVERE|EMERG(?:ENCY)?|ALERT'

const TIMESTAMP =
  String.raw`\[?(?:\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\]?`

// `2026-11-18 20:56:06.890 | WARNING  | mod:fn:588 - message` (loguru, and any
// pipe-separated layout with a timestamp first).
const PIPE_LINE = new RegExp(String.raw`^${TIMESTAMP}\s*\|\s*(${LEVEL_WORD})\s*\|\s*(.*)$`, 'i')
// `mod.sub:fn:588 - message`
const PIPE_LOCATION = /^([\w.<>-]+(?::[\w.<>-]+)*(?::\d+)?)\s+-\s+(.*)$/
// `2026-11-18T23:55:52.313450Z  WARN target::path: message` — an upper-case
// level after a timestamp. Lower or mixed case only when the level is marked
// as one: `12:00:01 [error] message`, `…Z\terror\tmessage`, `… warn: message`.
const STAMPED_LINE = new RegExp(String.raw`^${TIMESTAMP}\s+\[?(${LEVEL_WORD})\]?(?:\s*\(\d+\))?(?::\s*|\s+)(.*)$`)
const STAMPED_MARKED_LINE = new RegExp(
  String.raw`^${TIMESTAMP}\s+(?:\[(${LEVEL_WORD})\]\s*:?\s*|(${LEVEL_WORD})(?:\t|:\s+))(.*)$`,
  'i',
)
// A Rust target (`a::b`), a dotted logger (`a.b.c`), optionally with tracing
// span fields, followed by `: `.
const TARGET_PREFIX = /^((?:[A-Za-z_]\w*::)+[A-Za-z_]\w*|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)(?:\{[^}]*\})?:\s+(.*)$/
// `[ERROR] message`, `[warn] message` — any case inside brackets.
const BRACKET_LINE = new RegExp(String.raw`^\[(${LEVEL_WORD})\]\s*:?\s*(.*)$`, 'i')
// `WARNING:root:message` (Python logging's default layout).
const PY_LOGGING_LINE = new RegExp(String.raw`^(${LEVEL_WORD}):([\w.]+):(.*)$`)
// `ERROR: message`, `ERROR in ./src/x.js`, `INFO:     127.0.0.1 …` — upper case only.
const UPPER_LINE = new RegExp(String.raw`^(${LEVEL_WORD})(?::\s*|\s+)(.*)$`)
// `npm ERR! message`, `npm WARN message`, npm 10's `npm error message`.
const NPM_LINE = /^npm (ERR!|error|WARN|warn)\s*(.*)$/
// `src/x.c:12:3: error: message`, `x.rs:4: warning[unused]: message`.
const COMPILER_LINE = /^(\S+?:\d+(?::\d+)?):\s*(fatal error|error|warning)(?:\[[\w-]+\])?:\s*(.*)$/i
// `src/x.ts(12,5): error TS2322: message`, `src/x.ts:12:5 - error TS2322: message`.
const TSC_LINE = /^(\S+?(?:\(\d+,\d+\)|:\d+:\d+)):?\s+(?:-\s+)?(error|warning)\s+(TS\d+):\s*(.*)$/
// `error: message`, `Error: message`, `error[E0308]: message`, `warning: message`.
const WORD_COLON_LINE = /^(error|Error|ERROR|fatal|Fatal|warning|Warning)(?:\[[\w-]+\])?:\s*\S/
// `panic: message` (Go), `thread 'main' panicked at …` (Rust).
const PANIC_LINE = /^(?:panic:\s|thread '[^']*' panicked at\b)/
// `ConnectionRefusedError: [Errno 61] …`, `asyncpg.exceptions.X: …`,
// `Uncaught TypeError: …`, `Exception in thread "main" java.lang.…`.
const EXCEPTION_LINE = /^(?:Uncaught )?(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*(?:Error|Exception)(?::(?:\s.*)?)?$/
const JAVA_EXCEPTION_LINE = /^Exception in thread "[^"]*"\s/
// `/x/y.py:12: DeprecationWarning: message`, `DeprecationWarning: message`.
const PY_WARNING_LINE = /^(?:(\S+?:\d+):\s*)?([A-Z]\w*Warning):\s*(.*)$/
// `web-1  | …` — a docker compose service prefix.
const COMPOSE_PREFIX = /^([\w.-]+-\d+)\s+\|\s?(.*)$/
// logfmt `level=warn msg="…"`.
const LOGFMT_LEVEL = /(?:^|\s)(?:level|lvl|severity)=("?)(\w+)\1(?=\s|$)/i
const LOGFMT_MSG = /(?:^|\s)(?:msg|message)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/
const LOGFMT_LOGGER = /(?:^|\s)(?:logger|module|component|caller)=(?:"((?:[^"\\]|\\.)*)"|(\S+))/
// JSON lines: `{"level":"error","msg":"…"}`, pino's numeric `"level":50`.
const JSON_LEVEL = /"(?:level|severity|levelname|lvl)"\s*:\s*(?:"(\w+)"|(\d+))/i
const JSON_MSG = /"(?:msg|message)"\s*:\s*"((?:[^"\\]|\\.)*)"/
const JSON_LOGGER = /"(?:logger|name|module|target|component)"\s*:\s*"((?:[^"\\]|\\.)*)"/

type Verdict = DetectedProblem | 'quiet' | null

function stampedLevel(text: string): { level: string; rest: string } | null {
  const upper = STAMPED_LINE.exec(text)
  if (upper !== null) return { level: upper[1]!, rest: upper[2]! }
  const marked = STAMPED_MARKED_LINE.exec(text)
  if (marked !== null) return { level: (marked[1] ?? marked[2])!, rest: marked[3]! }
  return null
}

function verdict(level: TerminalProblemSeverity | 'quiet' | null, message: string, meta: string | null): Verdict {
  if (level === null) return null
  if (level === 'quiet') return 'quiet'
  const text = message.trim()
  return { severity: level, message: text === '' ? meta ?? '' : text, meta }
}

function pinoLevel(level: number): TerminalProblemSeverity | 'quiet' {
  if (level >= 50) return 'error'
  if (level >= 40) return 'warning'
  return 'quiet'
}

function unescapeQuoted(value: string): string {
  return value.replace(/\\(["\\])/g, '$1').replace(/\\n/g, ' ')
}

/** The verdict of the line's words alone: a problem, explicitly none ('quiet'), or nothing said (null). */
function byWords(text: string): Verdict {
  let match: RegExpExecArray | null

  if ((match = PIPE_LINE.exec(text)) !== null) {
    const rest = match[2]!
    const located = PIPE_LOCATION.exec(rest)
    if (located !== null) return verdict(levelOf(match[1]!), located[2]!, located[1]!.split(':')[0]!)
    return verdict(levelOf(match[1]!), rest, null)
  }

  if (text.startsWith('{') && (match = JSON_LEVEL.exec(text)) !== null) {
    const level = match[1] !== undefined ? levelOf(match[1]) : pinoLevel(Number(match[2]))
    const message = JSON_MSG.exec(text)?.[1]
    const logger = JSON_LOGGER.exec(text)?.[1]
    return verdict(level, unescapeQuoted(message ?? text), logger === undefined ? null : unescapeQuoted(logger))
  }

  if ((match = LOGFMT_LEVEL.exec(text)) !== null && LOGFMT_MSG.test(text)) {
    const msg = LOGFMT_MSG.exec(text)!
    const logger = LOGFMT_LOGGER.exec(text)
    return verdict(
      levelOf(match[2]!),
      unescapeQuoted(msg[1] ?? msg[2] ?? ''),
      logger === null ? null : unescapeQuoted(logger[1] ?? logger[2] ?? ''),
    )
  }

  const stamped = stampedLevel(text)
  if (stamped !== null) {
    const target = TARGET_PREFIX.exec(stamped.rest)
    if (target !== null) return verdict(levelOf(stamped.level), target[2]!, target[1]!)
    return verdict(levelOf(stamped.level), stamped.rest, null)
  }

  if ((match = BRACKET_LINE.exec(text)) !== null) return verdict(levelOf(match[1]!), match[2]!, null)
  if ((match = PY_LOGGING_LINE.exec(text)) !== null) return verdict(levelOf(match[1]!), match[3]!, match[2]!)
  if ((match = NPM_LINE.exec(text)) !== null) {
    const level = match[1]!.toLowerCase().startsWith('err') ? 'error' : 'warning'
    return verdict(level, match[2]!, 'npm')
  }
  if ((match = TSC_LINE.exec(text)) !== null) {
    return verdict(match[2] === 'error' ? 'error' : 'warning', `${match[3]}: ${match[4]}`, match[1]!)
  }
  if ((match = COMPILER_LINE.exec(text)) !== null) {
    return verdict(match[2]!.toLowerCase() === 'warning' ? 'warning' : 'error', match[3]!, match[1]!)
  }
  if ((match = UPPER_LINE.exec(text)) !== null) return verdict(levelOf(match[1]!), match[2]!, null)

  if ((match = WORD_COLON_LINE.exec(text)) !== null) {
    return verdict(match[1]!.toLowerCase() === 'warning' ? 'warning' : 'error', text, null)
  }
  if (PANIC_LINE.test(text) || JAVA_EXCEPTION_LINE.test(text)) return verdict('error', text, null)
  if ((match = PY_WARNING_LINE.exec(text)) !== null) {
    return verdict('warning', `${match[2]}: ${match[3]}`, match[1] ?? null)
  }
  if (EXCEPTION_LINE.test(text)) return verdict('error', text, null)
  return null
}

/** A coloured line long and wordy enough to be a message, and not a diff or a listing. */
function colourCounts(text: string): boolean {
  if (text.length < 8 || !/\s/.test(text)) return false
  // A diff's removed/added lines and hunk markers are red/green by design.
  if (/^(?:[-+<>]|@@)/.test(text)) return false
  return true
}

/**
 * Judge one line. `raw` is the line as printed (ANSI included); `tone` is the
 * colour most of it is printed in (`colourOfLine`). Null: not a problem.
 */
export function detectProblem(raw: string, tone: LineColour['tone'] = null): DetectedProblem | null {
  let text = stripAnsi(lastScreenSegment(raw)).trimEnd()
  if (text.length > MAX_PROBLEM_LINE_CHARS) text = text.slice(0, MAX_PROBLEM_LINE_CHARS)
  let meta: string | null = null
  const compose = COMPOSE_PREFIX.exec(text)
  if (compose !== null) {
    meta = compose[1]!
    text = compose[2]!
  }
  const leading = text.length - text.trimStart().length
  const trimmed = text.trimStart()
  if (trimmed === '') return null

  // An indented line is a continuation (a traceback frame, a wrapped message):
  // only a level token speaks for it, never a bare shape like `Error:`.
  const said = byWords(trimmed)
  if (said === 'quiet') return null
  if (said !== null) {
    if (leading > 0 && !isLevelVerdict(trimmed)) return colourVerdict(trimmed, tone, meta)
    return { ...said, meta: said.meta ?? meta }
  }
  return colourVerdict(trimmed, tone, meta)
}

function isLevelVerdict(text: string): boolean {
  return PIPE_LINE.test(text) || stampedLevel(text) !== null || BRACKET_LINE.test(text) || NPM_LINE.test(text)
}

function colourVerdict(text: string, tone: LineColour['tone'], meta: string | null): DetectedProblem | null {
  if (tone === null || !colourCounts(text)) return null
  return { severity: tone === 'red' ? 'error' : 'warning', message: text, meta }
}

/** A line without the carriage returns that end it (`\r\n` line ends). */
function withoutTrailingCr(raw: string): string {
  let end = raw.length
  while (end > 0 && raw.charCodeAt(end - 1) === 0x0d) end -= 1
  return end === raw.length ? raw : raw.slice(0, end)
}

/** What is left on screen of a line a carriage return redrew. */
export function lastScreenSegment(raw: string): string {
  const line = withoutTrailingCr(raw)
  const cr = line.lastIndexOf('\r')
  return cr < 0 ? line : line.slice(cr + 1)
}

// ── Same problem ─────────────────────────────────────────────────────────

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const DATE_TIME =
  /\b\d{4}[-/]\d{2}[-/]\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g
const HEX_PREFIXED = /\b0x[0-9a-f]+\b/gi
const HEX_RUN = /\b[0-9a-f]{8,}\b/gi
const QUOTED = /(?<!\w)(["'`])(?:(?!\1)[^\n]){1,200}?\1(?!\w)/g

/**
 * A message with what changes from one occurrence to the next taken out:
 * dates and times, UUIDs and hex ids, quoted values and every number (ports,
 * pids, counts, line numbers in paths). The host in `localhost:6379` stays.
 */
export function normalizeProblemText(message: string): string {
  return message
    .replace(UUID, '<id>')
    .replace(DATE_TIME, '<time>')
    .replace(HEX_PREFIXED, '<hex>')
    .replace(HEX_RUN, (run) => (/\d/.test(run) && /[a-f]/i.test(run) ? '<hex>' : run))
    .replace(QUOTED, '$1…$1')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Two lines are the same problem when this is equal. */
export function problemFingerprint(problem: Pick<DetectedProblem, 'severity' | 'message' | 'meta'>): string {
  const meta = problem.meta === null ? '' : normalizeProblemText(problem.meta)
  return `${problem.severity}\u0000${meta}\u0000${normalizeProblemText(problem.message)}`
}

// ── What crosses IPC ─────────────────────────────────────────────────────

/** One distinct problem a terminal printed, with how often. */
export interface TerminalProblem {
  id: string
  terminalId: string
  severity: TerminalProblemSeverity
  message: string
  meta: string | null
  count: number
  /** Epoch ms. */
  firstSeen: number
  lastSeen: number
  /** The problem's own line as printed the latest time (ANSI removed). */
  line: string
  /** The lines printed just before its latest appearance (ANSI removed). */
  context: string[]
  /** …and before its first. */
  firstContext: string[]
}

/** One terminal's problems, newest first. */
export interface TerminalProblemGroup {
  terminalId: string
  /** The step name or the tab title. */
  label: string
  projectName: string
  /** A Launchpad step or one-time action, not a terminal a person opened. */
  launchpad: boolean
  problems: TerminalProblem[]
}

export interface TerminalProblemCounts {
  errors: number
  warnings: number
}

export interface TerminalProblemsSnapshot {
  /** Distinct problems in every terminal, whatever the bound left out. */
  counts: TerminalProblemCounts
  /** Groups ordered by their newest problem, newest first. */
  groups: TerminalProblemGroup[]
  /** Problems counted but not sent. Withheld is not "none". */
  withheld: number
}

/** The most terminal problems one snapshot carries when the caller names no limit. */
export const DEFAULT_TERMINAL_PROBLEMS_LIMIT = 200
