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

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']

/** Top-level service names under `services:` — read by indentation, no YAML parser needed. */
export function composeServices(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const services: string[] = []
  let inServices = false
  let childIndent: number | null = null
  for (const raw of lines) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    if (indent === 0) {
      inServices = /^services\s*:\s*$/.test(raw.trim())
      childIndent = null
      continue
    }
    if (!inServices) continue
    if (childIndent === null) childIndent = indent
    if (indent !== childIndent) continue
    const match = /^["']?([A-Za-z0-9._-]+)["']?\s*:/.exec(raw.trim())
    if (match !== null) services.push(match[1]!)
  }
  return services
}

async function fromCompose(root: string, fs: SuggestFs): Promise<Candidate[]> {
  for (const file of COMPOSE_FILES) {
    const text = await fs.readFile(join(root, file))
    if (text === null) continue
    return composeServices(text).map((service) => ({
      name: service,
      command: `docker compose up ${service}`,
      source: 'Docker Compose',
    }))
  }
  return []
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
