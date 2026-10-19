/**
 * "THIS COPY HAS NO ENVIRONMENT YET" — said once, at the cut, to the projects
 * where it is true.
 *
 * A `git worktree` carries TRACKED files and nothing else. Flow carries three
 * untracked entries across on top of that — `node_modules` linked, `.env*`
 * copied, `flow/` linked — and that list is JS-shaped. A Python project keeps
 * its packages in a `.venv` that git ignores, so a fresh checkout has no
 * interpreter at all, and the first sign of it is a command failing in a
 * terminal with a message about somebody else's tool:
 *
 *   Project virtual environment directory …/.venv cannot be used because it is
 *   not a valid Python environment (no Python executable was found)
 *
 * (user, 2026-09-18, running alembic in a new checkout of orbit-core.)
 *
 * IT TELLS, IT DOES NOT RUN. Flow already has the mechanism for filling a new
 * copy — the project's setup command, which runs before the agent arrives and
 * is reported while it does. What it lacked was anything that says the project
 * needs one. Guessing the command and running it would be deciding to spend
 * somebody's network and disk on their behalf, on every cut, from a filename.
 *
 * THE EVIDENCE IS THE MAIN CHECKOUT'S OWN FOLDER, not a manifest. A
 * `pyproject.toml` says the project is Python; it does not say this machine
 * keeps the environment in the tree. The folder being THERE, beside the project,
 * is what makes "the copy will not have one" a fact rather than a guess — and it
 * is why this fires on exactly one of seventeen real projects on the machine
 * that reported it.
 */

/** An untracked folder a checkout needs and git will not carry. */
interface LocalEnvironment {
  /** The directory, relative to the project root. */
  dir: string
  /** What it is, in the reader's terms — never the folder's spelling. */
  label: string
}

/**
 * DELIBERATELY SHORT, AND IT GROWS WHEN A REAL CASE APPEARS.
 *
 * Every entry here is a claim about what a fresh checkout cannot do, and a
 * wrong one is a notice on every cut of a project that was fine. Go and Rust
 * are absent on purpose: their caches are global, so a new checkout builds —
 * slowly the first time, and correctly. `vendor/` is absent because it means
 * tracked dependencies in one ecosystem and untracked ones in another, and this
 * cannot tell which without asking git.
 */
const LOCAL_ENVIRONMENTS: readonly LocalEnvironment[] = [
  { dir: '.venv', label: 'Python environment' },
  { dir: 'venv', label: 'Python environment' },
]

export interface UnpreparedInput {
  /** True when the project already says what to run for a new copy. */
  setupConfigured: boolean
  /** The untracked entries the cut carried across, by name. */
  carried: readonly string[]
  /** Whether a path exists in the PROJECT — injected, never read here. */
  projectHas: (dir: string) => boolean
}

/**
 * One sentence for a copy that will not work yet, or null.
 *
 * Null for every project that configured a setup command — having answered the
 * question is the end of it, whether or not the answer is any good. This is not
 * a health check on the command; it is a notice that nobody was asked.
 */
export function unpreparedNote(input: UnpreparedInput): string | null {
  if (input.setupConfigured) return null
  const carried = new Set(input.carried)
  const missing = LOCAL_ENVIRONMENTS.find(
    (environment) => !carried.has(environment.dir) && input.projectHas(environment.dir),
  )
  if (missing === undefined) return null
  // NAMES A PLACE IN THE APP, NOT A CONFIG KEY (forbidden-pattern #12). The
  // reader can open that panel; they cannot press the name of a setting.
  return (
    `This copy has no ${missing.label} yet — those packages live in a folder git doesn’t copy. ` +
    'Set what to run for a new conversation in this project’s Conversation files settings and the next one will have it.'
  )
}
