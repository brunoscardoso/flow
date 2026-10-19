# Native Codex / PlanFlow pilot

This pilot adds repository-local native Codex entry points and a disposable smoke test for the real PlanFlow CLI. It validates the planning boundary without starting a provider, provisioning a workspace, or changing production behavior.

Run with existing project dependencies:

```sh
node --test scripts/native-codex-entrypoints.test.mjs
npm run build
node scripts/native-codex-smoke.mjs
npm test -- --runInBand --watchman=false src/cli/commands/plan.test.ts src/cli/init-command-config.test.ts
```

The script emits JSON command records with stdout, stderr and exit status. It asserts two phases, dependency and verification preservation, identical repeated compilation, valid empty change notes, and a cycle refusal that leaves no run artifact. It deletes only its own temporary fixture, even after failure.

## Snapshot and integration evidence

The pilot started from committed revision `0dff77a51b7719f921c311bdc955d1fbac4402ec` in an independent clone. The active checkout had 942 changes; none were copied. The installed `planflow-ai` shim points to that checkout's dist, so this pilot rebuilt its own dist from the pinned source. Build metadata confirmed the pinned commit. Dependencies were reused from the existing personal installation; no packages were installed.

Both package and CLI report 1.4.3. Source `src/cli/init-command-config.ts` still exposes Claude-only installation. Unknown init flags are tolerated, so passing `--codex` would not establish Codex support. The source revision has no root `AGENTS.md` or PlanFlow skill under `.agents/skills`; the active checkout's two Neon skills are unrelated. No secrets or linked knowledge stores were copied or read.

`app/src/main/agent/agent-manager.ts` calls the app's slash-command expander; `app/src/main/agent/runtime/slash-command.ts` reads command bodies. Native Codex does not gain that app behavior merely by running the CLI. This pilot explicitly reads the existing workflow guidance and executes supported deterministic commands. A fresh native task subsequently verified automatic AGENTS.md loading and access to its linked workflow skill (details below). Automatic skill-catalog registration and full app Autopilot parity are not demonstrated.

The installed standalone `codex-cli 0.19.0` failed before a session started: its existing MCP configuration could not deserialize `mcp_servers.Figma` (missing `command`). No global settings, account or provider configuration was changed. The pilot work itself ran in the native Codex task. This external legacy-CLI error does not block the validated native task route.

## Workflow coverage and results

| Stage / command | Result |
| --- | --- |
| Setup inspection | Passed: existing source, instructions, CLI help, and app adapter inspected; init skipped because it has unrelated global/workspace effects |
| Brainstorm | Original native agent authored options and selection in brainstorm.md from the authorized bounded scope; no automatic command expansion or fresh-task brainstorming test |
| Discovery / specification | Original native agent authored discovery.md using the workflow guidance; no automated discovery-generation test; no UI or external contract needed |
| Plan | Original native agent authored plan.md; local flow copy compiled successfully; the smoke test uses a seeded two-phase plan |
| `npm run build` | Exit 0; pinned source built successfully |
| `plan compile native_codex_pilot --target .` | Exit 0; two sequential waves; default model label opus is compiler metadata, no provider invoked |
| `node scripts/native-codex-smoke.mjs` | Exit 0; five CLI subprocess checks passed, including expected cycle exit 1 |
| `plan notes native_codex_pilot --check --json --target .` | Exit 0; zero code-function change notes, appropriate for new fixture/docs |
| Execute / write tests | Implemented smoke fixture in this native session; compiler artifacts do not execute themselves |
| Review | Local diff reviewed; no production behavior change; only fixture-owned temporary directory removed |
| Scoped Jest suites | Final exit 0: 2 suites, 14 tests passed |
| Initial Jest attempts | Watchman denied, then tsx IPC socket denied; resolved with `--watchman=false` and approved test execution outside the filesystem sandbox |
| `git diff --check` | Exit 0 |
| `flow risk --record low ...` / `flow risk --check ...` | Both exit 0; publish gate allowed low-risk fixture/docs |
| `worktree bind --here --remote origin --branch codex/native-planflow-pilot --json --target .` | Exit 0; explicit binding in isolated clone |
| Standalone `codex exec` | Failed at configuration parsing; no session or instruction-discovery proof |

Runtime flow files remain local and ignored. These documentation copies preserve the reviewable brainstorm, discovery and plan without publishing private runtime state or generated run artifacts.

## Deliberate limits and follow-ups

