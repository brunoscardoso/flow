import type { Command } from 'commander';

/**
 * Configure the `init` command's options and forward-compatibility.
 *
 * Extracted so it can be unit-tested without importing index.ts (which parses
 * argv on load). The Flow IDE auto-runs `init` via its EMBEDDED copy of this
 * CLI — a build artifact that can lag the app. So a newer app passing a flag or
 * argument an older embedded CLI doesn't recognize must NOT hard-fail
 * provisioning ("too many arguments for 'init'…" / "unknown option …"). We
 * tolerate the extras and proceed with the options we do recognize.
 */
export function configureInitCommand(command: Command): Command {
  return command
    .description('Install plan-flow into your project for Claude Code')
    .option('--claude', 'Install for Claude Code (slash commands + rules)')
    .option('--all', 'Install (kept for compatibility — same as --claude)')
    .option('--force', 'Overwrite existing files')
    .option(
      '--refresh-owned',
      'Refresh plan-flow-owned assets only (never rewrites .claude/rules, flow content, or existing .flowconfig keys); refuses when no install exists'
    )
    .option(
      '-y, --yes',
      'Non-interactive: never prompt, take the default for every question (defaults platforms to Claude)'
    )
    .option(
      '--workspace-managed',
      'The Flow app manages this project\'s Workspace: leave flow/ alone (no vault link, nothing seeded into it) unless it already links into a Workspace'
    )
    .option(
      '--target <dir>',
      'Target directory (defaults to current directory)',
      process.cwd()
    )
    .allowUnknownOption()
    .allowExcessArguments();
}
