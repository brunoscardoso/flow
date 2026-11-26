/**
 * A CONVERSATION'S DOCKER GROUP — what the Run setup store and the run
 * supervisor need to give a conversation its own Compose data, kept out of
 * both so their changes stay thin.
 *
 *   - PURE HELPERS (argv builders, folding a hand-made `docker compose up`,
 *     the port clash between projects, `.env` parsing, the group's steps).
 *   - THE SOURCE the store asks, per project of a conversation: with a
 *     Compose file in the conversation's checkout, the group (services,
 *     volumes, override) — read on EVERY resolve, so Run, Start Docker and
 *     Reload all always see the file as it is now. There is no switch to turn
 *     on: a project with a Compose file has a Docker group in every
 *     conversation, and nothing runs until a person presses Start Docker (or
 *     Run all).
 *   - THE PORT the supervisor drives on Start Docker and Run all: refuse a
 *     port clash, check Docker answers, stop whichever conversation's services
 *     are live, write the override, (re)create this conversation's
 *     containers, and — once they are
 *     ready — turn the detected migrations and seeds into commands through THE
 *     guard (`migration-guard.ts`), the only path one takes. The commands come
 *     from detection alone; nothing a person typed is stored or run here.
 *
 * HOW A GROUP RUNS (the override's header in `compose-thread.ts` says why):
 *
 *   docker compose -p <project's own Compose name> -f <checkout>/<file>
 *                  [-f <checkout>/<project override>] -f <thread override>
 *                  --project-directory <checkout> …
 *
 *   1. `up --no-start --renew-anon-volumes <services>` once, through the
 *      runner: every container is (re)created with the thread's volumes, and
 *      the anonymous volumes an image declares are NOT carried over from the
 *      previous thread's containers. Without the flag a database image's own
 *      VOLUME would leak one thread's data into the next.
 *   2. Each service then runs in its own terminal tab, attached:
 *      `up --no-recreate <service>` — the containers step 1 made, started.
 *
 * `-p` IS EXPLICIT. Compose names a project after its project directory, and
 * with `--project-directory <checkout>` that would be the checkout's folder —
 * a different project (other container names) per thread. The project's own
 * name keeps the same containers and ports as a run outside any thread, so a
 * switch is a recreate, as the override was designed for.
 *
 * Every Docker call goes through the injected `DockerRunner`; every sentence
 * here is shown to a person and names no command, path or setting
 * (forbidden-pattern #12). The commands built for terminals are commands, not
 * sentences — they are what the tab runs.
 */
import { basename, isAbsolute, join } from 'path'

import type { ResolvedRunStep, RunDockerGroup, RunReady } from '../../shared/run-setup'
import { DEFAULT_READY_TIMEOUT_MS } from '../../shared/run-setup'
import { readComposeDescription, type ComposeFs } from './compose-describe'
import {
  LABEL_THREAD,
  projectDataSlug,
  threadComposeOverride,
  type ThreadComposePlan,
  type ThreadPublishedPort,
} from './compose-thread'
import { listThreadContainers, listThreadVolumes, liveThread, type OverrideFiles } from './compose-thread-store'
import { dockerAvailability, openDockerDesktop, type DockerRunner, type OpenDockerResult } from './docker-runner'
import { databaseAddressesFrom, guardMigration } from './migration-guard'
import type { DataCommands, DetectedCommand } from './run-suggest'

// ─── timeouts ────────────────────────────────────────────────────────────────

/** Creating a thread's containers can pull images: give it room. */
export const DOCKER_CREATE_TIMEOUT_MS = 10 * 60_000
/** Stopping a live thread's services. */
export const DOCKER_STOP_TIMEOUT_MS = 2 * 60_000
/** Reading a service's last lines. */
export const DOCKER_LOGS_TIMEOUT_MS = 15_000
/** A Docker-group service that stops within this long after a switch is reported with its last lines. */
export const EARLY_EXIT_MS = 20_000
/** How many of its last lines. */
export const EARLY_EXIT_LINES = 20

// ─── sentences ───────────────────────────────────────────────────────────────

