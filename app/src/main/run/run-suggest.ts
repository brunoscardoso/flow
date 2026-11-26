/**
 * RUN SUGGESTIONS — the long-running commands a project already declares, each
 * with the file it was found in, for the first-time picker and the setup
 * panel's chips.
 *
 * READ-ONLY AND PURE: every file is read through the injected `SuggestFs`, and
 * nothing is ever written or run. A suggestion is only an offer — a person
 * ticks it before it joins a setup (FR-2, NFR-5).
 */
import { join } from 'path'

import type { RunSuggestion } from '../../shared/run-setup'

import { readComposeDescription } from './compose-describe'

export interface SuggestFs {
  /** The file's text, or null when it does not exist or cannot be read. */
  readFile(path: string): Promise<string | null>
  exists(path: string): Promise<boolean>
}

export interface SuggestProject {
  root: string
  name: string
  /** Where to read the files — a conversation's checkout of the project. Defaults to `root`. */
  dir?: string
}

type Candidate = Omit<RunSuggestion, 'projectRoot' | 'projectName'>

// ─── package.json ────────────────────────────────────────────────────────────

const LONG_RUNNING_SCRIPT = /(^|[:_-])(dev|develop|start|serve|server|watch|storybook|preview)([:_-]|$)/i
const ONE_SHOT_SCRIPT = /(^|[:_-])(build|test|tests|lint|format|fmt|typecheck|check|prepare|install|postinstall|preinstall|clean|release|deploy|publish|e2e|coverage|ci|gen|generate|migrate|seed)([:_-]|$)/i

async function packageRunner(root: string, fs: SuggestFs): Promise<(script: string) => string> {
  if (await fs.exists(join(root, 'pnpm-lock.yaml'))) return (script) => `pnpm run ${script}`
  if (await fs.exists(join(root, 'yarn.lock'))) return (script) => `yarn ${script}`
  if ((await fs.exists(join(root, 'bun.lockb'))) || (await fs.exists(join(root, 'bun.lock')))) {
    return (script) => `bun run ${script}`
  }
  return (script) => (script === 'start' ? 'npm start' : `npm run ${script}`)
}

async function fromPackageJson(root: string, fs: SuggestFs): Promise<Candidate[]> {
  const text = await fs.readFile(join(root, 'package.json'))
  if (text === null) return []
  let scripts: unknown
  try {
    scripts = (JSON.parse(text) as { scripts?: unknown }).scripts
  } catch {
    return []
  }
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return []
  const run = await packageRunner(root, fs)
  const out: Candidate[] = []
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof body !== 'string' || body.trim() === '') continue
    // `predev` / `poststart` are hooks npm runs around another script, never steps of their own.
    const hooked = /^(pre|post)(.+)$/.exec(name)?.[2]
    if (hooked !== undefined && hooked in (scripts as Record<string, unknown>)) continue
    if (ONE_SHOT_SCRIPT.test(name) || !LONG_RUNNING_SCRIPT.test(name)) continue
    out.push({ name, command: run(name), source: 'package.json' })
  }
  return out
}

// ─── a command line on its own ───────────────────────────────────────────────

/** Words that mark a command as a process that keeps running. */
const LONG_RUNNING_WORD = /^(dev|develop|start|serve|server|watch|storybook|preview|up|start-dev|run-dev)$/i
/** Words that mark a command as one that does a job and ends. */
const ONE_SHOT_WORD =
  /^(build|test|tests|lint|format|fmt|typecheck|check|prepare|install|i|ci|add|remove|uninstall|clean|release|deploy|publish|e2e|coverage|gen|generate|migrate|seed|init|login|logout|version|help|--help|-h|--version|-v)$/i
