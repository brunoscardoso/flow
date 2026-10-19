# Discovery: Native Codex pilot

## Intent
Demonstrate the existing PlanFlow CLI from native Codex using a repeatable local fixture.

## Requirements
- FR1: compile a two-phase plan using the real built CLI; assert phase dependencies survive.
- FR2: repeat compilation and verify the plan remains usable.
- FR3: reject cyclic dependencies without creating an executable artifact.
- FR4: report every invoked command's exit status, and clean up only the fixture's own temporary directory.
- NFR1: use Node built-ins and existing dependencies; no network or provider required by the smoke test.
- NFR2: isolate flow state and home paths; do not initialize or migrate any existing workspace.

## Evidence and constraints
At revision 0dff77a51b7719f921c311bdc955d1fbac4402ec, init exposes Claude installation only. The Electron agent manager expands slash commands for Codex; the CLI does not expose brainstorm or execute-plan verbs. The repository has no root AGENTS.md. This native session can explicitly read workflow guidance, but automatic native instruction/skill discovery is not demonstrated.

## Design Context
No UI.

## Acceptance
Build succeeds, smoke test succeeds including expected refusal, relevant compiler tests pass, and documentation distinguishes manually guided execution from app Autopilot.

## Native entry-point follow-up
FR5: expose repository instructions and a discoverable PlanFlow workflow skill in native locations, linking to the existing canonical command bodies.
FR6: verify native metadata and the referenced command/resource graph without provider calls or global changes.
Acceptance: packaging/reference tests and the skill validator pass. Fresh native-task validation at de2cd80 confirmed automatic AGENTS.md loading, reading the linked skill, and successful native test execution. Skill-catalog registration was not observed. The legacy external CLI parsing failure is separate and does not block this native route.
