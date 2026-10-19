---
name: planflow-workflow
description: Run requested PlanFlow brainstorming, discovery, planning, execution or review stages in this repository using its existing workflow sources and CLI. Use for explicit PlanFlow workflow requests, not ordinary coding questions.
---

# PlanFlow in native Codex

Work from the repository root. This skill routes to PlanFlow's existing sources;
it does not install PlanFlow into other projects or implement the Electron app's
Autopilot harness. Choose the stage the user requested. When they authorized an
end-to-end workflow, complete the relevant stages in order within that scope.

## Load the current stage

Read the command and its referenced skill/resources before performing that stage.
Paths below are relative to this skill file. Do not load every workflow at once.

| Stage | Command source |
| --- | --- |
| Setup / project patterns | [setup](../../../.claude/commands/setup.md) |
| Explore options | [brainstorm](../../../.claude/commands/brainstorm.md) |
| Requirements | [discovery-plan](../../../.claude/commands/discovery-plan.md) |
| Implementation plan | [create-plan](../../../.claude/commands/create-plan.md) |
| Execute approved scope | [execute-plan](../../../.claude/commands/execute-plan.md) |
| Local change review | [review-code](../../../.claude/commands/review-code.md) |
| Pull request review | [review-pr](../../../.claude/commands/review-pr.md) |
| Targeted tests | [write-tests](../../../.claude/commands/write-tests.md) |
| Resume an existing run | [resume-work](../../../.claude/commands/resume-work.md) |

References inside those command bodies such as `.claude/resources/...` are
repository-root-relative. Keep discovery and planning separate from implementation;
a discovery document is required before creating the implementation plan.

## Adapt the interface, preserve the workflow

The `/brainstorm` and `/execute-plan` names identify workflow documents, not shell
commands. Codex reads them through this skill; do not claim native slash-command
registration or automatic app chain execution. Use native file, shell and user-input
tools for equivalent actions. Preserve approval and scope boundaries. If a required
provider-specific capability has no equivalent, report that stage as blocked rather
than simulating its success. Use delegation only when authorized and available.

Use the current provider. Model labels in compiled plans are planning metadata;
they do not authorize launching another provider or prove that a model executed.
Do not change global Codex/MCP settings to make a local command run.

## CLI execution and evidence

Inspect `node dist/cli/index.js --help` and the selected verb's help before relying
on flags. Build with `npm run build` when dist is absent or stale. Do not invoke
`init` just to use this skill: its current installation path has wider side effects
and is not a native Codex installer.

Compile the authored plan with `node dist/cli/index.js plan compile <plan> --target
<repo>`. Compilation produces a run artifact; the agent still executes the tasks,
verifies their results and reviews the diff. Check plan notes and record risk through
the existing CLI writers as directed by the execution workflow. Keep generated
state and private knowledge in the existing ignored `flow/` directory.

For authorized publication, use an explicit remote binding and PlanFlow's worktree
push command. Inspect PR capabilities before publishing: if a draft is requested
and the helper lacks a draft option, use `gh pr create --draft` with the verified
repository, head, base and a reviewed body file. Never create a ready PR as a
substitute. Report the exact commit, tests, command exit statuses and PR/check
results; distinguish skipped or blocked stages from successful ones.
