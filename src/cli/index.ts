#!/usr/bin/env node
/**
 * Plan-Flow CLI
 *
 * Installs plan-flow skills into your project for Claude Code.
 */

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { configureInitCommand } from './init-command-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '1.0.0';
  } catch {
    return '1.0.0';
  }
}

const program = new Command();

program
  .name('plan-flow')
  .description(
    'Structured AI-assisted development workflows for discovery, planning, execution, code reviews, and testing.'
  )
  .version(getVersion());

configureInitCommand(program.command('init', { isDefault: true })).action(
  async (options) => {
    const { runInit } = await import('./commands/init.js');
    await runInit(options);
  }
);

program
  .command('heartbeat <action>')
  .description(
    'Manage the heartbeat daemon (start, stop, status)'
  )
  .option(
    '--target <dir>',
    'Target directory (defaults to current directory)',
    process.cwd()
  )
  .action(async (action: string, options: { target: string }) => {
    const { runHeartbeat } = await import('./commands/heartbeat.js');
    await runHeartbeat(action, options);
  });

program
  .command('state')
  .description(
    'Output deterministic JSON representing current plan-flow state'
  )
  .option(
    '--plan <path>',
    'Path to a plan file to include plan/wave/tier data'
  )
  .option(
    '--target <dir>',
    'Target directory (defaults to current directory)',
    process.cwd()
  )
  .action(async (options: { plan?: string; target: string }) => {
    const { runState } = await import('./commands/state.js');
    await runState(options);
  });

program
  .command('state-query <query>')
  .description(
    'Search the project brain for relevant context'
  )
  .option(
    '--scope <scope>',
    'Filter by scope: resources, rules, brain, plans, discovery, all',
    'all'
  )
  .option(
    '--type <chunkType>',
    'Filter by chunk type'
  )
  .option(
    '--limit <n>',
    'Max results',
    (v: string) => parseInt(v, 10),
    10
  )
  .option(
    '--target <dir>',
    'Target directory (defaults to current directory)',
    process.cwd()
  )
  .action(async (query: string, options: { scope?: string; type?: string; limit?: number; target: string }) => {
    const { runStateQuery } = await import('./commands/state-query.js');
    await runStateQuery({ query, ...options });
  });

