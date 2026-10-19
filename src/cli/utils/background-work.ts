/**
 * The one switch that turns off fire-and-forget background work.
 *
 * WHY IT EXISTS. `runInit` deliberately detaches work so a person is not made
 * to wait for it — a blueprint derive, and a heartbeat daemon. In a TEST that
 * detachment outlives the test: the daemon keeps running against a temp
 * directory the suite is deleting, and the delete loses (#1848).
 *
 * The symptom was a suite failing on a different test every full run —
 * `ENOTEMPTY: directory not empty, rmdir '…/plan-flow-init-test-…'` — and the
 * cause looked, for a long time, like the derive. It was not: `runInit` already
 * exposes `settleInitBackgroundWork()` for exactly that promise, `init.test.ts`
 * already awaits it before its cleanup, and the suite failed anyway. Running
 * that one file leaves EIGHT live heartbeat daemons pointed at deleted
 * directories. A promise is awaitable; a detached process is not.
 *
 * AN ENV GUARD RATHER THAN INJECTED DEPS, deliberately. Two of the suites this
 * fixes drive the CLI as a SUBPROCESS (`provisioner-e2e`, `init-completeness`),
 * where there is nothing to inject into — but a child inherits its parent's
 * environment, so one variable set once in the jest setup reaches all of them.
 * It is also the shape forbidden-pattern #15 argues for: a default that
 * protects every caller beats an injection point that protects the ones who
 * remember to use it.
 *
 * PRODUCTION NEVER SETS THIS. It is written in `jest.setup.cjs` and nowhere
 * else, so the only processes it stops are the ones a test started.
 */
export const NO_BACKGROUND_WORK_ENV = 'PLANFLOW_NO_BACKGROUND_WORK';

/** Whether fire-and-forget work should be skipped in this process. */
export function backgroundWorkDisabled(): boolean {
  return (process.env[NO_BACKGROUND_WORK_ENV] ?? '') !== '';
}
