// Every app test runs with its own Flow folder that does not exist, so no test
// can read — or write — the person's real `~/plan-flow` (jest.setup.cjs).

import { existsSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

import { resolveFlowFolder } from '../main/project/flow-folder'

describe('the app test suite never sees the real Flow folder', () => {
  it('PLAN_FLOW_HOME points at a temp folder that does not exist', () => {
    const home = process.env.PLAN_FLOW_HOME
    expect(typeof home).toBe('string')
    expect(home?.startsWith(tmpdir())).toBe(true)
    expect(existsSync(home as string)).toBe(false)
  })

  it('so the Flow folder every resolver follows is not ~/plan-flow', () => {
    expect(resolveFlowFolder()).not.toBe(join(homedir(), 'plan-flow'))
    expect(resolveFlowFolder()).toBe(process.env.PLAN_FLOW_HOME)
  })
})