/** Programs that are never a step of a Run: they show, move or change something and end. */
const ONE_SHOT_PROGRAMS = new Set([
  'sleep', 'wait', 'true', 'false', 'pytest', 'jest', 'vitest', 'mocha', 'playwright', 'cypress', 'tsc', 'eslint',
  'prettier', 'ruff', 'black', 'mypy', 'pyright', 'biome', 'curl', 'wget', 'grep', 'rg', 'find', 'sed', 'awk', 'jq',
  'cd', 'ls', 'll', 'la', 'l', 'pwd', 'git', 'gh', 'cat', 'bat', 'less', 'more', 'head', 'tail', 'clear', 'reset',
  'exit', 'logout', 'echo', 'printf', 'man', 'which', 'type', 'whoami', 'history', 'vim', 'vi', 'nvim', 'nano',
  'emacs', 'code', 'cursor', 'open', 'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'ln', 'kill',
  'killall', 'pkill', 'ps', 'top', 'htop', 'btop', 'grep', 'rg', 'find', 'fd', 'ssh', 'scp', 'export', 'source',
  '.', 'alias', 'unset', 'env', 'printenv', 'set', 'date', 'du', 'df', 'tree', 'wc', 'sort', 'diff', 'curl',
  'wget', 'jq', 'brew', 'nvm', 'pyenv', 'lsof', 'claude', 'planflow-ai', 'z', 'j', 'sudo',
])

/** The words of a command line, without leading `FOO=bar` assignments. */
function commandWords(command: string): string[] {
  const words = command.trim().split(/\s+/).filter((word) => word !== '')
  let at = 0
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!)) at += 1
  return words.slice(at)
}

/** True for a command that does a job and ends — never offered as a step. */
export function looksOneShotCommand(command: string): boolean {
  const words = commandWords(command)
  if (words.length === 0) return true
  const program = words[0]!.split('/').pop() ?? words[0]!
  if (ONE_SHOT_PROGRAMS.has(program.toLowerCase())) return true
  return words.slice(1).some((word) => ONE_SHOT_WORD.test(word) || ONE_SHOT_SCRIPT.test(word))
}

/** True for a command that looks like it keeps running (a server, a watcher, `compose up`). */
export function looksLongRunningCommand(command: string): boolean {
  if (looksOneShotCommand(command)) return false
  const words = commandWords(command)
  return words.slice(1).some((word) => LONG_RUNNING_WORD.test(word) || LONG_RUNNING_SCRIPT.test(word))
}

/** A short name for a command line: `npm run dev` → "dev", `docker compose up kafka` → "kafka". */
export function nameForCommand(command: string): string {
  const words = commandWords(command)
  if (words.length === 0) return 'step'
  const program = (words[0]!.split('/').pop() ?? words[0]!).toLowerCase()
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    if (words[1] === 'run' && words[2] !== undefined) return words[2]
    if (words[1] !== undefined) return words[1]
  }
  if ((program === 'docker' && words[1] === 'compose') || program === 'docker-compose') {
    const rest = words.slice(program === 'docker' ? 3 : 2).filter((word) => !word.startsWith('-'))
    if (rest.length > 0) return rest.join(' ')
    return 'compose'
  }
  if (program === 'make' && words[1] !== undefined) return words[1]
  return words.slice(0, 2).join(' ')
}

// ─── Procfile ────────────────────────────────────────────────────────────────

async function fromProcfile(root: string, fs: SuggestFs): Promise<Candidate[]> {
  const text = (await fs.readFile(join(root, 'Procfile.dev'))) ?? (await fs.readFile(join(root, 'Procfile')))
  if (text === null) return []
  const out: Candidate[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim())
    if (match === null || line.trim().startsWith('#')) continue
    out.push({ name: match[1]!, command: match[2]!.trim(), source: 'Procfile' })
  }
  return out
}

// ─── docker compose ──────────────────────────────────────────────────────────

// One reader of the Compose file (allowed-pattern #14): the suggestions are the
// services `describeCompose` lists, so the per-thread plan and the Docker group
// read the same description these chips come from.
export { composeServices, describeCompose, readComposeDescription } from './compose-describe'

async function fromCompose(root: string, fs: SuggestFs): Promise<Candidate[]> {
  const found = await readComposeDescription(root, fs)
  if (found === null) return []
  return found.description.services.map((service) => ({
    name: service.name,
    command: `docker compose up ${service.name}`,
    source: 'Docker Compose',
  }))
}