export const DOCKER_SENTENCE = {
  preparing: "Getting this conversation's services ready.",
  stopFailed: "Docker couldn't stop the services of the conversation that was running, so this conversation's services didn't start.",
  overrideFailed: "Flow couldn't save this conversation's service settings, so its services didn't start.",
  createFailed: "Docker couldn't create this conversation's services, so they didn't start.",
  earlyExit: 'This service stopped right after starting. Resetting the conversation\'s data often fixes it when its data was made by an older version. Its last lines:',
  earlyExitNoLines: "This service stopped right after starting. Resetting the conversation's data often fixes it when its data was made by an older version.",
  notReady: "Some of this conversation's services aren't ready, so its database wasn't updated.",
  notOurs:
    "This conversation's services weren't the ones running, so Flow didn't update the database. Press Start Docker to try again.",
  noMigrations: "Flow didn't find a command that updates this project's database, so none ran.",
  migrationFailed: "Updating this conversation's database didn't finish, so the rest of its data steps didn't run.",
} as const

export function portClashSentence(first: string, second: string, port: number): string {
  return `${first} and ${second} both use port ${port} on this computer, so this conversation's services can't start together. Change the port in one of them and press Start Docker again.`
}

// ─── argv ────────────────────────────────────────────────────────────────────

/** Where a thread's Compose run reads its files and runs from. Every path absolute. */
export interface ComposeTarget {
  /** The project's own Compose project name (container names and network). */
  projectName: string
  checkout: string
  composeFile: string
  projectOverride: string | null
  overridePath: string
}

/** One shell word: plain when it is safe as written, else single-quoted. */
export function shellQuote(word: string): string {
  if (word !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** A terminal command line from an argv — every word quoted where it has to be. */
export function commandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ')
}

export function composeBaseArgs(target: ComposeTarget): string[] {
  return [
    'compose',
    '-p',
    target.projectName,
    '-f',
    target.composeFile,
    ...(target.projectOverride !== null ? ['-f', target.projectOverride] : []),
    '-f',
    target.overridePath,
    '--project-directory',
    target.checkout,
  ]
}

/** (Re)create the thread's containers, renewing anonymous volumes, without starting them. */
export function composeCreateArgs(target: ComposeTarget, services: readonly string[]): string[] {
  return [...composeBaseArgs(target), 'up', '--no-start', '--renew-anon-volumes', ...services]
}

/** One service, attached — what its terminal tab runs. */
export function composeServiceUpArgs(target: ComposeTarget, service: string): string[] {
  return [...composeBaseArgs(target), 'up', '--no-recreate', service]
}

export function composeStopArgs(target: ComposeTarget): string[] {
  return [...composeBaseArgs(target), 'stop']
}

export function composeExecArgs(target: ComposeTarget, service: string, command: string): string[] {
  return [...composeBaseArgs(target), 'exec', '-T', service, 'sh', '-lc', command]
}

export function composeRunArgs(target: ComposeTarget, service: string): string[] {
  return [...composeBaseArgs(target), 'run', '--rm', service]
}

export function composeLogsArgs(target: ComposeTarget, service: string, tail = EARLY_EXIT_LINES): string[] {
  return [...composeBaseArgs(target), 'logs', '--no-color', '--tail', String(tail), service]
}

/**
 * The name Compose gives a project run from its own folder: a top-level
 * `name:` when the file writes one plainly, else the folder's name made the
 * way Compose makes it (lowercase; letters, digits, `-` and `_`).
 */
export function composeProjectName(projectRoot: string, composeText: string): string {
  const declared = /^name:[ \t]*["']?([A-Za-z0-9][A-Za-z0-9_-]*)["']?[ \t]*(?:#.*)?$/m.exec(composeText)?.[1]
  if (declared !== undefined) return declared.toLowerCase()
  const clean = basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[^a-z0-9]+/, '')
  return clean === '' ? 'project' : clean
}

// ─── hand-made steps ─────────────────────────────────────────────────────────

/** Flags of `up` that change nothing about WHICH services start. */
const HARMLESS_UP_FLAGS = new Set(['-d', '--detach', '--build', '--remove-orphans', '--force-recreate', '--no-deps', '--wait', '--no-recreate', '--renew-anon-volumes', '-V'])

/**
 * The services a hand-made step starts when it is plainly `docker compose up
 * [flags] [services]` (or `docker-compose up …`) — `[]` for "every service",
 * null when it is anything else (another file, another project, other flags).
 */
export function handMadeComposeServices(command: string): string[] | null {
  const words = command.trim().split(/\s+/)
  let at = 0
  if (words[at] === 'docker' && words[at + 1] === 'compose') at += 2
  else if (words[at] === 'docker-compose') at += 1
  else return null
  if (words[at] !== 'up') return null
  const services: string[] = []
  for (const word of words.slice(at + 1)) {
    if (word.startsWith('-')) {
      if (!HARMLESS_UP_FLAGS.has(word)) return null
      continue
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(word)) return null
    services.push(word)
  }
  return services
}

/**
 * Take out the hand-made steps a project's Docker group replaces: a step in
 * that project whose command starts only services the group runs (or every
 * service, when the group runs every one). Anything else stays a local step.
 */
export function foldHandMadeSteps(
  steps: readonly ResolvedRunStep[],
  groups: ReadonlyArray<Pick<RunDockerGroup, 'projectRoot' | 'services' | 'unreadable'>>,
): { kept: ResolvedRunStep[]; folded: Map<string, string[]> } {
  const folded = new Map<string, string[]>()
  const kept: ResolvedRunStep[] = []
  for (const step of steps) {
    const group = step.docker === undefined ? groups.find((candidate) => candidate.projectRoot === step.projectRoot) : undefined
    const named = group === undefined ? null : handMadeComposeServices(step.command)
    const covered =
      group !== undefined &&
      named !== null &&
      (named.length === 0 ? group.unreadable.length === 0 && group.services.length > 0 : named.every((service) => group.services.includes(service)))
    if (covered && group !== undefined) {
      folded.set(group.projectRoot, [...(folded.get(group.projectRoot) ?? []), step.key])
      continue
    }
    kept.push(step)
  }
  return { kept, folded }
}

// ─── ports ───────────────────────────────────────────────────────────────────

const ALL_ADDRESSES = new Set(['', '0.0.0.0', '::'])

function sameBind(a: ThreadPublishedPort, b: ThreadPublishedPort): boolean {
  const ia = (a.hostIp ?? '').toLowerCase()
  const ib = (b.hostIp ?? '').toLowerCase()
  return ALL_ADDRESSES.has(ia) || ALL_ADDRESSES.has(ib) || ia === ib
}

/** Two projects of one conversation publishing the same port on this computer — the first such pair, or null. */
export function publishedPortClash(
  groups: ReadonlyArray<{ projectName: string; publishedPorts: readonly ThreadPublishedPort[] }>,
): { port: number; first: string; second: string } | null {
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const a = groups[i]!
      const b = groups[j]!
      for (const pa of a.publishedPorts) {
        const hit = b.publishedPorts.find(
          (pb) => pb.published === pa.published && pb.protocol.toLowerCase() === pa.protocol.toLowerCase() && sameBind(pa, pb),
        )
        if (hit !== undefined) return { port: pa.published, first: a.projectName, second: b.projectName }
      }
    }
  }
  return null
}

