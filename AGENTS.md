# Working in PlanFlow

This repository contains the PlanFlow CLI (`src/cli`) and Electron app (`app`).
Read the relevant sections of [CLAUDE.md](CLAUDE.md) for architecture and the
[allowed](.claude/rules/core/allowed-patterns.md) and
[forbidden](.claude/rules/core/forbidden-patterns.md) patterns for code changes.
Those files are shared repository guidance; their names do not select a provider.

For a request to use the PlanFlow workflow, read the repository skill
[planflow-workflow](.agents/skills/planflow-workflow/SKILL.md). Its stage-specific
references are the existing workflow sources, loaded only when needed. Ordinary
code questions and small edits do not require the full workflow.

Use `node dist/cli/index.js --help` to inspect the built CLI, and `npm run build`
to refresh it after source changes. CLI tests use `npm test -- --runInBand` with
relevant test paths; `--watchman=false` avoids an optional Watchman dependency.
App checks are defined in `app/package.json`. The native pilot can be checked with
`node --test scripts/native-codex-entrypoints.test.mjs` and, after a build,
`node scripts/native-codex-smoke.mjs`.

Keep existing user changes isolated. Stage only the files belonging to the task.
`flow/` is local runtime knowledge and intentionally ignored; never force-add it.
Inspect whether it is a link before writing, and respect the permitted roots.
Repository guidance does not authorize installation, global configuration changes,
knowledge migration, publication or deployment. Honor the user's actual scope.