// ─── Makefile ────────────────────────────────────────────────────────────────

const MAKE_TARGET = /^(run|dev|serve|server|up|start|watch)(?:[-_][A-Za-z0-9_-]+)?\s*:(?!=)/

async function fromMakefile(root: string, fs: SuggestFs): Promise<Candidate[]> {
  const text = await fs.readFile(join(root, 'Makefile'))
  if (text === null) return []
  const out: Candidate[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = MAKE_TARGET.exec(line)
    if (match === null) continue
    const target = line.slice(0, line.indexOf(':')).trim()
    out.push({ name: target, command: `make ${target}`, source: 'Makefile' })
  }
  return out
}

// ─── pyproject.toml ──────────────────────────────────────────────────────────

/** Keys of the `[project.scripts]` and `[tool.poetry.scripts]` tables. */
export function pyprojectScripts(text: string): string[] {
  const names: string[] = []
  let inScripts = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inScripts = /^\[\s*(project\.scripts|tool\.poetry\.scripts)\s*\]$/.test(line)
      continue
    }
    if (!inScripts || line === '' || line.startsWith('#')) continue
    const match = /^["']?([A-Za-z0-9._-]+)["']?\s*=/.exec(line)
    if (match !== null) names.push(match[1]!)
  }
  return names
}

async function fromPyproject(root: string, fs: SuggestFs): Promise<Candidate[]> {
  const text = await fs.readFile(join(root, 'pyproject.toml'))
  if (text === null) return []
  return pyprojectScripts(text).map((name) => ({ name, command: `uv run ${name}`, source: 'pyproject.toml' }))
}

// ─── README ──────────────────────────────────────────────────────────────────

const RUN_HEADING =
  /(run(ning)?|start(ing)?)\b.*\b(local(ly)?|dev(elopment)?)|local development|development server|getting started|quick ?start/i
const SHELL_FENCE = /^(```|~~~)\s*(bash|sh|shell|zsh|console|terminal)?\s*$/i
const SETUP_LINE =
  /^(cd|git|cp|mv|mkdir|export|source|brew|apt|apt-get|curl|wget|echo|chmod|nvm|pyenv|python -m venv)\b|\b(install|ci|add|clone|init|migrate|seed|build|test|lint)\b/i
const RUN_LINE = /\b(run|dev|start|serve|server|up|watch|preview)\b/i

/** The command lines inside shell code blocks under a "run it locally" style heading. */
export function readmeRunLines(text: string): string[] {
  const out: string[] = []
  let inSection = false
  let sectionLevel = 0
  let inFence = false
  let fenceIsShell = false
  for (const raw of text.split(/\r?\n/)) {
    const fence = /^\s*(```|~~~)/.test(raw)
    if (fence) {
      if (inFence) {
        inFence = false
      } else {
        inFence = true
        fenceIsShell = SHELL_FENCE.test(raw.trim())
      }
      continue
    }
    if (inFence) {
      if (!inSection || !fenceIsShell) continue
      const line = raw.trim().replace(/^\$\s+/, '')
      if (line === '' || line.startsWith('#') || SETUP_LINE.test(line) || !RUN_LINE.test(line)) continue
      out.push(line)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw.trim())
    if (heading === null) continue
    const level = heading[1]!.length
    if (RUN_HEADING.test(heading[2]!)) {
      inSection = true
      sectionLevel = level
    } else if (inSection && level <= sectionLevel) {
      inSection = false
    }
  }
  return out
}

function nameFromCommand(command: string): string {
  return command.split(/\s+/).slice(0, 3).join(' ')
}

async function fromReadme(root: string, fs: SuggestFs): Promise<Candidate[]> {
  const text = (await fs.readFile(join(root, 'README.md'))) ?? (await fs.readFile(join(root, 'readme.md')))
  if (text === null) return []
  return readmeRunLines(text).map((command) => ({ name: nameFromCommand(command), command, source: 'README' }))
}