// ─── .env ────────────────────────────────────────────────────────────────────

/** `KEY=VALUE` lines of an env file: comments, `export`, quotes. Anything else is skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2]!
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1)
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"')
    } else {
      value = value.replace(/[ \t]+#.*$/, '').trim()
    }
    out[match[1]!] = value
  }
  return out
}

// ─── a group and its steps ───────────────────────────────────────────────────

/** Everything about one project's Docker group that stays in main. */
export interface DockerGroupPlan {
  group: RunDockerGroup
  plan: ThreadComposePlan
  target: ComposeTarget
}

/** The port a service's step waits for: its first port published on this computer. */
function readyPortOf(plan: ThreadComposePlan, service: string): RunReady | undefined {
  const port = plan.publishedPorts.find((candidate) => candidate.service === service && candidate.protocol.toLowerCase() === 'tcp')
  return port === undefined ? undefined : { kind: 'port', port: port.published }
}

/** The group's steps: one per service, each running it attached in its own tab. */
export function dockerStepsFor(groupPlan: DockerGroupPlan): ResolvedRunStep[] {
  const { group, plan, target } = groupPlan
  return group.services.map((service) => {
    const step: ResolvedRunStep = {
      key: `${group.projectRoot}::docker:${service}`,
      projectRoot: group.projectRoot,
      projectName: group.projectName,
      cwd: group.checkout,
      id: `docker:${service}`,
      name: service,
      command: commandLine(['docker', ...composeServiceUpArgs(target, service)]),
      start: 'now',
      readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS,
      from: { command: 'shared', ready: 'shared' },
      docker: { projectRoot: group.projectRoot, service },
    }
    const ready = readyPortOf(plan, service)
    if (ready !== undefined) step.ready = ready
    return step
  })
}

