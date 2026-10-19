// Fire-and-forget work is off for every test in this repo (#1848).
//
// `runInit` detaches a heartbeat daemon, and a detached PROCESS outlives the
// test that started it — running `init.test.ts` alone used to leave eight of
// them pointed at temp directories the suite had already deleted, which is what
// made a different test fail on every full run.
//
// Set here rather than injected because two of the affected suites drive the
// CLI as a subprocess, and a child inherits this.
process.env.PLANFLOW_NO_BACKGROUND_WORK = '1';

// No test may write the developer's real Copilot settings (forbidden-pattern
// #15). `initShared` grants the flow/ vault target on Copilot's sandbox
// allowlist in ~/.copilot/settings.json, and every init test ran it against
// the real home: one machine's allowlist held 269 temp-directory entries from
// test runs and not one real project. A home that does not exist makes the
// writer report `no-copilot` and touch nothing. Suites that exercise the writer
// pass their own `env` (see sandbox-config.test.ts), so they are unaffected,
// and a CLI driven as a subprocess inherits this like the line above.
process.env.COPILOT_HOME = require('node:path').join(
  require('node:os').tmpdir(),
  'planflow-tests-have-no-copilot-home',
);

// No test may read or write the developer's real Flow folder (~/plan-flow):
// provisioning now looks up Workspaces there (`resolveFlowFolder`). A folder
// that does not exist reads as "no Workspaces", so every suite that does not
// name its own sees today's behaviour. Workspace suites set their own.
process.env.PLAN_FLOW_HOME = require('node:path').join(
  require('node:os').tmpdir(),
  'planflow-tests-have-no-flow-folder',
);