// ─── one-time actions ────────────────────────────────────────────────────────

/** Script and target names that read as a job worth a button: migrations, seeds, codegen, tests. */
const ONCE_SCRIPT =
  /(^|[:_-])(migrate|migration|migrations|seed|seeds|gen|generate|codegen|schema|db|reset|setup|bootstrap|test|tests|e2e|typecheck|lint)([:_-]|$)/i

/**
 * How strongly a command reads as a one-time action worth offering first:
 * migrations, then seeds, codegen, then tests and checks.
 */
export function oncePriority(suggestion: Pick<RunSuggestion, 'name' | 'command'>): number {
  const text = `${suggestion.name} ${suggestion.command}`.toLowerCase()
  if (/migrat|alembic (upgrade|downgrade)|db:?push/.test(text)) return 50
  if (/seed/.test(text)) return 42
  if (/codegen|generate|\bgen\b|schema/.test(text)) return 36
  if (/reset|setup|bootstrap/.test(text)) return 30
  if (/e2e|test/.test(text)) return 24
  if (/typecheck|lint/.test(text)) return 16
  return 10
}

/**
 * True for a command worth offering as a ONE-TIME action: a job that ends (a
 * build, a test run) or one that changes data or code once (a migration, a
 * seed, codegen) — never one that keeps running.
 */
export function looksOnceCommand(command: string): boolean {
  if (looksLongRunningCommand(command)) return false
  return looksOneShotCommand(command) || oncePriority({ name: '', command }) > 10
}

async function onceFromPackageJson(root: string, fs: SuggestFs): Promise<Candidate[]> {
  const text = await fs.readFile(join(root, 'package.json'))
  if (text === null) return []
  let scripts: unknown
  try {
    scripts = (JSON.parse(text) as { scripts?: unknown }).scripts
  } catch {
    return []
  }
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return []
  const run = await packageRunner(root, fs)
  const out: Candidate[] = []
  for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof body !== 'string' || body.trim() === '') continue
    const hooked = /^(pre|post)(.+)$/.exec(name)?.[2]
    if (hooked !== undefined && hooked in (scripts as Record<string, unknown>)) continue
    if (!ONCE_SCRIPT.test(name) || LONG_RUNNING_SCRIPT.test(name)) continue
    out.push({ name, command: run(name), source: 'package.json' })
  }
  return out
}

const ONCE_MAKE_TARGET = /^((?:db[-_])?(?:migrate|migration|seed|gen|generate|codegen|schema|reset|setup|bootstrap|test|e2e|lint)(?:[-_][A-Za-z0-9_-]+)?)\s*:(?!=)/

async function onceFromMakefile(root: string, fs: SuggestFs): Promise<Candidate[]> {
  const text = await fs.readFile(join(root, 'Makefile'))
  if (text === null) return []
  const out: Candidate[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = ONCE_MAKE_TARGET.exec(line)
    if (match === null) continue
    out.push({ name: match[1]!, command: `make ${match[1]!}`, source: 'Makefile' })
  }
  return out
}

/**
 * The migration tools a project's own files show it uses — the ONE reading of
 * those markers, shared by the one-time action chips and the automatic
 * migrations and seeds (`detectDataCommands`), so the two never disagree about
 * which tool a project has (allowed-pattern #14).
 */
export interface ToolMarkers {
  /** A `uv.lock`: Python commands run through `uv run`. */
  uv: boolean
  alembic: boolean
  django: boolean
  prisma: boolean
  drizzle: boolean
  rails: boolean
}

export async function readToolMarkers(root: string, fs: SuggestFs): Promise<ToolMarkers> {
  let drizzle = false
  for (const file of ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs']) {
    if (await fs.exists(join(root, file))) {
      drizzle = true
      break
    }
  }
  return {
    uv: await fs.exists(join(root, 'uv.lock')),
    alembic: await fs.exists(join(root, 'alembic.ini')),
    django: await fs.exists(join(root, 'manage.py')),
    prisma: await fs.exists(join(root, 'prisma', 'schema.prisma')),
    drizzle,
    rails: await fs.exists(join(root, 'bin', 'rails')),
  }
}