program
  .command('blueprint <action> [target]')
  .description(
    // Every action runBlueprint's dispatch answers to, in dispatch order —
    // blueprint-help-drift.test.ts fails when this list and the switch diverge.
    'Derive and query the blueprint system map (derive, context <node>, render, observe, notes, propose, link, unlink, sweep, narrate, features <sub-verb>, workspace <graph>, coverage, brief, feature-map, gate-check, reconcile, stale-check, drift-check, drift-ack, drift-reset, forget, tiers, promote-doc, adjudicate, index <warm>, storyline)'
  )
  .option('--write <json>', 'View artifact JSON to validate and persist (features view only)')
  .option(
    '--entry <json>',
    'Learning entry as JSON (features learned only) — repeatable',
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option(
    '--relates <json>',
    'Proposed relates edges as a JSON array of {target, via, note} (features learned only)',
  )
  .option(
    '--run-id <id>',
    'Execution run id to attribute promoted records to (derive/observe)'
  )
  .option(
    '--force',
    'Derive only: overwrite a non-empty graph even when the scan saw zero candidate files (normally refused as a wrong-root derive)'
  )
  .option(
    '--note <text>',
    'Investigation note text (observe only; omit for a heat-only visit)'
  )
  .option(
    '--anchor <kind:ref>',
    'Anchor for the observation — repeatable (observe only)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[]
  )
  .option(
    '--status <status>',
    'How the note relates to existing notes: observed|corroborates|supersedes (observe only)'
  )
  .option(
    '--reason <text>',
    'Why the note supersedes an earlier one (observe only, with --supersedes)'
  )
  .option(
    '--supersedes <fingerprint>',
    'Fingerprint of the active note this one replaces (observe only)'
  )
  .option(
    '--project <name>',
    'Sibling project name (link/unlink only)',
  )
  .option(
    '--target <repo>',
    'The repo to read: whose Workspace to map (workspace graph), whose code to read as a story (storyline) or whose feature\'s entries and exits to read (features ports); default: the working directory',
  )
  .option(
    '--file <path>',
    'Project file to read as a story (storyline only)',
  )
  .option(
    '--folder <path>',
    "Project folder to pin as a feature's or part's home (features home only)",
  )
  .option(
    '--part <feature-ref>',
    'Feature or part whose files to read as one story (storyline), or the part whose learned role to write (features role)',
  )
  .option(
    '--learned <role>',
    "The role a learn pass decided for a feature or part (features role only)",
  )
  .option(
    '--base <rev>',
    "The plan's starting commit for storyline --plan (default: the run's recorded start, else HEAD when the story's files differ from it)",
  )
  .option(
    '--workspace <w>',
    'Which Workspace, when the repo is in more than one (workspace graph, features ports)',
  )
  .option(
    '--endpoint <endpoint>',
    'Endpoint to link: "GET /api/x" or "query Name" (link/unlink only)',
  )
  .option(
    '--lenient-anchors',
    'Observe only: drop unresolvable extra anchors (loudly) instead of refusing — at least one anchor must still resolve',
  )
  .option(
    '--conflict-scope <scope>',
    'Observe only: which anchors the contradiction rule considers — any (default) or primary (the first/identity anchor only)',
  )
  .option(
    '--ambiguous',
    'Flag the observation as ambiguous — never coerced to fact (observe only)'
  )
  .option(
    '--visit <visitor>',
    'Who visited the anchor: agent|human (observe heat-only mode)'
  )
  .option(
    '--json [inline-json]',
    'observe: whole investigation entry as inline JSON — same validation pipeline. stale-check: pass bare to emit a JSON report instead of human-readable lines'
  )
  .option(
    '--module <path>',
    'Filter to notes whose anchors resolve under this repo-relative module path (stale-check only)'
  )
  .option(
    '--plan <plan>',
    'Plan name the proposals belong to (propose/sweep); storyline: the plan whose Today and After to add'
  )
  .option(
    '--expired',
    'Sweep every plan whose source doc is gone or archived and has no plan of its slug — stale, never deleted (sweep only)'
  )
  .option(
    '--dry-run',
    'Report what would change without writing (features seed)'
  )
  .option(
    '--all',
    'Apply to every staged candidate rather than one slug (features confirm)'
  )
  .option(
    '--feature <id>',
    'Feature id or slug to scope the brief to (brief), or the feature or part whose entries and exits to read (features ports)'
  )
  .option(
    '--node <predicted-id>',
    'Exact predicted node id, per the extractor id grammar (propose only)'
  )
  .option(
    '--kind <kind>',
    'Predicted node kind: integration|endpoint|datastore|module (propose only)'
  )
  .option(
    '--label <text>',
    'Display label for the proposed node (propose only)'
  )
  .option(
    '--detail <text>',
    'Free-text detail for the proposal (propose only)'
  )
  .option(
    '--phase <n>',
    'Plan phase number that predicted the node (propose only)'
  )
  .option(
    '--decide <decision>',
    'Record a decision on an existing proposal: accepted|rejected (propose only)'
  )
  .option(
    '--from <doc>',
    'Source doc whose `## Story` section is compiled (narrate only)'
  )
  .option(
    '--draft',
    'Force draft mode — resolution gaps compile as drafts (narrate only)'
  )
  .option(
    '--strict',
    'Force strict mode — any resolution gap refuses (narrate only)'
  )
  .option(
    '--clear',
    'Clear the compiled story for --plan, when it matches (narrate), or a pinned home (features home)'
  )
    .option(
    '--paths <paths>',
    'Comma-separated repo-relative paths to mark reviewed (drift-ack only)'
  )
  .option(
    '--path <doc>',
    'Repo-relative doc path being adjudicated (adjudicate), or the document version to describe (brief)'
  )
  .option(
    '--verdict <verdict>',
    'Adjudication outcome: corroborated|contradicted|unverifiable (adjudicate only)'
  )
  .option(
    '--against <paths>',
    'Comma-separated repo-relative code paths the verdict was verified against (adjudicate only)'
  )
  .option(
    '--evidence <text>',
    'One-line evidence note recorded with the verdict (adjudicate only)'
  )
  .option(
    '--claims-json <json>',
    'Per-claim verdict payload as JSON array (adjudicate only; doc-verification)'
  )
  .option(
    '--provenance <origin>',
    'Verdict origin: user|learn-pass|verify-agent|auto (adjudicate only)'
  )
  .action(async (action: string, target: string | undefined, options: import('./commands/blueprint.js').BlueprintCommandOptions) => {
    const { runBlueprint } = await import('./commands/blueprint.js');
    await runBlueprint(action, target, options);
  });

const planCommand = program
  .command('plan')
  .description(
    'Work with implementation plans (compile <plan>, archive <plan>, notes <plan>, note <plan>)'
  );

planCommand
  .command('compile <plan>')
  .description(
    'Compile a plan into its deterministic run script (flow/plans/<plan>.run.json)'
  )
  .option(
    '--target <dir>',
    'Target directory (defaults to current directory)',
    process.cwd()
  )
  .action(async (plan: string, options: { target: string }) => {
    const { runPlanCompile } = await import('./commands/plan.js');
    await runPlanCompile(plan, options);
  });

planCommand
  .command('archive <plan>')
  .description(
    "Move a plan's run-script artifacts (<plan>.run.json and <plan>.run.prev.json) into flow/archive/"
  )
  .option(
    '--target <dir>',
    'Target directory (defaults to current directory)',
    process.cwd()
  )
  .action(async (plan: string, options: { target: string }) => {
    const { runPlanArchive } = await import('./commands/plan.js');
    await runPlanArchive(plan, options);
  });

planCommand
  .command('notes <plan>')
  .description(
    "A plan's change notes, their review status and where each quote is in today's code"
  )
  .option(
    '--check',
    "Refuse when a quote is found zero or several times, or a note cannot be read (a sibling project's note is checked in its checkout; with none on this computer it is reported quoteUnchecked, not checked)"
  )
  .option('--json', 'Output JSON')
  .option(
    '--target <dir>',
    'Target directory (defaults to current directory)',
    process.cwd()
  )
  .action(async (plan: string, options: { target: string; check?: boolean; json?: boolean }) => {
    const { runPlanNotes } = await import('./commands/plan.js');
    await runPlanNotes(plan, options);
  });

planCommand
  .command('note <plan>')
  .description(
    "Record one change note's status (accepted|rejected|proposed) or verdict (done|differs|not-built) — the one writer"
  )
  .option('--note <n>', 'The note number')
  .option('--status <status>', 'accepted | rejected | proposed')
  .option('--reason <text>', 'Why — usually with a rejection')
  .option('--verdict <verdict>', 'done | differs | not-built (after execution)')
  .option('--why <text>', 'One sentence saying why (required with --verdict)')
  .option('--json', 'Output JSON')
  .option(
    '--target <dir>',
    'Target directory (defaults to current directory)',
    process.cwd()
  )
  .action(async (plan: string, options: import('./commands/plan.js').PlanNoteRequest & { json?: boolean }) => {
    const { runPlanNote } = await import('./commands/plan.js');
    await runPlanNote(plan, options);
  });

const guardCommand = program
  .command('guard')
  .description(
    'Guarded-autopilot action gate (classify <action>)'
  );

guardCommand
  .command('classify')
  .description(
    'Classify a dangerous action JSON into a deterministic decision (action from --action or stdin)'
  )
  .option(
    '--action <json>',
    'The GuardAction JSON to classify (defaults to reading all of stdin)'
  )
  .action(async (options: { action?: string }) => {
    const { runGuardClassify } = await import('./commands/guard.js');
    await runGuardClassify(options);
  });

program
  .command('loop <verb>')
  .description(
    'Agent-loop verb family (next, file, claim, adopt, rework, unclaim, plan, classify, close, approve, escalate, worktree, push, merge, pause, resume, enable, disable, finish, forget, point, describe, status, list, log)'
  )
  .option(
    '--target <dir>',
    'Target directory (defaults to current directory)',
    process.cwd()
  )
  .option('--loop <name>', 'Which loop — required by next/file/claim/close/approve/enable/disable/point, a filter elsewhere')
  .option('--queue <kind>', 'Which store this loop reads its work from: github|ledger (point)')
  .option('--repo <owner/name>', 'The repo a github queue reads (point --queue github)')
  .option('--path <file>', 'The ledger file a ledger queue reads (point --queue ledger; omit to keep the current one)')
  .option('--owner <id>', 'Run id recorded on locks and claims (defaults to a unique id per invocation)')
  .option('--session <id>', 'The agent session this run lives in — recorded on the claims it takes, so an item held by a run that died can be named')
  .option('--live-runs <json>', 'Snapshot of the agents running for this root (status) — a claim whose session is missing from it is reported stuck; omit and no claim is called dead')
  .option('--cap <n>', 'Findings this instruction may file before it stops for a human (next; default 20)')
  .option('--stop-kind <kind>', 'How this hunt ends (resume --focus): findings|duration|custom — omit to leave it on the cap alone')
  .option('--stop-hours <n>', 'Hours a duration hunt runs for, measured from now (resume --focus --stop-kind duration)')
  .option('--stop-rule <text>', 'The sentence a custom hunt ends when it is true (resume --focus --stop-kind custom) — judged by the agent, never by the CLI')
  .option('--rule-met', "End this hunt because its own custom rule came true (finish) — records 'met', not a person's 'stopped'")
  .option('--stop-when-empty', 'Switch the loop off when the gate finds its list empty (next) — a state pause a resume lifts, never a directive change')
  .option('--direction <text>', "What this loop looks at and what a good finding is (describe) — the directive's ## Direction; empty removes it")
  .option('--rules <text>', "This loop's own standing constraints (describe) — the directive's ## Rules; empty removes it")
  .option('--max-open <n>', "How many open items this loop may have before the gate stops it (describe) — the directive's max_open_issues")
  .option('--needs-approval', 'This filed task waits for a human before any run may work it (file)')
  .option('--focus <text>', 'Aim THIS run within its directive (next), or the hunt to finish/forget — narrows attention, never widens scope; recorded on the run log')
  .option('--all', 'End every standing hunt this loop has (forget) — required, because it cannot be taken back')
  .option('--id <id>', 'Queue item id (claim/adopt/rework/close/approve/merge, and the issue a push --pr closes)')
  .option('--title <text>', 'Finding title (file)')
  .option('--body <text>', 'Finding body prose (file)')
  .option('--file <path>', 'The file the finding is primarily about (file)')
  .option('--labels <list>', 'Extra comma-separated labels (file)')
  .option('--plan <name>', 'The plan whose pipeline this run is advancing (plan) — omit to clear the record')
  .option('--reason <reason>', 'Close reason done|wontfix|duplicate (close), or the pause reason')
  .option('--detail <text>', 'Written reason (close/pause/resume, and required by adopt/rework)')
  .option('--evidence <json>', 'Captured {commands:[{command,exitCode}]} evidence (close/merge; "-" reads stdin)')
  .option('--until <when>', 'Pause expiry: an ISO timestamp or +<n>[mhd] (pause)')
  .option('--limit <n>', 'How many run-log lines to return (log)')
  .option('--state <slice>', 'Which slice of the queue to read: open|closed|all (list; defaults to open)')
  .option('--record [json]', 'Run record to append (log; "-" reads stdin), or the bare flag to record a classification')
  .option('--verdict <big|small>', 'The big/small judgment (classify --record)')
  .option('--prune', 'Remove the loop\'s worktree instead of resolving it (worktree)')
  .option('--no-create', 'Report where the worktree would be without creating it (worktree)')
  .option('--skip <ids>', 'Comma-separated item ids this run has passed over (claim) — serves the next one instead')
  .option('--slot <n>', 'Which run slot\'s worktree to act on (worktree; defaults to the one --owner holds)')
  .option('--branch <ref>', 'Branch to push (must be inside the loop/* carve-out) or to merge (must be this loop\'s own)')
  .option('--remote <name>', 'Remote to push to (push; defaults to origin)')
  .option('--base <branch>', 'Base branch a pull request targets (push --pr; defaults to main)')
  .option('--pr', 'Open a pull request after the push (push)')
  .option('--human', 'Render the compact human form of the same result object')
  .option('--no-pull', 'Skip the git pull that opens a run (next)')
  .action(async (verb: string, options: import('./commands/loop.js').LoopCommandOptions) => {
    const { runLoop } = await import('./commands/loop.js');
    await runLoop(verb, options);
  });

program
  .command('worktree <verb>')
  .description(
    'Thread worktree verbs (create, prune, list, name, promote, branches, bind, push, pr)'
  )
  .option(
    '--target <dir>',
    'The main checkout (defaults to current directory)',
    process.cwd()
  )
  .option('--thread <slug>', "The thread's slug — required by create/prune/name, and by bind/push/pr unless --here, a filter for list")
  .option('--here', 'Act on the checkout at --target, on the branch it is on, rather than a thread worktree (bind/push/pr; never together with --thread)')
  .option('--detach', 'Create the checkout detached, to be named once the thread has a title')
  .option('--discard', 'Prune a worktree that holds uncommitted work, losing it (prune) — the refusal without this names what would go')
  .option(
    '--base <ref>',
    "The branch to start FROM — the worktree branches off it (defaults to the branch the main checkout is on); with pr, the base the pull request opens against"
  )
  .option('--checkout <branch>', 'A branch to WORK ON — the worktree checks it out and commits land on it')
  .option('--trunk', "Start from the repository's default branch, brought up to date")
  .option('--branch <ref>', 'The branch to create (name), to attach at creation, or the REMOTE branch a binding publishes to (bind)')
  .option('--worktree-name <name>', "What the worktree's FOLDER is called — create names it; every other --thread verb finds the checkout by it. A different thing from --branch, which names the ref; defaults to the thread's slug")
  .option('--remote <name>', 'The remote a binding publishes to (bind) — required, never defaulted')
  .option(
    '--pr-base <ref>',
    'The base a pull request opens against — recorded with a --thread binding, or given to pr itself (a --here bind has nowhere to record it and refuses the flag)',
  )
  .option('--title <text>', 'The pull request title (pr)')
  .option('--body <text>', 'The pull request body (pr)')
  .option('--thread-title <text>', "The thread's title, for the remote-branch suggestion (push/pr)")
  .option('--plan <name>', 'The plan this work belongs to, for the remote-branch suggestion (push/pr)')
  .option('--default-remote <name>', 'The remote to OFFER when nothing is bound yet (push/pr) — takes precedence over the project file; never binds anything')
  .option('--branch-pattern <pattern>', 'The branch-name pattern to suggest with (push/pr), filling {ticket} {slug} {local} {user} — takes precedence over the project file')
  .option('--unattended', 'No person is present to answer (push): auto-bind an unbound branch when the suggestion is confident (source pattern|ticket); a weak rung still refuses. Never applies to attended calls')
  .option('--json', 'Emit the result object rather than the human line')
  .option('--no-fetch', 'Skip the network fetch — the ref store is already current for this base')
  .option('--no-create', 'Report where the worktree would be without creating it')
  .action(async (verb: string, options: import('./commands/worktree.js').WorktreeCommandOptions) => {
    const { runWorktree } = await import('./commands/worktree.js');
    runWorktree(verb, options);
  });

program
  .command('knowledge <action>')
  .description(
    "This project's own knowledge repo — RETIRED: knowledge syncs through the Workspace (status — where the knowledge is, with retired: true; disable — unhook an old knowledge repo, keeping everything; enable / adopt — refused as retired)"
  )
  .option(
    '--target <dir>',
    'Project root (defaults to current directory)',
    process.cwd()
  )
  .option('--remote <url>', 'The repository the knowledge syncs with, on any git host (enable) — https://<host>/<owner>/<repo>, ssh://[user@]<host>/<owner>/<repo> or [user@]<host>:<owner>/<repo>, never with credentials in it')
  .option('--branch <name>', 'The branch the knowledge repo starts on (enable; default main)')
  .option('--clean-leftovers', 'Delete the spare copies an interrupted enable or disable left beside the project, then go ahead (enable)')
  .option('--to <where>', 'Where the knowledge goes when sync is turned off (disable): keep | vault | shared')
  .option('--accept-unpushed', 'Turn sync off although the remote is missing commits — they stay in the kept history on this machine (disable)')
  .option('--json', 'Emit the result object rather than the human line')
  .action(async (action: string, options: import('./commands/knowledge.js').KnowledgeCommandOptions) => {
    const { runKnowledge } = await import('./commands/knowledge.js');
    runKnowledge(action, options);
  });

program
  .command('workspace <action>')
  .description(
    'Workspaces — groups of projects that own their knowledge (create — a new Workspace; link — add a repo as a project and link its flow/ there; join — clone a Workspace and link the projects this machine has; status — the Workspaces here, or which Workspace and project a repo is; link-knowledge — record how two projects of the Workspace touch; links — the recorded cross-project links; describe — set a project\'s description; sync — commit, merge and push a Workspace\'s knowledge; move-flow-folder — move the Workspaces to another folder and re-point every flow link; migrate — put many repos into the Default Workspace, their knowledge copied in; rename — change a Workspace\'s name; move-project — move a project to another Workspace; delete — delete a Workspace, its projects moving to the Default; set-default — choose this machine\'s Default Workspace; set-remote — connect a Workspace to a shared repository, published by the next sync; unset-remote — disconnect it, keeping everything on this machine; learn-connections — learn how the Workspace\'s projects talk, one pair at a time)'
  )
  .option('--name <name>', "The Workspace's name (create, rename; migrate: the Default's name when it has to be created, default Default), or its folder name on this machine (join)")
  .option('--remote <url>', "The Workspace's repository (create and set-remote record it; join clones it) — https://<host>/<owner>/<repo>, ssh://[user@]<host>/<owner>/<repo> or [user@]<host>:<owner>/<repo>, never with credentials in it")
  .option('--target <dir>', 'The code repository (link, status, link-knowledge, links — default: the current folder for the last two)')
  .option('--workspace <slug>', 'Which Workspace (link, status, link-knowledge, links, migrate — default: this machine\'s Default; rename, delete, set-default, set-remote, unset-remote — required) — optional when only one could be meant')
  .option('--project <id>', "Map the repo onto this existing project, by id or folder name (link) — for forks, mirrors and repos with no remote; only this project's links (links); the project to move, by folder name or id (move-project)")
  .option('--from <address>', 'One end of a cross-project link: <project>/<feature-or-anchor>, e.g. backend/endpoint:POST /api/orders (link-knowledge); the Workspace the project moves from, when more than one has it (move-project)')
  .option('--to <address>', 'The other end: <project>/<feature-or-anchor>, e.g. app/file:src/screens/Orders.tsx (link-knowledge); the new folder, absent or empty (move-flow-folder); the Workspace the project moves to (move-project)')
  .option('--kind <kind>', 'How --from relates to --to: calls | exposes | consumes | relates (link-knowledge)')
  .option('--note <text>', 'One line of why/how (link-knowledge)')
  .option('--text <text>', "The project's description, a sentence or two (describe)")
  .option('--if-empty', 'Only write when the project has no description yet (describe)')
  .option('--confirm-commit', 'Go ahead with the one code-repo commit that renames a committed flow/ to flow.pre-workspace (link) — the refusal without it shows the commit')
  .option('--import', 'Copy the knowledge flow/ holds today (a vault link, a plain or committed folder, its own knowledge repo) into the Workspace before linking — never overwriting (link)')
  .option('--roots <json>', 'A JSON array of absolute paths to code repositories (migrate)')
  .option('--dry-run', 'Report what would happen and write nothing (migrate)')
  .option('--replace', 'Change the shared repository a Workspace already has (set-remote) — the old one is left as it is')
  .option('--confirm', 'Move anyway, knowing every later run needs PLAN_FLOW_HOME set to the new folder — nothing remembers it yet, and the Flow app does not follow a moved folder (move-flow-folder); delete the Workspace, its projects moving to the Default (delete)')
  .option('--message <label>', 'The commit message for this machine\'s changes (sync)')
  .option('--no-push', 'Commit, fetch and merge, but publish nothing (sync)')
  .option('--all', 'Sync every Workspace on this machine, one after another (sync)')
  .option('--commit-only', 'Commit this machine\'s changes and nothing else — no fetch, merge or push (sync)')
  .option('--resolve <path>', 'Decide one waiting collision or merge, by its Workspace path (sync) — with --take')
  .option('--id <id>', 'Decide one waiting collision or merge by its id, exactly as it was shown (sync) — with --take; refused as stale-decision when its content changed since')
  .option('--take <how>', 'What the path holds afterwards: ours | theirs | merged | file:<path to the merged text> (sync --resolve / --id)')
  .option('--pair <a,b>', 'Check this pair of projects, by folder name (learn-connections) — without it, the plan for every pair')
  .option('--answer <file>', "A file holding the fast model's raw answer for the pair (learn-connections --pair)")
  .option('--model <outcome>', 'How the model pass ended when there is no answer: no-signal | unavailable | failed (learn-connections --pair)')
  .option('--json', 'Emit the result object rather than the human line')
  .action(async (action: string, options: import('./commands/workspace.js').WorkspaceCommandOptions) => {
    const { runWorkspace } = await import('./commands/workspace.js');
    runWorkspace(action, options);
  });

program
  .command('flow <verb> [args...]')
  .description(
    'Project settings in flow/.flowconfig (set <key>=<value>..., unset <key>..., show), the workflow ladder (stage <stage> --check), the publish gate (risk --check) and the enforced run\'s record (risk --record <level>, pushed-through <stop>) and where a plan\'s run starts (run-start --plan <name> --run <run-id>)'
  )
  .option(
    '--target <dir>',
    'Project root (defaults to current directory)',
    process.cwd()
  )
  .option('--json', 'Emit the result object rather than the human lines')
  .option('--check', 'Ask whether the named stage may run (stage), or whether this work may be published (risk) — required by both')
  .option('--feature <slug>', 'The feature every proof or record is scoped to (stage, risk, pushed-through) — never defaulted')
  .option(
    '--chain <id>',
    'The chain driving this call (stage, risk): with it a missing record refuses, without it the same verdict is reported and exit stays 0. On risk it is also the identity — --record stamps it and --check reads only what it stamped',
  )
  .option('--since <iso>', "The instant the run began (risk) — the alternative scope for a caller that knows when, not what the plan was called")
  .option('--record <level>', 'Record this run\'s risk assessment (risk): low|medium|high — the one writer of a risk entry, never combined with --check')
  .option('--rationale <text>', 'The one sentence about the changeset that goes with the level (risk --record)')
  .option('--run <run-id>', 'The run the record belongs to (pushed-through, risk --record, run-start) — never minted for you')
  .option('--plan <name>', 'The plan a run executes (run-start) — its slug or plan file name')
  .option('--detail <text>', 'One sentence about what the run went past (pushed-through)')
  .action(async (verb: string, args: string[], options: import('./commands/flow.js').FlowCommandOptions) => {
    const { runFlow } = await import('./commands/flow.js');
    runFlow(verb, args, options);
  });

program
  .command('share [mode]')
  .description(
    'Knowledge sharing switch (no mode reports the current one; local keeps flow/ out of git, shared commits the knowledge markdown)'
  )
  .option(
    '--target <dir>',
    'Project root to switch (defaults to current directory)',
    process.cwd()
  )
  .action(async (mode: string | undefined, options: { target: string }) => {
    const { runShare } = await import('./commands/share.js');
    runShare(mode, options);
  });

program
  .command('path <verb>')
  .description(
    'The planflow-ai shim on PATH (repair — rewrite a shim plan-flow wrote whose target no longer exists; never creates one, never touches a file plan-flow did not write)'
  )
  .option('--json', 'Print the result as one JSON line')
  .action(async (verb: string, options: { json?: boolean }) => {
    const { runPath } = await import('./commands/path.js');
    runPath(verb, options);
  });

program
  .command('brain <action> [args...]')
  .description(
    'Project knowledge front door (search — layered project search; ref — expand a catalogued section by its code; migrate — move the vault knowledge into this repo; index — rebuild the generated brain index from the notes)'
  )
  .option(
    '--list',
    'With ref: print the catalog — every code and what it answers'
  )
  .option(
    '--check',
    'With ref: resolve every catalog entry and report the ones that no longer point anywhere'
  )
  .option(
    '--prefix <code>',
    'With ref --list: only codes starting with this prefix (e.g. COR)'
  )
  .option(
    '--limit <n>',
    'Max results for search (default: 5)',
    (v) => parseInt(v, 10)
  )
  .option(
    '--type <chunkType>',
    'Filter search by chunk type (e.g. plan, pattern, discovery, memory)'
  )
  .option(
    '--scope <scope>',
    'Project search scope: code, symbols, modules, decisions, resources, plans, all — or workspace: every project of this project\'s Workspace, hits namespaced <project>/…',
  )
  .option(
    '--full <id>',
    'Print the full chunk/entry for one hit id (project search)'
  )
  .option(
    '--json',
    'Structured JSON output (project search)'
  )
  .option(
    '--target <dir>',
    'Project root for the project search / migration (defaults to current directory)',
    process.cwd()
  )
  .option(
    '--dry-run',
    'With migrate: copy and verify, then discard the copy without repointing anything'
  )
  .action(async (action: string, args: string[], options: { limit?: number; type?: string; scope?: string; full?: string; json?: boolean; target: string; dryRun?: boolean; list?: boolean; check?: boolean; prefix?: string }) => {
    const { runBrain } = await import('./commands/brain.js');
    await runBrain(action, args, options);
  });

/**
 * Refuse an unrecognized verb instead of installing over the directory (#1830).
 *
 * `init` is registered `{ isDefault: true }`, which is right for the documented
 * bare invocation — `npx plan-flow` opens the interactive install — but
 * commander applies a default command to ANY argv it cannot match. So
 * `plan-flow not-a-real-command`, `plan-flow bluprint derive`, or a quoted
 * argument a shell did not word-split, ran a full install in whatever directory
 * the user was standing in: 103 files, a rewritten `.gitignore`, an entry in the
 * GLOBAL Obsidian vault and a detached heartbeat daemon — two of which survive
 * `rm -rf` on the directory — and it exited 0, so every scripted caller read it
 * as success.
 *
 * This is the SECOND incident from this fall-through. The comment below records
 * the first: when argv mode was wrong, "every verb stopped matching, the
 * interactive default (init) ran instead". That was fixed by correcting argv,
 * which left the catch-all itself in place.
 *
 * The guard inspects ONLY argv[2], rather than removing the default, so every
 * shape that works today still does: bare (`plan-flow`), flags-only
 * (`plan-flow --claude --yes --target x`), `--help`, `--version` and every real
 * verb. Only a leading word that names no command is refused.
 *
 * ARGV[2] AND NOT "the first non-flag argument": scanning for the first operand
 * reads an option's VALUE as a verb, so `--target /some/path` refuses on
 * `/some/path`. It is argv[2] that is safe to check because `init` — the only
 * command reachable without naming one — takes no positional arguments, so a
 * leading non-flag word can only ever be a verb.
 *
 * The prompt-on-EOF behaviour is deliberately NOT touched. Answering EOF with
 * the documented default is #1795's fix — without it `init --all </dev/null`
 * hangs, then exits 0 over an unprovisioned repo. With a typo no longer able to
 * reach `init`, that default only applies to an install someone asked for.
 */
const KNOWN_COMMANDS = new Set([
  'help',
  ...program.commands.flatMap((command) => [command.name(), ...command.aliases()]),
]);
const leadingWord = process.argv[2];
if (
  leadingWord !== undefined &&
  !leadingWord.startsWith('-') &&
  !KNOWN_COMMANDS.has(leadingWord)
) {
  // The verb family's contract: one `<cmd> refused: <reason>` line, exit 1,
  // nothing written. Named commands already do this; the unnamed one now does.
  const { error } = await import('./utils/logger.js');
  error(
    `plan-flow refused: unknown command '${leadingWord}' — ` +
      `run \`plan-flow --help\` for the commands this version has`,
  );
  process.exit(1);
}

// ALWAYS node argv semantics (2026-07-23 incident): the Flow app spawns this
// CLI under its own Electron binary with ELECTRON_RUN_AS_NODE, where
// process.versions.electron is still set — commander then auto-switches to
// 'electron' argv mode and (packaged app → no process.defaultApp) treats the
// SCRIPT PATH as the first user argument. Every verb stopped matching, the
// interactive default (init) ran instead, hung on ignored stdin, and timed
// out — silently killing every app-spawned observe/derive since. Our argv is
// always [exec, script, ...args]; say so explicitly.
program.parse(process.argv, { from: 'node' });