/**
 * The Docker plans behind a resolution, kept beside it rather than in it: a
 * resolution crosses to the renderer, the plans (override, guard inputs) never
 * need to. Keyed by the resolution object, so a plan can never be read against
 * a resolution it was not made for.
 */
const plansByResolution = new WeakMap<object, ReadonlyMap<string, DockerGroupPlan>>()

export function attachDockerPlans(resolution: object, plans: ReadonlyMap<string, DockerGroupPlan>): void {
  if (plans.size > 0) plansByResolution.set(resolution, plans)
}

/** The Docker plans of a resolution, by project root — empty when it has none. */
export function dockerPlansOf(resolution: object): ReadonlyMap<string, DockerGroupPlan> {
  return plansByResolution.get(resolution) ?? new Map()
}

// ─── the source the store asks ───────────────────────────────────────────────

export interface ThreadDockerSourceDeps {
  fs: ComposeFs
  overrides: Pick<OverrideFiles, 'pathFor'>
  /** The slug — `projectDataSlug` in the app; injectable only for tests. */
  slugOf?: (projectRoot: string) => string
}

export interface RunDockerSource {
  /** The project's Docker group for a conversation, or null (no readable Compose file). Never throws. */
  groupFor(project: { root: string; name: string; cwd: string }, threadId: string): Promise<DockerGroupPlan | null>
}

export function createThreadDockerSource(deps: ThreadDockerSourceDeps): RunDockerSource {
  const slugOf = deps.slugOf ?? projectDataSlug
  return {
    groupFor: async (project, threadId) => {
      try {
        if (!isAbsolute(project.cwd)) return null
        // Read from the conversation's checkout on every resolve (FR-4).
        const compose = await readComposeDescription(project.cwd, deps.fs)
        if (compose === null) return null
        const projectSlug = slugOf(project.root)
        const plan = threadComposeOverride({ project: compose.description, projectSlug, threadId, checkout: project.cwd })
        if (plan.readableServices.length === 0) return null
        const target: ComposeTarget = {
          projectName: composeProjectName(project.root, compose.text),
          checkout: plan.checkout,
          composeFile: join(plan.checkout, compose.file),
          projectOverride: compose.projectOverride === null ? null : join(plan.checkout, compose.projectOverride),
          overridePath: deps.overrides.pathFor(projectSlug, threadId),
        }
        const group: RunDockerGroup = {
          projectRoot: project.root,
          projectName: project.name,
          threadId,
          checkout: plan.checkout,
          services: [...plan.readableServices],
          dataServices: [...plan.dataServices],
          volumes: plan.volumes.map((volume) => volume.name),
          unreadable: plan.unreadable.map((entry) => ({ ...entry })),
          folded: [],
          notes: [
            ...plan.sharedVolumes.map((entry) => entry.reason),
            ...plan.sharedBinds.map((entry) => entry.reason),
            ...plan.problems,
          ].filter((note, index, all) => all.indexOf(note) === index),
        }
        return { group, plan, target }
      } catch {
        return null
      }
    },
  }
}

// ─── the port the supervisor drives ──────────────────────────────────────────

export type DockerPrepareResult =
  | { ok: false; kind: 'port-clash' | 'docker-unavailable'; detail: string; offerOpenDocker: boolean }
  | {
      ok: true
      /** Per project: ready to start (and whether its volumes were just made), or why not. */
      projects: Map<string, { ok: true; newVolumes: boolean } | { ok: false; detail: string }>
    }

/** One migration or seed of a group, through the guard. */
export type DockerDataItem =
  | { kind: 'migration' | 'seed'; name: string; run: { command: string; cwd: string } }
  | { kind: 'migration' | 'seed'; name: string; refused: string }