const pythonCommand = (markers: ToolMarkers, command: string): string => (markers.uv ? `uv run ${command}` : command)

/** The migration and codegen tools a project's own files show it uses. */
async function onceFromTools(root: string, fs: SuggestFs): Promise<Candidate[]> {
  const out: Candidate[] = []
  const markers = await readToolMarkers(root, fs)
  const py = (command: string): string => pythonCommand(markers, command)
  if (markers.alembic) out.push({ name: 'migrate', command: py('alembic upgrade head'), source: 'Alembic' })
  if (markers.django) out.push({ name: 'migrate', command: py('python manage.py migrate'), source: 'Django' })
  if (markers.prisma) {
    out.push({ name: 'migrate', command: 'npx prisma migrate dev', source: 'Prisma' })
    out.push({ name: 'generate', command: 'npx prisma generate', source: 'Prisma' })
  }
  if (markers.drizzle) out.push({ name: 'migrate', command: 'npx drizzle-kit migrate', source: 'Drizzle' })
  if (markers.rails) out.push({ name: 'migrate', command: 'bin/rails db:migrate', source: 'Rails' })
  return out
}

// ─── automatic migrations and seeds ──────────────────────────────────────────

/** A migration or seed command Flow found. Detection only: nothing here runs it. */
export interface DetectedCommand {
  command: string
  /** Where it was found, for the person checking the guess ("Alembic", "package.json", "Docker Compose"…). */
  source: string
  /** Set when the command IS a Compose service: the guard starts that service in the thread's run. */
  service?: string
}

export interface DataCommands {
  migrations: DetectedCommand[]
  seeds: DetectedCommand[]
}

const MIGRATE_NAME = /^(db[:_-])?(migrate|migrations?)$/i
const SEED_NAME = /^(db[:_-])?seeds?$/i

/**
 * The commands that bring a project's database up to date, and the ones that
 * fill a new one — read from the same markers as the one-time chips. In order:
 * a Compose service of their own, the project's tools, package.json scripts,
 * Makefile targets; de-duplicated by command. Automatic runs use the
 * non-interactive form (Prisma's deploy, not dev). Never throws.
 */
export async function detectDataCommands(root: string, fs: SuggestFs): Promise<DataCommands> {
  const migrations: DetectedCommand[] = []
  const seeds: DetectedCommand[] = []
  const add = (list: DetectedCommand[], found: DetectedCommand): void => {
    const command = found.command.replace(/\s+/g, ' ').trim()
    if (command === '' || list.some((item) => item.command === command)) return
    list.push({ ...found, command })
  }

  try {
    const compose = await readComposeDescription(root, fs)
    for (const service of compose?.description.services ?? []) {
      if (MIGRATE_NAME.test(service.name)) {
        add(migrations, { command: `docker compose run --rm ${service.name}`, source: 'Docker Compose', service: service.name })
      } else if (SEED_NAME.test(service.name)) {
        add(seeds, { command: `docker compose run --rm ${service.name}`, source: 'Docker Compose', service: service.name })
      }
    }
  } catch {
    // an unreadable Compose file contributes nothing
  }

  try {
    const markers = await readToolMarkers(root, fs)
    const py = (command: string): string => pythonCommand(markers, command)
    if (markers.alembic) add(migrations, { command: py('alembic upgrade head'), source: 'Alembic' })
    if (markers.django) add(migrations, { command: py('python manage.py migrate'), source: 'Django' })
    if (markers.prisma) add(migrations, { command: 'npx prisma migrate deploy', source: 'Prisma' })
    if (markers.drizzle) add(migrations, { command: 'npx drizzle-kit migrate', source: 'Drizzle' })
    if (markers.rails) {
      add(migrations, { command: 'bin/rails db:migrate', source: 'Rails' })
      add(seeds, { command: 'bin/rails db:seed', source: 'Rails' })
    }
  } catch {
    // a marker that cannot be read contributes nothing
  }

  try {
    const text = await fs.readFile(join(root, 'package.json'))
    if (text !== null) {
      const parsed = JSON.parse(text) as { scripts?: unknown; prisma?: unknown }
      const run = await packageRunner(root, fs)
      const scripts = parsed.scripts
      if (typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)) {
        for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
          if (typeof body !== 'string' || body.trim() === '') continue
          if (MIGRATE_NAME.test(name)) add(migrations, { command: run(name), source: 'package.json' })
          else if (SEED_NAME.test(name)) add(seeds, { command: run(name), source: 'package.json' })
        }
      }
      const prisma = parsed.prisma
      if (typeof prisma === 'object' && prisma !== null && typeof (prisma as { seed?: unknown }).seed === 'string') {
        add(seeds, { command: 'npx prisma db seed', source: 'Prisma' })
      }
    }
  } catch {
    // unreadable package.json contributes nothing
  }

  try {
    const text = await fs.readFile(join(root, 'Makefile'))
    for (const line of text?.split(/\r?\n/) ?? []) {
      const target = /^([A-Za-z0-9_-]+)\s*:(?!=)/.exec(line)?.[1]
      if (target === undefined) continue
      if (MIGRATE_NAME.test(target)) add(migrations, { command: `make ${target}`, source: 'Makefile' })
      else if (SEED_NAME.test(target)) add(seeds, { command: `make ${target}`, source: 'Makefile' })
    }
  } catch {
    // unreadable Makefile contributes nothing
  }

  return { migrations, seeds }
}