- Full application E2E and full repository suite were not run for this fixture/docs-only change. The existing GitHub workflow filters pull requests to `app/**` and its own workflow file; it does not cover this change.
- Contracts, UI artifacts, heartbeat, knowledge sync, loop orchestration, merge, deployment and global pattern capture are not applicable to this pilot.
- Automatic skill-catalog registration remains unverified: the fresh native task loaded AGENTS.md automatically but read the skill through its link. A draft option for the PlanFlow PR helper remains a separate follow-up. The pilot uses the authorized draft-capable GitHub CLI route after PlanFlow's bound push, because `worktree pr` has no draft flag.
- The legacy standalone Codex configuration issue is separate from the working native task route. No global repair is required to use that route; this pilot does not change global settings.

## Repository-local native entry points

The follow-up adds root `AGENTS.md` and `.agents/skills/planflow-workflow/SKILL.md`.
They route to the existing maintained command bodies instead of duplicating those
workflows. The skill has native name/description frontmatter and does not opt out
of implicit discovery; catalog registration was not observed in the fresh task. It adapts provider-specific tool names to available native
tools while preserving stage boundaries, authorization and honest results.

This follows the official [AGENTS.md discovery contract](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
and [repository skill discovery locations](https://learn.chatgpt.com/docs/build-skills).
Start a new supported Codex session in this checkout and request the PlanFlow
workflow. The verified route is automatic AGENTS.md loading followed by reading
its linked skill; `$planflow-workflow` catalog invocation was not validated. This is repository-local authoring;
`init --codex` is still not implemented, and this change does not install into other projects.

Validation distinguishes packaging from runtime behavior:

| Check | Outcome |
| --- | --- |
| `node --test scripts/native-codex-entrypoints.test.mjs` | Exit 0; 2 tests pass: metadata, root-to-skill routing, canonical command/skill references and no reference escaping the repository |
| Skill Creator `quick_validate.py .agents/skills/planflow-workflow` | Exit 0; skill valid |
| Built CLI smoke fixture after entry-point changes | Exit 0 |
| Standalone `codex exec -s read-only -C <pilot> ...` discovery probe | Exit 1 before session initialization; this external CLI probe cannot establish native-platform discovery behavior |

Exact startup error:

```text
Failed to deserialize overridden config: missing field `command`
in `mcp_servers.Figma`
```

The executable is Homebrew Codex 0.19.0. The incompatible entry is in the user's
`~/.codex/config.toml`, not this repository. Read-only inspection confirmed its
Figma entry has a `url` key and no `command`. That legacy binary expects a
command-based MCP definition. This is an external-CLI compatibility issue, not a
blocker for the native Codex task route validated below. No config, security
setting, credential, account or integration was changed or disabled. The package
and reference tests alone are not proof of runtime discovery.

## Published milestone

Draft PR: #1948, targeting `main` from
`codex/native-planflow-pilot`. The initial published commit was
`6306a7e89ed56f9f6ba8658aaaab7ac1c22f93d9`.
Its reported checks were `Vercel: SUCCESS` and `Vercel Preview Comments: COMPLETED / SUCCESS`.
GitHub Actions listed no runs for the branch; the app E2E workflow excludes these
paths. These external checks do not substitute for the local CLI validation.

## Fresh native task validation

A separate native Codex task started with this isolated checkout as its actual
working directory at `de2cd80ff3e9176f38dbd3547702ffde9fe74867`.
The validation result was supplied to the pilot coordinator on 2026-10-14:

| Observation | Result |
| --- | --- |
| Startup repository instructions | PlanFlow AGENTS.md supplied automatically |
| Startup skill catalog | `planflow-workflow` absent; automatic catalog registration not established |
| Access to the workflow | Skill subsequently read through the automatically loaded AGENTS.md pointer |
| Native `node --test scripts/native-codex-entrypoints.test.mjs` | Exit 0; 2 tests passed |
| Native `node scripts/native-codex-smoke.mjs` | Exit 0; all assertions passed, including expected cycle exit 1 and no cycle artifact |
| Isolation | Temporary fixture state cleaned; HEAD unchanged and checkout clean |
| External CLI / global repair | Neither required nor used |

The supported route demonstrated here is **native Codex task → automatic AGENTS.md
instructions → linked workflow skill → native tools running PlanFlow CLI**. It has
no remaining blocker for this scoped pilot. The fresh validation did not regenerate
brainstorm/discovery documents, rebuild dist, execute an Electron Autopilot chain,
or validate native slash-command registration. Those results must not be inferred
from a passing fixture. Brainstorm, discovery, planning, implementation and review
were performed by the original native agent using the workflow documents; the
repeatable automated coverage is the CLI planning seam and entry-point integrity.