export interface RunDockerPort {
  /**
   * Before a conversation's group starts: refuse a port clash, check Docker
   * answers, stop whichever conversation's services are live (`beforeStop`
   * first, so the supervisor can mark their tabs stopped), write each
   * override and (re)create the containers. Never throws.
   */
  prepare(input: { threadId: string; groups: DockerGroupPlan[]; beforeStop: (threadId: string) => void }): Promise<DockerPrepareResult>
  /** The group's migrations (every Run) and seeds (new volumes only), each through the guard. Never throws. */
  dataCommands(groupPlan: DockerGroupPlan, newVolumes: boolean): Promise<{ items: DockerDataItem[]; notice: string | null }>
  /** A service's last lines, or null when Docker did not say. */
  lastLines(groupPlan: DockerGroupPlan, service: string): Promise<string | null>
  /** Stop every service of a conversation, in every project. Never throws; false when Docker did not manage it. */
  stopThread(threadId: string): Promise<boolean>
  openDocker(): Promise<OpenDockerResult>
}

export interface ThreadDockerDeps {
  runner: DockerRunner
  overrides: Pick<OverrideFiles, 'write'>
  /** Files of a checkout (`.env`, `.env.local`) — read-only. */
  fs: ComposeFs
  detectDataCommands: (root: string) => Promise<DataCommands>
  /**
   * A conversation's Docker groups (every project), or null when the
   * conversation is unknown — used to stop the live one with its own files.
   */
  resolveThread: (threadId: string) => Promise<DockerGroupPlan[] | null>
  /** The environment a local command inherits; its database variables count too. */
  processEnv: Record<string, string | undefined>
  /** electron's `shell.openPath`. */
  opener: (path: string) => Promise<string>
  slugOf?: (projectRoot: string) => string
  /** Waits between checks that the thread's containers run — a timer by default. */
  wait?: (ms: number) => Promise<void>
}

/** How long the data step waits for this thread's containers to run, and how often it looks. */
export const DATA_RUNNING_CHECKS = 15
export const DATA_RUNNING_INTERVAL_MS = 2_000

/** Every service's resolved environment, from `compose config`; null when it cannot be read. */
export function serviceEnvironmentsFrom(configJson: string): Record<string, Record<string, string>> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(configJson)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const services = (parsed as { services?: unknown }).services
  if (typeof services !== 'object' || services === null) return null
  const out: Record<string, Record<string, string>> = {}
  for (const [name, service] of Object.entries(services as Record<string, unknown>)) {
    const env: Record<string, string> = {}
    const raw = typeof service === 'object' && service !== null ? (service as { environment?: unknown }).environment : undefined
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (typeof entry !== 'string') continue
        const at = entry.indexOf('=')
        if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1)
      }
    } else if (typeof raw === 'object' && raw !== null) {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'string') env[key] = value
        else if (typeof value === 'number' || typeof value === 'boolean') env[key] = String(value)
      }
    }
    out[name] = env
  }
  return out
}

function lastLinesOf(text: string, count: number): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-count)
    .join('\n')
}

function withLines(sentence: string, output: string): string {
  const lines = lastLinesOf(output, 5)
  return lines === '' ? sentence : `${sentence} Docker said:\n${lines}`
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value
  return out
}