const ONCE_SCANNERS = [onceFromPackageJson, onceFromTools, onceFromMakefile]

/**
 * Every project's candidates for a ONE-TIME action — migrations, seeds,
 * codegen, tests — in scope order, de-duplicated per project by command.
 * Each is marked `use: 'once'`. Read-only; never throws.
 */
export async function suggestOnceSteps(projects: SuggestProject[], fs: SuggestFs): Promise<RunSuggestion[]> {
  const out: RunSuggestion[] = []
  for (const project of projects) {
    const seen = new Set<string>()
    for (const scan of ONCE_SCANNERS) {
      let found: Candidate[]
      try {
        found = await scan(project.dir ?? project.root, fs)
      } catch {
        found = []
      }
      for (const candidate of found) {
        const key = candidate.command.replace(/\s+/g, ' ').trim()
        if (key === '' || seen.has(key)) continue
        seen.add(key)
        out.push({ projectRoot: project.root, projectName: project.name, ...candidate, command: key, use: 'once' })
      }
    }
  }
  return out
}

// ─── the scanner ─────────────────────────────────────────────────────────────

const SCANNERS = [fromPackageJson, fromProcfile, fromCompose, fromMakefile, fromPyproject, fromReadme]

/**
 * Every project's candidates, in scope order, each source in a fixed order,
 * de-duplicated per project by command (the first source to name it wins).
 * A file that cannot be read contributes nothing; this never throws.
 */
export async function suggestRunSteps(projects: SuggestProject[], fs: SuggestFs): Promise<RunSuggestion[]> {
  const out: RunSuggestion[] = []
  for (const project of projects) {
    const seen = new Set<string>()
    for (const scan of SCANNERS) {
      let found: Candidate[]
      try {
        found = await scan(project.dir ?? project.root, fs)
      } catch {
        found = []
      }
      for (const candidate of found) {
        const key = candidate.command.replace(/\s+/g, ' ').trim()
        if (key === '' || seen.has(key)) continue
        seen.add(key)
        out.push({ projectRoot: project.root, projectName: project.name, ...candidate, command: key })
      }
    }
  }
  return out
}

/** The real read-only fs (async). */
export function nodeSuggestFs(): SuggestFs {
  return {
    readFile: async (path) => {
      const { readFile } = await import('fs/promises')
      try {
        return await readFile(path, 'utf8')
      } catch {
        return null
      }
    },
    exists: async (path) => {
      const { access } = await import('fs/promises')
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    },
  }
}
