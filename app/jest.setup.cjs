// Runs before every app test file (jest.config.cjs `setupFiles`).
//
// NO APP TEST MAY TOUCH THE PERSON'S REAL FLOW FOLDER. The app mirrors the
// CLI's resolution (PLAN_FLOW_HOME → PLAN_FLOW_VAULT_DIR → ~/plan-flow), and
// so does every bundled-CLI process a test spawns, which inherits this env.
// Pointing PLAN_FLOW_HOME at a temp path that does not exist means a test that
// forgets to isolate itself reads an empty Flow folder instead of the real
// `~/plan-flow` — and a test that needs one sets its own.
const { join } = require('path')
const { tmpdir } = require('os')

const unique = `${process.pid}-${process.env.JEST_WORKER_ID ?? '0'}-${Date.now()}`
process.env.PLAN_FLOW_HOME = join(tmpdir(), `flow-app-jest-no-flow-home-${unique}`)
