import type { Page } from '@playwright/test'

/**
 * The board's E2E-only handle, `window.__flowBoard`, called LOUDLY.
 *
 * Specs used to reach it as `window.__flowBoard?.handleChanged(root)`. The
 * optional chain turned a missing hook into a silent no-op — and the hook WAS
 * missing in every Playwright run for a while: the sandboxed preload gated it
 * on `process.env.FLOW_E2E`, which a sandboxed preload cannot see. Every spec
 * that "forced a refresh" forced nothing and passed (or failed) for some other
 * reason. A call through here throws `board hook missing` instead.
 */

/** The message a spec fails with when the board's E2E hook is not installed. */
export const BOARD_HOOK_MISSING = 'board hook missing'

export interface BoardCallOptions {
  /**
   * Await what the method returns (a Promise from `refresh()`). Default true.
   * `false` fires the call and returns at once — for a retry loop that must not
   * sit on a slow refresh.
   */
  wait?: boolean
}

/**
 * Call `window.__flowBoard[method](...args)` in the page, throwing
 * `board hook missing` when the hook (or the method) is not there.
 */
export async function callBoard(
  page: Page,
  method: string,
  args: readonly unknown[] = [],
  options: BoardCallOptions = {},
): Promise<unknown> {
  const wait = options.wait ?? true
  return page.evaluate(
    async ({ method, args, wait, missing }) => {
      const board = (window as unknown as { __flowBoard?: Record<string, unknown> }).__flowBoard
      if (board === undefined || board === null) {
        throw new Error(`${missing}: window.__flowBoard is not defined — the renderer was not told it runs under FLOW_E2E`)
      }
      const fn = board[method]
      if (typeof fn !== 'function') {
        throw new Error(`${missing}: window.__flowBoard.${method} is not a function`)
      }
      const result = (fn as (...a: unknown[]) => unknown).apply(board, args)
      if (wait) await result
      return undefined
    },
    { method, args: [...args], wait, missing: BOARD_HOOK_MISSING },
  )
}

/** Throw `board hook missing` unless `window.__flowBoard` is installed. */
export async function expectBoardHook(page: Page): Promise<void> {
  const present = await page.evaluate(
    () => typeof (window as unknown as { __flowBoard?: unknown }).__flowBoard === 'object',
  )
  if (!present) throw new Error(`${BOARD_HOOK_MISSING}: window.__flowBoard is not defined`)
}