export function createThreadDocker(deps: ThreadDockerDeps): RunDockerPort {
  const { runner } = deps
  const slugOf = deps.slugOf ?? projectDataSlug

  /** Stop a thread's running containers by label alone — when its own files cannot be found. */
  async function stopByLabel(threadId: string): Promise<boolean> {
    const listed = await runner.run(['ps', '-q', '--filter', `label=${LABEL_THREAD}=${threadId}`], { timeoutMs: DOCKER_STOP_TIMEOUT_MS })
    if (!listed.ok) return false
    const ids = listed.stdout.split(/\s+/).filter((id) => id !== '')
    if (ids.length === 0) return true
    const stopped = await runner.run(['stop', ...ids], { timeoutMs: DOCKER_STOP_TIMEOUT_MS })
    return stopped.ok
  }

  async function stopThread(threadId: string): Promise<boolean> {
    try {
      const groups = await deps.resolveThread(threadId)
      let ok = true
      for (const groupPlan of groups ?? []) {
        // Every thread of a project shares one Compose project name, so a
        // compose stop stops whichever thread is live. Only the live thread
        // takes the polite path; any other is stopped by its label below.
        const live = await liveThread(runner, slugOf(groupPlan.group.projectRoot))
        if (!live.ok) {
          ok = false
          continue
        }
        if (live.threadId !== threadId) continue
        const result = await runner.run(composeStopArgs(groupPlan.target), { timeoutMs: DOCKER_STOP_TIMEOUT_MS })
        if (!result.ok) ok = false
      }
      // Anything still carrying its label (a project whose file moved, an
      // unknown conversation) is stopped by label — compose stop is the
      // polite path, the label is the guarantee.
      const leftovers = await stopByLabel(threadId)
      const polite = groups !== null && groups.length > 0 && ok
      return polite || leftovers
    } catch {
      return false
    }
  }

  async function prepareNow({ threadId, groups, beforeStop }: Parameters<RunDockerPort['prepare']>[0]): Promise<DockerPrepareResult> {
      const clash = publishedPortClash(groups.map((entry) => ({ projectName: entry.group.projectName, publishedPorts: entry.plan.publishedPorts })))
      if (clash !== null) {
        return { ok: false, kind: 'port-clash', detail: portClashSentence(clash.first, clash.second, clash.port), offerOpenDocker: false }
      }
      const available = await dockerAvailability(runner)
      if (!available.available) {
        return { ok: false, kind: 'docker-unavailable', detail: available.detail, offerOpenDocker: available.reason === 'not-running' }
      }

      // Whose data is live, in any project of this conversation.
      const live = new Set<string>()
      for (const entry of groups) {
        try {
          const answer = await liveThread(runner, slugOf(entry.group.projectRoot))
          if (answer.ok && answer.threadId !== null && answer.threadId !== threadId) live.add(answer.threadId)
        } catch {
          // unreadable: the create below recreates the containers anyway
        }
      }
      const projects = new Map<string, { ok: true; newVolumes: boolean } | { ok: false; detail: string }>()
      for (const other of live) {
        beforeStop(other)
        if (!(await stopThread(other))) {
          for (const entry of groups) projects.set(entry.group.projectRoot, { ok: false, detail: DOCKER_SENTENCE.stopFailed })
          return { ok: true, projects }
        }
      }

      for (const entry of groups) {
        const { group, plan, target } = entry
        let newVolumes = false
        try {
          const existing = await listThreadVolumes(runner, slugOf(group.projectRoot), threadId, { sizes: false })
          if (existing.ok) {
            const names = new Set(existing.items.map((item) => item.name))
            newVolumes = plan.volumes.some((volume) => !names.has(volume.name))
          }
        } catch {
          newVolumes = false
        }
        try {
          await deps.overrides.write(plan)
        } catch {
          projects.set(group.projectRoot, { ok: false, detail: DOCKER_SENTENCE.overrideFailed })
          continue
        }
        const created = await runner.run(composeCreateArgs(target, group.services), {
          cwd: target.checkout,
          timeoutMs: DOCKER_CREATE_TIMEOUT_MS,
        })
        if (!created.ok) {
          projects.set(group.projectRoot, { ok: false, detail: withLines(DOCKER_SENTENCE.createFailed, created.stderr || created.stdout) })
          continue
        }
        projects.set(group.projectRoot, { ok: true, newVolumes })
      }
      return { ok: true, projects }
  }

  /**
   * True once this thread's own containers run every service a data command
   * needs, and no other thread's do. A port that answers proves nothing: a
   * server already on this computer can hold it while Compose fails to bind.
   */
  async function ourServicesRun(groupPlan: DockerGroupPlan): Promise<boolean> {
    const { group, plan } = groupPlan
    const slug = slugOf(group.projectRoot)
    const needed = [...new Set([...plan.dataServices, ...(plan.appService !== null ? [plan.appService] : [])])]
    const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let check = 0; check < DATA_RUNNING_CHECKS; check += 1) {
      if (check > 0) await wait(DATA_RUNNING_INTERVAL_MS)
      try {
        const live = await liveThread(runner, slug)
        if (!live.ok) continue
        if (live.threadId !== null && live.threadId !== plan.threadId) return false
        const containers = await listThreadContainers(runner, slug, plan.threadId)
        if (!containers.ok) continue
        const running = new Set(containers.items.filter((item) => item.state === 'running').map((item) => item.service))
        if (needed.every((service) => running.has(service))) return true
      } catch {
        // unanswered: look again
      }
    }
    return false
  }

  async function serviceEnvironments(target: ComposeTarget): Promise<Record<string, Record<string, string>> | null> {
    try {
      const result = await runner.run([...composeBaseArgs(target), 'config', '--format', 'json'], {
        cwd: target.checkout,
        timeoutMs: DOCKER_LOGS_TIMEOUT_MS,
      })
      return result.ok ? serviceEnvironmentsFrom(result.stdout) : null
    } catch {
      return null
    }
  }

  async function dataCommandsNow(groupPlan: DockerGroupPlan, newVolumes: boolean): Promise<{ items: DockerDataItem[]; notice: string | null }> {
      const { group, plan, target } = groupPlan
      // Detection is the only source; every command it finds goes through
      // the guard below (never around it).
      let found: DataCommands
      try {
        found = await deps.detectDataCommands(group.checkout)
      } catch {
        found = { migrations: [], seeds: [] }
      }
      // Every address the command could use: the checkout's env files AND
      // the environment it inherits. Each source is read on its own, so a
      // variable one source sets never hides the other's.
      const fileEnv: Record<string, string> = {}
      for (const file of ['.env', '.env.local']) {
        try {
          const text = await deps.fs.readFile(join(group.checkout, file))
          if (text !== null) Object.assign(fileEnv, parseEnvFile(text))
        } catch {
          // unreadable: contributes nothing
        }
      }
      const addresses = [...new Set([...databaseAddressesFrom(fileEnv), ...databaseAddressesFrom(definedEnv(deps.processEnv))])]

      const wanted: Array<{ kind: 'migration' | 'seed'; found: DetectedCommand }> = [
        ...found.migrations.map((entry) => ({ kind: 'migration' as const, found: entry })),
        ...(newVolumes ? found.seeds.map((entry) => ({ kind: 'seed' as const, found: entry })) : []),
      ]
      const notice = found.migrations.length === 0 ? DOCKER_SENTENCE.noMigrations : null
      if (wanted.length === 0) return { items: [], notice }
      if (!(await ourServicesRun(groupPlan))) {
        return {
          items: wanted.map(({ kind }) => ({ kind, name: kind === 'migration' ? 'Update database' : 'Fill new database', refused: DOCKER_SENTENCE.notOurs })),
          notice,
        }
      }
      const needsEnvironment = plan.appService !== null || wanted.some(({ found: entry }) => entry.service !== undefined)
      const environments = needsEnvironment ? await serviceEnvironments(target) : null
      const items: DockerDataItem[] = wanted.map(({ kind, found: entry }) => {
        const name = kind === 'migration' ? 'Update database' : 'Fill new database'
        const guarded = guardMigration({
          command: entry.command,
          plan,
          databaseAddresses: addresses,
          serviceEnvironments: environments,
          ...(entry.service !== undefined ? { composeService: entry.service } : {}),
        })
        switch (guarded.kind) {
          case 'inside':
            return { kind, name, run: { command: commandLine(['docker', ...composeExecArgs(target, guarded.service, guarded.command)]), cwd: group.checkout } }
          case 'service':
            return { kind, name, run: { command: commandLine(['docker', ...composeRunArgs(target, guarded.service)]), cwd: group.checkout } }
          case 'local':
            return { kind, name, run: { command: guarded.command, cwd: group.checkout } }
          case 'refused':
            return { kind, name, refused: guarded.reason }
        }
      })
      return { items, notice }
  }

  // One switch at a time: two threads preparing at once would recreate the
  // same shared container names in turn, and the first would then start the
  // second one's containers.
  let switching: Promise<unknown> = Promise.resolve()

  return {
    prepare(args) {
      const next = switching.then(() => prepareNow(args))
      switching = next.catch(() => undefined)
      return next
    },

    async dataCommands(groupPlan, newVolumes) {
      return dataCommandsNow(groupPlan, newVolumes)
    },

    async lastLines(groupPlan, service) {
      try {
        const result = await runner.run(composeLogsArgs(groupPlan.target, service), {
          cwd: groupPlan.target.checkout,
          timeoutMs: DOCKER_LOGS_TIMEOUT_MS,
        })
        if (!result.ok) return null
        const lines = lastLinesOf(`${result.stdout}\n${result.stderr}`, EARLY_EXIT_LINES)
        return lines === '' ? null : lines
      } catch {
        return null
      }
    },

    stopThread,

    openDocker: () => openDockerDesktop(deps.opener),
  }
}
